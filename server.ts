// The authority. In-memory out of the box. With a Postgres URL the board is
// RELATIONAL — tables are the truth, stored functions apply and compose,
// sequence ids, schema-native users with login required. Same client code.
//
// Exported as a factory (bun-route convention) so tests bind port 0 and
// inject their own database.
import { unlinkSync } from "node:fs";
import index from "./index.html";
import { createHost, type Host, type Signal } from "./epsilon";
import type { Sql } from "./epsilon/pg";
import type { Board } from "./types";

export interface StartOpts {
  port?: number;
  pgUrl?: string;
  /** EMBEDDED Postgres (PGlite): a data directory instead of a server —
   *  one deployable service, no separate database process. Ignored when a
   *  pgUrl is set; single app process only (see epsilon/pglite.ts). */
  pgDir?: string;
  /** Migration directory (tests point this at the repo's db/). */
  dbDir?: string;
}

export async function startServer(opts: StartOpts = {}) {
  const pgUrl = opts.pgUrl ?? process.env.EPSILON_PG_URL;
  const pgDir = opts.pgDir ?? (pgUrl ? undefined : process.env.EPSILON_PG_DIR);

  // Presence: being ON a board is WATCHING its presence doc — an ordinary
  // in-memory doc keyed by socket, written by the subscribe hooks and
  // evicted with its last watcher. Ephemeral and per-process by design:
  // nothing persists, nothing fans out across processes.
  let sid = 0;
  const presenceOf = (name: string) =>
    host.names().includes(name) ? host.doc<Record<string, { name: string }>>(name, {}) : null;
  const host: Host = createHost({
    requireAuth: !!(pgUrl || pgDir),
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
  let sql: Sql | undefined;

  if (pgUrl || pgDir) {
    const { migrate, pgDoc, pgSync, pgAuth, pgUndo } = await import("./epsilon/pg");
    // Same schema, two engines: a wire server (EPSILON_PG_URL), or EMBEDDED
    // Postgres in this process (EPSILON_PG_DIR) — one service, no db process.
    const db: Sql = pgUrl
      ? new (await import("bun")).SQL(pgUrl)
      : await (await import("./epsilon/pglite")).openPglite(pgDir!);
    sql = db;
    await migrate(db, { dir: opts.dbDir ?? "db" });    // db/*.sql, in order, hash-recorded
    await db`SELECT epsilon_prune()`;                  // bounded tables: old ops, dead sessions
    // ...and daily thereafter — long-lived deployments prune without a cron
    // (an external cron stays fine; prune is idempotent). unref: tests and
    // short runs exit freely.
    setInterval(async () => {
      try { await db`SELECT epsilon_prune()`; }
      catch (err) { console.error("[epsilon] prune failed:", err); }
    }, 86_400_000).unref?.();
    await pgAuth(host, db);                            // wire adapter over the SQL contract
    // Passkeys: register one while signed in, sign in with it ever after.
    // Ceremonies bind to the socket's own origin; pin { origins } in prod.
    const { pgPasskey } = await import("./epsilon/passkey");
    pgPasskey(host, db, { rpName: "epsilon-app" });

    // Docs are DYNAMIC — names are data, hosted on first open.
    // board:<id> — public when owner_id is NULL (the seeded board:1),
    // otherwise the owner's and their members'. No guard here: pgDoc's
    // default gate asks doc_open(name, user) at EVERY open — the composition
    // function is the permit, so a board claimed or shared while hosted is
    // re-judged on the next open, nothing captured at hosting time.
    const may = async (id: number, u?: number | string) => {
      const [r] = await db`SELECT board_may(${id}, ${u == null ? null : Number(u)}) AS ok`;
      return !!r?.ok;
    };
    host.docs("board:", async (name, userId) => {
      const id = Number(name.split(":")[1]);
      if (!Number.isFinite(id)) throw new Error(`unknown doc: ${name}`);
      const [b] = await db`SELECT 1 FROM boards WHERE id = ${id}`;
      // A stranger is refused BEFORE hosting — probes cost nothing.
      if (!b || !(await may(id, userId))) throw new Error(`unknown doc: ${name}`);
      const sig = await pgDoc<Board>(host, db, name, null as unknown as Board, { apply: "board_apply" });
      // Revocation bites LIVE sockets, not just the next open: a member
      // removed (or leaving) is expelled from the board and its presence —
      // expel re-asks the open gate, so a batch that nets to membership
      // keeps them. Ops arrive here on every process hosting the doc.
      sig.onOps((ops) => ops?.forEach((op) => {
        const m = op.op === "remove" ? /^\/members\/(\d+)$/.exec(op.path) : null;
        if (!m) return;
        void host.expel(name, Number(m[1]));
        void host.expel(`presence:${name}`, Number(m[1]));
      }));
    });

    // mine:<uid> — YOUR board list; creating a board is an op on it. Only its
    // owner's open may host (and seed) it — probes can't mint docs rows.
    host.docs("mine:", async (name, userId) => {
      const uid = Number(name.split(":")[1]);
      if (!Number.isFinite(uid) || Number(userId) !== uid) throw new Error(`unknown doc: ${name}`);
      await pgDoc(host, db, name, null, {
        apply: "mine_apply",
        seed: { open_fn: "mine_open" },
      });
    });

    // Undo is a write with server-computed ops: your last undoable version
    // (or an explicit v) reverts through board_apply itself — permit
    // re-checked, refused if later ops touched the same paths; the undo of
    // an undo is the redo. remote.call("undo", { doc: "board:2" }).
    pgUndo(host, db, (doc) => (doc.startsWith("board:") ? "board_apply" : undefined));

    // presence:board:<id> — who's looking. Exactly as private as the board
    // it watches: the factory refusal only guards the FIRST open (the doc
    // outlives its opener), so the open gate re-asks board_may for every
    // socket while it's hosted. In-memory docs have no doc_open to default
    // to — the gate is ours to fit.
    host.docs("presence:", async (name, userId) => {
      const id = Number(name.split(":")[2]);
      if (!Number.isFinite(id) || !(await may(id, userId))) throw new Error(`unknown doc: ${name}`);
      let sig!: Signal<Record<string, { name: string }>>;
      sig = host.doc<Record<string, { name: string }>>(name, {}, {
        open: async (u) => ((await may(id, u)) ? sig.peek() : null),
      });
    });

    // Fan-out exists for SIBLING processes. Embedded Postgres has none by
    // construction — this process owns the directory, and the host's own
    // broadcast already reaches every subscriber.
    if (pgUrl) await pgSync(host, db, { url: pgUrl });
  } else {
    host.doc<Board>("board:1", { name: "main", cards: {} });
    host.docs("presence:", (name) => { host.doc(name, {}); });
  }

  const server = Bun.serve({
    port: opts.port ?? Number(process.env.PORT ?? 3000),   // PaaS routers assign PORT
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
  g.__epsilon_app ??= startServer().then(async (app) => {
    const mode = process.env.EPSILON_PG_URL ? "relational Postgres + auth"
      : app.sql ? "embedded Postgres (PGlite) + auth"
      : "in-memory, open";
    console.log(`epsilon-app → http://localhost:${app.server.port} (${mode})`);
    // The pid file: `bun run stop` (or any script) knows what to kill.
    // Real boots only — tests spawn many servers and must not fight over
    // it. Removed on a clean exit; a crash can leave it stale.
    await Bun.write(".epsilon.pid", `${process.pid}\n`);
    const bye = () => {
      try { unlinkSync(".epsilon.pid"); } catch { /* already gone */ }
      process.exit(0);
    };
    process.on("SIGINT", bye);
    process.on("SIGTERM", bye);
    return app;
  });
}
