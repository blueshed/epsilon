// Postgres authority: durability, restart, cross-process fan-out, users.
// Needs the compose Postgres: `bun run db:up` first (or `bun run ci`).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { createHost, connect, type Host, type Remote } from "./doc";
import { ensureSchema, pgDoc, pgSync, pgAuth } from "./pg";

const PG_URL = process.env.EPSILON_PG_URL ?? "postgres://epsilon:epsilon@localhost:5599/epsilon";

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

/** Poll until the docs row reaches version v — persistence is async by design. */
const untilDbV = (name: string, v: number) =>
  until(async () => {
    const [row] = await sql`SELECT v FROM docs WHERE name = ${name}`;
    return row != null && Number(row.v) >= v;
  });

beforeAll(async () => {
  sql = freshSql();
  await ensureSchema(sql);
  await ensureSchema(sql); // idempotent
  await sql.unsafe("TRUNCATE docs, doc_ops, sessions RESTART IDENTITY CASCADE");
  await sql.unsafe("TRUNCATE users RESTART IDENTITY CASCADE");
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
    const board = await pgDoc<Board>(host, sql, "board:1", structuredClone(empty));
    const url = serve(host);
    const remote = client(url).doc<Board>("board:1");
    await remote.ready;

    remote.apply([{ op: "add", path: "/cards/1", value: { id: 1, title: "persisted" } }]);
    await until(() => board.peek().cards["1"] !== undefined);
    await untilDbV("board:1", 1);

    const [doc] = await sql`SELECT v, data FROM docs WHERE name = ${"board:1"}`;
    expect(Number(doc.v)).toBe(1);
    expect(doc.data.cards["1"].title).toBe("persisted");
    const opsRows = await sql`SELECT v, ops FROM doc_ops WHERE name = ${"board:1"} ORDER BY v`;
    expect(opsRows.length).toBe(1);
    expect(opsRows[0].ops[0].path).toBe("/cards/1");
  });

  test("restart: a new host hydrates state AND version, then keeps writing", async () => {
    const host2 = createHost();
    const board2 = await pgDoc<Board>(host2, sql, "board:1", structuredClone(empty));
    expect(board2.peek().cards["1"]!.title).toBe("persisted");   // hydrated
    expect(host2.v("board:1")).toBe(1);                          // version carried

    board2.apply([{ op: "replace", path: "/cards/1/title", value: "after-restart" }]);
    await untilDbV("board:1", 2);
    const [doc] = await sql`SELECT v, data FROM docs WHERE name = ${"board:1"}`;
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
    const boardA = await pgDoc<Board>(a, sqlA, "board:x", structuredClone(empty));
    const boardB = await pgDoc<Board>(b, sqlB, "board:x", structuredClone(empty));
    stops.push(pgSync(a, sqlA, { ms: 50 }), pgSync(b, sqlB, { ms: 50 }));
    const urlB = serve(b);
    const browserB = client(urlB).doc<Board>("board:x");
    await browserB.ready;

    boardA.apply([{ op: "add", path: "/cards/9", value: { id: 9, title: "cross" } }]);

    await until(() => boardB.peek().cards["9"] !== undefined);          // B's authority
    await until(() => browserB.peek()!.cards["9"] !== undefined);       // B's browser
    expect(b.v("board:x")).toBe(a.v("board:x"));
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
