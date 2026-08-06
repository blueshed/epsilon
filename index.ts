// The pixels. list() routes membership ops; each row renders from its own
// lens. Adds go to "/-" — the SERVER mints ids (Postgres sequences here).
// With auth on, you get YOUR boards (mine:<uid>): creating one is an op on
// that doc; opening one is just another doc name.
import {
  connect, list, text, signal, computed, effect, batch, routes, route, navigate,
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

/** How long ago, in the roughest useful unit. The stamp is a timestamptz
 *  string from the echo — never parsed on the server, never re-fetched. */
function ago(at: string): string {
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (s < 45) return "just now";
  const [n, unit] =
    s < 3600 ? [s / 60, "m"] :
    s < 86400 ? [s / 3600, "h"] :
    [s / 86400, "d"];
  return `${Math.round(n)}${unit} ago`;
}

/** A stamp's display name. The board's OWN members map is already composed
 *  and live on the doc, so this is a lookup, not a fetch. An id it can't
 *  resolve — the owner, who has no member row — renders as nothing rather
 *  than a bare "#4": a demo shouldn't teach leaking internal ids. */
function stampName(
  uid: number | null | undefined,
  members: Record<string, Member> | null | undefined,
): string {
  if (uid == null) return "";
  if (mineFor != null && String(uid) === String(mineFor)) return "you";
  return members?.[String(uid)]?.name ?? "";
}

/**
 * Undo and history are doc-kit verbs of the RELATIONAL tier: `server.ts`
 * wires `pgUndo`/`pgHistory` only when an engine is set. In-memory mode — a
 * shape preview, not a tier — has neither, and offering a button that can
 * only answer "unknown method" is worse than not offering it.
 *
 * So: one probe per session, not per board. Any OTHER refusal (a permit, a
 * missing board) still proves the method is there — only the host's own
 * "unknown method" hides the controls.
 */
let docKit: Promise<boolean> | null = null;
function hasDocKit(doc: string): Promise<boolean> {
  docKit ??= remote.call("history", { doc, limit: 1 })
    .then(() => true)
    .catch((err) => !/unknown method/i.test(String(err instanceof Error ? err.message : err)));
  return docKit;
}

/** One line of board status — a refusal, mostly. Cleared by the next thing
 *  that succeeds; never a dialog, because a refusal is information. */
function say(msg: string): void {
  boardMsg.textContent = msg;
}

/** A message that has to survive the navigation that follows it: openBoard
 *  clears the line, so a refusal handled by bouncing to the shared board
 *  would clear itself. Set it, navigate, and openBoard shows it on arrival. */
let pendingMsg = "";

interface HistoryEntry {
  v: number;
  at: string;
  by: number | null;
  /** Joined at READ time, so someone who has since left is still named. */
  name: string | null;
  ops: { op: string; path: string }[];
}

/** The audit, read back. Gated in SQL by the doc's own permit, so this can
 *  never be a side door into a board you may not open. */
async function loadHistory(doc: string): Promise<void> {
  historyPanel.replaceChildren(el("li", {}, "…"));
  try {
    const rows = await remote.call<HistoryEntry[]>("history", { doc, limit: 20 });
    historyPanel.replaceChildren(
      ...(rows.length
        ? rows.map((h) =>
            el("li", {},
              el("span", {}, `${h.name ?? "someone"} · ${h.ops.map((o) => `${o.op} ${o.path}`).join(", ")}`),
              el("small", { class: "byline" }, `v${h.v} · ${ago(h.at)}`)))
        : [el("li", {}, "nothing yet.")]),
    );
  } catch (err) {
    historyPanel.replaceChildren(el("li", {}, String(err instanceof Error ? err.message : err)));
  }
}

// The board's own elements, rebuilt per visit by boardView() below.
// Held as refs, not looked up: routes() appends the handler's fragment AFTER
// the handler returns, so a getElementById inside it would find nothing.
let boardName!: HTMLElement;
let boardBack!: HTMLButtonElement;
let undoBtn!: HTMLButtonElement;
let historyBtn!: HTMLButtonElement;
let historyPanel!: HTMLElement;
let boardMsg!: HTMLElement;
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

// Local state — not every signal is a doc. The socket's health is a fact
// about THIS tab: nothing to share, nothing to persist, so it is an ordinary
// signal. `live` is false until the first connect, `retrying` distinguishes a
// drop we expect to heal from a close we asked for.
const live = signal(false);
const retrying = signal(false);
/** One derived line, not two flags read in three places. */
const linkState = computed(() =>
  live.get() ? "" : retrying.get() ? "reconnecting…" : "offline");

const remote = connect(
  // wss on https — a hardcoded ws:// is blocked as mixed content behind TLS.
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
  {
    // Runs on EVERY (re)connect before docs re-open: a dropped socket
    // re-authenticates itself instead of stranding us at the auth dialog.
    async onConnect(r) {
      // Two locals, one flush: batch() is for writes to DIFFERENT signals —
      // an op array already batches a doc, so this is the case that needs it.
      batch(() => { live.set(true); retrying.set(false); });
      const token = localStorage.getItem("epsilon-token");
      if (!token) return;
      try {
        afterAuth(await r.call<{ id: number }>("authenticate", { token }));
      } catch {
        localStorage.removeItem("epsilon-token");
      }
    },
    // The symmetric half, and not optional: doc signals KEEP their last value
    // across a drop — the reconnect's snapshot is what resets them. Presence
    // below is rendered as live, so without this it goes on naming people who
    // are on a socket we no longer hold.
    onDisconnect(willRetry) {
      batch(() => { live.set(false); retrying.set(willRetry); });
    },
    onError(doc, error, meta) {
      // A requireAuth host refuses docs until an auth method vouches for us.
      if (error === "unauthenticated") {
        if (!authDialog.open) {
          authDialog.showModal();
          startPasskeyAutofill();   // autofill offers a passkey IF the browser holds one
        }
        return;
      }
      // A refused WRITE (0.8.1's `meta.write`) — the doc is fine, one write
      // wasn't. Say it where the other refusals are said.
      if (meta?.write) { say(error); return; }
      // A refused OPEN. "unknown doc" is the DESIGNED answer for a board that
      // is gone AND for one that was never yours — no existence oracle, so
      // they read alike on purpose. Neither is an error to shout into the
      // console, and the doc cannot tell us itself: a refused open leaves
      // peek() null and v 0, exactly like one that has not opened yet, which
      // is why the "gone" effect in openBoard cannot catch this and this
      // handler must. Without it you sit on a blank board with no way back.
      if (doc.startsWith("board:") || doc.startsWith("presence:board:")) {
        // A board doc we are no longer on: the refusal is STALE. Both docs of
        // a board can be refused, and the bounce below happens on the first —
        // so the second lands after currentBoard has already moved. Recovering
        // twice would fight the navigation; logging it would cry wolf.
        if (doc !== currentBoard && doc !== `presence:${currentBoard}`) return;
        const msg = "that board isn't there — or isn't yours.";
        if (currentBoard === "board:1") say(msg);
        else { pendingMsg = msg; queueMicrotask(() => navigate("/board/1")); }
        return;
      }
      console.error("[app]", doc, error);
    },
  },
);

// --- the board on screen ---------------------------------------------------

// Who we are, once an auth method vouches for the socket — read by
// stampName() to say "you". Declared HERE, above every render path, not
// beside afterAuth(): a `let` in the auth section is in its temporal dead
// zone while routes() builds the first board during module evaluation.
let mineFor: number | string | null = null;

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
  // Narrow, THEN read (0.9.0): reading doc.get() here tracked the root, so
  // anyone's card add re-ran this and rewrote the node — dropping your caret
  // to the end mid-rename. The lens re-runs only when /name itself changes.
  const boardTitle = doc.at<string | undefined>("/name");
  effect(() => {
    const name = boardTitle.get() ?? "";
    // And not while YOU are typing in it: a remote rename still lands here,
    // and rewriting a focused contentEditable moves the caret. onblur
    // reconciles what you leave behind.
    if (document.activeElement === boardName) return;
    boardName.textContent = name;
  });
  // Gone is a snapshot of nothing: a board deleted — or a share revoked —
  // pushes null (v stays > 0, unlike the pre-snapshot null). Fall back to
  // the shared board; the mine list already lost its row via the mirror.
  effect(() => {
    if (doc.get() != null || doc.v === 0) return;
    queueMicrotask(() => { if (currentBoard === name) navigate("/board/1"); });
  });
  effect(() => {
    // The link first: a presence doc holds its last value across a drop, so
    // rendering it unconditionally would keep naming people on a socket we
    // no longer have (epsilon/DESIGN.md, onDisconnect).
    const link = linkState.get();
    if (link) { who.textContent = link; return; }
    const here = pres.get();
    const names = here ? Object.values(here).map((p) => p?.name ?? "?") : [];
    who.textContent = names.length ? `here: ${names.join(", ")}` : "";
  });
  // Each row shows all three verbs: the checkbox REPLACES /done, the text
  // rides the lens, ✕ REMOVES the card. No local mutation — echoes render.
  // A lens read in an effect is the precise path: an op into ANOTHER card
  log.appendChild(
    list(cards, (card, id) => {
      const li = document.createElement("li");
      const done = document.createElement("input");
      done.type = "checkbox";
      const label = document.createElement("span");
      const doneL = card.at<boolean>("/done");
      const textL = card.at<string>("/text");
      effect(() => {
        const d = doneL.get();
        done.checked = !!d;
        label.style.textDecoration = d ? "line-through" : "";
      });
      effect(() => { label.textContent = textL.get() ?? ""; });
      // Into the nested route. The board layout stays mounted; only the
      // detail below is built, and switching cards swaps just that.
      label.onclick = () => navigate(`/board/${name.split(":")[1]}/card/${id}`);
      // The row stamps, which card_json puts on EVERY echo (db/100-board.sql).
      // Nothing else in the app reads them, so without this the schema is
      // sending three fields into the void. Each is its own lens, so a card's
      // byline re-renders when that card is edited — not when any card is.
      const byline = document.createElement("small");
      byline.className = "byline";
      const createdByL = card.at<number | null>("/created_by");
      const updatedByL = card.at<number | null>("/updated_by");
      const updatedAtL = card.at<string | null>("/updated_at");
      effect(() => {
        const roster = members.get();
        const author = stampName(createdByL.get(), roster);
        const editor = stampName(updatedByL.get(), roster);
        const at = updatedAtL.get();
        // board_apply stamps updated_* on the INSERT too, so a fresh card has
        // author === editor. Saying "added by you · edited by you" of a card
        // nobody has touched would be noise, so the two collapse into one
        // name; they only split once someone else has been in.
        byline.textContent =
          !at ? (author ? `added by ${author}` : "")
          : !editor ? `edited ${ago(at)}`
          : author && author !== editor ? `added by ${author} · edited by ${editor}, ${ago(at)}`
          : `${editor}, ${ago(at)}`;
      });
      done.onchange = () => card.at("/done").set(done.checked);
      const del = document.createElement("button");
      del.textContent = "✕";
      del.onclick = async () => {
        if (await confirmAction(`delete "${card.peek().text}"?`)) {
          cards.apply([{ op: "remove", path: `/${id}` }]);
        }
      };
      li.append(done, " ", label, " ", byline, " ", del);
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

  // Undo — the other half of the doc kit. doc_ops stores each write's inverse
  // (003), so this is a call, not a client-side stack: it reverts YOUR last
  // write and REFUSES, never clobbers, when someone wrote after you. The
  // refusal is the interesting part, so it is shown rather than swallowed.
  undoBtn.onclick = async () => {
    undoBtn.disabled = true;
    try {
      await remote.call("undo", { doc: name });
      say("");
    } catch (err) {
      say(String(err instanceof Error ? err.message : err).replace(/^Error:\s*/, ""));
    } finally {
      undoBtn.disabled = false;
      if (!historyPanel.hidden) loadHistory(name);
    }
  };

  // History — the SAME table the undo log lives in, read back through the
  // doc's own permit. A paged read, not a doc: it has no live claim to make,
  // so it loads when opened and after a write of ours changes it.
  historyBtn.onclick = () => {
    historyPanel.hidden = !historyPanel.hidden;
    historyBtn.textContent = historyPanel.hidden ? "history" : "hide history";
    if (!historyPanel.hidden) loadHistory(name);
  };
  historyPanel.hidden = true;
  historyBtn.textContent = "history";
  say(pendingMsg);
  pendingMsg = "";
  // Hidden until the server proves it has the kit — see hasDocKit(). The
  // shell outlives a board switch, so setting these late is safe.
  undoBtn.hidden = historyBtn.hidden = true;
  void hasDocKit(name).then((ok) => {
    undoBtn.hidden = historyBtn.hidden = !ok;
  });

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
  undoBtn = el("button", { id: "undo", title: "revert your last write" }, "undo");
  historyBtn = el("button", { id: "history-toggle" }, "history");
  historyPanel = el("ul", { id: "history", hidden: "" });
  boardMsg = el("p", { id: "board-msg" });
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

  // The nested route. route() is the reactive half of the router: a signal of
  // params, null when unmatched. It lives INSIDE this layout, so it is torn
  // down with it — and because `/board/:id/*` is a wildcard, moving between
  // cards (or boards) updates this signal without rebuilding anything above.
  const cardRoute = route<{ id: string; cid: string }>("/board/:id/card/:cid");
  const detail = el("section", { id: "card-detail", hidden: "" });
  let disposeCard: Dispose | null = null;
  effect(() => {
    const p = cardRoute.get();
    // Each detail owns a scope: the lens reads below are subscriptions, and
    // switching cards must release the previous one, not stack another.
    disposeCard?.();
    disposeCard = null;
    detail.replaceChildren();
    detail.hidden = !p;
    if (!p) return;
    const doc = boardDoc;
    if (!doc) return;
    pushDisposeScope();
    detail.append(...cardDetail(doc, p.cid, p.id));
    disposeCard = popDisposeScope();
  });
  trackDispose(() => { disposeCard?.(); disposeCard = null; });

  const frag = document.createDocumentFragment();
  frag.append(
    el("div", { id: "board-header" }, boardBack, boardName, undoBtn, historyBtn),
    who,
    boardMsg,
    cardForm,
    log,
    detail,
    historyPanel,
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

/**
 * One card, with room for what the row can only abbreviate: the text as an
 * editable field, and the full provenance the stamps carry. Built fresh per
 * card id by the nested route, under its own dispose scope.
 */
function cardDetail(doc: DocHandle<Board>, cid: string, boardId: string): Node[] {
  const card = doc.at<Card>(`/cards/${cid}`);
  const members = doc.at<Record<string, Member>>("/members");
  // NARROW ONCE, OUTSIDE the effects that read them. `at()` inside an effect
  // body mints a fresh lens on every run — the runtime shares the underlying
  // subscription per path (signal.ts), so it is no longer the hang it was in
  // 0.10.2, but it still allocates per run for nothing. Hoisting is the shape
  // to copy.
  const textL = card.at<string>("/text");
  const createdByL = card.at<number | null>("/created_by");
  const updatedByL = card.at<number | null>("/updated_by");
  const updatedAtL = card.at<string | null>("/updated_at");

  const input = el("input", { id: "detail-text", "aria-label": "card text" }) as HTMLInputElement;
  effect(() => {
    const v = textL.get() ?? "";
    // The same rule the board title learned: never rewrite what someone is
    // typing in. A remote edit lands here too.
    if (document.activeElement !== input) input.value = v;
  });
  input.onblur = () => {
    const v = input.value.trim();
    if (v && v !== card.peek()?.text) textL.set(v);
  };
  input.onkeydown = (e) => { if (e.key === "Enter") input.blur(); };

  const provenance = el("p", { id: "detail-by", class: "byline" });
  effect(() => {
    const roster = members.get();
    const author = stampName(createdByL.get(), roster);
    const editor = stampName(updatedByL.get(), roster);
    const at = updatedAtL.get();
    provenance.textContent = [
      author ? `added by ${author}` : "",
      at ? (editor ? `last touched by ${editor}, ${ago(at)}` : `last touched ${ago(at)}`) : "",
    ].filter(Boolean).join(" · ");
  });

  const close = el("button", { id: "detail-close" }, "✕");
  close.onclick = () => navigate(`/board/${boardId}`);

  // A card removed under us — by anyone — leaves nothing to detail.
  //
  // `null` means TWO things through a lens, and this guard has to tell them
  // apart: "the doc has not opened yet" (every path reads null) and "this row
  // is gone". Ask the DOC, not the lens — `doc.peek() != null` means a
  // snapshot has landed, so a null row is a real absence. Without it a deep
  // link to a card closes itself a beat before its own snapshot arrives, and
  // the board-level version of this trick (`doc.v === 0`, in openBoard) reads
  // as board-specific when the rule is general.
  effect(() => {
    if (card.get() == null && doc.peek() != null) {
      queueMicrotask(() => navigate(`/board/${boardId}`));
    }
  });

  return [el("div", { id: "detail-head" }, el("h3", {}, "card"), close), input, provenance];
}

/**
 * `/settings` — your account. The demo's second real screen, and the one
 * that shows why a route handler may return `Promise<() => Node>` and never
 * a bare `Promise<Node>`.
 *
 * Asking the browser whether this device can MAKE a passkey is genuinely
 * async, and it has to happen before there is anything to render. A dispose
 * scope cannot survive an `await` — browser JS has no AsyncContext — so the
 * router brackets the THUNK, not the work before it. Everything reactive
 * goes inside the returned function; that is what gets an owner and is torn
 * down on navigation.
 */
async function settingsView(): Promise<() => Node> {
  const platform = supported
    ? await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.()
        .catch(() => false) ?? false
    : false;

  return () => {
    addPasskeyBtn = el("button", { id: "add-passkey" },
      "add a passkey — sign in without a password next time");
    addPasskeyBtn.hidden = !supported;
    addPasskeyBtn.onclick = addPasskey;

    const frag = document.createDocumentFragment();
    frag.append(
      el("div", { id: "board-header" },
        el("button", { id: "settings-back" }, "←"),
        el("h2", {}, "settings")),
      el("p", { class: "byline" },
        !supported ? "this browser has no WebAuthn — password sign-in only."
        : platform ? "this device can hold a passkey (fingerprint, face or PIN)."
        : "no built-in authenticator here — a security key or phone still works."),
      addPasskeyBtn,
      el("p", { id: "settings-tally", class: "byline" }),
    );
    (frag.querySelector("#settings-back") as HTMLButtonElement).onclick = () => navigate("/board/1");

    // The tally view again, on its own screen — the same live doc the board
    // list renders, proving a view is just a doc: two readers, no fetch.
    const tallyEl = frag.querySelector("#settings-tally") as HTMLElement;
    const t = tallyDoc;
    if (t) {
      effect(() => {
        const v = t.get();
        tallyEl.textContent = v ? `${v.boards} boards · ${v.cards} cards · ${v.done} done` : "";
      });
    }
    return frag;
  };
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

// Patterns are tested in DECLARATION ORDER, first match wins — so a literal
// always precedes the parameterised pattern it would otherwise fall into.
// `/settings` before `/board/:id/*` costs nothing here (they cannot collide),
// but the day you add `/board/new` it has to sit above `/board/:id/*` or the
// board layout will try to open a doc called `board:new`.
//
// `/board/:id/*` is a LAYOUT: the wildcard keeps boardView mounted while
// `/board/:id/card/:cid` routes a detail panel underneath it, and switching
// cards — or boards — never rebuilds the shell.
routes(view, {
  "/settings": () => settingsView(),
  "/board/:id/*": (_p, params$) => boardView(params$),
  "/": () => el("p", { id: "pick" }, "pick a board, or make one above."),
});

// --- your boards (authenticated mode) --------------------------------------

/** The tally view, kept so /settings can render the SAME live doc the board
 *  list does — two readers of one view, neither of them a fetch. */
let tallyDoc: DocHandle<Tally> | null = null;

function showMine(userId: number | string): void {
  const mine = remote.doc<Mine>(`mine:${userId}`);
  const boards = mine.at<Record<string, BoardRef>>("/boards") as OpSignal<Record<string, BoardRef> | null>;
  // tally:<uid> — a declared view (epsilon/pg.ts's pgView), not a doc you
  // write to: it renders like any doc, live, without a fetch.
  const tally = (tallyDoc = remote.doc<Tally>(`tally:${userId}`));
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

function afterAuth(user: { id: number | string }): void {
  authDialog.close();
  settingsLink.hidden = false;
  signoutBtn.hidden = false;
  if (mineFor === user.id) return;  // reconnect — the docs re-open themselves
  mineFor = user.id;
  showMine(user.id);
}

const settingsLink = document.getElementById("settings-link") as HTMLButtonElement;
settingsLink.onclick = () => navigate("/settings");

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
// Built by /settings now, not the shell — so it is null until you go there.
let addPasskeyBtn: HTMLButtonElement | null = null;
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
/** The in-flight conditional request, so a modal one can WAIT for its abort.
 *  `abort()` does not settle synchronously: the browser still has a pending
 *  credentials request for a turn or two, and a second one issued inside that
 *  window is rejected outright ("a request is already pending"). Awaiting the
 *  run itself — it resolves when the abort lands — is the honest handshake. */
let conditionalRun: Promise<void> = Promise.resolve();

/**
 * Abort the autofill request and give the browser a moment to release it,
 * before any modal ceremony.
 *
 * BOUNDED, and that is the whole lesson. The first version of this awaited
 * the run unconditionally — and because `offerPasskeys` awaited it too, the
 * promise awaited itself and never settled. Every click then hung on the
 * first line of the handler: no sheet, no error, a dead button. A late
 * release costs at worst one rejected request, which reports itself; an
 * unbounded await costs the feature.
 */
async function stopPasskeyAutofill(): Promise<void> {
  const run = conditionalRun;
  conditionalRun = Promise.resolve();   // this one is spoken for
  conditionalAbort?.abort();
  conditionalAbort = null;
  await Promise.race([run, new Promise<void>((r) => setTimeout(r, 250))]);
}

/** Start it, and remember the run so the abort above has something to wait
 *  on. Stops any previous run FIRST — `offerPasskeys` must never await the
 *  promise it is itself producing. Never call `offerPasskeys()` directly. */
function startPasskeyAutofill(): void {
  const previous = stopPasskeyAutofill();
  conditionalRun = previous.then(() => offerPasskeys());
}

async function offerPasskeys(): Promise<void> {
  if (!supported) return;
  try {
    if (!(await PublicKeyCredential.isConditionalMediationAvailable?.())) return;
  } catch { return; }
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
authDialog.addEventListener("close", () => { void stopPasskeyAutofill(); });

passkeyBtn.onclick = async (e) => {
  e.preventDefault();
  await stopPasskeyAutofill();
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

async function addPasskey(): Promise<void> {
  const btn = addPasskeyBtn;
  if (!btn) return;
  // Same handshake as the modal sign-in: create() collides with a pending
  // get() just as get() does. The dialog is normally closed by now, so this
  // is usually a no-op — but "usually" is what races are made of.
  await stopPasskeyAutofill();
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
    btn.textContent = "passkey added ✓";
    btn.disabled = true;
  } catch (err) {
    btn.textContent = String(err instanceof Error ? err.message : err);
  }
}

// --- boot ------------------------------------------------------------------

// (Boot lands beside routes() above — the hash must be set before the
// router reads it.)
