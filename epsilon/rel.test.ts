// The relational tier: tables are the truth, stored functions apply and
// compose, sequences mint ids, doc_ops is the event log AND audit trail.
// Uses the app's own board.sql — the template is the test subject.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { createHost, connect, type Host, type Remote } from "./doc";
import type { Signal } from "./signal";
import { migrate, pgDoc, pgSync, pgAuth, pgUndo, pgAdmin } from "./pg";
import type { Card, Board } from "../types";

// Test db namespaced by app (package.json name) — see pg.test.ts's note.
const APP = ((await Bun.file(new URL("../package.json", import.meta.url)).json()).name as string)
  .toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^(?![a-z_])/, "app_");
const DB = `${APP}_test_rel`;
const ADMIN_URL = "postgres://epsilon:epsilon@localhost:5599/epsilon";
const PG_URL = process.env.EPSILON_TEST_PG_URL ?? `postgres://epsilon:epsilon@localhost:5599/${DB}`;
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
    const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${DB}`;
    if (!exists) await admin.unsafe(`CREATE DATABASE ${DB}`);
    await admin.end();
  }
  sql = freshSql();
  // Fresh schema, fresh ledger — frozen files only re-apply from nothing
  // (see pg.test.ts). Migrating seeds board 1 + its docs row.
  await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await migrate(sql, { dir: DB_DIR });
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

// A NEW doc type on the doc kit (003): one table, one composition query,
// one dispatch function. This is the recipe a real app copies.
const TODO_SQL = `
CREATE TABLE IF NOT EXISTS todos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text text NOT NULL,
  done boolean NOT NULL DEFAULT false
);

-- NULL user = the HOST composing its own copy (001's rule); refusal is for
-- non-NULL strangers. pgDoc's default gate asks THIS function per open.
CREATE OR REPLACE FUNCTION todo_open(p_doc text, p_user bigint DEFAULT NULL) RETURNS jsonb AS $$
  SELECT CASE WHEN p_user IS NOT NULL AND p_user <> doc_id(p_doc) THEN NULL ELSE
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
      // No guard: the default open gate asks todo_open(name, user) itself.
      await pgDoc(host, sql, name, null, {
        apply: "todo_apply", seed: { open_fn: "todo_open" },
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
      });
    });
    host.docs("board:", async (name, userId) => {
      const id = Number(name.split(":")[1]);
      const [b] = await sql`SELECT 1 FROM boards WHERE id = ${id}`;
      if (!b || !(await may(id, userId))) throw new Error(`unknown doc: ${name}`);
      // No guard: the default gate asks board_open(name, user) per open, so
      // membership granted or revoked while hosted bites at the next open.
      await pgDoc(host, sql, name, null, { apply: "board_apply" });
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

    // Emails compare normalized: a cased, padded variant is the SAME person
    // — refused as already-a-member, not mistaken for a stranger.
    err = "";
    try { await sql.unsafe(`SELECT board_apply($1, $2, $3)`, [doc, addOp("  MATE@Ref.TEST ") as unknown, boss]); }
    catch (e) { err = String(e); }
    expect(err).toContain("already a member");

    // The owner removes the member; the row is gone.
    const rm = await sql.unsafe(`SELECT board_apply($1, $2, $3) AS r`,
      [doc, [{ op: "remove", path: `/members/${mate}` }] as unknown, boss]);
    expect((rm[0]!.r as { ops: { path: string }[] }).ops[0]!.path).toBe(`/members/${mate}`);
    expect((await sql`SELECT 1 FROM board_members WHERE board_id = ${b.id}`).length).toBe(0);
  });
});

describe("undo — the log knows what was there", () => {
  let uid: number;
  let fid: number;
  let bid: number;
  let doc: string;
  const apply = (ops: unknown, user: number) =>
    sql.unsafe(`SELECT board_apply($1, $2, $3) AS r`, [doc, ops, user]);
  const undo = (user: number, v?: number) =>
    sql.unsafe(`SELECT doc_undo($1, $2, $3, 'board_apply') AS r`, [doc, v ?? null, user]);
  const echoOf = (rows: any) => rows[0]!.r as { v: number | string; ops: { op: string; path: string; value?: any }[] };

  beforeAll(async () => {
    const [u] = await sql`SELECT register('Undoer', 'undoer@undo.test', 'pw') AS u`;
    const [f] = await sql`SELECT register('Fellow', 'fellow@undo.test', 'pw') AS u`;
    uid = Number((u.u as { id: number }).id);
    fid = Number((f.u as { id: number }).id);
    const [b] = await sql`INSERT INTO boards (name, owner_id) VALUES ('undoable', ${uid}) RETURNING id`;
    bid = Number(b.id);
    doc = `board:${bid}`;
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${doc}, 0, NULL, 'board_open')`;
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${"mine:" + uid}, 0, NULL, 'mine_open')
              ON CONFLICT (name) DO NOTHING`;
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${"mine:" + fid}, 0, NULL, 'mine_open')
              ON CONFLICT (name) DO NOTHING`;
    await apply([{ op: "add", path: "/members/-", value: { email: "fellow@undo.test" } }], uid);
  });

  test("a remove's undo restores the row — same id, same author; the sequence is repaired", async () => {
    const add = echoOf(await apply([{ op: "add", path: "/cards/-", value: { text: "precious" } }], uid));
    const cardPath = add.ops[0]!.path;
    const cid = Number(cardPath.split("/")[2]);
    const rm = echoOf(await apply([{ op: "remove", path: cardPath }], uid));

    // The log recorded the inverse: an add AT the id, carrying the row.
    const [logged] = await sql`SELECT undo FROM doc_ops WHERE name = ${doc} AND v = ${Number(rm.v)}`;
    expect(logged.undo[0].op).toBe("add");
    expect(logged.undo[0].path).toBe(cardPath);
    expect(logged.undo[0].value.text).toBe("precious");

    const back = echoOf(await undo(uid, Number(rm.v)));
    expect(back.ops[0]!.op).toBe("add");
    expect(back.ops[0]!.path).toBe(cardPath);              // the exact id, restored
    const [row] = await sql`SELECT text, created_by FROM cards WHERE id = ${cid}`;
    expect(row.text).toBe("precious");
    expect(Number(row.created_by)).toBe(uid);              // authorship rode the value
    // The restore realigned the sequence — the next mint cannot collide.
    const next = echoOf(await apply([{ op: "add", path: "/cards/-", value: { text: "after" } }], uid));
    expect(Number(next.ops[0]!.path.split("/")[2])).toBeGreaterThan(cid);
  });

  test("no version = undo YOUR last write, not the doc's", async () => {
    const mine = echoOf(await apply([{ op: "add", path: "/cards/-", value: { text: "mine to undo" } }], uid));
    const theirs = echoOf(await apply([{ op: "add", path: "/cards/-", value: { text: "theirs stays" } }], fid));
    expect(Number(theirs.v)).toBeGreaterThan(Number(mine.v));   // theirs IS the doc's last

    const undone = echoOf(await undo(uid));                     // …but this undoes MINE
    expect(undone.ops[0]).toEqual({ op: "remove", path: mine.ops[0]!.path });
    const texts = (await sql`SELECT text FROM cards WHERE board_id = ${bid}`).map((r: any) => r.text);
    expect(texts).not.toContain("mine to undo");
    expect(texts).toContain("theirs stays");
  });

  test("refusals: changed since, no undo recorded, unknown version — and undo is a write", async () => {
    const add = echoOf(await apply([{ op: "add", path: "/cards/-", value: { text: "contested" } }], uid));
    const path = add.ops[0]!.path;
    const edit = echoOf(await apply([{ op: "replace", path: `${path}/text`, value: "fellow's edit" }], fid));
    const last = echoOf(await apply([{ op: "replace", path: `${path}/text`, value: "owner's edit" }], uid));

    // Someone changed it after — refuse rather than clobber their edit.
    let err = "";
    try { await undo(fid, Number(edit.v)); } catch (e) { err = String(e); }
    expect(err).toContain("changed since");

    // mine_apply records no undo (its ops create/delete whole docs).
    const mk = await sql.unsafe(`SELECT mine_apply($1, $2, $3) AS r`,
      ["mine:" + uid, [{ op: "add", path: "/boards/-", value: { name: "no undo here" } }] as unknown, uid]);
    err = "";
    try {
      await sql.unsafe(`SELECT doc_undo($1, $2, $3, 'mine_apply') AS r`,
        ["mine:" + uid, Number((mk[0]!.r as { v: number }).v), uid]);
    } catch (e) { err = String(e); }
    expect(err).toContain("no undo recorded");

    err = "";
    try { await undo(uid, 999999); } catch (e) { err = String(e); }
    expect(err).toContain("unknown version");

    // Undo is a WRITE: the dispatched apply re-checks the permit. (The
    // stranger aims at the LATEST version — no conflict in the way — and
    // still gets the same "not found" a missing board gives.)
    const [s] = await sql`SELECT register('Stranger', 'stranger@undo.test', 'pw') AS u`;
    err = "";
    try { await undo(Number((s.u as { id: number }).id), Number(last.v)); } catch (e) { err = String(e); }
    expect(err).toContain("not found");
  });

  test("the undo of an undo is the redo; a second undo of the same v refuses", async () => {
    const add = echoOf(await apply([{ op: "add", path: "/cards/-", value: { text: "flip" } }], uid));
    const cid = Number(add.ops[0]!.path.split("/")[2]);
    const un = echoOf(await undo(uid, Number(add.v)));
    expect((await sql`SELECT 1 FROM cards WHERE id = ${cid}`).length).toBe(0);
    await undo(uid, Number(un.v));                              // redo
    expect((await sql`SELECT 1 FROM cards WHERE id = ${cid}`).length).toBe(1);
    let err = "";
    try { await undo(uid, Number(add.v)); } catch (e) { err = String(e); }
    expect(err).toContain("changed since");                     // the redo touched it
  });

  test("undoing a member removal restores membership AND fires the mirror again", async () => {
    const rm = echoOf(await apply([{ op: "remove", path: `/members/${fid}` }], uid));
    expect((await sql`SELECT 1 FROM board_members WHERE board_id = ${bid}`).length).toBe(0);

    const back = echoOf(await undo(uid, Number(rm.v)));
    expect(back.ops[0]!.path).toBe(`/members/${fid}`);
    expect((await sql`SELECT 1 FROM board_members WHERE board_id = ${bid} AND user_id = ${fid}`).length).toBe(1);
    // The member's own list heard the restore in the same transaction.
    const [mirror] = await sql`
      SELECT ops FROM doc_ops WHERE name = ${"mine:" + fid} ORDER BY v DESC LIMIT 1`;
    expect(mirror.ops[0].path).toBe(`/boards/${bid}`);
    expect(mirror.ops[0].value.shared).toBe(true);
  });

  test("doc_cascade_remove turns an FK cascade into ops the log can carry", async () => {
    await sql.unsafe(`
      DROP TABLE IF EXISTS cr_stops, cr_legs;
      CREATE TABLE cr_legs (id bigint PRIMARY KEY);
      CREATE TABLE cr_stops (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        leg_id bigint NOT NULL REFERENCES cr_legs(id) ON DELETE CASCADE);
      INSERT INTO cr_legs VALUES (7), (8);
      INSERT INTO cr_stops (leg_id) VALUES (7), (7), (7), (8);`);
    const [r] = await sql`SELECT doc_cascade_remove('cr_stops', 'leg_id', 7, '/stops/') AS ops`;
    expect(r.ops.map((o: { op: string; path: string }) => o)).toEqual([
      { op: "remove", path: "/stops/1" },
      { op: "remove", path: "/stops/2" },
      { op: "remove", path: "/stops/3" },
    ]);
    expect((await sql`SELECT 1 FROM cr_stops WHERE leg_id = 7`).length).toBe(0);   // deleted here…
    expect((await sql`SELECT 1 FROM cr_stops WHERE leg_id = 8`).length).toBe(1);   // …not there
  });
});

describe("undo over the wire — pgUndo re-enters the hosted doc, no pgSync needed", () => {
  test("call('undo') reverts the caller's last write; undo again = redo", async () => {
    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    host.docs("board:", async (name, userId) => {
      const id = Number(name.split(":")[1]);
      const [b] = await sql`SELECT owner_id FROM boards WHERE id = ${id}`;
      if (!b || Number(userId) !== Number(b.owner_id)) throw new Error(`unknown doc: ${name}`);
      await pgDoc(host, sql, name, null, { apply: "board_apply" });
    });
    pgUndo(host, sql, (d) => (d.startsWith("board:") ? "board_apply" : undefined));
    const url = serve(host);   // deliberately NO pgSync — pgReceive must deliver

    const r = client(url);
    const me = await r.call<{ user: { id: number } }>("register", {
      name: "Wire", email: "wire@undo.test", password: "pw",
    });
    const [b] = await sql`INSERT INTO boards (name, owner_id) VALUES ('wire-undo', ${me.user.id}) RETURNING id`;
    const name = `board:${b.id}`;
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${name}, 0, NULL, 'board_open')`;

    const doc = r.doc<Board>(name);
    await doc.ready;
    doc.at("/cards").apply([{ op: "add", path: "/-", value: { text: "oops" } }]);
    await until(() => Object.keys(doc.peek()!.cards).length === 1);

    const undone = await r.call<{ ops: { op: string }[] }>("undo", { doc: name });
    expect(undone.ops[0]!.op).toBe("remove");
    await until(() => Object.keys(doc.peek()!.cards).length === 0);   // the echo reached us

    await r.call("undo", { doc: name });                              // my last = the undo → redo
    await until(() => Object.keys(doc.peek()!.cards).length === 1);
    expect(Object.values(doc.peek()!.cards)[0]!.text).toBe("oops");
  });
});

describe("presence — exactly as private as the board it watches", () => {
  test("refused while the doc is LIVE, not just at first host; never written in", async () => {
    // The trap this pins: a factory refusal guards only the FIRST open —
    // the doc outlives its opener, and an in-memory doc has no doc_open
    // gate to default to. The open gate must re-ask the board's permit.
    let sid = 0;
    const presenceOf = (name: string) =>
      host.names().includes(name) ? host.doc<Record<string, { name: string }>>(name, {}) : null;
    const host: Host = createHost({
      requireAuth: true,
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
    await pgAuth(host, sql);
    const may = async (id: number, u?: number | string) => {
      const [r] = await sql`SELECT board_may(${id}, ${u == null ? null : Number(u)}) AS ok`;
      return !!r?.ok;
    };
    host.docs("presence:", async (name, userId) => {
      const id = Number(name.split(":")[2]);
      if (!Number.isFinite(id) || !(await may(id, userId))) throw new Error(`unknown doc: ${name}`);
      let sig!: Signal<Record<string, { name: string }>>;
      sig = host.doc<Record<string, { name: string }>>(name, {}, {
        open: async (u) => ((await may(id, u)) ? sig.peek() : null),
      });
    });
    const url = serve(host);

    const owner = client(url);
    const om = await owner.call<{ user: { id: number } }>("register", {
      name: "Present", email: "present@presence.test", password: "pw",
    });
    const [b] = await sql`INSERT INTO boards (name, owner_id) VALUES ('occupied', ${om.user.id}) RETURNING id`;
    const name = `presence:board:${b.id}`;

    const here = owner.doc<Record<string, { name: string }>>(name);
    await here.ready;
    await until(() => Object.keys(here.peek() ?? {}).length === 1);   // the owner, written by the hook

    // The doc is HOSTED now — the stranger's open must still read as a
    // missing doc, and they must never appear as "here".
    const errors: string[] = [];
    const stranger = connect(url, { onError: (_d: string, e: string) => errors.push(e) });
    remotes.push(stranger);
    await stranger.call("register", {
      name: "Lurker", email: "lurker@presence.test", password: "pw",
    });
    stranger.doc(name);
    await until(() => errors.length > 0);
    expect(errors[0]).toContain("unknown doc");
    await new Promise((r) => setTimeout(r, 50));                      // any wrongful hook write lands by now
    expect(Object.keys(here.peek() ?? {}).length).toBe(1);            // still just the owner
    expect(Object.values(here.peek()!)[0]!.name).toBe("Present");
  });
});

describe("the law, executable — the op stream must equal recompute-from-state", () => {
  test("after every op shape the client copy equals compose-from-tables", async () => {
    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    host.docs("board:", async (name, userId) => {
      const id = Number(name.split(":")[1]);
      const [b] = await sql`SELECT owner_id FROM boards WHERE id = ${id}`;
      if (!b || Number(userId) !== Number(b.owner_id)) throw new Error(`unknown doc: ${name}`);
      await pgDoc(host, sql, name, null, { apply: "board_apply" });
    });
    const url = serve(host);
    const r = client(url);
    const me = await r.call<{ user: { id: number } }>("register", {
      name: "Law", email: "law@law.test", password: "pw",
    });
    const uid = me.user.id;
    const [b] = await sql`INSERT INTO boards (name, owner_id) VALUES ('law', ${uid}) RETURNING id`;
    const name = `board:${b.id}`;
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${name}, 0, NULL, 'board_open')`;

    const doc = r.doc<Board>(name);
    await doc.ready;
    // The assertion the whole design hangs on: what the ops built must equal
    // what the tables compose. An op stream that lies fails HERE.
    const same = async () => {
      const [row] = await sql`SELECT doc_open(${name}) AS d`;
      expect(doc.peek()).toEqual(row.d);
    };
    await same();

    doc.at("/cards").apply([{ op: "add", path: "/-", value: { text: "one" } }]);
    await until(() => Object.keys(doc.peek()!.cards).length === 1);
    await same();
    const id = Object.keys(doc.peek()!.cards)[0]!;

    doc.at<string>(`/cards/${id}/text`).set("edited");
    await until(() => doc.peek()!.cards[id]!.text === "edited");
    await same();

    doc.at<boolean>(`/cards/${id}/done`).set(true);
    await until(() => doc.peek()!.cards[id]!.done === true);
    await same();

    // Whole-row replace — the echo shape as INPUT (the kit's rule).
    doc.at<Card>(`/cards/${id}`).set({ id: Number(id), text: "whole", done: false });
    await until(() => doc.peek()!.cards[id]!.text === "whole");
    await same();

    doc.at<string>("/name").set("law, renamed");
    await until(() => doc.peek()!.name === "law, renamed");
    await same();

    const row = doc.peek()!.cards[id]!;
    doc.at("/cards").apply([{ op: "remove", path: `/${id}` }]);
    await until(() => doc.peek()!.cards[id] === undefined);
    await same();

    // Restore at the exact id, over the wire — the other half of the kit's rule.
    doc.at("/cards").apply([{ op: "add", path: `/${id}`, value: row }]);
    await until(() => doc.peek()!.cards[id] !== undefined);
    await same();
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
      });
    });
    host.docs("board:", async (name, userId) => {
      const id = Number(name.split(":")[1]);
      const [b] = await sql`SELECT owner_id FROM boards WHERE id = ${id}`;
      if (!b) throw new Error(`unknown doc: ${name}`);
      const owner = b.owner_id == null ? null : Number(b.owner_id);
      if (owner != null && Number(userId) !== owner) throw new Error(`unknown doc: ${name}`);
      await pgDoc(host, sql, name, null, { apply: "board_apply" });
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

describe("gone is a snapshot of nothing — deletion and revocation bite live sockets", () => {
  interface MineDoc { boards: Record<string, { id: number; name: string; shared?: boolean }> }

  test("the apply result names what it dropped — and leaving drops nothing", async () => {
    const [u] = await sql`SELECT register('Gone', 'gone@gone.test', 'pw') AS u`;
    const uid = Number(u.u.id);
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${"mine:" + uid}, 0, NULL, 'mine_open')`;
    const [made] = await sql`SELECT mine_apply(${"mine:" + uid},
      ${[{ op: "add", path: "/boards/-", value: { name: "brief" } }] as any}, ${uid}) AS r`;
    expect(made.r.gone).toBeUndefined();          // creation drops nothing
    const bid = Number(made.r.ops[0].value.id);

    const [dropped] = await sql`SELECT mine_apply(${"mine:" + uid},
      ${[{ op: "remove", path: `/boards/${bid}` }] as any}, ${uid}) AS r`;
    expect(dropped.r.gone).toEqual([`board:${bid}`]);
    expect((await sql`SELECT 1 FROM docs WHERE name = ${"board:" + bid}`).length).toBe(0);

    // Leaving a SHARED board removes only the membership — nothing is gone.
    const [o] = await sql`SELECT register('Keeper', 'keeper@gone.test', 'pw') AS u`;
    const [b] = await sql`INSERT INTO boards (name, owner_id) VALUES ('kept', ${Number(o.u.id)}) RETURNING id`;
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${"board:" + b.id}, 0, NULL, 'board_open')`;
    await sql`INSERT INTO board_members (board_id, user_id) VALUES (${b.id}, ${uid})`;
    const [left] = await sql`SELECT mine_apply(${"mine:" + uid},
      ${[{ op: "remove", path: `/boards/${b.id}` }] as any}, ${uid}) AS r`;
    expect(left.r.gone).toBeUndefined();
    expect((await sql`SELECT 1 FROM docs WHERE name = ${"board:" + b.id}`).length).toBe(1);
  });

  test("owner deletes a WATCHED board: watchers null on BOTH processes, nothing re-hosts", async () => {
    // Two processes: A is the writer (no sync — the apply result's `gone`
    // un-hosts there), B a sibling hearing doc_drop's doorbell via LISTEN.
    const a = createHost({ requireAuth: true });
    const b = createHost({ requireAuth: true });
    const sqlA = freshSql();
    const sqlB = freshSql();
    await pgAuth(a, sqlA);
    await pgAuth(b, sqlB);
    const factories = (host: Host, s: SQL) => {
      host.docs("mine:", async (name, userId) => {
        const uid = Number(name.split(":")[1]);
        if (!Number.isFinite(uid) || Number(userId) !== uid) throw new Error(`unknown doc: ${name}`);
        await pgDoc(host, s, name, null, { apply: "mine_apply", seed: { open_fn: "mine_open" } });
      });
      host.docs("board:", async (name, userId) => {
        const id = Number(name.split(":")[1]);
        const [row] = await s`SELECT 1 FROM boards WHERE id = ${id}`;
        const [ok] = await s`SELECT board_may(${id}, ${userId == null ? null : Number(userId)}) AS ok`;
        if (!row || !ok?.ok) throw new Error(`unknown doc: ${name}`);
        await pgDoc(host, s, name, null, { apply: "board_apply" });
      });
    };
    factories(a, sqlA);
    factories(b, sqlB);
    const urlA = serve(a);
    const urlB = serve(b);
    stops.push((await pgSync(b, sqlB, { url: PG_URL })).stop);

    const owner = client(urlA);
    const om = await owner.call<{ user: { id: number } }>("register", {
      name: "Own", email: "own@gone.test", password: "pw",
    });
    const friend = client(urlB);
    const fm = await friend.call<{ user: { id: number } }>("register", {
      name: "Fr", email: "fr@gone.test", password: "pw",
    });

    const oMine = owner.doc<MineDoc>(`mine:${om.user.id}`);
    await oMine.ready;
    oMine.at("/boards").apply([{ op: "add", path: "/-", value: { name: "doomed" } }]);
    await until(() => Object.keys(oMine.peek()!.boards).length === 1);
    const bid = Object.values(oMine.peek()!.boards)[0]!.id;
    const oBoard = owner.doc<Board>(`board:${bid}`);
    await oBoard.ready;
    oBoard.at("/members").apply([{ op: "add", path: "/-", value: { email: "fr@gone.test" } }]);
    await until(() => oBoard.peek()!.members?.[String(fm.user.id)] !== undefined);
    const fBoard = friend.doc<Board>(`board:${bid}`);
    await fBoard.ready;

    oMine.at("/boards").apply([{ op: "remove", path: `/${bid}` }]);
    await until(() => oBoard.peek() === null);                     // the writer's watchers
    await until(() => fBoard.peek() === null);                     // the sibling's, by doorbell
    await until(() => !a.names().includes(`board:${bid}`) && !b.names().includes(`board:${bid}`));
    expect((await sql`SELECT 1 FROM docs WHERE name = ${"board:" + bid}`).length).toBe(0);

    // A later ask reads as a doc that never existed — no existence oracle.
    const errors: string[] = [];
    const late = connect(urlB, { onError: (_d: string, e: string) => errors.push(e) });
    remotes.push(late);
    await late.call("login", { email: "fr@gone.test", password: "pw" });
    late.doc(`board:${bid}`);
    await until(() => errors.length > 0);
    expect(errors[0]).toContain("unknown doc");
  });

  test("removing a member evicts their LIVE board and presence watchers (server.ts's wiring)", async () => {
    let sid = 0;
    const presenceOf = (name: string) =>
      host.names().includes(name) ? host.doc<Record<string, { name: string }>>(name, {}) : null;
    const host: Host = createHost({
      requireAuth: true,
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
    await pgAuth(host, sql);
    const may = async (id: number, u?: number | string) => {
      const [r] = await sql`SELECT board_may(${id}, ${u == null ? null : Number(u)}) AS ok`;
      return !!r?.ok;
    };
    host.docs("board:", async (name, userId) => {
      const id = Number(name.split(":")[1]);
      const [row] = await sql`SELECT 1 FROM boards WHERE id = ${id}`;
      if (!row || !(await may(id, userId))) throw new Error(`unknown doc: ${name}`);
      const sig = await pgDoc<Board>(host, sql, name, null as unknown as Board, { apply: "board_apply" });
      sig.onOps((ops) => ops?.forEach((op) => {
        const m = op.op === "remove" ? /^\/members\/(\d+)$/.exec(op.path) : null;
        if (!m) return;
        void host.expel(name, Number(m[1]));
        void host.expel(`presence:${name}`, Number(m[1]));
      }));
    });
    host.docs("presence:", async (name, userId) => {
      const id = Number(name.split(":")[2]);
      if (!Number.isFinite(id) || !(await may(id, userId))) throw new Error(`unknown doc: ${name}`);
      let sig!: Signal<Record<string, { name: string }>>;
      sig = host.doc<Record<string, { name: string }>>(name, {}, {
        open: async (u) => ((await may(id, u)) ? sig.peek() : null),
      });
    });
    const url = serve(host);

    const owner = client(url);
    const om = await owner.call<{ user: { id: number } }>("register", {
      name: "Boss", email: "boss@expel.test", password: "pw",
    });
    const member = client(url);
    const mm = await member.call<{ user: { id: number } }>("register", {
      name: "Out", email: "out@expel.test", password: "pw",
    });
    const [b] = await sql`INSERT INTO boards (name, owner_id) VALUES ('club', ${om.user.id}) RETURNING id`;
    const name = `board:${b.id}`;
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${name}, 0, NULL, 'board_open')`;
    await sql`INSERT INTO board_members (board_id, user_id) VALUES (${b.id}, ${mm.user.id})`;

    const mBoard = member.doc<Board>(name);
    const mHere = member.doc<Record<string, { name: string }>>(`presence:${name}`);
    const oBoard = owner.doc<Board>(name);
    const oHere = owner.doc<Record<string, { name: string }>>(`presence:${name}`);
    await Promise.all([mBoard.ready, mHere.ready, oBoard.ready, oHere.ready]);
    await until(() => Object.keys(oHere.peek() ?? {}).length === 2);

    // One op ends the membership AND the live subscriptions — board and
    // presence both; the owner keeps theirs, and sees the watcher leave.
    oBoard.at("/members").apply([{ op: "remove", path: `/${mm.user.id}` }]);
    await until(() => mBoard.peek() === null);
    await until(() => mHere.peek() === null);
    await until(() => Object.keys(oHere.peek() ?? {}).length === 1);
    expect(oBoard.peek()!.name).toBe("club");

    // The stream really ended: a later write reaches the owner, not the evicted.
    oBoard.at("/cards").apply([{ op: "add", path: "/-", value: { text: "after" } }]);
    await until(() => Object.keys(oBoard.peek()!.cards).length === 1);
    expect(mBoard.peek()).toBeNull();
  });
});

describe("history — the audit read back, and the stamp on the row", () => {
  let owner: number;
  let mate: number;
  let stranger: number;
  let doc: string;
  const apply = (ops: unknown, user: number | null) =>
    sql.unsafe(`SELECT board_apply($1, $2, $3) AS r`, [doc, ops, user]);

  beforeAll(async () => {
    const [o] = await sql`SELECT register('Hist', 'hist@log.test', 'pw') AS u`;
    const [m] = await sql`SELECT register('Mate', 'mate@log.test', 'pw') AS u`;
    const [s] = await sql`SELECT register('Snoop', 'snoop@log.test', 'pw') AS u`;
    owner = Number((o.u as { id: number }).id);
    mate = Number((m.u as { id: number }).id);
    stranger = Number((s.u as { id: number }).id);
    const [b] = await sql`INSERT INTO boards (name, owner_id) VALUES ('logged', ${owner}) RETURNING id`;
    doc = `board:${b.id}`;
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${doc}, 0, NULL, 'board_open')`;
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${"mine:" + mate}, 0, NULL, 'mine_open')
              ON CONFLICT (name) DO NOTHING`;
  });

  test("newest first, named at read time, paged by version cursor", async () => {
    for (const text of ["one", "two", "three"]) {
      await apply([{ op: "add", path: "/cards/-", value: { text } }], owner);
    }
    const [h] = await sql`SELECT doc_history(${doc}, ${owner}) AS h`;
    const all = h.h as { v: number; by: number; name: string; ops: { path: string }[] }[];
    expect(all).toHaveLength(3);
    expect(Number(all[0]!.v)).toBe(3);                    // newest first
    expect(Number(all[0]!.by)).toBe(owner);
    expect(all[0]!.name).toBe("Hist");                    // joined, not stamped
    expect(all[0]!.ops[0]!.path).toMatch(/^\/cards\/\d+$/); // the RESOLVED echo, not the client's `-`

    // Version cursors: `before` pages backwards, `after` tops up.
    const [older] = await sql`SELECT doc_history(${doc}, ${owner}, 3) AS h`;
    expect((older.h as { v: number }[]).map((e) => Number(e.v))).toEqual([2, 1]);
    const [newer] = await sql`SELECT doc_history(${doc}, ${owner}, NULL, 2) AS h`;
    expect((newer.h as { v: number }[]).map((e) => Number(e.v))).toEqual([3]);
  });

  test("a name is honest after the fact — a member who left is still named", async () => {
    await apply([{ op: "add", path: "/members/-", value: { email: "mate@log.test" } }], owner);
    await apply([{ op: "add", path: "/cards/-", value: { text: "mate was here" } }], mate);
    await apply([{ op: "remove", path: `/members/${mate}` }], owner);

    const [h] = await sql`SELECT doc_history(${doc}, ${owner}) AS h`;
    const mine = (h.h as { by: number; name: string }[]).find((e) => Number(e.by) === mate);
    expect(mine!.name).toBe("Mate");                      // the log kept the id; the join finds them
  });

  test("history is the doc's permit, not a second one — a stranger is refused", async () => {
    let err = "";
    try { await sql`SELECT doc_history(${doc}, ${stranger}) AS h`; }
    catch (e) { err = String(e); }
    expect(err).toContain("not found");                   // exactly how the doc refuses

    // ...and an unknown doc refuses identically — no existence oracle.
    err = "";
    try { await sql`SELECT doc_history(${"board:999999"}, ${owner}) AS h`; }
    catch (e) { err = String(e); }
    expect(err).toContain("not found");

    // The host, asking as itself, sees the whole log (001's NULL-user rule).
    const [host] = await sql`SELECT doc_history(${doc}, NULL) AS h`;
    expect((host.h as unknown[]).length).toBeGreaterThan(0);
  });

  test("the row remembers its last editor, and a restore puts the stamp back", async () => {
    // A second writer with a live permit (mate left in the test above).
    const [e] = await sql`SELECT register('Editor', 'editor@log.test', 'pw') AS u`;
    const editor = Number((e.u as { id: number }).id);
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${"mine:" + editor}, 0, NULL, 'mine_open')
              ON CONFLICT (name) DO NOTHING`;
    await apply([{ op: "add", path: "/members/-", value: { email: "editor@log.test" } }], owner);

    const add = await apply([{ op: "add", path: "/cards/-", value: { text: "stamped" } }], owner);
    const id = ((add[0]!.r as { ops: { path: string }[] }).ops[0]!.path).split("/").pop()!;
    const [made] = await sql`SELECT updated_by, updated_at FROM cards WHERE id = ${id}`;
    expect(Number(made.updated_by)).toBe(owner);
    expect(made.updated_at).not.toBeNull();

    // Someone else edits it: the badge moves, and the echo SAYS so — the op
    // changed two columns, so it carries the whole row.
    const edit = await apply([{ op: "replace", path: `/cards/${id}/text`, value: "edited" }], editor);
    const echo = (edit[0]!.r as { ops: { value: { updated_by: number } }[] }).ops[0]!;
    expect(Number(echo.value.updated_by)).toBe(editor);
    const [moved] = await sql`SELECT updated_by FROM cards WHERE id = ${id}`;
    expect(Number(moved.updated_by)).toBe(editor);

    // A restore is undo putting the row BACK, stamp included — not a new
    // edit by whoever pressed undo.
    const rm = await apply([{ op: "remove", path: `/cards/${id}` }], owner);
    const v = Number((rm[0]!.r as { v: number }).v);
    await sql.unsafe(`SELECT doc_undo($1, $2, $3, 'board_apply') AS r`, [doc, v, owner]);
    const [back] = await sql`SELECT text, updated_by FROM cards WHERE id = ${id}`;
    expect(back.text).toBe("edited");
    expect(Number(back.updated_by)).toBe(editor);         // the editor's edit, not the undoer
  });
});

describe("the operator's door — no list, no door", () => {
  test("unlisted callers are refused in words; the listed one gets rows", async () => {
    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    const opened = pgAdmin(host, sql, { admins: ["  Boss@Door.TEST ", ""] });
    expect(opened).toBe(true);                       // padded and cased entries still count
    const url = serve(host);

    const boss = client(url);
    await boss.call("register", { name: "Boss", email: "boss@door.test", password: "pw" });
    const nobody = client(url);
    await nobody.call("register", { name: "Nobody", email: "nobody@door.test", password: "pw" });

    // A signed-in stranger is told WHY, not handed a uniform "unknown method"
    // — the door is only reachable by an authenticated socket anyway.
    let err = "";
    try { await nobody.call("admin", { sql: "SELECT 1" }); } catch (e) { err = String(e); }
    expect(err).toContain("not permitted");

    // No session at all is its own answer.
    const anon = client(url);
    err = "";
    try { await anon.call("admin", { sql: "SELECT 1" }); } catch (e) { err = String(e); }
    expect(err).toContain("no session");

    // The listed operator reaches the database — the door's whole purpose on
    // a deployment whose Postgres has no port.
    const out = await boss.call<{ rows: { email: string }[] }>("admin", {
      sql: "SELECT email FROM users WHERE email = 'nobody@door.test'",
    });
    expect(out.rows[0]!.email).toBe("nobody@door.test");

    err = "";
    try { await boss.call("admin", {}); } catch (e) { err = String(e); }
    expect(err).toContain("sql required");
  });

  test("the frame is bounded, and the truncation says so", async () => {
    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    pgAdmin(host, sql, { admins: ["cap@door.test"], maxRows: 5 });
    const r = client(serve(host));
    await r.call("register", { name: "Cap", email: "cap@door.test", password: "pw" });

    const out = await r.call<{ rows: unknown[]; truncated?: boolean; total?: number }>("admin", {
      sql: "SELECT generate_series(1, 50) AS n",
    });
    expect(out.rows).toHaveLength(5);
    expect(out.truncated).toBe(true);
    expect(out.total).toBe(50);                      // the tail is still in the database
  });

  test("with nobody listed, the method is never registered at all", async () => {
    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    const saved = process.env.EPSILON_ADMIN;
    delete process.env.EPSILON_ADMIN;
    try {
      expect(pgAdmin(host, sql)).toBe(false);
      const r = client(serve(host));
      await r.call("register", { name: "Void", email: "void@door.test", password: "pw" });
      let err = "";
      try { await r.call("admin", { sql: "SELECT 1" }); } catch (e) { err = String(e); }
      expect(err).toContain("unknown method");       // a deployment that didn't opt in has no door
    } finally {
      if (saved) process.env.EPSILON_ADMIN = saved;
    }
  });
});
