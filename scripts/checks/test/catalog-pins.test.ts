import { expect, test } from "bun:test";
import {
  WORKSPACE_GLOBS,
  auditCatalogPins,
  resolveCatalogs,
} from "../catalog-pins";

test("a literal range for a catalogued dependency is a violation", () => {
  const report = auditCatalogPins({ hono: "^4.11.9" }, [
    {
      dir: "packages/inbox",
      packageJson: { dependencies: { hono: "^4.11.9" } },
    },
  ]);
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("packages/inbox/package.json");
  expect(report.violations[0]).toContain("hono");
});

test("catalog: for a catalogued dependency passes", () => {
  const report = auditCatalogPins({ hono: "^4.11.9" }, [
    {
      dir: "packages/inbox",
      packageJson: { dependencies: { hono: "catalog:" } },
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("a literal for a dependency not in the catalog is fine", () => {
  const report = auditCatalogPins({ hono: "^4.11.9" }, [
    {
      dir: "packages/inbox",
      packageJson: { dependencies: { react: "^19.2.0" } },
    },
  ]);
  expect(report.violations).toEqual([]);
});

test("checks devDependencies and peerDependencies too", () => {
  const report = auditCatalogPins({ postgres: "^3.4.8" }, [
    {
      dir: "packages/a",
      packageJson: { devDependencies: { postgres: "^3.4.8" } },
    },
    {
      dir: "packages/b",
      packageJson: { peerDependencies: { postgres: "^3.4.8" } },
    },
  ]);
  expect(report.violations).toHaveLength(2);
});

test("a literal range for a dependency in a named catalog is a violation", () => {
  const report = auditCatalogPins(
    {},
    [
      {
        dir: "packages/inbox",
        packageJson: { dependencies: { react: "^19.2.0" } },
      },
    ],
    { react19: { react: "^19.2.0" } },
  );
  expect(report.violations).toHaveLength(1);
  expect(report.violations[0]).toContain("packages/inbox/package.json");
  expect(report.violations[0]).toContain("react");
  expect(report.violations[0]).toContain("catalog:react19");
});

test("catalog:<name> for a dependency in that named catalog passes", () => {
  const report = auditCatalogPins(
    {},
    [
      {
        dir: "packages/inbox",
        packageJson: { dependencies: { react: "catalog:react19" } },
      },
    ],
    { react19: { react: "^19.2.0" } },
  );
  expect(report.violations).toEqual([]);
});

test("resolveCatalogs reads a top-level catalog and catalogs", () => {
  const resolved = resolveCatalogs({
    catalog: { hono: "^4.11.9" },
    catalogs: { react19: { react: "^19.2.0" } },
  });
  expect(resolved.default).toEqual({ hono: "^4.11.9" });
  expect(resolved.named).toEqual({ react19: { react: "^19.2.0" } });
});

test("resolveCatalogs falls back to workspaces.catalog / workspaces.catalogs", () => {
  const resolved = resolveCatalogs({
    workspaces: {
      catalog: { hono: "^4.11.9" },
      catalogs: { react19: { react: "^19.2.0" } },
    },
  });
  expect(resolved.default).toEqual({ hono: "^4.11.9" });
  expect(resolved.named).toEqual({ react19: { react: "^19.2.0" } });
});

test("resolveCatalogs defaults to empty when neither location is present", () => {
  const resolved = resolveCatalogs({ workspaces: ["packages/*"] });
  expect(resolved.default).toEqual({});
  expect(resolved.named).toEqual({});
});

test("vendored manifests are excluded from workspace discovery", () => {
  expect(WORKSPACE_GLOBS.some((glob) => glob.startsWith("vendor/"))).toBe(
    false,
  );
});
