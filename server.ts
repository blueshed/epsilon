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
    sql = new SQL(pgUrl);
    await migrate(sql, { dir: opts.dbDir ?? "db" });   // db/*.sql, in order, hash-recorded
    await pgAuth(host, sql);                           // wire adapter over the SQL contract
    await pgDoc<Board>(host, sql, "board:1", null as unknown as Board, { apply: "board_apply" });
    await pgSync(host, sql, { url: pgUrl });           // cross-process fan-out
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
