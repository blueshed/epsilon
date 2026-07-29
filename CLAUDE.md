# CLAUDE.md

Epsilon — an app template (`bun create blueshed/epsilon my-app`) with its
runtime vendored inside. There is NO npm library: `epsilon/` IS the stack —
op-carrying signals, doc sync over one WebSocket, Postgres durability,
schema-native users. Merges the ideas of `../delta` and `../railroad`.

## Layout

- `server.ts`, `index.html`, `src/` — the app (the part users make theirs).
- `epsilon/` — the runtime + its tests. Tests are the contract; DESIGN.md is the why.
- `db/` — numbered migrations: 001–002 core (doc registry, auth), 006 housekeeping, 007 the doc kit, the rest the app's doc types. See DESIGN.md "Storage tiers" and "The doc kit".

## Rules

- **Bun only** — never npm/npx/node. No build step. Zero runtime deps (`pg` is optional dev-time, retires when Bun ships `sql.listen`).
- **Db-first**: schema is the source of truth; the database mints identity — every tier, server-side.
- **Small language**: three verbs (`add`/`replace`/`remove`), JSON-Pointer paths. Never invent verbs.
- The law: ops are the fast path; recompute-from-state must always be correct on its own.
- Budget every line against the four taxes in DESIGN.md (identity, time, lifetime, medium). If it pays none, delete it.
- For realtime work in the app, follow `.claude/skills/epsilon/SKILL.md` — it ships with every scaffold.
- Keep docs and reports SHORT.

## Commands

```sh
bun test           # unit + wire + DOM suites (no DB needed)
bun run db:up      # compose Postgres on :5599
bun run test:pg    # durability, fan-out, users (needs db:up)
bun run check      # tsc --noEmit, strict
bun run ci         # db up → check + everything → db down
bun dev            # the app, in-memory
```

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
