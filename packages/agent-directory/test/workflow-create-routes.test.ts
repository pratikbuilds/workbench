// Route-level tests for the workflow-run-authenticated agent-creation
// surface: authentication, the fail-closed tool-package-pin inventory
// check, the create happy path (mirroring `./routes.ts`'s `POST /`
// materialization), and the tenant-scoped conversational-agent listing.
// Mirrors `workflow-capability-routes.test.ts`'s fakes.

import { expect, test } from "bun:test";
import { Hono } from "hono";

import type { AssetService } from "@intx/hub-sessions";
import type { DB } from "@intx/db";

import {
  createWorkflowAgentCreateRoutes,
  type CreateWorkflowAgentCreateRoutesDeps,
} from "../src/workflow-create-routes";
import type {
  WorkflowCapabilityRunScope,
  WorkflowRunAuthenticator,
} from "../src/workflow-capability-routes";
import type { PinnedSkillIndexResolver } from "../src/routes";
import { createInMemoryDefinitionSkillsStore } from "../src/skills-store";
import type { CapabilityInventoryProvider } from "../src/capability-inventory";
import { CORBITS_TOOLS_REGISTRY } from "@corbits/tool-registry-publish";
import { definitionFrom, SOURCE_TREE_PATHS } from "./source-tree";

const TENANT_ID = "tnt_1";
const RUN_ID = "run_1";
const SIDECAR_TOKEN = "sidecar-token";
const RUN_ADDRESS = `${RUN_ID}@example.com`;

const fakeCapabilityInventory: CapabilityInventoryProvider = {
  resolve: () =>
    Promise.resolve({
      toolPackages: [{ name: "@corbits/memory-tools" }],
      skills: [{ name: "research" }],
      models: [{ canonicalName: "anthropic/claude-sonnet" }],
    }),
};

const fakeSkillIndex: PinnedSkillIndexResolver = {
  resolve: (_tenantId, _principalId, names) =>
    Promise.resolve(
      names.map((name) => ({ name, description: `What ${name} does.` })),
    ),
};

function fakeAssetService(overrides: Partial<AssetService> = {}): AssetService {
  return {
    createAsset: () =>
      Promise.resolve({ id: "ast_new", tenantId: TENANT_ID, kind: "workflow" }),
    populateAsset: () => Promise.resolve({ commitSha: "deadbeef" }),
    readAssetBlob: () => {
      throw new Error("not used in these tests");
    },
    // `resolvePinnedVersion`'s tarball listing — every create test in
    // this file pins (or gets baseline-pinned) `@corbits/memory-tools`.
    listAssetBlobs: () => Promise.resolve(["corbits-memory-tools-1.4.0.tgz"]),
    ...overrides,
  } as unknown as AssetService;
}

type FakeDefinitionRow = {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  status: string;
  currentVersion: number;
  assetId: string | null;
};

// `POST /definitions` reuses `createAgentDefinitionCore`, whose write
// path continues through populateAsset -> ensureWorkflowDefinitionForAsset
// (`@intx/hub-sessions`) -> read-back — that helper drives the drizzle
// handle directly (`.select().from().where().limit()`,
// `.insert().values().onConflictDoNothing().returning()`) rather than
// through `db.query.*`, so the fake below provides just enough of that
// chainable shape too, mirroring `routes.test.ts`'s own `fakeDb`.
function fakeDb(
  opts: {
    definitions?: FakeDefinitionRow[];
    createdRow?: FakeDefinitionRow;
  } = {},
): DB["db"] {
  const createdRow: FakeDefinitionRow = opts.createdRow ?? {
    id: "def_new",
    tenantId: TENANT_ID,
    name: "research-buddy",
    description: null,
    status: "deployed",
    currentVersion: 1,
    assetId: "ast_new",
  };
  const definitions = opts.definitions ?? [createdRow];
  const selectResult = [
    {
      tenantId: TENANT_ID,
      creatorPrincipalId: null,
      name: createdRow.name,
      displayName: createdRow.name,
    },
  ];

  return {
    query: {
      tenant: {
        findFirst: async () => ({
          id: TENANT_ID,
          domain: "acme.example",
          parentId: null,
        }),
      },
      asset: {
        findFirst: async () => ({
          id: "ast_corbits_tools",
          tenantId: TENANT_ID,
          kind: "package-registry" as const,
          name: CORBITS_TOOLS_REGISTRY,
        }),
      },
      workflowDefinition: {
        findFirst: async () => createdRow,
        findMany: async () => definitions,
      },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectResult),
        }),
      }),
    }),
    insert: () => ({
      values: () => {
        const chain: Record<string, unknown> = {
          onConflictDoNothing: () => chain,
          returning: () => Promise.resolve([{ id: createdRow.id }]),
          then: (onFulfilled: unknown) =>
            Promise.resolve([]).then(onFulfilled as never),
        };
        return chain;
      },
    }),
  } as unknown as DB["db"];
}

const authenticateAsRun: WorkflowRunAuthenticator = {
  resolve: (token, address) =>
    Promise.resolve(
      token === SIDECAR_TOKEN && address === RUN_ADDRESS
        ? ({
            tenantId: TENANT_ID,
            principalId: "prn_1",
            runId: RUN_ID,
          } satisfies WorkflowCapabilityRunScope)
        : null,
    ),
};

/** Records deploy calls instead of running a real
 * `sessionService.deployWorkflowFromSource`; routes here are asserted to
 * invoke it, with the commit the write produced, on every content
 * write. */
function recordingAgentDefinitionDeployer() {
  const deploys: {
    tenantId: string;
    principalId: string;
    assetId: string;
    assetName: string;
    commitSha: string;
    entry: string;
  }[] = [];
  return {
    deploys,
    deploy: (input: {
      tenantId: string;
      principalId: string;
      assetId: string;
      assetName: string;
      commitSha: string;
      entry: string;
    }) => {
      deploys.push(input);
      return Promise.resolve({
        deploymentId: "dep_1",
        definitionAssetId: input.assetId,
        status: "deployed" as const,
      });
    },
  };
}
function buildApp(
  opts: Partial<CreateWorkflowAgentCreateRoutesDeps> = {},
): Hono {
  return createWorkflowAgentCreateRoutes({
    db: opts.db ?? fakeDb(),
    assetService: opts.assetService ?? fakeAssetService(),
    skillIndex: opts.skillIndex ?? fakeSkillIndex,
    skillsStore: opts.skillsStore ?? createInMemoryDefinitionSkillsStore(),
    capabilityInventory: opts.capabilityInventory ?? fakeCapabilityInventory,
    authenticator: opts.authenticator ?? authenticateAsRun,
    deployer: opts.deployer ?? recordingAgentDefinitionDeployer(),
    ...(opts.tenantDefaultModel !== undefined
      ? { tenantDefaultModel: opts.tenantDefaultModel }
      : {}),
  }) as unknown as Hono;
}

const AUTH_HEADERS = {
  authorization: `Bearer ${SIDECAR_TOKEN}`,
  "x-workflow-run-address": RUN_ADDRESS,
};

test("POST /definitions is a 401 without a recognized run credential", async () => {
  const app = buildApp();
  const response = await app.request("/definitions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Research Buddy",
      handle: "research-buddy",
      systemPrompt: "You are a careful research assistant.",
    }),
  });
  expect(response.status).toBe(401);
});

test("GET /definitions is a 401 without a recognized run credential", async () => {
  const app = buildApp();
  const response = await app.request("/definitions");
  expect(response.status).toBe(401);
});

test("creates a definition and returns it, reusing the same materialization the tenant-session route uses", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp({
    assetService: fakeAssetService({
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
  });
  const response = await app.request("/definitions", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({
      name: "Research Buddy",
      handle: "research-buddy",
      systemPrompt: "You are a careful research assistant.",
    }),
  });
  expect(response.status).toBe(201);
  expect(Object.keys(writtenFiles ?? {})).toEqual(SOURCE_TREE_PATHS);
  const body = (await response.json()) as { id: string; name: string };
  expect(body.id).toBe("def_new");
});

test("a toolPackagePins entry outside the tenant's inventory is a 400, never written", async () => {
  let populateCalled = false;
  const app = buildApp({
    assetService: fakeAssetService({
      populateAsset: () => {
        populateCalled = true;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
  });
  const response = await app.request("/definitions", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({
      name: "Research Buddy",
      handle: "research-buddy",
      systemPrompt: "You are a careful research assistant.",
      toolPackagePins: ["@corbits/nonexistent-tools"],
    }),
  });
  expect(response.status).toBe(400);
  expect(populateCalled).toBe(false);
});

test("a toolPackagePins entry the tenant's inventory offers is pinned onto the created definition", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp({
    assetService: fakeAssetService({
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
  });
  const response = await app.request("/definitions", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({
      name: "Research Buddy",
      handle: "research-buddy",
      systemPrompt: "You are a careful research assistant.",
      toolPackagePins: ["@corbits/memory-tools"],
    }),
  });
  expect(response.status).toBe(201);
  const written = definitionFrom(writtenFiles);
  expect(written).toContain("@corbits/memory-tools");
});

test("a create naming no pins gets the baseline set the inventory offers — a specialist is never toolless (CL-6206)", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp({
    assetService: fakeAssetService({
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
  });
  const response = await app.request("/definitions", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({
      name: "Research Buddy",
      handle: "research-buddy",
      systemPrompt: "You are a careful research assistant.",
    }),
  });
  expect(response.status).toBe(201);
  const written = definitionFrom(writtenFiles);
  // The fake inventory offers memory-tools (see buildApp); mcp-tools and
  // interaction-tools are not offered, so only the resolvable baseline
  // member is pinned — never a pin that would fail at launch.
  expect(written).toContain("@corbits/memory-tools");
  expect(written).not.toContain("@corbits/mcp-tools");
});

test("a create with no model bakes the tenant's catalog default in, so the definition self-resolves at launch", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp({
    assetService: fakeAssetService({
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    tenantDefaultModel: (tenantId) =>
      Promise.resolve(
        tenantId === TENANT_ID ? "anthropic/claude-sonnet" : undefined,
      ),
  });
  const response = await app.request("/definitions", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({
      name: "Research Buddy",
      handle: "research-buddy",
      systemPrompt: "You are a careful research assistant.",
    }),
  });
  expect(response.status).toBe(201);
  const written = definitionFrom(writtenFiles);
  expect(written).toContain("anthropic/claude-sonnet");
});

test("a create with an explicit model the tenant's catalog offers never consults the tenant default", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp({
    assetService: fakeAssetService({
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    tenantDefaultModel: () => {
      throw new Error("must not be consulted when the caller supplied a model");
    },
  });
  const response = await app.request("/definitions", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    // fakeCapabilityInventory (see above) offers exactly this model.
    body: JSON.stringify({
      name: "Research Buddy",
      handle: "research-buddy",
      systemPrompt: "You are a careful research assistant.",
      model: "anthropic/claude-sonnet",
    }),
  });
  expect(response.status).toBe(201);
  const written = definitionFrom(writtenFiles);
  expect(written).toContain("anthropic/claude-sonnet");
  const body = (await response.json()) as { modelNote: string | null };
  expect(body.modelNote).toBeNull();
});

test("a create naming a model outside the tenant's catalog falls back to the tenant default and says so, rather than creating a dead agent", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp({
    assetService: fakeAssetService({
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    tenantDefaultModel: (tenantId) =>
      Promise.resolve(
        tenantId === TENANT_ID ? "anthropic/claude-sonnet" : undefined,
      ),
  });
  const response = await app.request("/definitions", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({
      name: "Research Buddy",
      handle: "research-buddy",
      systemPrompt: "You are a careful research assistant.",
      model: "gpt-4o",
    }),
  });
  expect(response.status).toBe(201);
  const written = definitionFrom(writtenFiles);
  expect(written).not.toContain("gpt-4o");
  expect(written).toContain("anthropic/claude-sonnet");
  const body = (await response.json()) as { modelNote: string | null };
  expect(body.modelNote).toMatch(/gpt-4o/);
  expect(body.modelNote).toMatch(/anthropic\/claude-sonnet/);
});

test("a create naming a model outside the catalog with no tenant default still creates a working, unpinned agent rather than a dead one", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp({
    assetService: fakeAssetService({
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    tenantDefaultModel: () => Promise.resolve(undefined),
  });
  const response = await app.request("/definitions", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({
      name: "Research Buddy",
      handle: "research-buddy",
      systemPrompt: "You are a careful research assistant.",
      model: "gpt-4o",
    }),
  });
  expect(response.status).toBe(201);
  const written = definitionFrom(writtenFiles);
  expect(written).not.toContain("gpt-4o");
  const body = (await response.json()) as { modelNote: string | null };
  expect(body.modelNote).toMatch(/gpt-4o/);
});

test("an invalid body is a 400", async () => {
  const app = buildApp();
  const response = await app.request("/definitions", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({ name: "", handle: "Bad Handle!" }),
  });
  expect(response.status).toBe(400);
});

test("GET /definitions lists conversational agents deployed in the caller's tenant", async () => {
  const app = buildApp({
    db: fakeDb({
      definitions: [
        {
          id: "def_1",
          tenantId: TENANT_ID,
          name: "research-buddy",
          description: "A careful researcher",
          status: "deployed",
          currentVersion: 1,
          assetId: "ast_1",
        },
        {
          id: "def_2",
          tenantId: TENANT_ID,
          name: "ins-0f1e2d3c4b5a69788796a5b4c3d2e1f0",
          description: null,
          status: "deployed",
          currentVersion: 1,
          assetId: "ast_2",
        },
      ],
    }),
  });
  const response = await app.request("/definitions", { headers: AUTH_HEADERS });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    definitions: { id: string; name: string; description: string | null }[];
  };
  expect(body.definitions).toEqual([
    {
      id: "def_1",
      name: "research-buddy",
      description: "A careful researcher",
    },
  ]);
});
