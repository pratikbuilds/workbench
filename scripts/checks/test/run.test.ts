import { expect, test } from "bun:test";
import path from "node:path";
import { buildChecks, discoverCheckFiles } from "../run";

const REAL_CHECKS_DIR = path.resolve(import.meta.dir, "..");

// The full, explicit roster of checks this repo currently ships, kept
// deliberately out of sync with the filesystem: a check whose file grows
// an `import.meta.main` entry point but whose name is missing here (or
// vice versa) fails this test loudly, instead of the runner silently
// dropping it the way `web-tailwind-utilities.ts` did before it gained
// its `if (import.meta.main)` guard.
const EXPECTED_CHECK_NAMES = [
  "browser-safe-subpaths",
  "catalog-pins",
  "db-gate",
  "deletion",
  "error-envelope",
  "hub-git-safety",
  "killdates",
  "licenses",
  "no-product-tenancy",
  "packages",
  "react-ui-drift",
  "react-ui-pin",
  "report-error",
  "routine-target-inference",
  "tailwind-source",
  "tool-package-freshness",
  "tool-package-pins",
  "tsconfig-references",
  "ui-vocabulary",
  "web-tailwind-utilities",
].sort();

const files: Record<string, string> = {
  "deletion.ts": "if (import.meta.main) main();",
  "deletion.test.ts": "if (import.meta.main) main();",
  "lib-only.ts": "export function helper() {}",
  "allowlist.ts": "export const ALLOWLIST = [];",
  "run.ts": "if (import.meta.main) main();",
};

function fakeReaddir(_dir: string): string[] {
  return Object.keys(files);
}

function fakeReadFile(file: string): string {
  const name = file.split("/").pop() ?? "";
  return files[name] ?? "";
}

/** Identity resolver for fake, non-existent test files. */
const identityRealPath = (file: string): string => file;

function discover(runnerRealPath: string): string[] {
  return discoverCheckFiles(
    "/checks",
    fakeReaddir,
    fakeReadFile,
    runnerRealPath,
    identityRealPath,
  );
}

test("discovers only .ts files with an import.meta.main entry point", () => {
  const found = discover("/checks/run.ts");
  expect(found).toEqual(["deletion.ts"]);
});

test("skips .test.ts files even if they have a main entry point", () => {
  expect(discover("/checks/run.ts")).not.toContain("deletion.test.ts");
});

test("excludes the runner by resolved real path, not by filename", () => {
  expect(discover("/checks/run.ts")).not.toContain("run.ts");
});

test("excludes a renamed copy of the runner when its real path matches", () => {
  const { "run.ts": _runner, ...withoutRunner } = files;
  const renamed: Record<string, string> = {
    ...withoutRunner,
    "structural.ts": files["run.ts"] ?? "",
  };
  const found = discoverCheckFiles(
    "/checks",
    () => Object.keys(renamed),
    (file) => renamed[file.split("/").pop() ?? ""] ?? "",
    // The renamed file resolves to the same real path as the runner —
    // e.g. it's the runner itself under a new name.
    "/checks/structural.ts",
    identityRealPath,
  );
  expect(found).not.toContain("structural.ts");
  expect(found).toEqual(["deletion.ts"]);
});

test("excludes a symlink pointing at the runner", () => {
  const symlinked: Record<string, string> = {
    ...files,
    "run-link.ts": files["run.ts"] ?? "",
  };
  const found = discoverCheckFiles(
    "/checks",
    () => Object.keys(symlinked),
    (file) => symlinked[file.split("/").pop() ?? ""] ?? "",
    "/checks/run.ts",
    // A symlink resolves to the runner's real path regardless of its
    // own name.
    (file) =>
      file.endsWith("run-link.ts") || file.endsWith("run.ts")
        ? "/checks/run.ts"
        : file,
  );
  expect(found).not.toContain("run-link.ts");
  expect(found).toEqual(["deletion.ts"]);
});

test("buildChecks always includes tsconfig-references alongside discovered checks", () => {
  const checks = buildChecks(
    REAL_CHECKS_DIR,
    path.resolve(REAL_CHECKS_DIR, "..", ".."),
  );
  const names = checks.map((check) => check.name);
  expect(names).toContain("tsconfig-references");
  expect(names).toContain("licenses");
  expect(names).toContain("catalog-pins");
  expect(names).not.toContain("react-ui-drift-allowlist");
});

test("buildChecks names are sorted", () => {
  const checks = buildChecks(
    REAL_CHECKS_DIR,
    path.resolve(REAL_CHECKS_DIR, "..", ".."),
  );
  const names = checks.map((check) => check.name);
  expect(names).toEqual([...names].sort());
});

test("never discovers itself (run.ts) as a check — that would recurse without bound", () => {
  const checks = buildChecks(
    REAL_CHECKS_DIR,
    path.resolve(REAL_CHECKS_DIR, "..", ".."),
  );
  expect(checks.map((check) => check.name)).not.toContain("run");
});

test("buildChecks still surfaces packages as a runnable, individually-named check", () => {
  const checks = buildChecks(
    REAL_CHECKS_DIR,
    path.resolve(REAL_CHECKS_DIR, "..", ".."),
  );
  expect(checks.map((check) => check.name)).toContain("packages");
});

test("buildChecks' discovered set matches the explicit expected roster exactly", () => {
  const checks = buildChecks(
    REAL_CHECKS_DIR,
    path.resolve(REAL_CHECKS_DIR, "..", ".."),
  );
  const names = checks.map((check) => check.name).sort();
  expect(names).toEqual(EXPECTED_CHECK_NAMES);
});
