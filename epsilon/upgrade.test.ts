// Upgrades: three-way over local patches, scope whitelisted, base stamped.
// Fixture repos play upstream and a scaffolded app; the script under test
// is THIS repo's epsilon/upgrade.ts, pointed at them via EPSILON_UPSTREAM.
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UPGRADE = new URL("./upgrade.ts", import.meta.url).pathname;
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sh(cwd: string, cmd: string[], env?: Record<string, string>) {
  const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), "eps-up-"));
  dirs.push(d);
  sh(d, ["git", "init", "-b", "main"]);
  sh(d, ["git", "config", "user.email", "t@e.st"]);
  sh(d, ["git", "config", "user.name", "t"]);
  return d;
}

const commit = (d: string, msg: string) => {
  sh(d, ["git", "add", "-A"]);
  sh(d, ["git", "commit", "-m", msg]);
};

/** Upstream at v0.1.0: one runtime file, one skill file, one db file. */
function upstream(): string {
  const d = repo();
  mkdirSync(join(d, "epsilon"), { recursive: true });
  mkdirSync(join(d, ".claude/skills/epsilon"), { recursive: true });
  mkdirSync(join(d, "db"), { recursive: true });
  writeFileSync(join(d, "epsilon/thing.ts"), "export const a = 1;\n\n\n\n\nexport const z = 1;\n");
  writeFileSync(join(d, ".claude/skills/epsilon/SKILL.md"), "v1\n");
  writeFileSync(join(d, "db/001-core.sql"), "-- v1\n");
  commit(d, "v0.1.0");
  sh(d, ["git", "tag", "v0.1.0"]);
  return d;
}

/** A scaffold from that upstream: same files, its own repo, base stamped.
 *  `bun run test` must exist — the upgrade ends by running it. */
function scaffold(up: string): string {
  const d = repo();
  for (const f of ["epsilon/thing.ts", ".claude/skills/epsilon/SKILL.md", "db/001-core.sql"]) {
    mkdirSync(join(d, f.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(d, f), readFileSync(join(up, f)));
  }
  writeFileSync(join(d, "package.json"), JSON.stringify({
    name: "app", version: "0.0.1",
    epsilon: { base: "v0.1.0" },
    scripts: { test: "true" },
  }, null, 2) + "\n");
  commit(d, "scaffolded");
  return d;
}

describe("epsilon:upgrade — taking a new runtime is mechanical", () => {
  test("three-way: upstream changes land, local patches survive, db/ is never touched", async () => {
    const up = upstream();
    const app = scaffold(up);

    // Upstream releases v0.2.0: runtime + skill + db all change.
    writeFileSync(join(up, "epsilon/thing.ts"), "export const a = 2;\n\n\n\n\nexport const z = 1;\n");
    writeFileSync(join(up, ".claude/skills/epsilon/SKILL.md"), "v2\n");
    writeFileSync(join(up, "db/001-core.sql"), "-- v2 (must NOT reach the app)\n");
    commit(up, "v0.2.0");
    sh(up, ["git", "tag", "v0.2.0"]);

    // The app patched the OTHER end of the same runtime file.
    writeFileSync(join(app, "epsilon/thing.ts"), "export const a = 1;\n\n\n\n\nexport const z = 9; // local patch\n");
    commit(app, "local patch");

    const r = sh(app, ["bun", UPGRADE], { EPSILON_UPSTREAM: up });
    expect(r.code).toBe(0);
    expect(r.out).toContain("runtime updated v0.1.0 → v0.2.0");

    const thing = readFileSync(join(app, "epsilon/thing.ts"), "utf8");
    expect(thing).toContain("export const a = 2;");            // upstream's change
    expect(thing).toContain("export const z = 9; // local patch"); // survived
    expect(readFileSync(join(app, ".claude/skills/epsilon/SKILL.md"), "utf8")).toBe("v2\n");
    expect(readFileSync(join(app, "db/001-core.sql"), "utf8")).toBe("-- v1\n"); // whitelist held
    const pkg = JSON.parse(readFileSync(join(app, "package.json"), "utf8"));
    expect(pkg.epsilon.base).toBe("v0.2.0");                   // ready for the next take
  });

  test("already current: no-op; missing base: refused loudly", async () => {
    const up = upstream();
    const app = scaffold(up);

    const same = sh(app, ["bun", UPGRADE], { EPSILON_UPSTREAM: up });
    expect(same.code).toBe(0);
    expect(same.out).toContain("already at v0.1.0");

    writeFileSync(join(app, "package.json"), JSON.stringify({
      name: "app", version: "0.0.1", scripts: { test: "true" },
    }, null, 2) + "\n");
    const bare = sh(app, ["bun", UPGRADE], { EPSILON_UPSTREAM: up });
    expect(bare.code).toBe(1);
    expect(bare.err).toContain('"epsilon": { "base"');
  });
});
