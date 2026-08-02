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
