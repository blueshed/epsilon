# CLAUDE.md

An [epsilon](https://github.com/blueshed/epsilon) app. The realtime stack is
**not a dependency** — `epsilon/` IS the stack, vendored in this repo:
op-carrying signals, doc sync over one WebSocket, Postgres durability,
schema-native users. Never add Firebase/Supabase/socket.io/React Query.

## Layout

- `server.ts` — the authority: which docs exist, who may open them.
- `index.ts`, `index.html`, `index.css`, `types.ts` — the app, at project
  root (bun-route convention: root route = `index.html` + `index.css` +
  `index.ts`). `app.test.ts` drives the real app in `Bun.WebView`.
- `epsilon/` — the runtime + its tests. Tests are the contract;
  `epsilon/DESIGN.md` is the why. Upgrade it with `bun run epsilon:upgrade`.
- `db/` — numbered migrations, applied at boot, forward-only, hash-recorded.
  `001`–`099` are **epsilon core and frozen** — never edit them; adopt a new
  one by copying that file. Your doc types start at **100**.
- `db/fn/` — stored functions: unnumbered, NOT hash-recorded, replayed every
  boot in one transaction. Edit in place. A signature change needs
  `DROP FUNCTION` in a numbered file first.

The board (`index.ts`, `index.css`, `types.ts`, `app.test.ts`,
`db/100-board.sql`, `db/101-tally.sql`, and the `board:`/`mine:`/`tally:`
blocks in `server.ts`) is the **scaffold's demo** — the worked example of a
doc type end to end. Delete it when the app has its own; see README.md.

## Rules

- **Bun only** — never npm/npx/node. No build step. Zero runtime deps (`pg`
  and `@electric-sql/pglite` are optional dev-time).
- **Db-first**: schema is the source of truth; the database mints identity —
  every tier, server-side. Never invent ids client-side.
- **Small language**: three verbs (`add`/`replace`/`remove`), JSON-Pointer
  paths. Never invent verbs.
- The law: ops are the fast path; recompute-from-state must always be
  correct on its own.
- For realtime work, follow `.claude/skills/epsilon/SKILL.md`; its
  `REFERENCE.md` is the deep manual, read on demand.
- If you deliberately diverge from upstream `epsilon/`, say so in a "Local
  divergence" section here — naming the files and the reason. The next
  upgrade will surface it as a conflict, and that is information.
- Keep docs and reports SHORT.

## Commands

```sh
bun dev              # the app, in-memory (writes .epsilon.pid)
bun run stop         # kill the server the pid file points at
bun test             # unit + wire + DOM suites (no DB needed)
bun run test:pglite  # the relational tier on EMBEDDED Postgres (no DB needed)
bun run db:up        # compose Postgres on :5599
bun run test:pg      # durability, fan-out, users (needs db:up)
bun run test:app     # the real app in a real browser (needs Bun ≥ 1.3.14)
bun run check        # tsc --noEmit, strict
bun run ci           # db up → check + everything → db down
```

## Testing in a container with no Docker

`db:up` needs Docker. Where there is none but Postgres 16 binaries exist
(Claude's cloud containers), once per container:

```sh
su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /var/lib/postgresql/pgdata -A trust -U postgres"
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/pgdata -o '-p 5599 -c listen_addresses=localhost' -l /var/lib/postgresql/pg.log start"
su postgres -c "/usr/lib/postgresql/16/bin/psql -p 5599 -U postgres -c \"CREATE ROLE epsilon LOGIN PASSWORD 'epsilon' CREATEDB\" -c 'CREATE DATABASE epsilon OWNER epsilon'"
```

Then `test:pg`, `test:migrate` and `test:app` run against it directly (skip
`db:up`/`db:down`; after a restart, only the `pg_ctl start` line). If the
container's Chromium won't sandbox as root, wrap it and point
`BUN_CHROME_PATH` at the wrapper.
