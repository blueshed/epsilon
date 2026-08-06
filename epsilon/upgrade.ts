/**
 * Upgrade — taking a new epsilon is mechanical (the japan field report).
 *
 * The runtime is code the app may have PATCHED, so the tool that replays
 * upstream changes over local patches is a three-way merge — not a
 * migration script, not a codemod:
 *
 *   bun run epsilon:upgrade            # to upstream's latest release tag
 *   bun run epsilon:upgrade v0.6.0     # to a specific tag (or sha)
 *
 * package.json records where this app came from — the release flow keeps
 * it in step with the version, and `bun create` carries it into every
 * scaffold:
 *
 *   "epsilon": { "base": "v0.5.0" }
 *
 * Flow: fetch upstream (history and tags land in this repo's object store,
 * so base, target, and every blob the merge needs resolve locally), then
 * `git diff <base> <target> -- <scope> | git apply -3`. Local patches
 * survive; genuine divergence surfaces as conflict markers — which is
 * correct. Ends by stamping the new base and running the vendored tests.
 *
 * Scope is a WHITELIST: `epsilon/` and the skill. Never `db/` — released
 * core migrations are frozen; a new one (005-gone and up) is adopted by
 * copying that one file, keeping your ledger one history. Never app files.
 * (`DESIGN.md` and the runtime's `LICENSE` sit INSIDE `epsilon/` for this
 * reason: a doc outside the whitelist freezes at scaffold time.)
 *
 * What a release needs from you BY HAND is upstream's `UPGRADING.md` — a
 * scaffold doesn't carry it, because a per-release trail it can never
 * update is a doc that is wrong by construction. This prints the link.
 */

export {};   // a module, for top-level await — this file is a script, not an API

const UPSTREAM = process.env.EPSILON_UPSTREAM ?? "https://github.com/blueshed/epsilon.git";
const SCOPE = ["epsilon/", ".claude/skills/epsilon/"];

async function git(args: string[], stdin?: string): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["git", ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  // out stays RAW: a diff's last hunk can end in blank-line context ("<sp>\n")
  // that a trim would corrupt. Callers trim where cosmetic.
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err: err.trim() };
}

async function must(args: string[], stdin?: string): Promise<string> {
  const r = await git(args, stdin);
  if (r.code !== 0) {
    console.error(`[epsilon:upgrade] git ${args.join(" ")} failed:\n${r.err || r.out}`);
    process.exit(1);
  }
  return r.out.trim();
}

const pkgFile = Bun.file("package.json");
const pkg = await pkgFile.json();
const base: string | undefined = pkg.epsilon?.base;
if (!base) {
  console.error(
    '[epsilon:upgrade] package.json carries no { "epsilon": { "base": "<tag-or-sha>" } } — ' +
      "record the upstream release this app was scaffolded from, then re-run.",
  );
  process.exit(1);
}

// A three-way apply writes into the working tree. With uncommitted work
// already there, an upgrade that goes wrong cannot be told apart from your
// own edits — and `git checkout .` would take both. UPGRADING.md said
// "commit before you start", but UPGRADING.md is upstream's file and the
// scaffold deletes it, so the tool has to say it itself.
// EPSILON_UPGRADE_DIRTY=1 is the escape hatch for anyone who means it.
const dirty = (await must(["status", "--porcelain"])).trim();
if (dirty && !process.env.EPSILON_UPGRADE_DIRTY) {
  console.error(
    "[epsilon:upgrade] the working tree has uncommitted changes:\n" +
      dirty.split("\n").slice(0, 10).map((l) => `  ${l}`).join("\n") +
      "\n  Commit or stash first — the upgrade edits these same files, and afterwards\n" +
      "  you want the diff to be upstream's work and nothing else.\n" +
      "  (EPSILON_UPGRADE_DIRTY=1 overrides.)",
  );
  process.exit(1);
}

await must(["fetch", "--tags", "--force", UPSTREAM, "main"]);

const target =
  process.argv[2] ??
  (await must(["tag", "--list", "v*", "--merged", "FETCH_HEAD", "--sort=-v:refname"])).split("\n")[0];
if (!target) {
  console.error("[epsilon:upgrade] no release tag found upstream — pass a tag or sha explicitly.");
  process.exit(1);
}

/** The by-hand half — printed on SUCCESS and on CONFLICT alike. A conflict
 *  is precisely when someone needs the release notes, and it used to be the
 *  one path that exited without them. A web URL only makes sense for an
 *  http(s) remote; a local path or ssh remote gets the plain instruction. */
function byHand(): void {
  const web = UPSTREAM.replace(/\.git$/, "");
  console.log(
    /^https?:\/\//.test(web)
      ? `[epsilon:upgrade] what ${target} needs from you by hand: ${web}/blob/${target}/UPGRADING.md`
      : `[epsilon:upgrade] read UPGRADING.md at ${target} upstream for anything needed by hand.`,
  );
}

const baseSha = await must(["rev-parse", `${base}^{commit}`]);
const targetSha = await must(["rev-parse", `${target}^{commit}`]);
if (baseSha === targetSha) {
  console.log(`[epsilon:upgrade] already at ${target} — nothing to take.`);
  process.exit(0);
}

const diff = await git(["diff", baseSha, targetSha, "--", ...SCOPE]);
if (diff.code !== 0) {
  console.error(`[epsilon:upgrade] git diff failed:\n${diff.err}`);
  process.exit(1);
}
const patch = diff.out;
if (patch.trim()) {
  const applied = await git(["apply", "-3"], patch);
  if (applied.code !== 0) {
    if (/conflict/i.test(applied.err)) {
      // The three-way left markers exactly where this app truly diverged.
      console.error(`[epsilon:upgrade] applied with conflicts:\n${applied.err}`);
      console.error("[epsilon:upgrade] resolve the markers, run the tests, then commit — base is NOT yet stamped.");
      console.error(`[epsilon:upgrade] re-run \`bun run epsilon:upgrade ${target}\` after resolving to stamp it.`);
      byHand();
    } else {
      console.error(`[epsilon:upgrade] apply failed:\n${applied.err || applied.out}`);
    }
    process.exit(1);
  }
  console.log(`[epsilon:upgrade] runtime updated ${base} → ${target}`);
} else {
  console.log(`[epsilon:upgrade] runtime unchanged ${base} → ${target} — stamping base only.`);
}

pkg.epsilon = { ...pkg.epsilon, base: target };
await Bun.write(pkgFile, JSON.stringify(pkg, null, 2) + "\n");

// The vendored tests are the upgrade's proof — they run in YOUR repo,
// against YOUR patches.
const tests = Bun.spawnSync(["bun", "run", "test"], { stdout: "inherit", stderr: "inherit" });
if (tests.exitCode !== 0) {
  console.error("[epsilon:upgrade] vendored tests failed — inspect before committing.");
  process.exit(1);
}
console.log(`[epsilon:upgrade] done — review the diff and commit (base is now ${target}).`);
byHand();
