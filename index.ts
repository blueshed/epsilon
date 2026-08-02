// The pixels. list() routes membership ops; each row renders from its own
// lens. Adds go to "/-" — the SERVER mints ids (Postgres sequences here).
// With auth on, you get YOUR boards (mine:<uid>): creating one is an op on
// that doc; opening one is just another doc name.
import {
  connect, list, text, bind, effect, routes, navigate,
  pushDisposeScope, popDisposeScope, trackDispose,
} from "./epsilon";
import type { OpSignal, Signal, Dispose, DocHandle } from "./epsilon";
import type { Board, Card, Member, Tally } from "./types";

interface BoardRef { id: number | string; name: string; shared?: boolean }
interface Mine { boards: Record<string, BoardRef> }

const authDialog = document.getElementById("auth") as HTMLDialogElement;
const authError = document.getElementById("auth-error")!;
const mineSection = document.getElementById("mine")!;
const view = document.getElementById("view")!;

/** Tiny builder — the board's markup lives here now, because routes() owns
 *  its target's children and a handler must be able to build them fresh. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  n.append(...kids);
  return n;
}

// The board's own elements, rebuilt per visit by boardView() below.
// Held as refs, not looked up: routes() appends the handler's fragment AFTER
// the handler returns, so a getElementById inside it would find nothing.
let boardName!: HTMLElement;
let boardBack!: HTMLButtonElement;
let log!: HTMLElement;
let share!: HTMLElement;
let membersUl!: HTMLElement;
let who!: HTMLElement;
let cardForm!: HTMLFormElement;
let cardInput!: HTMLInputElement;
let memberForm!: HTMLFormElement;
let memberInput!: HTMLInputElement;

// A native <dialog>, not window.confirm(): stylable like the rest of the
// app, and driveable by the same clicks a test already uses for #auth — a
// browser-chrome confirm() is invisible to both.
const confirmDialog = document.getElementById("confirm") as HTMLDialogElement;
const confirmMessage = document.getElementById("confirm-message")!;
const confirmOk = document.getElementById("confirm-ok") as HTMLButtonElement;
function confirmAction(message: string, actionLabel = "delete"): Promise<boolean> {
  confirmMessage.textContent = message;
  confirmOk.textContent = actionLabel;
  confirmDialog.returnValue = "";
  confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "ok"), { once: true });
  });
}

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
      if (error === "unauthenticated") {
        if (!authDialog.open) {
          authDialog.showModal();
          void offerPasskeys();   // autofill offers a passkey IF the browser holds one
        }
      } else console.error("[app]", error);
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
  boardBack.hidden = name === "board:1";
  disposeBoard?.();
  log.replaceChildren();
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
  // Gone is a snapshot of nothing: a board deleted — or a share revoked —
  // pushes null (v stays > 0, unlike the pre-snapshot null). Fall back to
  // the shared board; the mine list already lost its row via the mirror.
  effect(() => {
    if (doc.get() != null || doc.v === 0) return;
    queueMicrotask(() => { if (currentBoard === name) navigate("/board/1"); });
  });
  effect(() => {
    const here = pres.get();
    const names = here ? Object.values(here).map((p) => p?.name ?? "?") : [];
    who.textContent = names.length ? `here: ${names.join(", ")}` : "";
  });
  // Each row shows all three verbs: the checkbox REPLACES /done, the text
  // rides the lens, ✕ REMOVES the card. No local mutation — echoes render.
  // bind() is the precise path: an op into ANOTHER card never re-runs these.
  log.appendChild(
    list(cards, (card, id) => {
      const li = document.createElement("li");
      const done = document.createElement("input");
      done.type = "checkbox";
      const label = document.createElement("span");
      bind(card.at<boolean>("/done"), (d) => {
        done.checked = !!d;
        label.style.textDecoration = d ? "line-through" : "";
      });
      bind(card.at<string>("/text"), (t) => { label.textContent = t ?? ""; });
      done.onchange = () => card.at("/done").set(done.checked);
      const del = document.createElement("button");
      del.textContent = "✕";
      del.onclick = async () => {
        if (await confirmAction(`delete "${card.peek().text}"?`)) {
          cards.apply([{ op: "remove", path: `/${id}` }]);
        }
      };
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
      del.onclick = async () => {
        if (await confirmAction(`remove ${m.peek().name}?`, "remove")) {
          members.apply([{ op: "remove", path: `/${uid}` }]);
        }
      };
      li.append(" ", del);
      return li;
    }),
  );
  disposeBoard = popDisposeScope();

  memberForm.onsubmit = (e) => {
    e.preventDefault();
    const email = memberInput.value.trim();
    if (!email) return;
    // Minted by email — the echo carries the member's id, name, and the
    // board appears in THEIR list via the mine-doc mirror.
    members.apply([{ op: "add", path: "/-", value: { email } }]);
    memberInput.value = "";
  };

  cardForm.onsubmit = (e) => {
    e.preventDefault();
    if (!cardInput.value.trim()) return;
    // No local append — the echo (with the server-minted id) renders it.
    cards.apply([{ op: "add", path: "/-", value: { text: cardInput.value } }]);
    cardInput.value = "";
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

/**
 * The `/board/:id` view. routes() calls this ONCE per entry to the pattern
 * and hands it a params signal — so /board/1 → /board/2 does not rebuild
 * this shell, it just re-runs the effect below. The shell persists; only
 * the doc-bound content is torn down and reopened, which is the whole
 * reason params$ exists.
 */
function boardView(params$: Signal<Record<string, string>>): Node {
  boardBack = el("button", { id: "board-back", hidden: "" }, "←");
  boardName = el("h2", { id: "board-name" });
  who = el("p", { id: "who" });
  log = el("ul", { id: "log" });
  membersUl = el("ul", { id: "members" });
  memberInput = el("input", { id: "new-member", type: "email", placeholder: "share with an email, press enter" });
  memberForm = el("form", { id: "member-form" }, memberInput);
  share = el("section", { id: "share", hidden: "" },
    el("h3", {}, "members"), memberForm, membersUl);
  cardInput = el("input", { id: "input", placeholder: "type, press enter, watch the other tab", autofocus: "" });
  cardForm = el("form", { id: "form" }, cardInput);

  // Deterministic, unlike history.back(): always board 1, even after a
  // reload or a bookmarked link where there is no "back" to have.
  boardBack.onclick = () => navigate("/board/1");

  const frag = document.createDocumentFragment();
  frag.append(
    el("div", { id: "board-header" }, boardBack, boardName),
    who,
    cardForm,
    log,
    share,
  );

  // The param IS the navigation truth now — back/forward and a hand-edited
  // URL all arrive here, and openBoard no longer writes the hash back.
  effect(() => {
    const name = `board:${params$.get().id}`;
    if (name !== currentBoard) openBoard(name);
  });

  // Leaving the pattern entirely: drop the docs, so the server unsubscribes
  // and can evict. openBoard's own scope is disposed by routes().
  trackDispose(() => {
    disposeBoard?.();
    disposeBoard = null;
    boardDoc?.close();
    presenceDoc?.close();
    boardDoc = presenceDoc = null;
    currentBoard = null;
  });

  return frag;
}

// A cold load with no hash lands on the shared board — in-memory mode (no
// auth gate) then just works; a requireAuth host raises the dialog via
// onError instead. Set BEFORE routes() reads the hash: location.hash
// updates synchronously but `hashchange` does not fire until a later task,
// so going through the event would render the placeholder and flash. A
// hash already in the URL is honoured; replace() keeps a bare "#" out of
// the history.
if (!location.hash || location.hash === "#" || location.hash === "#/") {
  location.replace("#/board/1");
}

routes(view, {
  "/board/:id": (_p, params$) => boardView(params$),
  "/": () => el("p", { id: "pick" }, "pick a board, or make one above."),
});

// --- your boards (authenticated mode) --------------------------------------

function showMine(userId: number | string): void {
  const mine = remote.doc<Mine>(`mine:${userId}`);
  const boards = mine.at<Record<string, BoardRef>>("/boards") as OpSignal<Record<string, BoardRef> | null>;
  // tally:<uid> — a declared view (epsilon/pg.ts's pgView), not a doc you
  // write to: it renders like any doc, live, without a fetch.
  const tally = remote.doc<Tally>(`tally:${userId}`);
  mineSection.hidden = false;

  pushDisposeScope();
  document.getElementById("boards")!.appendChild(
    list(boards, (row, id) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.appendChild(text(row.map((b) => (b ? b.name + (b.shared ? " · shared" : "") : ""))));
      name.onclick = () => navigate(`/board/${id}`);
      const del = document.createElement("button");
      del.textContent = "✕";
      del.onclick = async () => {
        const b = row.peek();
        // Owned boards DELETE (every card with them); shared ones LEAVE —
        // mine_apply's dispatch already draws this line, the confirm just
        // says it out loud before it happens.
        const msg = b.shared ? `leave "${b.name}"?` : `delete "${b.name}"? this removes all its cards.`;
        if (await confirmAction(msg, b.shared ? "leave" : "delete")) {
          boards.apply([{ op: "remove", path: `/${id}` }]);
        }
      };
      li.append(name, " ", del);
      return li;
    }),
  );
  const tallyEl = document.getElementById("tally")!;
  effect(() => {
    const t = tally.get();
    tallyEl.textContent = t ? `${t.boards} boards · ${t.cards} cards · ${t.done} done` : "";
  });
  popDisposeScope(); // app-lifetime

  const form = document.getElementById("board-form") as HTMLFormElement;
  const input = document.getElementById("new-board") as HTMLInputElement;
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    boards.apply([{ op: "add", path: "/-", value: { name: input.value } }]);
    input.value = "";
  };

  // The board's FIRST open happened before we had an identity and a
  // requireAuth host refused it. Re-open the one we are on — the route
  // hasn't changed, so nothing else would.
  if (currentBoard) openBoard(currentBoard);
  else navigate("/board/1");
}

// --- auth ------------------------------------------------------------------

let mineFor: number | string | null = null;

function afterAuth(user: { id: number | string }): void {
  authDialog.close();
  if (supported) addPasskeyBtn.hidden = false;
  signoutBtn.hidden = false;
  if (mineFor === user.id) return;  // reconnect — the docs re-open themselves
  mineFor = user.id;
  showMine(user.id);
}

const signoutBtn = document.getElementById("signout") as HTMLButtonElement;
signoutBtn.onclick = async () => {
  const token = localStorage.getItem("epsilon-token");
  localStorage.removeItem("epsilon-token");
  try { if (token) await remote.call("logout", { token }); } catch { /* session already gone */ }
  location.reload();   // clean teardown — docs close with the page; the gate meets the next load
};

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

// --- passkeys — passwordless sign-in over the same wire ---------------------
// The server runs the ceremony (epsilon/passkey.ts); this side only ferries
// bytes between navigator.credentials and remote.call, base64url both ways.

const toB64u = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const passkeyBtn = document.getElementById("auth-passkey") as HTMLButtonElement;
const addPasskeyBtn = document.getElementById("add-passkey") as HTMLButtonElement;
const supported = !!window.PublicKeyCredential;
passkeyBtn.hidden = !supported;

async function finishAssertion(cred: PublicKeyCredential): Promise<void> {
  const r = cred.response as AuthenticatorAssertionResponse;
  const { token, user } = await remote.call<{ token: string; user: { id: number } }>("passkey_login_finish", {
    id: cred.id,
    clientDataJSON: toB64u(r.clientDataJSON),
    authenticatorData: toB64u(r.authenticatorData),
    signature: toB64u(r.signature),
    userHandle: r.userHandle ? toB64u(r.userHandle) : undefined,
  });
  localStorage.setItem("epsilon-token", token);
  afterAuth(user);
}

// Conditional UI: while the dialog is open, the email field's AUTOFILL
// offers a passkey — but only when the browser actually holds one for this
// site, so a first run never meets an empty passkey sheet. Aborted when
// the dialog closes or the explicit button takes over.
let conditionalAbort: AbortController | null = null;
async function offerPasskeys(): Promise<void> {
  if (!supported) return;
  try {
    if (!(await PublicKeyCredential.isConditionalMediationAvailable?.())) return;
  } catch { return; }
  conditionalAbort?.abort();
  const ac = (conditionalAbort = new AbortController());
  try {
    const o = await remote.call<{ challenge: string }>("passkey_login_begin", {});
    const cred = (await navigator.credentials.get({
      mediation: "conditional",
      signal: ac.signal,
      publicKey: { challenge: fromB64u(o.challenge), allowCredentials: [], userVerification: "preferred" },
    })) as PublicKeyCredential | null;
    if (cred) await finishAssertion(cred);
  } catch { /* aborted, dismissed, or superseded — the other doors still work */ }
}
authDialog.addEventListener("close", () => conditionalAbort?.abort());

passkeyBtn.onclick = async (e) => {
  e.preventDefault();
  conditionalAbort?.abort();
  try {
    // An email in the form narrows to that account; empty = the browser
    // offers whatever resident passkeys it holds for this site.
    const email = (document.getElementById("auth-email") as HTMLInputElement).value.trim();
    const o = await remote.call<{ challenge: string; allowCredentials: { id: string }[] }>(
      "passkey_login_begin", email ? { email } : {});
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: fromB64u(o.challenge),
        allowCredentials: o.allowCredentials.map((c) => ({ type: "public-key" as const, id: fromB64u(c.id) })),
        userVerification: "preferred",
      },
    })) as PublicKeyCredential | null;
    if (cred) await finishAssertion(cred);
  } catch (err) {
    authError.textContent = String(err instanceof Error ? err.message : err);
  }
};

addPasskeyBtn.onclick = async () => {
  try {
    const o = await remote.call<{
      challenge: string;
      rp: { name: string };
      user: { id: string; name: string; displayName: string };
      pubKeyCredParams: PublicKeyCredentialParameters[];
      authenticatorSelection: AuthenticatorSelectionCriteria;
    }>("passkey_register_begin");
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: fromB64u(o.challenge),
        rp: o.rp,
        user: { id: fromB64u(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: o.pubKeyCredParams,
        authenticatorSelection: o.authenticatorSelection,
        attestation: "none",
      },
    })) as PublicKeyCredential | null;
    if (!cred) return;
    const r = cred.response as AuthenticatorAttestationResponse;
    await remote.call("passkey_register_finish", {
      id: cred.id,
      clientDataJSON: toB64u(r.clientDataJSON),
      attestationObject: toB64u(r.attestationObject),
      transports: r.getTransports?.() ?? undefined,
    });
    addPasskeyBtn.textContent = "passkey added ✓";
    addPasskeyBtn.disabled = true;
  } catch (err) {
    addPasskeyBtn.textContent = String(err instanceof Error ? err.message : err);
  }
};

// --- boot ------------------------------------------------------------------

// (Boot lands beside routes() above — the hash must be set before the
// router reads it.)
