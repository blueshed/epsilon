# Changelog

Notable changes, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/). Unreleased collects what the next version
will ship.

## [Unreleased]

## [0.10.3] — 2026-08-06

An independent multi-agent review of 0.10.2, and the withdrawal it earned.
0.10.2's three security/grain fixes survived four adversarial lenses intact;
its **ordering pattern did not**, and its upgrade instructions broke a boot.
This release removes a mechanism and adds a distinction — see UPGRADING.md,
whose 0.10.2 section is superseded rather than amended, because following it
fails.

### Removed

- **The `pos` ordering mechanism is withdrawn whole** — `db/102-card-pos.sql`,
  `db/fn/board.sql`, the move buttons, the swap arithmetic, `Card.pos`. Two
  reviewers independently found the wedge: a MOVE expressed as a swap of two
  values preserves the multiset, so two moves computed from stale copies
  could tie two rows at one position — and a swap between tied rows writes
  each the value it already has, so the pair could never be separated again.
  A third found the same tie reachable through undo.
  **The bug is not the lesson.** A MECHANISM was invented where a
  DISTINCTION was needed, and inventing mechanisms is the failure mode this
  project exists to avoid. DESIGN.md now carries the distinction:
  - *Display order is a client concern* — nothing shared, nothing in the
    document; sort what the doc already gave you.
  - *Shared order is ordinary model data* — a number on the row, written
    with a `replace` op like `done`. There is nothing for the kit to add.
  - *Concurrent reordering is LWW*, like every other field; convergent
    reordering is the OT/CRDT this stack declines by design.
  SKILL.md and REFERENCE.md say it in those terms, and say plainly: do not
  invent a move protocol.

### Fixed

- **The 0.10.2 upgrade instructions bricked a boot** (UPGRADING.md,
  CHANGELOG). They said to copy 007 plus "the `db/fn/` files" — but
  `db/fn/board.sql` read `cards.pos`, which only `db/102-card-pos.sql`
  creates, and that file was never mentioned. Since 007 commits in its own
  transaction before the vocabulary pass, the failure left `doc_open`
  dropped and the app down, behind an error naming the wrong repair. With
  `db/fn/board.sql` withdrawn, core vocabulary touches core tables only —
  pinned by a test that boots an app which deleted the demo entirely.
- **`migrate()` names the real cause of a `db/fn` failure** (`epsilon/migrate.ts`).
  A vocabulary file referencing a table no migration creates now says so —
  and says that a `db/fn` file lives and dies with its numbered file —
  instead of offering the signature/`DROP FUNCTION` hint, which is the wrong
  repair. A missing-`DROP` default change gets its own message too.
- **`migrate()` refuses to finish with 007 applied and `doc_open` missing.**
  Copying the numbered half without `db/fn/doc-kit.sql` used to boot green
  and fail at the first doc open, far from the cause.
- **Sibling docs a factory hosts are gate-checked too** (`epsilon/doc.ts`).
  0.10.2's gateless-doc refusal inspected only the name that was asked for,
  so a factory hosting a second doc left that one ungated *and* permanently
  hosted (never marked dynamic, so never evicted). Both closed.
- Stale prose corrected where it now contradicted the schema: `DESIGN.md`'s
  NULL-user rule and law description, `epsilon/law.ts`'s header, the
  scaffold's core-file range (`db/001`–`007` plus the two core `db/fn`
  files).

## [0.10.2] — 2026-08-06

Grain hardening: the 2026-08 architecture review found three places where
the cheap path and the correct path still diverged and only prose stood
guard. All three are now structural, and the two worked patterns the review
reached for and couldn't find — ordering, cascade+undo — ship as code.

**Action required for apps with their own SQL or methods** (existing apps
adopt `db/007-doc-open-explicit.sql` and the `db/fn/` files by copying —
`db/` is outside the upgrade whitelist, as ever):

```sql
-- before: the permit-free read was the zero-argument call
SELECT doc_open('board:1');
-- after: omission errors; composing as the host is said out loud
SELECT doc_open('board:1', NULL);          -- the host's full copy
SELECT doc_open('board:1', p_user);        -- a user's permitted view
```

### Security

- **`doc_open` requires both arguments** (`db/007`, `db/fn/doc-kit.sql`).
  The user parameter carried `DEFAULT NULL` since 001, which made the
  permit-free full-copy read the ZERO-ARGUMENT call: a custom method that
  forgot to pass the socket's user compiled, ran, and silently served the
  host's own view of any doc. Omission is now an undefined-function error
  at the call site; NULL-means-host is unchanged, it just has to be
  written. pglite.test.ts pins both halves.
- **A gateless dynamic doc on a `requireAuth` host is refused at hosting
  time** (`epsilon/doc.ts`). A factory's refusal guards only the FIRST
  open — the doc outlives its opener — and an in-memory doc has no
  `doc_open` default to fall back to, so `host.doc(name, {})` behind a
  prefix factory failed OPEN for as long as anyone watched it. The host
  now un-hosts and errors, naming the fix (`{ open }`); an intentionally
  public doc states it: `open: () => sig.peek()`. doc.test.ts pins it.

### Changed

- **`doc_commit` refuses root-path ops** (`db/fn/doc-kit.sql`). A dispatch
  that echoes a recomposition — `replace "" {whole doc}` — satisfies the
  law trivially and destroys everything else the log is for: history reads
  "someone replaced everything", a root path conflicts every later undo,
  and who/what/why dissolve. "Express the change, never recompose" was a
  design rule; now it is a shape the kit refuses. Nothing legitimate
  commits at root (snapshots ride hydrate; views never commit).
- **The board's vocabulary moved to `db/fn/board.sql`** (`card_json`,
  `board_apply`). 100-board.sql predates `db/fn/` and its hash is frozen
  in deployed ledgers; behaviour now evolves in place, per the vocabulary
  rule. `board_open`/`mine_apply` are unchanged and stay in 100.
- App migrations now start at **103** — 100–102 are the scaffold's demo.

### Added

- **Ordering is model data — the worked pattern the demo's own genre was
  missing** (`db/102-card-pos.sql`, `db/fn/board.sql`, index.ts, types.ts).
  Cards get `pos`: minted max+1 on insert, restored from the value,
  composed by `card_json`, moved by ordinary replace ops on
  `/cards/<id>/pos` — a MOVE is a SWAP, two pos replaces in ONE batch,
  atomic, both stamped (echoes widen to the row, like `/done`), both
  undone together. The client renders each row's flex `order` from its own
  pos lens — no DOM surgery; `list()` is untouched. Move buttons hide on
  the in-memory preview, which mints no pos. Pinned by proveLaw on both
  engines (pglite.test.ts; rel.test.ts's law drive gained the swap batch).
- **Cascade + undo, combined** (pglite.test.ts's `recipe` type,
  REFERENCE.md). The review's build fell into the gap between the two
  worked examples: `doc_cascade_remove` expands the ECHO only — the
  before-rows die inside it — so a type that records undo must read the
  children FIRST and prepend parent-then-children adds to the inverse; and
  every inverse recorded must be an op the dispatch can dispatch. The
  recipe type is that combination end to end, pinned by proveLaw.
- **Two seams, named in the skill** (SKILL.md): bytes never ride ops — an
  attachment goes over an HTTP route to your object store, the doc carries
  the reference; verification/reset email is the mail vendor's side of a
  `host.method` seam. Both deliberately unvendored.

## [0.10.1] — 2026-08-06

A review of 0.10.0 as released, and the fixes it found. Almost all of this
is repair, not design: `call` was never auth-gated, which made two of the
built-in methods a way into any private doc; the production defaults were
development's; and the docs a newcomer meets first disagreed with each other
and with the code.

**Action required despite the patch number.** Apps that register their own
`host.method()` must say which are pre-auth doors, and anyone using the
operator's door must set `EPSILON_ADMIN_SECRET`. Both are one line, and
UPGRADING.md has them. Nothing in the client API changed.

### Security

- **`call` is gated like doc traffic (`epsilon/doc.ts`).** The `call` branch
  returned BEFORE the `requireAuth` check, so every registered method was
  reachable without a session. Two were exploitable as shipped, both verified
  against a running server: `history` returned the complete op log of a doc
  the same socket had just been refused (`pgHistory` passes `null` for a
  session-less socket, and `doc_history` reads NULL as "the host asking as
  itself" — the permit always passed), and `undo` with an explicit `v`
  reverted another user's write on any doc a NULL user may touch, which
  includes the seeded ownerless `board:1` the scaffold ships. Methods now
  need a session; `{ open: true }` marks the ones that MINT a session
  (login/register/authenticate/logout and the passkey login pair) and is the
  only exemption. **Breaking for apps with their own methods** — see
  UPGRADING.md.
- **The operator's door needs a secret** (`EPSILON_ADMIN_SECRET`). It ran
  arbitrary SQL behind an allowlist of emails, and registration is open and
  unverified, so on a fresh deployment whoever registered the operator's
  address first owned the database. With a list configured and no secret the
  door refuses to open rather than opening weakly, and every statement is
  now logged.
- **Session tokens are stored as a digest** (`db/006`, `db/fn/session.sql`).
  They were bearer credentials kept in the clear, so any dump or admin SELECT
  handed over live logins. Tokens also grew from a 122-bit uuid to 256 bits.
  Existing sessions survive: the migration hashes the column in place.
  Adds `session_end_all` — sign out everywhere.
- **Origin allowlist on the WebSocket upgrade** (`EPSILON_ORIGINS`).
  WebSockets are not bound by the same-origin policy, so any page a signed-in
  user visited could speak the protocol as them.
- **Passkeys**: `userVerification: "required"` is now enforced rather than
  merely requested (the UV flag was never checked), and `passkey_login_begin`
  — pre-auth, and it names a user's credentials — is rate limited.
- **Auth throttling gained a per-address budget.** The IP+email key never
  bounded CPU: rotating the email minted a fresh budget every time, so the
  bcrypt work — cost 12, deliberately expensive — had no ceiling at all. The
  per-account budget still does what it was for; the new per-address one is
  deliberately loose, because behind a PaaS edge it is shared by everybody.

### Production

- `development: { hmr, console }` is behind `NODE_ENV` — every deploy was
  serving Bun's dev mode, including client `console` piped into server logs.
- Under `NODE_ENV=production` a missing database is now a **startup failure**.
  A misspelled `EPSILON_PG_DIR` used to boot, pass its healthcheck, and serve
  every doc to the internet with no auth.
- WebSocket limits: 1 MiB frames, 120s idle, backpressure close. Op batches
  are capped at 500 — one batch is one transaction holding one row lock for
  its whole length, and the embedded engine serialises every query through
  one chain, so an unbounded batch is one client's hold on everyone. The
  bound is structural rather than tuned; `maxOpsPerBatch` raises it.
- Graceful shutdown: stop the server, stop sync, then close the database.
  Every redeploy had been hard-killing PGlite mid-transaction.
- `/health` touches the database, and `railway.json` points at it; `/` returned
  200 from the static bundle whether or not the database was alive. Pinned to
  one replica, since the embedded tier owns its directory.
- Presence docs refuse client writes and validate their whole name. Any member
  could forge or delete another user's presence entry, or host an invented
  `presence:<anything>:<id>` and use it as a free broadcast channel.
- `compose.yml` binds to `127.0.0.1` — Docker's port publishing goes through
  the host firewall, so the old mapping put a Postgres with a committed
  password on any public interface.

### Fixed

- **A rejected write no longer executes anyway.** `onclose` rejected pending
  promises but left their messages queued, so the reconnect flushed them and
  the server ran what the caller had been told failed — a caller who retried
  applied it twice. Id-bearing messages are now dropped with their promise;
  fire-and-forget writes still queue, which is `apply()`'s contract.
- `db/fn/`'s gate missed a bare `CREATE FUNCTION` — the likeliest mistake in a
  functions directory, which works on the first boot and fails on every one
  after.
- The migration ledger hashes with SHA-256 instead of `Bun.hash`, whose
  default algorithm is not a stability contract; had it changed, every
  deployed app would have refused to boot accusing its migrations. Existing
  ledgers are recognised and upgraded in place.
- Route handlers run untracked (new `untrack` export). A signal read at
  handler top level subscribed the ROUTER, so unrelated writes re-ran route
  matching — and mid-async tore the screen down and rebuilt it.
- Dynamic doc prefixes resolve LONGEST first; registration order used to
  decide, so `board:` silently shadowed `board:archived:`.
- `remote.doc()` after `close()` throws instead of returning a handle that
  never settles. A failed `pgDoc` un-hosts itself instead of serving `empty`
  at v=0 forever. The CLI's mutation commands use `write()`, so a concurrent
  writer's broadcast can't be printed as your echo. `.epsilon-token` is
  written 0600. `escapeToken` is exported.

### Added

- **`epsilon/export.ts`** (`bun run epsilon:export`) — the missing half of
  "scaling up is a config change". README told people to `pg_dump` the
  embedded tier, which is impossible: PGlite has no port. This emits the data
  as SQL, in foreign-key order, with sequences reset past every id already
  minted. Verified end to end: embedded → dump → wire Postgres, byte-identical
  docs and a post-move write that doesn't collide.
- `epsilon:upgrade` refuses a dirty tree (`EPSILON_UPGRADE_DIRTY=1` overrides)
  and prints the release notes link on the CONFLICT path, which is exactly
  when it was missing.
- Tests for what wasn't covered: the auth gate, the write/reconnect
  double-execute, gap classification and client resync, the upgrade conflict
  and dirty-tree paths, diamond glitch-freedom, and the infinite-loop guard.

### Documentation

- The scaffold said to number migrations from 101 (taken), the skill said 100
  (also taken); it is **102**. The "delete the demo" table said to keep
  `index.html`, which loads the deleted files by name and would not boot —
  it now says what to rewrite and what to port. New-doc-type guidance points
  at `db/fn/` and explains why `100-board.sql` looks different.
- README gains an environment-variable table, a production checklist, the
  embedded→server procedure, and a backup/retention section that says out
  loud that `epsilon_prune` is a 30-day cap on undo depth and the audit trail.
- A first run shows a sign-in dialog; the READMEs now say so rather than
  promising "two tabs, type in one".
- DESIGN.md: the `undefined = recompute` sentinel never existed in code, the
  in-memory tier DOES mint ids, and the doorbell's `v` is not read.

## [0.10.0] — 2026-08-06

A minor, not a patch: the doc-native storage tier is gone, so `pgDoc`'s
`apply` is now required. Everything else is housekeeping — the scaffold, and
the last five open findings from the 0.8.0 shakedown.

### Removed

- **`SHAKEDOWN.md`.** A 15 KB adversarial audit of 0.8.0 that shipped into
  every scaffold, quoting `file:line` bugs and another private app's schema
  throughout. Six of its findings had already been fixed; the last five are
  fixed in this release, so it holds nothing both true and unrecorded. The
  closed ones live in this changelog and in the code comments that explain
  them — `route.ts:75-77` states the hash fix better than the audit did.
- **The doc-native JSONB tier, and `DocOpts.persist` with it.** `pgDoc`
  branched on `opts.apply`: with it, tables are the truth; without it, the
  doc was a JSONB blob that TS applied ops to and one guarded UPDATE
  persisted. DESIGN.md called that tier "v0" and relational "next".
  Relational arrived at 0.7.0 and **no app ever hosted a blob** — every
  call site in this repo and in the one deployed app passes `apply`. The
  branch's real cost was not its ~48 lines: it was the SOLE reader of
  `DocOpts.persist`, which was the sole reason the host carried a per-entry
  `muted` flag through `hydrate` and `receive` — the trickiest invariant in
  `doc.ts`, maintained for no caller. `apply` is now required and both are
  gone. Found by two independent dimensions of the 0.8.0 shakedown, the
  single strongest agreement in that review.
- `pg.test.ts`'s durability and LISTEN fan-out cases went with the tier they
  tested. Both claims are proven on the tier that ships, in `rel.test.ts`
  ("restart: a fresh host hydrates by COMPOSING" and "two processes,
  concurrent writes", which also asserts `mode === "listen"`). The **poll**
  cases were unique — the fallback path, and the only place a doc's death is
  noticed by a sweep — so they were re-homed onto a relational board rather
  than deleted.

### Added

- **The demo shows the doc kit at last.** `db/003-doc-kit.sql` is described
  as "locking, audit, undo, history" and the README sells undo and the audit
  as headline knowns — and none of it had a single pixel. Three gaps, all in
  the same half of the database:
  - **Row stamps.** `card_json` puts `created_by`, `updated_by` and
    `updated_at` on **every echo**, and `types.ts` declared all three, but
    nothing ever read them — `git log -S updated_by -- index.ts` is empty.
    The column's own comment calls it *"the badge"*; the badge was never
    built. Each card now carries a byline, resolved through the board's own
    live `members` map (a lookup, not a fetch) and hidden rather than showing
    a bare id for someone it cannot name.
  - **Undo.** `pgUndo` was wired in `server.ts` and reachable over the wire;
    nothing called it. There is now an undo button, and a refusal ("someone
    wrote after you") is shown rather than swallowed — the refusal is the
    interesting part.
  - **History.** Same story for `pgHistory`. A toggle reads the audit back,
    newest first, each writer named at read time.

  All three are proven in a real browser by `app.test.ts`, not only at the
  SQL and wire level where `rel.test.ts` already had them covered — which is
  why the gap survived six releases with every suite green.
- The kit controls hide themselves in in-memory mode, where `server.ts` wires
  neither adapter: one capability probe per session, and any refusal OTHER
  than "unknown method" still counts as present.
- **The demo has screens now, not a screen.** The route table was two
  entries — one pattern with one param, and a placeholder string — driving
  346 lines of router. Nothing showed the wildcard layout, `route()`
  sub-navigation, declaration order, or the async handler's thunk. Now:
  - `/board/:id/*` is a **layout**. `/board/:id/card/:cid` routes a card
    detail underneath it via `route()`, and switching cards rebuilds only the
    detail — `app.test.ts` pins that by element identity, which is the claim
    `params$` and the wildcard exist to make.
  - `/settings` is a second real screen, and an **async handler**: it awaits
    a genuine browser probe (can this device hold a passkey?) before there is
    anything to render, so it returns `Promise<() => Node>`. A dispose scope
    cannot cross an `await`; the thunk is what the router brackets. The bare
    `Promise<Node>` that railroad shipped and documented as leaking is
    refused at the type level, and now the template shows why it exists.
  - The tally view is read by **two screens at once** — the board list and
    settings — which is what a view being an ordinary doc buys you.
  - `add a passkey` moved from the always-visible board list onto
    `/settings`, where account things belong.
- **`bun dev` now starts on embedded Postgres**, not in memory
  (`EPSILON_PG_DIR=./data`); the preview moves to `bun run dev:memory`. The
  old default was a trap: in-memory registers exactly one hardcoded doc, so
  a first run showed a checklist with no auth, no board list, no sharing, no
  undo, no history and no bylines — most of what the README sells, invisible,
  with no hint that an env var was the difference. It cost this repo's own
  author an hour before we worked out what he was looking at. `@electric-sql/pglite`
  already ships as a devDependency and `data/` is already gitignored, so the
  new default needs nothing extra.
- **`onDisconnect` is wired, and presence finally honours it.** DESIGN.md has
  warned since 0.6.0 that "anything rendered as live must hear the drop from
  this hook or it goes on testifying to a state nobody is in" — and the demo
  rendered presence without it, so a dropped socket left `here: Pete, Ada`
  on screen indefinitely. The demo now carries the bug's own cure.
- **`signal()`, `computed()` and `batch()` appear in the demo at last.** All
  three were exported, none was used: the demo's state was entirely
  doc-backed, so nothing showed what a purely local signal is for. The link
  state is exactly that — a fact about one tab, nothing to share or persist —
  and its two flags set together are the case `batch()` exists for. `batch()`
  was deleted in 0.9.0 and restored in 0.9.1 because a real app needed it;
  now the template says so itself.
- **REFERENCE.md gained a Routing section and a Local state section.**
  `route.ts` is a whole module and the deep manual mentioned `routes()` zero
  times; `text()`, `batch()` and `computed()` were documented nowhere in the
  skill pair. Three sharp edges moved in with them — set the boot hash before
  `routes()` reads it, hold element refs rather than calling
  `getElementById` in a handler, and don't rewrite a focused element from a
  remote write. The first two were only in `CHANGELOG.md` and `UPGRADING.md`,
  both of which 0.10.0 stops shipping to scaffolds.

### Fixed (the test suite explains itself)

- **Bare `bun test` failed out of the box.** It is what everyone types, and
  it discovers every `*.test.ts` — including the five that need a Postgres on
  :5599 and the one that drives a browser. On a machine without Docker that
  was **nine failures** of `ERR_POSTGRES_CONNECTION_CLOSED` plus a cascading
  `TypeError: undefined is not an object (evaluating 'sql.end')`, under a
  README promising "`bun test` verifies your stack, in your repo, forever".
  Those suites now ask first (`epsilon/testdb.ts`), skip cleanly, and print
  one line saying what would have run and how to enable it. Bare `bun test`
  with no database: **127 pass, 69 skip, 0 fail**. With one: 194 pass.
- **A skip must never be a silent pass in CI.** `EPSILON_REQUIRE_DB=1` turns
  an unreachable database into a loud failure instead of a skip, and
  epsilon's own workflow sets it — a database that fails to come up now
  fails the build rather than greening it.
- **Deleting the demo's schema now stops with an explanation.** The
  relational suites check for `board_apply` after migrating and, when it is
  gone, raise one message naming `db/100-board.sql`, saying it is the demo's
  file *and* their fixture, and giving the two ways forward. Previously an
  app that took the README's advice got seven cryptic failures.

### Fixed (documentation)

- **The scaffold README told you to delete the demo's schema, which breaks
  the vendored test suite.** `db/100-board.sql` and `db/101-tally.sql` are
  the demo's tables *and* the fixture `rel.test.ts`, `pglite.test.ts`,
  `view.test.ts` and `pg.test.ts` drive — some 360 references. Following the
  instruction turned `bun run test:pglite` into 7 failures out of 10, against
  a README promising "`bun test` verifies your stack, in your repo, forever".
  The delete list is now the UI and the wiring; the SQL stays until you have
  a doc type of your own to re-point those tests at. **The real fix is for
  the vendored suites to own their fixture rather than the app's, and it is
  not in this release** — `rel.test.ts` alone has 240 references.

### Changed

- **`bun create` now leaves an app, not a copy of this repo.** The
  postinstall hook was `rm -rf .github CHANGELOG.md` — five words against a
  root directory that had grown a changelog, an internal audit, an upgrade
  trail and a 37 KB design document. A scaffold inherited all of it. The
  hook is now `.scaffold/init.ts`, with the boundary written down as two
  lists: what an app must not keep, and what replaces it.
  - Gone from a scaffold: `UPGRADING.md`, `CHANGELOG.md`, `.github/`, and
    root `LICENSE`.
  - New in a scaffold: a `README.md` and `CLAUDE.md` written for the app
    rather than for this repo — what the demo is and which files to delete,
    which engine to pick, where things are — plus a CI workflow that runs
    the suites needing no service.
  - **The scaffold's `CLAUDE.md` is the app's file, not a trimmed copy of
    this repo's.** The first attempt swapped the file but not whose it was:
    it still carried the verbs, the law, db-first, `db/fn`'s rules and the
    `epsilon/` layout — all of which `SKILL.md` and `REFERENCE.md` already
    own, and which travel and stay current because the skill is inside the
    upgrade whitelist. `CLAUDE.md` is not, so those copies would have frozen
    at scaffold time — the identical trap that stranded root `DESIGN.md`.
    It now points at the skill for anything about the runtime and otherwise
    talks about the app, opening with a line the author is asked to replace.
  - `.scaffold/init.test.ts` is the contract, run by this repo's CI. It also
    pins the package.json invariants below, which no script can repair.
- **`DESIGN.md` → `epsilon/DESIGN.md`, and the runtime's notice →
  `epsilon/LICENSE`.** `epsilon:upgrade`'s whitelist is `epsilon/` and the
  skill, so a doc outside it freezes at the release you scaffolded from and
  silently describes a runtime that has moved on. The why now travels with
  the code it explains. See UPGRADING.md for the two stale copies to delete.
- **package.json stops leaking epsilon's identity into apps.** `version` was
  `0.9.3` and the description was this repo's pitch; both landed verbatim in
  every scaffold, so each new app claimed to be epsilon 0.9.3. Bun rewrites
  package.json *after* postinstall runs, so a script cannot fix this —
  the template's values ARE the app's values. `version` is therefore pinned
  at `0.0.0` (the app's field, for the app to set) and **the release of
  record is `epsilon.base`**, which is what `epsilon:upgrade` reads anyway.
  One fact, one field.

### Fixed

- `db/fn/` shipped as an empty directory, which git does not track — so no
  scaffold ever had one, and README's link to it was broken. It now carries
  a `README.md` with the folder's three rules (no schema DDL, a signature
  change needs a `DROP` in a numbered file first, order carries no meaning).
- `CLAUDE.md`'s layout named `src/`, which has never existed in this repo.
  The app is `index.ts` / `index.css` / `types.ts` / `app.test.ts` at the
  root, as `SKILL.md` correctly said all along.
- `epsilon:upgrade` now prints the link to the target release's
  `UPGRADING.md` — the by-hand half of an upgrade, which an app no longer
  carries a copy of.
- README no longer promises "three files" above a list of four, and no
  longer claims root `LICENSE` ships with every scaffold.
- **Two docs still sold `bind()` and `when()`, deleted in 0.9.0.** README's
  `ui.ts` row advertised both; it now names what `ui.ts` actually exports
  (`list()`, `text()`, `mount()`). Worse, `REFERENCE.md`'s gotcha list said
  "effects through a lens re-run on ANY root change — use `bind()` for
  scalars", which is the *inverse* of 0.9.0: `Lens.get()` tracks its own
  slice, so a lens read in an effect is the precise path. `SKILL.md` had it
  right and the deep manual contradicted it.
- README's runtime table listed 11 of the 12 runtime files — `passkey.ts`
  (343 lines of WebAuthn) was missing, though the prose above sells it.
- **`op.ts` finally has a test beside it.** It was the only source file
  without one, against README's "the tests are the contract" — and it holds
  the prototype-pollution guard. `op.test.ts` pins the escape round-trip and
  the `~1`-before-`~0` order that makes `~01` literal, the three forbidden
  tokens (including that `constructorName` stays legal), `add`-SETS-not-
  shifts, and that every op's undo restores exactly what changed. It also
  pins a deviation nothing had written down: `"/"` is the ROOT here, not
  RFC 6901's empty-string key, so an empty-string key is unaddressable.
- **`popDisposeScope`'s disposer stranded every disposer behind a thrower.**
  It ran `disposers.forEach((d) => d())`, so one throwing disposer skipped
  the rest — and a skipped disposer is a leaked subscription. It now isolates
  errors and rethrows the first, the policy `drain()` already used two
  hundred lines up. One policy, not two.
- **`OpsHandler`'s `undefined` arm was unreachable.** `notify()` has one
  caller — `apply(ops: Op[])` — and `set()` routes through it as a root
  replace, so a handler never saw `undefined`. The type, the arm in
  `Lens.onOps`, and the dead branch in `list()` are gone; a snapshot is an
  op like everything else.
- **The demo clobbered your caret mid-rename.** `index.ts` rewrote the board
  title from the doc ROOT on every op, so anyone's card add re-ran it. Fixed
  the 0.9.0 way — narrow to `/name` with `at()`, then read — plus an
  `activeElement` guard, because a *remote* rename still lands while you type.
- **"use a passkey" raced the autofill request it was cancelling.** Opening
  the sign-in dialog starts a *conditional* `navigator.credentials.get()`
  that stays pending for autofill. The button called `conditionalAbort.abort()`
  and issued a modal `get()` on the next line — but `abort()` does not settle
  synchronously, so the second request could land while the browser still
  held the first, which it rejects outright. Intermittent by construction,
  and it presented as "the passkey button doesn't work". The abort is now a
  handshake before any modal ceremony, registration included (`create()`
  collides with a pending `get()` the same way) — and a **bounded** one: it
  waits up to 250 ms for the browser to release the request, then proceeds
  regardless. That bound is load-bearing, not caution. The first attempt at
  this awaited the in-flight run unconditionally, the autofill path awaited
  the same promise it was itself producing, and it deadlocked: every click
  hung on the handler's first line with no sheet and no error. A late release
  costs one rejected request, which reports itself in the dialog; an
  unbounded await costs the whole feature.
- `pg.ts` cited `DEPLOY.md` for the deploy recommendation. No such file has
  ever existed in this repo; the reference is now README's "Deploying".
- `ui.ts`'s `mount()` docs still told readers about `bind()` and `when()`,
  removed in 0.9.0.

## [0.9.3] — 2026-08-02

### Fixed

- **The scaffold's own test failed the moment an app adopted `db/fn`.**
  `pg.test.ts` asserted `migrate()` returns `[]` on a second run —
  "idempotent: nothing re-runs". `db/fn` always replays, by design, so a
  vendored copy of that test breaks in any app that uses the feature. It
  now filters the `fn` entries: the LEDGER is idempotent, the vocabulary is
  replayed, and those are different claims. Found by japan, whose 23
  vocabulary files turned one assertion into a 140-line diff.

## [0.9.2] — 2026-08-02

### Fixed

- **`db/fn`'s DDL gate matched statements INSIDE function bodies**, which
  made it refuse the very files it exists for. The check ran over raw file
  text with `^…/m`, so a body containing `INSERT INTO`, `UPDATE …` or
  `DELETE FROM` at the start of a line tripped it — and every real dispatch
  function is full of those. It refused **six of japan's twenty-three**
  functions on the first real migration, including `trip_apply`, the
  function the whole feature was built for.

  Dollar-quoted bodies are now stripped before the test: a statement inside
  a function is not a statement the file executes. 0.9.0's tests only used
  `SELECT`-bodied one-liners, so nothing caught it until real SQL arrived.

## [0.9.1] — 2026-08-02

### Fixed

- **`batch()` is back.** 0.9.0 removed it on the reasoning that
  `apply(ops[])` "already batches the only channel an app writes through."
  That was wrong: an app also holds plain local signals, and two `.set()`
  calls on two DIFFERENT signals are not ops on one doc — nothing else
  coalesces them. The scan that found "one call site, its own test" ran
  against committed code while the real consumer was still in a working
  tree, so the removal looked safe and wasn't. japan's `client/line/line.ts`
  broke on the upgrade: `batch(() => { me.set(user); refused.set(""); })`.
  Restored with tests that pin the coalescing and the throw path.

  The lesson is the removal criterion, not the function: "no call sites"
  measured across one repo at one moment is not evidence of no consumers.

## [0.9.0] — 2026-08-02

The first release that ends **smaller than the one before it**: 3,834 →
3,768. Nine releases had each added while the pitch that justifies
vendoring says "small enough to read", and nobody was measuring. Two
concepts deleted, one grain inverted.

### Changed

- **A lens tracks its own slice, and `bind()` is gone.** The skill said, in
  bold, in its rules section: *"`list()` for collections, `bind()` for
  scalars… no effects that rebuild rows from `doc.data`."* The only
  production app answered with **116 effects and zero binds**.

  That is not the app being wrong. `Lens.get()` delegated tracking to the
  ROOT — DESIGN.md called it "known v0 looseness" — so an effect over a
  lens re-ran on every unrelated write. Correct, never minimal. `bind()`
  existed to buy back precision the ops channel already had, and nobody
  paid, because cheap-and-correct beats precise-and-correct every time.

  `Lens.onOps` already knew exactly which ops reach a slice: it rebases
  descendants, collapses ancestor writes, skips siblings. `get()` threw all
  of that away. It now tracks a per-lens tick fed by that same `onOps`, so
  `effect(() => …lens.get())` **is** the precise scalar path — and `bind()`
  had nothing left to do. The cheap path is now the correct one, and nobody
  has to read a rule.

  This is 0.7.0's own lesson applied to ourselves. That release found an
  agent following the grain — *"a dead read cost five lines, a live one
  forty"* — and **inverted the grain instead of restating the rule.**
  Nobody had done it for `bind`; restating was tried in three documents and
  failed 116 times. DESIGN.md now carries the rule: *do not restate a rule
  the grain fights — change the grain.*

  One cost: a lens read reactively outside a dispose scope now warns,
  because it holds a subscription. Same rule `list()` already had.

### Added

- **`db/fn/` — a function body is not a migration.** Forward-only exists
  because DDL is not replayable: a `CREATE TABLE` cannot run twice.
  `CREATE OR REPLACE FUNCTION` can — that is what `OR REPLACE` means.
  Applying one rule to both is the most expensive mistake in the stack, and
  it is measurable: japan defines `trip_apply` **ten times** to express one
  function, 79% of its `db/` is function bodies, and the copy-per-edit
  ritual has already produced a silent data-visibility bug (a later file
  copied an older body over a widened one and un-shared every board).

  `db/` now splits by what the SQL *is*. `db/NNN-*.sql` stays schema —
  numbered, hash-recorded, forward-only. `db/fn/*.sql` is vocabulary:
  unnumbered, never recorded, replayed wholesale every boot, **edited in
  place** like the TypeScript beside it. The numbered pass runs first, so a
  function may reference a table the same boot created.

  Three properties make it safe rather than merely convenient. **Order-free:**
  SQL bodies are validated at CREATE time, so a function calling another
  would otherwise depend on filename order — the pass runs the set twice in
  one transaction, once with `check_function_bodies = off` so everything
  exists, once with it ON so every body is still validated against the
  complete vocabulary. (One pass would have traded an ordering bug for a
  worse one: a typo installing silently and failing at call time, in front
  of a user.) **Atomic:** one transaction for the directory — a
  half-swapped vocabulary is worse than an old one. **Schema DDL is
  REFUSED**, not warned: it cannot survive a second boot, so `migrate()`
  throws naming the file and the fix, rather than letting Postgres say
  "relation already exists" from inside a two-pass swap.

  A signature change still needs a number — `CREATE OR REPLACE` cannot alter
  a return type or an argument name — and the failure says so, with the
  `DROP FUNCTION IF EXISTS` line to write. Pinned in migrate.test.ts (replay,
  edit-in-place, order-freedom, atomic rollback, the signature trap and its
  documented fix, the DDL refusal) and driven on the embedded engine in
  pglite.test.ts, because the vocabulary pass is ordinary Postgres but PGlite
  is a wasm build and assumptions there are worth nothing.

  Opt-in and backwards compatible: no `db/fn/` directory means no change.
  epsilon's own `001`–`005` and `100`/`101` keep their bodies where they are
  — moving them would change those files' hashes and every deployed ledger
  would refuse to boot. [UPGRADING.md](UPGRADING.md) has the per-function
  migration recipe (copy the NEWEST body, touch no numbered file).

### Removed

- **Four exports that paid no tax** (−80 lines). `applyOps` had zero call
  sites and duplicated the unwind loop in `Signal.apply` verbatim.
  `untrack` had zero call sites, tests included. `batch` had exactly one —
  its own test — and cost two module globals plus a branch in `notify()`,
  which runs on every op; it is railroad's API for coalescing independent
  `.set()` calls, and an epsilon app writes through `apply(ops[])`, which
  already batches. `migrationStatus` had one caller, its own test.
- **The router's hash refcount** (−8 net). railroad tore the hash signal
  down when the last router disposed; that was twenty lines of bookkeeping
  wrapped around a latent bug — a computed already returned by `route()`
  closes over the nulled signal and silently stops updating. A page has one
  hash for the life of the page. Own it once.
- **`bind()`** — superseded by the lens fix above. `ui.ts` is three
  primitives now (`text`, `list`, `mount`) rather than five.
- **`when()`** — shipped in 0.8.0, never prescribed in any document, and no
  consumer in any app by 0.9.0. Two days old.
- **The bare `Promise<Node>` route handler.** The file documented it as
  leaking in the stack's own terms (post-await bindings have no owner scope
  — browser JS has no AsyncContext). Shipping a shape whose own docs say
  not to use it is worse than refusing it: async handlers now resolve to a
  thunk, `() => Node`, and the error says so.

### Not done, and why

- **Boxing the signal's value** (the review's −12). It would delete the
  root-op special case in `Signal.apply` by storing the value in `{v: T}`
  so `""` is just another key. It is genuinely twelve lines smaller and
  slightly harder to read — every access in the hottest class gains an
  indirection, and "the value lives in a box so root ops aren't special" is
  cleverer, not clearer. Its stated bonus was that `applyOps` would stop
  being dead; deleting `applyOps` collected that instead. Against a pitch
  that says *small enough to read*, twelve lines is not worth the sentence
  you have to hold in your head.

## [0.8.1] — 2026-08-02

A shakedown review (7 dimensions, each adversarially verified) found a hole
in the protocol, a bug the poll path had been quietly covering for the
listen path, a throttle keyed on the wrong thing, and three published
numbers that were false. [UPGRADING.md](UPGRADING.md) is new and has the
per-release trail — nothing here needs a migration, and nothing breaks.

### Added

- **`doc.write(ops)` — the answered write.** `apply()` returns void, which
  is exactly what makes one call work on a signal, a lens and a remote doc
  alike; the shadow of that is a writer who cannot learn the id storage
  minted. Every app grew the same workaround: watch the echo and guess
  which row is yours by matching its VALUE — japan's is 21 lines with a
  ten-second timeout, and the CLI does it too (`cli.ts`, "the first ops
  after my apply are mine"). Two people adding "Kyoto" in the same second
  guess wrong.

  `write()` resolves with the RESOLVED ops — server-minted ids in their
  paths — and rejects when the authority refuses. On the wire it is the
  ops frame plus an optional `id`, answered on the SAME frame shape a
  `call()` uses, so there is no second message shape and the client's
  existing reply demux handles it unchanged. Without an id the frame
  behaves exactly as before: `apply()` is untouched, on the wire and in
  its silence.

  It lives on `DocHandle` ONLY, never on `OpSignal` or a lens — `Lens.apply`
  delegates to the root and returns void, so a lens cannot honour the
  contract and pretending otherwise would break the one-write-path rule.
  Pinned in doc.test.ts (including two clients racing on the same value,
  each getting its own id) and in rel.test.ts against a real Postgres
  sequence.

### Fixed

- **A refused WRITE is now distinguishable from a refused OPEN.** Both
  arrived as `{doc, error}`, so the only way to tell them apart was to read
  the error prose — which japan does, in a chain of string matches ending
  in "Everything else … is a refused WRITE." The frame now carries
  `write: true`, surfaced as a third `onError(doc, error, meta)` argument;
  two-argument handlers still compile. A rejected write also stops settling
  the doc's `ready`, which it never should have — the doc is open and
  working, one write was refused.
- **A doc that died while the LISTEN connection was down is noticed on
  reconnect.** `doc_drop` deletes the op log, so the reconnect's catch-up
  found nothing and reported success over a doc that no longer existed:
  every sibling process went on hosting and serving a deleted board until
  it restarted. The poll path has had a death-detector since 0.6.0; the two
  delivery modes now share one, hoisted to `pgSync` scope. The regression
  test drives it honestly — it terminates the real LISTEN backend, drops
  the doc while the socket is down, and waits for the reconnect. Verified
  to TIME OUT with the fix removed.
- **The auth throttle is keyed on IP *and* email, not IP alone.** Behind a
  PaaS edge — which DEPLOY.md recommends — `remoteAddress` is the load
  balancer, so the defaults gave ALL users combined ten login attempts a
  minute, and one person fat-fingering a password locked out the rest.
  Keying on the identity under attack splits that namespace. Deliberately
  NOT per-socket, which the review proposed: a per-socket counter resets by
  reconnecting, which is no throttle at all. The overflow eviction now
  drops only EXPIRED slots first, so flooding the map can no longer reset
  everyone's window in one `clear()`.

### Changed

- **"~1.7k lines" was 3.8k**, in README, package.json and the skill
  description — the number that justifies vendoring at all, true at v0.2.0
  and never revised, and copied into every scaffold. Corrected in all
  three. DESIGN.md already budgeted JSX against "past 4k" in the same
  release, so the repo was contradicting itself.
- `UPGRADING.md` (new) carries the per-release upgrade trail: what
  `epsilon:upgrade` handles, and what it deliberately does not (`db/`, app
  files) and therefore needs from you by hand.

### Known, not fixed here

Queued for 0.9.0, where they can have their own migration note:

- **`db/fn/` — stop treating a stored function body as a migration.**
  Forward-only exists because DDL is not replayable; `CREATE OR REPLACE
  FUNCTION` is. Applying one rule to both is the most expensive mistake in
  the stack: japan defines `trip_apply` ten times to express one function,
  79% of its `db/` is function bodies, and the ritual has already produced
  a silent data-visibility bug.
- **Four exports that pay no tax** — `applyOps` and `untrack` have zero
  call sites anywhere; `batch` and `migrationStatus` have exactly one each,
  their own tests. Removing exports is a breaking change, so they wait for
  a minor.

## [0.8.0] — 2026-08-01

The top of the stack, taken back from railroad. Epsilon's claim is that it
merges delta and railroad — and comparing two real apps showed the second
half of that was not true. `hump` (railroad) has a list view and a detail
view; `japan` (epsilon) has one page, because epsilon's whole UI surface
was `list`/`text`/`bind` and there was nowhere else to put anything. Three
primitives become five, and none of it is new invention: it is railroad's,
ported with its scars.

### Added

- **A router** (`epsilon/route.ts`) — `routes` / `route` / `navigate` /
  `matchRoute`, exported from `epsilon/index.ts`. The gap was found by
  comparing two real apps: `hump` (railroad) has a list view and a
  per-itinerary view because railroad hands it `routes()`; `japan`
  (epsilon) navigates between journeys with `location.href = "?t=5"` and
  `location.reload()` — a full reload of a WebSocket app, re-auth and
  re-open every doc, because epsilon's UI surface was `list`/`text`/`bind`
  and nothing else. Its one-page information architecture is partly a
  consequence.

  Ported from railroad 0.11.0 **whole**, not rewritten: epsilon's
  `signal.ts` already exports the exact primitive set railroad's router
  imports (`Signal`, `signal`, `computed`, `effect`, the dispose-scope
  trio), so the port is an import path and the log prefix. What came with
  it is the reason — the async scope balance (never leave a scope pushed
  across an await, or a parent pops the wrong one and teardown recurses),
  the run-id guard that drops a stale resolution after navigation, and an
  idempotent dispose that can't drive the shared hash refcount negative.
  Those were found the hard way once already.

  Hash-based, deliberately: epsilon serves its own HTML from `Bun.serve`,
  and a History-mode router needs a catch-all on every deployment plus a
  rewrite on every static host in front of one. Hash costs neither and
  works the day you scaffold. History mode is a live question, not a
  closed one.

  The property that matters for a doc app is pinned in `route.test.ts`:
  `/trips/1` → `/trips/2` updates `params$` and does **not** re-run the
  handler, so a route opens its doc once and lets the lens follow the
  param — rather than closing and re-opening the subscription on every id
  change.

- **`when()` and `mount()`** (`epsilon/ui.ts`), also ported from railroad.
  `when(cond, truthy, falsy?)` swaps on the TRUTHINESS transition only — a
  branch that stays truthy keeps its nodes and its bindings, so a value
  change inside it flows through a lens rather than rebuilding, which is
  the same rule `list()` already follows for membership. `mount(target,
  render)` is the app root: it brackets a dispose scope so the scope rules
  hold all the way down, and returns the disposer that unwinds it. Without
  one, a top-level `bind()`/`list()`/`when()` had no owner — which is what
  they have always warned about, with no answer in the box until now.

- **An SVG diagnostic** (`epsilon/ui.ts`). SVG has always WORKED — japan
  draws seventy stations through `list()` — because a caller building rows
  with `createElementNS` hands over nodes already in the right namespace.
  The hole was the other path: an element built with `document
  .createElement("circle")` lands in an SVG parent as HTML and never
  paints, silently. `list()`, `when()` and `mount()` now say so, and name
  the fix. They do NOT rewrite it: railroad can adopt the namespace only
  because its props system re-applies every reactive binding to the
  recreated element, and epsilon has no props system — a recreate here
  would drop whatever the caller attached by hand, `addEventListener`
  above all. Losing a click handler is worse than the bug being fixed.
  Pinned both ways in `ui.test.ts`, including that the reported node stays
  in the tree with its listener live, and that `<foreignObject>`'s HTML
  children pass without a word.

### Changed

- **The demo app is routed** (`index.html`, `index.ts`, `app.test.ts`) —
  which is how the router earned the release rather than just passing its
  own unit tests. The demo had grown its OWN router: `openBoard` wrote
  `location.hash`, a regex parsed it back, and a `hashchange` listener
  dispatched. That is the ad-hoc thing `routes()` exists to delete, and
  it was sitting in the template being copied into every scaffold.

  Now `<main id="view">` is the route target, `/board/:id` is the board
  and `/` is a placeholder, and `navigate()` replaces every direct
  `openBoard` call. The board list and tally stay outside the target and
  remain visible — list beside detail, not list THEN detail.

  Two things the wiring taught, both now commented where they bite:
  handlers must hold element REFS rather than call `getElementById`,
  because routes() appends the fragment after the handler returns; and the
  boot hash must be set BEFORE routes() reads it — `location.hash` updates
  synchronously but `hashchange` does not fire until a later task, so
  routing through the event renders the placeholder and flashes.

  `app.test.ts` drives all of it in a real browser: a cold load resolving
  to `#/board/1` with no flash, the view swap in both directions
  (`#board-name` existing or not IS the swap), and the board coming back
  live — its `list()` re-rendering a card written before the round trip.
  The pre-existing `history.back()`/`forward()` and `←` assertions pass
  unchanged, which is the real proof: navigation behaviour is identical,
  the hand-rolled router is just gone.

### Fixed

- `ui.test.ts` registered happy-dom unconditionally. `bun test` loads every
  file into one process and load order is not the order in the test script,
  so a second DOM suite made whichever body ran second throw
  ("Happy DOM has already been globally registered"). Both registrations
  are now conditional, and both files pass alone and together.

## [0.7.1] — 2026-08-01

### Added

- **The tally view, wired into the demo app for real** (`db/101-tally.sql`,
  `server.ts`, `types.ts`, `index.*`). `pgView`'s worked example (0.7.0)
  had only ever run inside `view.test.ts` — `tally_open` composes counts
  over your own boards, `pgView(host, db, "tally:", { open: "tally_open",
  on: ["board:", "mine:"] })` hosts it, and a quiet line under your board
  list (`2 boards · 5 cards · 1 done`) renders it live, the same
  `effect()`-over-`.get()` binding as `#board-name`. A new migration, not
  an edit to `100-board.sql` — that file was already applied on real
  databases, and `migrate()`'s forward-only hash check caught exactly
  this the hard way. Pinned end to end in `app.test.ts`: a real browser,
  real Postgres, the tally moving as boards and cards do.
- **A `←` button back to main** (`#board-header`), next to the board
  title: deterministic, unlike `history.back()` — a reload or a
  bookmarked board link has no history to use. Hidden while already on
  `board:1`.

### Changed

- **Every ✕ confirms first.** Card, member, and board removal all go
  through `<dialog id="confirm">` — not `window.confirm()`, which stays
  invisible to `app.test.ts`'s `Bun.WebView` the same way it would to a
  real user's script blocker; a DOM dialog is stylable and driveable by
  the same clicks the auth dialog already uses. The message names what's
  actually at stake: a board you own says "this removes all its cards",
  a shared one says "leave" instead of "delete" — `mine_apply`'s own
  owned-vs-shared distinction, said out loud before it happens.

## [0.7.0] — 2026-08-01

Nouns are docs, and the law is a harness. Both grew from the same japan
observation: the journey list was first built as a `call()` returning rows
— a dead read that had to be *asked* to be made live. The agent didn't
fail; it followed the grain (a dead read cost five lines, a live one
forty). This release inverts the grain and hands the design's one law to
app authors as a tool.

### Added

- **Declared read views** (`pgView`, in `epsilon/pg.ts`). The rule:
  `call()` is for VERBS — anything you render is a noun, and a noun
  arrives as a doc, live, permitted, versioned. When no doc exposes what
  a screen needs, one app SQL function plus one line declares a view:
  `pgView(host, db, "tally:", { open: "tally_open", on: ["board:",
  "mine:"] })`. The function is composition AND permit (001's rule —
  NULL user composes the host's copy, NULL result refuses as "unknown
  doc", re-asked at every open); `on` names the dependency prefixes whose
  commits — and deaths — recompose it. Read-only (writes refuse), no docs
  row, no op log; per-identity views are per-identity NAMES
  (`tally:<uid>`), like `mine:<uid>`. Recompose is eager by design and
  bounded three ways: eviction (a view composes only while watched),
  per-name coalescing, and an equality skip (a doorbell that changes
  nothing pushes nothing — jsonb's canonical key order makes that one
  string compare). Delivery is pgSync's in both modes: LISTEN taps the
  doorbell; poll (the embedded tier) sweeps the dependencies' version
  rows, hosted or not, only while a view is watched. Pinned by
  view.test.ts (wire: LISTEN, poll, permit probes while live, the
  equality skip, eviction/recompose) and a PGlite drive in
  pglite.test.ts.
- **The law harness** (`epsilon/law.ts`). The doc kit made writing a
  type ~30 lines; nothing made proving one cheap — and every field-report
  defect (the silent FK cascade, the un-widened `done` echo) was a law
  violation caught by hand. `proveLaw({ handle, name, sql, batches,
  mirrors?, undo? })` drives batches over the REAL wire — one per
  dispatch branch, functions of current data, closing over test state
  where a restore needs its remove's row — and after every echo asserts
  the client copy deep-equals `doc_open(name)` recomposed from the
  tables. With `undo` wired each batch is undone, checked, redone,
  checked (types that record no undo skip gracefully); `mirrors` must
  converge to their own recompute. The FAILURE TEXT is the interface:
  differing paths, the last echo, and the defect class named
  (unexpressed cascade → `doc_cascade_remove`; a sibling column
  disagreeing beside an echoed path → widen the echo to the whole row).
  Dogfooded: rel.test.ts's law describe is now a `proveLaw` call —
  stronger than the hand-rolled drive it replaced (undo/redo of every
  batch, the rename mirror) — and the todo type's drive is the minimal
  recipe an app copies. Pure halves (deepEquals, diff, classify) pinned
  without a database in law.test.ts.

### Changed

- **Two decrees, recorded in DESIGN.md.** Per-viewer composition is
  promoted from "known limit" to a NON-GOAL: a doc reads the same to
  everyone permitted to read it — different views for different people
  are different doc names, minted per identity; per-subscriber recompose
  would fight "express the change, never recompose". And "no arbitrary
  live queries" is amended to "no UNDECLARED live queries" — `pgView` is
  the door a declared one walks through.
- **Presence's multi-process limit is stated, not hidden**: per-process
  means presence under-reports behind a load balancer — each process
  shows only its own sockets' watchers. "Scaling up is a config change"
  holds for docs; presence is the one exception, documented in DESIGN.md
  and left for a field report to justify fanning out.
- Stale embedded-tier notes corrected (`pglite.ts` header, REFERENCE.md):
  both still said pgSync is skipped/unnecessary on the embedded engine —
  contradicting 0.6.0, which made poll-mode sync the embedded tier's
  delivery path. The skill gains the two rules with teeth: *about to
  render data? open a doc — if none exposes it, add a view, never a
  fetch*; and *pin every new doc type with `proveLaw()`*.

## [0.6.0] — 2026-07-31

The third japan field report, absorbed. A month deployed with eight real
users on the embedded tier; three of these are bugs it found in shipped
behavior, two are features it grew that belong in the box.

### Fixed

- **A queued call could overtake its own authentication** (`epsilon/doc.ts`).
  `connect()` flushed calls queued before the socket opened *ahead* of the
  `onConnect` hook — and every call a one-shot CLI command makes is issued
  in the same tick as `connect()`, so it landed on a session-less socket.
  Symptom: a valid owner session refused all evening. The hook now runs
  first; its own calls send directly, the socket being open by then.
- **The embedded tier delivered no mirrors** (`server.ts`). `pgSync` was
  started only for a `pgUrl`, on the reasoning that PGlite has no sibling
  processes — true, and beside the point. Sync is the delivery path for
  every commit made OUTSIDE a doc's own write hook, and the commonest is a
  MIRROR: `board_apply` writing into `mine:<uid>` in the same transaction.
  The write hook re-enters the doc it wrote; nothing re-enters the sibling.
  Symptom: a share landed in the tables and the member's list never moved
  — *refresh included*, because a doc another socket still watches is
  served the hosted snapshot, not a fresh composition. The embedded tier
  now polls its own in-process database (250ms); `startServer` returns the
  `sync` handle. Pinned twice: the mechanism, and the wiring that omitted it.

### Added

- **`connect()` gains `onDisconnect(willRetry)`** — the symmetric half of
  `onConnect`, fired on every close; false only for a deliberate
  `remote.close()`. Doc signals KEEP their last value across a drop (the
  reconnect's snapshot is what resets them), so anything rendered as live —
  presence, a connection dot — must hear the drop from the hook or it goes
  on testifying to a state nobody is in.
- **Who changed what.** Two halves, cleanly split. HISTORY is core:
  `doc_history` joins the doc kit beside `doc_undo` — the op log read back,
  newest first, paged by VERSION cursor (`before` walks back, `after` tops
  up an open panel), names JOINed at read time so a member who has since
  left is still named honestly. The permit is `doc_open`, the same question
  the wire's default gate asks at every open, so history can never be a side
  door and no doc type has to remember to guard it; `pgHistory(host, db)` is
  the whole wiring, and the audit was already being written for every op.
  STATE is app schema by nature — `updated_by`/`updated_at` on the row,
  stamped by the type's dispatch, surviving the op-log prune; `100-board.sql`
  gains it on cards as the worked example, along with a `card_json` helper so
  the wire shape has ONE definition. Two traps documented in the kit and the
  skill: an op that also stamps changes more columns than its path says, so
  its echo must widen to the whole row (the `done` branch did) or clients
  disagree with a recompute; and a RESTORE takes the stamp from the value,
  so undo puts the row back rather than re-attributing it to the undoer.
- **The operator's door** (`pgAdmin`). The embedded database has no port, so
  the CLI is the only way into a live deployment: `call admin {"sql":"…"}`,
  gated by `EPSILON_ADMIN` (registered emails). NO LIST, NO DOOR — unset and
  the method is never registered, so a deployment that didn't opt in has
  nothing to attack. When it IS configured, refusals SPEAK rather than
  hiding behind a uniform missing-method reply: the no-oracle rule earns its
  keep on doc names, which strangers can probe, but this door is only
  reachable by an authenticated socket, and an operator who cannot tell "not
  signed in" from "not on the list" from "not deployed" spends the evening
  guessing which. Born the night a typo'd registration could be neither
  found nor repaired. The frame is bounded (500 rows, and it says when it
  truncated); writes bypass the op log — right for users and sessions,
  reload-worthy for doc tables.

### Changed

- `db/003-doc-kit.sql` grows `doc_history` IN PLACE rather than shipping a
  006 (migrations are day-zero truth, not a diary — 0.3.0's rule, applied
  again while the change is still unreleased). No deployed app is disturbed:
  `epsilon:upgrade`'s scope is `epsilon/` and the skill, NEVER `db/`, so an
  existing app's migrations and ledger come through an upgrade untouched —
  there is no hash drift to heal. Adopt history when you want it by copying
  the one function body into your next app migration; it is `CREATE OR
  REPLACE`, so it re-applies cleanly. New scaffolds are born with it.

## [0.5.1] — 2026-07-30

### Fixed

- **Emails normalize — trimmed and lowercased at every door** (a japan
  field lesson: an address registered as "Pete@…" on an autocapitalizing
  phone couldn't log in as "pete@…", and a member shared with a cased
  email read as an unknown user). `register` STORES `lower(trim(email))`;
  `login`, passkeys' `credential_list`, and both member-by-email lookups
  in `board_apply` COMPARE the same way — a cased duplicate registration
  now refuses as "already registered" instead of minting a second
  identity. Fixed in place in `002-auth.sql`/`100-board.sql` (a bug fix,
  not a new migration — CREATE OR REPLACE re-applies cleanly). Deployed
  apps adopt by copying the four function bodies into their next app
  migration, plus a one-line heal for existing rows:
  `UPDATE users SET email = lower(trim(email));` (check first for rows
  that differ only by case — those are the japan duplicates to merge).
  Logout was audited on the same pass: the sign-out button, CLI command,
  and `session_end` are all present and pinned.

## [0.5.0] — 2026-07-30

### Security

- **A subscription never outlives its permit.** Two lingering shapes, one
  fix. Deletion: a `doc_drop`ped board stayed hosted wherever it had
  watchers — rendering forever, no push. Revocation: a removed member kept
  receiving board (and presence) broadcasts until they closed the doc.
  The wire needed no new vocabulary — the eviction push is a root replace
  to **null**, the value every doc holds before its first snapshot, so
  clients and `ui.ts` already render it and gone reads exactly like
  never-there. `host.drop(name)` un-hosts a deleted doc (every watcher
  nulls and is unsubscribed); every process learns — the writer from the
  apply result (`doc_drop` now returns the name; `mine_apply` lists it as
  `gone`, which covers PGlite and poll mode), siblings from `doc_drop`'s
  new doorbell (`{name, gone}`), and a polling host notices a known row
  that stops coming back. `host.expel(name, user)` re-asks the doc's
  `open` gate and evicts on refusal — the permit at open time and eviction
  time is the same question; `server.ts` wires member-remove echoes to
  expel the board AND its presence, on every process hosting them. The
  board view on screen falls back to the shared board when its doc goes to
  nothing. Pinned across doc.test.ts (wire), rel.test.ts (both processes;
  live revocation), and pg.test.ts (poll).

### Added

- **Upgrades — taking a new epsilon is mechanical** (the japan field
  report, absorbed into DESIGN.md "Upgrades"). package.json records the
  release you scaffolded from (`"epsilon": { "base": "v0.5.0" }`, kept in
  step by the release flow); `bun run epsilon:upgrade`
  (`epsilon/upgrade.ts`) fetches upstream and three-way applies
  `git diff <base> <target>` over a whitelist — `epsilon/` and the skill,
  never `db/`, never app files — so local patches survive and genuine
  divergence surfaces as conflict markers; it ends by stamping the new
  base and running the vendored tests. Pinned by upgrade.test.ts with
  fixture upstream/scaffold repos.
- **Migration policy, now binding**: released core migrations (001–099)
  freeze forever; new core behavior ships as the next numbered file, which
  a deployed app adopts by copying that one file. App migrations start at
  100 — the board/mine types moved to `db/100-board.sql` (re-applying
  under the new name is idempotent; the old `005-board.sql` ledger row is
  inert), and `migrate()` warns when a sub-100 file isn't upstream's.
  `doc_drop`'s upgrade ships as `db/005-gone.sql` accordingly — 003/004
  are untouched, so existing ledgers stay clean.
- **Prune heartbeat**: `epsilon_prune()` runs daily after boot (unref'd
  timer — tests and short runs exit freely; an external cron remains
  fine). Closes the last DESIGN.md open item.

### Changed

- A dispatch that `doc_drop`s other docs should collect the return value
  into its result — before: `PERFORM doc_drop('board:' || v_bid);` after:
  `v_gone := v_gone || doc_drop('board:' || v_bid);` returned as
  `doc_commit(...) || jsonb_build_object('gone', to_jsonb(v_gone))` (see
  `100-board.sql`'s `mine_apply`). Without it, deletion still works — the
  writing process just relies on the doorbell instead of un-hosting
  immediately (and PGlite/poll writers keep the doc hosted until eviction).

## [0.4.0] — 2026-07-29

### Added

- **Passkeys — passwordless sign-in by default** (`db/002-auth.sql` +
  `epsilon/passkey.ts`, zero dependencies). Register with a password once
  (the identity anchor, and the CLI's door), click "add a passkey" while
  signed in, and sign in without a password ever after — Touch ID, Windows
  Hello, security keys. The boundary rule applied to auth: SQL owns
  identity and state (credentials beside users and sessions; the clone-
  detecting counter policy inside `credential_use`), TS owns the ceremony
  — pgcrypto has no ECDSA, so WebCrypto verifies, and the attestation
  CBOR is read by a ~60-line vendored decoder. Challenges live on the
  socket (single-use, die with the connection — no table); ceremonies
  bind to the socket's own Origin by default, `pgPasskey(host, sql,
  { origins })` pins it in production. The dialog gains "use a passkey"
  (an email narrows to that account; empty offers the browser's resident
  keys) plus CONDITIONAL UI: while the dialog is open, the email field's
  autofill offers a passkey only when the browser actually holds one — a
  first run never meets the empty cross-device sheet. The header gains a
  quiet "sign out" (the `logout` method existed; the button didn't).
  Pinned by a SOFTWARE authenticator suite — real CBOR
  attestations, DER-wrapped P-256 assertions, the full tamper matrix
  (challenge, origin, signature, replay, counter regression) — no browser
  required. TOTP was considered and declined: passkeys supersede
  password+TOTP, and pgcrypto-hmac TOTP can be a later recipe if wanted.
- **`.epsilon.pid`** — a real boot (`bun dev`, production) writes its pid
  and removes it on SIGINT/SIGTERM; `bun run stop` kills exactly that
  process. Tests spawn many servers and deliberately don't touch it.

## [0.3.2] — 2026-07-29

### Security

- **Presence no longer outlives its permit.** The presence factory checked
  `board_may` only at FIRST open; while `presence:board:<id>` stayed
  hosted (its board occupied), any authenticated socket could open it —
  reading who's on a private board and being written INTO it as "here" by
  the subscribe hook. The factory now fits an `open` gate that re-asks
  `board_may` per socket, pinned by a wire test that probes while the doc
  is live. Stated as a rule (DESIGN, REFERENCE): a factory refusal guards
  only the first open — an in-memory doc whose factory checks a permit
  needs the SAME permit as its open gate (relational docs get this by
  default via `doc_open`).

### Fixed

- Test databases are namespaced by app (package.json name): every scaffold
  inherited the literal `epsilon_test_*` names, so a scaffold sharing the
  template's dev Postgres re-applied ITS migrations into the TEMPLATE's
  test databases — ping-ponging the ledger and failing whichever repo ran
  second with hash drift (found when a real scaffold did exactly that).
  The template still uses `epsilon_test_*`; a scaffold now derives
  `<name>_test_*`. Existing scaffolds: re-copy the three `epsilon/*.test.ts`
  DB suites and `app.test.ts`, or point `EPSILON_TEST_PG_URL` at your own
  database.

### Changed

- **The face is designed now, not defaulted.** The demo app goes
  monospace — the CLI is a first-class client, and the browser drives the
  same wire — over a cool paper ground with ONE accent that means "live":
  the ε wordmark, a presence dot, prompt glyphs on the inputs (`+` adds,
  `@` shares), and the signature: a new row FLASHES once as its echo
  lands, pure CSS, so the two-tab demo shows the op stream arriving.
  Done rows mute via `:has()`, the editable title hints on hover, focus
  is visible everywhere, reduced motion respected, dark mode stays
  first-class (slate + teal, not black + acid). Structure and ids are
  untouched — `app.test.ts` drives the same DOM. Plus a viewport meta,
  `lang`, and an ε favicon (killing the 404).

### Added

- README "Deploying": `railway.json` explained at last — the worked deploy
  example (config-as-code: start, healthcheck, restart), the volume +
  `EPSILON_PG_DIR` recipe, inert off Railway. It had only ever been
  described in this changelog, which is a diary, not a manual.

## [0.3.1] — 2026-07-29

### Added

- `LICENSE` (MIT, © 2026 blueshed.co.uk) — the repo declared MIT but
  carried no notice, and MIT requires it in every copy; scaffolds are
  copies, so it ships with them. README's Lineage now credits the third
  collaborator: built in conversation with Claude Code.

## [0.3.0] — 2026-07-29

Driven by a field report: a real app (a shared journey planner for eight
people) built on the template in one sitting and deployed on the embedded
tier. Its §1 was a live security defect caught in a deploy rehearsal.

### Security

- **The open gate can no longer be forgotten — or go stale.** `pgDoc`'s
  wire gate now DEFAULTS to `doc_open(name, user) IS NOT NULL`: the
  composition function is the permit (001's rule), asked fresh at EVERY
  open, so ownership and membership changes bite at the next open with
  zero app code. Previously an omitted `guard` served the hosted snapshot
  to any authenticated socket — and the natural factory for a *claimable*
  doc (`owner == null ? undefined : …`) fitted no guard while unclaimed,
  then failed OPEN, silently, once claimed, because options were captured
  at hosting time. `guard` remains as an override only; never compute one
  from row state read at hosting time.

### Added

- **Undo**, in the doc kit. `doc_ops.undo` (001) records each write's
  inverse, built by the dispatch loop (one before-read per mutating op —
  O(change), no snapshots); `doc_commit` (003) grows the parameter.
  `doc_undo(doc, v|NULL, user, apply)` reverts a version — NULL means the
  asker's LATEST undoable write — by dispatching the stored inverse
  through the type's own apply: the permit is re-checked, mirrors re-fire,
  and the commit it makes records the redo (undo the undo). It REFUSES,
  never clobbers: later ops on the same paths, nothing recorded (types
  that opt out), or a pruned version (`epsilon_prune` bounds undo depth)
  all raise. `pgUndo(host, sql, applyOf)` exposes it as
  `remote.call("undo", { doc, v? })`; `pgReceive` re-enters any stored
  write made outside the write hook — no pgSync needed, embedded tier
  included. board_apply records inverses for every branch; mine_apply
  opts out (its ops create/delete whole docs).
- **A type's resolved echo is legal input** (the kit's rule):
  `add /cards/<id> {row}` restores that exact row — `OVERRIDING SYSTEM
  VALUE` plus the new `doc_restore_id` realigns the sequence so the id
  can't be re-minted — and `replace /cards/<id> {row}` sets it whole;
  `add /members/<uid>` restores a membership (owner only: leavers rejoin
  by invitation, not by undo). Undo, replay, and fork all hang off this
  one property.
- **`doc_cascade_remove(table, fk, id, prefix)`** — an FK `ON DELETE
  CASCADE` is invisible to the op log: the report measured 10 stops still
  rendering after their base was removed, until reload. The helper deletes
  the children and returns their remove ops for the echo; the kit and
  skill now say plainly that cascades must be expanded by hand.
- **`bind(lens, set)`** (ui.ts) — the ops-driven scalar binding: set()
  runs only when an op touches the lens's slice, with the same ancestor/
  snapshot fallback as `list()`. Closes §4 of the report (one keystroke
  re-ran every state effect on the doc — O(n) at the centre of an
  O(change) system). The template's card rows use it.
- **The law is executable.** rel.test.ts drives every op shape a board
  supports over the real wire and asserts the client copy deep-equals
  compose-from-tables after each — the test that catches any dispatch
  whose op stream lies (the cascade bug is the canonical liar).

### Changed

- **Migrations stay day-zero truth, not a diary.** Undo and the NULL-user
  rule are folded INTO 001/003/005 (pre-1.0, same five files, one version
  of every function) — no 006 replaying board_apply. Upgrade path proven
  against a live database: `TRUNCATE migrations` (or
  `bun run db:down && bun run db:up` for the compose db) and every file
  re-applies idempotently — 001 carries the one-line `doc_ops.undo`
  upgrade, data intact. Freshly-scaffolded apps are untouched (they are
  born at day zero).
- **The host composes as itself.** `doc_open(name)` with NO user is the
  host's own full copy; composition functions refuse only a non-NULL user
  who may not see the doc. `openAs` is DELETED from `pgDoc` — nothing
  about identity is captured at hosting time anymore. Also fixes a latent
  bug: gap catch-up composes with no user and used to blank
  identity-scoped docs (`mine:<uid>`) for everyone watching.
- The migrate drift error now spells out that the ledger records the hash,
  not the meaning — a comment-only edit still needs the next numbered file.
- Claims corrected: PGlite WASM boot is ~2–7s by machine (was "~7s");
  in-memory mode is documented as a shape preview (uuid ids, no `-`
  identity resolution, no permits), not a second implementation.
- Docs restructured for context economy: SKILL.md is the tight core
  (mental model, client reference, rules); the deep manual moved to
  `.claude/skills/epsilon/REFERENCE.md`, read on demand. README gained
  "Choosing an engine" (the three-engines decision table). CLAUDE.md's
  release ceremony is marked template-repo-only so scaffolds aren't
  misled. Scaffolds no longer inherit the template's CHANGELOG
  (`bun-create.postinstall`), alongside `.github`.

## [0.2.3] — 2026-07-29

### Changed

- **Migrations squashed to day-zero truth** (pre-1.0, no deployed
  databases): `db/` is now 001 core, 002 auth, 003 the doc kit, 004
  housekeeping, 005 the app's doc types (board/mine/sharing, final form) —
  five files instead of nine, no superseded function versions replayed.
  The development narrative lives in git and DESIGN.md. Databases that
  applied the old files upgrade cleanly: the renamed files re-apply
  idempotently; orphaned ledger rows are ignored by the runner.

### Added

- Deploy-ready: `server.ts` honors `PORT` (PaaS routers assign it);
  `railway.json` carries the deploy story (start command, healthcheck) —
  add a volume, set `EPSILON_PG_DIR=/data`, `bun add @electric-sql/pglite`
  in the deploying app. Found by scaffolding a real app and simulating
  the deploy: production install, `PORT` boot, CLI drive, restart-with-
  volume durability — all verified.
- Scaffolds no longer inherit the template's CI workflow: a
  `bun-create.postinstall` removes `.github` from new apps (runs via
  Bun's shell, where `rm` is a cross-platform builtin). The repo's
  workflow guards the TEMPLATE's contract; an app opts into its own CI.

## [0.2.2] — 2026-07-29

### Added

- **Embedded Postgres** (`epsilon/pglite.ts`) — the relational tier with NO
  database process. `EPSILON_PG_DIR=./data` runs the same schema on
  in-process Postgres (PGlite, WASM) behind a new structural `Sql` seam
  that Bun's SQL also satisfies: every migration, the doc kit, sharing,
  and the pgcrypto auth contract run UNCHANGED (bcrypt ~350ms in WASM —
  on par with native; WASM boot ~7s, once). One deployable service, state
  on a volume; single app process by design, so pgSync is skipped — no
  sibling processes exist to hear from. Outgrow it: pg_dump, set
  `EPSILON_PG_URL` — scaling up is a config change. `bun run test:pglite`
  proves migrations, the wire, auth, the 009 mirrors, and reopen-the-
  directory durability, no server anywhere; CI runs it. Optional
  dependency like `pg`: `bun add @electric-sql/pglite` when deploying
  with it.

### Fixed

- CI: the app tests hung at the default 5s test timeout — ubuntu-24.04
  runners restrict unprivileged user namespaces (AppArmor), which kills
  Chrome's sandbox at launch and stalls `Bun.WebView`. The workflow now
  wraps Chrome with `--no-sandbox` (the container recipe from CLAUDE.md,
  applied to CI), and `test:app` runs with a 30s per-test timeout — cold
  Chrome plus the full auth flow doesn't fit in 5s on a slow runner.

## [0.2.1] — 2026-07-29

### Added

- **Doc lifetime is paid, not leaked.** `remote.doc(name)` handles are
  refcounted and gain `close()`: the last close unsubscribes on the server,
  stops reconnect re-opens (previously every doc ever visited re-opened on
  each reconnect, forever), and abandons that doc's queued writes; a write
  through a closed handle throws. The host tracks subscriptions per socket
  — a socket's death releases everything it watched — and EVICTS a
  factory-hosted (dynamic) doc when its last watcher leaves; the factory
  re-hosts and recomposes on the next open. Statically registered docs
  still live for the process. The template's board switcher closes the
  board it leaves.
- CI (`.github/workflows/ci.yml`) — tsc + every suite, including the
  real-browser app test, against a postgres:16 service container.
- **Sharing** (`db/009-sharing.sql`) — `board_members`, and `board_may`
  grown to public/owner/MEMBER. Share by email: `add /members/-` on the
  board (owner only) mints the member row and mirrors the board into the
  member's own list in the same transaction; `remove /members/<uid>` is the
  owner removing anyone or a member leaving; on your own list, `remove
  /boards/<id>` deletes what you own and LEAVES what you don't. Renames
  now mirror path-precisely (`/boards/<id>/name`) into every list showing
  the board. Lock order generalized from 005: all mine docs ascending uid,
  then board docs ascending id, pre-scanned and locked up front. The
  template grows a members panel on owned boards; `mine` rows mark shared
  boards. Host `open`/pgDoc `guard` hooks may now be async, so the open
  gate is `SELECT board_may(...)` — membership changes bite on the next
  open. Cards gain a `done` boolean (dispatch + composition).
- **Presence** — being on a board IS watching its presence doc.
  `presence:board:<id>` is an ordinary in-memory doc keyed by socket,
  maintained by the new host hooks `onSubscribe`/`onUnsubscribe` (fired on
  a socket's first successful open — after the snapshot, so the new watcher
  sees itself appear as a contiguous op — and on release or death) and
  evicted with its last watcher. The template shows "here: …" under the
  board name: guests before auth, names after. Ephemeral and per-process
  by design.
- **The demo speaks all three verbs.** Each card row has a done checkbox
  (`replace /cards/<id>/done`, strikethrough when done) and a ✕
  (`remove /cards/<id>`); the board title renames in place — blur or Enter
  sends one `replace /name` and the mirror renames it in every mine list
  live. The app test drives all three through a real browser.
- **The CLI** (`epsilon/cli.ts`) — the wire from a terminal, so a human, a
  script, or an AI can work the live app while `bun dev` runs. It is the
  browser's own client (`connect()`) behind argv: one-shot commands, JSON
  out. `register`/`login`/`whoami`/`logout` manage a session
  (`.epsilon-token`, or `EPSILON_TOKEN`; re-authenticated by the connect
  hook so every command runs as you); `open <doc> [pointer]` prints the
  composed snapshot; `add`/`set`/`rm`/`apply` mutate and print the
  RESOLVED echo the server broadcast — minted ids included; `watch`
  streams snapshot-then-ops as NDJSON; `call` is RPC. `--url` /
  `EPSILON_URL` pick the host; `--timeout` bounds every command. The
  scaffold skill documents it, so agents reach for the wire instead of
  guessing from source. `DocHandle` exposes `v` (the last applied server
  version).

### Fixed

- The in-memory app test waits for the first snapshot before typing —
  keystrokes racing module evaluation could native-submit the form and
  navigate away (an intermittent CI-class flake).

## [0.2.0] — 2026-07-29

### Added

- **The doc kit** (`db/007-doc-kit.sql`) — the reusable skeleton of a
  relational doc type, so a new type is ~30 lines of app SQL: one
  composition query plus one dispatch function. `doc_begin` (lock + exist +
  permit, no existence oracle), `doc_commit` (bump v, log, doorbell — and
  the multi-doc mirror primitive: NULL no-op on never-seeded docs),
  `doc_lock`, `doc_drop`, `doc_id`, `doc_path`, and
  `op_add`/`op_replace`/`op_remove` — the wire's three verbs in SQL.
- `db/008-board-on-kit.sql` — `board_apply`/`mine_apply` rewritten on the
  kit, behavior-identical (005's lock order included) at half the length.
  One tightening: paths match exactly (`/name/x` no longer renames).
- rel.test.ts's `todo` type — a complete new doc type built on the kit and
  driven over the real wire; the minimal recipe an app copies.

- `connect(url, { onConnect })` — a hook awaited on every socket open (first
  connect and each reconnect), after queued calls flush and before docs
  (re)open. The template re-authenticates there with the stored token, so a
  dropped socket recovers a logged-in session by itself instead of stranding
  it at the auth dialog.
- This changelog.
- `db/006-housekeeping.sql` — `epsilon_prune(keep interval)` bounds the two
  unbounded tables: `doc_ops` older than `keep` (catch-up re-hydrates from
  the snapshot on a gap, so only audit history is lost) and expired
  sessions. The server calls it at boot; cron it in long-lived deployments.
- `pgSync` accepts `mode: "poll"` to force the interval fallback.

### Changed

- The poll fallback sweeps every hosted doc in ONE query per tick instead
  of one query per doc.
- `op.ts` documents that the vocabulary is NOT RFC 6902: `add` sets (an
  array index is overwritten, only `/-` appends), `replace` creates missing
  keys, batches are atomic. `ui.ts`'s first-paint comment corrected: rows
  created before the caller appends ride the fragment in — nothing drops.

### Fixed

- Back/forward navigate boards: the client now listens for `hashchange`
  (the hash was written but never read back), so browser history — and a
  hand-edited `#/board:<id>` — opens the board. Pinned by a real
  history.back()/forward() round trip in app.test.ts.
- The client websocket URL follows the page protocol (`wss:` on HTTPS) —
  the hardcoded `ws://` was blocked as mixed content behind TLS.
- A refused doc open (`unknown doc`, `unauthenticated`) now REJECTS
  `doc.ready` instead of hanging forever; re-asking after a refusal re-arms
  it. Refusals still report through `onError`, never as unhandled
  rejections.
- Doc writes made while the socket is down queue and flush on reconnect —
  after the connect hook and the re-opens, so a `requireAuth` host accepts
  them — instead of being silently dropped. A deliberate `close()` abandons
  the queue.
- `Signal.apply` (and `applyOps`) are ATOMIC: a bad op mid-batch unwinds
  the applied prefix and notifies nothing, so a hosted signal can never
  silently diverge from what its subscribers saw. Matches the relational
  tier, where the stored function's transaction rolls the batch back.
- `db/005-lock-order.sql` — a rename now locks the owner's `mine:` doc
  BEFORE its own docs row, matching `mine_apply`'s order and closing an
  AB-BA deadlock between a rename's mirror and a concurrent board delete.
- Persistence muting during `hydrate`/`receive` is per-doc: a synchronous
  cascade that writes ANOTHER doc during the apply persists that doc
  normally instead of being silently skipped.

### Removed

- `applySql` (pg.ts) — unused since migrations became the one schema path.
- The `mintIds` export (doc.ts) — internal to the host's write path; nothing
  outside doc.ts used it.

### Security

- `register` / `login` are rate limited per client IP (fixed window,
  10/min by default, `pgAuth(host, sql, { maxAttempts, windowMs })` to
  tune) — bcrypt at cost 12 was a CPU faucet for anyone hammering them.
  `authenticate` stays unthrottled: every reconnect re-auths through it.
- Dynamic-doc factories receive the asking user —
  `host.docs(prefix, (name, userId) => ...)` — and the template's `mine:` /
  `board:` factories refuse strangers BEFORE hosting or seeding anything.
  Previously any authenticated user probing `mine:<n>` names minted `docs`
  rows and hosted signals without bound.

## [0.1.0] — 2026-07-28

The first cut: an app template (`bun create blueshed/epsilon`) with the
runtime vendored in — no library, no build step, zero runtime deps.

### Added

- **Op-carrying signals** (`epsilon/signal.ts`) — `apply(ops)` mutates and
  notifies both channels; composing `at()` lenses rebase paths; railroad's
  glitch-free topological flush.
- **The wire** (`epsilon/doc.ts`) — one Signal class both sides; the
  snapshot IS an op; no optimistic apply; contiguous versions with
  gap → re-open; `call()` RPC; server-minted ids; dynamic docs via
  `host.docs(prefix, factory)`.
- **UI** (`epsilon/ui.ts`) — `list()` routes membership ops only; row
  content flows through each row's lens; `text()` is the state-channel
  fallback.
- **Postgres, doc-native tier** (`epsilon/pg.ts`) — JSONB durability with a
  guarded UPDATE, `doc_ops` event log, LISTEN/NOTIFY fan-out (optional `pg`
  peer, polling fallback).
- **Relational tier** (`db/003-board.sql`, `db/004-mine.sql`) — tables are
  the truth; `<doc>_apply` applies + mints + logs + notifies in one
  transaction; `<doc>_open` composes at open time; ownership enforced at
  the function boundary; per-user `mine:<uid>` docs; creating a doc is an
  op; multi-doc transactional writes.
- **Migrations** (`epsilon/migrate.ts`) — numbered `db/*.sql`, applied in
  order, hash-recorded, forward-only, advisory-locked.
- **Schema-native users** (`db/002-auth.sql`) — SQL auth contract
  (register/login/sessions, pgcrypto bcrypt); `pgAuth` is only the wire
  adapter; auth dialog in the template.
