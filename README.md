# epsilon

The next letter after delta. One op stream, Postgres to pixel.

```sh
bun create blueshed/epsilon my-app
cd my-app && bun dev     # two tabs, type in one, watch the other
```

**There is no library to install.** The runtime is the [`epsilon/`](epsilon/)
folder in your app — ~1.7k lines of TypeScript you own, with its own tests.
`bun test` verifies your stack, in your repo, forever. Edit it; it's yours.

## The knowns

- **Users are first-class.** `users` and `sessions` ship in the schema; register/login work on day one.
- **Multi-user is in the box.** Share a board by email — it appears in the member's own list in the same transaction; presence shows who's looking; unwatched docs evict and re-host on demand.
- **Postgres, db-first.** Migrations in `db/` (numbered, hash-recorded, forward-only). Set `EPSILON_PG_URL` and the doc is durable — state and versions survive restarts. Identity is minted by the database and carried everywhere, never re-derived.
- **Undo is in the schema.** `doc_ops` records each write's inverse; `remote.call("undo", { doc })` reverts *your* last one — refused, never clobbered, when someone wrote after you. The audit log and the undo log are the same table.
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

## The app (three files, yours)

- [`server.ts`](server.ts) — the authority. In-memory out of the box (a shape *preview*: uuid ids, no permits); Postgres — the real implementation, with auth + ownership — via one env var.
- [`index.ts`](index.ts) — the pixels. A remote doc is a signal whose writes go over the wire; the echo renders them.
- [`index.html`](index.html) / [`index.css`](index.css) — Bun serves and bundles them.
- [`db/`](db/) — your schema: numbered migrations, applied at boot, forward-only. `003-doc-kit.sql` is the reusable skeleton of a relational doc type; `005-board.sql` is the worked example — tables, composition, transactional writes, ownership.

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
| `ui.ts` | `list()` routes membership ops; `bind()` rides a lens's op stream for scalars |
| `pg.ts` | Durability, LISTEN/NOTIFY fan-out, wire adapter for the SQL auth contract |
| `pglite.ts` | The same `Sql` seam over in-process Postgres — the embedded engine |
| `migrate.ts` | Numbered migrations: ordered, hash-recorded, forward-only, transactional |
| `cli.ts` | The wire from a terminal — auth-aware one-shot commands + `watch`, JSON out (humans, scripts, AIs) |

`*.test.ts` beside each — the tests are the contract. [DESIGN.md](DESIGN.md) is the why.

## Lineage

[delta](https://github.com/blueshed/delta) proved the document lens; [railroad](https://github.com/blueshed/railroad) proved signals-to-DOM. Epsilon merges them and hands you the source: the delta IS the signal, and the stack IS the app.

## License

MIT
