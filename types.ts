// One model, both sides — Bun runs the same TypeScript everywhere.
// `id` is minted by the server (uuid in-memory, sequence in Postgres) and
// arrives in the echo; clients send adds to "/cards/-".
export interface Card {
  id?: number | string;
  text: string;
  done?: boolean;
  /** Relational tier only: the author, from the echo. */
  created_by?: number | null;
  /** Relational tier only: who last edited this row, and when — the STATE
   *  half of "who changed what" (the kit's doc_history is the other). NULL
   *  until someone touches it. Survives the op-log prune. */
  updated_by?: number | null;
  updated_at?: string | null;
}

export interface Member {
  id: number;
  name: string;
  email: string;
}

export interface Board {
  name: string;
  cards: Record<string, Card>;
  /** Relational tier only: set when the board is owned. */
  owner_id?: number | null;
  members?: Record<string, Member>;
}

/** tally:<uid> — a declared view (epsilon/pg.ts's pgView), not a doc type:
 *  counts over your own boards, composed by db/101-tally.sql. Relational
 *  tier only — nothing to show in-memory mode, which has no owner_id. */
export interface Tally {
  boards: number;
  cards: number;
  done: number;
}
