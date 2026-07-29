// The pixels. list() routes membership ops; each row renders from its own
// lens. Adds go to "/-" — the SERVER mints ids (Postgres sequences here).
// With auth on, you get YOUR boards (mine:<uid>): creating one is an op on
// that doc; opening one is just another doc name.
import { connect, list, text, effect, pushDisposeScope, popDisposeScope } from "./epsilon";
import type { OpSignal, Dispose, DocHandle } from "./epsilon";
import type { Board, Card } from "./types";

interface BoardRef { id: number | string; name: string }
interface Mine { boards: Record<string, BoardRef> }

const authDialog = document.getElementById("auth") as HTMLDialogElement;
const authError = document.getElementById("auth-error")!;
const mineSection = document.getElementById("mine")!;
const boardName = document.getElementById("board-name")!;
const log = document.getElementById("log")!;

const remote = connect(
  // wss on https — a hardcoded ws:// is blocked as mixed content behind TLS.
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
  {
    // Runs on EVERY (re)connect before docs re-open: a dropped socket
    // re-authenticates itself instead of stranding us at the auth dialog.
    async onConnect(r) {
      const token = localStorage.getItem("epsilon-token");
      if (!token) return;
      try {
        afterAuth(await r.call<{ id: number }>("authenticate", { token }));
      } catch {
        localStorage.removeItem("epsilon-token");
      }
    },
    onError(_doc, error) {
      // A requireAuth host refuses docs until an auth method vouches for us.
      if (error === "unauthenticated") authDialog.showModal();
      else console.error("[app]", error);
    },
  },
);

// --- the board on screen ---------------------------------------------------

let disposeBoard: Dispose | null = null;
let boardDoc: DocHandle<Board> | null = null;
let currentBoard: string | null = null;

function openBoard(name: string): void {
  currentBoard = name;
  disposeBoard?.();
  log.replaceChildren();
  location.hash = `#/${name}`;
  // Acquire before releasing: a same-name re-open keeps the handle alive
  // (refcount), a switch lets the old doc close — the server unsubscribes
  // and can evict it. No leak per visited board.
  const prev = boardDoc;
  const doc = (boardDoc = remote.doc<Board>(name));
  prev?.close();
  const cards = doc.at<Record<string, Card>>("/cards") as OpSignal<Record<string, Card> | null>;
  pushDisposeScope();
  effect(() => { boardName.textContent = doc.get()?.name ?? ""; });
  log.appendChild(
    list(cards, (card) => {
      const li = document.createElement("li");
      li.appendChild(text(card.map((c) => c?.text)));
      return li;
    }),
  );
  disposeBoard = popDisposeScope();

  const form = document.getElementById("form") as HTMLFormElement;
  const input = document.getElementById("input") as HTMLInputElement;
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    // No local append — the echo (with the server-minted id) renders it.
    cards.apply([{ op: "add", path: "/-", value: { text: input.value } }]);
    input.value = "";
  };
}

const hashBoard = () => /^#\/(board:\d+)$/.exec(location.hash)?.[1];

// The hash is navigation truth: openBoard writes it; back/forward (and a
// hand-edited URL) land here. Only a real change opens — openBoard's own
// hash write echoes back with currentBoard already set.
addEventListener("hashchange", () => {
  const name = hashBoard() ?? "board:1";
  if (name !== currentBoard) openBoard(name);
});

// --- your boards (authenticated mode) --------------------------------------

function showMine(userId: number | string): void {
  const mine = remote.doc<Mine>(`mine:${userId}`);
  const boards = mine.at<Record<string, BoardRef>>("/boards") as OpSignal<Record<string, BoardRef> | null>;
  mineSection.hidden = false;

  pushDisposeScope();
  document.getElementById("boards")!.appendChild(
    list(boards, (row, id) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.appendChild(text(row.map((b) => b?.name)));
      name.onclick = () => openBoard(`board:${id}`);
      const del = document.createElement("button");
      del.textContent = "✕";
      del.onclick = () => boards.apply([{ op: "remove", path: `/${id}` }]);
      li.append(name, " ", del);
      return li;
    }),
  );
  popDisposeScope(); // app-lifetime

  const form = document.getElementById("board-form") as HTMLFormElement;
  const input = document.getElementById("new-board") as HTMLInputElement;
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    boards.apply([{ op: "add", path: "/-", value: { name: input.value } }]);
    input.value = "";
  };

  openBoard(hashBoard() ?? "board:1");
}

// --- auth ------------------------------------------------------------------

let mineFor: number | string | null = null;

function afterAuth(user: { id: number | string }): void {
  authDialog.close();
  if (mineFor === user.id) return;  // reconnect — the docs re-open themselves
  mineFor = user.id;
  showMine(user.id);
}

async function auth(method: "login" | "register") {
  const params = {
    name: (document.getElementById("auth-name") as HTMLInputElement).value,
    email: (document.getElementById("auth-email") as HTMLInputElement).value,
    password: (document.getElementById("auth-password") as HTMLInputElement).value,
  };
  try {
    const { token, user } = await remote.call<{ token: string; user: { id: number } }>(method, params);
    localStorage.setItem("epsilon-token", token);
    afterAuth(user);
  } catch (err) {
    authError.textContent = String(err instanceof Error ? err.message : err);
  }
}
document.getElementById("auth-login")!.onclick = (e) => { e.preventDefault(); auth("login"); };
document.getElementById("auth-register")!.onclick = (e) => { e.preventDefault(); auth("register"); };

// --- boot ------------------------------------------------------------------

// In-memory mode (no auth gate): the shared board just works. If the host
// requires auth, this open triggers the dialog via onError instead.
openBoard(hashBoard() ?? "board:1");
