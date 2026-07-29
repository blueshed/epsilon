// The pixels. list() routes membership ops; each row renders from its own
// lens. Adds go to "/-" — the SERVER mints ids (Postgres sequences here).
// With auth on, you get YOUR boards (mine:<uid>): creating one is an op on
// that doc; opening one is just another doc name.
import { connect, list, text, effect, pushDisposeScope, popDisposeScope } from "./epsilon";
import type { OpSignal, Dispose, DocHandle } from "./epsilon";
import type { Board, Card, Member } from "./types";

interface BoardRef { id: number | string; name: string; shared?: boolean }
interface Mine { boards: Record<string, BoardRef> }

const authDialog = document.getElementById("auth") as HTMLDialogElement;
const authError = document.getElementById("auth-error")!;
const mineSection = document.getElementById("mine")!;
const boardName = document.getElementById("board-name")!;
const log = document.getElementById("log")!;
const share = document.getElementById("share")!;
const membersUl = document.getElementById("members")!;
const who = document.getElementById("who")!;

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
let presenceDoc: DocHandle<Record<string, { name: string }>> | null = null;
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
  const prevPresence = presenceDoc;
  const doc = (boardDoc = remote.doc<Board>(name));
  // Presence: watching this doc IS being on the board — the server's
  // subscribe hooks write us in and out.
  const pres = (presenceDoc = remote.doc<Record<string, { name: string }>>(`presence:${name}`));
  prev?.close();
  prevPresence?.close();
  const cards = doc.at<Record<string, Card>>("/cards") as OpSignal<Record<string, Card> | null>;
  const members = doc.at<Record<string, Member>>("/members") as OpSignal<Record<string, Member> | null>;
  membersUl.replaceChildren();
  pushDisposeScope();
  effect(() => { boardName.textContent = doc.get()?.name ?? ""; });
  effect(() => {
    const here = pres.get();
    const names = here ? Object.values(here).map((p) => p?.name ?? "?") : [];
    who.textContent = names.length ? `here: ${names.join(", ")}` : "";
  });
  // Each row shows all three verbs: the checkbox REPLACES /done, the text
  // rides the lens, ✕ REMOVES the card. No local mutation — echoes render.
  log.appendChild(
    list(cards, (card, id) => {
      const li = document.createElement("li");
      const done = document.createElement("input");
      done.type = "checkbox";
      effect(() => { done.checked = !!card.get()?.done; });
      done.onchange = () => card.at("/done").set(done.checked);
      const label = document.createElement("span");
      label.appendChild(text(card.map((c) => c?.text)));
      effect(() => { label.style.textDecoration = card.get()?.done ? "line-through" : ""; });
      const del = document.createElement("button");
      del.textContent = "✕";
      del.onclick = () => cards.apply([{ op: "remove", path: `/${id}` }]);
      li.append(done, " ", label, " ", del);
      return li;
    }),
  );
  // Sharing lives on OWNED boards (relational tier composes owner_id).
  effect(() => { share.hidden = doc.get()?.owner_id == null; });
  membersUl.appendChild(
    list(members, (m, uid) => {
      const li = document.createElement("li");
      li.appendChild(text(m.map((x) => (x ? `${x.name} <${x.email}>` : ""))));
      const del = document.createElement("button");
      del.textContent = "✕";
      del.onclick = () => members.apply([{ op: "remove", path: `/${uid}` }]);
      li.append(" ", del);
      return li;
    }),
  );
  disposeBoard = popDisposeScope();

  const memberForm = document.getElementById("member-form") as HTMLFormElement;
  const memberInput = document.getElementById("new-member") as HTMLInputElement;
  memberForm.onsubmit = (e) => {
    e.preventDefault();
    const email = memberInput.value.trim();
    if (!email) return;
    // Minted by email — the echo carries the member's id, name, and the
    // board appears in THEIR list via the mine-doc mirror.
    members.apply([{ op: "add", path: "/-", value: { email } }]);
    memberInput.value = "";
  };

  const form = document.getElementById("form") as HTMLFormElement;
  const input = document.getElementById("input") as HTMLInputElement;
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    // No local append — the echo (with the server-minted id) renders it.
    cards.apply([{ op: "add", path: "/-", value: { text: input.value } }]);
    input.value = "";
  };

  // Rename in place: edit the title, blur (or Enter) sends one replace op.
  // The echo — and its mirror into every mine list — renders the change.
  boardName.contentEditable = "true";
  boardName.onblur = () => {
    const v = boardName.textContent?.trim();
    if (v && v !== doc.peek()?.name) doc.at<string>("/name").set(v);
    else boardName.textContent = doc.peek()?.name ?? "";
  };
  boardName.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); boardName.blur(); }
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
      name.appendChild(text(row.map((b) => (b ? b.name + (b.shared ? " · shared" : "") : ""))));
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
