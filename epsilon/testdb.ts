/**
 * Preflight for the suites that need something this machine may not have.
 *
 * `bun test` — bare, no arguments — is what everyone types, and it discovers
 * EVERY `*.test.ts` in the repo: the pure ones, the ones that need a Postgres
 * on :5599, and the one that drives a real browser. Before 0.10.0 that meant
 * a fresh scaffold's first `bun test` produced nine failures full of
 * `ERR_POSTGRES_CONNECTION_CLOSED`, under a README promising "bun test
 * verifies your stack, in your repo, forever".
 *
 * A test suite that cannot run should say so and step aside, not fail. So the
 * database-backed suites ask first, skip cleanly when the answer is no, and
 * print one line saying what would have run and how to get it.
 *
 * `bun run test` remains the curated no-database list; this makes the bare
 * command honest as well.
 */
import { SQL } from "bun";
// The seam, not Bun's client: this check runs against embedded Postgres too.
import type { Sql } from "./pg";

/**
 * Skipping is right on a laptop with no Docker and WRONG in CI, where a
 * database that failed to come up would turn a red build green. Set
 * `EPSILON_REQUIRE_DB=1` there: an unreachable Postgres then fails loudly
 * instead of quietly skipping. epsilon's own workflow sets it.
 */
const REQUIRED = !!process.env.EPSILON_REQUIRE_DB;

/** Can we reach a Postgres here? One connection, closed immediately. */
export async function pgReachable(url: string): Promise<boolean> {
  let sql: SQL | undefined;
  try {
    sql = new SQL(url, { max: 1 });
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    try { await sql?.end?.(); } catch { /* never opened */ }
  }
}

/** Say what was skipped and how to un-skip it — once per suite, not per test. */
export function skipped(suite: string, reason = "no Postgres on :5599"): void {
  if (REQUIRED) {
    throw new Error(
      `[epsilon/test] ${suite} cannot run — ${reason} — and EPSILON_REQUIRE_DB is set.\n` +
        "               Refusing to skip: a green build that tested nothing is worse than a red one.",
    );
  }
  console.warn(
    `[epsilon/test] SKIPPED ${suite} — ${reason}.\n` +
      `               \`bun run db:up\` (Docker), or set EPSILON_TEST_PG_URL.\n` +
      `               \`bun run test\` is the no-database list and always runs.`,
  );
}

/**
 * The relational suites drive the scaffold's demo doc type — `board_apply`
 * and friends, from `db/100-board.sql`. That file is the APP's, and an app is
 * told it may delete it; when it does, these suites lose their fixture. One
 * explained failure beats seven cryptic ones, so they check.
 */
export async function hasBoardFixture(sql: Sql): Promise<boolean> {
  try {
    const [row] = await sql`SELECT to_regprocedure('board_apply(text,jsonb,bigint)') IS NOT NULL AS ok`;
    return !!row?.ok;
  } catch {
    return false;
  }
}

/** The message for a database that is up but has no demo schema in it. */
export const NO_FIXTURE =
  "[epsilon/test] db/100-board.sql is missing, and the relational suites drive it as their\n" +
  "               fixture (board_apply / tally_open). It is the DEMO's schema and yours to\n" +
  "               delete — but these vendored tests come with it. Either keep those two SQL\n" +
  "               files, or re-point these suites at your own doc type (proveLaw in\n" +
  "               epsilon/law.ts is how you pin one). See README.md.";
