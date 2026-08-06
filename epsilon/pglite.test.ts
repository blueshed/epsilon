// The EMBEDDED engine: the app's own migrations, stored functions, auth
// contract, and wire — on in-process Postgres (PGlite), no server anywhere.
// Same schema, two engines; this suite is the proof the seam holds.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, connect, type Host, type Remote } from "./doc";
import { migrate, pgDoc, pgAuth, pgSync, pgUndo, pgView, type Sql } from "./pg";
import { hasBoardFixture, NO_FIXTURE } from "./testdb";
import { openPglite } from "./pglite";
import { proveLaw } from "./law";
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
  if (!(await hasBoardFixture(sql))) throw new Error(NO_FIXTURE);
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
    expect(Number(m.n)).toBeGreaterThanOrEqual(5);
    const [b] = await sql`SELECT doc_open(${"board:1"}, NULL) AS d`;
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

  test("sharing mirrors across docs in one transaction — the sharing machinery, in process", async () => {
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

  test("a mirror reaches a HOSTED doc — sync is not only for sibling processes", async () => {
    // The test above proves the mirror lands in the TABLES. This one proves
    // it reaches a doc already on someone's screen. The write goes to
    // board:<id>, so board:<id>'s own write hook re-enters its echo; nothing
    // in that path touches mine:<friend>. Only sync does — and the embedded
    // tier used to run none, so a share appeared in the database and never on
    // the member's list, refresh included (a doc another socket still watches
    // is served the hosted snapshot, not a fresh composition).
    const [o] = await sql`SELECT register('Own2', 'own2@pg.lite', 'pw') AS u`;
    const [f] = await sql`SELECT register('Fri2', 'fri2@pg.lite', 'pw') AS u`;
    const owner = Number(o.u.id);
    const friend = Number(f.u.id);
    const [b] = await sql`INSERT INTO boards (name, owner_id) VALUES ('mirrored', ${owner}) RETURNING id`;
    const bid = Number(b.id);
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${"board:" + bid}, 0, NULL, 'board_open')`;
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${"mine:" + friend}, 0, NULL, 'mine_open')`;

    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    await pgDoc<Board>(host, sql, "board:" + bid, null as unknown as Board, { apply: "board_apply" });
    type Mine = { boards: Record<string, { name: string }> };
    const mine = await pgDoc<Mine>(host, sql, "mine:" + friend, null as unknown as Mine, { apply: "mine_apply" });
    const sync = await pgSync(host, sql, { mode: "poll", ms: 50 });
    expect(sync.mode).toBe("poll");                     // no doorbell to hear in process
    try {
      const url = serve(host);
      const r = connect(url, {
        onConnect: async (remote) => { await remote.call("login", { email: "own2@pg.lite", password: "pw" }); },
      });
      remotes.push(r);
      const board = r.doc<Board>("board:" + bid);
      await board.ready;
      expect(mine.peek()!.boards[String(bid)]).toBeUndefined();

      // A real wire write, through board_apply. Its mirror into mine:<friend>
      // is committed in the same transaction — and reaches the hosted signal
      // only because sync is running.
      board.apply([{ op: "add", path: "/members/-", value: { email: "fri2@pg.lite" } }]);

      await until(() => !!mine.peek()!.boards[String(bid)]);
      expect(mine.peek()!.boards[String(bid)]!.name).toBe("mirrored");
    } finally {
      sync.stop();
    }
  });

  test("the embedded server STARTS sync — the wiring, not just the mechanism", async () => {
    // The bug was here, not in pgSync: server.ts started fan-out only when a
    // pgUrl was set, on the reasoning that embedded Postgres has no sibling
    // processes. True, and beside the point — mirrors need delivery too.
    const { startServer } = await import("../server");
    const saved = process.env.EPSILON_PG_URL;
    delete process.env.EPSILON_PG_URL;                  // this test is about the embedded path
    const bootDir = mkdtempSync(join(tmpdir(), "epsilon-pglite-boot-"));
    let app: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      app = await startServer({ port: 0, pgDir: bootDir, dbDir: DB_DIR });
      expect(app.sync?.mode).toBe("poll");              // polls its own in-process database
    } finally {
      app?.sync?.stop();
      app?.server.stop(true);
      await app?.sql?.end?.();
      rmSync(bootDir, { recursive: true, force: true });
      if (saved) process.env.EPSILON_PG_URL = saved;
    }
  });

  test("a view follows its dependencies on the embedded engine — the sweep is the doorbell", async () => {
    // PGlite has nothing to LISTEN on, so a view's recompose rides the same
    // poll pgSync already runs here (0.6.0) — dependency version bumps in the
    // docs table are the signal.
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION tally_open(p_doc text, p_user bigint DEFAULT NULL) RETURNS jsonb AS $$
        SELECT CASE WHEN p_user IS NOT NULL AND p_user <> doc_id(p_doc) THEN NULL ELSE
          jsonb_build_object(
            'boards', (SELECT COUNT(*) FROM boards b WHERE b.owner_id = doc_id(p_doc)))
        END;
      $$ LANGUAGE sql STABLE;`);
    const [u] = await sql`SELECT register('Viewer', 'viewer@pg.lite', 'pw') AS u`;
    const uid = Number(u.u.id);
    await sql`INSERT INTO docs (name, v, data, open_fn) VALUES (${"mine:" + uid}, 0, NULL, 'mine_open')`;

    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    pgView(host, sql, "tally:", { open: "tally_open", on: ["board:", "mine:"] });
    const sync = await pgSync(host, sql, { mode: "poll", ms: 50 });
    try {
      const url = serve(host);
      const r = connect(url, {
        onConnect: async (remote) => { await remote.call("login", { email: "viewer@pg.lite", password: "pw" }); },
      });
      remotes.push(r);
      const tally = r.doc<{ boards: number }>(`tally:${uid}`);
      await tally.ready;
      expect(Number(tally.peek()!.boards)).toBe(0);

      // Creation is an op on the mine doc — it rings the version bump the
      // sweep watches; the view follows without hosting any dependency.
      await sql.unsafe(`SELECT mine_apply($1, $2, $3) AS r`,
        ["mine:" + uid, [{ op: "add", path: "/boards/-", value: { name: "embedded" } }] as unknown, uid]);
      await until(() => Number(tally.peek()?.boards) === 1);
    } finally {
      sync.stop();
    }
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

  test("undo, embedded: the inverse is recorded and doc_undo restores the exact row", async () => {
    const [card] = await sql`SELECT id FROM cards`;
    const rm = await sql.unsafe(`SELECT board_apply($1, $2, $3) AS r`,
      ["board:1", [{ op: "remove", path: `/cards/${card.id}` }] as unknown, null]);
    expect((await sql`SELECT 1 FROM cards`).length).toBe(0);

    await sql.unsafe(`SELECT doc_undo($1, $2, $3, 'board_apply') AS r`,
      ["board:1", Number((rm[0]!.r as { v: number }).v), null]);
    const [back] = await sql`SELECT id, text, done FROM cards`;
    expect(Number(back.id)).toBe(Number(card.id));          // restored, not re-minted
    expect(back.text).toBe("in-process");
    expect(back.done).toBe(true);
  });
});

describe("grain hardening — the kit refuses the cheap-but-wrong shapes", () => {
  test("doc_open omitting the user is an ERROR, not the full copy (007)", async () => {
    // Before 007 the permit-free read was the ZERO-ARGUMENT call: a custom
    // method that forgot to pass the socket's user compiled, ran, and
    // silently served the host's full view. Omission now fails at the call.
    let refused = "";
    try { await sql.unsafe(`SELECT doc_open('board:1') AS d`); }
    catch (err) { refused = String(err); }
    expect(refused).toMatch(/doc_open/);
    expect(refused).toMatch(/does not exist/);
    // Composing as the host is said OUT LOUD — and unchanged in meaning.
    const [full] = await sql`SELECT doc_open(${"board:1"}, NULL) AS d`;
    expect(full.d.name).toBe("main");
  });

  test("doc_commit refuses a root-path op — recompose erases who/what from the log", async () => {
    // A dispatch that echoes "replace / {recomposition}" satisfies the law
    // and destroys everything else the log is for: history reads 'someone
    // replaced everything', and a root path conflicts every later undo.
    const [before] = await sql`SELECT v FROM docs WHERE name = ${"board:1"}`;
    let refused = "";
    try {
      await sql.unsafe(`SELECT doc_commit('board:1', $1) AS r`,
        [[{ op: "replace", path: "", value: { name: "recomposed" } }] as unknown]);
    } catch (err) { refused = String(err); }
    expect(refused).toMatch(/root op in doc_commit/);
    expect(refused).toMatch(/never recompose/);
    const [after] = await sql`SELECT v FROM docs WHERE name = ${"board:1"}`;
    expect(Number(after.v)).toBe(Number(before.v));       // nothing committed
  });

  test("007 without db/fn/doc-kit.sql is caught AT BOOT, not at the first doc open", async () => {
    // `db/` is outside the upgrade whitelist, so apps copy these by hand —
    // and 007 (which DROPs doc_open) commits in its own transaction before
    // the vocabulary pass. Copying only the numbered half used to boot GREEN
    // and fail later, far from the cause.
    const d = mkdtempSync(join(tmpdir(), "epsilon-pair-"));
    mkdirSync(join(d, "fn"), { recursive: true });
    for (const f of ["001-epsilon.sql", "002-auth.sql", "003-doc-kit.sql",
                     "004-housekeeping.sql", "005-gone.sql", "006-session-digest.sql",
                     "007-doc-open-explicit.sql"]) {
      writeFileSync(join(d, f), readFileSync(join(DB_DIR, f), "utf8"));
    }
    writeFileSync(join(d, "fn", "session.sql"), readFileSync(join(DB_DIR, "fn", "session.sql"), "utf8"));
    // ...deliberately NOT db/fn/doc-kit.sql.
    const dbDir = mkdtempSync(join(tmpdir(), "epsilon-pairdb-"));
    const s2 = await openPglite(dbDir);
    try {
      let err = "";
      try { await migrate(s2 as Sql, { dir: d, log: () => {} }); } catch (e) { err = String(e); }
      expect(err).toContain("nothing recreated it");
      expect(err).toContain("db/fn/doc-kit.sql");
      expect(err).toContain("ONE change");
    } finally {
      await (s2 as any).end?.();
      rmSync(d, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  test("the kit's own vocabulary survives an app that deleted the demo", async () => {
    // The 0.10.2 hazard, pinned: db/fn is replayed and re-validated every
    // boot, so a vocabulary file referencing demo tables broke the boot of
    // any app that followed its own README and deleted them. Core db/fn
    // touches core tables ONLY — this is that promise, executable.
    const d = mkdtempSync(join(tmpdir(), "epsilon-nodemo-"));
    mkdirSync(join(d, "fn"), { recursive: true });
    for (const f of ["001-epsilon.sql", "002-auth.sql", "003-doc-kit.sql",
                     "004-housekeeping.sql", "005-gone.sql", "006-session-digest.sql",
                     "007-doc-open-explicit.sql"]) {
      writeFileSync(join(d, f), readFileSync(join(DB_DIR, f), "utf8"));
    }
    for (const f of ["doc-kit.sql", "session.sql"]) {
      writeFileSync(join(d, "fn", f), readFileSync(join(DB_DIR, "fn", f), "utf8"));
    }
    const dbDir = mkdtempSync(join(tmpdir(), "epsilon-nodemodb-"));
    const s2 = await openPglite(dbDir);
    try {
      await migrate(s2 as Sql, { dir: d, log: () => {} });          // boots
      const [ok] = await s2`SELECT to_regprocedure('doc_open(text,bigint)') IS NOT NULL AS ok`;
      expect(ok.ok).toBe(true);
      const [none] = await s2`SELECT to_regclass('cards') AS t`;
      expect(none.t).toBeNull();                                    // no demo anywhere
    } finally {
      await (s2 as any).end?.();
      rmSync(d, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});

// The gap the review's build fell into: db/100 and the todo recipe each show
// cascade OR undo, never both — and the combination has a trap the harness
// alone can't teach: doc_cascade_remove expands the ECHO but not the
// INVERSE (it deletes and returns remove ops; the before-rows are already
// gone). A type that records undo must read the children FIRST. This is the
// worked example REFERENCE.md points at.
const RECIPE_SQL = `
CREATE TABLE IF NOT EXISTS recipes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL
);
CREATE TABLE IF NOT EXISTS recipe_steps (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipe_id bigint NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  text text NOT NULL
);

CREATE OR REPLACE FUNCTION recipe_open(p_doc text, p_user bigint DEFAULT NULL) RETURNS jsonb AS $$
  SELECT CASE WHEN p_user IS NOT NULL AND p_user <> doc_id(p_doc) THEN NULL ELSE
    jsonb_build_object(
      'recipes', COALESCE(
        (SELECT jsonb_object_agg(x.id::text, jsonb_build_object('id', x.id, 'name', x.name))
           FROM recipes x WHERE x.owner_id = doc_id(p_doc)), '{}'::jsonb),
      'steps', COALESCE(
        (SELECT jsonb_object_agg(s.id::text,
           jsonb_build_object('id', s.id, 'recipe_id', s.recipe_id, 'text', s.text))
           FROM recipe_steps s JOIN recipes x ON x.id = s.recipe_id
           WHERE x.owner_id = doc_id(p_doc)), '{}'::jsonb))
  END;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION recipe_apply(p_doc text, p_ops jsonb, p_user bigint DEFAULT NULL) RETURNS jsonb AS $$
DECLARE
  v_uid bigint := doc_id(p_doc);
  v_op jsonb; v_p text[]; v_id bigint; v_row jsonb; v_before jsonb; v_kids jsonb;
  v_out jsonb := '[]'::jsonb; v_undo jsonb := '[]'::jsonb;
BEGIN
  PERFORM doc_begin(p_doc, p_user = v_uid);
  FOR v_op IN SELECT jsonb_array_elements(p_ops) LOOP
    v_p := doc_path(v_op);

    IF v_p = ARRAY['recipes', '-'] AND v_op->>'op' = 'add' THEN
      INSERT INTO recipes (owner_id, name) VALUES (v_uid, v_op->'value'->>'name') RETURNING id INTO v_id;
      v_out := v_out || op_add('/recipes/' || v_id,
        jsonb_build_object('id', v_id, 'name', v_op->'value'->>'name'));
      v_undo := op_remove('/recipes/' || v_id) || v_undo;

    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'recipes' AND v_op->>'op' = 'add'
          AND v_p[2] ~ '^\\d+$' THEN
      -- RESTORE (the undo of a recipe remove — the parent must come back
      -- BEFORE its steps, which is the order the remove branch records).
      INSERT INTO recipes (id, owner_id, name) OVERRIDING SYSTEM VALUE
        VALUES (v_p[2]::bigint, v_uid, v_op->'value'->>'name')
        RETURNING jsonb_build_object('id', id, 'name', name) INTO v_row;
      PERFORM doc_restore_id('recipes');
      v_out := v_out || op_add('/recipes/' || v_p[2], v_row);
      v_undo := op_remove('/recipes/' || v_p[2]) || v_undo;

    ELSIF v_p = ARRAY['steps', '-'] AND v_op->>'op' = 'add' THEN
      INSERT INTO recipe_steps (recipe_id, text)
        SELECT (v_op->'value'->>'recipe_id')::bigint, v_op->'value'->>'text'
        FROM recipes WHERE id = (v_op->'value'->>'recipe_id')::bigint AND owner_id = v_uid
        RETURNING id INTO v_id;
      IF v_id IS NULL THEN RAISE EXCEPTION 'row not found: %', v_op->>'path'; END IF;
      v_out := v_out || op_add('/steps/' || v_id,
        jsonb_build_object('id', v_id, 'recipe_id', (v_op->'value'->>'recipe_id')::bigint,
                           'text', v_op->'value'->>'text'));
      v_undo := op_remove('/steps/' || v_id) || v_undo;

    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'steps' AND v_op->>'op' = 'add'
          AND v_p[2] ~ '^\\d+$' THEN
      -- RESTORE a step (the tail of a cascade's undo).
      INSERT INTO recipe_steps (id, recipe_id, text) OVERRIDING SYSTEM VALUE
        SELECT v_p[2]::bigint, x.id, v_op->'value'->>'text'
        FROM recipes x WHERE x.id = (v_op->'value'->>'recipe_id')::bigint AND x.owner_id = v_uid
        RETURNING jsonb_build_object('id', id, 'recipe_id', recipe_id, 'text', text) INTO v_row;
      IF v_row IS NULL THEN RAISE EXCEPTION 'row not found: %', v_op->>'path'; END IF;
      PERFORM doc_restore_id('recipe_steps');
      v_out := v_out || op_add('/steps/' || v_p[2], v_row);
      v_undo := op_remove('/steps/' || v_p[2]) || v_undo;

    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'steps' AND v_op->>'op' = 'remove' THEN
      -- Also the undo of "add step": every inverse a dispatch RECORDS must
      -- be an op it can DISPATCH — proveLaw's undo drive catches the gap.
      SELECT jsonb_build_object('id', s.id, 'recipe_id', s.recipe_id, 'text', s.text) INTO v_before
        FROM recipe_steps s JOIN recipes x ON x.id = s.recipe_id
        WHERE s.id = v_p[2]::bigint AND x.owner_id = v_uid;
      DELETE FROM recipe_steps s USING recipes x
        WHERE s.id = v_p[2]::bigint AND x.id = s.recipe_id AND x.owner_id = v_uid;
      IF FOUND THEN
        v_out := v_out || op_remove(v_op->>'path');
        v_undo := op_add('/steps/' || v_p[2], v_before) || v_undo;
      END IF;

    ELSIF array_length(v_p, 1) = 2 AND v_p[1] = 'recipes' AND v_op->>'op' = 'remove' THEN
      SELECT jsonb_build_object('id', x.id, 'name', x.name) INTO v_before
        FROM recipes x WHERE x.id = v_p[2]::bigint AND x.owner_id = v_uid;
      IF v_before IS NOT NULL THEN
        -- THE TRAP, disarmed in order:
        --   1. read the children (doc_cascade_remove cannot — they die in it)
        --   2. expand the cascade into the ECHO
        --   3. delete the parent; echo its remove
        --   4. record the inverse: parent add FIRST (FK), then its steps
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'op', 'add', 'path', '/steps/' || s.id,
                 'value', jsonb_build_object('id', s.id, 'recipe_id', s.recipe_id, 'text', s.text))),
               '[]'::jsonb)
          INTO v_kids FROM recipe_steps s WHERE s.recipe_id = v_p[2]::bigint;
        v_out := v_out || doc_cascade_remove('recipe_steps', 'recipe_id', v_p[2]::bigint, '/steps/');
        DELETE FROM recipes WHERE id = v_p[2]::bigint AND owner_id = v_uid;
        v_out := v_out || op_remove(v_op->>'path');
        v_undo := (op_add('/recipes/' || v_p[2], v_before) || v_kids) || v_undo;
      END IF;

    ELSE
      RAISE EXCEPTION 'unsupported op: % %', v_op->>'op', v_op->>'path';
    END IF;
  END LOOP;
  RETURN doc_commit(p_doc, v_out, p_user, v_undo);
END;
$$ LANGUAGE plpgsql;
`;

describe("cascade + undo — the worked combination (REFERENCE.md points here)", () => {
  test("a parent remove expresses its cascade AND records an inverse that restores it whole", async () => {
    await sql.unsafe(RECIPE_SQL);
    const host = createHost({ requireAuth: true });
    await pgAuth(host, sql);
    host.docs("recipe:", async (name, userId) => {
      const uid = Number(name.split(":")[1]);
      if (!Number.isFinite(uid) || Number(userId) !== uid) throw new Error(`unknown doc: ${name}`);
      await pgDoc(host, sql, name, null, { apply: "recipe_apply", seed: { open_fn: "recipe_open" } });
    });
    pgUndo(host, sql, (d) => (d.startsWith("recipe:") ? "recipe_apply" : undefined));
    const url = serve(host);

    const r = connect(url);
    remotes.push(r);
    const me = await r.call<{ user: { id: number } }>("register", {
      name: "Chef", email: "chef@pg.lite", password: "pw",
    });
    const uid = me.user.id;
    type Recipes = {
      recipes: Record<string, { id: number; name: string }>;
      steps: Record<string, { id: number; recipe_id: number; text: string }>;
    };
    const doc = r.doc<Recipes>(`recipe:${uid}`);
    await doc.ready;

    const rid = (d: Recipes) => Object.keys(d.recipes)[0]!;
    await proveLaw<Recipes>({
      handle: doc, name: `recipe:${uid}`, sql,
      undo: (v?: number) => r.call("undo", { doc: `recipe:${uid}`, v }),
      batches: [
        () => [{ op: "add", path: "/recipes/-", value: { name: "ramen" } }],
        (d) => [{ op: "add", path: "/steps/-", value: { recipe_id: Number(rid(d)), text: "boil stock" } }],
        (d) => [{ op: "add", path: "/steps/-", value: { recipe_id: Number(rid(d)), text: "cut noodles" } }],
        // The combination under test: removing the parent cascades BOTH
        // steps — expressed in the echo, restored whole by the undo (which
        // proveLaw drives, then redoes).
        (d) => [{ op: "remove", path: `/recipes/${rid(d)}` }],
      ],
    });
  }, 30_000);
});

// The vocabulary pass uses SET LOCAL check_function_bodies, twice, inside
// one transaction. That is ordinary Postgres, but the embedded engine is a
// wasm build — assume nothing, drive it.
describe("db/fn on the embedded engine", () => {
  test("replays, resolves cross-references, and an edit takes effect", async () => {
    const d = mkdtempSync(join(tmpdir(), "epsilon-pglite-fn-"));
    const fnDir = join(d, "fn");
    mkdirSync(fnDir, { recursive: true });
    writeFileSync(join(d, "001-t.sql"), "CREATE TABLE fn_t (id int)");
    // a.sql sorts first but calls b.sql's function.
    writeFileSync(join(fnDir, "a.sql"),
      "CREATE OR REPLACE FUNCTION fn_a(n text) RETURNS text AS $$ SELECT fn_b('hi ' || n) $$ LANGUAGE sql;");
    writeFileSync(join(fnDir, "b.sql"),
      "CREATE OR REPLACE FUNCTION fn_b(t text) RETURNS text AS $$ SELECT upper(t) $$ LANGUAGE sql;");

    const dbDir = mkdtempSync(join(tmpdir(), "epsilon-pglite-fndb-"));
    const s2 = await openPglite(dbDir);
    try {
      const ran = await migrate(s2 as Sql, { dir: d, log: () => {} });
      expect(ran.map((m) => m.name)).toEqual(["001-t.sql", "fn/a.sql", "fn/b.sql"]);
      expect((await s2`SELECT fn_a('pete') AS r`)[0]!.r).toBe("HI PETE");

      writeFileSync(join(fnDir, "b.sql"),
        "CREATE OR REPLACE FUNCTION fn_b(t text) RETURNS text AS $$ SELECT lower(t) $$ LANGUAGE sql;");
      await migrate(s2 as Sql, { dir: d, log: () => {} });
      expect((await s2`SELECT fn_a('PETE') AS r`)[0]!.r).toBe("hi pete");
    } finally {
      await (s2 as any).end?.();
      rmSync(d, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });
});
