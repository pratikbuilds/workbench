// check:catalog-pins — a dependency declared in the root `catalog` (or a
// named catalog under `catalogs`) must be consumed as `catalog:` (or
// `catalog:<name>`) everywhere. A literal range for a catalogued
// dependency is how the same package ends up pinned two ways (CL-7442
// found drizzle-orm, hono, postgres, and @types/react-dom drifted this
// way) — one workspace bumps its own literal, the rest don't, and the
// version actually installed depends on hoisting order.
//
// vendor/intx/*/package.json is excluded: those manifests are governed
// by the vendoring ledger (VENDORED.md), not by this repo's catalog.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";
import { type } from "arktype";
import {
  emptyReport,
  reportAndExit,
  rootFromArgs,
  type CheckReport,
} from "./lib/repo";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
] as const;

const PackageJson = type({
  "dependencies?": "Record<string, string>",
  "devDependencies?": "Record<string, string>",
  "peerDependencies?": "Record<string, string>",
  "catalog?": "Record<string, string>",
  "catalogs?": "Record<string, Record<string, string>>",
  "workspaces?": "unknown",
});

type PackageJson = typeof PackageJson.infer;

export const WORKSPACE_GLOBS = [
  "apps/*/package.json",
  "packages/*/package.json",
  "tools/*/package.json",
  "templates/package.json",
  "workflows/*/package.json",
];

function parsePackageJson(raw: string, source: string): PackageJson {
  const parsed = PackageJson(JSON.parse(raw));
  if (parsed instanceof type.errors) {
    throw new Error(`${source}: invalid package.json — ${parsed.summary}`);
  }
  return parsed;
}

/** Resolves the root's default catalog plus any named catalogs, either
 * from a top-level `catalog`/`catalogs` or from `workspaces.catalog` /
 * `workspaces.catalogs` (bun accepts both shapes). */
export function resolveCatalogs(rootPackageJson: PackageJson): {
  readonly default: Readonly<Record<string, string>>;
  readonly named: Readonly<Record<string, Readonly<Record<string, string>>>>;
} {
  const workspaces = rootPackageJson.workspaces;
  const workspacesObject =
    workspaces && typeof workspaces === "object" && !Array.isArray(workspaces)
      ? (workspaces as {
          catalog?: Record<string, string>;
          catalogs?: Record<string, Record<string, string>>;
        })
      : undefined;

  return {
    default: rootPackageJson.catalog ?? workspacesObject?.catalog ?? {},
    named: rootPackageJson.catalogs ?? workspacesObject?.catalogs ?? {},
  };
}

export function auditCatalogPins(
  catalog: Readonly<Record<string, string>>,
  workspaces: readonly { dir: string; packageJson: PackageJson }[],
  namedCatalogs: Readonly<
    Record<string, Readonly<Record<string, string>>>
  > = {},
): CheckReport {
  const report = emptyReport();
  const catalogued = new Set(Object.keys(catalog));
  const cataloguedByName = new Map(
    Object.entries(namedCatalogs).map(([catalogName, deps]) => [
      catalogName,
      new Set(Object.keys(deps)),
    ]),
  );

  for (const { dir, packageJson } of workspaces) {
    for (const field of DEPENDENCY_FIELDS) {
      const deps = packageJson[field];
      if (!deps) continue;
      for (const [name, range] of Object.entries(deps)) {
        if (range.startsWith("catalog:")) continue;
        if (catalogued.has(name)) {
          report.violations.push(
            `${dir}/package.json: "${name}" is declared in the root ` +
              `catalog but pinned here as a literal ("${range}") instead ` +
              `of "catalog:" — either use "catalog:" or drop the entry ` +
              `from the root catalog if this package intentionally needs ` +
              `a different version.`,
          );
          continue;
        }
        for (const [catalogName, names] of cataloguedByName) {
          if (!names.has(name)) continue;
          report.violations.push(
            `${dir}/package.json: "${name}" is declared in the ` +
              `"${catalogName}" catalog but pinned here as a literal ` +
              `("${range}") instead of "catalog:${catalogName}" — either ` +
              `use "catalog:${catalogName}" or drop the entry from that ` +
              `catalog if this package intentionally needs a different ` +
              `version.`,
          );
          break;
        }
      }
    }
  }
  return report;
}

async function listWorkspaces(
  root: string,
): Promise<{ dir: string; packageJson: PackageJson }[]> {
  const workspaces: { dir: string; packageJson: PackageJson }[] = [];
  for (const pattern of WORKSPACE_GLOBS) {
    const glob = new Glob(pattern);
    for await (const manifestPath of glob.scan(root)) {
      const dir = path.dirname(manifestPath);
      const packageJson = parsePackageJson(
        readFileSync(path.join(root, manifestPath), "utf8"),
        manifestPath,
      );
      workspaces.push({ dir, packageJson });
    }
  }
  return workspaces;
}

async function main(): Promise<void> {
  const root = rootFromArgs(Bun.argv.slice(2));
  const rootPackageJsonPath = path.join(root, "package.json");
  const rootPackageJson = existsSync(rootPackageJsonPath)
    ? parsePackageJson(
        readFileSync(rootPackageJsonPath, "utf8"),
        "package.json",
      )
    : ({} as PackageJson);
  const { default: catalog, named: namedCatalogs } =
    resolveCatalogs(rootPackageJson);
  const workspaces = await listWorkspaces(root);
  const report = auditCatalogPins(catalog, workspaces, namedCatalogs);
  if (workspaces.length === 0) {
    report.notes.push("no workspace packages yet.");
  }
  report.notes.push(
    "vendor/intx/*/package.json is excluded — vendored manifests are " +
      "governed by VENDORED.md, not this repo's catalog.",
  );
  reportAndExit("check:catalog-pins", report);
}

if (import.meta.main) await main();
