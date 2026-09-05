// Registry drift guard: every `@corbits`-scoped tool-package pin a
// workflow `seedTenant` actually deploys must be in
// `CORBITS_TOOL_PACKAGE_DIRS` so `workbench setup` publishes it onto
// the root. Missing a dir fails the closure resolver with "unknown
// registry" the moment a descendant launches. This suite fails loud,
// naming the exact missing package, so adding a pin to a default
// workflow without also registering its package dir is caught here
// instead of at a stranger's first login.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { CORBITS_TOOL_PACKAGE_DIRS } from "@corbits/tool-registry-publish";
import {
  CATALOG_TEST_WORKFLOWS,
  CATALOG_WORKFLOWS,
  DEFAULT_WORKFLOWS,
  type DefaultWorkflow,
} from "../src/seed";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

const MODEL = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  baseURL: "https://api.anthropic.com",
  apiKey: "sk-test",
};

type ToolPackagePinLike = { name: string; version: string };

function publishedCorbitsPackageNames(): Set<string> {
  const names = new Set<string>();
  for (const dir of CORBITS_TOOL_PACKAGE_DIRS) {
    const pkg = JSON.parse(
      readFileSync(path.join(dir, "package.json"), "utf8"),
    ) as { name: string };
    names.add(pkg.name);
  }
  return names;
}

/** Every `@corbits`-scoped `toolPackagePins` entry across every step
 * agent in a serialized workflow definition. Mirrors the shape
 * `@corbits/agent-directory`'s `DefinitionWithAgentSteps` validates:
 * `{ steps: { [id]: { agent: { toolPackagePins?: [{name, version}] } } } }`. */
function corbitsPinsIn(definitionJson: string): ToolPackagePinLike[] {
  const parsed = JSON.parse(definitionJson) as {
    steps?: Record<string, { agent?: { toolPackagePins?: unknown } }>;
  };
  const pins: ToolPackagePinLike[] = [];
  for (const stepDef of Object.values(parsed.steps ?? {})) {
    const rawPins = stepDef.agent?.toolPackagePins;
    if (!Array.isArray(rawPins)) continue;
    for (const rawPin of rawPins) {
      if (
        typeof rawPin === "object" &&
        rawPin !== null &&
        "name" in rawPin &&
        "version" in rawPin &&
        typeof rawPin.name === "string" &&
        typeof rawPin.version === "string" &&
        rawPin.name.startsWith("@corbits/")
      ) {
        pins.push({ name: rawPin.name, version: rawPin.version });
      }
    }
  }
  return pins;
}

function pinsFor(workflows: readonly DefaultWorkflow[]): {
  workflow: string;
  pin: ToolPackagePinLike;
}[] {
  const found: { workflow: string; pin: ToolPackagePinLike }[] = [];
  for (const workflow of workflows) {
    const json = workflow.buildJson("example.com", [
      { provider: MODEL.provider, model: MODEL.model },
    ]);
    for (const pin of corbitsPinsIn(json)) {
      found.push({ workflow: workflow.assetName, pin });
    }
  }
  return found;
}

describe("corbits-tools registry coverage", () => {
  test("every @corbits pin among the workflows seedTenant deploys is published by CORBITS_TOOL_PACKAGE_DIRS", () => {
    const published = publishedCorbitsPackageNames();
    const deployed = pinsFor([
      ...DEFAULT_WORKFLOWS,
      ...CATALOG_WORKFLOWS,
      ...CATALOG_TEST_WORKFLOWS,
    ]);
    const missing = deployed.filter(({ pin }) => !published.has(pin.name));

    if (missing.length > 0) {
      const missingList = missing
        .map(
          ({ workflow, pin }) => `${workflow} pins ${pin.name}@${pin.version}`,
        )
        .join("; ");
      throw new Error(
        `The following @corbits tool-package pins have no published ` +
          `tarball: ${missingList}. Register the missing package's ` +
          `directory in packages/tool-registry-publish/src/registry.ts's ` +
          `CORBITS_TOOL_PACKAGE_DIRS.`,
      );
    }
    expect(missing).toEqual([]);
  });

  // Soft, informational coverage: the same check extended across every
  // catalog workflow, deployed or not, sourced by reading each
  // `workflows/*/src/index.ts` directly rather than importing it (these
  // packages are installable data, not static dependencies of this
  // package — see `@corbits/agent-directory`'s README). Widening this
  // set is expected right up until a workflow gains a real deploy path
  // through `DEFAULT_WORKFLOWS`/`CATALOG_TEST_WORKFLOWS`, at which point
  // the hard check above starts enforcing it instead. This snapshot
  // exists so a *new* unpublished pin appearing on a catalog-only
  // workflow is visible here — while it is still catalog-only — rather
  // than silent until someone deploys it.
  test("catalog-wide (informational): unpublished @corbits pins outside the deployed set are exactly the known, tracked gap", () => {
    const published = publishedCorbitsPackageNames();
    const deployedAssetNames = new Set(
      [
        ...DEFAULT_WORKFLOWS,
        ...CATALOG_WORKFLOWS,
        ...CATALOG_TEST_WORKFLOWS,
      ].map((workflow) => workflow.assetName),
    );
    const workflowsDir = path.join(REPO_ROOT, "workflows");
    const pinPattern = /name:\s*"(@corbits\/[a-zA-Z0-9_-]+)"/g;
    const uncoveredWorkflows = new Set<string>();

    for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || deployedAssetNames.has(entry.name)) continue;
      let source: string;
      try {
        source = readFileSync(
          path.join(workflowsDir, entry.name, "src", "index.ts"),
          "utf8",
        );
      } catch {
        continue;
      }
      for (const match of source.matchAll(pinPattern)) {
        const pkgName = match[1];
        if (pkgName !== undefined && !published.has(pkgName)) {
          uncoveredWorkflows.add(entry.name);
        }
      }
    }

    expect([...uncoveredWorkflows].sort()).toEqual([]);
  });

  // The class guard: every `@corbits`-scoped pin literal anywhere in the
  // repo — every `workflows/*/src/index.ts` (deployed or catalog-only,
  // active or not yet wired through `toolPackagePins`) plus every
  // statically injected pin idiom (`SKILLS_TOOL_PACKAGE_PIN` in
  // `@corbits/agent-directory`, the inline pins `apps/hub/src/index.ts`
  // pushes for its built-in connectors) — must resolve through
  // `CORBITS_TOOL_PACKAGE_DIRS`. This is broader than the deployed-only
  // hard check above and the catalog-only informational check: it is
  // the one place a *new* unresolvable pin, anywhere, fails loud with
  // its exact location instead of surfacing as a stranger's runtime
  // "unknown registry" error.
  test("every @corbits pin literal in the repo — workflow definitions and static pin idioms alike — is published by CORBITS_TOOL_PACKAGE_DIRS", () => {
    const published = publishedCorbitsPackageNames();
    const pinPattern = /name:\s*"(@corbits\/[a-zA-Z0-9_-]+)"/g;
    const found: { location: string; name: string }[] = [];

    const workflowsDir = path.join(REPO_ROOT, "workflows");
    for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const indexPath = path.join(workflowsDir, entry.name, "src", "index.ts");
      let source: string;
      try {
        source = readFileSync(indexPath, "utf8");
      } catch {
        continue;
      }
      for (const match of source.matchAll(pinPattern)) {
        const pkgName = match[1];
        if (pkgName !== undefined) {
          found.push({
            location: `workflows/${entry.name}/src/index.ts`,
            name: pkgName,
          });
        }
      }
    }

    const staticPinSites = [
      "packages/agent-directory/src/agent-workflow.ts",
      "apps/hub/src/index.ts",
    ];
    for (const relativePath of staticPinSites) {
      const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
      for (const match of source.matchAll(pinPattern)) {
        const pkgName = match[1];
        if (pkgName !== undefined) {
          found.push({ location: relativePath, name: pkgName });
        }
      }
    }

    const missing = found.filter(({ name }) => !published.has(name));

    if (missing.length > 0) {
      const missingList = missing
        .map(({ location, name }) => `${location} pins ${name}`)
        .join("; ");
      throw new Error(
        `The following @corbits tool-package pin literals have no ` +
          `published tarball: ${missingList}. Register the missing ` +
          `package's directory in ` +
          `packages/tool-registry-publish/src/registry.ts's ` +
          `CORBITS_TOOL_PACKAGE_DIRS, or remove the pin if the package ` +
          `is not meant to be a publishable tool package.`,
      );
    }
    expect(missing).toEqual([]);
  });
});
