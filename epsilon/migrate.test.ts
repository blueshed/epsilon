// Migrations: ordered, recorded, idempotent, forward-only, transactional.
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { SQL } from "bun";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrationFiles, functionFiles } from "./migrate";

// Test db namespaced by app (package.json name) — see pg.test.ts's note.
const APP = ((await Bun.file(new URL("../package.json", import.meta.url)).json()).name as string)
  .toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^(?![a-z_])/, "app_");
const DB = `${APP}_migrate_test`;
const ADMIN_URL = "postgres://epsilon:epsilon@localhost:5599/epsilon";
const PG_URL = process.env.EPSILON_TEST_PG_URL ?? `postgres://epsilon:epsilon@localhost:5599/${DB}`;

let sql: SQL;
let dir: string;
const quiet = { log: () => {} };

beforeAll(async () => {
  if (!process.env.EPSILON_TEST_PG_URL) {
    const admin = new SQL(ADMIN_URL);
    const [exists] = await admin`SELECT 1 FROM pg_database WHERE datname = ${DB}`;
    if (!exists) await admin.unsafe(`CREATE DATABASE ${DB}`);
    await admin.end();
  }
  sql = new SQL(PG_URL, { max: 3 });
  // Start from a known-empty schema — this DB is scratch space.
  await sql.unsafe("DROP TABLE IF EXISTS migrations, m_a, m_b, m_c CASCADE");
});

afterAll(async () => { await sql.end(); });

afterEach(async () => {
  await sql.unsafe("DROP TABLE IF EXISTS migrations, m_a, m_b, m_c CASCADE");
  await sql.unsafe("DROP FUNCTION IF EXISTS m_greet(text); DROP FUNCTION IF EXISTS m_shout(text)");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "eps-mig-"));
  for (const [name, body] of Object.entries(files)) {
    // "fn/foo.sql" writes into the vocabulary directory.
    if (name.startsWith("fn/")) mkdirSync(join(dir, "fn"), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe("migrate", () => {
  test("applies in numeric order and records each file", async () => {
    const d = fixture({
      "002-b.sql": "CREATE TABLE m_b (id int);",
      "001-a.sql": "CREATE TABLE m_a (id int);",
      "010-c.sql": "CREATE TABLE m_c (id int);",   // 10 sorts after 2, not before
      "notes.md": "ignored",
    });
    expect(migrationFiles(d)).toEqual(["001-a.sql", "002-b.sql", "010-c.sql"]);

    const ran = await migrate(sql, { dir: d, ...quiet });
    expect(ran.map((m) => m.name)).toEqual(["001-a.sql", "002-b.sql", "010-c.sql"]);
    const rows = await sql`SELECT name FROM migrations ORDER BY name`;
    expect(rows.map((r: any) => r.name)).toEqual(["001-a.sql", "002-b.sql", "010-c.sql"]);
  });

  test("is idempotent — a second run applies nothing", async () => {
    const d = fixture({ "001-a.sql": "CREATE TABLE m_a (id int);" });
    await migrate(sql, { dir: d, ...quiet });
    expect(await migrate(sql, { dir: d, ...quiet })).toEqual([]);
  });

  test("applies only what is new", async () => {
    const d = fixture({ "001-a.sql": "CREATE TABLE m_a (id int);" });
    await migrate(sql, { dir: d, ...quiet });
    writeFileSync(join(d, "002-b.sql"), "CREATE TABLE m_b (id int);");
    const ran = await migrate(sql, { dir: d, ...quiet });
    expect(ran.map((m) => m.name)).toEqual(["002-b.sql"]);
  });

  test("FORWARD-ONLY: editing an applied file is refused by hash", async () => {
    const d = fixture({ "001-a.sql": "CREATE TABLE m_a (id int);" });
    await migrate(sql, { dir: d, ...quiet });
    writeFileSync(join(d, "001-a.sql"), "CREATE TABLE m_a (id int, extra text);");
    await expect(migrate(sql, { dir: d, ...quiet })).rejects.toThrow(/forward-only/i);
  });

  test("a failing migration rolls back whole — no partial schema, not recorded", async () => {
    const d = fixture({
      "001-a.sql": "CREATE TABLE m_a (id int);\nCREATE TABLE m_b (id int);\nSELECT 1/0;",
    });
    await expect(migrate(sql, { dir: d, ...quiet })).rejects.toThrow(/001-a\.sql failed/);
    const [t] = await sql`SELECT to_regclass('m_a') AS t`;
    expect(t.t).toBeNull();                                   // rolled back
    const rows = await sql`SELECT name FROM migrations`;
    expect(rows.length).toBe(0);                              // not recorded
  });


  test("concurrent boots don't double-apply (advisory lock)", async () => {
    const d = fixture({ "001-a.sql": "CREATE TABLE m_a (id int);" });
    const other = new SQL(PG_URL, { max: 2 });
    const [a, b] = await Promise.all([
      migrate(sql, { dir: d, ...quiet }),
      migrate(other, { dir: d, ...quiet }),
    ]);
    expect(a.length + b.length).toBe(1);                      // exactly one ran it
    await other.end();
  });
});

// A function body is NOT a migration: CREATE OR REPLACE is idempotent by
// construction, so hash-locking it forces a full copy per edit. db/fn is
// replayed every boot and never recorded.
describe("db/fn — the vocabulary, edited in place", () => {
  test("replays on every boot, and an EDIT just takes effect", async () => {
    const d = fixture({
      "001-a.sql": "CREATE TABLE m_a (id int)",
      "fn/greet.sql": "CREATE OR REPLACE FUNCTION m_greet(n text) RETURNS text AS $$ SELECT 'hi ' || n $$ LANGUAGE sql;",
    });
    const first = await migrate(sql, { dir: d, ...quiet });
    expect(first.map((m) => m.name)).toEqual(["001-a.sql", "fn/greet.sql"]);
    expect(first.find((m) => m.fn)?.applied).toBe(true);
    expect((await sql`SELECT m_greet('pete') AS r`)[0]!.r).toBe("hi pete");

    // The ledger records SCHEMA only — the vocabulary is not in it.
    const ledger = await sql`SELECT name FROM migrations`;
    expect(ledger.map((r: any) => r.name)).toEqual(["001-a.sql"]);

    // Edit the file in place. No new number, no copy, no drift error.
    writeFileSync(join(d, "fn", "greet.sql"),
      "CREATE OR REPLACE FUNCTION m_greet(n text) RETURNS text AS $$ SELECT 'hello ' || n $$ LANGUAGE sql;");
    const second = await migrate(sql, { dir: d, ...quiet });
    expect(second.map((m) => m.name)).toEqual(["fn/greet.sql"]);   // 001 already applied
    expect((await sql`SELECT m_greet('pete') AS r`)[0]!.r).toBe("hello pete");
  });

  test("order within db/fn carries no meaning — functions may call each other", async () => {
    // greet.sql sorts BEFORE shout.sql but calls it. Without
    // check_function_bodies=off this fails on a missing function.
    const d = fixture({
      "fn/greet.sql": "CREATE OR REPLACE FUNCTION m_greet(n text) RETURNS text AS $$ SELECT m_shout('hi ' || n) $$ LANGUAGE sql;",
      "fn/shout.sql": "CREATE OR REPLACE FUNCTION m_shout(t text) RETURNS text AS $$ SELECT upper(t) $$ LANGUAGE sql;",
    });
    await migrate(sql, { dir: d, ...quiet });
    expect((await sql`SELECT m_greet('pete') AS r`)[0]!.r).toBe("HI PETE");
  });

  test("the vocabulary swaps atomically — one bad file leaves the old set intact", async () => {
    const d = fixture({
      "fn/greet.sql": "CREATE OR REPLACE FUNCTION m_greet(n text) RETURNS text AS $$ SELECT 'v1 ' || n $$ LANGUAGE sql;",
    });
    await migrate(sql, { dir: d, ...quiet });
    expect((await sql`SELECT m_greet('x') AS r`)[0]!.r).toBe("v1 x");

    writeFileSync(join(d, "fn", "greet.sql"),
      "CREATE OR REPLACE FUNCTION m_greet(n text) RETURNS text AS $$ SELECT 'v2 ' || n $$ LANGUAGE sql;");
    writeFileSync(join(d, "fn", "zbroken.sql"), "CREATE OR REPLACE FUNCTION m_bad() RETURNS int AS $$ this is not sql $$ LANGUAGE sql;");

    await expect(migrate(sql, { dir: d, ...quiet })).rejects.toThrow("db/fn failed");
    expect((await sql`SELECT m_greet('x') AS r`)[0]!.r).toBe("v1 x");   // rolled back whole
  });

  test("a SIGNATURE change is refused, and the error names the fix", async () => {
    const d = fixture({
      "fn/greet.sql": "CREATE OR REPLACE FUNCTION m_greet(n text) RETURNS text AS $$ SELECT n $$ LANGUAGE sql;",
    });
    await migrate(sql, { dir: d, ...quiet });

    // Return type change — exactly what CREATE OR REPLACE cannot do.
    writeFileSync(join(d, "fn", "greet.sql"),
      "CREATE OR REPLACE FUNCTION m_greet(n text) RETURNS int AS $$ SELECT length(n) $$ LANGUAGE sql;");
    await expect(migrate(sql, { dir: d, ...quiet })).rejects.toThrow("DROP FUNCTION IF EXISTS");

    // The documented fix: drop it in a NUMBERED file, then the edit lands.
    writeFileSync(join(d, "002-drop.sql"), "DROP FUNCTION IF EXISTS m_greet(text)");
    await migrate(sql, { dir: d, ...quiet });
    expect((await sql`SELECT m_greet('four') AS r`)[0]!.r).toBe(4);
  });

  test("DML inside a function BODY is not schema DDL — the gate looks outside", async () => {
    // Every real dispatch function is full of INSERT/UPDATE/DELETE. Testing
    // the raw file text refused six of japan's twenty-three functions on the
    // first real migration — the gate matched statements inside $$ … $$.
    const d = fixture({
      "001-a.sql": "CREATE TABLE m_a (id int, label text)",
      "fn/greet.sql": `CREATE OR REPLACE FUNCTION m_greet(n text) RETURNS text AS $$
BEGIN
INSERT INTO m_a (label) VALUES (n);
UPDATE m_a SET label = n WHERE label IS NULL;
DELETE FROM m_a WHERE label = 'x';
RETURN n;
END;
$$ LANGUAGE plpgsql;`,
    });
    const ran = await migrate(sql, { dir: d, ...quiet });
    expect(ran.map((m) => m.name)).toEqual(["001-a.sql", "fn/greet.sql"]);
    expect((await sql`SELECT m_greet('ok') AS r`)[0]!.r).toBe("ok");
    await migrate(sql, { dir: d, ...quiet });                 // and it replays
  });

  test("schema DDL in db/fn is REFUSED — it could not survive a second boot", async () => {
    const d = fixture({
      "fn/oops.sql": "CREATE TABLE m_b (id int);\nCREATE OR REPLACE FUNCTION m_greet(n text) RETURNS text AS $$ SELECT n $$ LANGUAGE sql;",
    });
    // Refused BEFORE anything runs, naming the file and the fix — rather
    // than letting the second validation pass fail with "already exists",
    // which explains nothing.
    await expect(migrate(sql, { dir: d, ...quiet })).rejects.toThrow("NUMBERED file");
    expect((await sql`SELECT to_regclass('m_b') AS t`)[0]!.t).toBeNull();
  });

  test("the numbered pass runs FIRST — a function may use a table just created", async () => {
    const d = fixture({
      "001-a.sql": "CREATE TABLE m_a (id int, label text)",
      "fn/greet.sql": "CREATE OR REPLACE FUNCTION m_greet(n text) RETURNS bigint AS $$ SELECT count(*) FROM m_a WHERE label = n $$ LANGUAGE sql;",
    });
    await migrate(sql, { dir: d, ...quiet });       // same boot, both land
    expect(Number((await sql`SELECT m_greet('nope') AS r`)[0]!.r)).toBe(0);
  });

  test("no db/fn directory is not an error", async () => {
    const d = fixture({ "001-a.sql": "CREATE TABLE m_a (id int)" });
    expect(functionFiles(d)).toEqual([]);
    const ran = await migrate(sql, { dir: d, ...quiet });
    expect(ran.map((m) => m.name)).toEqual(["001-a.sql"]);
  });
});
