/**
 * What `bun create` leaves behind — run once, at scaffold time.
 *
 * The template repo carries two kinds of file: the ones an app should start
 * with, and the ones that exist because epsilon is a project with a history
 * (its changelog, its audit, its upgrade trail, its CI). Only the first kind
 * should survive `bun create`. This script is the boundary.
 *
 * It is wired as `bun-create.postinstall`, which Bun runs in the NEW app's
 * directory after installing dependencies — then deletes itself along with
 * the rest of `.scaffold/`.
 *
 * One thing it deliberately does NOT do: touch `package.json`. Bun writes
 * that file itself after this script returns (renaming `name`, stripping the
 * `bun-create` block), so any edit here is discarded. Anything a scaffold
 * needs from package.json must therefore be correct AT REST in the template
 * — which is why `version` is `0.0.0` upstream and the epsilon release is
 * recorded in `epsilon.base` instead.
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Template-only: epsilon's own history and plumbing, meaningless in an app. */
const REMOVE = [
  ".github",         // epsilon's CI — the app gets its own, from .scaffold/ci.yml
  "CHANGELOG.md",    // epsilon's releases, not the app's
  "UPGRADING.md",    // per-release upgrade trail; epsilon:upgrade links to it upstream
  "LICENSE",         // epsilon's copyright — the app picks its own; epsilon/LICENSE stays
];

/** `.scaffold/<from>` → `<to>`: the app-facing version of a template file. */
const INSTALL: [from: string, to: string][] = [
  ["README.md", "README.md"],
  ["CLAUDE.md", "CLAUDE.md"],
  ["ci.yml", ".github/workflows/ci.yml"],
];

export function scaffoldInit(root: string): void {
  for (const name of REMOVE) rmSync(join(root, name), { recursive: true, force: true });

  for (const [from, to] of INSTALL) {
    const src = join(root, ".scaffold", from);
    if (!existsSync(src)) continue;   // tolerate a partial template rather than half-init
    const dest = join(root, to);
    mkdirSync(join(dest, ".."), { recursive: true });
    renameSync(src, dest);
  }

  rmSync(join(root, ".scaffold"), { recursive: true, force: true });
}

// Not when the test imports it.
if (import.meta.main) {
  scaffoldInit(process.cwd());
  console.log("[epsilon] scaffolded — README.md is yours now. `bun dev`, then open two tabs.");
}
