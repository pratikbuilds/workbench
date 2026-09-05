// CL-7389: `resolvePinnedVersion` must resolve to a concrete, reproducible
// version — semver-sorted (never string-sorted), matched to the exact
// package name (never a prefix/suffix neighbor), and preferring the
// highest STABLE version over a higher-sorting prerelease. These are
// pure-fake-db unit tests: no real Postgres, since `resolveAssetByName`'s
// ancestor-chain walk only needs `db.query.tenant`/`db.query.asset` to
// answer plausibly (`test/tool-package-version.drizzle.test.ts` covers the
// real ancestor-chain walk against Postgres).
import { expect, test } from "bun:test";
import type { DB } from "@intx/db";
import type { AssetService } from "@intx/hub-sessions";
import { CORBITS_TOOLS_REGISTRY } from "@corbits/tool-registry-publish";

import { CapabilityOutOfInventoryError } from "./capability-inventory";
import {
  createPinnedVersionResolver,
  resolvePinnedVersion,
} from "./tool-package-version";

const TENANT_ID = "tnt_1";

const REGISTRY_ASSET = {
  id: "ast_corbits_tools",
  tenantId: TENANT_ID,
  kind: "package-registry" as const,
  name: CORBITS_TOOLS_REGISTRY,
  displayName: CORBITS_TOOLS_REGISTRY,
  creatorPrincipalId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function registryDb(counters: { tenant: number; asset: number }): DB["db"] {
  return {
    query: {
      tenant: {
        findFirst: async () => {
          counters.tenant++;
          return { parentId: null };
        },
      },
      asset: {
        findFirst: async () => {
          counters.asset++;
          return REGISTRY_ASSET;
        },
      },
    },
  } as unknown as DB["db"];
}

function assetServiceWith(
  tarballs: string[],
  counters: { list: number },
): AssetService {
  return {
    createAsset: () => {
      throw new Error("not used");
    },
    populateAsset: () => {
      throw new Error("not used");
    },
    readAssetBlob: () => {
      throw new Error("not used");
    },
    listAssetBlobs: () => {
      counters.list++;
      return Promise.resolve(tarballs);
    },
  };
}

test("a stable version wins over a higher-sorting prerelease", async () => {
  const c = { tenant: 0, asset: 0, list: 0 };
  const resolved = await resolvePinnedVersion(
    {
      db: registryDb(c),
      assetService: assetServiceWith(
        [
          "corbits-memory-tools-1.9.0.tgz",
          "corbits-memory-tools-2.0.0-rc.1.tgz",
        ],
        c,
      ),
    },
    TENANT_ID,
    "@corbits/memory-tools",
  );
  expect(resolved.version).toBe("1.9.0");
});

test("a prerelease wins only when the registry carries no stable version", async () => {
  const c = { tenant: 0, asset: 0, list: 0 };
  const resolved = await resolvePinnedVersion(
    {
      db: registryDb(c),
      assetService: assetServiceWith(
        [
          "corbits-memory-tools-2.0.0-rc.1.tgz",
          "corbits-memory-tools-2.0.0-rc.2.tgz",
        ],
        c,
      ),
    },
    TENANT_ID,
    "@corbits/memory-tools",
  );
  expect(resolved.version).toBe("2.0.0-rc.2");
});

test("string sort would pick 1.9.0 over 1.10.0; semver picks 1.10.0", async () => {
  const c = { tenant: 0, asset: 0, list: 0 };
  const resolved = await resolvePinnedVersion(
    {
      db: registryDb(c),
      assetService: assetServiceWith(
        ["corbits-memory-tools-1.9.0.tgz", "corbits-memory-tools-1.10.0.tgz"],
        c,
      ),
    },
    TENANT_ID,
    "@corbits/memory-tools",
  );
  expect(resolved.version).toBe("1.10.0");
});

test("a name that is a prefix of another package does not steal its tarballs", async () => {
  const c = { tenant: 0, asset: 0, list: 0 };
  await expect(
    resolvePinnedVersion(
      {
        db: registryDb(c),
        assetService: assetServiceWith(["corbits-memory-tools-1.0.0.tgz"], c),
      },
      TENANT_ID,
      "@corbits/memory",
    ),
  ).rejects.toBeInstanceOf(CapabilityOutOfInventoryError);
});

test("a longer package name does not match a shorter package's tarball", async () => {
  const c = { tenant: 0, asset: 0, list: 0 };
  await expect(
    resolvePinnedVersion(
      {
        db: registryDb(c),
        assetService: assetServiceWith(["corbits-memory-1.0.0.tgz"], c),
      },
      TENANT_ID,
      "@corbits/memory-tools",
    ),
  ).rejects.toBeInstanceOf(CapabilityOutOfInventoryError);
});

test("package name case must match the tarball filename exactly", async () => {
  const c = { tenant: 0, asset: 0, list: 0 };
  await expect(
    resolvePinnedVersion(
      {
        db: registryDb(c),
        assetService: assetServiceWith(["corbits-memory-tools-1.0.0.tgz"], c),
      },
      TENANT_ID,
      "@Corbits/Memory-Tools",
    ),
  ).rejects.toBeInstanceOf(CapabilityOutOfInventoryError);
});

test("createPinnedVersionResolver loads the registry and its listing at most once across several names", async () => {
  const c = { tenant: 0, asset: 0, list: 0 };
  const resolve = createPinnedVersionResolver(
    {
      db: registryDb(c),
      assetService: assetServiceWith(
        [
          "corbits-a-tools-1.0.0.tgz",
          "corbits-b-tools-2.0.0.tgz",
          "corbits-c-tools-3.0.0.tgz",
        ],
        c,
      ),
    },
    TENANT_ID,
  );
  const a = await resolve("@corbits/a-tools");
  const b = await resolve("@corbits/b-tools");
  const cc = await resolve("@corbits/c-tools");
  expect(a.version).toBe("1.0.0");
  expect(b.version).toBe("2.0.0");
  expect(cc.version).toBe("3.0.0");
  expect(c.list).toBe(1);
  expect(c.asset).toBe(1);
  expect(c.tenant).toBe(1);
});
