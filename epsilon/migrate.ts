/**
 * Migrations — numbered SQL files in `db/`, applied in order, recorded by
 * name AND content hash. Forward-only: once a file is applied, editing it is
 * an error (write the next number instead). Delta's vendor-first philosophy:
 * the files are yours, git-tracked, and nothing is hidden in node_modules.
 *
 *   await migrate(sql);                  // ./db relative to the app root
 *   await migrate(sql, { dir: "./db" }); // explicit
 *
 * Each file runs in ONE transaction — a failed migration leaves no partial
 * schema. An advisory lock serializes concurrent boots (two processes
 * starting together can't both apply 003).
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { SQL } from "bun";

/** Namespace for the boot-time advisory lock (arbitrary, stable). */
const LOCK_KEY = 8_147_231;

export interface Migration {
  name: string;
  hash: string;
  applied: boolean;
}

async function ensureTable(sql: SQL): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS migrations (
      name text PRIMARY KEY,
      hash text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
}

const hash = (text: string) => Bun.hash(text).toString(16);

/** List migration files in order — `NNN-name.sql`, numerically sorted. */
export function migrationFiles(dir: string): string[] {
  // Conservative charset: these names are inlined as SQL literals below.
  return readdirSync(dir)
    .filter((f) => /^\d+[\w.-]*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
}

/**
 * Apply every pending migration. Returns what ran (empty = already current).
 * Throws on drift: an applied file whose content changed.
 */
export async function migrate(
  sql: SQL,
  opts?: { dir?: string; log?: (msg: string) => void },
): Promise<Migration[]> {
  const dir = opts?.dir ?? "db";
  const log = opts?.log ?? ((m: string) => console.log(`[epsilon/migrate] ${m}`));

  // RESERVE one connection for the whole run: pg_advisory_lock is SESSION
  // scoped, so lock and unlock must land on the same connection — through
  // the pool they wouldn't, and the lock would never be released.
  const conn: any = await (sql as any).reserve();
  try {
    // Serializes concurrent boots: two processes starting together can't
    // both apply 003 — NOR both run the ledger DDL below, which would race
    // in pg_type (concurrent CREATE TABLE IF NOT EXISTS is not atomic).
    await conn`SELECT pg_advisory_lock(${LOCK_KEY})`;
    await ensureTable(conn);

    const done = new Map<string, string>();
    for (const row of await conn`SELECT name, hash FROM migrations`) {
      done.set(row.name as string, row.hash as string);
    }

    const ran: Migration[] = [];
    for (const name of migrationFiles(dir)) {
      const text = await Bun.file(join(dir, name)).text();
      const h = hash(text);
      const prev = done.get(name);

      if (prev !== undefined) {
        if (prev !== h) {
          throw new Error(
            `[epsilon/migrate] ${name} changed after it was applied. ` +
              `Migrations are forward-only — revert it and add the next numbered file.`,
          );
        }
        continue;
      }

      // One transaction per file — the file AND its ledger row commit
      // together, so a failure leaves neither partial schema nor a false
      // record. Explicit BEGIN/COMMIT on the reserved connection (NOT
      // conn.begin(): a multi-statement unsafe() inside it leaks failures as
      // unhandled rejections instead of rejecting the promise — verified on
      // Bun 1.3.14). Literals are safe to inline: `name` matched the
      // filename filter, `hash` is hex.
      try {
        await conn.unsafe(
          `BEGIN;\n${text}\n;INSERT INTO migrations (name, hash) VALUES ('${name}', '${h}');\nCOMMIT;`,
        );
      } catch (err) {
        try { await conn.unsafe("ROLLBACK"); } catch { /* already aborted */ }
        throw new Error(`[epsilon/migrate] ${name} failed: ${err}`);
      }
      log(`applied ${name}`);
      ran.push({ name, hash: h, applied: true });
    }
    return ran;
  } finally {
    try { await conn`SELECT pg_advisory_unlock(${LOCK_KEY})`; } catch { /* connection may be dead */ }
    conn.release?.();
  }
}

/** What's applied vs pending — for a status command or a boot log. */
export async function migrationStatus(sql: SQL, opts?: { dir?: string }): Promise<Migration[]> {
  await ensureTable(sql);
  const done = new Set<string>();
  for (const row of await sql`SELECT name FROM migrations`) done.add(row.name as string);
  const dir = opts?.dir ?? "db";
  return migrationFiles(dir).map((name) => ({
    name,
    hash: "",
    applied: done.has(name),
  }));
}
