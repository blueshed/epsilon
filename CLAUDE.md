# CLAUDE.md

Epsilon — an app template (`bun create blueshed/epsilon my-app`) with its
runtime vendored inside. There is NO npm library: `epsilon/` IS the stack —
op-carrying signals, doc sync over one WebSocket, Postgres durability,
schema-native users. Merges the ideas of `../delta` and `../railroad`.

## Layout

- `server.ts`, `index.ts`, `index.html`, `index.css`, `types.ts`, `app.test.ts` — the app, at project root (bun-route convention). The board is the scaffold's DEMO: the worked example of a doc type, and what a new app deletes first.
- `epsilon/` — the runtime + its tests. Tests are the contract; `epsilon/DESIGN.md` is the why. This folder and `.claude/skills/epsilon/` are the ONLY things `epsilon:upgrade` carries, so anything that must reach an existing app lives inside them — that is why DESIGN.md and the runtime's LICENSE are in here.
- `db/fn/` — stored functions: unnumbered, NOT hash-recorded, replayed every boot in one transaction. Edit in place. A signature change needs `DROP FUNCTION` in a numbered file first.
- `db/` — numbered migrations: 001–002 core (doc registry, auth), 003 the doc kit (locking, audit, undo, history), 004 housekeeping, 005 gone. 001–099 are CORE and FROZEN once released — new core behavior is the next number, never an edit. The app's doc types start at 100 (`100-board.sql`). See `epsilon/DESIGN.md` "The doc kit" and "Upgrades".
- `.scaffold/` — **template only, deleted by `bun create`**: the app-facing `README.md`, `CLAUDE.md` and CI that replace this repo's own, plus `init.ts` (the `bun-create.postinstall` hook) and its test. Anything a scaffolded app should NOT inherit is removed there — see its `REMOVE` list.
  - `.scaffold/CLAUDE.md` is **the app's file, not a trimmed copy of this one**. `CLAUDE.md` is outside the upgrade whitelist, so any runtime rule written there freezes at scaffold time — the same trap that stranded `DESIGN.md` at root. How the runtime works goes in `.claude/skills/epsilon/`, which travels and stays current; the scaffold's CLAUDE.md points at it and otherwise talks about the app. The same test applies to `.scaffold/README.md`.

## Rules

- **Bun only** — never npm/npx/node. No build step. Zero runtime deps (`pg` and `@electric-sql/pglite` are optional dev-time; `pg` retires when Bun ships `sql.listen`).
- **Db-first**: schema is the source of truth; the database mints identity — every tier, server-side.
- **Small language**: three verbs (`add`/`replace`/`remove`), JSON-Pointer paths. Never invent verbs.
- The law: ops are the fast path; recompute-from-state must always be correct on its own.
- Budget every line against the four taxes in `epsilon/DESIGN.md` (identity, time, lifetime, medium). If it pays none, delete it.
- For realtime work in the app, follow `.claude/skills/epsilon/SKILL.md` — it ships with every scaffold; its `REFERENCE.md` is the deep manual, read on demand.
- **Every root file ships into every app.** Before adding one, decide which it is: an app's file, or epsilon's. Epsilon's goes on `.scaffold/init.ts`'s `REMOVE` list — or, if an existing app needs it too, inside `epsilon/`.
- A release IS a merge to main. Ship it in the branch: roll Unreleased into a dated CHANGELOG section and bump `epsilon.base` BEFORE the PR — the PR Peter merges is already the release. **Not `version`**: that field is the scaffolded app's, pinned at `0.0.0`, because Bun rewrites package.json after `postinstall` and an app would otherwise inherit epsilon's version number. Tags are Peter's to push (cloud sessions hold branch-scoped credentials).
- Keep docs and reports SHORT.

## Commands

```sh
bun test           # unit + wire + DOM suites (no DB needed)
bun run test:pglite  # the relational tier on EMBEDDED Postgres (no DB needed)
bun run db:up      # compose Postgres on :5599
bun run test:pg    # durability, fan-out, users (needs db:up)
bun run check      # tsc --noEmit, strict
bun run ci         # db up → check + everything → db down
bun dev            # the app on EMBEDDED Postgres (./data); writes .epsilon.pid
bun run dev:memory # the in-memory shape preview: no auth, no permits, no doc kit
bun run stop       # kill the server the pid file points at

bun test ./.scaffold/init.test.ts   # what `bun create` leaves behind (./ — bun test skips dot-dirs)
```

The scaffold suite is template-only, so it is NOT in `bun run ci` (a script
naming `.scaffold/` would break in every app). `.github/workflows/ci.yml`
runs it; run it by hand after touching anything at the root.

## Testing in a Claude container (no Docker)

`db:up` needs Docker; Claude's cloud containers have none, but Postgres 16
binaries are installed. Once per container:

```sh
su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /var/lib/postgresql/pgdata -A trust -U postgres"
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/pgdata -o '-p 5599 -c listen_addresses=localhost' -l /var/lib/postgresql/pg.log start"
su postgres -c "/usr/lib/postgresql/16/bin/psql -p 5599 -U postgres -c \"CREATE ROLE epsilon LOGIN PASSWORD 'epsilon' CREATEDB\" -c 'CREATE DATABASE epsilon OWNER epsilon'"
```

Then `test:pg`, `test:migrate`, and `test:app` run against it directly
(skip `db:up`/`db:down`; after a restart, only the `pg_ctl start` line).

`app.test.ts` needs `Bun.WebView` (Bun ≥ 1.3.14) and a Chrome. The
container ships an older Bun and blocks bun.sh — upgrade from npm:
`bun add -g bun@latest`. Its Chromium won't sandbox as root — wrap it:

```sh
printf '#!/bin/sh\nexec /opt/pw-browsers/chromium --no-sandbox "$@"\n' > /usr/local/bin/chromium-no-sandbox
chmod +x /usr/local/bin/chromium-no-sandbox
BUN_CHROME_PATH=/usr/local/bin/chromium-no-sandbox bun run test:app
```
