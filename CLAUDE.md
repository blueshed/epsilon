# CLAUDE.md

Epsilon — the merge of `../delta` (doc sync) and `../railroad` (signals/JSX) into one op stream, Postgres to pixel. Design phase.

## Rules

- Read `DESIGN.md` before writing anything. `README.md` is the pitch.
- **Bun only** — never npm/npx/node. No build step. Zero runtime deps.
- **Db-first**: schema is the source of truth; the database mints identity.
- **Small language**: three verbs (`add`/`replace`/`remove`), JSON-Pointer paths. Never invent verbs.
- Budget every line against the four taxes in DESIGN.md. If it pays none, delete it.
- Peter is dyslexic: keep docs and reports SHORT. Insight, acknowledgement, next steps.
- delta and railroad stay maintained; epsilon borrows their tested code (signals flush scheduler, applyOps, auth) rather than rewriting from scratch.
- Checkpoint with Peter at design decisions — propose 2–3 options with a recommendation.
