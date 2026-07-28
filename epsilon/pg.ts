/**
 * Postgres — durability and fan-out for DOC-NATIVE docs (JSONB blobs), plus
 * schema-native users.
 *
 * This tier needs no stored functions: the doc IS the stored value, so there
 * is no composition and no multi-table write — TS applies ops with the same
 * op.ts the browser runs, then persists the result (serialized per doc — a
 * promise chain, so writes can't interleave) and NOTIFYs other processes.
 * The RELATIONAL tier (docs as lenses over tables) is where stored functions
 * are optimal and expected — see DESIGN.md "Storage tiers".
 * Listeners fetch missed ops from doc_ops and inject them via
 * host.receive(); a gap falls back to reload + hydrate.
 *
 * Uses Bun's built-in SQL client — zero dependencies, one language.
 *
 *   const sql = new SQL(process.env.EPSILON_PG_URL!);
 *   await ensureSchema(sql);
 *   const board = await pgDoc<Board>(host, sql, "board", empty);
 *   await pgAuth(host, sql);      // register/login/authenticate/logout
 *   await pgListen(host, sql);    // cross-process fan-out (LISTEN/NOTIFY)
 */

import { SQL } from "bun";
import type { Host } from "./doc";
import type { Op } from "./op";
import type { Signal } from "./signal";

const CHANNEL = "epsilon_ops";

/** Apply schema.sql — plain DDL, idempotent, statement by statement. */
export async function ensureSchema(sql: SQL): Promise<void> {
  const ddl = await Bun.file(new URL("./schema.sql", import.meta.url)).text();
  for (const stmt of ddl.split(";")) {
    const s = stmt.trim();
    if (s) await sql.unsafe(s);
  }
}

/**
 * Host a doc backed by Postgres: load (or create) the row, hydrate the host,
 * persist every local write, NOTIFY other processes.
 */
export async function pgDoc<T>(
  host: Host,
  sql: SQL,
  name: string,
  empty: T,
): Promise<Signal<T>> {
  // Persistence is serialized per doc (delta's A2 lesson): a chain, not a race.
  let chain: Promise<void> = Promise.resolve();

  const sig = host.doc<T>(name, empty, {
    persist(v, ops, data) {
      chain = chain.then(async () => {
        // Optimistic guard: only advance from exactly v-1. A conflict means
        // another process wrote — reload and hydrate to their truth.
        // Bind objects raw — Bun encodes them as jsonb objects; a pre-
        // stringified value + ::jsonb double-encodes into a string scalar.
        const updated = await sql`
          UPDATE docs SET v = ${v}, data = ${data as any}
          WHERE name = ${name} AND v = ${v - 1}
          RETURNING v`;
        if (updated.length === 0) {
          const [row] = await sql`SELECT v, data FROM docs WHERE name = ${name}`;
          if (row) host.hydrate(name, Number(row.v), row.data);
          return;
        }
        await sql`INSERT INTO doc_ops (name, v, ops) VALUES (${name}, ${v}, ${ops as any})`;
        await sql`SELECT pg_notify(${CHANNEL}, ${JSON.stringify({ name, v })})`;
      }).catch((err) => {
        console.error(`[epsilon/pg] persist ${name} v${v} failed:`, err);
      });
    },
  });

  const [row] = await sql`SELECT v, data FROM docs WHERE name = ${name}`;
  if (row) {
    host.hydrate(name, Number(row.v), row.data);
  } else {
    await sql`INSERT INTO docs (name, v, data) VALUES (${name}, 0, ${empty as any})
              ON CONFLICT (name) DO NOTHING`;
  }
  return sig;
}


/** Bring one hosted doc up to the database's version. Idempotent — receive()
 *  drops stale versions, so overlapping calls can't double-apply. */
async function catchUp(host: Host, sql: SQL, name: string): Promise<void> {
  let current: number;
  try { current = host.v(name); } catch { return; }        // not hosted here
  const missed = await sql`
    SELECT v, ops FROM doc_ops WHERE name = ${name} AND v > ${current} ORDER BY v`;
  for (const m of missed) {
    if (host.receive(name, Number(m.v), m.ops as Op[]) === "gap") {
      const [doc] = await sql`SELECT v, data FROM docs WHERE name = ${name}`;
      if (doc) host.hydrate(name, Number(doc.v), doc.data);
      return;
    }
  }
}

export interface Sync {
  /** "listen" — pg LISTEN/NOTIFY push. "poll" — interval fallback. */
  mode: "listen" | "poll";
  stop(): void;
}

/**
 * Cross-process fan-out. Prefers real push: when the optional `pg` package
 * is installed, a dedicated connection LISTENs on the channel every persist
 * already NOTIFYs, with reconnect + full catch-up. Without `pg`, falls back
 * to polling hosted docs' versions.
 *
 * The pg dependency exists ONLY because Bun's SQL client has no LISTEN
 * callbacks yet (verified, 1.3.14). The day `sql.listen` ships, the listen
 * branch moves to Bun and `pg` retires — the seam and tests don't change.
 */
export async function pgSync(
  host: Host,
  sql: SQL,
  opts?: { ms?: number; url?: string },
): Promise<Sync> {
  const url = opts?.url ?? process.env.EPSILON_PG_URL;

  // --- listen mode (pg installed, url known) ------------------------------
  if (url) {
    let ClientCtor: any;
    try {
      const pg: any = await import("pg");
      ClientCtor = pg.Client ?? pg.default?.Client;
    } catch { /* pg not installed — fall through to polling */ }

    if (ClientCtor) {
      let client: any = null;
      let stopped = false;
      let backoff = 200;

      async function start(): Promise<void> {
        if (stopped) return;
        try {
          client = new ClientCtor({ connectionString: url });
          client.on("error", () => { if (!stopped) retry(); });
          await client.connect();
          await client.query(`LISTEN ${CHANNEL}`);
          client.on("notification", (msg: { payload?: string }) => {
            if (stopped || !msg.payload) return;
            try {
              const { name } = JSON.parse(msg.payload) as { name: string };
              void catchUp(host, sql, name).catch((err) =>
                console.error("[epsilon/pg] catch-up failed:", err));
            } catch { /* malformed payload — ignore */ }
          });
          backoff = 200;
          // Anything committed while we were (re)connecting was NOTIFYd to
          // nobody — catch every hosted doc up now.
          for (const name of host.names()) await catchUp(host, sql, name);
        } catch (err) {
          console.error("[epsilon/pg] listen connect failed:", err);
          retry();
        }
      }

      function retry(): void {
        try { client?.end(); } catch { /* closing */ }
        client = null;
        if (stopped) return;
        setTimeout(() => void start(), (backoff = Math.min(backoff * 2, 10_000)));
      }

      await start();
      return {
        mode: "listen",
        stop() {
          stopped = true;
          try { client?.end(); } catch { /* closing */ }
        },
      };
    }
  }

  // --- poll fallback ------------------------------------------------------
  let stopped = false;
  let inFlight = false;
  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      for (const name of host.names()) {
        const [row] = await sql`SELECT v FROM docs WHERE name = ${name}`;
        if (!row) continue;
        let current: number;
        try { current = host.v(name); } catch { continue; }
        if (Number(row.v) > current) await catchUp(host, sql, name);
      }
    } catch (err) {
      console.error("[epsilon/pg] sync tick failed:", err);
    } finally {
      inFlight = false;
    }
  }
  const timer = setInterval(tick, opts?.ms ?? 250);
  return {
    mode: "poll",
    stop() { stopped = true; clearInterval(timer); },
  };
}

// ---------------------------------------------------------------------------
// Users — schema-native auth (DESIGN.md decision 3). Sessions, not JWT:
// a random token in a table, Bun.password for hashing, zero dependencies.
// ---------------------------------------------------------------------------

export interface User { id: number; name: string; email: string }

const SESSION_DAYS = 7;

export async function pgAuth(host: Host, sql: SQL): Promise<void> {
  async function startSession(ws: any, user: User): Promise<{ token: string; user: User }> {
    const token = crypto.randomUUID();
    await sql`INSERT INTO sessions (token, user_id, expires_at)
              VALUES (${token}, ${user.id}, now() + ${`${SESSION_DAYS} days`}::interval)`;
    ws.data ??= {};
    ws.data.user = user;
    return { token, user };
  }

  host.method("register", async (params: { name?: string; email?: string; password?: string }, ws) => {
    const { name, email, password } = params ?? {};
    if (!name || !email || !password) throw new Error("name, email, and password required");
    const hash = await Bun.password.hash(password);
    let rows;
    try {
      rows = await sql`INSERT INTO users (email, name, password_hash)
                       VALUES (${email}, ${name}, ${hash})
                       RETURNING id, name, email`;
    } catch (err) {
      // Bun's PostgresError puts ERR_POSTGRES_SERVER_ERROR in .code; match the
      // constraint violation by message rather than chasing the SQLSTATE.
      if (String(err).includes("duplicate key")) throw new Error("email already registered");
      throw err;
    }
    const u = rows[0]!;
    return startSession(ws, { id: Number(u.id), name: u.name, email: u.email });
  });

  host.method("login", async (params: { email?: string; password?: string }, ws) => {
    const { email, password } = params ?? {};
    if (!email || !password) throw new Error("email and password required");
    const [u] = await sql`SELECT id, name, email, password_hash FROM users WHERE email = ${email}`;
    // Verify against a constant dummy hash when the user is missing, so the
    // response time doesn't reveal which emails exist.
    const ok = await Bun.password.verify(password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !ok) throw new Error("invalid credentials");
    return startSession(ws, { id: Number(u.id), name: u.name, email: u.email });
  });

  host.method("authenticate", async (params: { token?: string }, ws) => {
    const { token } = params ?? {};
    if (!token) throw new Error("token required");
    const [row] = await sql`
      SELECT u.id, u.name, u.email FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ${token} AND s.expires_at > now()`;
    if (!row) throw new Error("invalid or expired session");
    const user: User = { id: Number(row.id), name: row.name, email: row.email };
    ws.data ??= {};
    ws.data.user = user;
    return user;
  });

  host.method("logout", async (params: { token?: string }, ws) => {
    if (params?.token) await sql`DELETE FROM sessions WHERE token = ${params.token}`;
    if (ws.data) delete ws.data.user;
    return { ok: true };
  });
}

// A real argon2 hash of an unguessable throwaway value — computed once at
// startup so login timing is uniform for unknown emails.
const DUMMY_HASH = await Bun.password.hash(crypto.randomUUID());
