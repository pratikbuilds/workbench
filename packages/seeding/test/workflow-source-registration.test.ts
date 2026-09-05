// CL-7073 critique: `CATALOG_WORKFLOWS` had drifted to 4 entries while
// `workflows/` carried roughly 15 source packages — most of a template's
// blocks (the GTM template's, in particular) 404ed through the catalog
// instantiate route because nothing in `@corbits/seeding` knew about
// them. This test makes that drift structural: every directory under
// `workflows/` must appear in exactly one of `DEFAULT_WORKFLOWS`,
// `CATALOG_WORKFLOWS`, `CATALOG_TEST_WORKFLOWS`, or
// `EXCLUDED_WORKFLOW_SOURCES` (with a one-line reason). A new
// `workflows/<name>` package that nobody wires up fails this test
// instead of silently 404ing through the route.
import { expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  CATALOG_WORKFLOWS,
  CATALOG_TEST_WORKFLOWS,
  DEFAULT_WORKFLOWS,
  EXCLUDED_WORKFLOW_SOURCES,
} from "../src/seed";

const workflowsDir = path.join(
  fileURLToPath(new URL("..", import.meta.url)),
  "..",
  "..",
  "workflows",
);

function workflowSourceDirectories(): string[] {
  return readdirSync(workflowsDir).filter((entry) =>
    statSync(path.join(workflowsDir, entry)).isDirectory(),
  );
}

test("every workflows/ source directory is registered in exactly one bucket", () => {
  const sources = workflowSourceDirectories();
  expect(sources.length).toBeGreaterThan(0);

  const registeredNames = [
    ...DEFAULT_WORKFLOWS,
    ...CATALOG_WORKFLOWS,
    ...CATALOG_TEST_WORKFLOWS,
  ].map((workflow) => workflow.assetName);
  const excludedNames = EXCLUDED_WORKFLOW_SOURCES.map(
    (excluded) => excluded.name,
  );

  for (const source of sources) {
    const isRegistered = registeredNames.includes(source);
    const isExcluded = excludedNames.includes(source);
    if (isRegistered === isExcluded) {
      throw new Error(
        `workflows/${source} must be registered in exactly one of ` +
          `DEFAULT_WORKFLOWS/CATALOG_WORKFLOWS/CATALOG_TEST_WORKFLOWS or ` +
          `EXCLUDED_WORKFLOW_SOURCES (registered=${isRegistered}, excluded=${isExcluded})`,
      );
    }
  }

  // Every excluded entry names a real source directory and a real
  // reason — an excluded name that stops matching any directory (the
  // package was deleted, or actually got registered) is a stale entry.
  for (const excluded of EXCLUDED_WORKFLOW_SOURCES) {
    expect(sources).toContain(excluded.name);
    expect(excluded.reason.length).toBeGreaterThan(0);
  }

  // No asset name is double-registered across the deployable buckets.
  expect(new Set(registeredNames).size).toBe(registeredNames.length);
});
