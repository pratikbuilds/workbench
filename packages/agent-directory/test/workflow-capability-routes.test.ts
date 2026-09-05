// Route-level tests for the workflow-run-authenticated capabilities
// surface: authentication, the own-definition-only constraint, the
// fail-closed inventory check, and the versioned-add + read-back happy
// path. Mirrors `routes.test.ts`'s fakes for the tenant-session
// `POST /:definitionId/capabilities` route this surface parallels.

import { expect, test } from "bun:test";
import { Hono } from "hono";

import { AssetServiceError } from "@intx/hub-sessions";
import type { AssetService } from "@intx/hub-sessions";
import type { DB } from "@intx/db";

import {
  buildAgentDefinitionWorkflow,
  serializeAgentDefinitionWorkflow,
} from "../src/agent-workflow";
import {
  createWorkflowCapabilityRoutes,
  type WorkflowCapabilityRunScope,
  type WorkflowRunAuthenticator,
} from "../src/workflow-capability-routes";
import {
  agentDefinitionSourceTree,
  AGENT_DEFINITION_ENTRY_PATH,
} from "../src/definition-asset";
import type { PinnedSkillIndexResolver } from "../src/routes";
import {
  createInMemoryDefinitionSkillsStore,
  type DefinitionSkillsStore,
} from "../src/skills-store";
import { SOURCE_TREE_PATHS } from "./source-tree";
import type { CapabilityInventoryProvider } from "../src/capability-inventory";
import { CORBITS_TOOLS_REGISTRY } from "@corbits/tool-registry-publish";

const TENANT_ID = "tnt_1";
const RUN_ID = "run_1";
const OWN_DEFINITION_ID = "def_1";
const OTHER_DEFINITION_ID = "def_2";
const SIDECAR_TOKEN = "sidecar-token";
const RUN_ADDRESS = `${RUN_ID}@example.com`;

const fakeCapabilityInventory: CapabilityInventoryProvider = {
  resolve: () =>
    Promise.resolve({
      toolPackages: [{ name: "@corbits/capability-tools" }],
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

function storedDefinitionBytes(): Uint8Array {
  const tree = agentDefinitionSourceTree({
    handle: "research-buddy",
    workflowJson: serializeAgentDefinitionWorkflow(
      buildAgentDefinitionWorkflow({
        handle: "research-buddy",
        tenantDomain: "acme.example",
        description: "",
        systemPrompt: "You are a careful research assistant.",
      }),
    ),
  });
  return new TextEncoder().encode(tree[AGENT_DEFINITION_ENTRY_PATH]);
}

/** A `readAssetBlob` that always answers the definition's entry module
 * — pinned skills no longer live in the asset tree, so a test that needs
 * a definition's skills seeds a `DefinitionSkillsStore` directly
 * instead. */
function readAssetBlobFor(
  workflowBytes: Uint8Array,
): AssetService["readAssetBlob"] {
  return () => Promise.resolve(workflowBytes);
}

function fakeAssetService(overrides: Partial<AssetService> = {}): AssetService {
  return {
    createAsset: () => {
      throw new Error("createAsset not stubbed for this test");
    },
    populateAsset: () => Promise.resolve({ commitSha: "deadbeef" }),
    readAssetBlob: () => {
      throw new Error("not used in these tests");
    },
    listAssetBlobs: () => {
      throw new Error("not used in these tests");
    },
    ...overrides,
  };
}

/** `resolvePinnedVersion`'s `resolveAssetByName` lookup, stubbed as a
 * tenant-owned `corbits-tools` package-registry asset with no parent —
 * mirrors `routes.test.ts`'s `CORBITS_TOOLS_REGISTRY_ASSET` fixture. */
const CORBITS_TOOLS_REGISTRY_ASSET = {
  id: "ast_corbits_tools",
  tenantId: TENANT_ID,
  kind: "package-registry" as const,
  name: CORBITS_TOOLS_REGISTRY,
  displayName: CORBITS_TOOLS_REGISTRY,
  creatorPrincipalId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function fakeDb(): DB["db"] {
  return {
    query: {
      workflowRun: {
        findFirst: async () => ({
          id: RUN_ID,
          definitionId: OWN_DEFINITION_ID,
        }),
      },
      workflowDefinition: {
        findFirst: async () => ({
          id: OWN_DEFINITION_ID,
          tenantId: TENANT_ID,
          assetId: "ast_1",
          name: "research-buddy",
        }),
      },
      tenant: { findFirst: async () => ({ parentId: null }) },
      asset: { findFirst: async () => CORBITS_TOOLS_REGISTRY_ASSET },
    },
  } as unknown as DB["db"];
}

const authenticateAsOwnRun: WorkflowRunAuthenticator = {
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
function buildApp(opts: {
  assetService?: AssetService;
  db?: DB["db"];
  authenticator?: WorkflowRunAuthenticator;
  capabilityInventory?: CapabilityInventoryProvider;
  skillsStore?: DefinitionSkillsStore;
  deployer?: ReturnType<typeof recordingAgentDefinitionDeployer>;
}): Hono {
  return createWorkflowCapabilityRoutes({
    db: opts.db ?? fakeDb(),
    assetService: opts.assetService ?? fakeAssetService(),
    skillIndex: fakeSkillIndex,
    skillsStore: opts.skillsStore ?? createInMemoryDefinitionSkillsStore(),
    capabilityInventory: opts.capabilityInventory ?? fakeCapabilityInventory,
    authenticator: opts.authenticator ?? authenticateAsOwnRun,
    deployer: opts.deployer ?? recordingAgentDefinitionDeployer(),
  }) as unknown as Hono;
}

async function postCapability(
  app: Hono,
  definitionId: string,
  body: unknown,
  headers: Record<string, string> = {
    authorization: `Bearer ${SIDECAR_TOKEN}`,
    "x-workflow-run-address": RUN_ADDRESS,
  },
): Promise<Response> {
  return app.request(`/${definitionId}/capabilities`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("a missing or unrecognized bearer token / run address is a 401", async () => {
  const app = buildApp({});
  const response = await postCapability(
    app,
    OWN_DEFINITION_ID,
    { kind: "toolPackage", name: "@corbits/capability-tools" },
    {},
  );
  expect(response.status).toBe(401);
});

test("a definition still on the retired envelope is a 409, never a 500, and writes nothing", async () => {
  let populateCalled = false;
  const app = buildApp({
    assetService: fakeAssetService({
      readAssetBlob: (params) =>
        Promise.reject(
          new AssetServiceError(
            "not_found",
            `readAssetBlob: asset ${params.assetId} has no blob at "${params.path}"`,
          ),
        ),
      populateAsset: () => {
        populateCalled = true;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
  });
  const response = await postCapability(app, OWN_DEFINITION_ID, {
    kind: "toolPackage",
    name: "@corbits/capability-tools",
  });
  expect(response.status).toBe(409);
  expect(populateCalled).toBe(false);
});

test("a run targeting another definition's capabilities is a 403", async () => {
  const app = buildApp({});
  const response = await postCapability(app, OTHER_DEFINITION_ID, {
    kind: "toolPackage",
    name: "@corbits/capability-tools",
  });
  expect(response.status).toBe(403);
});

test("a run may add a capability to its own definition without any grant check", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  let writtenMessage: string | undefined;
  const deployer = recordingAgentDefinitionDeployer();
  const app = buildApp({
    assetService: fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        writtenMessage = params.tree.message;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
      listAssetBlobs: () =>
        Promise.resolve(["corbits-capability-tools-0.0.2.tgz"]),
    }),
    deployer,
  });
  const response = await postCapability(app, OWN_DEFINITION_ID, {
    kind: "toolPackage",
    name: "@corbits/capability-tools",
  });
  expect(response.status).toBe(200);
  // The rewrite redeploys the definition through the native source
  // pipeline so the next launch carries the added capability (CL-6447,
  // cut over to native deploy by CL-7363).
  expect(deployer.deploys).toHaveLength(1);
  expect(deployer.deploys[0]?.commitSha).toBe("deadbeef");
  expect(Object.keys(writtenFiles ?? {})).toEqual(SOURCE_TREE_PATHS);
  expect(writtenMessage).toBe(
    "Add @corbits/capability-tools to research-buddy",
  );
  const body = (await response.json()) as {
    toolPackagePins: { name: string; version: string }[];
  };
  expect(body.toolPackagePins).toEqual([
    { name: "@corbits/capability-tools", version: "0.0.2" },
  ]);
});

test("adding a capability the tenant's inventory doesn't offer is a 400, never written", async () => {
  let populateCalled = false;
  const app = buildApp({
    assetService: fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
      populateAsset: () => {
        populateCalled = true;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
  });
  const response = await postCapability(app, OWN_DEFINITION_ID, {
    kind: "toolPackage",
    name: "@corbits/nonexistent-tools",
  });
  expect(response.status).toBe(400);
  expect(populateCalled).toBe(false);
});

test("adding a skill merges it additively into the skills store and re-indexes the prompt", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const skillsStore = createInMemoryDefinitionSkillsStore();
  const app = buildApp({
    assetService: fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    skillsStore,
  });
  const response = await postCapability(app, OWN_DEFINITION_ID, {
    kind: "skill",
    name: "research",
  });
  expect(response.status).toBe(200);
  expect(Object.keys(writtenFiles ?? {})).toEqual(SOURCE_TREE_PATHS);
  expect(await skillsStore.getSkills("ast_1")).toEqual(["research"]);
  const body = (await response.json()) as { skills: string[] };
  expect(body.skills).toEqual(["research"]);
});

test("setting a model in the tenant's catalog writes a single named commit", async () => {
  let writtenMessage: string | undefined;
  const app = buildApp({
    assetService: fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
      populateAsset: (params) => {
        writtenMessage = params.tree.message;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
  });
  const response = await postCapability(app, OWN_DEFINITION_ID, {
    kind: "model",
    canonicalName: "anthropic/claude-sonnet",
  });
  expect(response.status).toBe(200);
  expect(writtenMessage).toBe(
    "Set research-buddy's model to anthropic/claude-sonnet",
  );
  const body = (await response.json()) as { model?: string };
  expect(body.model).toBe("anthropic/claude-sonnet");
});

test("capabilities route 404s for an unknown definition even when it is the caller's own", async () => {
  const app = buildApp({
    db: {
      query: {
        workflowRun: {
          findFirst: async () => ({
            id: RUN_ID,
            definitionId: OWN_DEFINITION_ID,
          }),
        },
        workflowDefinition: { findFirst: async () => undefined },
      },
    } as unknown as DB["db"],
  });
  const response = await postCapability(app, OWN_DEFINITION_ID, {
    kind: "model",
    canonicalName: "anthropic/claude-sonnet",
  });
  expect(response.status).toBe(404);
});

test("GET /inventory serves the resolved scope's tenant inventory", async () => {
  const app = buildApp({});
  const response = await app.request("/inventory", {
    headers: {
      authorization: `Bearer ${SIDECAR_TOKEN}`,
      "x-workflow-run-address": RUN_ADDRESS,
    },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    toolPackages: { name: string }[];
  };
  expect(body.toolPackages).toEqual([{ name: "@corbits/capability-tools" }]);
});

test("GET /inventory is a 401 without a recognized run credential", async () => {
  const app = buildApp({});
  const response = await app.request("/inventory");
  expect(response.status).toBe(401);
});
