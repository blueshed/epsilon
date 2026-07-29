// The authority. In-memory out of the box. With a Postgres URL the board is
// RELATIONAL — tables are the truth, stored functions apply and compose,
// sequence ids, schema-native users with login required. Same client code.
//
// Exported as a factory (bun-route convention) so tests bind port 0 and
// inject their own database.
import index from "./index.html";
import { createHost, type Host } from "./epsilon";
import type { Board } from "./types";

export interface StartOpts {
  port?: number;
  pgUrl?: string;
  /** Migration directory (tests point this at the repo's db/). */
  dbDir?: string;
}

export async function startServer(opts: StartOpts = {}) {
  const pgUrl = opts.pgUrl ?? process.env.EPSILON_PG_URL;
  const host: Host = createHost({ requireAuth: !!pgUrl });
  let sql: import("bun").SQL | undefined;

  if (pgUrl) {
    const { SQL } = await import("bun");
    const { migrate, pgDoc, pgSync, pgAuth } = await import("./epsilon/pg");
    const db = new SQL(pgUrl);
    sql = db;
    await migrate(db, { dir: opts.dbDir ?? "db" });    // db/*.sql, in order, hash-recorded
    await db`SELECT epsilon_prune()`;                  // bounded tables: old ops, dead sessions
    await pgAuth(host, db);                            // wire adapter over the SQL contract

    // Docs are DYNAMIC — names are data, hosted on first open.
    // board:<id> — shared when owner_id is NULL (the seeded board:1),
    // otherwise the owner's alone, decided by the tables.
    host.docs("board:", async (name, userId) => {
      const id = Number(name.split(":")[1]);
      if (!Number.isFinite(id)) throw new Error(`unknown doc: ${name}`);
      const [b] = await db`SELECT owner_id FROM boards WHERE id = ${id}`;
      if (!b) throw new Error(`unknown doc: ${name}`);
      const owner = b.owner_id == null ? null : Number(b.owner_id);
      // An owned board refuses strangers BEFORE hosting — probes cost nothing.
      if (owner != null && Number(userId) !== owner) throw new Error(`unknown doc: ${name}`);
      await pgDoc<Board>(host, db, name, null as unknown as Board, {
        apply: "board_apply",
        openAs: owner,
        guard: owner == null ? undefined : (u) => Number(u) === owner,
      });
    });

    // mine:<uid> — YOUR board list; creating a board is an op on it. Only its
    // owner's open may host (and seed) it — probes can't mint docs rows.
    host.docs("mine:", async (name, userId) => {
      const uid = Number(name.split(":")[1]);
      if (!Number.isFinite(uid) || Number(userId) !== uid) throw new Error(`unknown doc: ${name}`);
      await pgDoc(host, db, name, null, {
        apply: "mine_apply",
        seed: { open_fn: "mine_open" },
        openAs: uid,
        guard: (u) => Number(u) === uid,
      });
    });

    await pgSync(host, db, { url: pgUrl });            // cross-process fan-out
  } else {
    host.doc<Board>("board:1", { name: "main", cards: {} });
  }

  const server = Bun.serve({
    port: opts.port ?? 3000,
    routes: { "/": index },
    fetch: (req, srv) => host.fetch(req, srv) ?? new Response("not found", { status: 404 }),
    websocket: host.websocket,
    development: { hmr: true, console: true },
  });
  host.setServer(server);
  return { server, host, sql };
}

// `bun --hot` re-evaluates this module on every edit. Boot ONCE per process
// and cache the app on globalThis — otherwise each reload leaks a connection
// pool and resets doc versions under connected clients.
if (import.meta.main) {
  const g = globalThis as { __epsilon_app?: Promise<Awaited<ReturnType<typeof startServer>>> };
  g.__epsilon_app ??= startServer().then((app) => {
    console.log(
      `epsilon-app → http://localhost:${app.server.port} (${app.sql ? "relational Postgres + auth" : "in-memory, open"})`,
    );
    return app;
  });
}
