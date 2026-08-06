/**
 * Fixture types for the VENDORED suites.
 *
 * The relational suites drive `db/100-board.sql` as their fixture, and they
 * used to import `Board` and `Card` from the app's own `types.ts` — which
 * quietly made two of the DEMO's type names permanent furniture in every app
 * that scaffolds one. A field report put it exactly right: keeping them after
 * deleting the demo "reads like an apology".
 *
 * Nothing about `board_apply` needs to live in an app's model file, so the
 * shapes the suites need live HERE, inside the runtime they belong to, and
 * travel with `epsilon:upgrade` like everything else in this folder. An app
 * that deletes the demo now deletes `db/100-board.sql`, `db/101-tally.sql`
 * and its own types — and these suites keep compiling until it re-points
 * them at its own doc type (see `hasBoardFixture` in testdb.ts, which says
 * so when the SQL goes).
 *
 * These are DELIBERATELY loose: a fixture asserts what a test reads, not
 * what an app models.
 */

export interface FixtureCard {
  id?: number | string;
  text: string;
  done?: boolean;
  created_by?: number | null;
  updated_by?: number | null;
  updated_at?: string | null;
  /** Test fixtures also carry ad-hoc fields (a `title`, an in-memory shape). */
  [key: string]: unknown;
}

export interface FixtureMember {
  id: number;
  name: string;
  email: string;
}

export interface FixtureBoard {
  name: string;
  cards: Record<string, FixtureCard>;
  owner_id?: number | null;
  members?: Record<string, FixtureMember>;
  [key: string]: unknown;
}
