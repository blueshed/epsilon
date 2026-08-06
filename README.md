# epsilon

The next letter after delta. One op stream, Postgres to pixel.

```sh
bun create blueshed/epsilon my-app
cd my-app && bun dev     # two tabs, type in one, watch the other
```

**There is no library to install.** The runtime is the [`epsilon/`](epsilon/)
folder in your app — ~3.8k lines of TypeScript you own, with its own tests.
`bun test` verifies your stack, in your repo, forever. Edit it; it's yours.

## The knowns

- **Users are first-class.** `users` and `sessions` ship in the schema; register/login work on day one — and so do **passkeys**: add one while signed in, sign in without a password ever after (WebAuthn, zero dependencies — the ceremony is ~350 lines you own, `epsilon/passkey.ts`).
- **Multi-user is in the box.** Share a board by email — it appears in the member's own list in the same transaction; presence shows who's looking; unwatched docs evict and re-host on demand.
- **Postgres, db-first.** Migrations in `db/` (numbered, hash-recorded, forward-only). Set `EPSILON_PG_URL` and the doc is durable — state and versions survive restarts. Identity is minted by the database and carried everywhere, never re-derived.
- **Undo is in the schema.** `doc_ops` records each write's inverse; `remote.call("undo", { doc })` reverts *your* last one — refused, never clobbered, when someone wrote after you. The audit log and the undo log are the same table.
- **Nothing renders dead.** Anything a screen shows is a doc — live, permitted, versioned. When no doc exposes it (a list across docs, counts, a dashboard), one SQL function plus one `pgView` line declares a read-only **view** that recomposes when its named dependencies commit. `call()` is for verbs; there are no fetches to go stale.
- **The law is a harness you run.** `epsilon/law.ts` drives your doc type's ops over the real wire and proves the client copy equals recompute-from-tables after every echo — undo and mirrors included, failures naming the defect (`proveLaw`, one call per doc type, in your own tests).
- **Or Postgres with no database process.** Set `EPSILON_PG_DIR=./data` and the SAME schema runs embedded, in-process ([PGlite](https://pglite.dev)) — one deployable service, state on a volume, every migration and stored function unchanged. Outgrow it? `pg_dump`, set `EPSILON_PG_URL`: scaling up is a config change. (Single app process only; add `@electric-sql/pglite` when deploying with it.)
- **Bun, simple.** One runtime, TypeScript on both sides, no build step, zero dependencies (`pg` is optional, dev-time, and retires when Bun ships `sql.listen`).
- **The UX is the same stream.** Signals carry ops; `list()` routes them; nothing diffs.

## Choosing an engine

One schema, three ways to run it — the choice is one env var, and moving up
later is a config change (`pg_dump` carries your data):

| You want | Set | You get |
|---|---|---|
| To see the shape (first run, demos) | nothing | In-memory **preview**: instant, open access, uuid ids. No auth, no permits; state dies with the process. |
| A real app, one service | `EPSILON_PG_DIR=./data` | **Embedded Postgres** (PGlite, in-process): the full schema — auth, ownership, sharing, undo — durable on a volume, no database service to run. One app process only. |
| Several app processes, or Postgres you already run | `EPSILON_PG_URL=postgres://…` | The same schema on a **Postgres server**, plus LISTEN/NOTIFY fan-out between processes. |

Start embedded unless you already run Postgres. In-memory is a preview, not
a tier — switch on an engine early so auth and permissions are real while
you build.

## Deploying

[`railway.json`](railway.json) is the worked deploy example, the way
`db/100-board.sql` is the worked doc type — [Railway](https://railway.com)
config-as-code: start command, healthcheck, restart policy. The whole
recipe for one durable service with no database process:

1. mount a volume at `/data`
2. set `EPSILON_PG_DIR=/data`
3. `bun add @electric-sql/pglite`

`server.ts` honors `PORT`, so any PaaS router just works. Not on Railway?
The file is inert (delete it if you like) — the pattern is the same on any
host: start `bun server.ts`, healthcheck `/`, a volume behind
`EPSILON_PG_DIR`.

## The app (yours, and a demo to delete)

- [`server.ts`](server.ts) — the authority. In-memory out of the box (a shape *preview*: uuid ids, no permits); Postgres — the real implementation, with auth + ownership — via one env var.
- [`index.ts`](index.ts) — the pixels. A remote doc is a signal whose writes go over the wire; the echo renders them.
- [`index.html`](index.html) / [`index.css`](index.css) — Bun serves and bundles them.
- [`db/`](db/) — your schema: numbered migrations, applied at boot, forward-only — and [`db/fn/`](db/fn/), your stored functions, replayed every boot and **edited in place** (`CREATE OR REPLACE` is idempotent; hash-locking it only forces a copy per edit). `003-doc-kit.sql` is the reusable skeleton of a relational doc type (locking, the audit, undo, history); `100-board.sql` is the worked example — tables, composition, transactional writes, ownership. Number your own migrations from 100 up: 001–099 are epsilon core, frozen once released, so an upgrade never collides with your files.

A scaffold arrives as a **working multi-user kanban board**, so nothing here
is theoretical: every known above is on screen — sharing, presence, the
`tally:` view, and the doc kit's undo, audit trail and per-row "who touched
this last". It is yours to delete the moment the app has its own doc type;
the scaffold's README says exactly which files are the demo.

```sh
bun run db:up            # compose Postgres (or use your own)
EPSILON_PG_URL=postgres://epsilon:epsilon@localhost:5599/epsilon bun dev
```

## The runtime (epsilon/, also yours)

| File | What it is |
|---|---|
| `op.ts` | Three verbs, JSON-Pointer paths, pollution-guarded |
| `signal.ts` | Op-carrying signals; composing `at()` lenses |
| `doc.ts` | The wire — one Signal class both sides; `apply()` hides the WebSocket |
| `ui.ts` | `list()` routes membership ops; `text()` binds a signal to a text node; `mount()` owns a render scope |
| `route.ts` | Screens — hash router (`routes`/`route`/`navigate`), params change without teardown |
| `pg.ts` | Durability, LISTEN/NOTIFY fan-out, declared read views (`pgView`), wire adapters: auth, undo, history, the operator's door |
| `pglite.ts` | The same `Sql` seam over in-process Postgres — the embedded engine |
| `passkey.ts` | WebAuthn end to end, zero dependencies — CBOR, COSE→JWK, the register/sign-in ceremony |
| `law.ts` | The law as a harness — `proveLaw` drives your doc type over the wire and fails with the defect named |
| `migrate.ts` | Numbered migrations: ordered, hash-recorded, forward-only, transactional |
| `cli.ts` | The wire from a terminal — auth-aware one-shot commands + `watch`, JSON out (humans, scripts, AIs) |
| `upgrade.ts` | `bun run epsilon:upgrade` — take a newer runtime over your local patches (three-way merge) |

`*.test.ts` beside each — the tests are the contract. [`epsilon/DESIGN.md`](epsilon/DESIGN.md) is the why, and it lives inside the folder so an upgrade keeps it current.

**Owning the source doesn't mean forking forever.** package.json records
the release you scaffolded from (`"epsilon": { "base": ... }`);
`bun run epsilon:upgrade` fetches upstream and replays the runtime delta
over your patches — `epsilon/` and the skill only, never `db/` (released
core migrations are frozen; you adopt a new one by copying that one file),
never your app. Conflicts surface as markers exactly where you truly
diverged, and the vendored tests prove the result in your repo.

## Lineage

[delta](https://github.com/blueshed/delta) proved the document lens; [railroad](https://github.com/blueshed/railroad) proved signals-to-DOM. Epsilon merges them and hands you the source: the delta IS the signal, and the stack IS the app.

Built in conversation with [Claude Code](https://claude.com/claude-code) — the runtime, its tests, and these docs; 0.3.0 itself was driven by a field report Claude wrote after building a real app on the stack in one sitting.

## License

MIT © 2026 [blueshed.co.uk](https://blueshed.co.uk) — [LICENSE](LICENSE).
A scaffold picks its own license; the notice travels with the vendored
source it covers, in [`epsilon/LICENSE`](epsilon/LICENSE), as MIT asks.
