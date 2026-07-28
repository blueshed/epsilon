# Changelog

Notable changes, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/). Unreleased collects what the next version
will ship.

## [Unreleased]

### Added

- This changelog.

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
