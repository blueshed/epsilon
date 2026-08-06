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

**This file lives upstream, not in your app** (0.10.0). A per-release trail
that a scaffold cannot update is wrong the day after it ships, so
`epsilon:upgrade` prints the link to the version you are taking instead.

---

## → 0.10.2

Two of the three structural fixes need a look from you; the third
(`doc_commit` refusing root-path ops) is automatic unless a dispatch of
yours echoes a recomposition — which was always a defect, and now says so.

**`doc_open` takes both arguments.** Copy `db/007-doc-open-explicit.sql`
and the `db/fn/` files into your app (`db/` is outside the upgrade
whitelist, as ever). Then grep your own SQL and methods for single-argument
calls:

```sql
SELECT doc_open('board:1');          -- before: silently the FULL copy
SELECT doc_open('board:1', NULL);    -- after: the host's copy, said out loud
SELECT doc_open('board:1', p_user);  -- a user's permitted view
```

A custom `host.method` must pass `ws.data.user.id` — forgetting it is now
an undefined-function error instead of a permit bypass.

**Gateless dynamic in-memory docs are refused on `requireAuth` hosts.** If
a prefix factory of yours calls `host.doc(name, empty)` with no `{ open }`,
its opens now fail loudly instead of failing open. Fit the factory's own
permit as the gate (see server.ts's presence factory); an intentionally
public doc states it: `open: () => sig.peek()`.

A patch by intent — 0.10.0 reviewed and repaired — but two of the repairs
need a line from you, because a security hole cannot be closed without
changing what the insecure code did.

**The one API change is a security fix: methods registered with
`host.method()` now require a session on a `requireAuth` host.**

Until 0.10.1 the `call` branch returned before the auth gate, so every
registered method was reachable by a socket that had never authenticated. On
the Postgres tier that made `history` a world-readable dump of any private
doc's op log — a NULL user reads as "the host asking as itself" inside the
SQL permit — and `undo` an anonymous write against any doc a NULL user may
touch (the seeded, ownerless `board:1` among them).

**If you only use the built-in methods, the upgrade is automatic.** `login`,
`register`, `authenticate`, `logout` and the passkey LOGIN pair are declared
as doors upstream and keep working before sign-in.

**If you registered your own methods**, decide for each one:

```ts
host.method("mine", fn);                  // needs a session (the new default)
host.method("start_session", fn, { open: true });   // reachable before one exists
```

Only mark a method `open` if it MINTS a session or must run before one can
exist. Anything that reads or writes app state must not be: a call-shaped
read is not covered by the doc permit, which is the hole this closed.

**Two things also need you, both one line:**

- **The operator's door now requires `EPSILON_ADMIN_SECRET`.** `EPSILON_ADMIN`
  is a list of emails, and registration is open and unverified — so on a
  fresh deployment whoever registers that address first inherits arbitrary
  SQL. With `EPSILON_ADMIN` set and no secret, the door does not open at all
  and says so at boot. Generate one with `openssl rand -hex 32`, then pass it
  alongside the sql (`bun epsilon/cli.ts call admin '{"sql":"…"}'` picks it up
  from the environment).
- **Set `EPSILON_ORIGINS` and `NODE_ENV=production` when you deploy.** Neither
  is required, and both matter — see README "Deploying". Without the first,
  any web page can open a socket to your deployment as your signed-in user;
  without the second, Bun serves in development mode in production.

**Automatic, but worth knowing:**

- `db/006-session-digest.sql` hashes session tokens at rest. **Nobody is
  signed out** — the migration hashes the existing column in place, so the
  token a client already holds still resolves. Copy that one file into your
  own `db/` (core migrations are frozen; you adopt a new one by copying it),
  along with `db/fn/session.sql`, which holds the new function bodies.
- The migration ledger moved from `Bun.hash` to SHA-256. Your existing rows
  are recognised and rewritten on the next boot — no migration re-runs, and
  an actually-edited file is still refused.
- A rejected write no longer replays on reconnect. If your app worked around
  the double-execute by not retrying, you can stop.
- Writes are capped at 500 ops per batch (`maxOpsPerBatch`), and the socket
  at a 1 MiB frame. Both are far above real use; raise them if you disagree.

---

## → 0.10.0

**One breaking change, and it is a compile error, not a surprise at
runtime: `pgDoc`'s `apply` is now required.**

The doc-native tier — `pgDoc` WITHOUT `apply`, where the doc was a JSONB
blob in `docs.data` — is gone, along with `DocOpts.persist`. If `bun run
check` is clean after the upgrade, you were never using it, which is
overwhelmingly likely: every call site in this repo and in the one deployed
app already passed `apply`.

If it does complain, that doc was a blob and needs a relational home before
you take 0.10.0: a table, a `<doc>_open` composition function and a
`<doc>_apply` dispatch — `db/003-doc-kit.sql` is the skeleton and
`db/100-board.sql` the worked example. There is no automatic migration,
because only you know what the blob's shape should become in tables.

**Otherwise the runtime is automatic.** Two files move INTO the whitelist,
so the upgrade brings them to you: `epsilon/DESIGN.md` (the why, previously
root `DESIGN.md` and frozen at whatever release you scaffolded from) and
`epsilon/LICENSE` (the notice that travels with the vendored source).

**Then delete the stale copies at your root** — `DESIGN.md` is now a
duplicate that will never update again, and root `LICENSE` is epsilon's
copyright sitting where your app's license belongs:

```sh
rm DESIGN.md          # now epsilon/DESIGN.md, and current
rm LICENSE            # epsilon/LICENSE covers the runtime; license your app as you like
rm -f SHAKEDOWN.md    # an internal audit of epsilon 0.8.0; it was never yours
```

Nothing reads them, so this is housekeeping, not a break. If you have
`db/fn/`, upstream's [`db/fn/README.md`](https://github.com/blueshed/epsilon/blob/main/db/fn/README.md)
is worth copying in — the folder's three rules, where the next person looks.

---

## → 0.9.1 – 0.9.3

**Runtime: automatic, nothing required of you.** Three fixes in a row, all
found the same week `db/fn/` shipped: `batch()` had gone missing from the
public exports (0.9.1); `db/fn/`'s own safety gate refused some of the files
it exists to accept (0.9.2); and the scaffold's test broke on the new
directory (0.9.3).

---

## → 0.9.0

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
