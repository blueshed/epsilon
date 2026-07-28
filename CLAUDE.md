# CLAUDE.md

Epsilon — an app template (`bun create blueshed/epsilon my-app`) with its
runtime vendored inside. There is NO npm library: `epsilon/` IS the stack —
op-carrying signals, doc sync over one WebSocket, Postgres durability,
schema-native users. Merges the ideas of `../delta` and `../railroad`.

## Layout

- `server.ts`, `index.html`, `src/` — the app (the part users make theirs).
- `epsilon/` — the runtime + its tests. Tests are the contract; DESIGN.md is the why.
- `schema.sql` — plain DDL (doc-native tier). Stored functions belong to the future relational tier — see DESIGN.md "Storage tiers".

## Rules

- **Bun only** — never npm/npx/node. No build step. Zero runtime deps (`pg` is optional dev-time, retires when Bun ships `sql.listen`).
- **Db-first**: schema is the source of truth; the database mints identity — every tier, server-side.
- **Small language**: three verbs (`add`/`replace`/`remove`), JSON-Pointer paths. Never invent verbs.
- The law: ops are the fast path; recompute-from-state must always be correct on its own.
- Budget every line against the four taxes in DESIGN.md (identity, time, lifetime, medium). If it pays none, delete it.
- Peter is dyslexic: keep docs and reports SHORT. Insight, acknowledgement, next steps.
- Checkpoint with Peter at design decisions — propose 2–3 options with a recommendation.

## Commands

```sh
bun test           # unit + wire + DOM suites (no DB needed)
bun run db:up      # compose Postgres on :5599
bun run test:pg    # durability, fan-out, users (needs db:up)
bun run check      # tsc --noEmit, strict
bun run ci         # db up → check + everything → db down
bun dev            # the app, in-memory
```
