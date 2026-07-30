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

await must(["fetch", "--tags", "--force", UPSTREAM, "main"]);

const target =
  process.argv[2] ??
  (await must(["tag", "--list", "v*", "--merged", "FETCH_HEAD", "--sort=-v:refname"])).split("\n")[0];
if (!target) {
  console.error("[epsilon:upgrade] no release tag found upstream — pass a tag or sha explicitly.");
  process.exit(1);
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
