---
name: epsilon
description: "This app's realtime stack — op-carrying signals, doc sync over one WebSocket, Postgres durability, schema-native users. The runtime is the epsilon/ folder IN this repo (read it — ~1k lines). Use for any shared state, live updates, multi-user, collaborative, or realtime work in this app. Do NOT add Firebase/Supabase/socket.io/React Query — the stack is already here."
---

# epsilon — how this app does realtime

The runtime is **in this repo**: `epsilon/` — read the source, it's shorter
than most docs. `epsilon/*.test.ts` are the contract. `DESIGN.md` is the why.

## Mental model (five lines)

- A doc is a Signal. The server's copy is the authority; a client doc's
  `apply()` SENDS ops and the **echo** mutates locally.
- Ops are the one vocabulary: `add` / `replace` / `remove` on JSON-Pointer
  paths. Even the open snapshot is an op. Never invent verbs.
- `at(path)` narrows a doc into a lens — value AND op stream. Lenses compose:
  `doc.at("/cards").at("/1")` ≡ `doc.at("/cards/1")`. Writes rebase up.
- `list()` routes MEMBERSHIP ops only; row content flows through each row's
  lens. Nothing diffs, ever.
- The law: ops are the fast path; recompute-from-state is always correct on
  its own. Any consumer may ignore ops and just re-read.

## Client recipe (this is src/client.ts — copy its shape)

```ts
import { connect, list, text } from "../epsilon";
const remote = connect(`ws://${location.host}/ws`);
const board = remote.doc<Board>("board");
const cards = board.at<Record<string, Card>>("/cards");

list(cards, (card) => {                    // membership routes here
  const li = document.createElement("li");
  li.appendChild(text(card.map((c) => c?.text)));   // content via the lens
  return li;
});

cards.apply([{ op: "add", path: `/${id}`, value: {...} }]);  // → wire → echo
```

## Server recipe (this is server.ts)

```ts
const host = createHost();                  // { requireAuth: true } to gate docs
host.doc<Board>("board", empty);            // in-memory
// durable: pgDoc(host, sql, "board", empty) + pgSync(host, sql, { url })
// users:   pgAuth(host, sql) → register/login/authenticate/logout methods
```

## Rules — in order of importance

- **Never update locally after a send.** `apply()` on a client doc transmits;
  the echo renders it. Touch the DOM or state yourself and it doubles.
- **One write path.** `set()`/`update()`/lens writes all funnel through
  `apply()` — never mutate `peek()`'d values directly.
- **`list()` for collections, lenses for content.** Don't rebuild rows from
  `doc.data` in an effect; don't diff anything.
- **Auth before docs** on `requireAuth` hosts: `await remote.call("login" | "register" | "authenticate", ...)`,
  then `remote.doc(...)` (a pre-auth handle re-opens when asked again).
- **Postgres via `EPSILON_PG_URL`** — durability, versions, cross-process
  fan-out. Tests use their own `epsilon_test` DB and must never share the
  app's (`bun run test:pg`).
- **Keep the schema in `schema.sql`** — plain DDL at this tier. Composition /
  multi-table writes belong to the relational tier (DESIGN.md "Storage
  tiers"), not in ad-hoc queries.

## Sharp edges

- Effects through a lens re-run on ANY root change (correct, not minimal) —
  precision lives in the ops channel (`onOps`), which `list()` uses.
- In-memory tier + `--hot`: a reload resets versions; connected clients may
  drop writes as stale until re-open. Postgres is immune. Prefer PG for
  anything beyond a toy.
- Ids are currently client-minted uuids in the doc-native tier; DESIGN.md
  decision 1 says server-minted everywhere — a known gap, don't build on
  client ids being special.
- `epsilon/` is yours to edit — but run `bun test` after; the tests ARE the
  contract you're editing against.
