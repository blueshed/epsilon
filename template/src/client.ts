// The pixels. list() routes membership ops; each row renders from its own
// lens, so edits patch text in place — no diffing, no re-render.
import { connect, list, text, pushDisposeScope, popDisposeScope } from "@blueshed/epsilon";
import type { OpSignal } from "@blueshed/epsilon";
import type { Board, Card } from "./types";

const remote = connect("/ws".replace(/^/, `ws://${location.host}`));
const board = remote.doc<Board>("board");
const cards = board.at<Record<string, Card>>("/cards") as OpSignal<Record<string, Card> | null>;

const log = document.getElementById("log")!;
const form = document.getElementById("form") as HTMLFormElement;
const input = document.getElementById("input") as HTMLInputElement;

pushDisposeScope();
log.appendChild(
  list(cards, (card) => {
    const li = document.createElement("li");
    li.appendChild(text(card.map((c) => c?.text)));
    return li;
  }),
);
popDisposeScope(); // app-lifetime scope — keep the disposer if you route

form.onsubmit = (e) => {
  e.preventDefault();
  if (!input.value.trim()) return;
  // The op echoes back and renders itself — no local append (add it here
  // too and it appears twice).
  cards.apply([{ op: "add", path: `/${crypto.randomUUID()}`, value: { id: "", text: input.value } }]);
  input.value = "";
};
