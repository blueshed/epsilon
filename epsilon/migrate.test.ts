// Migrations: ordered, recorded, idempotent, forward-only, transactional.
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { SQL } from "bun";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrationStatus, migrationFiles } from "./migrate";

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
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "eps-mig-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
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

  test("status reports applied vs pending", async () => {
    const d = fixture({ "001-a.sql": "CREATE TABLE m_a (id int);" });
    await migrate(sql, { dir: d, ...quiet });
    writeFileSync(join(d, "002-b.sql"), "CREATE TABLE m_b (id int);");
    const status = await migrationStatus(sql, { dir: d });
    expect(status).toEqual([
      { name: "001-a.sql", hash: "", applied: true },
      { name: "002-b.sql", hash: "", applied: false },
    ]);
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
