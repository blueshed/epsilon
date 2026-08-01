// Views — nouns are docs. A view is a READ-ONLY doc composed by one SQL
// function over other docs' tables, recomposed when a DECLARED dependency
// commits, delivered by pgSync in both of its modes. The dependencies are
// deliberately NOT hosted on the view's host anywhere in this file: a view
// must hear about tables changing, not about docs it happens to share a
// process with.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { SQL } from "bun";
import { createHost, connect, type Host, type Remote } from "./doc";
import { migrate, pgAuth, pgSync, pgView } from "./pg";

const APP = ((await Bun.file(new URL("../package.json", import.meta.url)).json()).name as string)
  .toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^(?![a-z_])/, "app_");
const DB = `${APP}_test_view`;
const ADMIN_URL = "postgres://epsilon:epsilon@localhost:5599/epsilon";
const PG_URL = process.env.EPSILON_TEST_PG_URL ?? `postgres://epsilon:epsilon@localhost:5599/${DB}`;
const DB_DIR = new URL("../db", import.meta.url).pathname;

// tally:<uid> — the worked example: counts over the user's boards. Per-
// identity exactly the way mine:<uid> is (the decree: different views for
// different people are different NAMES); the function is composition AND
// permit — NULL user is the host, NULL result refuses.
const TALLY_SQL = `
CREATE OR REPLACE FUNCTION tally_open(p_doc text, p_user bigint DEFAULT NULL) RETURNS jsonb AS $$
  SELECT CASE WHEN p_user IS NOT NULL AND p_user <> doc_id(p_doc) THEN NULL ELSE
    jsonb_build_object(
      'boards', (SELECT COUNT(*) FROM boards b WHERE b.owner_id = doc_id(p_doc)),
      'cards',  (SELECT COUNT(*) FROM cards c JOIN boards b ON b.id = c.board_id
                  WHERE b.owner_id = doc_id(p_doc)),
      'done',   (SELECT COUNT(*) FROM cards c JOIN boards b ON b.id = c.board_id
                  WHERE b.owner_id = doc_id(p_doc) AND c.done))
  END;
$$ LANGUAGE sql STABLE;
`;

interface Tally { boards: number; cards: number; done: number }

let sql: SQL;
const servers: ReturnType<typeof Bun.serve>[] = [];
const remotes: Remote[] = [];
const stops: (() => void)[] = [];

function serve(host: Host) {
  const server = Bun.serve({ port: 0, fetch: host.fetch, websocket: host.websocket });
  host.setServer(server);
  servers.push(server);
  return `ws://localhost:${server.port}${host.path}`;
}

function client(url: string, onError?: (doc: string, error: string) => void) {
  const r = connect(url, { onError });
  remotes.push(r);
  return r;
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A user with a seeded mine doc, made over SQL — the wire under test is
 *  the VIEW's, not auth's. */
async function mint(email: string): Promise<number> {
  const [u] = await sql`SELECT register(${email.split("@")[0]!}, ${email}, 'pw') AS u`;
  const uid = Number((u.u as { id: number }).id);
  await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${"mine:" + uid}, 0, NULL, 'mine_open')
            ON CONFLICT (name) DO NOTHING`;
  return uid;
}

/** Creation is an op — the mine dispatch mints the board AND rings a
 *  doorbell (a bare INSERT would ring nothing, which is the point of
 *  driving dependencies through their own stored functions). */
async function makeBoard(uid: number, name: string): Promise<number> {
  const rows = await sql.unsafe(`SELECT mine_apply($1, $2, $3) AS r`,
    ["mine:" + uid, [{ op: "add", path: "/boards/-", value: { name } }] as unknown, uid]);
  return Number((rows[0]!.r as { ops: { value: { id: number } }[] }).ops[0]!.value.id);
}

const addCard = (bid: number, uid: number, text: string) =>
  sql.unsafe(`SELECT board_apply($1, $2, $3) AS r`,
    ["board:" + bid, [{ op: "add", path: "/cards/-", value: { text } }] as unknown, uid]);

beforeAll(async () => {
  if (!process.env.EPSILON_TEST_PG_URL) {
    const admin = new SQL(ADMIN_URL);
    const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${DB}`;
    if (!exists) await admin.unsafe(`CREATE DATABASE ${DB}`);
    await admin.end();
  }
  sql = new SQL(PG_URL, { max: 3 });
  await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await migrate(sql, { dir: DB_DIR });
  await sql.unsafe(TALLY_SQL);
});

afterAll(async () => {
  for (const stop of stops) stop();
  for (const r of remotes) r.close();
  for (const s of servers) s.stop(true);
  await sql.end?.();
});

describe("views — nouns are docs (LISTEN delivery)", () => {
  test("opens with a snapshot, follows its dependencies live, refuses writes", async () => {
    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    pgView(host, sql, "tally:", { open: "tally_open", on: ["board:", "mine:"] });
    stops.push((await pgSync(host, sql, { url: PG_URL })).stop);

    const errors: string[] = [];
    const r = client(serve(host), (_d, e) => errors.push(e));
    const uid = await mint("watcher@view.test");
    await r.call("login", { email: "watcher@view.test", password: "pw" });

    const tally = r.doc<Tally>(`tally:${uid}`);
    await tally.ready;
    expect(Number(tally.peek()!.boards)).toBe(0);

    // A dependency committed by plain SQL — no doc hosted anywhere, only the
    // doorbell. The view follows.
    const bid = await makeBoard(uid, "counted");
    await until(() => Number(tally.peek()?.boards) === 1);

    await addCard(bid, uid, "one");
    await until(() => Number(tally.peek()?.cards) === 1);

    const [card] = await sql`SELECT id FROM cards WHERE board_id = ${bid}`;
    await sql.unsafe(`SELECT board_apply($1, $2, $3) AS r`,
      ["board:" + bid, [{ op: "replace", path: `/cards/${card.id}/done`, value: true }] as unknown, uid]);
    await until(() => Number(tally.peek()?.done) === 1);

    // Read-only: a write through the view refuses on the wire.
    tally.apply([{ op: "replace", path: "/boards", value: 99 }]);
    await until(() => errors.some((e) => e.includes("read-only view")));
    expect(Number(tally.peek()!.boards)).toBe(1);   // and nothing moved
  });

  test("the composition function is the permit — a stranger reads unknown doc while the view is LIVE", async () => {
    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    pgView(host, sql, "tally:", { open: "tally_open", on: ["board:"] });
    const url = serve(host);

    const owner = client(url);
    const uid = await mint("kept@view.test");
    await owner.call("login", { email: "kept@view.test", password: "pw" });
    const mine = owner.doc<Tally>(`tally:${uid}`);
    await mine.ready;                                // hosted and occupied…

    const errors: string[] = [];
    const snoop = client(url, (_d, e) => errors.push(e));
    await snoop.call("register", { name: "Snoop", email: "snoop@view.test", password: "pw" });
    snoop.doc(`tally:${uid}`);                       // …the stranger still reads absence
    await until(() => errors.length > 0);
    expect(errors[0]).toContain("unknown doc");
  });

  test("a doorbell that changes nothing pushes nothing — the equality skip", async () => {
    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    pgView(host, sql, "tally:", { open: "tally_open", on: ["board:", "mine:"] });
    stops.push((await pgSync(host, sql, { url: PG_URL })).stop);

    const r = client(serve(host));
    const uid = await mint("quiet@view.test");
    await r.call("login", { email: "quiet@view.test", password: "pw" });
    const bid = await makeBoard(uid, "before");

    const tally = r.doc<Tally>(`tally:${uid}`);
    await tally.ready;
    let pushes = 0;
    tally.onOps((ops) => { if (ops) pushes++; });

    // A rename rings the board's doorbell but no tally number moves.
    await sql.unsafe(`SELECT board_apply($1, $2, $3) AS r`,
      ["board:" + bid, [{ op: "replace", path: "/name", value: "after" }] as unknown, uid]);
    await new Promise((res) => setTimeout(res, 300));   // the doorbell has long arrived
    expect(pushes).toBe(0);

    await addCard(bid, uid, "moves the count");
    await until(() => pushes === 1);
    expect(Number(tally.peek()!.cards)).toBe(1);
  });
});

describe("views — poll delivery (the embedded tier's mode)", () => {
  test("dependency bumps, and deaths, arrive by sweep — no doorbell anywhere", async () => {
    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    pgView(host, sql, "tally:", { open: "tally_open", on: ["board:", "mine:"] });
    stops.push((await pgSync(host, sql, { mode: "poll", ms: 50 })).stop);

    const r = client(serve(host));
    const uid = await mint("poller@view.test");
    await r.call("login", { email: "poller@view.test", password: "pw" });

    const tally = r.doc<Tally>(`tally:${uid}`);
    await tally.ready;
    expect(Number(tally.peek()!.boards)).toBe(0);

    const bid = await makeBoard(uid, "polled");
    await until(() => Number(tally.peek()?.boards) === 1);
    await addCard(bid, uid, "swept in");
    await until(() => Number(tally.peek()?.cards) === 1);

    // Death is a dependency change too: the owner deletes the board —
    // doc_drop's row vanishes from the sweep and the view follows down.
    await sql.unsafe(`SELECT mine_apply($1, $2, $3) AS r`,
      ["mine:" + uid, [{ op: "remove", path: `/boards/${bid}` }] as unknown, uid]);
    await until(() => Number(tally.peek()?.boards) === 0);
    expect(Number(tally.peek()!.cards)).toBe(0);
  });

  test("evicted with its last watcher; a fresh open recomposes current state", async () => {
    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    pgView(host, sql, "tally:", { open: "tally_open", on: ["board:", "mine:"] });
    stops.push((await pgSync(host, sql, { mode: "poll", ms: 50 })).stop);

    const r = client(serve(host));
    const uid = await mint("leaver@view.test");
    await r.call("login", { email: "leaver@view.test", password: "pw" });

    const name = `tally:${uid}`;
    const tally = r.doc<Tally>(name);
    await tally.ready;
    expect(host.names()).toContain(name);

    tally.close();                                   // the LAST handle
    await until(() => !host.names().includes(name));

    // The world moves while nobody watches — nothing recomposes, nothing
    // leaks; the next open pays the composition and reads current truth.
    await makeBoard(uid, "while away");
    const again = r.doc<Tally>(name);
    await again.ready;
    expect(Number(again.peek()!.boards)).toBe(1);
  });
});
