// The authority. In-memory out of the box. With a Postgres URL the board is
// RELATIONAL — tables are the truth, stored functions apply and compose,
// sequence ids, schema-native users with login required. Same client code.
//
// Exported as a factory (bun-route convention) so tests bind port 0 and
// inject their own database.
import { unlinkSync } from "node:fs";
import index from "./index.html";
import { createHost, type Host, type Signal } from "./epsilon";
import type { Sql, Sync } from "./epsilon/pg";
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

  // In-memory is a SHAPE PREVIEW: no auth, no permits, no persistence. It is
  // also what you silently get by misspelling EPSILON_PG_DIR — and that
  // deployment boots fine, passes its healthcheck, and serves every doc to
  // the whole internet. So in production the preview must be asked for out
  // loud; anything else is a typo, and a typo should stop the boot.
  if (!pgUrl && !pgDir && process.env.NODE_ENV === "production" && !process.env.EPSILON_ALLOW_OPEN) {
    throw new Error(
      "[epsilon] refusing to start: NODE_ENV=production with no database.\n" +
      "  In-memory mode has NO auth and NO permits — every doc is world-readable and world-writable.\n" +
      "  Set EPSILON_PG_DIR=/data (embedded) or EPSILON_PG_URL=postgres://… (server).\n" +
      "  If an open, stateless preview really is what you want here, set EPSILON_ALLOW_OPEN=1.",
    );
  }

  // Presence: being ON a board is WATCHING its presence doc — an ordinary
  // in-memory doc keyed by socket, written by the subscribe hooks and
  // evicted with its last watcher. Ephemeral and per-process by design:
  // nothing persists, nothing fans out across processes.
  let sid = 0;
  const presenceOf = (name: string) =>
    host.names().includes(name) ? host.doc<Record<string, { name: string }>>(name, {}) : null;
  const wsOrigins = process.env.EPSILON_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean);
  const host: Host = createHost({
    requireAuth: !!(pgUrl || pgDir),
    origins: wsOrigins,   // same allowlist the passkey ceremony pins to
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
  let sync: Sync | undefined;

  if (pgUrl || pgDir) {
    const { migrate, pgDoc, pgSync, pgAuth, pgUndo, pgHistory, pgAdmin, pgView } = await import("./epsilon/pg");
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
    // EPSILON_ORIGINS pins which web origins may run a ceremony (comma
    // separated, e.g. "https://app.example.com"). Unset keeps the zero-config
    // default — the origin the socket itself connected from — which is right
    // for development and worth being explicit about in production.
    const { pgPasskey } = await import("./epsilon/passkey");
    pgPasskey(host, db, { rpName: process.env.EPSILON_RP_NAME ?? "epsilon-app", origins: wsOrigins });

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

    // tally:<uid> — nouns are docs (0.7.0): counts over your own boards,
    // read-only, recomposed whenever board: or mine: commits. The worked
    // example from DESIGN.md and view.test.ts, wired in for real.
    pgView(host, db, "tally:", { open: "tally_open", on: ["board:", "mine:"] });

    // Undo is a write with server-computed ops: your last undoable version
    // (or an explicit v) reverts through board_apply itself — permit
    // re-checked, refused if later ops touched the same paths; the undo of
    // an undo is the redo. remote.call("undo", { doc: "board:2" }).
    pgUndo(host, db, (doc) => (doc.startsWith("board:") ? "board_apply" : undefined));

    // Who changed what: the doc's own op log, read back through the doc's own
    // permit. remote.call("history", { doc: "board:2" }) — newest first, names
    // joined at read time, paged by version. Costs a doc type nothing; the
    // audit was already being written for every op.
    pgHistory(host, db);

    // The operator's door, only if EPSILON_ADMIN names someone. On the
    // embedded tier the database has no port, so this is the ONLY way to
    // look at a live deployment: `bun epsilon/cli.ts call admin '{"sql":"…"}'`.
    if (pgAdmin(host, db)) console.log("[epsilon] admin door open (EPSILON_ADMIN)");

    // presence:board:<id> — who's looking. Exactly as private as the board
    // it watches: the factory refusal only guards the FIRST open (the doc
    // outlives its opener), so the open gate re-asks board_may for every
    // socket while it's hosted. In-memory docs have no doc_open to default
    // to — the gate is ours to fit.
    // Presence is written by the SUBSCRIBE HOOKS, never by a client. Without
    // a write hook the host applies whatever ops arrive, which let any member
    // forge or delete someone else's entry and use the board as a free
    // broadcast channel. `write` refusing everything makes it server-authored
    // by construction; the hooks call sig.apply() directly and never come
    // through here. The name is checked whole, so `presence:anything:1` can't
    // ride in on a board id it happens to end with.
    host.docs("presence:", async (name, userId) => {
      const parts = name.split(":");
      const id = Number(parts[2]);
      if (parts.length !== 3 || parts[1] !== "board" || !Number.isFinite(id)) {
        throw new Error(`unknown doc: ${name}`);
      }
      if (!(await may(id, userId))) throw new Error(`unknown doc: ${name}`);
      let sig!: Signal<Record<string, { name: string }>>;
      sig = host.doc<Record<string, { name: string }>>(name, {}, {
        open: async (u) => ((await may(id, u)) ? sig.peek() : null),
        write: () => { throw new Error("read-only: presence is written by the server"); },
      });
    });

    // Sync is not only about SIBLING processes. It is the delivery path for
    // every commit made outside a doc's own write hook — above all a MIRROR:
    // board_apply writing into mine:<uid> bumps that doc in the database, and
    // only sync carries it to the hosted signal here. Wire Postgres hears its
    // own LISTEN; embedded Postgres has no doorbell to hear, so it polls the
    // in-process database instead. Skipping it on the embedded tier meant a
    // share landed in the tables and the member's list never moved — refresh
    // included, because a doc another socket still watches is never recomposed.
    sync = await pgSync(host, db, pgUrl ? { url: pgUrl } : { mode: "poll", ms: 250 });
  } else {
    host.doc<Board>("board:1", { name: "main", cards: {} });
    host.docs("presence:", (name) => { host.doc(name, {}); });
  }

  // Dev mode is a DEVELOPMENT tool: HMR plumbing served to whoever asks,
  // verbose error pages, and client console output piped into this process's
  // stdout — which is an unauthenticated log-injection channel on a public
  // host. Bun's own signal (NODE_ENV) decides, so `bun dev` keeps hot reload
  // and a deploy does not have to remember anything.
  const dev = (process.env.NODE_ENV ?? "development") !== "production";

  const server = Bun.serve({
    port: opts.port ?? Number(process.env.PORT ?? 3000),   // PaaS routers assign PORT
    routes: {
      // Bun bundles this natively; wrapping it in a handler to add security
      // headers defeats the bundler (you get the object stringified, not the
      // app), so HSTS/CSP/X-Frame-Options belong at your TLS terminator —
      // see README "Deploying". The defense that has to live here is the
      // WebSocket origin allowlist above, which no proxy can do for you.
      "/": index,
      // A healthcheck that only proves the process is up restarts nothing
      // when the thing that broke is the database — and the database is
      // in-process on the embedded tier, so "up" and "usable" really can
      // differ. One round trip, so a wedged pool fails the check.
      "/health": async () => {
        try {
          if (sql) await sql`SELECT 1`;
          return Response.json({ ok: true, db: sql ? "up" : "memory" });
        } catch (err) {
          return Response.json({ ok: false, error: String(err) }, { status: 503 });
        }
      },
    },
    fetch: host.fetch,   // /ws upgrade; 404 for anything else
    websocket: {
      ...host.websocket,
      // A frame bigger than this is refused by Bun before it reaches the op
      // path. 1 MiB is far above any real batch and far below the 16 MiB
      // default, which a malicious client can send as fast as it can type.
      maxPayloadLength: Number(process.env.EPSILON_MAX_PAYLOAD ?? 1024 * 1024),
      // A socket that stops reading must not buffer without limit: past this
      // much unsent fan-out, Bun closes it. One slow reader on a busy doc is
      // the whole process's memory otherwise.
      backpressureLimit: 16 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      // Dead sockets hold their subscriptions — and their presence entries —
      // until something notices they are gone. Safe for a quiet-but-live tab:
      // Bun pings automatically and both browsers and Bun's own client pong at
      // the protocol level, so idleness here means the peer is unreachable,
      // not that the user stopped typing (verified, Bun 1.3.14).
      idleTimeout: 120,
    },
    development: dev ? { hmr: true, console: true } : false,
  });
  host.setServer(server);
  return { server, host, sql, sync };
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
    // Shut down in the order that keeps a restart clean: stop taking traffic,
    // stop the sync loop, THEN close the database. On the embedded tier the
    // database is in this process, so exiting without closing it kills PGlite
    // mid-transaction — every redeploy was doing that. `true` drains in-flight
    // requests rather than cutting them.
    let leaving = false;
    const bye = async () => {
      if (leaving) return;                        // a second SIGTERM must not race the first
      leaving = true;
      try { unlinkSync(".epsilon.pid"); } catch { /* already gone */ }
      try { app.server.stop(true); } catch (err) { console.error("[epsilon] stop:", err); }
      try { app.sync?.stop(); } catch (err) { console.error("[epsilon] sync stop:", err); }
      try { await app.sql?.end?.(); } catch (err) { console.error("[epsilon] db close:", err); }
      process.exit(0);
    };
    process.on("SIGINT", bye);
    process.on("SIGTERM", bye);
    return app;
  });
}
