# Your epsilon app

Built on [epsilon](https://github.com/blueshed/epsilon) — one op stream,
Postgres to pixel. The runtime is **not a dependency**: it's the
[`epsilon/`](epsilon/) folder in this repo, ~3.8k lines of TypeScript you
own, with its own tests. Edit it; it's yours.

```sh
bun dev            # embedded Postgres in ./data — register, then open a second tab
bun test           # everything; DB/browser suites skip themselves and say why
bun run test       # just the suites that never need a service
bun run check      # tsc --noEmit, strict
```

**The first screen is a sign-in dialog.** `bun dev` runs on embedded
Postgres, which means the full stack — users, ownership, sharing, the audit
log — so the app asks who you are before it serves a doc. Register any
email and password (it is your own database, on your own disk), then open a
second tab as the same user to watch realtime work. `bun run dev:memory`
skips all of it when you just want the shape.

Needs [Bun](https://bun.sh) ≥ 1.3.14. Nothing else — no database to install,
no build step. Docker is optional, and only for `bun run db:up`.

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

Keep `epsilon/`, `db/001`–`006` (epsilon core), and the rest of `server.ts`.

**`index.html` needs rewriting — it is neither "keep" nor "delete".** Its
body is board markup, so replace that with your own; but keep the
`<link rel="stylesheet" href="./index.css">` and
`<script type="module" src="./index.ts">` tags, which are what Bun bundles
from (write new files at those two names).

One piece is worth porting rather than dropping: the `<dialog id="auth">`
block, together with the code in `index.ts` that drives it. The runtime does
not require that markup — nothing in `epsilon/` looks for those ids — but a
`requireAuth` host serves no docs until a session exists, so an app with no
sign-in UI shows an empty screen and a refusal. The pair is the worked
example of the register/login/passkey flow; take both or write both.

Number your own migrations from **102** up. 001–099 are epsilon's, frozen
once released; 100 and 101 are the demo's, and stay put while you keep it
(see below). Once the demo is gone, its numbers are yours again — but there
is no reason to reuse them.

**Keep `db/100-board.sql` and `db/101-tally.sql` too, for now.** They are the
demo's schema *and* the fixture the vendored relational suites drive:
`test:pg` and `test:pglite` call `board_apply` and compose `tally_open` in
some 360 places. Delete the SQL and those suites stop with one plain message
naming the file and your two options — they will not fail mysteriously — but
they do stop. Two small tables are a cheap price until you have a doc type of
your own and have re-pointed the tests at it; `proveLaw` (`epsilon/law.ts`)
is how you pin yours, the way `epsilon/rel.test.ts` pins the board.

## Choosing an engine

One schema, three ways to run it — the choice is one env var, and moving up
later is a config change (`epsilon:export` carries your data — see Deploying):

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

  **Where your own doc type goes:** its *tables* need a number
  (`db/102-yours.sql`); its `*_open` composition and `*_apply` dispatch go in
  `db/fn/yours.sql`, which you then edit in place forever. `db/fn/session.sql`
  is the shape to copy.

  `db/100-board.sql` defines its functions inline, which is the OLDER pattern
  — those files are hash-recorded and already applied everywhere, so moving
  their bodies would break every deployed ledger for a cosmetic win. Read 100
  for *what a dispatch does*; follow `db/fn/` for *where to put it*.
- [`epsilon/`](epsilon/) — the runtime. `*.test.ts` beside each file are the contract; [`epsilon/DESIGN.md`](epsilon/DESIGN.md) is the why.
- [`.claude/skills/epsilon/`](.claude/skills/epsilon/) — how to build on it, for you and for Claude. `REFERENCE.md` is the deep manual.

## Deploying

[`railway.json`](railway.json) is the worked example — start command,
healthcheck, restart policy. One durable service with no database process:
mount a volume at `/data`, set `EPSILON_PG_DIR=/data`, and
`bun add @electric-sql/pglite`. `server.ts` honors `PORT`, so any PaaS
router just works; the file is inert if you deploy elsewhere.

Set these too, and know why:

- **`NODE_ENV=production`** — otherwise Bun serves in dev mode (HMR public,
  verbose errors, client `console` in your logs). It also makes a missing
  database a startup failure instead of a silently open, auth-free app.
- **`EPSILON_ORIGINS=https://your.app`** — WebSockets ignore the same-origin
  policy, so without this any page your users visit can talk to your server
  as them. It pins the passkey ceremony too; changing your hostname later
  strands enrolled passkeys.
- **`bun add pg`** if you use `EPSILON_PG_URL` — it is the LISTEN peer, and
  without it cross-process fan-out quietly falls back to polling.
- **TLS in front** — session tokens are bearer credentials. Put HSTS and any
  CSP at that terminator; `Bun.serve` bundles the HTML natively, so wrapping
  the `/` route to add headers breaks the bundle.

Health is at `/health` (it touches the database, so a restart policy fires on
the failure that matters). Back up by snapshotting the volume, or with
`bun run epsilon:export`. Note `epsilon_prune()` deletes ops older than 30
days at boot and daily — that is your undo depth and audit window, not just
housekeeping.

**Outgrowing the embedded tier.** PGlite has no port, so `pg_dump` cannot
reach it — `epsilon:export` is the way out:

```sh
bun run epsilon:export --dir ./data > dump.sql   # export the data
EPSILON_PG_URL=postgres://… bun server.ts        # boot once so migrations build the schema, then stop
psql "$EPSILON_PG_URL" -f dump.sql               # load it
```

Ids and sequences survive, so writes on the new server continue where the old
one left off.

## Upgrading the runtime

`package.json` records the release you scaffolded from
(`"epsilon": { "base": … }`):

```sh
bun run epsilon:upgrade          # to upstream's latest release
bun run epsilon:upgrade v0.10.1   # to a specific tag
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
