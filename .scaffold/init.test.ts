// The scaffold's contract: what `bun create` leaves behind. Template-only,
// like everything in .scaffold/ — it is deleted before an app ever sees it,
// so it runs from epsilon's own CI, not from `bun run ci`.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { scaffoldInit } from "./init";

const REPO = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

/** The template's shape, as a throwaway tree: the files an app must NOT keep,
 *  the ones .scaffold/ swaps in, and one bystander that proves we only delete
 *  what we name. */
function fixture(): string {
  const d = mkdtempSync(join(tmpdir(), "epsilon-scaffold-"));
  const write = (rel: string, body: string) => {
    mkdirSync(join(d, dirname(rel)), { recursive: true });
    writeFileSync(join(d, rel), body);
  };
  write(".github/workflows/ci.yml", "epsilon's own CI");
  write("CHANGELOG.md", "epsilon's releases");
  write("UPGRADING.md", "the upgrade trail");
  write("LICENSE", "MIT © blueshed.co.uk");
  write("README.md", "the template's pitch");
  write("CLAUDE.md", "the template's instructions");
  write(".scaffold/README.md", "APP README");
  write(".scaffold/CLAUDE.md", "APP CLAUDE");
  write(".scaffold/ci.yml", "APP CI");
  write("server.ts", "the app");            // bystander
  write("epsilon/LICENSE", "MIT © blueshed.co.uk");  // the notice that must travel
  write("tsconfig.json", '{\n  "include": ["*.ts", "epsilon/**/*.ts", ".scaffold/**/*.ts"]\n}\n');
  return d;
}

describe("scaffoldInit", () => {
  test("leaves an app, not a copy of the template repo", () => {
    const d = fixture();
    try {
      scaffoldInit(d);

      // epsilon's history: gone. (.github is not here — it is removed and
      // then rebuilt from the app's own CI, asserted by content below.)
      for (const gone of ["CHANGELOG.md", "UPGRADING.md", "LICENSE"]) {
        expect(existsSync(join(d, gone))).toBe(false);
      }
      // The app's own versions: installed over the template's.
      expect(readFileSync(join(d, "README.md"), "utf8")).toBe("APP README");
      expect(readFileSync(join(d, "CLAUDE.md"), "utf8")).toBe("APP CLAUDE");
      expect(readFileSync(join(d, ".github/workflows/ci.yml"), "utf8")).toBe("APP CI");
      // The scaffolding itself: gone, including this test.
      expect(existsSync(join(d, ".scaffold"))).toBe(false);
      // Everything unnamed: untouched. The vendored notice travels, as MIT asks.
      expect(readFileSync(join(d, "server.ts"), "utf8")).toBe("the app");
      expect(readFileSync(join(d, "epsilon/LICENSE"), "utf8")).toBe("MIT © blueshed.co.uk");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("drops the .scaffold glob from tsconfig — it points at a deleted directory", () => {
    const d = fixture();
    try {
      scaffoldInit(d);
      const ts = readFileSync(join(d, "tsconfig.json"), "utf8");
      expect(ts).not.toContain(".scaffold");
      expect(ts).toContain("epsilon/**/*.ts");     // the real sources still compile
      expect(JSON.parse(ts).include).toEqual(["*.ts", "epsilon/**/*.ts"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("a missing source is skipped, not half-installed", () => {
    const d = fixture();
    try {
      rmSync(join(d, ".scaffold/ci.yml"));
      expect(() => scaffoldInit(d)).not.toThrow();
      expect(existsSync(join(d, ".github"))).toBe(false);   // removed, never recreated
      expect(readFileSync(join(d, "README.md"), "utf8")).toBe("APP README");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("the template it runs against", () => {
  test("still has every file the lists name", () => {
    for (const src of ["README.md", "CLAUDE.md", "ci.yml"]) {
      expect(existsSync(join(REPO, ".scaffold", src))).toBe(true);
    }
    for (const gone of [".github", "CHANGELOG.md", "UPGRADING.md", "LICENSE"]) {
      expect(existsSync(join(REPO, gone))).toBe(true);
    }
    expect(existsSync(join(REPO, "epsilon/LICENSE"))).toBe(true);
  });

  // Bun rewrites package.json AFTER postinstall, discarding anything this
  // script writes there — so the template's values ARE the app's values.
  // `version` is the app's to set; epsilon's release lives in `epsilon.base`.
  test("carries package.json values an app can keep", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    expect(pkg.version).toBe("0.0.0");
    expect(pkg.epsilon?.base).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(pkg.description).not.toMatch(/bun create|~[\d.]+k lines/);
    expect(pkg["bun-create"]?.postinstall).toBe("bun .scaffold/init.ts");
    // A script pointing into .scaffold/ would break in every app.
    for (const [name, cmd] of Object.entries(pkg.scripts as Record<string, string>)) {
      expect(`${name}: ${cmd}`).not.toContain(".scaffold");
    }
  });
});
