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
- Lifetime: `remote.doc()` handles are refcounted; the last `close()` unsubscribes and stops re-opens. The host counts watchers per socket and evicts an unwatched DYNAMIC doc — its factory re-hosts (and recomposes) on the next open. Static docs live for the process.
- Postgres tier (pg.ts): TS applies ops, one guarded UPDATE persists, doc_ops is the log. Cross-process fan-out is real push — LISTEN/NOTIFY via the optional `pg` peer (a dedicated connection with reconnect + catch-up), because Bun's SQL client has no LISTEN callbacks yet (verified, 1.3.14). Decision (Peter, 2026-07-28): carry `pg` for this one job and RETIRE it the day `sql.listen` ships — the seam and tests don't change. Without `pg` installed, `pgSync` degrades to polling.

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

## Delivered (Peter-driven, 2026-07-28 evening)

1. **Server mints ids — every tier.** Clients send `add /coll/-`; the host
   assigns a uuid (doc-native) or the Postgres sequence assigns (relational);
   the echo carries the resolved path. Arrays keep native `-` append.
2. **Auth UI in the template.** `requireAuth` turns on with Postgres; the
   dialog drives register/login/authenticate; tokens restore sessions.
3. **Relational tier v1** (`board.sql` is the pattern): tables are the truth;
   `<doc>_apply(name, ops, user)` applies + mints + logs + notifies in ONE
   transaction (`FOR UPDATE` serializes writers — no lost updates);
   `<doc>_open(name)` composes at OPEN time only.

Two laws that fell out of Peter's review of the first cut:

- **Express the change, never recompose.** Writes are O(change): op log +
  version bump. Composition is an open-time cost (`doc_open` indirection —
  one read path for both tiers). A write must never rebuild the doc.
- **NOTIFY is a doorbell, not a payload.** `{name, v}` (~40 bytes — the 8k
  limit is unreachable); listeners fetch ops from `doc_ops`, which is the
  event log AND the audit trail (`by_user`, `at`).

## The doc kit (007) — SQL reuse where it's core

The first relational doc types were hand-rolled skeletons: every `_apply`
re-wrote the same lock prologue, path splitting, echo building, and
bump-log-notify tail. The kit extracts THAT — nine small functions — and
leaves the dispatch loop yours:

- `doc_begin(doc, permit)` — lock + exist + permit; absence and refusal
  raise indistinguishably (`unknown doc` / `not found`). NULL permit reads
  as refused, so `board_may(...)` passes raw.
- `doc_commit(doc, ops, user)` — bump v, log, doorbell; returns `{v, ops}`
  or NULL when the doc row doesn't exist — which makes it the multi-doc
  MIRROR primitive too (a mirror into a never-seeded doc no-ops).
- `doc_lock` (tolerant, for mirror pre-locks — canonical order per 005),
  `doc_drop` (registry row + log die together), `doc_id`, `doc_path`, and
  `op_add`/`op_replace`/`op_remove` — the wire's three verbs, in SQL.

A doc type is now ~30 lines of app SQL: one composition query + one
dispatch function. 008 is board/mine rebuilt on it (behavior-identical,
paths now match exactly); rel.test.ts's `todo` type is the minimal worked
example, driven over the real wire.

## Db-first, properly (Peter's challenge, 2026-07-28 night)

The first cut wasn't db-first enough. Three gaps, closed:

- **Migrations.** `db/NNN-*.sql`, applied in order by `migrate(sql)`, recorded
  by name AND content hash in a `migrations` table. **Forward-only**: editing
  an applied file is refused — write the next number. One transaction per
  file (file + ledger row commit together), advisory-locked so concurrent
  boots can't double-apply. Files are yours, git-tracked, nothing hidden in
  a package. `bun run test:migrate` pins all of it.
- **Auth is a SQL contract** (`db/002-auth.sql`): `register` / `login` /
  `session_start` / `session_get` / `session_end`, hashing with pgcrypto
  bcrypt (cost 12) where the data lives, uniform timing on unknown emails.
  `pgAuth` is now only a wire adapter — override the functions in a later
  migration and the runtime doesn't change.
- **Users own things.** `boards.owner_id`, `cards.created_by`, and
  `board_may(board, user)` enforced INSIDE `board_open` (returns NULL) and
  `board_apply` (RAISEs "not found" — no existence oracle). `owner_id NULL`
  = shared, which is how the demo board stays open.

Known limit: the hosted server copy of a doc is shared, so per-identity doc
scoping applies at the WRITE boundary and at direct `doc_open(doc, user)`
reads. Per-subscriber composed docs (delta's recompute pattern) are future
work.

Bun quirks found the hard way (all pinned by tests):
`expect(p).rejects.toThrow()` never settles against a Bun SQL rejection —
use try/catch. A multi-statement `unsafe()` inside `conn.begin()` leaks
failures as unhandled rejections — use explicit BEGIN/COMMIT on a reserved
connection. `pg_advisory_lock` is session-scoped, so the whole migration run
must hold ONE reserved connection.

## The vision, closed (2026-07-28, late)

- **Docs are dynamic.** `host.docs(prefix, factory)` — names are data,
  hosted on first open, concurrent opens coalesce.
- **Per-identity docs.** `mine:<uid>` composes as its owner (`openAs`) and
  is guarded on the wire (`guard`): strangers get "unknown doc" — no
  existence oracle. Enforced again inside the stored functions.
- **Creating a doc is an op.** `add /boards/-` on your mine doc creates an
  owned board AND its doc row in one transaction; the echo carries the
  sequence id; the client opens `board:<id>` like any other name.
- **Multi-doc transactional writes.** A board rename mirrors into the
  owner's mine doc — two docs, one transaction, both versioned, logged,
  and notified. Delivery is the ordinary fan-out (pgSync).
- **Delete cascades.** Cards via FK; the doc row and its log explicitly.

## Sharing (009) — members, mirrored

- `board_members` + `board_may`: public, owner, or member — one predicate,
  both directions, asked again on every open (guards may be async: the
  membership check is one SQL call).
- Share BY EMAIL: `add /members/-` on the board (owner only); the echo
  carries the resolved member row and the member's mine doc gains the board
  in the SAME transaction. `remove /members/<uid>`: the owner removes
  anyone; a member removes themselves. On your own list, `remove
  /boards/<id>` DELETES what you own and LEAVES what you don't.
- Lock order, generalized from 005: ALL mine docs in ascending uid order,
  THEN board docs in ascending id order. Both apply functions pre-scan the
  batch and take every lock up front; mirrors only ever target pre-locked
  docs. A membership change racing the pre-scan can only SKIP a mirror —
  never lock out of order — and recompute-from-state heals the stale entry
  at the next open.
- Known limit: revocation bites at the write boundary and the next open; an
  already-subscribed socket keeps receiving broadcasts until it closes the
  doc (the per-subscriber limit above).

## Presence — being there is watching a doc

`presence:board:<id>` is an ordinary in-memory doc keyed by socket: the
host's `onSubscribe`/`onUnsubscribe` hooks (a socket's first successful
open; its release or death) write watchers in and out, and the doc evicts
with its last watcher. Hooks fire AFTER the snapshot send, so a new
subscriber sees itself appear as a contiguous op. Ephemeral and
PER-PROCESS by design — nothing persists, nothing fans out across
processes.

## Open items

- Doc GC covers the unwatched case; a deleted doc that still has watchers
  lingers until they leave (no "doc deleted" push yet).
- Prune cadence: `epsilon_prune(keep)` (006) runs at boot only — long-lived
  deployments should cron it.

## Non-goals

No vdom. No OT/CRDT (model is authoritative; LWW + resync). No offline. No arbitrary live queries — read views without a lawful `put` are read-only, as in delta.

## Decisions (Peter, 2026-07-28)

0. **No separate library.** `bun create blueshed/epsilon` scaffolds the app
   WITH the runtime vendored in (`epsilon/`, tests included). No npm package,
   no version skew, no install — the stack is source you own, small enough to
   read. (This is delta's "vendor-first" philosophy applied to everything,
   and the correction of an inversion: the library hosting the app was
   upside down; the app hosts the runtime.)

1. **Server mints ids — every tier.** Clients send `/coll/-`; the assigned id comes back in the echo op. Uniform with Postgres sequences; no client uuids. Consequence: identity is *always* conferred by the store — the Active Record law holds on every rung.
2. **`at()` composes.** `board.at("/cards").at("/5")` ≡ `board.at("/cards/5")`. Path rebasing must be associative — one test pins it.
3. **Users are schema-native.** The `users` table ships in the core schema; auth (register/login/JWT) works out of the box on day one. Delta's auth-jwt is the borrowed implementation, but it's no longer opt-in.
