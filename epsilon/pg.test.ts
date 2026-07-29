// Postgres authority: durability, restart, cross-process fan-out, users.
// Needs the compose Postgres: `bun run db:up` first (or `bun run ci`).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { createHost, connect, type Host, type Remote } from "./doc";
import { migrate, pgDoc, pgSync, pgAuth } from "./pg";

// Tests own a SEPARATE database (created on demand) — the suite TRUNCATEs,
// and it must never share the app's DB. Point EPSILON_TEST_PG_URL elsewhere
// to override; it deliberately does NOT read EPSILON_PG_URL.
const ADMIN_URL = "postgres://epsilon:epsilon@localhost:5599/epsilon";
const PG_URL = process.env.EPSILON_TEST_PG_URL ?? "postgres://epsilon:epsilon@localhost:5599/epsilon_test_pg";
const DB_DIR = new URL("../db", import.meta.url).pathname;

async function ensureTestDb(): Promise<void> {
  if (process.env.EPSILON_TEST_PG_URL) return;   // caller owns that DB
  const admin = new SQL(ADMIN_URL);
  const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = 'epsilon_test_pg'`;
  if (!exists) await admin.unsafe("CREATE DATABASE epsilon_test_pg");
  await admin.end();
}

interface Board { cards: Record<string, { id: number; title: string }> }
const empty: Board = { cards: {} };

let sql: SQL;
const servers: ReturnType<typeof Bun.serve>[] = [];
const remotes: Remote[] = [];
const sqls: SQL[] = [];
const stops: (() => void)[] = [];

function serve(host: Host) {
  const server = Bun.serve({
    port: 0,
    fetch: (req, srv) => host.fetch(req, srv) ?? new Response("", { status: 404 }),
    websocket: host.websocket,
  });
  host.setServer(server);
  servers.push(server);
  return `ws://localhost:${server.port}${host.path}`;
}

function client(url: string, onError?: (d: string, e: string) => void) {
  const r = connect(url, { onError });
  remotes.push(r);
  return r;
}

function freshSql() {
  const s = new SQL(PG_URL, { max: 3 });   // small pools: many suites, one server
  sqls.push(s);
  return s;
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 2000) => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Poll until the docs row reaches version v — persistence is async by design. */
const untilDbV = (name: string, v: number) =>
  until(async () => {
    const [row] = await sql`SELECT v FROM docs WHERE name = ${name}`;
    return row != null && Number(row.v) >= v;
  });

beforeAll(async () => {
  await ensureTestDb();
  sql = freshSql();
  await migrate(sql, { dir: DB_DIR });
  expect(await migrate(sql, { dir: DB_DIR })).toEqual([]);   // idempotent: nothing re-runs
  // Wipe data AND the ledger, then re-migrate — the suite starts from seeds.
  await sql.unsafe("TRUNCATE docs, doc_ops, sessions, boards, cards, migrations RESTART IDENTITY CASCADE");
  await sql.unsafe("TRUNCATE users RESTART IDENTITY CASCADE");
  await migrate(sql, { dir: DB_DIR });
});

afterAll(async () => {
  for (const stop of stops) stop();
  for (const r of remotes) r.close();
  for (const s of servers) s.stop(true);
  for (const s of sqls) await s.end?.();
});

describe("durability", () => {
  test("a wire write lands in docs and doc_ops with contiguous versions", async () => {
    const host = createHost();
    const board = await pgDoc<Board>(host, sql, "blob:1", structuredClone(empty));
    const url = serve(host);
    const remote = client(url).doc<Board>("blob:1");
    await remote.ready;

    remote.apply([{ op: "add", path: "/cards/1", value: { id: 1, title: "persisted" } }]);
    await until(() => board.peek().cards["1"] !== undefined);
    await untilDbV("blob:1", 1);

    const [doc] = await sql`SELECT v, data FROM docs WHERE name = ${"blob:1"}`;
    expect(Number(doc.v)).toBe(1);
    expect(doc.data.cards["1"].title).toBe("persisted");
    const opsRows = await sql`SELECT v, ops FROM doc_ops WHERE name = ${"blob:1"} ORDER BY v`;
    expect(opsRows.length).toBe(1);
    expect(opsRows[0].ops[0].path).toBe("/cards/1");
  });

  test("restart: a new host hydrates state AND version, then keeps writing", async () => {
    const host2 = createHost();
    const board2 = await pgDoc<Board>(host2, sql, "blob:1", structuredClone(empty));
    expect(board2.peek().cards["1"]!.title).toBe("persisted");   // hydrated
    expect(host2.v("blob:1")).toBe(1);                          // version carried

    board2.apply([{ op: "replace", path: "/cards/1/title", value: "after-restart" }]);
    await untilDbV("blob:1", 2);
    const [doc] = await sql`SELECT v, data FROM docs WHERE name = ${"blob:1"}`;
    expect(Number(doc.v)).toBe(2);                               // optimistic guard passed
    expect(doc.data.cards["1"].title).toBe("after-restart");
  });
});

describe("cross-process fan-out (LISTEN/NOTIFY)", () => {
  test("a write in process A reaches process B's doc and B's browser", async () => {
    // Two hosts, two SQL connections — two processes in miniature.
    const a = createHost();
    const b = createHost();
    const sqlA = freshSql();
    const sqlB = freshSql();
    const boardA = await pgDoc<Board>(a, sqlA, "blob:x", structuredClone(empty));
    const boardB = await pgDoc<Board>(b, sqlB, "blob:x", structuredClone(empty));
    const syncA = await pgSync(a, sqlA, { url: PG_URL });
    const syncB = await pgSync(b, sqlB, { url: PG_URL });
    stops.push(syncA.stop, syncB.stop);
    // pg is installed in this repo, so fan-out must be real push, not polling.
    expect(syncA.mode).toBe("listen");
    expect(syncB.mode).toBe("listen");
    const urlB = serve(b);
    const browserB = client(urlB).doc<Board>("blob:x");
    await browserB.ready;

    boardA.apply([{ op: "add", path: "/cards/9", value: { id: 9, title: "cross" } }]);

    await until(() => boardB.peek().cards["9"] !== undefined);          // B's authority
    await until(() => browserB.peek()!.cards["9"] !== undefined);       // B's browser
    expect(b.v("blob:x")).toBe(a.v("blob:x"));
  });

  test("poll fallback sweeps every hosted doc in one query", async () => {
    const a = createHost();
    const c = createHost();
    const sqlA = freshSql();
    const sqlC = freshSql();
    const boardA = await pgDoc<Board>(a, sqlA, "blob:p", structuredClone(empty));
    const boardC = await pgDoc<Board>(c, sqlC, "blob:p", structuredClone(empty));
    const sync = await pgSync(c, sqlC, { ms: 50, mode: "poll" });
    stops.push(sync.stop);
    expect(sync.mode).toBe("poll");

    boardA.apply([{ op: "add", path: "/cards/7", value: { id: 7, title: "polled" } }]);
    await until(() => boardC.peek().cards["7"] !== undefined);
  });
});

describe("schema-native users", () => {
  test("register → session; wrong password rejects; token authenticates a NEW socket", async () => {
    const host = createHost();
    await pgAuth(host, sql);
    const url = serve(host);

    const r1 = client(url);
    const reg = await r1.call<{ token: string; user: { id: number; name: string } }>("register", {
      name: "Pete", email: "pete@blueshed.co.uk", password: "correct-horse",
    });
    expect(reg.user.name).toBe("Pete");
    expect(reg.token).toBeTruthy();

    await expect(r1.call("login", { email: "pete@blueshed.co.uk", password: "wrong" }))
      .rejects.toThrow(/invalid credentials/);
    await expect(r1.call("register", { name: "P", email: "pete@blueshed.co.uk", password: "x" }))
      .rejects.toThrow(/already registered/);

    const r2 = client(url);   // call() queues until the socket opens
    const me = await r2.call<{ email: string }>("authenticate", { token: reg.token });
    expect(me.email).toBe("pete@blueshed.co.uk");
  });

  test("register/login are rate limited per client — bcrypt is expensive", async () => {
    const host = createHost();
    await pgAuth(host, sql, { maxAttempts: 2, windowMs: 60_000 });
    const url = serve(host);
    const r = client(url);

    await r.call("login", { email: "nobody@x.test", password: "a" }).catch(() => {});
    await r.call("login", { email: "nobody@x.test", password: "a" }).catch(() => {});
    // The third attempt is refused BEFORE bcrypt runs.
    await expect(r.call("login", { email: "nobody@x.test", password: "a" }))
      .rejects.toThrow(/too many attempts/);
    // authenticate stays unthrottled — every reconnect re-auths through it.
    await expect(r.call("authenticate", { token: "not-a-token" }))
      .rejects.toThrow(/invalid or expired/);
  });

  test("requireAuth: docs are closed until an auth method vouches for the socket", async () => {
    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    await pgDoc<Board>(host, sql, "private", structuredClone(empty));
    const url = serve(host);

    const errors: string[] = [];
    const r = client(url, (_d, e) => errors.push(e));
    const before = r.doc<Board>("private");        // open fires unauthenticated
    await until(() => errors.length > 0);
    expect(errors[0]).toBe("unauthenticated");
    expect(before.peek()).toBeNull();

    await r.call("login", { email: "pete@blueshed.co.uk", password: "correct-horse" });
    // v0: no automatic re-open after auth — the doc handle re-opens on ask.
    const after = r.doc<Board>("private");
    await after.ready;
    expect(after.peek()).not.toBeNull();
  });
});

describe("housekeeping", () => {
  test("epsilon_prune drops old ops and dead sessions, keeps the rest", async () => {
    await sql`INSERT INTO docs (name, v, data) VALUES ('prune:1', 2, '{}'::jsonb)
              ON CONFLICT (name) DO NOTHING`;
    await sql`INSERT INTO doc_ops (name, v, ops, at) VALUES
      ('prune:1', 1, '[]'::jsonb, now() - interval '40 days'),
      ('prune:1', 2, '[]'::jsonb, now())`;
    const [u] = await sql`SELECT register('Pruned', 'pruned@x.test', 'pw') AS u`;
    const uid = Number((u.u as { id: number }).id);
    await sql`INSERT INTO sessions (token, user_id, expires_at) VALUES
      ('dead-token', ${uid}, now() - interval '1 hour'),
      ('live-token', ${uid}, now() + interval '1 hour')`;

    const [r] = await sql`SELECT epsilon_prune(${"30 days"}::interval) AS r`;
    expect(Number(r.r.doc_ops)).toBeGreaterThanOrEqual(1);
    expect(Number(r.r.sessions)).toBeGreaterThanOrEqual(1);

    const ops = await sql`SELECT v FROM doc_ops WHERE name = 'prune:1' ORDER BY v`;
    expect(ops.map((o: { v: unknown }) => Number(o.v))).toEqual([2]);   // recent op survives
    const sess = await sql`SELECT token FROM sessions WHERE user_id = ${uid}`;
    expect(sess.map((s: { token: string }) => s.token)).toEqual(["live-token"]);
  });
});
