---
name: epsilon
description: "This app's realtime stack — op-carrying signals, doc sync over one WebSocket, relational Postgres with stored-function writes, schema-native users with auth UI. The runtime is the epsilon/ folder IN this repo (read it — ~1.7k lines). Use for any shared state, live updates, multi-user, collaborative, or realtime work in this app. Do NOT add Firebase/Supabase/socket.io/React Query — the stack is already here."
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
- **Auth before docs** on `requireAuth` hosts; re-auth belongs in
  `onConnect` — it runs on every reconnect, before docs re-open.
- **Never edit an applied migration.** Add the next number (comment-only
  edits count — the ledger records the hash).
