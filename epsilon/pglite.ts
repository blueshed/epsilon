/**
 * PGlite — in-process Postgres. The EMBEDDED engine behind the same `Sql`
 * seam pg.ts and migrate.ts already speak: real Postgres (WASM), real
 * plpgsql, real pgcrypto — so every migration, the doc kit, and the auth
 * contract run UNCHANGED. No separate database service; state lives in a
 * directory (mount a volume and it survives deploys).
 *
 *   const sql = await openPglite("./data");
 *   await migrate(sql);
 *   await pgDoc(host, sql, "board:1", null, { apply: "board_apply" });
 *
 * The deal being made (and why it suits many small apps): ONE app process
 * owns the directory — no horizontal scaling, and pgSync is unnecessary by
 * construction (there is no other process to hear from; the host's own
 * broadcast reaches every subscriber). Outgrow it, pg_dump into a wire
 * Postgres, set EPSILON_PG_URL: scaling up is a config change, because both
 * engines speak the same schema.
 *
 * Optional, like `pg`: nothing imports this file unless the app asks for
 * the embedded engine. Deploying with it? `bun add @electric-sql/pglite`.
 */
import type { Sql } from "./pg";

/** The slice of PGlite the adapter drives (structural — no hard import). */
interface PGliteish {
  query(query: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(query: string): Promise<{ rows: unknown[] }[]>;
  close(): Promise<void>;
}

/** Bun's SQL binds JS objects/arrays as jsonb. PGlite sends params as text,
 *  so containers are stringified and Postgres coerces by context (function
 *  signatures, column types) — same shape on the other side. */
function bind(v: unknown): unknown {
  return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
}

/** Wrap a PGlite instance in the `Sql` surface. Queries are serialized
 *  through one chain — PGlite IS one exclusive session, and the chain keeps
 *  interleaved awaits (persist chains, factory boots) strictly ordered. */
export function pgliteSql(db: PGliteish): Sql {
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0]!;
    for (let i = 0; i < values.length; i++) text += `$${i + 1}${strings[i + 1]}`;
    return run(async () => (await db.query(text, values.map(bind))).rows);
  }) as unknown as Sql;

  sql.unsafe = (query: string, params?: unknown[]) =>
    run(async () => {
      // Parameterized → extended protocol; bare (possibly multi-statement,
      // e.g. a migration file wrapped in BEGIN/COMMIT) → simple protocol.
      if (params?.length) return (await db.query(query, params.map(bind))).rows;
      const results = await db.exec(query);
      return results[results.length - 1]?.rows ?? [];
    });

  // One process, one session: the "reserved connection" migrate() wants for
  // its session-scoped advisory lock is simply this one. release is a no-op
  // via migrate's optional call.
  sql.reserve = async () => sql;
  sql.end = () => db.close();
  return sql;
}

/**
 * Open (or create) an embedded database at `dir` and hand back the `Sql`
 * epsilon speaks. Loads pgcrypto — the auth contract hashes with it.
 */
export async function openPglite(dir: string): Promise<Sql> {
  let PGlite: any;
  let pgcrypto: unknown;
  try {
    ({ PGlite } = await import("@electric-sql/pglite"));
    ({ pgcrypto } = await import("@electric-sql/pglite/contrib/pgcrypto"));
  } catch {
    throw new Error(
      "[epsilon/pglite] @electric-sql/pglite is not installed — bun add @electric-sql/pglite",
    );
  }
  const db: PGliteish = await PGlite.create(dir, { extensions: { pgcrypto } });
  return pgliteSql(db);
}
