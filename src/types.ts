// One model, both sides — Bun runs the same TypeScript everywhere.
export interface Card {
  id: string;
  text: string;
}

export interface Board {
  cards: Record<string, Card>;
}
