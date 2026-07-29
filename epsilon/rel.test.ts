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
    fetch: host.fetch,
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

// A NEW doc type on the doc kit (007): one table, one composition query,
// one dispatch function. This is the recipe a real app copies.
const TODO_SQL = `
CREATE TABLE IF NOT EXISTS todos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text text NOT NULL,
  done boolean NOT NULL DEFAULT false
);

CREATE OR REPLACE FUNCTION todo_open(p_doc text, p_user bigint DEFAULT NULL) RETURNS jsonb AS $$
  SELECT CASE WHEN p_user IS NULL OR p_user <> doc_id(p_doc) THEN NULL ELSE
    jsonb_build_object('todos', COALESCE(
      (SELECT jsonb_object_agg(t.id::text,
         jsonb_build_object('id', t.id, 'text', t.text, 'done', t.done))
         FROM todos t WHERE t.owner_id = doc_id(p_doc)),
      '{}'::jsonb))
  END;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION todo_apply(p_doc text, p_ops jsonb, p_user bigint DEFAULT NULL) RETURNS jsonb AS $$
DECLARE
  v_uid bigint := doc_id(p_doc);
  v_op jsonb; v_p text[]; v_id bigint; v_out jsonb := '[]'::jsonb;
BEGIN
  PERFORM doc_begin(p_doc, p_user = v_uid);
  FOR v_op IN SELECT jsonb_array_elements(p_ops) LOOP
    v_p := doc_path(v_op);
    IF v_p = ARRAY['todos', '-'] AND v_op->>'op' = 'add' THEN
      INSERT INTO todos (owner_id, text) VALUES (v_uid, v_op->'value'->>'text') RETURNING id INTO v_id;
      v_out := v_out || op_add('/todos/' || v_id,
        jsonb_build_object('id', v_id, 'text', v_op->'value'->>'text', 'done', false));
    ELSIF array_length(v_p, 1) = 3 AND v_p[1] = 'todos' AND v_p[3] = 'done' AND v_op->>'op' = 'replace' THEN
      UPDATE todos SET done = (v_op->>'value')::boolean WHERE id = v_p[2]::bigint AND owner_id = v_uid;
      IF NOT FOUND THEN RAISE EXCEPTION 'row not found: %', v_op->>'path'; END IF;
      v_out := v_out || op_replace(v_op->>'path', v_op->'value');
    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'todos' AND v_op->>'op' = 'remove' THEN
      DELETE FROM todos WHERE id = v_p[2]::bigint AND owner_id = v_uid;
      IF FOUND THEN v_out := v_out || op_remove(v_op->>'path'); END IF;
    ELSE
      RAISE EXCEPTION 'unsupported op: % %', v_op->>'op', v_op->>'path';
    END IF;
  END LOOP;
  RETURN doc_commit(p_doc, v_out, p_user);
END;
$$ LANGUAGE plpgsql;
`;

describe("the doc kit — a new doc type is dispatch + composition only", () => {
  test("todo: full wire round trip on kit-built SQL", async () => {
    await sql.unsafe(TODO_SQL);
    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    host.docs("todo:", async (name, userId) => {
      const uid = Number(name.split(":")[1]);
      if (!Number.isFinite(uid) || Number(userId) !== uid) throw new Error(`unknown doc: ${name}`);
      await pgDoc(host, sql, name, null, {
        apply: "todo_apply", seed: { open_fn: "todo_open" },
        openAs: uid, guard: (u) => Number(u) === uid,
      });
    });
    const url = serve(host);

    const r = client(url);
    const me = await r.call<{ user: { id: number } }>("register", {
      name: "Kit", email: "kit@kit.test", password: "pw",
    });
    const uid = me.user.id;
    type Todos = { todos: Record<string, { id: number; text: string; done: boolean }> };
    const doc = r.doc<Todos>(`todo:${uid}`);
    await doc.ready;
    expect(doc.peek()!.todos).toEqual({});

    doc.at("/todos").apply([{ op: "add", path: "/-", value: { text: "ship the kit" } }]);
    await until(() => Object.keys(doc.peek()!.todos).length === 1);
    const id = Object.keys(doc.peek()!.todos)[0]!;
    expect(doc.peek()!.todos[id]!.done).toBe(false);   // sequence id, echoed row

    doc.at<boolean>(`/todos/${id}/done`).set(true);
    await until(() => doc.peek()!.todos[id]!.done === true);
    const [row] = await sql`SELECT done FROM todos WHERE id = ${id}`;
    expect(row.done).toBe(true);                       // the table is the truth

    doc.at("/todos").apply([{ op: "remove", path: `/${id}` }]);
    await until(() => Object.keys(doc.peek()!.todos).length === 0);

    const [audit] = await sql`SELECT by_user FROM doc_ops WHERE name = ${"todo:" + uid} AND v = 1`;
    expect(Number(audit.by_user)).toBe(uid);           // doc_commit wrote the audit row
  });
});

describe("sharing — members make multi-user real (009)", () => {
  interface MineDoc { boards: Record<string, { id: number; name: string; shared?: boolean }> }

  test("add by email → member's list updates live; member writes; leaving and deleting revoke", async () => {
    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    const may = async (id: number, u?: number | string) => {
      const [r] = await sql`SELECT board_may(${id}, ${u == null ? null : Number(u)}) AS ok`;
      return !!r?.ok;
    };
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
      if (!b || !(await may(id, userId))) throw new Error(`unknown doc: ${name}`);
      const owner = b.owner_id == null ? null : Number(b.owner_id);
      await pgDoc(host, sql, name, null, {
        apply: "board_apply", openAs: owner,
        guard: owner == null ? undefined : (u) => may(id, u),
      });
    });
    const url = serve(host);
    stops.push((await pgSync(host, sql, { url: PG_URL })).stop);

    const owner = client(url);
    const om = await owner.call<{ user: { id: number } }>("register", {
      name: "Owner", email: "owner@share.test", password: "pw",
    });
    const oid = om.user.id;
    const friendErrors: string[] = [];
    const friend = connect(url, { onError: (_d: string, e: string) => friendErrors.push(e) });
    remotes.push(friend);
    const fm = await friend.call<{ user: { id: number } }>("register", {
      name: "Friend", email: "friend@share.test", password: "pw",
    });
    const fid = fm.user.id;

    // Owner creates a board; the friend probing it reads as a missing doc.
    const oMine = owner.doc<MineDoc>(`mine:${oid}`);
    await oMine.ready;
    oMine.at("/boards").apply([{ op: "add", path: "/-", value: { name: "shared plan" } }]);
    await until(() => Object.keys(oMine.peek()!.boards).length === 1);
    const bid = Object.values(oMine.peek()!.boards)[0]!.id;

    friend.doc(`board:${bid}`);
    await until(() => friendErrors.length > 0);
    expect(friendErrors[0]).toContain("unknown doc");

    const fMine = friend.doc<MineDoc>(`mine:${fid}`);
    await fMine.ready;
    expect(fMine.peek()!.boards).toEqual({});

    // SHARE BY EMAIL: one op on the board; the echo carries the member row
    // and the mirror lands in the friend's own list, live, over the fan-out.
    const oBoard = owner.doc<Board>(`board:${bid}`);
    await oBoard.ready;
    oBoard.at("/members").apply([{ op: "add", path: "/-", value: { email: "friend@share.test" } }]);
    await until(() => fMine.peek()!.boards[String(bid)] !== undefined);
    expect(fMine.peek()!.boards[String(bid)]!.shared).toBe(true);
    expect(oBoard.peek()!.members![String(fid)]!.email).toBe("friend@share.test");

    // The member opens the same doc name and WRITES — attributed to them.
    const fBoard = friend.doc<Board>(`board:${bid}`);
    await fBoard.ready;
    fBoard.at("/cards").apply([{ op: "add", path: "/-", value: { text: "from the friend" } }]);
    await until(() => Object.values(oBoard.peek()!.cards).some((c) => c.text === "from the friend"));
    const [card] = await sql`SELECT created_by FROM cards WHERE board_id = ${bid}`;
    expect(Number(card.created_by)).toBe(fid);

    // A rename mirrors into EVERY list showing the board — and the precise
    // path keeps the friend's `shared` flag intact.
    oBoard.at<string>("/name").set("our plan");
    await until(() => fMine.peek()!.boards[String(bid)]!.name === "our plan");
    expect(fMine.peek()!.boards[String(bid)]!.shared).toBe(true);

    // LEAVING: the friend removes the board from their own list; the board
    // hears it and the membership row dies. Access ends at the next open.
    fMine.at("/boards").apply([{ op: "remove", path: `/${bid}` }]);
    await until(() => fMine.peek()!.boards[String(bid)] === undefined);
    await until(() => oBoard.peek()!.members![String(fid)] === undefined);
    expect((await sql`SELECT 1 FROM board_members WHERE board_id = ${bid}`).length).toBe(0);
    const [reopen] = await sql`SELECT doc_open(${"board:" + bid}, ${fid}) AS d`;
    expect(reopen.d).toBeNull();

    // DELETE cascades to members' lists: re-share, then the owner deletes.
    oBoard.at("/members").apply([{ op: "add", path: "/-", value: { email: "friend@share.test" } }]);
    await until(() => fMine.peek()!.boards[String(bid)] !== undefined);
    oMine.at("/boards").apply([{ op: "remove", path: `/${bid}` }]);
    await until(() => oMine.peek()!.boards[String(bid)] === undefined);
    await until(() => fMine.peek()!.boards[String(bid)] === undefined);
    expect((await sql`SELECT 1 FROM docs WHERE name = ${"board:" + bid}`).length).toBe(0);
  });

  test("the function refuses: unknown email, non-owner invites, double add", async () => {
    const [o] = await sql`SELECT register('Boss', 'boss@ref.test', 'pw') AS u`;
    const [m] = await sql`SELECT register('Mate', 'mate@ref.test', 'pw') AS u`;
    const boss = Number((o.u as { id: number }).id);
    const mate = Number((m.u as { id: number }).id);
    const [b] = await sql`INSERT INTO boards (name, owner_id) VALUES ('refusals', ${boss}) RETURNING id`;
    const doc = `board:${b.id}`;
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${doc}, 0, NULL, 'board_open')`;
    const addOp = (email: string) => [{ op: "add", path: "/members/-", value: { email } }];

    let err = "";
    try { await sql.unsafe(`SELECT board_apply($1, $2, $3)`, [doc, addOp("nobody@ref.test") as unknown, boss]); }
    catch (e) { err = String(e); }
    expect(err).toContain("unknown user");

    await sql.unsafe(`SELECT board_apply($1, $2, $3)`, [doc, addOp("mate@ref.test") as unknown, boss]);
    err = "";
    try { await sql.unsafe(`SELECT board_apply($1, $2, $3)`, [doc, addOp("boss@ref.test") as unknown, mate]); }
    catch (e) { err = String(e); }
    expect(err).toContain("owner only");

    err = "";
    try { await sql.unsafe(`SELECT board_apply($1, $2, $3)`, [doc, addOp("mate@ref.test") as unknown, boss]); }
    catch (e) { err = String(e); }
    expect(err).toContain("already a member");

    // The owner removes the member; the row is gone.
    const rm = await sql.unsafe(`SELECT board_apply($1, $2, $3) AS r`,
      [doc, [{ op: "remove", path: `/members/${mate}` }] as unknown, boss]);
    expect((rm[0]!.r as { ops: { path: string }[] }).ops[0]!.path).toBe(`/members/${mate}`);
    expect((await sql`SELECT 1 FROM board_members WHERE board_id = ${b.id}`).length).toBe(0);
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

    // RENAME MIRRORS across docs in one transaction: board write → mine op,
    // path-precise (/boards/<id>/name) so sibling fields survive.
    const mineVBefore = await sql`SELECT v FROM docs WHERE name = ${"mine:" + aliceId}`;
    board.at<string>("/name").set("the better plan");
    await until(() => mine.peek()!.boards[String(bid)]!.name === "the better plan");
    const [mineOps] = await sql`
      SELECT ops, by_user FROM doc_ops WHERE name = ${"mine:" + aliceId}
      AND v = ${Number(mineVBefore[0].v) + 1}`;
    expect(mineOps.ops[0].path).toBe(`/boards/${bid}/name`);
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
