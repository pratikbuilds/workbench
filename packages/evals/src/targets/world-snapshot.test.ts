import { expect, test } from "bun:test";

import type { DB } from "@intx/db";
import type { AssetService } from "@intx/hub-sessions";

import { agentDefinitionSourceTree } from "@corbits/agent-directory";
import { webhookTrigger as webhookTriggerTable } from "@corbits/webhook-triggers";

import {
  captureWorldSnapshot,
  type WorldSnapshotInfra,
} from "./world-snapshot.ts";

type FakeTables = {
  workflowDefinitions: {
    id: string;
    name: string;
    description: string | null;
    assetId: string | null;
  }[];
  providers: {
    id: string;
    tenantId: string;
    name: string;
    apiBaseUrl: string | null;
  }[];
  credentials: {
    id: string;
    tenantId: string;
    providerId: string;
    name: string;
    status: string;
  }[];
  webhookTriggers: {
    id: string;
    tenantId: string;
    name: string;
    workflowDefinitionId: string;
    enabled: boolean;
  }[];
  workflowBlobs: Record<string, string>;
};

function fakeDb(tables: FakeTables): DB["db"] {
  return {
    query: {
      workflowDefinition: {
        findMany: async () => tables.workflowDefinitions,
      },
      tenant: {
        findFirst: async () => ({ parentId: null }),
      },
      provider: {
        findMany: async () => tables.providers,
      },
      credential: {
        findMany: async () => tables.credentials,
      },
    },
    select: () => ({
      from: (table: unknown) => ({
        where: async () =>
          table === webhookTriggerTable ? tables.webhookTriggers : [],
      }),
    }),
  } as unknown as DB["db"];
}

/** Fake of the ancestor-walking credential resolver: a plain name
 * lookup over the fixture's credential rows. */
function fakeResolveCredentialByName(tables: FakeTables) {
  return (async (_db: unknown, _tenantId: string, name: string) =>
    tables.credentials.find((credential) => credential.name === name) ??
    null) as unknown as NonNullable<
    WorldSnapshotInfra["resolveCredentialByNameFn"]
  >;
}

/** Answers each asset's entry module out of the source tree its
 * definition renders into — the shape the snapshot reads through. */
function fakeAssetService(blobs: Record<string, string>): AssetService {
  return {
    readAssetBlob: async ({
      assetId,
      path,
    }: {
      assetId: string;
      path: string;
    }) =>
      new TextEncoder().encode(
        agentDefinitionSourceTree({
          handle: assetId,
          workflowJson: blobs[assetId] ?? "{}",
        })[path],
      ),
  } as unknown as AssetService;
}

function workflowJsonWith(
  toolPackagePins: { name: string; version: string }[],
  model?: string,
) {
  return JSON.stringify({
    steps: {
      agent: {
        agent: {
          systemPrompt: "You are a helpful agent.",
          toolPackagePins,
          ...(model === undefined
            ? {}
            : { inference: { sources: [{ provider: "anthropic", model }] } }),
        },
      },
    },
  });
}

function emptyTables(): FakeTables {
  return {
    workflowDefinitions: [],
    providers: [],
    credentials: [],
    webhookTriggers: [],
    workflowBlobs: {},
  };
}

test("captureWorldSnapshot reads agent definitions with their capabilities", async () => {
  const tables = emptyTables();
  tables.workflowDefinitions = [
    {
      id: "def-1",
      name: "ai-daily-research",
      description: "AI Daily researcher",
      assetId: "asset-1",
    },
  ];
  const infra: WorldSnapshotInfra = {
    db: fakeDb(tables),
    resolveCredentialByNameFn: fakeResolveCredentialByName(tables),
    assetService: fakeAssetService({
      "asset-1": workflowJsonWith(
        [{ name: "@corbits/web-search-tools", version: "0.0.1" }],
        "claude-3-5-sonnet",
      ),
    }),
  };
  const world = await captureWorldSnapshot(infra, "tenant-1");
  expect(world.agentDefinitions).toEqual([
    {
      id: "def-1",
      name: "ai-daily-research",
      displayName: "AI Daily researcher",
      toolPackagePins: ["@corbits/web-search-tools"],
      skills: [],
      model: "claude-3-5-sonnet",
    },
  ]);
});

test("captureWorldSnapshot skips a definition with no materialized asset", async () => {
  const tables = emptyTables();
  tables.workflowDefinitions = [
    { id: "def-1", name: "draft", description: null, assetId: null },
  ];
  const infra: WorldSnapshotInfra = {
    db: fakeDb(tables),
    resolveCredentialByNameFn: fakeResolveCredentialByName(tables),
    assetService: fakeAssetService({}),
  };
  const world = await captureWorldSnapshot(infra, "tenant-1");
  expect(world.agentDefinitions).toEqual([]);
});

test("captureWorldSnapshot reads live MCP connections", async () => {
  const tables = emptyTables();
  tables.providers = [
    {
      id: "p-1",
      tenantId: "tenant-1",
      name: "mcp:github",
      apiBaseUrl: "https://fake/mcp",
    },
  ];
  tables.credentials = [
    {
      id: "c-1",
      tenantId: "tenant-1",
      providerId: "p-1",
      name: "mcp:github",
      status: "active",
    },
  ];
  const infra: WorldSnapshotInfra = {
    db: fakeDb(tables),
    resolveCredentialByNameFn: fakeResolveCredentialByName(tables),
    assetService: fakeAssetService({}),
  };
  const world = await captureWorldSnapshot(infra, "tenant-1");
  expect(world.connections).toEqual([
    { slug: "github", name: "mcp:github", url: "https://fake/mcp", live: true },
  ]);
});

test("captureWorldSnapshot reads a connector credential (a GitHub PAT) as a live connection", async () => {
  const tables = emptyTables();
  tables.credentials = [
    {
      id: "c-1",
      tenantId: "tenant-1",
      providerId: "p-1",
      name: "GitHub",
      status: "active",
    },
  ];
  const infra: WorldSnapshotInfra = {
    db: fakeDb(tables),
    resolveCredentialByNameFn: fakeResolveCredentialByName(tables),
    assetService: fakeAssetService({}),
  };
  const world = await captureWorldSnapshot(infra, "tenant-1");
  expect(world.connections).toEqual([
    { slug: "github", name: "GitHub", url: "", live: true },
  ]);
});

test("captureWorldSnapshot reads webhook trigger rows", async () => {
  const tables = emptyTables();
  tables.webhookTriggers = [
    {
      id: "wt-1",
      tenantId: "tenant-1",
      name: "abklabs/workbench pull-request-opened",
      workflowDefinitionId: "def-cr",
      enabled: true,
    },
  ];
  const infra: WorldSnapshotInfra = {
    db: fakeDb(tables),
    resolveCredentialByNameFn: fakeResolveCredentialByName(tables),
    assetService: fakeAssetService({}),
  };
  const world = await captureWorldSnapshot(infra, "tenant-1");
  expect(world.webhookTriggers).toEqual([
    {
      id: "wt-1",
      name: "abklabs/workbench pull-request-opened",
      workflowDefinitionId: "def-cr",
      enabled: true,
    },
  ]);
});

test("captureWorldSnapshot folds in fake receipts from the injected reader", async () => {
  const tables = emptyTables();
  const infra: WorldSnapshotInfra = {
    db: fakeDb(tables),
    resolveCredentialByNameFn: fakeResolveCredentialByName(tables),
    assetService: fakeAssetService({}),
    fakeReceiptsReader: () => [
      { server: "github", toolName: "list_pull_requests", arguments: {} },
    ],
  };
  const world = await captureWorldSnapshot(infra, "tenant-1");
  expect(world.fakeReceipts).toEqual([
    { server: "github", toolName: "list_pull_requests", arguments: {} },
  ]);
});

test("captureWorldSnapshot returns an empty, well-formed snapshot for a tenant with nothing yet", async () => {
  const tables = emptyTables();
  const infra: WorldSnapshotInfra = {
    db: fakeDb(tables),
    resolveCredentialByNameFn: fakeResolveCredentialByName(tables),
    assetService: fakeAssetService({}),
  };
  const world = await captureWorldSnapshot(infra, "tenant-1");
  expect(world.agentDefinitions).toEqual([]);
  expect(world.connections).toEqual([]);
  expect(world.fakeReceipts).toEqual([]);
  expect(typeof world.capturedAt).toBe("string");
});
