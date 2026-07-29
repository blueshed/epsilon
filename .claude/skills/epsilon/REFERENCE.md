# epsilon — the deep manual

Read on demand from SKILL.md. Source of truth order: the runtime source
(`epsilon/`), its tests (the contract), `DESIGN.md` (the why), then this.

## Engines — mechanics

- **In-memory** (nothing set): `host.doc(name, empty)` — host mints uuids,
  open access, state dies with the process. A SHAPE PREVIEW, not a second
  implementation: `-` mints random uuids (never resolves to identities the
  way relational dispatch can), and there are no permits — keep
  identity-dependent UI behind auth.
- **Embedded** (`EPSILON_PG_DIR=./data`): the relational tier on in-process
  Postgres (PGlite) — no database service; migrations, stored functions,
  and auth run unchanged. ONE app process owns the directory (mount a
  volume); pgSync is skipped — no sibling processes exist. Deploying with
  it? `bun add @electric-sql/pglite`. Outgrowing it? pg_dump, set
  `EPSILON_PG_URL` — a config change, same schema.
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
SQL). Copy `db/005-board.sql` (worked example) or rel.test.ts's `todo`
type (minimal).

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
  `doc_drop` deletes a doc whole; `doc_commit` on ANOTHER doc is the
  multi-doc mirror. Multi-doc mirrors follow 005's lock order: ALL mine
  docs ascending uid, THEN board docs ascending id, pre-scanned and locked
  up front — mirror only into docs you pre-locked.
- Then seed the `docs` row with `open_fn` and add one `pgDoc` line behind
  a gated factory. Singletons (`trip:1`-style) skip the factory: seed the
  docs row in your migration like `board:1` and host with
  `pgDoc(host, sql, "trip:1", null, { apply: "trip_apply" })` at boot.

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

## Dynamic docs, presence

- `host.docs(prefix, (name, userId) => ...)` — names are data, hosted on
  first open; the factory sees the asking user: throw `unknown doc` BEFORE
  hosting/seeding so probes cost nothing (see server.ts's `mine:` factory).
- Presence: `presence:board:<id>` is an in-memory doc the host's
  `onSubscribe`/`onUnsubscribe` hooks maintain (see server.ts) — being
  present IS watching the doc; it evicts with its last watcher. Ephemeral,
  per-process. Follow this shape for any who's-here / typing / cursor
  state.

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
bun epsilon/cli.ts call undo '{"doc":"board:2"}'   # revert YOUR last write
```

Every mutation prints the RESOLVED echo the server broadcast — what you
see is what every client rendered. `--url`/`EPSILON_URL` target another
port; `EPSILON_TOKEN` overrides the token file; `--timeout` bounds every
command (a bare `watch` runs until Ctrl-C). Write in one terminal, `watch`
in another, and you are watching the fan-out itself.

## Testing

- `bun test` (unit/wire/DOM), `bun run test:pglite` (embedded, no server),
  `bun run test:pg` + `test:app` (need `bun run db:up`), `bun run check`
  (strict tsc), `bun run ci` (everything).
- Each test file owns its OWN database (`epsilon_test_pg`, `_rel`, `_app`,
  `epsilon_migrate_test`) — they TRUNCATE, and sharing one deadlocks
  against the migration advisory lock.
- The law as a test: after driving ops over the wire, assert the client
  copy `toEqual`s `doc_open(name)` composed from the tables (see
  rel.test.ts "the law, executable"). Add the same assertion for every
  new doc type — it catches any dispatch whose op stream lies.

## Sharp edges

- `--hot` re-evaluates server.ts top level: boot ONCE via the `globalThis`
  guard (see server.ts) or every reload leaks a Postgres pool and resets
  doc versions under live clients.
- Bun SQL binds objects/arrays RAW into jsonb — `JSON.stringify(...)::jsonb`
  double-encodes into a scalar and `jsonb_array_elements` explodes.
- Effects through a lens re-run on ANY root change (correct, not minimal)
  — use `bind()` for scalars; `list()` already rides the ops channel.
- `expect(p).rejects.toThrow()` NEVER settles against a Bun SQL rejection —
  use try/catch and assert on the message (verified, Bun 1.3.14).
- A multi-statement `unsafe()` inside `conn.begin()` leaks failures as
  unhandled rejections — use explicit BEGIN/COMMIT on a reserved
  connection (see `migrate.ts`).
- `epsilon/` is yours to edit — run `bun test` after; the tests ARE the
  contract you're editing against.
