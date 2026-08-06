# epsilon — the deep manual

Read on demand from SKILL.md. Source of truth order: the runtime source
(`epsilon/`), its tests (the contract), `epsilon/DESIGN.md` (the why), then
this.

## Engines — mechanics

- **In-memory** (nothing set): `host.doc(name, empty)` — host mints uuids,
  open access, state dies with the process. A SHAPE PREVIEW, not a second
  implementation: `-` mints random uuids (never resolves to identities the
  way relational dispatch can), and there are no permits — keep
  identity-dependent UI behind auth.
- **Embedded** (`EPSILON_PG_DIR=./data`): the relational tier on in-process
  Postgres (PGlite) — no database service; migrations, stored functions,
  and auth run unchanged. ONE app process owns the directory (mount a
  volume); pgSync runs in POLL mode (0.6.0) — sync is the delivery path
  for every commit made outside a doc's own write hook (mirrors, undo,
  views), not just for sibling processes. Deploying with it?
  `bun add @electric-sql/pglite`. Outgrowing it? PGlite has no port, so
  `pg_dump` cannot reach it: `bun run epsilon:export --dir ./data > dump.sql`,
  boot once against `EPSILON_PG_URL` so migrations build the schema, then
  `psql -f dump.sql`. Ids and sequences carry over. `railway.json` at the
  repo root is the worked deploy example (config-as-code: start command,
  healthcheck `/`, restart on failure) — volume at `/data`,
  `EPSILON_PG_DIR=/data`; `server.ts` honors `PORT`. Inert off Railway;
  the same pattern applies on any host.
- **Wire Postgres** (`EPSILON_PG_URL`): same schema on a server; pgSync
  (LISTEN/NOTIFY via the optional `pg` peer, polling without it) fans
  writes out across processes.

## Schema — migrations, always

`db/NNN-name.sql`, applied in order by `migrate(sql)` at boot, recorded by
name + content hash. **Forward-only: never edit an applied file** — the
runner refuses it (the ledger records the hash, not the meaning: comment
edits count); write the next number. One transaction per file. Add a
table? New migration. Change a stored function? New migration with
`CREATE OR REPLACE`. (The template repo itself may re-squash its five
day-zero files pre-1.0 — apps never edit applied files.)

## Auth — a SQL contract, not TypeScript

`db/002-auth.sql` owns `register` / `login` / `session_start` /
`session_get` / `session_end` (pgcrypto bcrypt, cost 12). `pgAuth` is only
the wire adapter. To change auth policy, write a migration that replaces
the function — no runtime change.

**Passkeys** (`db/002-auth.sql` + `epsilon/passkey.ts`): the boundary
rule applied to auth — SQL owns identity and state (credentials beside
users/sessions, counter policy in `credential_use`), TS owns the CEREMONY
(pgcrypto has no ECDSA; WebCrypto verifies). Zero dependencies — the CBOR
reader is vendored. `pgPasskey(host, sql, { rpName, origins? })` registers
four begin/finish methods; challenges live ON THE SOCKET (single-use, die
with the connection — no table). Ceremonies bind to the socket's own
Origin by default; pin `{ origins: ["https://app.example"] }` in
production. Flow: password registers the account (the identity anchor and
the CLI's door), "add a passkey" while signed in, passwordless sign-in
ever after. The CLI can't run WebAuthn — passkey-only users paste a
browser-minted token into `EPSILON_TOKEN`. HTTPS required (localhost
exempt). Tested by a SOFTWARE authenticator (passkey.test.ts) — no
browser needed to pin the contract.

## Ownership — users mean something

`board_may(board, user)` gates BOTH `board_open` (NULL for refused
non-NULL users) and `board_apply` (RAISE "not found" — never confirm a doc
exists). Follow that shape for every doc type: one predicate, both
directions, checked inside the stored function with the identity the
socket authenticated. Members too (0.2.1): share by email with
`add /members/-` on the board (owner only); the member's own list mirrors
it in the same transaction.

The wire is gated by the SAME function (0.3.0): pgDoc's open gate defaults
to `doc_open(name, user) IS NOT NULL`, asked fresh at every open — a doc
claimed or shared while hosted is re-judged at the next open. A NULL user
is the HOST composing its own copy (full view); your `<t>_open` must
refuse only a NON-NULL user who may not see it. Pass `guard` only to skip
the SQL round trip, and NEVER capture mutable row state at hosting time
(`owner == null ? undefined : …` at factory time fails open, silently,
the moment the row changes — the bug that motivated 0.3.0).

## Authoring a doc type (the kit — db/003)

A type is ONE composition query + ONE dispatch function (~30 lines of app
SQL). Copy `db/100-board.sql` (worked example) or rel.test.ts's `todo`
type (minimal). 001–099 are epsilon core, frozen once released, and
`migrate()` warns if you squat below; 100/101 are the scaffold's demo, so
number your own from **102**. The TABLES need a number — the `_open` and
`_apply` FUNCTIONS go in `db/fn/`, edited in place (100-board.sql defines
its own inline only because it predates `db/fn/` and its hash is already
recorded in deployed ledgers).

- `<x>_open(doc, user)` — one composition query; NULL user = the host,
  full view; NULL result = refused.
- `<x>_apply(doc, ops, user)` = `doc_begin(p_doc, <permit>)` → dispatch
  loop → `RETURN doc_commit(p_doc, v_out, p_user, v_undo)`. Per branch:
  match `doc_path(v_op)`, do the DML, append the RESOLVED echo
  (`v_out := v_out || op_add/op_replace/op_remove(...)`), and PREPEND the
  inverse (`v_undo := <inverse> || v_undo` — read the before value first;
  a batch undoes back to front). The inverse table is in 003's header.
- **Accept your own resolved echoes as input**: `add /coll/<id> {row}`
  restores that exact row (`INSERT … OVERRIDING SYSTEM VALUE` then
  `doc_restore_id(table)` so the sequence can't re-mint the id);
  `replace /coll/<id> {row}` sets it whole. Undo, replay, and fork hang
  off this one property.
- **FK cascades are invisible to the op log**: expand them with
  `doc_cascade_remove(table, fk, id, prefix)` BEFORE deleting the parent,
  or clients render orphans until reload — and undo can never restore
  what the log never saw.
- The kit owns locks, refusals (no existence oracle), versioning, audit,
  NOTIFY, undo (`doc_undo`), conflict detection (`doc_touched_since`);
  `doc_drop` deletes a doc whole — and tells the world: it rings the
  doorbell (`{name, gone}`) and returns the name, which your dispatch
  collects into the result's `gone` array
  (`v_gone := v_gone || doc_drop(...)`, returned as
  `doc_commit(...) || jsonb_build_object('gone', to_jsonb(v_gone))`) so
  the writing process un-hosts it too — watchers receive the snapshot of
  nothing (a root replace to null). `doc_commit` on ANOTHER doc is the
  multi-doc mirror. Multi-doc mirrors follow 005's lock order: ALL mine
  docs ascending uid, THEN board docs ascending id, pre-scanned and locked
  up front — mirror only into docs you pre-locked.
- Then seed the `docs` row with `open_fn` and add one `pgDoc` line behind
  a gated factory. Singletons (`trip:1`-style) skip the factory: seed the
  docs row in your migration like `board:1` and host with
  `pgDoc(host, sql, "trip:1", null, { apply: "trip_apply" })` at boot.

## Views — render a noun, open a doc

`call()` is for VERBS. Anything you render is a noun, and a noun arrives
as a doc — a fetch-shaped call renders once, goes dead, and escapes the
permit lifetime. When no doc exposes what a screen needs (a list across
docs, counts, a dashboard), declare a VIEW:

```sql
-- App SQL: composition AND permit in one function (001's rule — NULL user
-- = the host's full copy; NULL result = refused, "unknown doc" on the wire).
CREATE OR REPLACE FUNCTION tally_open(p_doc text, p_user bigint DEFAULT NULL)
RETURNS jsonb AS $$
  SELECT CASE WHEN p_user IS NOT NULL AND p_user <> doc_id(p_doc) THEN NULL ELSE
    jsonb_build_object('boards',
      (SELECT COUNT(*) FROM boards b WHERE b.owner_id = doc_id(p_doc)))
  END;
$$ LANGUAGE sql STABLE;
```

```ts
pgView(host, db, "tally:", { open: "tally_open", on: ["board:", "mine:"] });
```

- READ-ONLY: writes refuse ("read-only view") — mutate the docs it
  composes from. No docs row, no version history, no undo; nothing to
  migrate beyond the function.
- `on` DECLARES the dependency prefixes — a commit (or doc_drop) on any
  matching doc recomposes every hosted name of the view. Declared, not
  inferred; that's the whole tractability (DESIGN.md: no UNDECLARED live
  queries).
- Per-identity views are per-identity NAMES (`tally:<uid>`), like
  `mine:<uid>` — one name reads the same to everyone permitted (the
  per-viewer decree). The permit is re-asked at every open and the client
  opens it like any doc: `remote.doc("tally:" + uid)`.
- Costs: recompose is eager, bounded by eviction (composes only while
  watched), per-name coalescing, and an equality skip (a doorbell that
  changes nothing pushes nothing). Delivery is pgSync's — LISTEN or poll,
  embedded tier included; no pgSync, no updates.
- `history` stays a call on purpose: the rule governs rendered LIVE
  state; a parameterized, paged archive read is verb-shaped.
- view.test.ts is the worked suite (wire + poll); pglite.test.ts drives
  one embedded.

## Undo

`pgUndo(host, db, (doc) => doc.startsWith("board:") ? "board_apply" :
undefined)` registers the `undo` method: `remote.call("undo", { doc })`
reverts the CALLER's last undoable write (`{ v }` for a specific one);
refused — never clobbered — when later ops touched the same paths, when
the type recorded no undo, or when the version was pruned
(`epsilon_prune` bounds undo depth). The inverse dispatches through the
type's own apply: permit re-checked, mirrors re-fired, and the resulting
commit records the redo. Works without pgSync (`pgReceive` re-enters the
echo), so it's embedded-tier safe. Undo is a WRITE — treat it like one.

## Who changed what

Two halves. **HISTORY**: `pgHistory(host, db)` registers the `history`
method — `remote.call("history", { doc, before?, after?, limit? })` returns
the doc's own op log, newest first, each entry `{v, at, by, name, ops}`.
Paging is by VERSION cursor: `before` walks backwards ("older…"), `after`
fetches only what is newer than a version you already hold. The permit is
`doc_open` — the doc's own gate — so it is never a side door, and a doc type
gets it for free. Names are JOINed at read time, so someone who has since
left is still named. Depth is whatever `epsilon_prune` keeps.

**STATE**: `updated_by` / `updated_at` on the row, stamped by your dispatch
(see `100-board.sql`'s cards). Survives the prune, composes into the doc, and
answers "who last touched this" without a query. Two traps: an op that also
stamps changes more columns than its path says, so widen its ECHO to the
whole row (a scalar echo would leave clients disagreeing with a recompute);
and a RESTORE must take the stamp FROM the value, or undo re-attributes the
row to whoever pressed undo.

## The operator's door

`pgAdmin(host, db)` registers `admin` — `call admin '{"sql":"…"}'` — gated by
`EPSILON_ADMIN` (comma-separated registered emails) or `{ admins }`. It
returns `{ rows }`, or `{ rows, truncated, total }` past `maxRows` (500).
NO LIST, NO DOOR: unset and the method is never registered, so a deployment
that didn't opt in has nothing to attack; `pgAdmin` returns whether it opened
one. It exists for the EMBEDDED tier, whose database has no port — this is
the only way to inspect or repair a running deployment. Refusals say which
of "no session" / "not permitted" applies, deliberately: the door is only
reachable by an authenticated socket. Writes here bypass the op log, so
hosted docs won't hear them — reload after touching doc tables.

## Dynamic docs, presence

- `host.docs(prefix, (name, userId) => ...)` — names are data, hosted on
  first open; the factory sees the asking user: throw `unknown doc` BEFORE
  hosting/seeding so probes cost nothing (see server.ts's `mine:` factory).
  **A factory refusal guards only the FIRST open** — the doc outlives its
  opener. Relational docs stay safe because the default gate asks
  `doc_open(name, user)` per open; an IN-MEMORY doc has no such default,
  so any permit the factory checks must ALSO be fitted as its `open` gate
  (`host.doc(name, {}, { open })`) or it fails open while hosted.
- Presence: `presence:board:<id>` is an in-memory doc the host's
  `onSubscribe`/`onUnsubscribe` hooks maintain (see server.ts) — being
  present IS watching the doc; it evicts with its last watcher. Ephemeral,
  per-process, and exactly as private as the board it watches: its open
  gate re-asks `board_may` per socket (the rule above, applied). Follow
  this shape for any who's-here / typing / cursor state.
- A subscription never outlives its permit: `host.drop(name)` un-hosts a
  deleted doc (every watcher gets the null snapshot and is unsubscribed —
  the relational tier calls it for you via `gone` and the doorbell);
  `host.expel(name, userId)` re-asks the doc's `open` gate and evicts that
  user's sockets when it refuses. server.ts wires member-remove echo ops
  to expel (the board AND its presence) — copy that wiring for any doc
  type whose membership can be revoked.

## The CLI — full commands

`epsilon/cli.ts` is the browser's own client (`connect()`) behind argv:
one-shot, auth-aware, JSON out. While `bun dev` runs, USE IT — verify
realtime behavior end-to-end instead of guessing from source:

```sh
bun epsilon/cli.ts register <name> <email> <password>  # token → .epsilon-token
bun epsilon/cli.ts open board:1            # {doc, v, data} — composed snapshot
bun epsilon/cli.ts open board:1 /cards     # a pointer slices it
bun epsilon/cli.ts add mine:1 /boards/- '{"name":"plan"}'   # creation is an op
bun epsilon/cli.ts add board:2 /cards/- '{"text":"hi"}'     # echo has the minted id
bun epsilon/cli.ts set board:2 /cards/1/done true
bun epsilon/cli.ts rm  board:2 /cards/1
bun epsilon/cli.ts watch board:2 --for 3000    # NDJSON: snapshot, then each op
bun epsilon/cli.ts call login '{"email":"…","password":"…"}'
bun epsilon/cli.ts call undo '{"doc":"board:2"}'      # revert YOUR last write
bun epsilon/cli.ts call history '{"doc":"board:2"}'   # who changed what, newest first
bun epsilon/cli.ts call admin '{"sql":"SELECT …"}'    # EPSILON_ADMIN only; the embedded db has no port
```

Every mutation prints the RESOLVED echo the server broadcast — what you
see is what every client rendered. `--url`/`EPSILON_URL` target another
port; `EPSILON_TOKEN` overrides the token file; `--timeout` bounds every
command (a bare `watch` runs until Ctrl-C). Write in one terminal, `watch`
in another, and you are watching the fan-out itself.

## Routing — screens (route.ts)

A hash router, not the History API: epsilon serves its own HTML from
`Bun.serve`, so History mode would need a catch-all route on every deployment
and a rewrite rule on every static host in front of one. `#/board/5` still
resolves cold and is still a shareable URL.

```ts
routes(target, table)   // declarative — owns target's children, one scope per handler
route<T>(pattern)       // reactive — Signal<params | null>, null when unmatched
navigate(path)          // set location.hash programmatically
matchRoute(pattern, path)  // the pure matcher; params or null
```

Patterns are `"/users/:id"` (named params, exact segments), `"/sites/*"`
(wildcard, any depth, rest in `params["*"]`), or both. **Tested in declaration
order, first match wins** — put `/users/new` before `/users/:id`. Matching is
purely segment-based: there is no query-string handling (`#/users/42?tab=1`
gives `id === "42?tab=1"`), and a trailing slash is a real empty segment, so
`/users/42/` does NOT match `/users/:id`.

**A handler returns `Node`, or `Promise<() => Node>` — never `Promise<Node>`.**
Browser JS has no AsyncContext, so a dispose scope cannot survive an `await`.
The thunk is what the router brackets, and it is how bindings created after an
await get an owner. The bare async form is refused at the type level.

**Params change without teardown.** `/board/1 → /board/2` updates `params$`
and re-runs nothing else. That is the point: a route that opens a doc should
open it ONCE and let an effect follow `params$` — closing and re-opening a
subscription on every id change is the bug this shape prevents.

```ts
function boardView(params$: Signal<Record<string, string>>): Node {
  const title = el("h2");                 // built once, per ENTRY to the pattern
  effect(() => openBoard(`board:${params$.get().id}`));   // re-runs per id
  return title;
}
```

Nest by keeping a layout mounted under a wildcard, then using `route()` inside
it. Both `routes()` and `route()` auto-track in the parent scope. `route()` at
module level is supported and needs no ceremony — the hash signal is
app-lifetime by construction, so a computed over it is too.

## Local state — signals that aren't docs

Not everything on screen is shared. `signal()`, `computed()` and `batch()` are
the same primitives the doc layer is built from, for state that never leaves
the tab (a filter, a dialog's mode, a draft):

```ts
const filter = signal("all");
const visible = computed(() => rows.get().filter(r => keep(r, filter.get())));
batch(() => { me.set(user); refused.set(""); });   // one flush, not two
```

**`batch()` is for two writes to DIFFERENT signals.** `apply(ops[])` already
batches a doc — one op array is one notify — so batching around a single doc
write buys nothing. Two `.set()` calls on two local signals are what nothing
else coalesces. (This is not hypothetical: 0.9.0 deleted `batch()` after a
scan found "one call site", and the real consumer was in a working tree; it
came back in 0.9.1.)

`text(sig)` returns a Text node bound to a signal — the smallest binding there
is, for when you want a value in the DOM without an element to hang it on.

## Testing

- `bun test` runs EVERY suite; the ones needing a Postgres on :5599 or a
  browser skip themselves with a line saying how to enable them, so a bare
  run is always green. `bun run test` is the curated no-service list.
- `bun run test:pglite` (embedded, no server),
  `bun run test:pg` + `test:app` (need `bun run db:up`), `bun run check`
  (strict tsc), `bun run ci` (everything).
- Each test file owns its OWN database (`<app>_test_pg`, `_rel`, `_app`,
  `<app>_migrate_test` — `<app>` derived from package.json name, so
  checkouts sharing one dev Postgres never fight over migration ledgers) —
  they TRUNCATE, and sharing one deadlocks against the migration advisory
  lock.
- The law as a harness (`epsilon/law.ts`): `proveLaw({ handle, name, sql,
  batches, mirrors?, undo? })` drives batches over the real wire and
  asserts the client copy deep-equals `doc_open(name)` after every echo —
  undoing and redoing each batch when `undo` is wired, waiting on mirrors
  to converge. One batch per dispatch branch is the discipline; batch
  functions may close over test state (a restore keeps its remove's row).
  Failures name the defect class (unexpressed cascade, un-widened echo).
  Pin EVERY new doc type with it — rel.test.ts's law describe is the
  worked call; the todo drive there is the minimal one to copy.

## Sharp edges

- `--hot` re-evaluates server.ts top level: boot ONCE via the `globalThis`
  guard (see server.ts) or every reload leaks a Postgres pool and resets
  doc versions under live clients.
- Bun SQL binds objects/arrays RAW into jsonb — `JSON.stringify(...)::jsonb`
  double-encodes into a scalar and `jsonb_array_elements` explodes.
- Effects through a lens are PRECISE since 0.9.0 — `Lens.get()` tracks its
  own slice, so the effect re-runs only when an op touches it. What still
  costs you is reading the whole doc (`doc.get()`) inside an effect: that
  tracks the whole doc and re-runs on every write. Narrow with `at()`, then
  read. (`bind()` is gone — the lens is what it bought.)
- **Set the boot hash BEFORE `routes()` reads it.** `location.hash` updates
  synchronously but `hashchange` does not fire until a later task, so routing
  through the event renders your placeholder first and flashes. A cold load
  with no hash wants `location.replace("#/your/default")` above the `routes()`
  call — `replace`, so a bare `#` stays out of the history.
- **A route handler must hold element REFS, not call `getElementById`.**
  `routes()` appends the handler's fragment AFTER the handler returns, so a
  lookup inside it finds nothing. Build the nodes, keep the references.
- **A focused element is not yours to rewrite.** An effect that writes
  `textContent` from a doc will move the caret out from under someone typing
  in a `contentEditable` when a REMOTE write lands. Narrow the lens so
  unrelated writes don't re-run it, and guard on `document.activeElement`.
- `expect(p).rejects.toThrow()` NEVER settles against a Bun SQL rejection —
  use try/catch and assert on the message (verified, Bun 1.3.14).
- A multi-statement `unsafe()` inside `conn.begin()` leaks failures as
  unhandled rejections — use explicit BEGIN/COMMIT on a reserved
  connection (see `migrate.ts`).
- `epsilon/` is yours to edit — run `bun test` after; the tests ARE the
  contract you're editing against.
