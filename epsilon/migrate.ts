/**
 * Migrations — TWO kinds of SQL, because there are two kinds of SQL.
 *
 * `db/NNN-name.sql` — SCHEMA. Numbered, applied in order, recorded by name
 * AND content hash. Forward-only: once applied, editing it is an error
 * (write the next number instead). This is the right rule for DDL, because
 * a CREATE TABLE cannot be replayed over a table that exists.
 *
 * `db/fn/*.sql` — VOCABULARY. Stored functions, unnumbered, NOT recorded,
 * re-applied wholesale on every boot. `CREATE OR REPLACE FUNCTION` is
 * idempotent by construction — that is what OR REPLACE means — so a hash
 * lock buys nothing and costs everything: it forces a full copy of the body
 * into a new numbered file for each edit. The one deployed consumer had
 * `trip_apply` written out ten times, 79% of its db/ was function bodies,
 * and the copy-paste ritual had already produced a silent data-visibility
 * bug (a new file copied an old body over a widened one). Edit the file.
 *
 *   await migrate(sql);                  // ./db relative to the app root
 *   await migrate(sql, { dir: "./db" }); // explicit
 *
 * Order: every pending numbered file first, then the whole of `db/fn/` —
 * so a function may reference a table a migration in the same boot created.
 * Within `db/fn/` order does NOT matter: the set is created once with
 * `check_function_bodies = off` (so cross-references all exist) and then
 * re-run with it ON (so every body is still validated) — order-freedom
 * without losing the compiler. One transaction for the lot: the vocabulary
 * is replaced atomically or not at all. An advisory lock serializes
 * concurrent boots (two processes starting together can't both apply 003).
 *
 * What still belongs in a NUMBERED file: anything not replayable. Tables,
 * columns, indexes, types, seed data — and a function SIGNATURE change,
 * since CREATE OR REPLACE cannot alter a return type or argument names:
 * `DROP FUNCTION IF EXISTS foo(int);` in the next number, then edit db/fn.
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Sql } from "./pg";

/** Namespace for the boot-time advisory lock (arbitrary, stable). */
const LOCK_KEY = 8_147_231;

export interface Migration {
  name: string;
  hash: string;
  applied: boolean;
  /** A `db/fn/` file — replayed every boot, never recorded. */
  fn?: true;
}

async function ensureTable(sql: Sql): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS migrations (
      name text PRIMARY KEY,
      hash text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
}

/**
 * The ledger's fingerprint. SHA-256, because this value is COMPARED ACROSS
 * TIME: it is written once and re-checked on every boot for the life of the
 * deployment, and a mismatch does not degrade — it refuses to start, accusing
 * a file of having changed. `Bun.hash` was the wrong tool for that, not
 * because it is weak (drift detection needs no cryptography) but because its
 * default algorithm is not a documented stability contract. A Bun upgrade
 * that changed it would have stopped every deployed epsilon app at once, with
 * an error blaming the migrations.
 *
 * `legacyHash` is what those apps already have in their ledger, so a boot
 * that finds one rewrites it in place instead of accusing the file — the
 * upgrade is silent and one-way. Remove it when no 0.10-era ledger remains.
 */
const hash = (text: string) => Bun.SHA256.hash(text, "hex");
const legacyHash = (text: string) => Bun.hash(text).toString(16);

/** Released core migrations — 001–099 are epsilon's range, frozen once
 *  released; new core behavior ships as the next number. App migrations
 *  start at 100, so an upgrade never collides with an app's own files.
 *  This list upgrades WITH the runtime (epsilon:upgrade). */
const CORE = new Set([
  "001-epsilon.sql",
  "002-auth.sql",
  "003-doc-kit.sql",
  "004-housekeeping.sql",
  "005-gone.sql",
  "006-session-digest.sql",
]);

/** List migration files in order — `NNN-name.sql`, numerically sorted. The
 *  leading-digit filter is also what makes `db/fn/` invisible here. */
export function migrationFiles(dir: string): string[] {
  // Conservative charset: these names are inlined as SQL literals below.
  return readdirSync(dir)
    .filter((f) => /^\d+[\w.-]*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
}

/** Vocabulary files — `db/fn/*.sql`, name-sorted for a stable report. Order
 *  carries no meaning; see the header on check_function_bodies. */
export function functionFiles(dir: string): string[] {
  const fnDir = join(dir, "fn");
  if (!existsSync(fnDir)) return [];
  return readdirSync(fnDir).filter((f) => f.endsWith(".sql")).sort();
}

/** Dollar-quoted bodies removed. A statement INSIDE a function body is not
 *  a statement the FILE executes — and every real dispatch function is full
 *  of INSERT/UPDATE/DELETE. Testing the raw text refused six of the first
 *  app's twenty-three functions, which is the whole point of db/fn. */
const outsideBodies = (sql: string) =>
  sql.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "");

/** Statements a replayed file cannot contain and stay idempotent. Unlike
 *  the sub-100 warning this is a GATE — such a file cannot survive a second
 *  boot, so there is nothing to warn about and everything to refuse. */
// FUNCTION, VIEW, PROCEDURE and TRIGGER are in the list on purpose: the
// likeliest mistake in a functions directory is a bare `CREATE FUNCTION`
// (no OR REPLACE), which works on the FIRST boot and fails on every one
// after with a raw "already exists" from inside the two-pass swap — the
// unexplained failure this gate exists to prevent. UNIQUE INDEX and the
// IF NOT EXISTS spellings are covered by the same shapes.
const NOT_REPLAYABLE =
  /^\s*(CREATE\s+(?!OR\s+REPLACE)(UNIQUE\s+)?(TABLE|INDEX|TYPE|EXTENSION|SEQUENCE|FUNCTION|VIEW|PROCEDURE|TRIGGER|AGGREGATE|DOMAIN|SCHEMA)|ALTER\s+TABLE|INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM|DROP\s+)/im;

/**
 * Apply every pending migration. Returns what ran (empty = already current).
 * Throws on drift: an applied file whose content changed.
 */
export async function migrate(
  sql: Sql,
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
      // Cheap tripwire, not a gate: a sub-100 number that isn't upstream's
      // will collide with a future core file the day you upgrade.
      if (parseInt(name, 10) < 100 && !CORE.has(name)) {
        log(`${name}: 001–099 are reserved for epsilon core — start app migrations at 100`);
      }
      const text = await Bun.file(join(dir, name)).text();
      const h = hash(text);
      const prev = done.get(name);

      if (prev !== undefined) {
        if (prev !== h) {
          // Before accusing the file, check whether the LEDGER is simply
          // older than the hash function (pre-0.10.1 rows hold a Bun.hash
          // value). Same bytes, different algorithm: upgrade the row quietly.
          if (prev === legacyHash(text)) {
            await conn.unsafe(`UPDATE migrations SET hash = '${h}' WHERE name = '${name.replace(/'/g, "''")}'`);
            continue;
          }
          throw new Error(
            `[epsilon/migrate] ${name} changed after it was applied. ` +
              `Migrations are forward-only — revert it and add the next numbered file ` +
              `(the ledger records the hash, not the meaning: even a comment-only edit counts).`,
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

    // The vocabulary, after the schema — a function may reference a table
    // the numbered pass just created. One transaction for all of it: a
    // half-swapped vocabulary is worse than an old one.
    const fns = functionFiles(dir);
    if (fns.length) {
      const bodies: string[] = [];
      for (const name of fns) {
        const text = await Bun.file(join(dir, "fn", name)).text();
        // A GATE, not a tripwire (unlike the sub-100 warning above, which is
        // about a future collision). This file cannot work: db/fn is
        // replayed on every boot, so a CREATE TABLE in it fails the second
        // time the app starts. Refusing here with the reason beats letting
        // Postgres say "relation already exists" from inside a two-pass
        // vocabulary swap, which explains nothing.
        if (NOT_REPLAYABLE.test(outsideBodies(text))) {
          throw new Error(
            `[epsilon/migrate] db/fn/${name} contains schema DDL, and db/fn is REPLAYED on ` +
              `every boot. Move that statement to the next NUMBERED file; db/fn is for ` +
              `CREATE OR REPLACE FUNCTION (and VIEW) only — things that are idempotent by construction.`,
          );
        }
        bodies.push(text);
      }
      try {
        // TWO passes, one transaction. SQL-language bodies are validated at
        // CREATE time, so a function calling another would otherwise depend
        // on filename order.
        //   1. check_function_bodies OFF — everything is created, so
        //      cross-references all exist by the end. Order-free.
        //   2. check_function_bodies ON — the SAME bodies again, now
        //      validated against a complete vocabulary.
        // Skipping pass 2 would trade an ordering bug for a worse one: a
        // typo would install silently and fail at CALL time, in front of a
        // user. Re-creating a function is metadata, so the second pass is
        // cheap. SET LOCAL dies with the transaction — the app's session
        // never sees a relaxed setting.
        const sets = bodies.join("\n;\n");
        await conn.unsafe(
          `BEGIN;\nSET LOCAL check_function_bodies = off;\n${sets}\n;` +
            `SET LOCAL check_function_bodies = on;\n${sets}\n;COMMIT;`,
        );
      } catch (err) {
        try { await conn.unsafe("ROLLBACK"); } catch { /* already aborted */ }
        throw new Error(
          `[epsilon/migrate] db/fn failed: ${err}\n` +
            `If this is "cannot change return type" or "cannot change name of input parameter", ` +
            `CREATE OR REPLACE cannot alter a signature — put ` +
            `\`DROP FUNCTION IF EXISTS <name>(<old args>);\` in the next NUMBERED file, then edit db/fn.`,
        );
      }
      log(`vocabulary: ${fns.length} file${fns.length === 1 ? "" : "s"} in db/fn`);
      for (const name of fns) ran.push({ name: `fn/${name}`, hash: "", applied: true, fn: true });
    }
    return ran;
  } finally {
    try { await conn`SELECT pg_advisory_unlock(${LOCK_KEY})`; } catch { /* connection may be dead */ }
    conn.release?.();
  }
}

