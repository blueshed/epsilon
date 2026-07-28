# epsilon

The next letter after delta. One op stream, Postgres to pixel.

**A model, the documents that view and edit it, and a UX that stays in sync — one concept, one vocabulary, all the way down.**

## The knowns

- **Users are first-class.** Auth is in the schema from day one, not bolted on.
- **Postgres, db-first.** The schema is the source of truth; identity is minted by the database and carried everywhere, never re-derived.
- **Bun, simple.** One runtime, no build step, `--compile` to a binary.
- **The UX is the same stream.** Signals carry ops, not just "something changed." `list()` routes ops; nothing diffs.

## Lineage

delta proved the document lens (model ↔ doc, three verbs, three backends).
railroad proved signals-to-DOM (real nodes, no vdom).
They meet today at `doc.data` by convention. Epsilon makes them meet by design: **the delta IS the signal.**

## Status

Design. Nothing here runs yet. Read [DESIGN.md](DESIGN.md).
