# Upgrading epsilon

The runtime is vendored, so an upgrade is a **merge into your repo**, not a
package bump. `epsilon/upgrade.ts` does the mechanical part; this file is
the trail of what each release needs from YOU on top of that.

## The mechanical part, every time

```sh
bun run epsilon:upgrade          # to upstream's latest release tag
bun run epsilon:upgrade v0.8.1   # to a specific tag
```

It fetches upstream, three-way applies `git diff <your base> <target>` over
your local patches, stamps the new base into `package.json`, and runs the
vendored tests. Local edits survive; genuine divergence surfaces as conflict
markers, which is correct — resolve them, don't discard them.

**Scope is a whitelist: `epsilon/` and `.claude/skills/epsilon/`.** Never
`db/`, never your app files. That is deliberate — released core migrations
are frozen, and your app is yours. Anything a release needs OUTSIDE that
whitelist is listed below, per version, by hand.

Commit before you start. The tool assumes a clean tree.

---

## → 0.9.0 (unreleased)

**Runtime: automatic. Nothing breaks, and nothing is required of you.**
`db/fn/` is opt-in: an app with no such directory behaves exactly as it did.

### `db/fn/` — stop copying function bodies

Forward-only is the right rule for DDL and the wrong one for
`CREATE OR REPLACE FUNCTION`, which is idempotent by construction. `db/fn/*.sql`
is unnumbered, not hash-recorded, and replayed wholesale every boot — you
**edit those files in place**.

Moving an existing app across is incremental and safe. Per function:

1. Copy its **latest** body — the one from the highest-numbered file that
   defines it — into `db/fn/<name>.sql`. Take the newest; that is the whole
   point, and copying an older one is exactly the bug this prevents.
2. Leave every numbered file **untouched**. They are hash-recorded and
   already applied; editing one throws on the next boot. The vocabulary pass
   runs after them and replaces whatever they created.
3. Delete nothing from `db/`. The old definitions are inert — overwritten on
   every boot by `db/fn/`.

Then stop writing new numbered files for function changes.

```
db/
  001-epsilon.sql        ← untouched, still recorded
  ...
  024-say-who.sql        ← untouched
  fn/
    trip_apply.sql       ← the one live definition, edited in place
    trip_open.sql
```

Two things to know before you start:

- **A signature change still needs a number.** `CREATE OR REPLACE` cannot
  alter a return type or an argument name. Put
  `DROP FUNCTION IF EXISTS foo(old args);` in the next numbered file, then
  edit `db/fn`. `migrate()`'s error says this when it happens.
- **Schema DDL in `db/fn/` is refused at boot**, by design — it could not
  survive a second start. Tables, columns, indexes and seeds keep their
  numbers.

Order inside `db/fn/` carries no meaning: the pass creates everything with
`check_function_bodies = off`, then re-runs the same set with it on, so
functions may call each other regardless of filename and every body is still
validated. The whole directory is one transaction.

---

## → 0.8.1

**Runtime: automatic.** `bun run epsilon:upgrade v0.8.1` covers all of it.
Nothing in `db/` changed, so there is no migration to copy and no schema
step. Every change is backwards compatible — an app that does nothing else
keeps working exactly as it did.

Then, at your leisure, three things become available.

### 1. `doc.write(ops)` — stop guessing which row is yours

`apply()` still works and still returns void. `write()` is the same send with
an answer: it resolves with the RESOLVED ops (server-minted ids in their
paths) and rejects if the write is refused.

```ts
// Before — watch the echo, guess by value, hope nobody else typed "Kyoto":
const id = await onEcho(legs, (row) => row.place === place, 10_000);

// After:
const [minted] = await trip.write([{ op: "add", path: "/legs/-", value: { place } }]);
const id = minted.path.split("/").pop()!;
```

It lives on the **handle** (`remote.doc(...)`), never on a lens — a lens
delegates `apply()` to its root and returns void, so it cannot honour the
contract. If you hold a lens, keep a reference to the handle for writes that
need an answer.

**Look for this pattern in your app** — an echo watcher with a timeout that
matches a new row by its contents. It is the workaround this replaces, and
it picks the wrong row when two people write the same value at once.

### 2. `onError` gains a third argument

A refused WRITE and a refused OPEN used to arrive in the same shape, so the
only way to tell them apart was to read the error text.

```ts
connect(url, {
  onError(doc, error, meta) {
    if (meta?.write) return showToast(error);   // a rejected write
    if (error === "unauthenticated") return openAuthDialog();
    // ...a refused open
  },
});
```

Existing two-argument handlers still compile and still behave the same. If
your app classifies refusals by matching on the error string, that code can
go.

Also fixed here: a refused write no longer settles the doc's `ready`. It
never should have — the doc is open and working; one write was rejected.

### 3. Nothing to do for the two bug fixes

- **A doc dropped while your LISTEN connection was down is now noticed on
  reconnect.** `doc_drop` deletes the op log, so catch-up found nothing and
  reported success over a doc that no longer existed — sibling processes
  went on serving a deleted board until restart. The poll path always caught
  this; the listener now shares the same death-detector.
- **The auth throttle is keyed on IP *and* email, not IP alone.** Behind a
  PaaS edge `remoteAddress` is the load balancer, so one shared budget of
  ten attempts a minute covered every user of the deployment — and one
  person fat-fingering a password locked out everyone else. If you passed
  `maxAttempts`/`windowMs` to `pgAuth`, they mean the same thing; the key
  they apply to is now narrower.

---

## → 0.8.0

**Runtime: automatic**, plus one thing worth doing by hand.

`epsilon/route.ts` is new (`routes` / `route` / `navigate` / `matchRoute`),
and `ui.ts` gained `when()` and `mount()`. Nothing is removed, so the
upgrade alone breaks nothing.

**Then check how your app navigates.** If it moves between screens with
`location.href = …` or `location.reload()`, that is a full reload of a
WebSocket app: reconnect, re-authenticate, re-open every doc, re-render
everything. Replace it with `navigate()` and a `routes()` table. The
template's own demo did exactly this and the diff is in
`index.ts` / `index.html` at v0.8.0 if you want a worked example.

Two things that bite when you wire it:

- A route handler must hold element **refs**, not call `getElementById` —
  `routes()` appends the handler's fragment *after* the handler returns.
- Set the boot hash **before** `routes()` reads it. `location.hash` updates
  synchronously but `hashchange` does not fire until a later task, so
  routing through the event renders your placeholder first and flashes.

---

## Living with a fork

If you have deliberately diverged from upstream, say so where the next
person will look — a "Local divergence" section in your `CLAUDE.md`, naming
the files and the reason. `epsilon:upgrade` will re-apply upstream's changes
over your patches, and a conflict in a file you *chose* to fork is
information, not a failure.

If you have forked `db/`, keep it forked: upstream renumbers its core
migrations occasionally, and adopting that renumbering against a database
that has already applied the old names leaves your ledger with two
histories. Adopt a new core migration by copying **that one file** into your
own numbering instead.
