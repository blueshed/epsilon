#!/usr/bin/env bun
/**
 * Export the EMBEDDED database as SQL — the missing half of "scaling up is a
 * config change".
 *
 * The README has always said: outgrow PGlite, `pg_dump`, set EPSILON_PG_URL.
 * But PGlite has no port, so `pg_dump` cannot reach it — the one documented
 * exit from the embedded tier did not exist. This is it.
 *
 *   bun epsilon/export.ts --dir ./data > dump.sql
 *   psql "$EPSILON_PG_URL" -f dump.sql
 *
 * It emits DATA ONLY, on purpose. The schema is `db/*.sql`, and the target
 * builds it the way every epsilon process does — by booting and running the
 * migrations. So the move is:
 *
 *   1. bun epsilon/export.ts --dir ./data > dump.sql
 *   2. EPSILON_PG_URL=postgres://… bun server.ts    # migrates, then stop it
 *   3. psql "$EPSILON_PG_URL" -f dump.sql
 *   4. redeploy with EPSILON_PG_URL set
 *
 * Step 3 is idempotent in the sense that matters: it TRUNCATEs each table it
 * fills, so a half-finished attempt can simply be re-run.
 *
 * Tables are emitted in foreign-key order (parents first) and sequences are
 * reset to match, so the first insert on the new server does not collide with
 * an id the old one already minted.
 */
import { openPglite } from "./pglite";
import type { Sql } from "./pg";

/** Quote a value as a SQL literal. jsonb/arrays arrive as JS objects. */
function lit(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : `'${v}'`;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

export async function exportSql(sql: Sql, write: (s: string) => void): Promise<void> {
  // Every ordinary table in public, with its FK dependencies.
  const tables = (await sql`
    SELECT c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname
  `) as { name: string }[];

  const deps = (await sql`
    SELECT src.relname AS child, tgt.relname AS parent
      FROM pg_constraint k
      JOIN pg_class src ON src.oid = k.conrelid
      JOIN pg_class tgt ON tgt.oid = k.confrelid
      JOIN pg_namespace n ON n.oid = src.relnamespace
     WHERE k.contype = 'f' AND n.nspname = 'public'
  `) as { child: string; parent: string }[];

  // Parents before children. A self-reference is not a cycle for this purpose
  // (one table, ordered against itself), so it is skipped.
  const names = tables.map((t) => t.name);
  const parentsOf = new Map<string, Set<string>>(names.map((n) => [n, new Set<string>()]));
  for (const d of deps) {
    if (d.child === d.parent) continue;
    parentsOf.get(d.child)?.add(d.parent);
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string, path: Set<string>) => {
    if (seen.has(n)) return;
    if (path.has(n)) return;               // circular FKs: emit and let the load sort it out
    path.add(n);
    for (const p of parentsOf.get(n) ?? []) visit(p, path);
    path.delete(n);
    seen.add(n);
    ordered.push(n);
  };
  for (const n of names) visit(n, new Set());

  write("-- epsilon: embedded → server. Data only; run the migrations first.\n");
  write("BEGIN;\n");
  write("SET CONSTRAINTS ALL DEFERRED;\n\n");

  for (const table of ordered) {
    const rows = (await sql.unsafe(`SELECT * FROM "${table}"`)) as Record<string, unknown>[];
    write(`TRUNCATE "${table}" CASCADE;\n`);
    if (!rows.length) { write("\n"); continue; }
    const cols = Object.keys(rows[0]!);
    const collist = cols.map((c) => `"${c}"`).join(", ");
    // OVERRIDING SYSTEM VALUE so identity columns keep the ids the app has
    // already handed out — doc_ops paths and client copies reference them.
    for (const row of rows) {
      write(
        `INSERT INTO "${table}" (${collist}) OVERRIDING SYSTEM VALUE VALUES (` +
          cols.map((c) => lit(row[c])).join(", ") + ");\n",
      );
    }
    write("\n");
  }

  // Sequences last: the next id the new server mints must be past every id
  // the old one did, or the first write collides.
  // From the CATALOG, not information_schema.sequences — which PGlite leaves
  // empty for identity columns, so an earlier version of this silently emitted
  // no setval at all and the first write on the new server collided with an
  // id the old one had already used.
  const seqs = (await sql`
    SELECT s.relname AS seq, c.relname AS "table", a.attname AS "column"
      FROM pg_depend d
      JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
      JOIN pg_class c ON c.oid = d.refobjid
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.refobjsubid
      JOIN pg_namespace n ON n.oid = s.relnamespace
     WHERE n.nspname = 'public'
  `) as { seq: string; table: string; column: string }[];
  for (const s of seqs) {
    write(
      `SELECT setval('${s.seq}', GREATEST((SELECT COALESCE(max("${s.column}"), 0) ` +
        `FROM "${s.table}"), 1));\n`,
    );
  }
  if (!seqs.length) write("-- no sequences found\n");

  write("\nCOMMIT;\n");
}

if (import.meta.main) {
  const flags = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a.startsWith("--")) flags.set(a.slice(2), process.argv[++i] ?? "");
  }
  const dir = flags.get("dir") ?? process.env.EPSILON_PG_DIR;
  if (!dir) {
    console.error("usage: bun epsilon/export.ts --dir ./data > dump.sql");
    process.exit(1);
  }
  const sql = await openPglite(dir);
  const out: string[] = [];
  await exportSql(sql, (s) => out.push(s));
  process.stdout.write(out.join(""));
  await sql.end?.();
}
