# Changelog

Notable changes, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/). Unreleased collects what the next version
will ship.

## [Unreleased]

### Added

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
