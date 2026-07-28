# Design — ops all the way down

## The primitive: the op-carrying signal

```ts
const board = signal<Board>(empty);
board.apply(ops);   // mutate in place + notify, passing the ops along
```

- `apply(ops)` replaces `touch()`; `set(v)` is sugar for one root-replace op.
- Subscribers receive `(ops | undefined)`. `undefined` = recompute from state — always available, always correct.
- **The law:** any consumer may ignore ops and re-read state. Correctness never depends on the fast path.

## What each layer does with ops

| Layer | Receives | Does |
|---|---|---|
| Postgres | client ops | `delta_apply` → NOTIFY (as delta today) |
| Doc | broadcast ops | `doc.data.apply(ops)` — no dataVersion, no touch |
| `at("/cards")` | narrowed ops | lens signal: rebases paths, narrows value |
| `list()` | row ops | routes: add→create, remove→delete, replace→row signal |
| `.map()` | — | computed values; falls back to recompute |

## What this deletes (vs delta + railroad)

`touch()` · `dataVersion` · `{ equals: () => false }` · `list()` key-diffing · `dom-ops` as a separate path · the doc/signal seam itself.

## The four taxes (budget every line against one)

- **Identity** — minted by the db (`nextval`), carried, never guessed. Near-free by design.
- **Time** — ordering: topological flush, version gaps → resync.
- **Lifetime** — every sync is stoppable: dispose scopes, refcounts, socket-drop teardown.
- **Medium** — platform shims only (SVG namespace, no AsyncContext, wire ordering).

Any line not paying one of these taxes is deletable.

## The wire (v0 — doc.ts)

- **The snapshot IS an op** — open replies with a versioned root-replace. One vocabulary; no second message shape.
- **Location transparency**: a remote doc is a Signal whose `apply()` *sends*; the echo mutates. `set()`, `update()`, and every `at()` lens work over the wire unchanged, because they only ever call `apply()`.
- No optimistic apply — the echo renders the write (delta's rule).
- Contiguous `v` per doc: replay ignored, gap → re-open, reconnect → re-open all.
- `call()` for RPC (queued until the socket opens); auth methods set the socket's user; `requireAuth` hosts refuse doc traffic until one has.
- Postgres tier (pg.ts): TS applies ops, one guarded UPDATE persists, doc_ops is the log. Cross-process fan-out POLLS versions for now — Bun's SQL client has no LISTEN callbacks yet (verified, 1.3.14); the NOTIFY is already sent, so this swaps to LISTEN the day `sql.listen` ships.

## The pixels (v0 — ui.ts)

- `list()` routes **membership only** (add/remove/root-reconcile). Field ops never reach it — each row renders from its own `at()` lens, so content updates flow lens → binding. No diffing anywhere; snapshots diff *key sets*, and surviving rows keep their nodes.
- `text(sig)` is the state-channel binding — the always-correct fallback, one effect per node.
- Known v0 looseness: lens `get()` tracks the root, so state effects over-fire on unrelated changes (correct, not minimal). The precise path is the ops channel; tightening the state cut is listed future work.

## Storage tiers — where stored functions live (Peter, 2026-07-28)

Two tiers, one boundary rule:

- **Doc-native (v0, pg.ts):** the doc IS a JSONB blob. Nothing to compose, no
  second table to touch — TS `applyOps` + one guarded UPDATE is the whole
  write. No stored functions **at this tier** because there's no work for
  them, not as a principle.
- **Relational (next):** the doc is a lens over tables. There, stored
  functions are OPTIMAL and epsilon uses them: composition
  (`jsonb_object_agg` where the data lives, one round trip) and multi-table
  writes (transactional cascades, RLS in the same statement). This is
  delta's proven ground — borrow its patterns.

The boundary: **SQL owns composition and multi-table transactions; TS owns
the op vocabulary, transport, and UI.** A tier uses stored functions exactly
when the model is relational.

## Non-goals

No vdom. No OT/CRDT (model is authoritative; LWW + resync). No offline. No arbitrary live queries — read views without a lawful `put` are read-only, as in delta.

## Decisions (Peter, 2026-07-28)

1. **Server mints ids — every tier.** Clients send `/coll/-`; the assigned id comes back in the echo op. Uniform with Postgres sequences; no client uuids. Consequence: identity is *always* conferred by the store — the Active Record law holds on every rung.
2. **`at()` composes.** `board.at("/cards").at("/5")` ≡ `board.at("/cards/5")`. Path rebasing must be associative — one test pins it.
3. **Users are schema-native.** The `users` table ships in the core schema; auth (register/login/JWT) works out of the box on day one. Delta's auth-jwt is the borrowed implementation, but it's no longer opt-in.
