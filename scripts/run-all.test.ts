// Drives the workspace script runner through its real command line against a
// throwaway fixture workspace. This runner gates every commit for everyone, so
// a swallowed exit code or a package silently skipped here would break the
// merge gate with nothing to catch it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { resolveConcurrency } from "./run-all.ts";
import { SEQUENTIAL_SCRIPTS } from "./sequential-scripts.ts";

const RUNNER = join(import.meta.dir, "run-all.ts");

// Each probe brackets a sleep with a start/end line in a shared log, which is
// what lets a test reconstruct how many probes were in flight at once without
// depending on wall-clock timing.
const PROBE_SOURCE = `import { appendFile } from "node:fs/promises";
import { basename } from "node:path";

const log = process.env["PROBE_LOG"] ?? "";
const name = basename(process.cwd());

await appendFile(log, \`start:\${name}\\n\`);
await Bun.sleep(250);
await appendFile(log, \`end:\${name}\\n\`);
console.log(\`probe ran in \${name}\`);

if (process.env["PROBE_FAIL"] === name) process.exit(1);
`;

const WITH_PROBE = ["alpha", "bravo", "charlie", "delta"] as const;
const WITHOUT_PROBE = "echo-only";
const SEQUENTIAL_SCRIPT = "test";

let workspace = "";
let logCounter = 0;

async function writePackage(
  root: string,
  name: string,
  scripts: Record<string, string>,
): Promise<void> {
  const dir = join(root, "packages", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: `@fixture/${name}`, scripts }, null, 2),
  );
}

type RunnerResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly log: string;
};

async function runProbe(
  extraEnv: Record<string, string> = {},
  script = "probe",
): Promise<RunnerResult> {
  logCounter += 1;
  const logPath = join(workspace, `probe-${logCounter}.log`);
  await writeFile(logPath, "");

  // The parent process may have WORKBENCH_CHECK_CONCURRENCY set for the
  // gate itself. Default-concurrency probes must not inherit it; tests that
  // intend an override pass the var in extraEnv.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PROBE_LOG: logPath,
    ...extraEnv,
  };
  if (!Object.hasOwn(extraEnv, "WORKBENCH_CHECK_CONCURRENCY")) {
    delete env["WORKBENCH_CHECK_CONCURRENCY"];
  }

  const child = Bun.spawn(["bun", "run", RUNNER, script], {
    cwd: workspace,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode, stdout, stderr, log: await readFile(logPath, "utf8") };
}

/** Peak number of probes running at the same moment, from the shared log. */
function peakOverlap(log: string): number {
  let current = 0;
  let peak = 0;
  for (const line of log.split("\n")) {
    if (line.startsWith("start:")) {
      current += 1;
      peak = Math.max(peak, current);
    } else if (line.startsWith("end:")) {
      current -= 1;
    }
  }
  return peak;
}

describe("run-all", () => {
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "workbench-run-all-"));
    for (const name of WITH_PROBE) {
      await writePackage(workspace, name, {
        probe: "bun run probe.ts",
        [SEQUENTIAL_SCRIPT]: "bun run probe.ts",
      });
      await writeFile(
        join(workspace, "packages", name, "probe.ts"),
        PROBE_SOURCE,
      );
    }
    await writePackage(workspace, WITHOUT_PROBE, { other: "true" });

    const vendorDir = join(workspace, "vendor", "intx", "vendor-probe");
    await mkdir(vendorDir, { recursive: true });
    await writeFile(
      join(vendorDir, "package.json"),
      JSON.stringify(
        { name: "@intx/vendor-probe", scripts: { probe: "bun run probe.ts" } },
        null,
        2,
      ),
    );
    await writeFile(join(vendorDir, "probe.ts"), PROBE_SOURCE);
  });

  afterAll(async () => {
    if (workspace !== "") await rm(workspace, { recursive: true, force: true });
  });

  test("runs the script in every package that defines it, and only those", async () => {
    const result = await runProbe();

    for (const name of WITH_PROBE) {
      expect(result.stdout).toContain(`probe ran in ${name}`);
    }
    expect(result.stdout).not.toContain(WITHOUT_PROBE);
    expect(result.exitCode).toBe(0);
  });

  test("runs the script in vendored packages under vendor/intx too", async () => {
    const result = await runProbe();

    expect(result.stdout).toContain("probe ran in vendor-probe");
    expect(result.exitCode).toBe(0);
  });

  test("runs packages concurrently rather than one at a time", async () => {
    const result = await runProbe({ WORKBENCH_CHECK_CONCURRENCY: "4" });

    expect(peakOverlap(result.log)).toBeGreaterThan(1);
  });

  test("never exceeds the configured concurrency", async () => {
    const result = await runProbe({ WORKBENCH_CHECK_CONCURRENCY: "2" });

    expect(peakOverlap(result.log)).toBeLessThanOrEqual(2);
    for (const name of WITH_PROBE) {
      expect(result.stdout).toContain(`probe ran in ${name}`);
    }
  });

  test("runs the test script one package at a time by default", async () => {
    const result = await runProbe({}, SEQUENTIAL_SCRIPT);

    expect(peakOverlap(result.log)).toBe(1);
    for (const name of WITH_PROBE) {
      expect(result.stdout).toContain(`probe ran in ${name}`);
    }
  });

  test("default sequential run ignores ambient WORKBENCH_CHECK_CONCURRENCY", async () => {
    const previous = process.env["WORKBENCH_CHECK_CONCURRENCY"];
    process.env["WORKBENCH_CHECK_CONCURRENCY"] = "4";
    try {
      const result = await runProbe({}, SEQUENTIAL_SCRIPT);

      expect(peakOverlap(result.log)).toBe(1);
    } finally {
      if (previous === undefined) {
        delete process.env["WORKBENCH_CHECK_CONCURRENCY"];
      } else {
        process.env["WORKBENCH_CHECK_CONCURRENCY"] = previous;
      }
    }
  });

  test("honours an explicit concurrency for the test script", async () => {
    const result = await runProbe(
      { WORKBENCH_CHECK_CONCURRENCY: "3" },
      SEQUENTIAL_SCRIPT,
    );

    expect(peakOverlap(result.log)).toBeGreaterThan(1);
  });

  test("rejects a concurrency setting that is not a positive integer", async () => {
    const result = await runProbe({ WORKBENCH_CHECK_CONCURRENCY: "0" });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("WORKBENCH_CHECK_CONCURRENCY");
  });

  test("uses every core in GitHub Actions and leaves two free locally", () => {
    expect(resolveConcurrency("typecheck", {}, 8)).toBe(6);
    expect(resolveConcurrency("typecheck", { GITHUB_ACTIONS: "true" }, 8)).toBe(
      8,
    );
    expect(
      resolveConcurrency(
        "typecheck",
        { GITHUB_ACTIONS: "true", WORKBENCH_CHECK_CONCURRENCY: "3" },
        8,
      ),
    ).toBe(3);
    expect(resolveConcurrency("test", { GITHUB_ACTIONS: "true" }, 8)).toBe(1);
  });

  test("fails the run and names the package whose script failed", async () => {
    const result = await runProbe({ PROBE_FAIL: "charlie" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("@fixture/charlie");
  });

  test("keeps a failing package from cancelling its siblings", async () => {
    const result = await runProbe({ PROBE_FAIL: "charlie" });

    for (const name of WITH_PROBE) {
      expect(result.stdout).toContain(`probe ran in ${name}`);
    }
  });

  test("attributes each package's output to that package", async () => {
    const result = await runProbe();

    for (const name of WITH_PROBE) {
      const header = result.stdout.indexOf(`@fixture/${name}`);
      const output = result.stdout.indexOf(`probe ran in ${name}`);
      expect(header).toBeGreaterThanOrEqual(0);
      expect(header).toBeLessThan(output);
    }
  });

  test("reports when no package defines the script", async () => {
    const child = Bun.spawn(["bun", "run", RUNNER, "nothing-defines-this"], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("no workspace packages define it");
  });

  test("fixture workspace holds only the packages the tests declare", () => {
    expect(basename(workspace).startsWith("workbench-run-all-")).toBe(true);
  });

  // Without this, renaming the script the root gate hands the runner would
  // silently restore concurrency to the test phase, and the flakiness that
  // causes would surface later as an unrelated-looking regression.
  test("the root gate runs its test phase through a script declared sequential", async () => {
    const manifest = (await Bun.file(
      join(import.meta.dir, "..", "package.json"),
    ).json()) as { scripts?: Record<string, string> };
    const testScript = manifest.scripts?.["test"] ?? "";

    const invoked = [...testScript.matchAll(/run-all\.ts\s+([\w:-]+)/g)].map(
      (match) => match[1],
    );

    expect(invoked.length).toBeGreaterThan(0);
    for (const script of invoked) {
      expect(SEQUENTIAL_SCRIPTS.has(script ?? "")).toBe(true);
    }
  });
});
