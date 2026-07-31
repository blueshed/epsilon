# Changelog

Notable changes, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/). Unreleased collects what the next version
will ship.

## [Unreleased]

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
