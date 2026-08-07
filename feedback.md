# Feedback on epsilon — from building a kanban on it

Written after replacing the scaffold demo with a real doc type (`kanban:<id>`
+ `kanbans:<uid>`, columns/cards/members, drag-drop, sharing, undo, history)
in one session, on v0.10.2. Everything below is something I actually hit, in
the order I hit it — not a review of the design.

## What worked, and should not change

- **The skill is enough to author a type without reading the runtime.**
  SKILL.md's six lines plus REFERENCE.md's "Authoring a doc type" got me to a
  correct `_open`/`_apply` pair on the first attempt. I read `db/100-board.sql`
  and `db/fn/board.sql` as the worked example and copied their *shape* —
  pre-scan, lock order, echo/inverse discipline — verbatim. That worked.
- **`proveLaw` is the best thing in the box.** Not because it caught a defect,
  but because knowing it would drive undo *and redo* through every branch
  changed how I wrote the dispatch: I recorded inverses honestly the first
  time instead of discovering the gap later. The rule "every inverse you
  record must be an op your own dispatch can dispatch" is the one that would
  have bitten me.
- **Echoes-are-input** (restore by resolved id) is a genuinely small idea that
  pays for undo, replay and fork at once. Writing the restore branch felt
  redundant right up until undo needed it.
- **`db/fn/` edited in place** vs numbered tables is exactly the right seam. I
  rewrote `kanban_apply` maybe fifteen times; not once did I think about
  migrations.
- **`write()` returning the resolved echo.** My test helper is
  `newBoard() → minted.path.split("/").pop()`. Without it every test would be
  matching rows by value.
- Error text that names the defect class (`epsilon/law.ts`'s `classify`) is
  written for whoever has to fix it. Keep doing that everywhere.

## Sharp edges, worst first

### 1. A lens created inside an effect wedges the tab (severity: high)

This cost me most of the session. In a card-detail panel I wrote what the
demo writes:

```ts
effect(() => {
  const author = stampName(card.at<number | null>("/created_by").get(), roster);
  ...
});
```

Each run mints a new lens, each lens subscribes, and nothing ever drops them.
With a doc type whose echoes are **whole-row replaces** (mine widen, because a
stamp moves with every scalar edit), the second or third echo left the tab
completely unresponsive — `evaluate()` in the browser test just never
returned. No error, no warning, no console output: a hang.

Three things about this:

- **The scaffold's own `index.ts` teaches the anti-pattern.** `cardDetail()`
  in the demo calls `card.at(...)` inside `effect()` three times. It survives
  only because the board's echoes are narrow enough that the effect rarely
  re-runs. A new app with wider echoes inherits the bug from the worked
  example.
- **REFERENCE.md frames "narrow, then read" as a performance concern** ("an
  effect over the whole doc is correct but re-runs on every write"). The real
  failure mode is not extra re-runs, it is a dead tab. Worth saying in those
  words.
- **The fix should probably be in the runtime**: cache lenses per
  `(root, path)` on the handle so `at()` is idempotent, or — cheaper — warn in
  development when a lens is created while a tracking context is active,
  naming the path. Either would have turned a two-hour hunt into a line of
  console output.

### 2. Delete the demo and a new app has no auth gate (severity: medium)

The demo raises the sign-in dialog because a cold load opens the seeded public
`board:1`, gets `unauthenticated`, and `onError` shows the dialog. Delete the
demo and there is nothing to open before sign-in — your boards live at
`kanbans:<uid>` and you have no uid. Result: a blank screen and no way in.
Nothing in SKILL.md or the scaffold README warns about this, and it will
happen to *every* app that follows the "delete the demo" instructions.

I worked around it by probing: open a name that cannot exist
(`kanbans:0`) and read the refusal — `unauthenticated` means the host requires
auth, anything else means the in-memory preview. That works, but it is a trick
the app shouldn't have to invent. Options, in preference order:

1. The host tells the client at connect time whether it requires auth (one
   flag in the hello/ack frame). The client then knows which tier it is on
   without a doc open — useful for more than the dialog.
2. A standard `auth_required` open method.
3. Failing both, document the probe in REFERENCE.md's auth section.

### 3. The demo is also the vendored suites' fixture, in more places than documented (severity: medium)

The scaffold README says to keep `db/100-board.sql` and `db/101-tally.sql`
because the relational suites drive them, and `testdb.ts`'s `NO_FIXTURE`
message is a genuinely good failure. But the coupling is wider than the README
says: `epsilon/{pg,rel,pglite}.test.ts` also **import `Board` and `Card` from
`../types`** — the app's own types file. So "delete the demo" also means "keep
two type names in your app's model file forever, or edit vendored tests".

I kept them, in a marked section at the bottom of `types.ts`. It reads like an
apology. Two suggestions:

- Have the vendored suites declare their fixture types **locally**. Nothing
  about `board_apply` needs to live in an app's `types.ts`.
- Longer term: move the fixture schema into `epsilon/` (a fixture dir the
  suites migrate themselves) so `db/` is purely the app's, and deleting the
  demo is a one-line action instead of a judgement call.

Also, the numbering advice disagrees with itself: `.scaffold/README.md` says
"number your own migrations from **102**", `.scaffold/CLAUDE.md` says
"numbered from **102**", and SKILL.md/REFERENCE.md say **103** (correct — 102
is `card-pos`). I started at 103.

### 4. Testing the app in `Bun.WebView` has two undocumented traps (severity: low, but each cost a debugging cycle)

- **`evaluate()` takes an expression, not a script.** `"a(); 1"` is a
  `SyntaxError`. The demo test happens to use IIFEs everywhere, which reads
  like style rather than requirement. One line in REFERENCE.md's testing
  section would do it.
- **`click()` on an element below the fold never resolves** — it waits for
  actionability and hangs the whole test rather than failing. My card-detail
  panel sits under the board, so `view.click("#detail-close")` hung. Driving
  off-screen UI with `evaluate(...click())` is the workaround; worth saying,
  since any app with a scrolling layout will meet it.

## Smaller notes

- **The CLI cannot send a batch.** `set` sends one op, so I could not drive my
  move-between-columns (`replace column_id` + `replace pos`, one batch) from
  the CLI — the very thing the CLI is best at verifying. A raw
  `epsilon/cli.ts apply <doc> '<ops json>'` would close that gap.
- **`_may(id, NULL)` refuses, `_open(doc, NULL)` composes.** The asymmetry is
  right (a NULL user is the host reading, not the host writing), but it caught
  me in a debug script: `kanban_apply(doc, ops, NULL)` raises `not found` and
  the message points at `doc_begin`, which reads like a missing doc rather
  than a missing permit. Worth a sentence in the kit's header.
- `doc_cascade_remove` expanding the echo but *not* the inverse is the trap
  REFERENCE.md says it is, and the pglite `recipe` example is exactly the
  right place to have documented it. I read it before writing my column-remove
  branch and got it right first time. Good.
- pgView (`stats:<uid>`, with a per-board count map) was a five-minute job and
  removed any temptation to fetch. The "declared dependencies" rule made the
  `on: [...]` list obvious.
- The lock-order header comment in `100-board.sql` is the single most useful
  comment in the repo. I copied its structure into my type and never thought
  about deadlocks.

## The one-line version

The design held up: I wrote ~450 lines of SQL and ~950 of client and never
once needed to diff, invent a verb, or reach for a fetch. The thing that hurt
was not the model — it was a lens created in the wrong place, failing silently
and catastrophically, taught by the worked example.
