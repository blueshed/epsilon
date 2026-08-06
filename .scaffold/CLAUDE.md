# CLAUDE.md

<!-- Replace this line with what this app is. It is the first thing Claude
     reads, and nobody else can write it for you. -->
An app built on [epsilon](https://github.com/blueshed/epsilon).

## The stack is already here

Realtime is **not a dependency**: `epsilon/` is the runtime, vendored in this
repo, and `.claude/skills/epsilon/SKILL.md` is how to use it — read it before
any shared-state, live, multi-user or collaborative work. Its `REFERENCE.md`
is the deep manual. Never add Firebase/Supabase/socket.io/React Query.

**Nothing about how the runtime works belongs in this file.** The skill and
`epsilon/` are what `bun run epsilon:upgrade` keeps current; a copy of their
rules here would freeze on the day you scaffolded and quietly start lying.
This file is for *your app*.

## This app

- `server.ts` — the authority: which docs exist, who may open them.
- `index.ts` / `index.html` / `index.css` / `types.ts` — the app, at project root.
- `app.test.ts` — the app driven in a real browser.
- `db/` — your migrations, numbered from **100**. `001`–`099` are epsilon's
  and frozen. Stored functions live in `db/fn/`, edited in place.

The kanban board is the scaffold's **demo** — a worked example of a doc type
end to end, and yours to delete once this app has its own. README.md lists
exactly which files it is.

## House rules

- **Bun only** — never npm/npx/node. No build step.
- Add your own here. This file is yours; the skill is upstream's.

## Commands

```sh
bun dev              # the app on EMBEDDED Postgres (./data); writes .epsilon.pid
bun run dev:memory   # the in-memory shape preview — no auth, no permits, no doc kit
bun run stop         # stop it
bun run check        # tsc --noEmit, strict
bun test             # the vendored suites — no database needed
bun run test:pglite  # the relational tier on embedded Postgres — no database needed
bun run db:up        # compose Postgres on :5599, for test:pg
bun run test:pg      # durability, fan-out, users
bun run test:app     # the real app in a real browser (Bun ≥ 1.3.14)
bun run ci           # all of it, database up and down
```

## Local divergence

`epsilon:upgrade` replays upstream's changes over your patches. If you
deliberately change something in `epsilon/`, record it here — the file and
the reason — so the next conflict reads as information rather than a
surprise.

_(none yet)_
