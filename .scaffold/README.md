# Your epsilon app

Built on [epsilon](https://github.com/blueshed/epsilon) — one op stream,
Postgres to pixel. The runtime is **not a dependency**: it's the
[`epsilon/`](epsilon/) folder in this repo, ~3.8k lines of TypeScript you
own, with its own tests. Edit it; it's yours.

```sh
bun dev            # embedded Postgres in ./data — two tabs, type in one, watch the other
bun test           # the runtime's contract (no database needed)
bun run check      # tsc --noEmit, strict
```

## What you start with

A working multi-user kanban board — **this is a demo, and it's yours to
delete.** It exists so nothing here is theoretical: it's the worked example
of a doc type end to end, and the app tests prove the stack in a real
browser. When you're ready to make this app your own:

| Delete | What it is |
|---|---|
| `index.ts` / `index.css` / `types.ts` | the board's pixels and types |
| `app.test.ts` | the board's browser test |
| the `board:` / `mine:` / `tally:` blocks in `server.ts` | the board's wiring |

Keep everything else: `epsilon/`, `db/001`–`005` (epsilon core), the rest of
`server.ts`, `index.html`. Number your own migrations from **101** up —
001–099 are epsilon's, frozen once released, so an upgrade never collides
with your files.

**Keep `db/100-board.sql` and `db/101-tally.sql` too, for now.** They are the
demo's schema *and* the fixture the vendored relational suites drive:
`test:pg` and `test:pglite` call `board_apply` and compose `tally_open` in
some 360 places. Delete the SQL and `bun test`'s promise — your stack,
verified in your repo — turns into a red suite. Two small tables are a cheap
price until you have a doc type of your own and have re-pointed those tests
at it; `proveLaw` (`epsilon/law.ts`) is how you pin yours, the way
`epsilon/rel.test.ts` pins the board.

## Choosing an engine

One schema, three ways to run it — the choice is one env var, and moving up
later is a config change (`pg_dump` carries your data):

| You want | Set | You get |
|---|---|---|
| A real app, one service — **this is what `bun dev` does** | `EPSILON_PG_DIR=./data` | **Embedded Postgres** (PGlite, in-process): the full schema — auth, ownership, sharing, undo, the audit — durable on a volume, no database service to run. One app process only. |
| Several app processes, or Postgres you already run | `EPSILON_PG_URL=postgres://…` | The same schema on a **Postgres server**, plus LISTEN/NOTIFY fan-out between processes. |
| Just the shape, nothing kept (`bun run dev:memory`) | nothing | In-memory **preview**: instant, open access, uuid ids. No auth, no permits, no undo or history; state dies with the process. |

`bun dev` starts embedded, on purpose: in-memory is a preview, not a tier,
and a first run that hides auth, sharing and the audit log undersells the
stack you just installed. Reach for `dev:memory` when you want a throwaway.

```sh
bun run db:up            # compose Postgres on :5599 (or use your own)
EPSILON_PG_URL=postgres://epsilon:epsilon@localhost:5599/epsilon bun dev
bun run test:pglite      # the relational tier on embedded Postgres, no DB needed
bun run test:pg          # durability, fan-out, users (needs db:up)
```

## Where things are

- [`server.ts`](server.ts) — the authority: which docs exist, who may open them.
- [`index.ts`](index.ts) / [`index.html`](index.html) / [`index.css`](index.css) — the pixels. Bun serves and bundles them, no build step.
- [`db/`](db/) — numbered migrations, applied at boot, forward-only. [`db/fn/`](db/fn/) holds stored functions: unnumbered, replayed every boot, **edited in place**.
- [`epsilon/`](epsilon/) — the runtime. `*.test.ts` beside each file are the contract; [`epsilon/DESIGN.md`](epsilon/DESIGN.md) is the why.
- [`.claude/skills/epsilon/`](.claude/skills/epsilon/) — how to build on it, for you and for Claude. `REFERENCE.md` is the deep manual.

## Deploying

[`railway.json`](railway.json) is the worked example — start command,
healthcheck, restart policy. One durable service with no database process:
mount a volume at `/data`, set `EPSILON_PG_DIR=/data`, and
`bun add @electric-sql/pglite`. `server.ts` honors `PORT`, so any PaaS
router just works; the file is inert if you deploy elsewhere.

## Upgrading the runtime

`package.json` records the release you scaffolded from
(`"epsilon": { "base": … }`):

```sh
bun run epsilon:upgrade          # to upstream's latest release
bun run epsilon:upgrade v0.10.0   # to a specific tag
```

It three-way merges upstream's runtime changes over your local patches —
`epsilon/` and the skill only, never `db/`, never your app files. Conflicts
surface as markers exactly where you truly diverged, and the vendored tests
prove the result in your repo. What each release needs from you by hand is
in [UPGRADING.md](https://github.com/blueshed/epsilon/blob/main/UPGRADING.md)
upstream.

## License

Your app is yours — pick a license and add one. The vendored runtime keeps
its own notice in [`epsilon/LICENSE`](epsilon/LICENSE) (MIT © blueshed.co.uk),
as MIT asks.
