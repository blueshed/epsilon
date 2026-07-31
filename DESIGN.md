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
| Postgres | client ops | `<t>_apply` → echo + doorbell NOTIFY |
| Doc | broadcast ops | `doc.apply(ops)` — no dataVersion, no touch |
| `at("/cards")` | narrowed ops | lens signal: rebases paths, narrows value |
| `list()` | row ops | routes: add→create, remove→delete; content flows per-row |
| `bind()` | slice ops | one setter, run only when its slice is touched |
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
- `call()` for RPC (queued until the socket opens); auth methods set the socket's user; `requireAuth` hosts refuse doc traffic until one has. **The connect hook goes first on every open** (2026-07-31): queued calls used to flush ahead of it, so a call issued in the same tick as `connect()` — which is every call a one-shot CLI makes — overtook its own `authenticate` and landed on a session-less socket. The hook's own calls don't queue; the socket is open by the time it runs.
- `onDisconnect(willRetry)` is the symmetric half of `onConnect`, fired on every close (false only for a deliberate `remote.close()`). Doc signals KEEP their last value across a drop — the reconnect's snapshot is what resets them — so anything rendered as live (presence, a connection dot) must hear the drop from this hook or it goes on testifying to a state nobody is in.
- Lifetime: `remote.doc()` handles are refcounted; the last `close()` unsubscribes and stops re-opens. The host counts watchers per socket and evicts an unwatched DYNAMIC doc — its factory re-hosts (and recomposes) on the next open. Static docs live for the process.
- Postgres tier (pg.ts): TS applies ops, one guarded UPDATE persists, doc_ops is the log. Cross-process fan-out is real push — LISTEN/NOTIFY via the optional `pg` peer (a dedicated connection with reconnect + catch-up), because Bun's SQL client has no LISTEN callbacks yet (verified, 1.3.14). Decision (Peter, 2026-07-28): carry `pg` for this one job and RETIRE it the day `sql.listen` ships — the seam and tests don't change. Without `pg` installed, `pgSync` degrades to polling.

## The pixels (v0 — ui.ts)

- `list()` routes **membership only** (add/remove/root-reconcile). Field ops never reach it — each row renders from its own `at()` lens, so content updates flow lens → binding. No diffing anywhere; snapshots diff *key sets*, and surviving rows keep their nodes.
- `bind(lens, set)` is the **precise scalar path** (2026-07-29, from the field report's §4): set() runs only when an op touches the lens's slice — sibling writes never reach it; ancestor replaces and snapshots fall through like `list()`'s reconcile. O(change) for field content.
- `text(sig)` is the state-channel binding — the always-correct fallback, one effect per node, and the only choice for computed/`map()` values (they carry no ops).
- Known v0 looseness: lens `get()` tracks the root, so state *effects* over-fire on unrelated changes (correct, not minimal) — reach for `bind` where that matters.

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

Two ENGINES, one schema (2026-07-29): the relational tier also runs on
EMBEDDED Postgres — PGlite (WASM, in-process) behind the same `Sql` seam
(`epsilon/pglite.ts`). Every migration, the doc kit, and the auth contract
run unchanged; `EPSILON_PG_DIR` selects it. The deal: ONE app process owns
the directory — no horizontal scaling. It still runs pgSync, in POLL mode
(2026-07-31, a japan field lesson): sync was skipped here on the reasoning
that there are no sibling processes to hear from, which is true and beside
the point. Sync is the delivery path for every commit made OUTSIDE a doc's
own write hook, and the commonest of those is a MIRROR — `board_apply`
writing into `mine:<uid>` in the same transaction. The write hook re-enters
the doc it wrote; nothing re-enters the sibling, and PGlite has no doorbell
to ring. Symptom: a share landed in the tables and the member's list never
moved, refresh included — a doc another socket still watches is served the
hosted snapshot, not a fresh composition. Outgrow it → pg_dump into a wire
server, set `EPSILON_PG_URL`: scaling up is a config change because both
engines speak the same schema. Measured: WASM boot ~2–7s by machine (once, at start),
bcrypt cost 12 ~350ms — on par with native.

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

## The doc kit (db/003-doc-kit.sql) — SQL reuse where it's core

The first relational doc types were hand-rolled skeletons: every `_apply`
re-wrote the same lock prologue, path splitting, echo building, and
bump-log-notify tail. The kit extracts THAT — a baker's dozen of small
functions — and leaves the dispatch loop yours:

- `doc_begin(doc, permit)` — lock + exist + permit; absence and refusal
  raise indistinguishably (`unknown doc` / `not found`). NULL permit reads
  as refused, so `board_may(...)` passes raw.
- `doc_commit(doc, ops, user, undo)` — bump v, log (echo AND inverse),
  doorbell; returns `{v, ops}` or NULL when the doc row doesn't exist —
  which makes it the multi-doc MIRROR primitive too (a mirror into a
  never-seeded doc no-ops).
- `doc_undo` (+ `doc_touched_since`, `doc_restore_id`) — see "The host
  composes as itself; undo" below.
- `doc_cascade_remove` — an FK cascade, expanded into the ops it silently
  skipped.
- `doc_lock` (tolerant, for mirror pre-locks — canonical order per 005),
  `doc_drop` (registry row + log die together), `doc_id`, `doc_path`, and
  `op_add`/`op_replace`/`op_remove` — the wire's three verbs, in SQL.

A doc type is now ~30 lines of app SQL: one composition query + one
dispatch function. db/100-board.sql is board/mine built on it (behavior-identical,
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
- **Per-identity docs.** `mine:<uid>` refuses strangers on the wire — the
  same "unknown doc" a missing name gives (no existence oracle) — and again
  inside the stored functions. (Since 0.3.0 the wire gate is the composition
  function itself; see "The host composes as itself".)
- **Creating a doc is an op.** `add /boards/-` on your mine doc creates an
  owned board AND its doc row in one transaction; the echo carries the
  sequence id; the client opens `board:<id>` like any other name.
- **Multi-doc transactional writes.** A board rename mirrors into the
  owner's mine doc — two docs, one transaction, both versioned, logged,
  and notified. Delivery is the ordinary fan-out (pgSync).
- **Delete cascades.** Cards via FK; the doc row and its log explicitly.

## Sharing (db/100-board.sql) — members, mirrored

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
- Revocation bites LIVE sockets too (0.5.0): the member-remove echo expels
  the removed user from the board and its presence — see "Gone is a
  snapshot of nothing".

## Presence — being there is watching a doc

`presence:board:<id>` is an ordinary in-memory doc keyed by socket: the
host's `onSubscribe`/`onUnsubscribe` hooks (a socket's first successful
open; its release or death) write watchers in and out, and the doc evicts
with its last watcher. Hooks fire AFTER the snapshot send, so a new
subscriber sees itself appear as a contiguous op. Ephemeral and
PER-PROCESS by design — nothing persists, nothing fans out across
processes.

And exactly as private as the board it watches (2026-07-29): a factory
refusal guards only the FIRST open — the doc outlives its opener — and an
in-memory doc has no `doc_open` gate to default to, so the presence
factory fits an `open` gate that re-asks `board_may` per socket. The rule
generalizes: an in-memory doc whose factory checks a permit needs the
SAME permit in its open gate, or it fails open while occupied.

## The host composes as itself; undo (2026-07-29)

Driven by a field report — a real app (a shared journey planner, eight
users, deployed on the embedded tier) built on the template in one sitting.
Its §1 was a live security defect; all three rules below are its asks.

- **NULL user = the host.** `doc_open(name)` with no user composes the
  doc's own full copy; composition functions refuse only a NON-NULL user
  who may not see it. `openAs` is deleted — nothing about identity is
  captured at hosting time. (The old shape failed OPEN: a factory that
  computed its guard from a row read at hosting time kept serving a doc
  that was *claimed* while hosted, and gap catch-up — which composes with
  no user — blanked identity-scoped docs.)
- **The composition function IS the permit.** `pgDoc`'s wire gate defaults
  to `doc_open(name, user) IS NOT NULL`, asked fresh at EVERY open —
  ownership and membership changes bite at the next open with zero app
  code. `guard` remains only as an override; never capture mutable row
  state in one.
- **The log records what was there.** Each dispatch branch builds the
  batch's inverse (reversed; one before-read per mutating op — O(change),
  no snapshots) and `doc_commit` stores it in `doc_ops.undo`.
  `doc_undo(doc, v|NULL, user, apply)` — NULL = your latest undoable
  write — applies the inverse THROUGH the type's own apply: permit
  re-checked, mirrors re-fired, and the resulting commit records the redo.
  Concurrency REFUSES: undoing under later ops on the same paths raises
  rather than clobbering someone's edit. Depth is bounded by
  `epsilon_prune` (pruned = not undoable). `pgUndo` is the wire adapter;
  `pgReceive` re-enters any stored write made outside the write hook.
- **A type's resolved echo is legal input.** `add /coll/<id> {row}`
  restores that exact row (`OVERRIDING SYSTEM VALUE` + `doc_restore_id` so
  the sequence can't re-mint it); `replace /coll/<id> {row}` sets it whole.
  Undo, replay, and fork all hang off this one property.
- **FK cascades are invisible to the op log** — the law's blind spot: the
  children die in the tables, no op says so, clients render orphans until
  recompute. Expand the cascade with `doc_cascade_remove` BEFORE deleting
  the parent. The law is now executable: rel.test.ts asserts the client
  copy deep-equals compose-from-tables after every op shape a board
  supports.

## Passkeys — the boundary rule, applied to auth (2026-07-29)

Browsers ship passwordless (WebAuthn); epsilon supports it by default with
ZERO dependencies. The split honors the existing boundary: SQL owns
identity and state — `credentials` beside users and sessions (db/002),
counter policy inside `credential_use` — and TS owns the CEREMONY
(`epsilon/passkey.ts`): pgcrypto has no ECDSA, so WebCrypto verifies, the
way TS already owns transport. The attestation CBOR needs only four fixed
shapes — a ~60-line vendored reader, not a package.

Decisions:
- **Passkey-first, password-fallback.** The password stays as the
  register-time identity anchor and the CLI's door (a terminal has no
  authenticator; `EPSILON_TOKEN` takes a browser-minted session). A
  passkey is added while signed in and signs you in ever after.
- **Challenges live on the socket** — single-use, per-connection,
  ephemeral. The wire is the session context; no challenge table.
- **Ceremonies bind to the socket's own Origin** by default (the browser's
  own scoping is the phishing resistance); `origins` pins it in
  production. The RP ID is that origin's hostname — never sent, browsers
  default to the same.
- **TOTP declined**: pgcrypto's hmac() could do RFC 6238 in pure SQL, but
  passkeys supersede password+TOTP — yesterday's second factor fails the
  line budget once tomorrow's first factor is in.
- The contract is pinned by a SOFTWARE authenticator (passkey.test.ts
  mints P-256 keys, builds CBOR attestations, DER-wraps signatures) — the
  ceremony is tested without a browser, like everything else.

## Gone is a snapshot of nothing (2026-07-29)

The last two open items — and the sharing known-limit — were one defect: a
subscription could outlive its permit. A deleted board lingered on every
host with watchers (rendering forever, no push); a removed member kept
receiving broadcasts until they closed the doc.

- **No new vocabulary.** The eviction push is a root replace to null — the
  value every doc holds before its first snapshot, so clients and ui.ts
  already render it, and gone reads exactly like never-there (no existence
  oracle grows).
- **`host.drop(name)`** un-hosts: each watcher gets the null snapshot and
  is unsubscribed (hooks fire), the entry is forgotten. Every process
  learns: the WRITER from the apply result — `doc_drop` returns the name
  and the dispatch lists it as `gone` (no listener needed: PGlite, poll) —
  siblings from `doc_drop`'s doorbell (`{name, gone}`); a polling host
  notices a known row that stops coming back.
- **`host.expel(name, user)`** re-asks the doc's `open` gate and evicts
  only on refusal — the permit at open time and eviction time is the same
  question (0.3.2's presence rule, extended to lifetime). server.ts wires
  member-remove echo ops to expel the board and its presence; riding
  `sig.onOps` means every process hosting the doc enforces it on its own
  sockets.
- Known nuance: a doc deleted while a client's socket was DOWN re-opens to
  a refusal (onError), not a null push — the mine mirror's fresh snapshot
  carries the loss.

## Who changed what (2026-07-31)

Eight people editing one plan, mostly while the others are asleep. The
audit to answer "who moved this?" was already on disk — `doc_ops` has
recorded who, what and when since 001 — and the only way to read it was
psql. The answer splits in two, and the split is the design:

- **STATE** — a row's own `updated_by` / `updated_at`, stamped by the
  type's dispatch on real edits. Lives on the row, composes into the doc,
  and SURVIVES the op-log prune. This is app schema by nature (the kit
  cannot know your tables); `100-board.sql`'s cards are the worked example.
- **HISTORY** — `doc_history`, in the kit beside `doc_undo` (`db/003`),
  the log read back: newest first,
  paged by VERSION cursor (`before` walks back, `after` tops up an open
  panel), names JOINed at read time so a member who has since left is still
  named honestly and a rename isn't retconned across the past.

The permit is `doc_open` — the same question the wire's default gate asks
at every open — so history can never be a side door into a doc you may not
read, and no doc type has to remember to guard it. `pgHistory(host, sql)`
is the whole wiring; the audit was already being written.

Two costs worth naming. An op that stamps a row changes more columns than
its path says, so its ECHO has to widen to the whole row — otherwise the
client's copy stops matching a recompute, which is the law rel.test.ts
drives (the `done` branch moved from a scalar echo to a row echo for
exactly this). And a RESTORE must put the old stamp back rather than
re-attributing the row to whoever pressed undo: the kit's rule is that a
type's resolved echo is legal input, so `add /cards/<id> {row}` restores
that row, stamp included.

## The operator's door (2026-07-31)

The embedded tier has no port. PGlite lives inside the app process, so a
deployment on `EPSILON_PG_DIR` has no psql, no console, and no way to
inspect or repair itself except the wire it already speaks. `pgAdmin` is
that door: `call admin {"sql":"…"}`, gated by a list of registered emails
(`EPSILON_ADMIN`). It was born the night a typo'd registration could be
neither found nor fixed.

Two deliberate choices against the usual instincts. **No list, no door** —
with none configured the method is never registered, so a deployment that
didn't opt in has nothing to attack. And when it IS configured, refusals
SPEAK ("no session on this socket", "not permitted for …") instead of
hiding behind a uniform missing-method reply: the no-oracle rule earns its
keep on doc names, which strangers can probe, but this door is only
reachable by an authenticated socket, and an operator who cannot tell "not
signed in" from "not on the list" from "not deployed" spends the evening
guessing which. Writes here bypass the op log — right for users and
sessions, reload-worthy for doc tables.

## Upgrades — taking a new epsilon is mechanical (2026-07-30)

The second field report (japan; the first became 0.3.0): one month
deployed, pinned to 0.2.2 plus local patches, `db/` forked permanently
because 0.3.0's renumbering broke its ledger. Upgrade-by-hand was already
the most expensive part of owning the stack. The problem splits in three,
and only the SQL part wanted machinery — which existed:

- **Runtime files are a merge problem; git is the tool.** package.json
  records the scaffold's upstream base (`"epsilon": { "base": "v0.5.0" }`,
  kept in step by the release flow, carried by `bun create`). `bun run
  epsilon:upgrade` fetches upstream and three-way applies
  `git diff <base> <target>` over a WHITELIST — `epsilon/` and the skill;
  never `db/`, never app files. Local patches survive; genuine divergence
  surfaces as conflict markers, which is correct; the vendored tests are
  the proof. Upstream commits are the upgrade steps, the recorded base is
  the ledger — no new mechanism.
- **Released core migrations freeze forever.** The 0.3.0 renumbering was
  the sin: right for fresh scaffolds, unadoptable by any deployed ledger.
  Decision 4's "once real deployments exist" moment has passed. New core
  behavior ships as the next numbered file — `005-gone.sql` is the first —
  which a deployed app adopts by copying that one file; its ledger stays
  one history. The range is reserved: **001–099 core, app migrations from
  100** (the board type moved to `100-board.sql`; `migrate()` warns when a
  sub-100 file isn't upstream's).
- **App call-sites: TypeScript is the codemod.** No scripts that edit app
  code. Every breaking change must fail LOUDLY at `check` or construction
  time with the one-line fix in the message, and gets a CHANGELOG entry
  with exact before/after. That is the whole contract.

## Open items

- None right now. (`epsilon_prune` runs at boot and daily since 0.5.0; an
  external cron remains fine.)

## Non-goals

No vdom. No OT/CRDT (model is authoritative; LWW + resync). No offline. No arbitrary live queries — read views without a lawful `put` are read-only, as in delta. In-memory mode is a SHAPE PREVIEW, not a second implementation: uuid ids, no `-` identity resolution, no permits — keep identity-dependent UI behind auth.

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
4. **Migrations are day-zero truth, not a development diary** (Peter,
   2026-07-29). Pre-1.0 the `db/` files were squashed to the final state —
   001 core, 002 auth, 003 the kit, 004 housekeeping, 005 the app's doc
   types. The narrative lives in git and this file. Databases that applied
   the old files upgrade cleanly (new names, idempotent statements); once
   real deployments exist, the files freeze and forward-only rules.
   *Amended 2026-07-30 (japan):* that moment has passed. Released core
   files are frozen forever; new core behavior is the next number; the
   range is reserved (001–099 core, app from 100) — see "Upgrades".
