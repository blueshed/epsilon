// One model, both sides — Bun runs the same TypeScript everywhere.
// `id` is minted by the server (uuid in-memory, sequence in Postgres) and
// arrives in the echo; clients send adds to "/cards/-".
export interface Card {
  id?: number | string;
  text: string;
}

export interface Board {
  name: string;
  cards: Record<string, Card>;
}
