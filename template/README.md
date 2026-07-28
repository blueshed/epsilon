# epsilon-app

A realtime app on [`@blueshed/epsilon`](https://github.com/blueshed/epsilon) — one op stream, server to pixel.

```sh
bun install
bun dev          # http://localhost:3000 — open two tabs, type in one
```

No database needed to start. Set `EPSILON_PG_URL` and the same doc becomes durable Postgres (`schema.sql` applies itself):

```sh
docker compose -f ../compose.yml up -d   # or your own Postgres
EPSILON_PG_URL=postgres://epsilon:epsilon@localhost:5599/epsilon bun dev
```

Three files: `server.ts` (the authority), `src/client.ts` (the pixels), `index.html`.
