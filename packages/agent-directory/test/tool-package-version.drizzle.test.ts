// DB-gated: skipped when no DATABASE_URL is reachable (a fresh checkout
// still runs the unit gates), mirroring
// `visible-definitions.drizzle.test.ts`. Only `resolveAssetByName`'s
// tenant-ancestor-chain walk needs a real Postgres — the tarball
// listing itself is a hand-rolled fake `AssetService` (`routes.test.ts`'s
// convention), never a real git substrate.
//
// Proves CL-7389: a runtime tool-package pin resolves to the HIGHEST
// published version among the tenant's (possibly inherited)
// `corbits-tools` registry tarballs, never `*` — and fails closed with
// the same `CapabilityOutOfInventoryError` the guided-capability-add
// path already maps to a 4xx when the registry or the package is
// absent.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDB, dropSchema, runMigrations, schema } from "@intx/db";
import type { AssetService } from "@intx/hub-sessions";
import { CORBITS_TOOLS_REGISTRY } from "@corbits/tool-registry-publish";

import { dbTargetFromUrl } from "../../../scripts/db-setup";
import { e2eDatabaseUrl } from "../../../scripts/e2e/harness";
import { dbGate } from "../../../scripts/e2e/db-gate";
import { CapabilityOutOfInventoryError } from "../src/capability-inventory";
import { resolvePinnedVersion } from "../src/tool-package-version";

const databaseUrl = e2eDatabaseUrl();
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const SCHEMA = "agent_directory_tool_package_version_test";

function fakeAssetService(
  filenamesByDir: Record<string, string[]>,
): AssetService {
  return {
    createAsset: () => {
      throw new Error("not used in these tests");
    },
    populateAsset: () => {
      throw new Error("not used in these tests");
    },
    readAssetBlob: () => {
      throw new Error("not used in these tests");
    },
    listAssetBlobs: ({ dir }) => Promise.resolve(filenamesByDir[dir] ?? []),
  };
}

async function seedTenant(
  db: Awaited<ReturnType<typeof createDB>>["db"],
  input: { id: string; parentId?: string },
) {
  await db.insert(schema.tenant).values({
    id: input.id,
    name: input.id,
    slug: input.id.replace(/_/g, "-"),
    domain: `${input.id.replace(/_/g, "-")}.workbench.test`,
    ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
  });
}

describeIfDb(
  "resolvePinnedVersion: resolves against the tenant's corbits-tools registry",
  () => {
    const target = dbTargetFromUrl(
      databaseUrl ?? "postgres://localhost:5432/unused",
    );

    beforeAll(async () => {
      await runMigrations(target, { schema: SCHEMA });
    });

    afterAll(async () => {
      await dropSchema(target, { schema: SCHEMA });
    });

    test("resolves the highest published version among the registry's tarballs", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        const tenantId = `tnt_tpv_${randomUUID().slice(0, 8)}`;
        await seedTenant(db, { id: tenantId });
        await db.insert(schema.asset).values({
          id: `asset_${tenantId}`,
          tenantId,
          kind: "package-registry",
          name: CORBITS_TOOLS_REGISTRY,
        });

        const assetService = fakeAssetService({
          tarballs: [
            "corbits-memory-tools-1.2.0.tgz",
            "corbits-memory-tools-1.10.0.tgz",
            "corbits-memory-tools-1.3.0.tgz",
            "corbits-capability-tools-0.0.2.tgz",
          ],
        });
        const resolved = await resolvePinnedVersion(
          { db, assetService },
          tenantId,
          "@corbits/memory-tools",
        );
        expect(resolved).toEqual({
          name: "@corbits/memory-tools",
          version: "1.10.0",
        });
      } finally {
        await close();
      }
    });

    test("a child tenant resolves against its inherited (ancestor-owned) registry", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        const rootId = `tnt_tpv_root_${randomUUID().slice(0, 8)}`;
        const childId = `tnt_tpv_child_${randomUUID().slice(0, 8)}`;
        await seedTenant(db, { id: rootId });
        await seedTenant(db, { id: childId, parentId: rootId });
        await db.insert(schema.asset).values({
          id: `asset_${rootId}`,
          tenantId: rootId,
          kind: "package-registry",
          name: CORBITS_TOOLS_REGISTRY,
        });

        const assetService = fakeAssetService({
          tarballs: ["corbits-capability-tools-0.0.2.tgz"],
        });
        const resolved = await resolvePinnedVersion(
          { db, assetService },
          childId,
          "@corbits/capability-tools",
        );
        expect(resolved).toEqual({
          name: "@corbits/capability-tools",
          version: "0.0.2",
        });
      } finally {
        await close();
      }
    });

    test("pinning a package absent from the registry fails closed", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        const tenantId = `tnt_tpv_${randomUUID().slice(0, 8)}`;
        await seedTenant(db, { id: tenantId });
        await db.insert(schema.asset).values({
          id: `asset_${tenantId}`,
          tenantId,
          kind: "package-registry",
          name: CORBITS_TOOLS_REGISTRY,
        });

        const assetService = fakeAssetService({
          tarballs: ["corbits-memory-tools-1.0.0.tgz"],
        });
        await expect(
          resolvePinnedVersion(
            { db, assetService },
            tenantId,
            "@corbits/no-such-tools",
          ),
        ).rejects.toBeInstanceOf(CapabilityOutOfInventoryError);
      } finally {
        await close();
      }
    });

    test("a tenant with no visible corbits-tools registry fails closed", async () => {
      const { db, close } = createDB({ ...target, schema: SCHEMA });
      try {
        const tenantId = `tnt_tpv_${randomUUID().slice(0, 8)}`;
        await seedTenant(db, { id: tenantId });

        const assetService = fakeAssetService({});
        await expect(
          resolvePinnedVersion(
            { db, assetService },
            tenantId,
            "@corbits/memory-tools",
          ),
        ).rejects.toBeInstanceOf(CapabilityOutOfInventoryError);
      } finally {
        await close();
      }
    });
  },
);
