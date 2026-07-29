// One model, both sides — Bun runs the same TypeScript everywhere.
// `id` is minted by the server (uuid in-memory, sequence in Postgres) and
// arrives in the echo; clients send adds to "/cards/-".
export interface Card {
  id?: number | string;
  text: string;
  done?: boolean;
  /** Relational tier only: the author, from the echo. */
  created_by?: number | null;
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
