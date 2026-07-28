// The pixels. list() routes membership ops; each row renders from its own
// lens. Adds go to "/cards/-" — the SERVER mints the id (uuid in-memory,
// Postgres sequence relational) and the echo renders it.
import { connect, list, text, pushDisposeScope, popDisposeScope } from "./epsilon";
import type { OpSignal } from "./epsilon";
import type { Board, Card } from "./types";

const authDialog = document.getElementById("auth") as HTMLDialogElement;
const authError = document.getElementById("auth-error")!;

const remote = connect(`ws://${location.host}/ws`, {
  onError(_doc, error) {
    // A requireAuth host refuses docs until an auth method vouches for us.
    if (error === "unauthenticated") authDialog.showModal();
    else console.error("[app]", error);
  },
});

const board = remote.doc<Board>("board:1");
const cards = board.at<Record<string, Card>>("/cards") as OpSignal<Record<string, Card> | null>;

// Session restore: a stored token authenticates before the queued doc open
// would otherwise 401. call() queues until the socket opens.
const token = localStorage.getItem("epsilon-token");
if (token) {
  remote.call("authenticate", { token })
    .then(() => remote.doc("board:1"))            // re-ask — now authorized
    .catch(() => localStorage.removeItem("epsilon-token"));
}

async function auth(method: "login" | "register") {
  const params = {
    name: (document.getElementById("auth-name") as HTMLInputElement).value,
    email: (document.getElementById("auth-email") as HTMLInputElement).value,
    password: (document.getElementById("auth-password") as HTMLInputElement).value,
  };
  try {
    const { token } = await remote.call<{ token: string }>(method, params);
    localStorage.setItem("epsilon-token", token);
    authDialog.close();
    remote.doc("board:1");                        // re-open now we're in
  } catch (err) {
    authError.textContent = String(err instanceof Error ? err.message : err);
  }
}
document.getElementById("auth-login")!.onclick = (e) => { e.preventDefault(); auth("login"); };
document.getElementById("auth-register")!.onclick = (e) => { e.preventDefault(); auth("register"); };

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
  // No local append — the echo (with the server-minted id) renders it.
  cards.apply([{ op: "add", path: "/-", value: { text: input.value } }]);
  input.value = "";
};
