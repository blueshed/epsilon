// Postgres authority: durability, restart, cross-process fan-out, users.
// Needs the compose Postgres: `bun run db:up` first (or `bun run ci`).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { createHost, connect, type Host, type Remote } from "./doc";
import { migrate, pgDoc, pgSync, pgAuth } from "./pg";
import { pgReachable, skipped, hasBoardFixture, NO_FIXTURE } from "./testdb";

// Tests own a SEPARATE database (created on demand) — the suite wipes its
// schema, and it must never share the app's DB. NAMESPACED BY APP (package.json
// name): scaffolds share a dev Postgres with the template — and each other —
// and identical names ping-pong the migration ledger between checkouts
// (hash drift). Point EPSILON_TEST_PG_URL elsewhere to override; it
// deliberately does NOT read EPSILON_PG_URL.
const APP = ((await Bun.file(new URL("../package.json", import.meta.url)).json()).name as string)
  .toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^(?![a-z_])/, "app_");
const DB = `${APP}_test_pg`;
const ADMIN_URL = "postgres://epsilon:epsilon@localhost:5599/epsilon";
const PG_URL = process.env.EPSILON_TEST_PG_URL ?? `postgres://epsilon:epsilon@localhost:5599/${DB}`;

// Bare `bun test` runs this file too. Ask before assuming.
const DB_UP = await pgReachable(ADMIN_URL);
if (!DB_UP) skipped('pg.test.ts (durability, fan-out, users)');
const DB_DIR = new URL("../db", import.meta.url).pathname;

async function ensureTestDb(): Promise<void> {
  if (process.env.EPSILON_TEST_PG_URL) return;   // caller owns that DB
  const admin = new SQL(ADMIN_URL);
  const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${DB}`;
  if (!exists) await admin.unsafe(`CREATE DATABASE ${DB}`);
  await admin.end();
}

import type { FixtureBoard as Board, FixtureCard as Card } from "./fixture";

let sql: SQL;
const servers: ReturnType<typeof Bun.serve>[] = [];
const remotes: Remote[] = [];
const sqls: SQL[] = [];
const stops: (() => void)[] = [];

function serve(host: Host) {
  const server = Bun.serve({
    port: 0,
    fetch: host.fetch,
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

beforeAll(async () => {
  if (!DB_UP) return;   // nothing to set up; the describes are skipped
  await ensureTestDb();
  sql = freshSql();
  // Start from NOTHING: released core files are frozen and only guaranteed
  // against their ledger (005 upgrades what 003 created — re-applying 003
  // over the final schema cannot work), so the suite wipes the schema, not
  // the ledger, and migrates fresh.
  await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await migrate(sql, { dir: DB_DIR });
  // The LEDGER is idempotent — no numbered file re-runs. db/fn always
  // replays by design, so filter it out rather than asserting an empty
  // result: an app that adopts db/fn would otherwise fail this line.
  expect((await migrate(sql, { dir: DB_DIR })).filter((m) => !m.fn)).toEqual([]);
  if (!(await hasBoardFixture(sql))) throw new Error(NO_FIXTURE);
});

afterAll(async () => {
  if (!DB_UP) return;   // nothing was opened
  for (const stop of stops) stop();
  for (const r of remotes) r.close();
  for (const s of servers) s.stop(true);
  for (const s of sqls) await s.end?.();
});

// Durability, restart-hydrate and LISTEN fan-out are proven on the tier that
// ships, in rel.test.ts — "restart: a fresh host hydrates by COMPOSING" and
// "two processes, concurrent writes: FOR UPDATE serializes, both land", which
// also asserts mode === "listen". They lived here too until 0.10.0, against a
// doc-native JSONB tier that no app ever hosted; the tier is gone and its
// copies with it. What remains here is what rel.test.ts does NOT cover: the
// POLL path, chosen when `pg` is absent, where a doc's death is noticed by a
// sweep rather than a doorbell.
describe.skipIf(!DB_UP)("cross-process fan-out — the poll fallback", () => {
  test("poll fallback sweeps every hosted doc in one query", async () => {
    const a = createHost();
    const c = createHost();
    const sqlA = freshSql();
    const sqlC = freshSql();
    await pgDoc<Board>(a, sqlA, "board:1", null as unknown as Board, { apply: "board_apply" });
    const boardC = await pgDoc<Board>(c, sqlC, "board:1", null as unknown as Board, { apply: "board_apply" });
    const sync = await pgSync(c, sqlC, { ms: 50, mode: "poll" });
    stops.push(sync.stop);
    expect(sync.mode).toBe("poll");

    const before = Object.keys(boardC.peek()!.cards).length;
    const ca = client(serve(a)).doc<Board>("board:1");
    await ca.ready;
    ca.at<Record<string, Card>>("/cards").apply([{ op: "add", path: "/-", value: { text: "polled" } }]);

    await until(() => Object.keys(boardC.peek()!.cards).length === before + 1);
  });

  test("poll notices a vanished row: the doc un-hosts, watchers get the snapshot of nothing", async () => {
    // Its own board, because this test deletes it. owner_id NULL = public,
    // so no user is needed to watch or write.
    const [b] = await sql`INSERT INTO boards (name, owner_id) VALUES ('doomed', NULL) RETURNING id`;
    const name = `board:${b.id}`;
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${name}, 0, NULL, 'board_open')`;

    const a = createHost();
    const c = createHost();
    const sqlA = freshSql();
    const sqlC = freshSql();
    await pgDoc<Board>(a, sqlA, name, null as unknown as Board, { apply: "board_apply" });
    const boardC = await pgDoc<Board>(c, sqlC, name, null as unknown as Board, { apply: "board_apply" });
    const sync = await pgSync(c, sqlC, { ms: 50, mode: "poll" });
    stops.push(sync.stop);
    const watcher = client(serve(c)).doc<Board>(name);
    await watcher.ready;

    // A write round-trips first, so a sweep has seen the row (it is KNOWN —
    // docs that never had a row, like in-memory presence, are never dropped).
    const ca = client(serve(a)).doc<Board>(name);
    await ca.ready;
    ca.at<Record<string, Card>>("/cards").apply([{ op: "add", path: "/-", value: { text: "brief" } }]);
    await until(() => Object.keys(boardC.peek()!.cards).length === 1);

    await sqlA`SELECT doc_drop(${name})`;
    await until(() => !c.names().includes(name));
    await until(() => watcher.peek() === null);
  });
});

describe.skipIf(!DB_UP)("schema-native users", () => {
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

  test("emails normalize — trimmed and lowercased at every door (the japan lesson)", async () => {
    const host = createHost();
    await pgAuth(host, sql);
    const url = serve(host);
    const r = client(url);

    // Registered from a phone, with autocapitalize and a stray space…
    const reg = await r.call<{ user: { email: string } }>("register", {
      name: "Cased", email: "  Cased.User@Example.TEST ", password: "pw",
    });
    expect(reg.user.email).toBe("cased.user@example.test");   // STORED normalized

    // …logs in from a laptop, typed plainly — and shouted, and padded.
    const plain = await r.call<{ user: { email: string } }>("login",
      { email: "cased.user@example.test", password: "pw" });
    expect(plain.user.email).toBe("cased.user@example.test");
    const shouted = await r.call<{ user: { email: string } }>("login",
      { email: " CASED.USER@EXAMPLE.TEST  ", password: "pw" });
    expect(shouted.user.email).toBe("cased.user@example.test");

    // A different casing is the SAME identity — not a second account.
    await expect(r.call("register", { name: "C", email: "CASED.user@example.test", password: "x" }))
      .rejects.toThrow(/already registered/);
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
    await pgDoc<Board>(host, sql, "board:1", null as unknown as Board, { apply: "board_apply" });
    const url = serve(host);

    const errors: string[] = [];
    const r = client(url, (_d, e) => errors.push(e));
    const before = r.doc<Board>("board:1");        // open fires unauthenticated
    await until(() => errors.length > 0);
    expect(errors[0]).toBe("unauthenticated");
    expect(before.peek()).toBeNull();

    await r.call("login", { email: "pete@blueshed.co.uk", password: "correct-horse" });
    // v0: no automatic re-open after auth — the doc handle re-opens on ask.
    const after = r.doc<Board>("board:1");
    await after.ready;
    expect(after.peek()).not.toBeNull();
  });
});

describe.skipIf(!DB_UP)("housekeeping", () => {
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
