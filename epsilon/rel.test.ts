// The relational tier: tables are the truth, stored functions apply and
// compose, sequences mint ids, doc_ops is the event log AND audit trail.
// Uses the app's own board.sql — the template is the test subject.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { createHost, connect, type Host, type Remote } from "./doc";
import { migrate, pgDoc, pgSync, pgAuth } from "./pg";
import type { Card, Board } from "../types";

const ADMIN_URL = "postgres://epsilon:epsilon@localhost:5599/epsilon";
const PG_URL = process.env.EPSILON_TEST_PG_URL ?? "postgres://epsilon:epsilon@localhost:5599/epsilon_test_rel";
const DB_DIR = new URL("../db", import.meta.url).pathname;

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

function client(url: string) {
  const r = connect(url);
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
  if (!process.env.EPSILON_TEST_PG_URL) {
    const admin = new SQL(ADMIN_URL);
    const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = 'epsilon_test_rel'`;
    if (!exists) await admin.unsafe("CREATE DATABASE epsilon_test_rel");
    await admin.end();
  }
  sql = freshSql();
  await migrate(sql, { dir: DB_DIR });
  await sql.unsafe("TRUNCATE docs, doc_ops, sessions, boards, cards, migrations RESTART IDENTITY CASCADE");
  await sql.unsafe("TRUNCATE users RESTART IDENTITY CASCADE");
  await migrate(sql, { dir: DB_DIR });   // re-seed board 1 + its docs row
});

afterAll(async () => {
  for (const stop of stops) stop();
  for (const r of remotes) r.close();
  for (const s of servers) s.stop(true);
  for (const s of sqls) await s.end?.();
});

describe("relational tier — the tables are the truth", () => {
  test("full stack: register → add /cards/- → sequence id, table row, audit row", async () => {
    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    await pgDoc<Board>(host, sql, "board:1", null as unknown as Board, { apply: "board_apply" });
    const url = serve(host);

    const r = client(url);
    const me = await r.call<{ user: { id: number } }>("register", {
      name: "Pete", email: "pete@rel.test", password: "pw",
    });
    const board = r.doc<Board>("board:1");
    await board.ready;
    expect(board.peek()!.name).toBe("main");            // composed by board_open

    board.at<Record<string, Card>>("/cards").apply([{ op: "add", path: "/-", value: { text: "from the wire" } }]);
    await until(() => Object.keys(board.peek()!.cards).length === 1);

    const id = Object.keys(board.peek()!.cards)[0]!;
    expect(id).toBe("1");                               // Postgres sequence, not a uuid
    const [row] = await sql`SELECT text, board_id FROM cards WHERE id = ${id}`;
    expect(row.text).toBe("from the wire");             // the TABLE is the truth
    const [audit] = await sql`SELECT by_user, ops FROM doc_ops WHERE name = ${"board:1"} AND v = 1`;
    expect(Number(audit.by_user)).toBe(me.user.id);     // event log doubles as audit
    expect(audit.ops[0].path).toBe("/cards/1");         // resolved op in the log
  });

  test("writes express the change — docs.data stays NULL, composition is open-time", async () => {
    const [doc] = await sql`SELECT data, open_fn, v FROM docs WHERE name = ${"board:1"}`;
    expect(doc.data).toBeNull();                        // never recomposed on write
    expect(doc.open_fn).toBe("board_open");
    const [open] = await sql`SELECT doc_open(${"board:1"}) AS d`;
    expect(open.d.cards["1"].text).toBe("from the wire");
  });

  test("lens edits and removes route through the stored function", async () => {
    const host = createHost();
    await pgDoc<Board>(host, sql, "board:1", null as unknown as Board, { apply: "board_apply" });
    const url = serve(host);
    const board = client(url).doc<Board>("board:1");
    await board.ready;

    board.at<string>("/cards/1/text").set("edited");
    await until(() => board.peek()!.cards["1"]!.text === "edited");
    const [row] = await sql`SELECT text FROM cards WHERE id = 1`;
    expect(row.text).toBe("edited");

    board.at<Record<string, Card>>("/cards").apply([{ op: "remove", path: "/1" }]);
    await until(() => board.peek()!.cards["1"] === undefined);
    const gone = await sql`SELECT 1 FROM cards WHERE id = 1`;
    expect(gone.length).toBe(0);
  });

  test("restart: a fresh host hydrates by COMPOSING, version intact", async () => {
    // Board currently has 0 cards (removed above); add one, then 'restart'.
    const seedHost = createHost();
    await pgDoc<Board>(seedHost, sql, "board:1", null as unknown as Board, { apply: "board_apply" });
    const seedUrl = serve(seedHost);
    const seeder = client(seedUrl).doc<Board>("board:1");
    await seeder.ready;
    seeder.at<Record<string, Card>>("/cards").apply([{ op: "add", path: "/-", value: { text: "survivor" } }]);
    await until(() => Object.keys(seeder.peek()!.cards).length === 1);

    const host2 = createHost();
    const board2 = await pgDoc<Board>(host2, sql, "board:1", null as unknown as Board, { apply: "board_apply" });
    const cards = Object.values(board2.peek()!.cards);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toBe("survivor");
    const [doc] = await sql`SELECT v FROM docs WHERE name = ${"board:1"}`;
    expect(host2.v("board:1")).toBe(Number(doc.v));
  });

  test("two processes, concurrent writes: FOR UPDATE serializes, both land", async () => {
    const a = createHost();
    const b = createHost();
    const sqlA = freshSql();
    const sqlB = freshSql();
    await pgDoc<Board>(a, sqlA, "board:1", null as unknown as Board, { apply: "board_apply" });
    await pgDoc<Board>(b, sqlB, "board:1", null as unknown as Board, { apply: "board_apply" });
    stops.push((await pgSync(a, sqlA, { url: PG_URL })).stop, (await pgSync(b, sqlB, { url: PG_URL })).stop);

    const ca = client(serve(a)).doc<Board>("board:1");
    const cb = client(serve(b)).doc<Board>("board:1");
    await Promise.all([ca.ready, cb.ready]);
    const before = Object.keys(ca.peek()!.cards).length;

    ca.at<Record<string, Card>>("/cards").apply([{ op: "add", path: "/-", value: { text: "from A" } }]);
    cb.at<Record<string, Card>>("/cards").apply([{ op: "add", path: "/-", value: { text: "from B" } }]);

    // Both writes land (no lost update), both clients converge via LISTEN.
    await until(() => Object.keys(ca.peek()!.cards).length === before + 2);
    await until(() => Object.keys(cb.peek()!.cards).length === before + 2);
    const texts = Object.values(ca.peek()!.cards).map((c) => c.text).sort();
    expect(texts).toContain("from A");
    expect(texts).toContain("from B");
  });
});

describe("ownership — users mean something", () => {
  test("a private board: the owner writes, a stranger is refused by the FUNCTION", async () => {
    // Two real users via the SQL auth contract.
    const [o] = await sql`SELECT register('Owner', 'owner@own.test', 'pw') AS u`;
    const [s] = await sql`SELECT register('Stranger', 'stranger@own.test', 'pw') AS u`;
    const owner = Number(o.u.id);
    const stranger = Number(s.u.id);

    const [b] = await sql`INSERT INTO boards (name, owner_id) VALUES ('private', ${owner}) RETURNING id`;
    const doc = `board:${b.id}`;
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${doc}, 0, NULL, 'board_open')`;

    // Owner may compose and write.
    const [asOwner] = await sql`SELECT doc_open(${doc}, ${owner}) AS d`;
    expect(asOwner.d.name).toBe("private");
    const ops = [{ op: "add", path: "/cards/-", value: { text: "mine" } }];
    const [w] = await sql.unsafe(`SELECT board_apply($1, $2, $3) AS r`, [doc, ops as unknown, owner]);
    expect(w.r.ops[0].path).toMatch(/^\/cards\/\d+$/);

    // Stranger: composition returns NULL, writes RAISE — same message a
    // missing board gives, so ids can't be probed.
    const [asStranger] = await sql`SELECT doc_open(${doc}, ${stranger}) AS d`;
    expect(asStranger.d).toBeNull();
    let refused = "";
    try {
      await sql.unsafe(`SELECT board_apply($1, $2, $3) AS r`, [doc, ops as unknown, stranger]);
    } catch (err) {
      refused = String(err);
    }
    expect(refused).toMatch(/not found/);

    // And the card that did land is attributed to its author.
    const [card] = await sql`SELECT created_by FROM cards WHERE board_id = ${b.id}`;
    expect(Number(card.created_by)).toBe(owner);
  });

  test("the shared demo board (owner_id NULL) stays open to everyone", async () => {
    const [row] = await sql`SELECT doc_open(${"board:1"}, ${999999}) AS d`;
    expect(row.d).not.toBeNull();
  });
});

describe("lock order — a rename's mirror and a board delete cannot deadlock", () => {
  test("concurrent board_apply(rename) vs mine_apply(remove) of the same board", async () => {
    // 004 locked board→mine on rename while mine_apply's delete locks
    // mine→board — AB-BA. 005 makes the rename take mine FIRST. The delete
    // may still win the race (rename sees "not found") — that's LWW; what
    // must never happen is a deadlock abort.
    const [u] = await sql`SELECT register('Racer', 'racer@lock.test', 'pw') AS u`;
    const uid = Number((u.u as { id: number }).id);
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${"mine:" + uid}, 0, NULL, 'mine_open')
              ON CONFLICT (name) DO NOTHING`;
    const a = freshSql();
    const b = freshSql();   // two pools — genuinely concurrent transactions

    for (let i = 0; i < 8; i++) {
      const mk = await sql.unsafe(
        `SELECT mine_apply($1, $2, $3) AS r`,
        ["mine:" + uid, [{ op: "add", path: "/boards/-", value: { name: `race ${i}` } }] as unknown, uid],
      );
      const bid = Number((mk[0]!.r as { ops: { value: { id: number } }[] }).ops[0]!.value.id);

      const results = await Promise.allSettled([
        a.unsafe(`SELECT board_apply($1, $2, $3)`,
          ["board:" + bid, [{ op: "replace", path: "/name", value: `renamed ${i}` }] as unknown, uid]),
        b.unsafe(`SELECT mine_apply($1, $2, $3)`,
          ["mine:" + uid, [{ op: "remove", path: `/boards/${bid}` }] as unknown, uid]),
      ]);
      for (const res of results) {
        if (res.status === "rejected") {
          expect(String(res.reason)).not.toMatch(/deadlock/i);
        }
      }
    }
  });
});

describe("the vision: per-user docs, creation as an op, multi-doc writes", () => {
  test("mine:<uid> is yours alone — the WIRE refuses strangers like a missing doc", async () => {
    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    host.docs("mine:", async (name, userId) => {
      const uid = Number(name.split(":")[1]);
      if (!Number.isFinite(uid) || Number(userId) !== uid) throw new Error(`unknown doc: ${name}`);
      await pgDoc(host, sql, name, null, {
        apply: "mine_apply", seed: { open_fn: "mine_open" },
        openAs: uid, guard: (u) => Number(u) === uid,
      });
    });
    host.docs("board:", async (name, userId) => {
      const id = Number(name.split(":")[1]);
      const [b] = await sql`SELECT owner_id FROM boards WHERE id = ${id}`;
      if (!b) throw new Error(`unknown doc: ${name}`);
      const owner = b.owner_id == null ? null : Number(b.owner_id);
      if (owner != null && Number(userId) !== owner) throw new Error(`unknown doc: ${name}`);
      await pgDoc(host, sql, name, null, {
        apply: "board_apply", openAs: owner,
        guard: owner == null ? undefined : (u) => Number(u) === owner,
      });
    });
    const url = serve(host);
    // The rename mirror is a cross-doc write delivered by the fan-out
    // machinery — production always runs pgSync; so does this test.
    stops.push((await pgSync(host, sql, { url: PG_URL })).stop);

    // Alice and Mallory.
    const alice = client(url);
    const am = await alice.call<{ user: { id: number } }>("register", {
      name: "Alice", email: "alice@vision.test", password: "pw",
    });
    const aliceId = am.user.id;
    const mallory = client(url);
    await mallory.call("register", { name: "Mallory", email: "mallory@vision.test", password: "pw" });

    // Alice's list opens; Mallory asking for it reads as unknown.
    const mine = alice.doc<{ boards: Record<string, { id: number; name: string }> }>(`mine:${aliceId}`);
    await mine.ready;
    expect(mine.peek()!.boards).toEqual({});
    const spyErrors: string[] = [];
    const mallory2 = connect(url, { onError: (_d: string, e: string) => spyErrors.push(e) });
    remotes.push(mallory2);
    await mallory2.call("login", { email: "mallory@vision.test", password: "pw" });
    mallory2.doc(`mine:${aliceId}`);
    await until(() => spyErrors.length > 0);
    expect(spyErrors[0]).toContain("unknown doc");

    // CREATING A BOARD IS AN OP — the echo carries the sequence id and the
    // board's own doc row now exists.
    mine.at("/boards").apply([{ op: "add", path: "/-", value: { name: "the plan" } }]);
    await until(() => Object.keys(mine.peek()!.boards).length === 1);
    const bid = Object.values(mine.peek()!.boards)[0]!.id;
    const [docRow] = await sql`SELECT open_fn FROM docs WHERE name = ${"board:" + bid}`;
    expect(docRow.open_fn).toBe("board_open");

    // Alice opens her new board over the wire and writes to it.
    const board = alice.doc<Board>(`board:${bid}`);
    await board.ready;
    expect(board.peek()!.name).toBe("the plan");
    board.at<Record<string, Card>>("/cards").apply([{ op: "add", path: "/-", value: { text: "step one" } }]);
    await until(() => Object.keys(board.peek()!.cards).length === 1);

    // Mallory cannot open it — same "unknown doc" a missing board gives.
    mallory2.doc(`board:${bid}`);
    await until(() => spyErrors.length > 1);
    expect(spyErrors[1]).toContain("unknown doc");

    // RENAME MIRRORS across docs in one transaction: board write → mine op.
    const mineVBefore = await sql`SELECT v FROM docs WHERE name = ${"mine:" + aliceId}`;
    board.at<string>("/name").set("the better plan");
    await until(() => mine.peek()!.boards[String(bid)]!.name === "the better plan");
    const [mineOps] = await sql`
      SELECT ops, by_user FROM doc_ops WHERE name = ${"mine:" + aliceId}
      AND v = ${Number(mineVBefore[0].v) + 1}`;
    expect(mineOps.ops[0].path).toBe(`/boards/${bid}`);
    expect(Number(mineOps.by_user)).toBe(aliceId);

    // DELETE CASCADES: cards go via FK, the doc row and log go explicitly.
    mine.at("/boards").apply([{ op: "remove", path: `/${bid}` }]);
    await until(() => Object.keys(mine.peek()!.boards).length === 0);
    const cards = await sql`SELECT 1 FROM cards WHERE board_id = ${bid}`;
    const docsLeft = await sql`SELECT 1 FROM docs WHERE name = ${"board:" + bid}`;
    expect(cards.length).toBe(0);
    expect(docsLeft.length).toBe(0);
  });
});
