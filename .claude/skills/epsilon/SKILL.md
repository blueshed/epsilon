---
name: epsilon
description: "This app's realtime stack — op-carrying signals, doc sync over one WebSocket, relational Postgres with stored-function writes, schema-native users with auth UI. The runtime is the epsilon/ folder IN this repo (read it — ~3.8k lines). Use for any shared state, live updates, multi-user, collaborative, or realtime work in this app. Do NOT add Firebase/Supabase/socket.io/React Query — the stack is already here."
---

# epsilon — how this app does realtime

The runtime is **in this repo**: `epsilon/` — read the source, it's shorter
than most docs. `epsilon/*.test.ts` are the contract; `DESIGN.md` is the
why. **`REFERENCE.md` (next to this file) is the deep manual — read it
BEFORE authoring a doc type, wiring auth/sharing/undo, choosing an engine,
or debugging the wire.** Routes follow the bun-route convention: root
route = `index.html` + `index.css` + `index.ts` at project root;
`server.ts` exports `startServer(opts)` so tests bind port 0; `app.test.ts`
drives the real app in `Bun.WebView`.

## Mental model (six lines)

- A doc is a Signal. The server's copy is the authority; a client doc's
  `apply()` SENDS ops and the **echo** mutates locally.
- Ops are the one vocabulary: `add` / `replace` / `remove` on JSON-Pointer
  paths. Even the open snapshot is an op. Never invent verbs.
- **The server mints ids.** Send `add /coll/-`; the echo carries the real id
  (uuid in-memory, Postgres sequence relational). Never invent ids client-side.
- `at(path)` narrows a doc into a lens — value AND op stream; lenses compose
  and writes rebase up. `list()` routes MEMBERSHIP ops; row content flows
  through each row's lens. Nothing diffs, ever.
- **Express the change, never recompose.** Writes are O(change) — op log +
  version bump. Composition happens at open (`doc_open`), not per write.
- The law: ops are the fast path; recompute-from-state is always correct on
  its own.

## Client (index.ts is the reference)

```ts
const remote = connect(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`, {
  onConnect: (r) => reauth(r),   // EVERY (re)connect, awaited FIRST — before queued calls and re-opens
  onDisconnect: (willRetry) => setLive(false),  // every close; false only for remote.close()
  onError,                       // "unauthenticated" → show auth dialog
});
const board = remote.doc<Board>("board:1");
await board.ready;               // REJECTS if the open is refused (also reported via onError)
const cards = board.at<Record<string, Card>>("/cards");
list(cards, (card) => { ...bind(card.at<string>("/text"), (t) => { el.textContent = t ?? ""; })... });
cards.apply([{ op: "add", path: "/-", value: { text } }]);         // server mints; echo renders
await remote.call("login" | "register" | "authenticate", params);  // then re-ask: remote.doc("board:1")
await remote.call("undo", { doc: "board:2" });                     // YOUR last write, reverted ({ v } for a specific one)
await remote.call("history", { doc: "board:2", before, after });   // the op log back: newest first, named, paged by v
```

`bind(lens, set)` is the precise scalar path — set() re-runs only when an
op touches that slice, never on a sibling's keystroke. `text(sig)`/`effect`
are the state-channel fallback (always correct; the only choice for
`map()`ed values, which carry no ops).

**Need the id back? `write()`, not `apply()`** (0.8.1). `apply()` returns
void — that is what makes one call work on a signal, a lens and a remote
doc alike. When you need the id the server just minted, or the refusal in
a `catch`, use the handle's `write()`:

```ts
const [minted] = await board.write([{ op: "add", path: "/cards/-", value: { text } }]);
select(minted.path.split("/").pop()!);        // the real id, first try
```

Handle-only — a lens delegates `apply()` to its root and cannot answer.
**Never watch the echo and match your new row by VALUE**: two people adding
"Kyoto" in the same second pick each other's.

**Screens, not one page** (0.8.0). `routes(target, table)` is the hash
router; `route(pattern)` is a `Signal<params | null>`; `navigate(path)`
moves. Never navigate with `location.href` or `location.reload()` — that
reloads a WebSocket app, re-authenticating and re-opening every doc.
Params change WITHIN a pattern without re-running the handler
(`/trips/1` → `/trips/2` updates `params$`), so open the doc once and let
the lens follow the param.

```ts
mount(document.getElementById("app")!, () =>            // the app root's scope
  when(signedIn, () => shell(), () => loginForm()));    // swaps on truthiness only
routes(main, { "/": () => tripList(), "/trips/:id": (p, p$) => trip(p$) });
```

`mount()` is what a top-level `bind`/`list`/`when` warns for the want of.
`when()` swaps only when truthiness FLIPS — inside a branch, react with a
lens, not by rebuilding.

**SVG:** build nodes with `document.createElementNS("http://www.w3.org/
2000/svg", tag)`. `createElement("circle")` in an SVG parent is an HTML
element that never paints; `list`/`when`/`mount` warn, and deliberately do
not rewrite it — that would mean recreating the node and dropping your
listeners.

A doc signal KEEPS its last value while the socket is down (the reconnect's
snapshot resets it), so render live-ness from `onDisconnect`, never from the
doc — a presence list left alone stays green and lies.

## Engines (decision table in README "Choosing an engine")

Nothing set = in-memory, a shape PREVIEW (uuid ids, no permits — keep
identity-dependent UI behind auth). `EPSILON_PG_DIR=./data` = embedded
Postgres, the default for a real single-service app. `EPSILON_PG_URL` =
wire Postgres for multiple processes. Same schema; switching is config.

## The CLI — work the live app while it runs

`bun epsilon/cli.ts open|add|set|rm|watch|call … --url ws://…` — the
browser's own client behind argv, auth-aware, JSON out; every mutation
prints the RESOLVED echo the server broadcast. While `bun dev` runs, USE
IT to verify realtime behavior end-to-end. Full commands: REFERENCE.md.

On the EMBEDDED engine the database has no port, so the CLI is also the only
way in: `call admin '{"sql":"…"}'` (gated by `EPSILON_ADMIN` — unset means
the method doesn't exist). Admin writes bypass the op log: fine for
users/sessions, reload-worthy for doc tables.

## Rules — in order of importance

- **About to render data? You're about to open a doc.** `call()` is for
  VERBS (login, undo). If no doc exposes what you're rendering, add a VIEW
  (`pgView` — one SQL function, declared dependencies; REFERENCE.md) —
  NEVER a fetch-shaped call: it renders once, goes dead, and escapes the
  permit lifetime. A view reads like any doc: `remote.doc("tally:" + uid)`.
- **Never update locally after a send.** The echo renders the write — touch
  the DOM or state yourself and it doubles.
- **Never mint ids client-side.** `/-` in, resolved id out.
- **A write never recomposes the doc.** Bump v, log ops, notify — `doc_ops`
  carries the payload and doubles as the audit trail AND the undo log.
- **Express EVERY change — cascades included.** An FK cascade the op log
  never saw leaves orphans on every screen and a hole undo can't restore
  (`doc_cascade_remove`, see REFERENCE.md). Same rule for extra COLUMNS: if
  a dispatch also stamps `updated_by`/`updated_at`, the echo must widen from
  the scalar path to the whole row, or a recompute won't match what clients
  hold.
- **`list()` for collections, `bind()` for scalars, lenses for content.**
  No effects that rebuild rows from `doc.data`.
- **Close what you leave.** `remote.doc()` handles are refcounted — call
  `.close()` when a view is done with a doc. Writes through a closed
  handle throw.
- **Pin every new doc type with `proveLaw()`** (`epsilon/law.ts`) — one
  batch per dispatch branch, driven over the real wire, checked against
  recompute after every echo (undo and mirrors too). The failure names the
  defect class. rel.test.ts's law describe is the worked call.
- **Auth before docs** on `requireAuth` hosts; re-auth belongs in
  `onConnect` — it runs on every reconnect, before docs re-open.
- **Never edit an applied migration.** Add the next number (comment-only
  edits count — the ledger records the hash).
