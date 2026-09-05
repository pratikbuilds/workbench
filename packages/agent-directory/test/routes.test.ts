// Route-level tests cover this package's own wiring: request parsing,
// grant gating, and error-envelope mapping. The definition-projection
// path (`ensureWorkflowDefinitionForAsset` + the read-back query) is
// `@intx/hub-sessions`/`@intx/db` machinery already covered upstream —
// re-proving it here against a hand-rolled fake drizzle db would be
// coverage theater, not a meaningful test of this package's code.

import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { idResource } from "@intx/hub-api";
import { AssetServiceError } from "@intx/hub-sessions";
import type { AssetService } from "@intx/hub-sessions";
import type { DB } from "@intx/db";

import { SkillRegistryError } from "@corbits/skills";
import { CORBITS_TOOLS_REGISTRY } from "@corbits/tool-registry-publish";

import {
  buildAgentDefinitionWorkflow,
  serializeAgentDefinitionWorkflow,
  withAgentToolPackagePin,
} from "../src/agent-workflow";
import {
  agentDefinitionSourceTree,
  AGENT_DEFINITION_ENTRY_PATH,
  readAgentDefinitionWorkflowJson,
} from "../src/definition-asset";
import { createAgentDefinitionRoutes } from "../src/routes";
import type { PinnedSkillIndexResolver } from "../src/routes";
import {
  createWorkflowSkillPinRoutes,
  type WorkflowRunAuthenticator,
} from "../src/workflow-skill-pin-routes";
import {
  createInMemoryDefinitionSkillsStore,
  type DefinitionSkillsStore,
} from "../src/skills-store";
import type { DefinitionAssetHistory } from "../src/definition-history";
import type { CapabilityInventoryProvider } from "../src/capability-inventory";
import { definitionFrom, SOURCE_TREE_PATHS } from "./source-tree";

/** A `readAssetBlob` that always answers the definition's entry module
 * with `workflowBytes` — pinned skills no longer live in the asset tree
 * (see `../src/skills-store.ts`), so a test that needs a definition's
 * skills seeds a `DefinitionSkillsStore` directly instead of stubbing a
 * second path here. */
function readAssetBlobFor(
  workflowBytes: Uint8Array,
): AssetService["readAssetBlob"] {
  return () => Promise.resolve(workflowBytes);
}

const fakeCapabilityInventory: CapabilityInventoryProvider = {
  resolve: () =>
    Promise.resolve({
      toolPackages: [{ name: "@corbits/github-tools" }],
      skills: [{ name: "research" }],
      models: [{ canonicalName: "anthropic/claude-sonnet" }],
    }),
};

function fakeHistory(
  overrides: Partial<DefinitionAssetHistory> = {},
): DefinitionAssetHistory {
  return {
    history: () => Promise.resolve([]),
    readBlobAtCommit: () => Promise.resolve(null),
    ...overrides,
  };
}

/** Resolves every pinned name to a one-line description, so a route test
 * can assert on the stanza without standing up the registry. */
const fakeSkillIndex: PinnedSkillIndexResolver = {
  resolve: (_tenantId, _principalId, names) =>
    Promise.resolve(
      names.map((name) => ({ name, description: `What ${name} does.` })),
    ),
};

const TENANT = {
  id: "tnt_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const PRINCIPAL = {
  id: "prn_1",
  tenantId: TENANT.id,
  kind: "user" as const,
  refId: "prn_1",
  status: "active" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** `resolvePinnedVersion`'s `resolveAssetByName` lookup, stubbed for tests
 * that create/pin a tool package: a tenant-owned `corbits-tools`
 * package-registry asset, so `db.query.tenant.findFirst`/`db.query.asset.findFirst`
 * resolve exactly like the real ancestor-chain walk would for a
 * single-tenant (no-parent) fixture. */
const CORBITS_TOOLS_REGISTRY_ASSET = {
  id: "ast_corbits_tools",
  tenantId: TENANT.id,
  kind: "package-registry" as const,
  name: CORBITS_TOOLS_REGISTRY,
  displayName: CORBITS_TOOLS_REGISTRY,
  creatorPrincipalId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** Merges the `db.query.tenant`/`db.query.asset` lookups
 * `resolvePinnedVersion` needs into a fake db's `query` object, leaving
 * every other query untouched. */
function withToolPackageRegistryQueries<T extends { query: object }>(db: T): T {
  return {
    ...db,
    query: {
      ...db.query,
      tenant: { findFirst: async () => ({ parentId: null }) },
      asset: { findFirst: async () => CORBITS_TOOLS_REGISTRY_ASSET },
    },
  };
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

/** An asset whose reads observe writes — the race two concurrent
 * capability-adds hit is only visible when the second read can see the
 * first write, or when both reads share a snapshot the later write then
 * clobbers. */
function liveDefinitionAsset(initial: Uint8Array): AssetService {
  let current = initial;
  return fakeAssetService({
    readAssetBlob: async () => {
      await Promise.resolve();
      return current;
    },
    populateAsset: async (params) => {
      const entry = params.tree.files[AGENT_DEFINITION_ENTRY_PATH];
      if (typeof entry !== "string") {
        throw new Error("populateAsset wrote no entry module");
      }
      await Promise.resolve();
      current = new TextEncoder().encode(entry);
      return { commitSha: "deadbeef" };
    },
    // Every tool package a `liveDefinitionAsset` test pins by name, at a
    // fixed version — enough for `resolvePinnedVersion` to resolve
    // without each concurrent-write test needing its own tarball list.
    listAssetBlobs: () =>
      Promise.resolve([
        "corbits-github-tools-3.1.0.tgz",
        "corbits-memory-tools-1.4.0.tgz",
      ]),
  });
}

/** The entry module a stored definition's asset carries, so the PUT
 * path has something real to re-index. */
function storedDefinitionBytes(
  systemPrompt = "You are a careful research assistant.",
): Uint8Array {
  const tree = agentDefinitionSourceTree({
    handle: "research-buddy",
    workflowJson: serializeAgentDefinitionWorkflow(
      buildAgentDefinitionWorkflow({
        handle: "research-buddy",
        tenantDomain: TENANT.domain,
        description: "",
        systemPrompt,
      }),
    ),
  });
  return new TextEncoder().encode(tree[AGENT_DEFINITION_ENTRY_PATH]);
}

/** A stored definition that already pins a model — the state a person
 * un-pins from. */
function storedDefinitionBytesWithModel(model: string): Uint8Array {
  const tree = agentDefinitionSourceTree({
    handle: "research-buddy",
    workflowJson: serializeAgentDefinitionWorkflow(
      buildAgentDefinitionWorkflow({
        handle: "research-buddy",
        tenantDomain: TENANT.domain,
        description: "",
        systemPrompt: "You are a careful research assistant.",
        model,
      }),
    ),
  });
  return new TextEncoder().encode(tree[AGENT_DEFINITION_ENTRY_PATH]);
}

/** The model the one step agent resolves against, or `undefined` when it
 * pins none. */
function modelFrom(workflowJson: string): string | undefined {
  const parsed = JSON.parse(workflowJson) as {
    steps: Record<
      string,
      { agent: { inference?: { sources: { model?: string }[] } } }
    >;
  };
  const step = Object.values(parsed.steps)[0];
  if (step === undefined) throw new Error("definition carries no steps");
  return step.agent.inference?.sources[0]?.model;
}

/** The one step agent's tool-package pins inside a serialized definition. */
function pinsFrom(workflowJson: string): { name: string; version: string }[] {
  const parsed = JSON.parse(workflowJson) as {
    steps: Record<
      string,
      { agent: { toolPackagePins?: { name: string; version: string }[] } }
    >;
  };
  const step = Object.values(parsed.steps)[0];
  if (step === undefined) throw new Error("definition carries no steps");
  return step.agent.toolPackagePins ?? [];
}

/** The one step agent's system prompt inside a serialized definition. */
function promptFrom(workflowJson: string): string {
  const parsed = JSON.parse(workflowJson) as {
    steps: Record<string, { agent: { systemPrompt: string } }>;
  };
  const step = Object.values(parsed.steps)[0];
  if (step === undefined) throw new Error("definition carries no steps");
  return step.agent.systemPrompt;
}

// The duplicate-asset recovery path queries `db` directly (looking up the
// existing asset and its definition) before deciding whether to reuse an
// empty shell or surface a real 409. When the shell is reused the route
// continues through populateAsset → ensureWorkflowDefinitionForAsset →
// read-back, so the fake also provides just enough of drizzle's chainable
// query-builder API (`.select().from().where().limit()`,
// `.insert().values().onConflictDoNothing().returning()`) for that
// projection — the projection logic itself is `@intx/hub-sessions`/
// `@intx/db` machinery already covered upstream; the fake only needs to
// return plausible rows, not re-prove the SQL.

type FakeDbOptions = {
  existingAsset?: { id: string };
  hasDefinition?: boolean;
};

function fakeDb(opts: FakeDbOptions = {}): DB["db"] {
  let wfDefFindFirstCalls = 0;

  const selectResult = [
    {
      tenantId: TENANT.id,
      creatorPrincipalId: null,
      name: "research-buddy",
      displayName: "Research Buddy",
    },
  ];

  return {
    query: {
      asset: {
        findFirst: async () => opts.existingAsset ?? undefined,
      },
      workflowDefinition: {
        findFirst: async () => {
          wfDefFindFirstCalls += 1;
          if (wfDefFindFirstCalls === 1) {
            return opts.hasDefinition ? { id: "def_existing" } : undefined;
          }
          // Read-back after ensureWorkflowDefinitionForAsset.
          return {
            id: "def_new",
            tenantId: TENANT.id,
            name: "Research Buddy",
            description: null,
            currentVersion: "1",
            status: "deployed",
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
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
          returning: () => Promise.resolve([{ id: "def_new" }]),
          then: (onFulfilled: unknown) =>
            Promise.resolve([]).then(onFulfilled as never),
        };
        return chain;
      },
    }),
  } as unknown as DB["db"];
}

const allowAllRequireGrant: RequireGrant = () => async (_c, next) => {
  await next();
};

/** Records deploy calls instead of running the real
 * `sessionService.deployWorkflowFromSource` machinery (whose own suites
 * cover the install/probe/gate/freeze half); routes here are asserted to
 * invoke it on every content write, with the commit the write produced. */
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
  assetService: AssetService,
  db: DB["db"] = fakeDb(),
  requireGrant: RequireGrant = allowAllRequireGrant,
  history: DefinitionAssetHistory = fakeHistory(),
  capabilityInventory: CapabilityInventoryProvider = fakeCapabilityInventory,
  skillsStore: DefinitionSkillsStore = createInMemoryDefinitionSkillsStore(),
  deployer: ReturnType<
    typeof recordingAgentDefinitionDeployer
  > = recordingAgentDefinitionDeployer(),
): Hono<TenantEnv> {
  const routes = createAgentDefinitionRoutes({
    db,
    assetService,
    skillIndex: fakeSkillIndex,
    skillsStore,
    history,
    capabilityInventory,
    requireGrant,
    deployer,
  });
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", PRINCIPAL);
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}

async function post(app: Hono<TenantEnv>, body: unknown): Promise<Response> {
  return app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postTo(
  app: Hono<TenantEnv>,
  path: string,
  body: unknown,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function put(
  app: Hono<TenantEnv>,
  path: string,
  body: unknown,
): Promise<Response> {
  return app.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a malformed body is rejected with a field-scoped 400", async () => {
  const app = buildApp(fakeAssetService());
  const response = await post(app, {
    name: "",
    handle: "Not Kebab",
    systemPrompt: "hello",
  });
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { userMessage: string } };
  expect(body.error.userMessage).toContain("invalid agent definition");
});

test("a missing system prompt is rejected before any asset is created", async () => {
  let createCalled = false;
  const app = buildApp(
    fakeAssetService({
      createAsset: () => {
        createCalled = true;
        throw new Error("should never be called");
      },
    }),
  );
  const response = await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
  });
  expect(response.status).toBe(400);
  expect(createCalled).toBe(false);
});

test("a duplicate handle surfaces as a 409, not a 500", async () => {
  const app = buildApp(
    fakeAssetService({
      createAsset: () => {
        throw new AssetServiceError(
          "duplicate_asset",
          'an asset named "research-buddy" already exists',
        );
      },
    }),
  );
  const response = await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
  });
  expect(response.status).toBe(409);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("conflict");
});

test("an unrelated asset-service failure is not swallowed as a conflict", async () => {
  const app = buildApp(
    fakeAssetService({
      createAsset: () => {
        throw new Error("the git backend is unreachable");
      },
    }),
  );
  const response = await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
  });
  // Hono's default error handler turns an uncaught throw into a 500
  // rather than the 409 the duplicate-asset path returns — proving this
  // route re-throws instead of misclassifying every asset-service
  // failure as a handle conflict.
  expect(response.status).toBe(500);
});

// A minimal db fake for the straight-through create path (no duplicate-asset
// recovery in play): `query.workflowDefinition.findFirst` is called exactly
// once, for the final read-back, so it can answer unconditionally — unlike
// `fakeDb()` above, whose call-count switch exists only to serve the
// duplicate-recovery tests, none of which reach this point.
function fakeCreateDb(): DB["db"] {
  return {
    query: {
      workflowDefinition: {
        findFirst: async () => ({
          id: "def_new",
          tenantId: TENANT.id,
          name: "Research Buddy",
          description: null,
          currentVersion: "1",
          status: "deployed",
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              {
                tenantId: TENANT.id,
                creatorPrincipalId: null,
                name: "research-buddy",
                displayName: "Research Buddy",
              },
            ]),
        }),
      }),
    }),
    insert: () => ({
      values: () => {
        const chain: Record<string, unknown> = {
          onConflictDoNothing: () => chain,
          returning: () => Promise.resolve([{ id: "def_new" }]),
          then: (onFulfilled: unknown) =>
            Promise.resolve([]).then(onFulfilled as never),
        };
        return chain;
      },
    }),
  } as unknown as DB["db"];
}

test("a create request with skills writes the definition source tree to the asset and records skills in the skills store", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const skillsStore = createInMemoryDefinitionSkillsStore();
  const deployer = recordingAgentDefinitionDeployer();
  const app = buildApp(
    fakeAssetService({
      createAsset: () =>
        Promise.resolve({
          id: "ast_1",
          tenantId: TENANT.id,
          kind: "workflow" as const,
          name: "research-buddy",
          displayName: "Research Buddy",
          creatorPrincipalId: PRINCIPAL.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeCreateDb(),
    allowAllRequireGrant,
    fakeHistory(),
    fakeCapabilityInventory,
    skillsStore,
    deployer,
  );
  const response = await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
    skills: ["web-research", "long-form-write"],
  });
  expect(response.status).toBe(201);
  expect(writtenFiles).toBeDefined();
  expect(Object.keys(writtenFiles ?? {})).toEqual(SOURCE_TREE_PATHS);
  // The definition is deployed through the native source pipeline with
  // the exact commit the asset write produced — this is what makes the
  // created definition launchable (CL-6447, cut over to native deploy
  // by CL-7363).
  expect(deployer.deploys).toHaveLength(1);
  expect(deployer.deploys[0]?.assetId).toBe("ast_1");
  expect(deployer.deploys[0]?.commitSha).toBe("deadbeef");
  expect(await skillsStore.getSkills("ast_1")).toEqual([
    "web-research",
    "long-form-write",
  ]);
  const body = (await response.json()) as { skills: readonly string[] };
  expect(body.skills).toEqual(["web-research", "long-form-write"]);
});

test("a create request without skills records an empty skills list", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const skillsStore = createInMemoryDefinitionSkillsStore();
  const app = buildApp(
    fakeAssetService({
      createAsset: () =>
        Promise.resolve({
          id: "ast_1",
          tenantId: TENANT.id,
          kind: "workflow" as const,
          name: "research-buddy",
          displayName: "Research Buddy",
          creatorPrincipalId: PRINCIPAL.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeCreateDb(),
    allowAllRequireGrant,
    fakeHistory(),
    fakeCapabilityInventory,
    skillsStore,
  );
  const response = await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
  });
  expect(response.status).toBe(201);
  expect(Object.keys(writtenFiles ?? {})).toEqual(SOURCE_TREE_PATHS);
  expect(await skillsStore.getSkills("ast_1")).toEqual([]);
});

test("a create request with toolPackagePins pins each named package at its highest published version", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp(
    fakeAssetService({
      createAsset: () =>
        Promise.resolve({
          id: "ast_1",
          tenantId: TENANT.id,
          kind: "workflow" as const,
          name: "scout",
          displayName: "Scout",
          creatorPrincipalId: PRINCIPAL.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
      listAssetBlobs: () =>
        Promise.resolve([
          "corbits-memory-tools-1.4.0.tgz",
          "corbits-web-search-tools-2.1.0.tgz",
        ]),
    }),
    withToolPackageRegistryQueries(fakeCreateDb()),
  );
  const response = await post(app, {
    name: "Scout",
    handle: "scout",
    systemPrompt: "You are Scout.",
    toolPackagePins: ["@corbits/memory-tools", "@corbits/web-search-tools"],
  });
  expect(response.status).toBe(201);
  const workflowJson = definitionFrom(writtenFiles);
  expect(pinsFrom(workflowJson)).toEqual([
    { name: "@corbits/memory-tools", version: "1.4.0" },
    { name: "@corbits/web-search-tools", version: "2.1.0" },
  ]);
});

test("a create request rejects a toolPackagePins entry outside the @corbits scope", async () => {
  const app = buildApp(fakeAssetService());
  const response = await post(app, {
    name: "Scout",
    handle: "scout",
    systemPrompt: "You are Scout.",
    toolPackagePins: ["not-a-corbits-package"],
  });
  expect(response.status).toBe(400);
});

function fakeSkillsDb(
  row: { id: string; assetId: string | null } | undefined,
): DB["db"] {
  return {
    query: {
      workflowDefinition: {
        findFirst: async () =>
          row === undefined
            ? undefined
            : {
                id: row.id,
                tenantId: TENANT.id,
                assetId: row.assetId,
                name: "Research Buddy",
              },
      },
    },
  } as unknown as DB["db"];
}

test("GET /skills returns an empty list for a definition with no skills store row", async () => {
  const app = buildApp(
    fakeAssetService(),
    fakeSkillsDb({ id: "def_1", assetId: "ast_1" }),
  );
  const response = await app.request("/skills?ids=def_1");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    skills: Record<string, readonly string[]>;
  };
  expect(body.skills).toEqual({ def_1: [] });
});

test("GET /skills returns the stored skill list", async () => {
  const skillsStore = createInMemoryDefinitionSkillsStore();
  await skillsStore.setSkills("ast_1", ["web-research"]);
  const app = buildApp(
    fakeAssetService(),
    fakeSkillsDb({ id: "def_1", assetId: "ast_1" }),
    allowAllRequireGrant,
    fakeHistory(),
    fakeCapabilityInventory,
    skillsStore,
  );
  const response = await app.request("/skills?ids=def_1");
  const body = (await response.json()) as {
    skills: Record<string, readonly string[]>;
  };
  expect(body.skills).toEqual({ def_1: ["web-research"] });
});

test("GET /skills omits unknown definition ids from the map rather than erroring", async () => {
  const app = buildApp(fakeAssetService(), fakeSkillsDb(undefined));
  const response = await app.request("/skills?ids=def_missing");
  const body = (await response.json()) as {
    skills: Record<string, readonly string[]>;
  };
  expect(body.skills).toEqual({});
});

test("PUT /:definitionId/skills replaces the skill set, writing the definition source tree to the asset", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const skillsStore = createInMemoryDefinitionSkillsStore();
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: () => Promise.resolve(storedDefinitionBytes()),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeSkillsDb({ id: "def_1", assetId: "ast_1" }),
    allowAllRequireGrant,
    fakeHistory(),
    fakeCapabilityInventory,
    skillsStore,
  );
  const response = await put(app, "/def_1/skills", {
    skills: ["long-form-write"],
  });
  expect(response.status).toBe(200);
  expect(Object.keys(writtenFiles ?? {})).toEqual(SOURCE_TREE_PATHS);
  expect(await skillsStore.getSkills("ast_1")).toEqual(["long-form-write"]);
  const body = (await response.json()) as { skills: readonly string[] };
  expect(body.skills).toEqual(["long-form-write"]);
});

test("PUT /:definitionId/skills 404s for an unknown definition", async () => {
  const app = buildApp(fakeAssetService(), fakeSkillsDb(undefined));
  const response = await put(app, "/def_missing/skills", { skills: [] });
  expect(response.status).toBe(404);
});

test("PUT /:definitionId/skills re-indexes the system prompt to exactly the new pins", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: () =>
        Promise.resolve(
          storedDefinitionBytes(
            "You are a careful research assistant.\n\n" +
              "<available_skills>\n- stale: gone now.\n</available_skills>",
          ),
        ),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeSkillsDb({ id: "def_1", assetId: "ast_1" }),
  );
  await put(app, "/def_1/skills", { skills: ["long-form-write"] });
  const prompt = promptFrom(definitionFrom(writtenFiles));
  expect(prompt).toContain("- long-form-write: What long-form-write does.");
  expect(prompt).not.toContain("stale");
  expect(prompt.split("<available_skills>")).toHaveLength(2);
});

test("PUT /:definitionId/skills with no pins strips the index from the prompt", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: () =>
        Promise.resolve(
          storedDefinitionBytes(
            "You are a careful research assistant.\n\n" +
              "<available_skills>\n- stale: gone now.\n</available_skills>",
          ),
        ),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeSkillsDb({ id: "def_1", assetId: "ast_1" }),
  );
  await put(app, "/def_1/skills", { skills: [] });
  const workflowJson = definitionFrom(writtenFiles);
  expect(promptFrom(workflowJson)).toBe(
    "You are a careful research assistant.",
  );
  expect(pinsFrom(workflowJson)).toEqual([]);
});

test("PUT /:definitionId/skills rejects a duplicate skill name with a 400", async () => {
  const app = buildApp(
    fakeAssetService(),
    fakeSkillsDb({ id: "def_1", assetId: "ast_1" }),
  );
  const response = await put(app, "/def_1/skills", {
    skills: ["Web research", "Web research"],
  });
  expect(response.status).toBe(400);
});

test("PUT /:definitionId/skills rejects a blank skill name with a 400", async () => {
  const app = buildApp(
    fakeAssetService(),
    fakeSkillsDb({ id: "def_1", assetId: "ast_1" }),
  );
  const response = await put(app, "/def_1/skills", { skills: ["   "] });
  expect(response.status).toBe(400);
});

/** A db fake for the instructions read/write routes: `findFirst` answers
 * the tenant-scoped lookup, and `update` records every `.set(...)` call
 * (in call order) rather than asserting a real drizzle round-trip — the
 * route's own choice of table/predicate is what a test here should
 * catch, not drizzle's chain semantics. `db.transaction` runs the
 * callback against the same recording `update`, so the row-update
 * atomicity test can assert both calls land (or, with
 * `failSecondUpdate`, that the first is rolled back rather than left
 * standing alone). */
function fakeInstructionsDb(
  row: { id: string; assetId: string | null; name: string } | undefined,
  options: { readonly failSecondUpdate?: boolean } = {},
): DB["db"] & {
  readonly updateCalls: readonly unknown[];
  /** `.set(...)` calls made straight on `db.update`, outside a
   * transaction — what the status route writes. */
  readonly directUpdateCalls: readonly unknown[];
} {
  const updateCalls: unknown[] = [];
  const committedUpdateCalls: unknown[] = [];
  const makeUpdater = (target: unknown[]) => () => ({
    set: (values: unknown) => {
      target.push(values);
      if (options.failSecondUpdate === true && target.length === 2) {
        throw new Error("simulated row-update failure");
      }
      return { where: async () => undefined };
    },
  });
  return {
    query: {
      workflowDefinition: {
        findFirst: async () =>
          row === undefined
            ? undefined
            : {
                id: row.id,
                tenantId: TENANT.id,
                assetId: row.assetId,
                name: row.name,
                description: null,
                currentVersion: "1",
                status: "deployed",
                createdAt: new Date("2026-08-01T00:00:00.000Z"),
                updatedAt: new Date("2026-08-01T00:00:00.000Z"),
              },
      },
    },
    update: makeUpdater(committedUpdateCalls),
    // A failed transaction commits nothing: `txCalls` (whatever ran
    // before the throw) is only merged into `updateCalls` once `fn`
    // resolves — a rejection propagates straight out, leaving
    // `updateCalls` exactly as it was, so a test can assert "both or
    // neither" by reading it after a failure and seeing it empty.
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      const txCalls: unknown[] = [];
      await fn({ update: makeUpdater(txCalls) });
      updateCalls.push(...txCalls);
    },
    updateCalls,
    directUpdateCalls: committedUpdateCalls,
  } as unknown as DB["db"] & {
    readonly updateCalls: readonly unknown[];
    readonly directUpdateCalls: readonly unknown[];
  };
}

test("GET /:definitionId returns the agent's display name and system prompt", async () => {
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: readAssetBlobFor(
        storedDefinitionBytes("You are a careful research assistant."),
      ),
    }),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
  );
  const response = await app.request("/def_1");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    name: string;
    systemPrompt: string;
  };
  expect(body.name).toBe("research-buddy");
  expect(body.systemPrompt).toBe("You are a careful research assistant.");
});

/** A `readAssetBlob` for an asset written before the source-form
 * cutover: it carries a bare `workflow.json`, so the entry module the
 * routes read is simply absent. */
function retiredEnvelopeAssetService(
  overrides: Partial<AssetService> = {},
): AssetService {
  return fakeAssetService({
    readAssetBlob: (params) =>
      Promise.reject(
        new AssetServiceError(
          "not_found",
          `readAssetBlob: asset ${params.assetId} has no blob at "${params.path}"`,
        ),
      ),
    ...overrides,
  });
}

test("GET /:definitionId answers 409, never a 500, for an asset still on the retired envelope", async () => {
  const app = buildApp(
    retiredEnvelopeAssetService(),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
  );
  const response = await app.request("/def_1");
  expect(response.status).toBe(409);
  const body = (await response.json()) as {
    error: { code: string; userMessage: string };
  };
  expect(body.error.code).toBe("conflict");
  expect(body.error.userMessage).toContain("workflow.json");
});

test("PUT /:definitionId answers 409 and writes nothing for an asset still on the retired envelope", async () => {
  let populateCalled = false;
  const app = buildApp(
    retiredEnvelopeAssetService({
      populateAsset: () => {
        populateCalled = true;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
  );
  const response = await put(app, "/def_1", {
    name: "Research Buddy",
    systemPrompt: "You are now polite.",
  });
  expect(response.status).toBe(409);
  expect(populateCalled).toBe(false);
});

test("GET /:definitionId 404s for an unknown definition", async () => {
  const app = buildApp(fakeAssetService(), fakeInstructionsDb(undefined));
  const response = await app.request("/def_missing");
  expect(response.status).toBe(404);
});

test("PUT /:definitionId writes the new system prompt in a single source-tree commit", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const db = fakeInstructionsDb({
    id: "def_1",
    assetId: "ast_1",
    name: "research-buddy",
  });
  const deployer = recordingAgentDefinitionDeployer();
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: () =>
        Promise.resolve(
          storedDefinitionBytes("You are a careful research assistant."),
        ),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    db,
    allowAllRequireGrant,
    fakeHistory(),
    fakeCapabilityInventory,
    createInMemoryDefinitionSkillsStore(),
    deployer,
  );
  const response = await put(app, "/def_1", {
    name: "Research Buddy",
    systemPrompt: "You are now a blunt, no-nonsense researcher.",
  });
  expect(response.status).toBe(200);
  expect(Object.keys(writtenFiles ?? {})).toEqual(SOURCE_TREE_PATHS);
  expect(promptFrom(definitionFrom(writtenFiles))).toBe(
    "You are now a blunt, no-nonsense researcher.",
  );
  // Saving instructions redeploys the definition through the native
  // source pipeline with the commit the edit produced, so the next
  // launch answers with the edit — the native install/probe/gate/freeze
  // replaces the old bare-freeze call (CL-7363).
  expect(deployer.deploys).toHaveLength(1);
  expect(deployer.deploys[0]?.assetId).toBe("ast_1");
  expect(deployer.deploys[0]?.commitSha).toBe("deadbeef");
  expect(db.updateCalls).toEqual([
    { description: "Research Buddy", updatedAt: expect.any(Date) },
    { displayName: "Research Buddy", updatedAt: expect.any(Date) },
  ]);
  const body = (await response.json()) as {
    name: string;
    systemPrompt: string;
  };
  expect(body).toEqual({
    name: "Research Buddy",
    systemPrompt: "You are now a blunt, no-nonsense researcher.",
  });
});

// CL-7389: PUT /:definitionId only rewrites the name and system prompt —
// it must never re-touch tool-package pins, so a tarball that lands in
// the registry after this definition deployed never silently moves an
// already-deployed specialist's stored pin.
test("PUT instructions after a newer tarball lands keeps the stored pin version", async () => {
  const pinned = withAgentToolPackagePin(
    serializeAgentDefinitionWorkflow(
      buildAgentDefinitionWorkflow({
        handle: "research-buddy",
        tenantDomain: TENANT.domain,
        description: "",
        systemPrompt: "You are a careful research assistant.",
      }),
    ),
    { name: "@corbits/memory-tools", version: "1.4.0" },
  );
  const tree = agentDefinitionSourceTree({
    handle: "research-buddy",
    workflowJson: pinned,
  });
  let current = new TextEncoder().encode(tree[AGENT_DEFINITION_ENTRY_PATH]);
  let writtenEntry: string | undefined;
  let listCalls = 0;
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: async () => current,
      populateAsset: (params) => {
        const entry = params.tree.files[AGENT_DEFINITION_ENTRY_PATH];
        if (typeof entry !== "string") {
          throw new Error("populateAsset wrote no entry module");
        }
        writtenEntry = entry;
        current = new TextEncoder().encode(entry);
        return Promise.resolve({ commitSha: "deadbeef" });
      },
      // A newer tarball has landed since this definition deployed. The
      // PUT below must never look at it.
      listAssetBlobs: () => {
        listCalls++;
        return Promise.resolve([
          "corbits-memory-tools-1.4.0.tgz",
          "corbits-memory-tools-1.5.0.tgz",
        ]);
      },
    }),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
  );
  const response = await put(app, "/def_1", {
    name: "Research Buddy",
    systemPrompt: "You are now a blunt, no-nonsense researcher.",
  });
  expect(response.status).toBe(200);
  expect(listCalls).toBe(0);
  expect(
    pinsFrom(
      definitionFrom({ [AGENT_DEFINITION_ENTRY_PATH]: writtenEntry ?? "" }),
    ),
  ).toEqual([{ name: "@corbits/memory-tools", version: "1.4.0" }]);
});

test("PUT /:definitionId 404s for an unknown definition", async () => {
  const app = buildApp(fakeAssetService(), fakeInstructionsDb(undefined));
  const response = await put(app, "/def_missing", {
    name: "Research Buddy",
    systemPrompt: "hello",
  });
  expect(response.status).toBe(404);
});

test("PUT /:definitionId rejects a blank display name with a 400", async () => {
  const app = buildApp(
    fakeAssetService(),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
  );
  const response = await put(app, "/def_1", {
    name: "   ",
    systemPrompt: "hello",
  });
  expect(response.status).toBe(400);
});

test("PUT /:definitionId rejects a blank system prompt with a 400", async () => {
  const app = buildApp(
    fakeAssetService(),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
  );
  const response = await put(app, "/def_1", {
    name: "Research Buddy",
    systemPrompt: "   ",
  });
  expect(response.status).toBe(400);
});

/** Captures the exact resolved resource string `requireGrant` was
 * called with, per route, so a test can assert the grant check is
 * scoped to the definitionId in the URL rather than the tenant-wide
 * `workflow-definition:*` wildcard. */
function capturingRequireGrant(): RequireGrant & {
  readonly calls: { readonly resource: string; readonly action: string }[];
} {
  const calls: { resource: string; action: string }[] = [];
  const requireGrant: RequireGrant = (resource, action) => {
    return async (c, next) => {
      const resolved =
        typeof resource === "function"
          ? resource({ param: (name) => c.req.param(name) })
          : resource;
      calls.push({ resource: resolved, action });
      await next();
    };
  };
  return Object.assign(requireGrant, { calls });
}

test("GET /:definitionId scopes its grant check to this definition, not the tenant-wide wildcard", async () => {
  const requireGrant = capturingRequireGrant();
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
    }),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
    requireGrant,
  );
  await app.request("/def_1");
  expect(requireGrant.calls).toEqual([
    {
      resource: idResource(
        "workflow-definition",
        "definitionId",
      )({ param: () => "def_1" }),
      action: "read",
    },
  ]);
});

test("PUT /:definitionId and PUT /:definitionId/skills scope their grant check per definition id", async () => {
  const requireGrant = capturingRequireGrant();
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: () => Promise.resolve(storedDefinitionBytes()),
    }),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
    requireGrant,
  );
  await put(app, "/def_1", { name: "Research Buddy", systemPrompt: "hi" });
  await put(app, "/def_1/skills", { skills: [] });
  expect(requireGrant.calls).toEqual([
    { resource: "workflow-definition:def_1", action: "update" },
    { resource: "workflow-definition:def_1", action: "update" },
  ]);
});

// A definition belonging to another tenant never resolves through this
// package's own tenant-scoped lookup (`and(eq(id), eq(tenantId))`,
// unchanged by the grant-scoping fix above) — it falls into exactly the
// same `row === undefined` branch an unknown id does, so it 404s rather
// than ever reaching a point where the caller's grant matters. The
// unknown-id tests above already exercise this branch; the case is
// restated here so the authz-scoping fix is explicitly covered too.
test("PUT /:definitionId 404s rather than 403s for a definition this tenant cannot see", async () => {
  const app = buildApp(fakeAssetService(), fakeInstructionsDb(undefined));
  const response = await put(app, "/def_other_tenant", {
    name: "Research Buddy",
    systemPrompt: "hello",
  });
  expect(response.status).toBe(404);
});

test("GET/PUT /:definitionId refuse a workbench host's definition as 404, never exposing its prompt", async () => {
  const hostName = `run-${"a".repeat(32)}`;
  const getApp = buildApp(
    fakeAssetService(),
    fakeInstructionsDb({ id: "def_host", assetId: "ast_host", name: hostName }),
  );
  const getResponse = await getApp.request("/def_host");
  expect(getResponse.status).toBe(404);

  const putApp = buildApp(
    fakeAssetService(),
    fakeInstructionsDb({ id: "def_host", assetId: "ast_host", name: hostName }),
  );
  const putResponse = await put(putApp, "/def_host", {
    name: "Not Actually Editable",
    systemPrompt: "You are now a responder.",
  });
  expect(putResponse.status).toBe(404);
});

test("PUT /:definitionId updates the definition's row and its asset's row together, or neither", async () => {
  const failingDb = fakeInstructionsDb(
    { id: "def_1", assetId: "ast_1", name: "research-buddy" },
    { failSecondUpdate: true },
  );
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: () => Promise.resolve(storedDefinitionBytes()),
      populateAsset: () => Promise.resolve({ commitSha: "deadbeef" }),
    }),
    failingDb,
  );
  const response = await put(app, "/def_1", {
    name: "Research Buddy",
    systemPrompt: "hello",
  });
  expect(response.status).toBe(500);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("partial_failure");
  // Neither row update is left standing when the transaction fails
  // partway through.
  expect(failingDb.updateCalls).toEqual([]);
});

// --- GET /by-name/:name (slug resolution) ---

test("a definition resolves by its immutable slug, not by scanning a listing page", async () => {
  const app = buildApp(
    fakeAssetService(),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
  );
  const response = await app.request("/by-name/research-buddy");
  expect(response.status).toBe(200);
  const body = (await response.json()) as { id: string; name: string };
  expect(body.id).toBe("def_1");
  expect(body.name).toBe("research-buddy");
});

test("an unknown slug 404s, and a workbench host's name is never resolvable by slug", async () => {
  const unknown = buildApp(fakeAssetService(), fakeInstructionsDb(undefined));
  expect((await unknown.request("/by-name/nobody")).status).toBe(404);

  const hostName = `run-${"a".repeat(32)}`;
  const host = buildApp(
    fakeAssetService(),
    fakeInstructionsDb({ id: "def_host", assetId: "ast_host", name: hostName }),
  );
  expect((await host.request(`/by-name/${hostName}`)).status).toBe(404);
});

// --- DELETE /:definitionId/capabilities/model (un-pin a model) ---

test("clearing a model rewrites the definition with no inference source", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  let writtenMessage: string | undefined;
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: readAssetBlobFor(
        storedDefinitionBytesWithModel("anthropic/claude-sonnet"),
      ),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        writtenMessage = params.tree.message;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
  );

  const response = await app.request("/def_1/capabilities/model", {
    method: "DELETE",
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { model?: string };
  expect(body.model).toBeUndefined();
  expect(writtenMessage).toBe("Clear research-buddy's model");
  expect(modelFrom(definitionFrom(writtenFiles))).toBeUndefined();
});

test("clearing a model 404s for an unknown definition and scopes its grant per id", async () => {
  const unknown = buildApp(fakeAssetService(), fakeInstructionsDb(undefined));
  expect(
    (
      await unknown.request("/def_missing/capabilities/model", {
        method: "DELETE",
      })
    ).status,
  ).toBe(404);

  const requireGrant = capturingRequireGrant();
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
    }),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
    requireGrant,
  );
  await app.request("/def_1/capabilities/model", { method: "DELETE" });
  expect(requireGrant.calls).toEqual([
    { resource: "workflow-definition:def_1", action: "update" },
  ]);
});

// --- PUT /:definitionId/status (archive and restore) ---

test("archiving a definition writes the stopped status and touches nothing else", async () => {
  const db = fakeInstructionsDb({
    id: "def_1",
    assetId: "ast_1",
    name: "research-buddy",
  });
  let populateCalled = false;
  const app = buildApp(
    fakeAssetService({
      populateAsset: () => {
        populateCalled = true;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    db,
  );
  const response = await put(app, "/def_1/status", { status: "stopped" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ id: "def_1", status: "stopped" });
  expect(db.directUpdateCalls).toEqual([
    { status: "stopped", updatedAt: expect.any(Date) },
  ]);
  // Archiving is a row-status change: the definition's asset and its git
  // history are never rewritten, which is what makes a restore possible.
  expect(populateCalled).toBe(false);
});

test("restoring a definition writes the deployed status back", async () => {
  const db = fakeInstructionsDb({
    id: "def_1",
    assetId: "ast_1",
    name: "research-buddy",
  });
  const app = buildApp(fakeAssetService(), db);
  const response = await put(app, "/def_1/status", { status: "deployed" });
  expect(response.status).toBe(200);
  expect(db.directUpdateCalls).toEqual([
    { status: "deployed", updatedAt: expect.any(Date) },
  ]);
});

test("a status outside the schema's two lifecycle states is a 400, never written", async () => {
  const db = fakeInstructionsDb({
    id: "def_1",
    assetId: "ast_1",
    name: "research-buddy",
  });
  const app = buildApp(fakeAssetService(), db);
  const response = await put(app, "/def_1/status", { status: "deleted" });
  expect(response.status).toBe(400);
  expect(db.directUpdateCalls).toEqual([]);
});

test("status 404s for an unknown definition and for a workbench host", async () => {
  const unknown = buildApp(fakeAssetService(), fakeInstructionsDb(undefined));
  expect(
    (await put(unknown, "/def_missing/status", { status: "stopped" })).status,
  ).toBe(404);

  const host = buildApp(
    fakeAssetService(),
    fakeInstructionsDb({
      id: "def_host",
      assetId: "ast_host",
      name: `run-${"a".repeat(32)}`,
    }),
  );
  expect(
    (await put(host, "/def_host/status", { status: "stopped" })).status,
  ).toBe(404);
});

test("status scopes its grant check per definition id and requires update", async () => {
  const requireGrant = capturingRequireGrant();
  const app = buildApp(
    fakeAssetService(),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
    requireGrant,
  );
  await put(app, "/def_1/status", { status: "stopped" });
  expect(requireGrant.calls).toEqual([
    { resource: "workflow-definition:def_1", action: "update" },
  ]);
});

test("a create request indexes its pinned skills into the stored system prompt", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp(
    fakeAssetService({
      createAsset: () =>
        Promise.resolve({
          id: "ast_1",
          tenantId: TENANT.id,
          kind: "workflow" as const,
          name: "research-buddy",
          displayName: "Research Buddy",
          creatorPrincipalId: PRINCIPAL.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeCreateDb(),
  );
  await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
    skills: ["web-research"],
  });
  const workflowJson = definitionFrom(writtenFiles);
  const prompt = promptFrom(workflowJson);
  expect(prompt.startsWith("You are a careful research assistant.")).toBe(true);
  expect(prompt).toContain("- web-research: What web-research does.");
  expect(prompt).toContain("skills_load");
  // The prompt tells the model to call `skills_load`, so the bundle that
  // provides it must be pinned on the same push.
  expect(pinsFrom(workflowJson)).toEqual([
    { name: "@corbits/tools-skills", version: "0.0.2" },
  ]);
});

test("pinning a skill the registry cannot resolve is a 400, not a 500", async () => {
  const routes = createAgentDefinitionRoutes({
    db: fakeCreateDb(),
    assetService: fakeAssetService(),
    skillIndex: {
      resolve: () =>
        Promise.reject(
          new SkillRegistryError("not_found", 'cannot pin skill "ghost"'),
        ),
    },
    skillsStore: createInMemoryDefinitionSkillsStore(),
    history: fakeHistory(),
    capabilityInventory: fakeCapabilityInventory,
    requireGrant: () => async (_c, next) => {
      await next();
    },
    deployer: recordingAgentDefinitionDeployer(),
  });
  const app = new Hono<TenantEnv>();
  app.use("*", async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", PRINCIPAL);
    await next();
  });
  app.route("/", routes);
  const response = await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
    skills: ["ghost"],
  });
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: { userMessage: string } };
  expect(body.error.userMessage).toContain("ghost");
});

test("a create request with no pinned skills stores the author's prompt verbatim", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const app = buildApp(
    fakeAssetService({
      createAsset: () =>
        Promise.resolve({
          id: "ast_1",
          tenantId: TENANT.id,
          kind: "workflow" as const,
          name: "research-buddy",
          displayName: "Research Buddy",
          creatorPrincipalId: PRINCIPAL.id,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeCreateDb(),
  );
  await post(app, {
    name: "Research Buddy",
    handle: "research-buddy",
    systemPrompt: "You are a careful research assistant.",
  });
  const workflowJson = definitionFrom(writtenFiles);
  expect(promptFrom(workflowJson)).toBe(
    "You are a careful research assistant.",
  );
  expect(pinsFrom(workflowJson)).toEqual([]);
});

// --- GET /:definitionId/versions ---

test("GET /:definitionId/versions lists the asset's commit log, newest marked current", async () => {
  const app = buildApp(
    fakeAssetService(),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
    allowAllRequireGrant,
    fakeHistory({
      history: () =>
        Promise.resolve([
          {
            commitSha: "sha2",
            message: "Update agent instructions for research-buddy",
            author: "Ada",
            committedAtIso: "2024-02-01T00:00:00.000Z",
          },
          {
            commitSha: "sha1",
            message: "Define agent Research Buddy",
            author: "Ada",
            committedAtIso: "2024-01-01T00:00:00.000Z",
          },
        ]),
    }),
  );
  const response = await app.request("/def_1/versions");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    versions: { commitSha: string; current: boolean }[];
  };
  expect(body.versions).toEqual([
    expect.objectContaining({ commitSha: "sha2", current: true }),
    expect.objectContaining({ commitSha: "sha1", current: false }),
  ]);
});

test("GET /:definitionId/versions 404s for an unknown definition", async () => {
  const app = buildApp(fakeAssetService(), fakeInstructionsDb(undefined));
  const response = await app.request("/def_missing/versions");
  expect(response.status).toBe(404);
});

test("GET /:definitionId/versions scopes its grant check per definition id", async () => {
  const requireGrant = capturingRequireGrant();
  const app = buildApp(
    fakeAssetService(),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
    requireGrant,
  );
  await app.request("/def_1/versions");
  expect(requireGrant.calls).toEqual([
    { resource: "workflow-definition:def_1", action: "read" },
  ]);
});

// --- POST /:definitionId/restore ---

test("restore writes the old commit's blobs as a new, human-named commit — never a git reset", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  let writtenMessage: string | undefined;
  const oldWorkflow = storedDefinitionBytes("You were once blunt.");
  const app = buildApp(
    fakeAssetService({
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        writtenMessage = params.tree.message;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
    allowAllRequireGrant,
    fakeHistory({
      readBlobAtCommit: () => Promise.resolve(oldWorkflow),
    }),
  );
  const response = await postTo(app, "/def_1/restore", {
    commitSha: "sha1old",
  });
  expect(response.status).toBe(200);
  expect(Object.keys(writtenFiles ?? {})).toEqual(SOURCE_TREE_PATHS);
  expect(promptFrom(definitionFrom(writtenFiles))).toBe("You were once blunt.");
  expect(writtenMessage).toBe("Restore agent research-buddy to sha1old");
  // The response reports the definition just restored, read out of the
  // entry module the route wrote — never a re-read of the asset, which
  // would race whatever else is committing to it.
  const body = (await response.json()) as { systemPrompt: string };
  expect(body.systemPrompt).toBe("You were once blunt.");
});

test("restore 404s when the target commit never carried an entry module", async () => {
  const app = buildApp(
    fakeAssetService(),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
    allowAllRequireGrant,
    fakeHistory({ readBlobAtCommit: () => Promise.resolve(null) }),
  );
  const response = await postTo(app, "/def_1/restore", { commitSha: "sha1" });
  expect(response.status).toBe(404);
});

test("restore rejects a blank commitSha with a 400", async () => {
  const app = buildApp(
    fakeAssetService(),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
  );
  const response = await postTo(app, "/def_1/restore", { commitSha: "" });
  expect(response.status).toBe(400);
});

test("restore scopes its grant check per definition id and requires update", async () => {
  const requireGrant = capturingRequireGrant();
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
    }),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
    requireGrant,
    fakeHistory({
      readBlobAtCommit: () => Promise.resolve(storedDefinitionBytes()),
    }),
  );
  await postTo(app, "/def_1/restore", { commitSha: "sha1" });
  expect(requireGrant.calls).toEqual([
    { resource: "workflow-definition:def_1", action: "update" },
  ]);
});

// --- POST /:definitionId/capabilities ---

test("adding a tool package pin merges it into the definition in one commit, named for a person", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  let writtenMessage: string | undefined;
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        writtenMessage = params.tree.message;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
      listAssetBlobs: () => Promise.resolve(["corbits-github-tools-3.1.0.tgz"]),
    }),
    withToolPackageRegistryQueries(
      fakeInstructionsDb({
        id: "def_1",
        assetId: "ast_1",
        name: "research-buddy",
      }),
    ),
  );
  const response = await postTo(app, "/def_1/capabilities", {
    kind: "toolPackage",
    name: "@corbits/github-tools",
  });
  expect(response.status).toBe(200);
  expect(Object.keys(writtenFiles ?? {})).toEqual(SOURCE_TREE_PATHS);
  expect(pinsFrom(definitionFrom(writtenFiles))).toEqual([
    { name: "@corbits/github-tools", version: "3.1.0" },
  ]);
  expect(writtenMessage).toBe("Add @corbits/github-tools to research-buddy");
  const body = (await response.json()) as {
    toolPackagePins: { name: string; version: string }[];
  };
  expect(body.toolPackagePins).toEqual([
    { name: "@corbits/github-tools", version: "3.1.0" },
  ]);
});

test("re-adding an already-pinned tool package keeps its stored version after a newer tarball lands", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  let writtenMessage: string | undefined;
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: readAssetBlobFor(
        new TextEncoder().encode(
          agentDefinitionSourceTree({
            handle: "research-buddy",
            workflowJson: withAgentToolPackagePin(
              serializeAgentDefinitionWorkflow(
                buildAgentDefinitionWorkflow({
                  handle: "research-buddy",
                  tenantDomain: TENANT.domain,
                  description: "",
                  systemPrompt: "You are a careful research assistant.",
                }),
              ),
              { name: "@corbits/memory-tools", version: "1.4.0" },
            ),
          })[AGENT_DEFINITION_ENTRY_PATH] as string,
        ),
      ),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        writtenMessage = params.tree.message;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
      // A newer tarball has landed since the pin was first added — this
      // re-add must not bump onto it.
      listAssetBlobs: () =>
        Promise.resolve([
          "corbits-memory-tools-1.4.0.tgz",
          "corbits-memory-tools-1.5.0.tgz",
        ]),
    }),
    withToolPackageRegistryQueries(
      fakeInstructionsDb({
        id: "def_1",
        assetId: "ast_1",
        name: "research-buddy",
      }),
    ),
    allowAllRequireGrant,
    fakeHistory(),
    {
      resolve: () =>
        Promise.resolve({
          toolPackages: [{ name: "@corbits/memory-tools" }],
          skills: [],
          models: [],
        }),
    },
  );
  const response = await postTo(app, "/def_1/capabilities", {
    kind: "toolPackage",
    name: "@corbits/memory-tools",
  });
  expect(response.status).toBe(200);
  expect(pinsFrom(definitionFrom(writtenFiles))).toEqual([
    { name: "@corbits/memory-tools", version: "1.4.0" },
  ]);
  expect(writtenMessage).not.toContain("Add");
  const body = (await response.json()) as {
    toolPackagePins: { name: string; version: string }[];
  };
  expect(body.toolPackagePins).toEqual([
    { name: "@corbits/memory-tools", version: "1.4.0" },
  ]);
});

test("adding a tool package pin the tenant's inventory doesn't offer is a 400, never written", async () => {
  let populateCalled = false;
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
      populateAsset: () => {
        populateCalled = true;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
  );
  const response = await postTo(app, "/def_1/capabilities", {
    kind: "toolPackage",
    name: "@corbits/nonexistent-tools",
  });
  expect(response.status).toBe(400);
  expect(populateCalled).toBe(false);
  const body = (await response.json()) as { error: { userMessage: string } };
  expect(body.error.userMessage).toContain("@corbits/nonexistent-tools");
});

test("adding a skill the inventory doesn't offer is a 400, never written", async () => {
  let populateCalled = false;
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
      populateAsset: () => {
        populateCalled = true;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
  );
  const response = await postTo(app, "/def_1/capabilities", {
    kind: "skill",
    name: "ghost-skill",
  });
  expect(response.status).toBe(400);
  expect(populateCalled).toBe(false);
});

test("adding a skill merges it additively into the skills store and re-indexes the prompt", async () => {
  let writtenFiles: Record<string, string | Uint8Array> | undefined;
  const skillsStore = createInMemoryDefinitionSkillsStore();
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
      populateAsset: (params) => {
        writtenFiles = params.tree.files;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
    allowAllRequireGrant,
    fakeHistory(),
    fakeCapabilityInventory,
    skillsStore,
  );
  const response = await postTo(app, "/def_1/capabilities", {
    kind: "skill",
    name: "research",
  });
  expect(response.status).toBe(200);
  expect(Object.keys(writtenFiles ?? {})).toEqual(SOURCE_TREE_PATHS);
  expect(await skillsStore.getSkills("ast_1")).toEqual(["research"]);
  expect(definitionFrom(writtenFiles).includes("research")).toBe(true);
  const body = (await response.json()) as { skills: string[] };
  expect(body.skills).toEqual(["research"]);
});

test("adding a model out of the tenant's catalog is a 400, never written", async () => {
  let populateCalled = false;
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
      populateAsset: () => {
        populateCalled = true;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
  );
  const response = await postTo(app, "/def_1/capabilities", {
    kind: "model",
    canonicalName: "openai/gpt-ghost",
  });
  expect(response.status).toBe(400);
  expect(populateCalled).toBe(false);
});

test("setting a model in the tenant's catalog writes a single named commit", async () => {
  let writtenMessage: string | undefined;
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
      populateAsset: (params) => {
        writtenMessage = params.tree.message;
        return Promise.resolve({ commitSha: "deadbeef" });
      },
    }),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
  );
  const response = await postTo(app, "/def_1/capabilities", {
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

test("capabilities route scopes its grant check per definition id and requires update", async () => {
  const requireGrant = capturingRequireGrant();
  const app = buildApp(
    fakeAssetService({
      readAssetBlob: readAssetBlobFor(storedDefinitionBytes()),
    }),
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
    requireGrant,
  );
  await postTo(app, "/def_1/capabilities", {
    kind: "model",
    canonicalName: "anthropic/claude-sonnet",
  });
  expect(requireGrant.calls).toEqual([
    { resource: "workflow-definition:def_1", action: "update" },
  ]);
});

test("capabilities route 404s for an unknown definition", async () => {
  const app = buildApp(fakeAssetService(), fakeInstructionsDb(undefined));
  const response = await postTo(app, "/def_missing/capabilities", {
    kind: "model",
    canonicalName: "anthropic/claude-sonnet",
  });
  expect(response.status).toBe(404);
});

test("two concurrent capability-adds on the same definition both land", async () => {
  const inventory: CapabilityInventoryProvider = {
    resolve: () =>
      Promise.resolve({
        toolPackages: [
          { name: "@corbits/github-tools" },
          { name: "@corbits/memory-tools" },
        ],
        skills: [{ name: "research" }],
        models: [{ canonicalName: "anthropic/claude-sonnet" }],
      }),
  };
  const assetService = liveDefinitionAsset(storedDefinitionBytes());
  const app = buildApp(
    assetService,
    withToolPackageRegistryQueries(
      fakeInstructionsDb({
        id: "def_1",
        assetId: "ast_1",
        name: "research-buddy",
      }),
    ),
    allowAllRequireGrant,
    fakeHistory(),
    inventory,
  );

  const [first, second] = await Promise.all([
    postTo(app, "/def_1/capabilities", {
      kind: "toolPackage",
      name: "@corbits/github-tools",
    }),
    postTo(app, "/def_1/capabilities", {
      kind: "toolPackage",
      name: "@corbits/memory-tools",
    }),
  ]);
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);

  const workflowJson = await readAgentDefinitionWorkflowJson(
    assetService,
    "ast_1",
  );
  const names = pinsFrom(workflowJson)
    .map((pin) => pin.name)
    .toSorted();
  expect(names).toEqual(["@corbits/github-tools", "@corbits/memory-tools"]);
});

test("concurrent PUT instructions and DELETE model both land", async () => {
  const assetService = liveDefinitionAsset(
    storedDefinitionBytesWithModel("anthropic/claude-sonnet"),
  );
  const app = buildApp(
    assetService,
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
  );

  const [putRes, delRes] = await Promise.all([
    put(app, "/def_1", {
      name: "Research Buddy",
      systemPrompt: "You are now a blunt researcher.",
    }),
    app.request("/def_1/capabilities/model", { method: "DELETE" }),
  ]);
  expect(putRes.status).toBe(200);
  expect(delRes.status).toBe(200);

  const workflowJson = await readAgentDefinitionWorkflowJson(
    assetService,
    "ast_1",
  );
  expect(promptFrom(workflowJson)).toBe("You are now a blunt researcher.");
  expect(modelFrom(workflowJson)).toBeUndefined();
});

test("concurrent PUT skills and DELETE model both land", async () => {
  const skillsStore = createInMemoryDefinitionSkillsStore();
  const assetService = liveDefinitionAsset(
    storedDefinitionBytesWithModel("anthropic/claude-sonnet"),
  );
  const app = buildApp(
    assetService,
    fakeInstructionsDb({
      id: "def_1",
      assetId: "ast_1",
      name: "research-buddy",
    }),
    allowAllRequireGrant,
    fakeHistory(),
    fakeCapabilityInventory,
    skillsStore,
  );

  const [skillsRes, delRes] = await Promise.all([
    put(app, "/def_1/skills", { skills: ["long-form-write"] }),
    app.request("/def_1/capabilities/model", { method: "DELETE" }),
  ]);
  expect(skillsRes.status).toBe(200);
  expect(delRes.status).toBe(200);

  const workflowJson = await readAgentDefinitionWorkflowJson(
    assetService,
    "ast_1",
  );
  expect(await skillsStore.getSkills("ast_1")).toEqual(["long-form-write"]);
  expect(promptFrom(workflowJson)).toContain(
    "- long-form-write: What long-form-write does.",
  );
  expect(modelFrom(workflowJson)).toBeUndefined();
});

test("concurrent DELETE model and a capability-add both land", async () => {
  const assetService = liveDefinitionAsset(
    storedDefinitionBytesWithModel("anthropic/claude-sonnet"),
  );
  const app = buildApp(
    assetService,
    withToolPackageRegistryQueries(
      fakeInstructionsDb({
        id: "def_1",
        assetId: "ast_1",
        name: "research-buddy",
      }),
    ),
  );

  const [delRes, capRes] = await Promise.all([
    app.request("/def_1/capabilities/model", { method: "DELETE" }),
    postTo(app, "/def_1/capabilities", {
      kind: "toolPackage",
      name: "@corbits/github-tools",
    }),
  ]);
  expect(delRes.status).toBe(200);
  expect(capRes.status).toBe(200);

  const workflowJson = await readAgentDefinitionWorkflowJson(
    assetService,
    "ast_1",
  );
  expect(modelFrom(workflowJson)).toBeUndefined();
  expect(pinsFrom(workflowJson).map((pin) => pin.name)).toContain(
    "@corbits/github-tools",
  );
});

test("concurrent pin_skill and DELETE model both land", async () => {
  const skillsStore = createInMemoryDefinitionSkillsStore();
  const assetService = liveDefinitionAsset(
    storedDefinitionBytesWithModel("anthropic/claude-sonnet"),
  );
  const db = fakeInstructionsDb({
    id: "def_1",
    assetId: "ast_1",
    name: "research-buddy",
  });
  const definitionApp = buildApp(
    assetService,
    db,
    allowAllRequireGrant,
    fakeHistory(),
    fakeCapabilityInventory,
    skillsStore,
  );
  const pinAuthenticator: WorkflowRunAuthenticator = {
    resolve: (token, address) =>
      Promise.resolve(
        token === "sidecar-token" && address === "run_1@example.com"
          ? {
              tenantId: TENANT.id,
              principalId: PRINCIPAL.id,
              runId: "run_1",
            }
          : null,
      ),
  };
  const pinApp = createWorkflowSkillPinRoutes({
    db,
    assetService,
    skillIndex: fakeSkillIndex,
    skillsStore,
    authenticator: pinAuthenticator,
    deployer: recordingAgentDefinitionDeployer(),
  });

  const [pinRes, delRes] = await Promise.all([
    pinApp.request("/pin", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sidecar-token",
        "x-workflow-run-address": "run_1@example.com",
      },
      body: JSON.stringify({
        definitionId: "def_1",
        skillName: "research",
      }),
    }),
    definitionApp.request("/def_1/capabilities/model", { method: "DELETE" }),
  ]);
  expect(pinRes.status).toBe(200);
  expect(delRes.status).toBe(200);

  const workflowJson = await readAgentDefinitionWorkflowJson(
    assetService,
    "ast_1",
  );
  expect(await skillsStore.getSkills("ast_1")).toEqual(["research"]);
  expect(promptFrom(workflowJson)).toContain("- research: What research does.");
  expect(modelFrom(workflowJson)).toBeUndefined();
});
