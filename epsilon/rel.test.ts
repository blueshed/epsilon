// The relational tier: tables are the truth, stored functions apply and
// compose, sequences mint ids, doc_ops is the event log AND audit trail.
// Uses the app's own board.sql — the template is the test subject.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { createHost, connect, type Host, type Remote } from "./doc";
import { ensureSchema, applySql, pgDoc, pgSync, pgAuth } from "./pg";
import type { Card, Board } from "../types";

const ADMIN_URL = "postgres://epsilon:epsilon@localhost:5599/epsilon";
const PG_URL = process.env.EPSILON_TEST_PG_URL ?? "postgres://epsilon:epsilon@localhost:5599/epsilon_test";
const BOARD_SQL = new URL("../board.sql", import.meta.url);

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
  const s = new SQL(PG_URL);
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
    const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = 'epsilon_test'`;
    if (!exists) await admin.unsafe("CREATE DATABASE epsilon_test");
    await admin.end();
  }
  sql = freshSql();
  await ensureSchema(sql);
  await applySql(sql, BOARD_SQL);
  await sql.unsafe("TRUNCATE docs, doc_ops, sessions, boards, cards RESTART IDENTITY CASCADE");
  await sql.unsafe("TRUNCATE users RESTART IDENTITY CASCADE");
  await applySql(sql, BOARD_SQL);   // re-seed board 1 + its docs row
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
