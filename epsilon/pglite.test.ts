// The EMBEDDED engine: the app's own migrations, stored functions, auth
// contract, and wire — on in-process Postgres (PGlite), no server anywhere.
// Same schema, two engines; this suite is the proof the seam holds.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, connect, type Host, type Remote } from "./doc";
import { migrate, pgDoc, type Sql } from "./pg";
import { openPglite } from "./pglite";
import type { Card, Board } from "../types";

const DB_DIR = new URL("../db", import.meta.url).pathname;

let dir: string;
let sql: Sql;
const servers: ReturnType<typeof Bun.serve>[] = [];
const remotes: Remote[] = [];

function serve(host: Host) {
  const server = Bun.serve({ port: 0, fetch: host.fetch, websocket: host.websocket });
  host.setServer(server);
  servers.push(server);
  return `ws://localhost:${server.port}${host.path}`;
}

const until = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "epsilon-pglite-"));
  sql = await openPglite(dir);
  await migrate(sql, { dir: DB_DIR });
});

afterAll(async () => {
  for (const r of remotes) r.close();
  for (const s of servers) s.stop(true);
  await sql.end?.();
  rmSync(dir, { recursive: true, force: true });
});

describe("embedded Postgres — same schema, no server", () => {
  test("every migration applies; the demo board composes", async () => {
    const [m] = await sql`SELECT count(*)::int AS n FROM migrations`;
    expect(Number(m.n)).toBeGreaterThanOrEqual(9);
    const [b] = await sql`SELECT doc_open(${"board:1"}) AS d`;
    expect(b.d.name).toBe("main");
    expect(b.d.cards).toEqual({});
  });

  test("the relational tier over the real wire: stored-function writes, sequence ids, audit", async () => {
    const host = createHost();
    await pgDoc<Board>(host, sql, "board:1", null as unknown as Board, { apply: "board_apply" });
    const url = serve(host);
    const r = connect(url);
    remotes.push(r);

    const board = r.doc<Board>("board:1");
    await board.ready;
    expect(board.peek()!.name).toBe("main");

    board.at<Record<string, Card>>("/cards").apply([{ op: "add", path: "/-", value: { text: "in-process" } }]);
    await until(() => Object.keys(board.peek()!.cards).length === 1);
    const id = Object.keys(board.peek()!.cards)[0]!;
    expect(id).toBe("1");                                   // a real sequence minted it

    const [row] = await sql`SELECT text, done FROM cards WHERE id = ${id}`;
    expect(row.text).toBe("in-process");                    // the table is the truth
    const [audit] = await sql`SELECT ops FROM doc_ops WHERE name = ${"board:1"} AND v = 1`;
    expect(audit.ops[0].path).toBe("/cards/1");             // resolved echo in the log

    board.at<boolean>(`/cards/${id}/done`).set(true);       // the other verbs dispatch too
    await until(() => board.peek()!.cards[id]!.done === true);
    const [flipped] = await sql`SELECT done FROM cards WHERE id = ${id}`;
    expect(flipped.done).toBe(true);
  });

  test("auth: the pgcrypto contract hashes and verifies in WASM", async () => {
    const [reg] = await sql`SELECT register('Pete', 'pete@pglite.test', 'pw') AS u`;
    expect(reg.u.email).toBe("pete@pglite.test");
    const [bad] = await sql`SELECT login('pete@pglite.test', 'wrong') AS u`;
    expect(bad.u).toBeNull();
    const [ok] = await sql`SELECT login('pete@pglite.test', 'pw') AS u`;
    expect(Number(ok.u.id)).toBe(Number(reg.u.id));
    const [tok] = await sql`SELECT session_start(${Number(reg.u.id)}) AS t`;
    const [who] = await sql`SELECT session_get(${tok.t}) AS u`;
    expect(who.u.email).toBe("pete@pglite.test");
  });

  test("sharing mirrors across docs in one transaction — the 009 machinery, in process", async () => {
    // Users straight into the table (bcrypt already proven above).
    const [o] = await sql`INSERT INTO users (email, name, password_hash) VALUES ('own@pg.lite', 'Own', 'x') RETURNING id`;
    const [f] = await sql`INSERT INTO users (email, name, password_hash) VALUES ('fri@pg.lite', 'Fri', 'x') RETURNING id`;
    const owner = Number(o.id);
    const friend = Number(f.id);
    const [b] = await sql`INSERT INTO boards (name, owner_id) VALUES ('ours', ${owner}) RETURNING id`;
    const bid = Number(b.id);
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${"board:" + bid}, 0, NULL, 'board_open')`;
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${"mine:" + friend}, 0, NULL, 'mine_open')`;

    const rows = await sql.unsafe(`SELECT board_apply($1, $2, $3) AS r`, [
      "board:" + bid,
      [{ op: "add", path: "/members/-", value: { email: "fri@pg.lite" } }] as unknown,
      owner,
    ]);
    const echo = rows[0]!.r as { ops: { path: string }[] };
    expect(echo.ops[0]!.path).toBe(`/members/${friend}`);

    const members = await sql`SELECT user_id FROM board_members WHERE board_id = ${bid}`;
    expect(Number(members[0].user_id)).toBe(friend);
    // The friend's own list heard it in the SAME transaction.
    const [mirror] = await sql`SELECT ops FROM doc_ops WHERE name = ${"mine:" + friend} AND v = 1`;
    expect(mirror.ops[0].path).toBe(`/boards/${bid}`);
    expect(mirror.ops[0].value.shared).toBe(true);
    // And composes for them at open.
    const [mine] = await sql`SELECT doc_open(${"mine:" + friend}, ${friend}) AS d`;
    expect(mine.d.boards[String(bid)].name).toBe("ours");
  });

  test("durability: close the process's database, reopen the directory, hydrate", async () => {
    const [before] = await sql`SELECT v FROM docs WHERE name = ${"board:1"}`;
    await sql.end?.();

    sql = await openPglite(dir);                            // "restart"
    const host = createHost();
    const board = await pgDoc<Board>(host, sql, "board:1", null as unknown as Board, { apply: "board_apply" });
    expect(host.v("board:1")).toBe(Number(before.v));       // version survived the disk
    const cards = Object.values(board.peek()!.cards);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toBe("in-process");
    expect(cards[0]!.done).toBe(true);
  });
});
