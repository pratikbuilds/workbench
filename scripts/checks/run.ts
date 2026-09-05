// check:structural — the single check runner.
//
// Every structural check used to get its own root `package.json` script
// (`check:report-error`, `check:licenses`, ...) plus a line in
// `check:structural`'s chain, so adding a check meant touching both. This
// runner instead discovers every `scripts/checks/*.ts` file that has an
// `if (import.meta.main)` entry point — that is the same signal each check
// already carries to run standalone during development — and runs it. A
// file with no such entry point (a shared lib, an allowlist data module, a
// `*.test.ts`) is not a check and is skipped. The runner itself
// (`run.ts`, or anything whose resolved real path points at it — a
// rename or a symlink included) is excluded even though it carries the
// same entry point, so it never discovers and recurses into itself.
//
// `scripts/generate-tsconfig-references.ts --check` lives outside this
// directory (it doubles as the reference generator), so it is added
// explicitly rather than discovered.
//
// `check:packages` (packed-consumption audit) was never part of the full
// `check:structural` chain before CL-7442 — it spawns a subprocess per
// workspace package to prove each one only imports what it packs, which
// takes minutes rather than seconds. It stays discoverable and runnable on
// its own (`bun run check:structural packages`), but is excluded from the
// full run so `check:structural`'s wall-clock does not regress.
//
// An optional name argument runs just that one check (by its filename
// without `.ts`, or `tsconfig-references`), forwarding any further
// arguments to it — e.g. `bun run check:structural report-error --
// --write-baseline`.
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

const CHECKS_DIR = path.resolve(import.meta.dir);
const ROOT = path.resolve(CHECKS_DIR, "..", "..");

export interface Check {
  readonly name: string;
  readonly command: readonly string[];
}

const MAIN_ENTRY_POINT = /if\s*\(\s*import\.meta\.main\s*\)/;

/** Discoverable and independently runnable, but excluded from a full run. */
const EXCLUDED_FROM_FULL_RUN = new Set(["packages"]);

// The runner itself lives in this directory and also has an
// `import.meta.main` entry point — without excluding it, it would
// discover itself as a check and spawn an unbounded recursion of itself.
// Excluded by resolved real path (not by filename) so a rename or a
// symlink pointing at this file is still recognized as "the runner"
// rather than slipping in as a discovered check.
export function discoverCheckFiles(
  checksDir: string,
  readdir: (dir: string) => string[] = (dir) => readdirSync(dir),
  readFile: (file: string) => string = (file) => readFileSync(file, "utf8"),
  runnerRealPath: string = realpathSync(import.meta.path),
  resolveRealPath: (file: string) => string = (file) => realpathSync(file),
): string[] {
  return readdir(checksDir)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .filter(
      (entry) =>
        resolveRealPath(path.join(checksDir, entry)) !== runnerRealPath,
    )
    .filter((entry) =>
      MAIN_ENTRY_POINT.test(readFile(path.join(checksDir, entry))),
    )
    .sort();
}

export function buildChecks(checksDir: string, root: string): Check[] {
  const checks: Check[] = discoverCheckFiles(checksDir).map((file) => ({
    name: file.slice(0, -".ts".length),
    command: ["bun", "run", path.join(checksDir, file)],
  }));
  checks.push({
    name: "tsconfig-references",
    command: [
      "bun",
      "run",
      path.join(root, "scripts", "generate-tsconfig-references.ts"),
      "--check",
    ],
  });
  return checks.sort((a, b) => a.name.localeCompare(b.name));
}

async function run(command: readonly string[]): Promise<number> {
  const proc = Bun.spawn([...command], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

async function main(): Promise<void> {
  const [only, ...rest] = Bun.argv.slice(2);
  const checks = buildChecks(CHECKS_DIR, ROOT);

  if (only !== undefined) {
    const check = checks.find((candidate) => candidate.name === only);
    if (!check) {
      console.error(
        `check:structural: no check named "${only}". Known checks: ` +
          checks.map((candidate) => candidate.name).join(", "),
      );
      process.exit(1);
    }
    process.exit(await run([...check.command, ...rest]));
  }

  let failed = false;

  console.log("--- scripts/checks/test ---");
  if ((await run(["bun", "test", "scripts/checks/test"])) !== 0) failed = true;

  for (const check of checks) {
    if (EXCLUDED_FROM_FULL_RUN.has(check.name)) continue;
    console.log(`--- ${check.name} ---`);
    if ((await run(check.command)) !== 0) failed = true;
  }

  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
