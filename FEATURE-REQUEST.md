# Feature request — upgrades: taking a new epsilon should be mechanical

Filed 2026-07-30, from the japan field app (the second field report; the
first became 0.3.0's undo, guards, and cascades).

## The evidence

Japan is pinned to runtime 0.2.2 plus two local patches, cherry-picked
`bind()` out of 0.3.0 by hand, and has forked `db/` permanently — its
CLAUDE.md now carries the rule "take runtime files, NEVER take `db/`",
because 0.3.0 renumbered migrations its deployed ledger had already
recorded. One app, one month in: upgrade-by-hand is already the most
expensive thing about owning the stack. With ten scaffolded apps it
becomes ten slightly-divergent runtimes.

"Migrations in TypeScript" was the first framing, but the problem splits
into three, and only the SQL part wants migration machinery — which
already exists.

## 1. Runtime files — a merge problem, git is the tool

Migrations replay transformations over *data*; the runtime is *code the
app may have patched* (japan patched `pg.ts` and `doc.ts`). The tool that
replays upstream changes over local patches is a three-way merge.

- **The scaffold records its upstream commit.** The release flow stamps
  the current SHA into the template (e.g. `"epsilon": { "base": "<sha>" }`
  in package.json); `bun create` carries it into every app.
- **`bun run epsilon:upgrade`** (a script the scaffold ships): fetch
  `blueshed/epsilon`, then three-way apply the runtime delta —
  `git diff <base> <release-tag> -- epsilon/ .claude/skills/epsilon/ | git apply -3` —
  update `base`, run the vendored tests. Local patches survive; conflicts
  surface only where the app truly diverged, as conflict markers, which is
  correct.
- **Scope is a whitelist:** `epsilon/` and the skill. Never `db/`, never
  app files.

Upstream commits are the numbered upgrade steps; the recorded base is the
ledger. No new mechanism — just plumbing worth shipping in the template.

## 2. `db/` — the machinery exists; the policy was violated

`migrate()` is already forward-only and hash-checked. The 0.3.0
renumbering was the sin: right for fresh scaffolds, unadoptable by any
deployed ledger. DESIGN.md says "once real deployments exist, the files
freeze" — japan proves that moment has passed.

- **Released core migrations freeze forever.** New core features ship as
  new numbered files (the way 004-housekeeping already did), which a
  deployed app adopts by copying one file — its ledger stays one history.
- **Reserve the range:** 001–099 core, app migrations start at 100. The
  scaffold's example doc type moves to 100 so the first thing an app does
  isn't squatting on upstream's next number. `migrate()` could warn when
  a sub-100 file isn't upstream's — cheap tripwire, optional.

## 3. App call-sites — TypeScript is the codemod

With a ~10-function API surface, migration scripts that edit app code are
the magic epsilon exists to refuse. Instead, every breaking change must
fail LOUDLY at `check` or construction time, with the one-line fix in the
message — the way `pgDoc` throwing on a missing `guard` already works
(japan's patch, absorbed in 0.3.x). Each break gets a CHANGELOG entry
with exact before/after. That is the whole contract.

## Non-goals

Codemods, an upgrade CLI beyond the one script, auto-merging `db/`, and
anything that edits app-owned files.
