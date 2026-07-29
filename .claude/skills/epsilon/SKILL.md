---
name: epsilon
description: "This app's realtime stack — op-carrying signals, doc sync over one WebSocket, relational Postgres with stored-function writes, schema-native users with auth UI. The runtime is the epsilon/ folder IN this repo (read it — ~1.7k lines). Use for any shared state, live updates, multi-user, collaborative, or realtime work in this app. Do NOT add Firebase/Supabase/socket.io/React Query — the stack is already here."
---

# epsilon — how this app does realtime

The runtime is **in this repo**: `epsilon/` — read the source, it's shorter
than most docs. `epsilon/*.test.ts` are the contract. `DESIGN.md` is the why.
Routes follow the bun-route convention: root route = `index.html` +
`index.css` + `index.ts` at project root; `server.ts` exports
`startServer(opts)` so tests bind port 0; `app.test.ts` drives the real app
in `Bun.WebView`.

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
  onConnect: (r) => reauth(r),   // EVERY (re)connect, awaited BEFORE docs re-open — re-auth here
  onError,                       // "unauthenticated" → show auth dialog
});
const board = remote.doc<Board>("board:1");
await board.ready;               // REJECTS if the open is refused (also reported via onError)
const cards = board.at<Record<string, Card>>("/cards");
list(cards, (card) => { ...text(card.map(c => c?.text))... });
cards.apply([{ op: "add", path: "/-", value: { text } }]);         // server mints; echo renders
await remote.call("login" | "register" | "authenticate", params);  // then re-ask: remote.doc("board:1")
```

## Schema — migrations, always

`db/NNN-name.sql`, applied in order by `migrate(sql)` at boot, recorded by
name + content hash. **Forward-only: never edit an applied file** — the
runner refuses it; write the next number. One transaction per file. Add a
table? New migration. Change a stored function? New migration with
`CREATE OR REPLACE`.

## Auth — a SQL contract, not TypeScript

`db/002-auth.sql` owns `register` / `login` / `session_start` /
`session_get` / `session_end` (pgcrypto bcrypt, cost 12). `pgAuth` is only
the wire adapter. To change auth policy, write a migration that replaces the
function — no runtime change.

## Ownership — users mean something

`board_may(board, user)` gates BOTH `board_open` (NULL for outsiders) and
`board_apply` (RAISE "not found" — never confirm a doc exists). Follow that
shape for every doc type: one predicate, both directions, checked inside the
stored function with the identity the socket authenticated.

## Server — two tiers, one wire

- **In-memory** (default): `host.doc(name, empty)` — host mints uuids, open
  access, state dies with the process.
- **Relational** (set `EPSILON_PG_URL`): `db/008-board-on-kit.sql` is the
  pattern (built on the 007 doc kit) — YOUR
  tables are the truth; `board_apply(name, ops, user)` applies + mints from
  sequences + logs + notifies in ONE transaction (`FOR UPDATE` serializes
  writers); `board_open(name)` composes the doc at open only. Glue:
  `pgDoc(host, sql, "board:1", null, { apply: "board_apply" })`. Auth comes
  on with it: `createHost({ requireAuth: true })` + `pgAuth(host, sql)`.
- To add a doc type, use the DOC KIT (`db/007-doc-kit.sql`): a table,
  `<x>_open` (ONE composition query), and `<x>_apply` =
  `doc_begin(p_doc, <permit>)` → your dispatch loop (`doc_path(v_op)` to
  match, DML, `v_out := v_out || op_add/op_replace/op_remove(...)`) →
  `RETURN doc_commit(p_doc, v_out, p_user)`. The kit owns locks, refusals
  (no existence oracle), versioning, audit, NOTIFY; `doc_drop` deletes a
  doc whole, `doc_commit` on ANOTHER doc is the multi-doc mirror. Copy
  `008-board-on-kit.sql` (worked example) or rel.test.ts's `todo` type
  (minimal). Then seed the `docs` row with `open_fn` and add one `pgDoc`
  line behind a gated factory.
- Dynamic docs: `host.docs(prefix, (name, userId) => ...)` — the factory sees
  the asking user; throw `unknown doc` BEFORE hosting/seeding so probes cost
  nothing (see server.ts's `mine:` factory).

## Rules — in order of importance

- **Never update locally after a send.** The echo renders the write — touch
  the DOM or state yourself and it doubles.
- **Never mint ids client-side.** `/-` in, resolved id out.
- **A write never recomposes the doc.** If your stored function rebuilds
  `docs.data`, it's wrong — bump v, log ops, notify (a ~40-byte doorbell;
  `doc_ops` carries the payload and doubles as the audit trail — `by_user`
  is threaded from the socket's authenticated user).
- **`list()` for collections, lenses for content.** No effects that rebuild
  rows from `doc.data`.
- **Auth before docs** on `requireAuth` hosts; store the session token; a
  refused doc handle re-opens when asked again. Re-auth belongs in
  `onConnect` — it runs on every reconnect, before docs re-open.
- **Each test file owns its OWN database** (`epsilon_test_pg`, `_rel`,
  `_app`, `epsilon_migrate_test`) — they TRUNCATE, and sharing one deadlocks
  against the migration advisory lock.
- **Never edit an applied migration.** Add the next number.

## Sharp edges

- `--hot` re-evaluates server.ts top level: boot ONCE via the `globalThis`
  guard (see server.ts) or every reload leaks a Postgres pool and resets doc
  versions under live clients.
- Bun SQL binds objects/arrays RAW into jsonb — `JSON.stringify(...)::jsonb`
  double-encodes into a scalar and `jsonb_array_elements` explodes.
- Effects through a lens re-run on ANY root change (correct, not minimal) —
  precision lives in the ops channel, which `list()` uses.
- `expect(p).rejects.toThrow()` NEVER settles against a Bun SQL rejection —
  use try/catch and assert on the message (verified, Bun 1.3.14).
- A multi-statement `unsafe()` inside `conn.begin()` leaks failures as
  unhandled rejections — use explicit BEGIN/COMMIT on a reserved connection
  (see `migrate.ts`).
- `epsilon/` is yours to edit — run `bun test` after; the tests ARE the
  contract you're editing against.
