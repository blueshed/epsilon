# epsilon

The next letter after delta. One op stream, Postgres to pixel.

```sh
bun create blueshed/epsilon my-app
cd my-app && bun dev     # two tabs, type in one, watch the other
```

**There is no library to install.** The runtime is the [`epsilon/`](epsilon/)
folder in your app — ~1k lines of TypeScript you own, with its own tests.
`bun test` verifies your stack, in your repo, forever. Edit it; it's yours.

## The knowns

- **Users are first-class.** `users` and `sessions` ship in the schema; register/login work on day one.
- **Postgres, db-first.** Set `EPSILON_PG_URL` and the doc is durable — state and versions survive restarts. Identity is minted by the database and carried everywhere, never re-derived.
- **Bun, simple.** One runtime, TypeScript on both sides, no build step, zero dependencies (`pg` is optional, dev-time, and retires when Bun ships `sql.listen`).
- **The UX is the same stream.** Signals carry ops; `list()` routes them; nothing diffs.

## The app (three files, yours)

- [`server.ts`](server.ts) — the authority. In-memory out of the box; Postgres via one env var.
- [`src/client.ts`](src/client.ts) — the pixels. A remote doc is a signal whose writes go over the wire; the echo renders them.
- [`index.html`](index.html) — Bun serves and bundles it.

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
| `ui.ts` | `list()` routes membership ops; row content flows through lenses |
| `pg.ts` | Durability + LISTEN/NOTIFY fan-out; schema-native users |
| `schema.sql` | Plain DDL — docs, ops log, users, sessions |

`*.test.ts` beside each — the tests are the contract. [DESIGN.md](DESIGN.md) is the why.

## Lineage

[delta](https://github.com/blueshed/delta) proved the document lens; [railroad](https://github.com/blueshed/railroad) proved signals-to-DOM. Epsilon merges them and hands you the source: the delta IS the signal, and the stack IS the app.

## License

MIT
