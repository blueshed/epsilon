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

  // Presence: being ON a board is WATCHING its presence doc — an ordinary
  // in-memory doc keyed by socket, written by the subscribe hooks and
  // evicted with its last watcher. Ephemeral and per-process by design:
  // nothing persists, nothing fans out across processes.
  let sid = 0;
  const presenceOf = (name: string) =>
    host.names().includes(name) ? host.doc<Record<string, { name: string }>>(name, {}) : null;
  const host: Host = createHost({
    requireAuth: !!pgUrl,
    onSubscribe(doc, ws) {
      if (!doc.startsWith("presence:")) return;
      ws.data.sid ??= ++sid;
      presenceOf(doc)?.apply([
        { op: "add", path: `/${ws.data.sid}`, value: { name: ws.data.user?.name ?? "guest" } },
      ]);
    },
    onUnsubscribe(doc, ws) {
      if (!doc.startsWith("presence:") || !ws.data?.sid) return;
      presenceOf(doc)?.apply([{ op: "remove", path: `/${ws.data.sid}` }]);
    },
  });
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
    // board:<id> — public when owner_id is NULL (the seeded board:1),
    // otherwise the owner's and their members', decided by board_may IN THE
    // TABLES — the same predicate the stored functions enforce.
    const may = async (id: number, u?: number | string) => {
      const [r] = await db`SELECT board_may(${id}, ${u == null ? null : Number(u)}) AS ok`;
      return !!r?.ok;
    };
    host.docs("board:", async (name, userId) => {
      const id = Number(name.split(":")[1]);
      if (!Number.isFinite(id)) throw new Error(`unknown doc: ${name}`);
      const [b] = await db`SELECT owner_id FROM boards WHERE id = ${id}`;
      // A stranger is refused BEFORE hosting — probes cost nothing.
      if (!b || !(await may(id, userId))) throw new Error(`unknown doc: ${name}`);
      const owner = b.owner_id == null ? null : Number(b.owner_id);
      await pgDoc<Board>(host, db, name, null as unknown as Board, {
        apply: "board_apply",
        openAs: owner,
        // Membership changes bite on the next open — the guard asks SQL.
        guard: owner == null ? undefined : (u) => may(id, u),
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

    // presence:board:<id> — who's looking, visible to whoever may open the
    // board itself. Hosted empty; the subscribe hooks fill it.
    host.docs("presence:", async (name, userId) => {
      const id = Number(name.split(":")[2]);
      if (!Number.isFinite(id) || !(await may(id, userId))) throw new Error(`unknown doc: ${name}`);
      host.doc(name, {});
    });

    await pgSync(host, db, { url: pgUrl });            // cross-process fan-out
  } else {
    host.doc<Board>("board:1", { name: "main", cards: {} });
    host.docs("presence:", (name) => { host.doc(name, {}); });
  }

  const server = Bun.serve({
    port: opts.port ?? 3000,
    routes: { "/": index },
    fetch: host.fetch,   // /ws upgrade; 404 for anything else
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
