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
 *   await migrate(sql);           // db/*.sql, in order, hash-recorded
 *   const board = await pgDoc<Board>(host, sql, "board", empty);
 *   await pgAuth(host, sql);      // register/login/authenticate/logout
 *   await pgSync(host, sql);      // cross-process fan-out (LISTEN/NOTIFY)
 */

import type { Host } from "./doc";
import type { Op } from "./op";
import type { Signal } from "./signal";

/**
 * The slice of a Postgres client epsilon actually uses. Bun's `SQL`
 * satisfies it structurally (wire Postgres); `pglite.ts` implements it over
 * an IN-PROCESS database. Everything in this file — and migrate.ts, and the
 * stored functions themselves — runs unchanged on either engine.
 */
export interface Sql {
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<any>;
  unsafe(query: string, params?: any): PromiseLike<any>;
  /** One session for the whole call — advisory locks are session-scoped. */
  reserve?(): PromiseLike<any>;
  end?(): PromiseLike<void> | void;
}

const CHANNEL = "epsilon_ops";

export { migrate, migrationStatus, migrationFiles } from "./migrate";

/**
 * Host a doc backed by Postgres.
 *
 * Doc-native (default): the doc is a JSONB blob — TS applies ops, one guarded
 * UPDATE persists, NOTIFY fans out.
 *
 * Relational (`opts.apply` = a stored function name): the TABLES are the
 * truth. Client ops go to `<apply>(name, ops)` in ONE transaction — it mints
 * ids from sequences, updates tables, recomposes the doc into docs.data,
 * logs doc_ops, bumps v, NOTIFYs — and returns `{v, ops}` with resolved
 * paths/rows, which re-enter through host.receive(). Composition and
 * multi-table writes live in SQL, where they're optimal; hydrate, catch-up,
 * fan-out, wire, and UI are IDENTICAL to the doc-native tier.
 */
export async function pgDoc<T>(
  host: Host,
  sql: Sql,
  name: string,
  empty: T,
  opts?: {
    apply?: string;
    /** Create the docs row on first host (dynamic docs — mine:<uid>). */
    seed?: { open_fn: string };
    /** Identity the hosted composition runs AS (an owner/uid derived from the
     *  name). The hosted signal holds THAT view; pair with `guard`. */
    openAs?: number | null;
    /** Who may receive the hosted snapshot over the wire. May be async —
     *  e.g. `SELECT board_may(...)`, so membership changes take effect on
     *  the next open. Refusals read as "unknown doc" — no existence oracle. */
    guard?: (userId?: number | string) => boolean | Promise<boolean>;
  },
): Promise<Signal<T>> {
  if (opts?.apply) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(opts.apply)) {
      throw new Error(`[epsilon/pg] apply must be a plain function name: ${opts.apply}`);
    }
    const applyFn = opts.apply;
    const openAs = opts.openAs ?? null;
    const guard = opts.guard;
    let sig!: Signal<T>;
    sig = host.doc<T>(name, empty, {
      async write(ops, userId) {
        // ops bind RAW — Bun encodes arrays/objects as jsonb; stringify+cast
        // double-encodes into a scalar (see the doc-native lesson above).
        const rows = await sql.unsafe(
          `SELECT ${applyFn}($1, $2, $3) AS r`,
          [name, ops as unknown, userId ?? null],
        );
        const r = rows[0]!.r as { v: number | string; ops: Op[] };
        if (host.receive(name, Number(r.v), r.ops) === "gap") {
          const [doc] = await sql`SELECT v, doc_open(name, ${openAs}) AS data FROM docs WHERE name = ${name}`;
          if (doc) host.hydrate(name, Number(doc.v), doc.data);
        }
      },
      open: guard ? async (userId) => ((await guard(userId)) ? sig.peek() : null) : undefined,
    });
    if (opts.seed) {
      await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${name}, 0, NULL, ${opts.seed.open_fn})
                ON CONFLICT (name) DO NOTHING`;
    }
    // Composition happens HERE, at open — never per write. `openAs` lets an
    // identity-scoped doc compose its owner's view into the hosted signal;
    // `guard` keeps that view from anyone else.
    const [row] = await sql`SELECT v, doc_open(name, ${openAs}) AS data FROM docs WHERE name = ${name}`;
    if (!row) throw new Error(`[epsilon/pg] relational doc ${name} not seeded — your SQL file should INSERT its docs row`);
    host.hydrate(name, Number(row.v), row.data);
    return sig;
  }

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

  const [row] = await sql`SELECT v, doc_open(name) AS data FROM docs WHERE name = ${name}`;
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
async function catchUp(host: Host, sql: Sql, name: string): Promise<void> {
  let current: number;
  try { current = host.v(name); } catch { return; }        // not hosted here
  const missed = await sql`
    SELECT v, ops FROM doc_ops WHERE name = ${name} AND v > ${current} ORDER BY v`;
  for (const m of missed) {
    if (host.receive(name, Number(m.v), m.ops as Op[]) === "gap") {
      const [doc] = await sql`SELECT v, doc_open(name) AS data FROM docs WHERE name = ${name}`;
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
  sql: Sql,
  opts?: { ms?: number; url?: string; mode?: "listen" | "poll" },
): Promise<Sync> {
  const url = opts?.url ?? process.env.EPSILON_PG_URL;

  // --- listen mode (pg installed, url known) ------------------------------
  if (url && opts?.mode !== "poll") {
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
      const names = host.names();
      if (names.length === 0) return;
      // One sweep, not one query per doc. Bind as jsonb (Bun encodes JS
      // arrays that way) and unnest server-side.
      const rows = await sql`
        SELECT name, v FROM docs
        WHERE name IN (SELECT jsonb_array_elements_text(${names as any}))`;
      for (const row of rows) {
        let current: number;
        try { current = host.v(row.name as string); } catch { continue; }
        if (Number(row.v) > current) await catchUp(host, sql, row.name as string);
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
// Users — schema-native auth. The CONTRACT is SQL (db/002-auth.sql):
// register / login / session_start / session_user / session_end. Hashing is
// pgcrypto bcrypt, where the data lives. This module is only the wire
// adapter — swap the functions in a later migration and nothing here changes.
// ---------------------------------------------------------------------------

export interface User { id: number; name: string; email: string }

function asUser(row: any): User {
  return { id: Number(row.id), name: row.name, email: row.email };
}

export async function pgAuth(
  host: Host,
  sql: Sql,
  opts?: { maxAttempts?: number; windowMs?: number },
): Promise<void> {
  // bcrypt (cost 12) is deliberately expensive, which makes register/login a
  // CPU faucet for anyone hammering them — a fixed window per client IP caps
  // that. In-process on purpose: it protects THIS process's CPU; the SQL
  // contract stays unthrottled. `authenticate` is exempt — it's one indexed
  // SELECT, and every reconnect re-auths through it (onConnect).
  const maxAttempts = opts?.maxAttempts ?? 10;
  const windowMs = opts?.windowMs ?? 60_000;
  const attempts = new Map<string, { n: number; resetAt: number }>();
  function throttle(ws: any): void {
    const key = String(ws?.remoteAddress ?? "?");
    const now = Date.now();
    const slot = attempts.get(key);
    if (!slot || now >= slot.resetAt) {
      if (attempts.size > 10_000) attempts.clear();   // bounded memory
      attempts.set(key, { n: 1, resetAt: now + windowMs });
      return;
    }
    if (++slot.n > maxAttempts) throw new Error("too many attempts — try again later");
  }

  async function startSession(ws: any, user: User): Promise<{ token: string; user: User }> {
    const [row] = await sql`SELECT session_start(${user.id}) AS token`;
    ws.data ??= {};
    ws.data.user = user;
    return { token: row.token as string, user };
  }

  host.method("register", async (params: { name?: string; email?: string; password?: string }, ws) => {
    throttle(ws);
    const { name, email, password } = params ?? {};
    if (!name || !email || !password) throw new Error("name, email, and password required");
    let rows;
    try {
      rows = await sql`SELECT register(${name}, ${email}, ${password}) AS u`;
    } catch (err) {
      // Bun's PostgresError puts ERR_POSTGRES_SERVER_ERROR in .code; match the
      // constraint violation by message rather than chasing the SQLSTATE.
      if (String(err).includes("duplicate key")) throw new Error("email already registered");
      throw err;
    }
    return startSession(ws, asUser(rows[0]!.u));
  });

  host.method("login", async (params: { email?: string; password?: string }, ws) => {
    throttle(ws);
    const { email, password } = params ?? {};
    if (!email || !password) throw new Error("email and password required");
    // login() returns NULL for unknown email AND wrong password alike, with
    // uniform timing — the distinction never reaches the wire.
    const [row] = await sql`SELECT login(${email}, ${password}) AS u`;
    if (!row?.u) throw new Error("invalid credentials");
    return startSession(ws, asUser(row.u));
  });

  host.method("authenticate", async (params: { token?: string }, ws) => {
    const { token } = params ?? {};
    if (!token) throw new Error("token required");
    const [row] = await sql`SELECT session_get(${token}) AS u`;
    if (!row?.u) throw new Error("invalid or expired session");
    const user = asUser(row.u);
    ws.data ??= {};
    ws.data.user = user;
    return user;
  });

  host.method("logout", async (params: { token?: string }, ws) => {
    if (params?.token) await sql`SELECT session_end(${params.token})`;
    if (ws.data) delete ws.data.user;
    return { ok: true };
  });
}
