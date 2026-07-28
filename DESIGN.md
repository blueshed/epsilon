# Design — ops all the way down

## The primitive: the op-carrying signal

```ts
const board = signal<Board>(empty);
board.apply(ops);   // mutate in place + notify, passing the ops along
```

- `apply(ops)` replaces `touch()`; `set(v)` is sugar for one root-replace op.
- Subscribers receive `(ops | undefined)`. `undefined` = recompute from state — always available, always correct.
- **The law:** any consumer may ignore ops and re-read state. Correctness never depends on the fast path.

## What each layer does with ops

| Layer | Receives | Does |
|---|---|---|
| Postgres | client ops | `delta_apply` → NOTIFY (as delta today) |
| Doc | broadcast ops | `doc.data.apply(ops)` — no dataVersion, no touch |
| `at("/cards")` | narrowed ops | lens signal: rebases paths, narrows value |
| `list()` | row ops | routes: add→create, remove→delete, replace→row signal |
| `.map()` | — | computed values; falls back to recompute |

## What this deletes (vs delta + railroad)

`touch()` · `dataVersion` · `{ equals: () => false }` · `list()` key-diffing · `dom-ops` as a separate path · the doc/signal seam itself.

## The four taxes (budget every line against one)

- **Identity** — minted by the db (`nextval`), carried, never guessed. Near-free by design.
- **Time** — ordering: topological flush, version gaps → resync.
- **Lifetime** — every sync is stoppable: dispose scopes, refcounts, socket-drop teardown.
- **Medium** — platform shims only (SVG namespace, no AsyncContext, wire ordering).

Any line not paying one of these taxes is deletable.

## Non-goals

No vdom. No OT/CRDT (model is authoritative; LWW + resync). No offline. No arbitrary live queries — read views without a lawful `put` are read-only, as in delta.

## Decisions (Peter, 2026-07-28)

1. **Server mints ids — every tier.** Clients send `/coll/-`; the assigned id comes back in the echo op. Uniform with Postgres sequences; no client uuids. Consequence: identity is *always* conferred by the store — the Active Record law holds on every rung.
2. **`at()` composes.** `board.at("/cards").at("/5")` ≡ `board.at("/cards/5")`. Path rebasing must be associative — one test pins it.
3. **Users are schema-native.** The `users` table ships in the core schema; auth (register/login/JWT) works out of the box on day one. Delta's auth-jwt is the borrowed implementation, but it's no longer opt-in.
