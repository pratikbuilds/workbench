// Proves `launchFoldedRun`'s own folded-run shape: it resolves
// inference sources against the tenant catalog, writes the same
// principal/session/run rows a folded launch writes (never a
// deployment-shaped run), deploys via `sessionService.deployInstanceAtHead`
// — never `deployWorkflowDefinition` — and rolls the just-committed rows
// back (or marks the run failed-but-routable on a leaked deploy) when the
// deploy fails. `persistExtra` is proven to run inside the same
// transaction as the principal/session/run inserts.
//
// `resolveDefinitionSources` is real catalog resolution (joins across
// several tables via `@intx/db`), which a plain chainable fake `db`
// cannot answer without reimplementing that join. Rather than fake the
// join, this file replaces just that one export of `@intx/hub-api` with
// a controllable stub — spreading through every other export unchanged
// — so a real tenant catalog is never required to prove the wiring.
import { describe, expect, mock, test } from "bun:test";
import {
  agentSession,
  principal,
  workflowDefinition,
  workflowRun,
} from "@intx/db/schema";
import { foldedRun } from "../src/schema";
import { SessionLaunchError } from "@intx/hub-sessions";
import type { EventCollectorRegistry, SidecarRouter } from "@intx/hub-sessions";
import type { DefinitionSourceResolution } from "@intx/hub-api";
import type { FoldedRunsDeps } from "../src/types";
import type { FoldedBody } from "@intx/workflow-deploy";

const actualHubApi = await import("@intx/hub-api");

let resolveDefinitionSourcesResult: DefinitionSourceResolution = {
  ok: true,
  sources: [
    {
      id: "off_1",
      provider: "anthropic",
      baseURL: "https://inference.invalid",
      apiKey: "placeholder",
      model: "claude-sonnet-5",
    },
  ],
  defaultSource: "off_1",
};
const resolveDefinitionSourcesCalls: unknown[] = [];
// A queued sequence of per-call results, consumed oldest-first, for a
// test that must prove `deployAtHead` retries with a SECOND fallback
// model after the first attempt fails — a single shared
// `resolveDefinitionSourcesResult` cannot express "fails, then
// succeeds" across two calls inside the same synchronous resolution.
// Empty (the common case) falls back to the single shared result
// above, unchanged for every other test in this file.
let resolveDefinitionSourcesQueue: DefinitionSourceResolution[] = [];

mock.module("@intx/hub-api", () => ({
  ...actualHubApi,
  resolveDefinitionSources: async (...args: unknown[]) => {
    resolveDefinitionSourcesCalls.push(args[0]);
    const queued = resolveDefinitionSourcesQueue.shift();
    return queued ?? resolveDefinitionSourcesResult;
  },
}));

const actualDb = await import("@intx/db");

type BuildCredentialDeliveryResult = Awaited<
  ReturnType<typeof actualDb.buildCredentialDelivery>
>;

let buildCredentialDeliveryResult: BuildCredentialDeliveryResult = {
  ok: true,
  delivery: undefined,
};
const buildCredentialDeliveryCalls: unknown[] = [];

// `deployAtHead` consults `listVisibleOfferings` once per catalog-resolved
// launch, to correct a source's adapter-registry key when its offering's
// provider is actually named "ollama" (`withOllamaAdapterKey`). Only the
// two fields that decision reads are given here; a real `ResolvedOffering`
// carries far more, none of which this fix touches.
type FakeResolvedOffering = {
  offering: { id: string };
  provider: { name: string };
};
let listVisibleOfferingsResult: FakeResolvedOffering[] = [];
const listVisibleOfferingsCalls: unknown[] = [];

mock.module("@intx/db", () => ({
  ...actualDb,
  buildCredentialDelivery: async (...args: unknown[]) => {
    buildCredentialDeliveryCalls.push(args[0]);
    return buildCredentialDeliveryResult;
  },
  listVisibleOfferings: async (...args: unknown[]) => {
    listVisibleOfferingsCalls.push(args);
    return listVisibleOfferingsResult;
  },
}));

const {
  launchFoldedRun,
  mintFoldedRun,
  deployAtHead,
  InferenceResolutionError,
} = await import("../src/launch");
const { wakeFoldedRun } = await import("../src/wake");
const { sessionAsset } = await import("@intx/db/schema");

type InsertChain = {
  values(values: unknown): Promise<void>;
};

/**
 * `deployAtHead` reads the run's definition row twice: once before the
 * deploy (for the asset its per-run tree is committed into) and once
 * after, to see which row the deploy repointed the run at. `definitionIds`
 * answers those reads in order — a second id different from the first is
 * the per-run clone every real code-sourced deploy mints.
 */
function createFakeDb(
  assetId: string | null = "ast_definition1",
  definitionIds: readonly string[] = ["wfd_definition1", "wfd_definition1"],
) {
  const inserted: { table: unknown; values: unknown }[] = [];
  const updated: { table: unknown; values: unknown }[] = [];
  const deleted: { table: unknown }[] = [];
  let definitionReadIndex = 0;

  function insertOn(table: unknown): InsertChain {
    return {
      values: async (values: unknown) => {
        inserted.push({ table, values });
      },
    };
  }

  return {
    select() {
      const definitionId =
        definitionIds[definitionReadIndex] ??
        definitionIds[definitionIds.length - 1];
      definitionReadIndex += 1;
      return {
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: async () =>
                assetId === null ? [] : [{ definitionId, assetId }],
            }),
          }),
        }),
      };
    },
    insert(table: unknown) {
      return insertOn(table);
    },
    update(table: unknown) {
      return {
        set(values: unknown) {
          updated.push({ table, values });
          return { where: async () => undefined };
        },
      };
    },
    delete(table: unknown) {
      deleted.push({ table });
      return { where: async () => undefined };
    },
    async transaction(fn: (tx: unknown) => Promise<void>) {
      await fn({
        insert(table: unknown) {
          return insertOn(table);
        },
        update(table: unknown) {
          return {
            set(values: unknown) {
              updated.push({ table, values });
              return { where: async () => undefined };
            },
          };
        },
        delete(table: unknown) {
          deleted.push({ table });
          return { where: async () => undefined };
        },
      });
    },
    inserted,
    updated,
    deleted,
  };
}

function createFakeEventCollectors(): EventCollectorRegistry & {
  createCalls: unknown[];
  abandonCalls: string[];
} {
  const createCalls: unknown[] = [];
  const abandonCalls: string[] = [];
  return {
    createCalls,
    abandonCalls,
    create(...args: unknown[]) {
      createCalls.push(args);
    },
    abandon(address: string) {
      abandonCalls.push(address);
    },
    has: () => false,
    getStatus: () => undefined,
    getAccumulatedText: () => undefined,
    getCurrentTurnId: () => null,
    getLastTurnId: () => undefined,
    dispatch: () => undefined,
  } as unknown as EventCollectorRegistry & {
    createCalls: unknown[];
    abandonCalls: string[];
  };
}

type FakeSessionService = FoldedRunsDeps["sessionService"] & {
  adoptedDeployCalls: AdoptedDeployCall[];
};

type AdoptedDeployCall = {
  tenantId: string;
  anchorRunId: string;
  deploymentDomain: string;
  agentAddress: string;
  entry: string;
  definitionAssetId: string;
  source: {
    kind: string;
    assetId: string;
    package: { format: string; commitSha: string };
  };
  config: {
    sources: unknown[];
    defaultSource: string;
    tenantId: string;
    principalId: string;
    grants: Record<string, unknown>[];
  };
  credentialCipher?: unknown;
};

function createFakeSessionService(): FakeSessionService {
  const adoptedDeployCalls: AdoptedDeployCall[] = [];
  return {
    adoptedDeployCalls,
    async stageWorkflowStep() {},
    async deployInstanceAtHead() {
      throw new Error(
        "deployInstanceAtHead must not be called: a folded run deploys " +
          "its own rendered workflow source package",
      );
    },
    async deployWorkflowFromSource() {
      throw new Error(
        "deployWorkflowFromSource must not be called: it INSERTs an anchor " +
          "row a folded run already owns",
      );
    },
    async deployAdoptedWorkflowFromSource(params: AdoptedDeployCall) {
      adoptedDeployCalls.push(params);
      return {
        anchorRunId: params.anchorRunId,
        deploymentAddress: params.agentAddress,
        publicKey: "test-public-key",
      };
    },
    async deployWorkflowDefinition() {
      throw new Error(
        "deployWorkflowDefinition must not be called: launchFoldedRun " +
          "launches a folded run through the adopting code-sourced front",
      );
    },
    async sendUserMessage() {
      return new TextEncoder().encode("raw-mime-bytes");
    },
    async endSession() {},
  } as unknown as FakeSessionService;
}

type PopulateAssetCall = {
  assetId: string;
  ref: string;
  tree: { files: Record<string, string>; message: string };
};

function createFakeAssetService(): FoldedRunsDeps["assetService"] & {
  populateAssetCalls: PopulateAssetCall[];
} {
  const populateAssetCalls: PopulateAssetCall[] = [];
  return {
    populateAssetCalls,
    async createAsset() {
      throw new Error(
        "createAsset must not be called: a folded run commits its per-run " +
          "tree into the definition asset its host already minted",
      );
    },
    async populateAsset(params: PopulateAssetCall) {
      populateAssetCalls.push(params);
      return { commitSha: "commit-sha-1" };
    },
  } as unknown as FoldedRunsDeps["assetService"] & {
    populateAssetCalls: PopulateAssetCall[];
  };
}

type RunGrantsCall = {
  agentAddress: string;
  runId: string;
  stepGrants: readonly unknown[];
};

/**
 * Records the `run.grants` frames `deployAtHead` produces. `routable`
 * mirrors the real router's return: `false` means the deployment address is
 * not routable, which the launch must treat as a hard failure rather than
 * starting a run with no grants file.
 */
function createFakeSidecarRouter(routable = true): SidecarRouter & {
  runGrantsCalls: RunGrantsCall[];
} {
  const runGrantsCalls: RunGrantsCall[] = [];
  return {
    runGrantsCalls,
    sendRunGrants(
      agentAddress: string,
      runId: string,
      stepGrants: readonly unknown[],
    ) {
      runGrantsCalls.push({ agentAddress, runId, stepGrants });
      return routable;
    },
  } as unknown as SidecarRouter & { runGrantsCalls: RunGrantsCall[] };
}

function onlyCall<T>(calls: readonly T[]): T {
  const [call] = calls;
  if (call === undefined) {
    throw new Error("expected exactly one recorded call");
  }
  return call;
}

/**
 * The definition a rendered entry module default-exports. The run's
 * evaluated definition IS the deployed bytes under the workflow.json
 * retirement — the tree carries no dependency and no build call, because
 * an asset tree is a standalone codebase with no workspace to resolve
 * one against — so a test that wants to know what was deployed reads the
 * definition back out of them.
 */
function entryDefinition(entry: string): Record<string, unknown> {
  const open = entry.indexOf("export default ");
  const close = entry.lastIndexOf(";");
  if (open === -1 || close === -1) {
    throw new Error(
      `rendered entry module has no definition literal: ${entry}`,
    );
  }
  return JSON.parse(entry.slice(open + "export default ".length, close));
}

/** Walk a parsed definition literal by key path. The real
 * `WorkflowDefinition` is function-bearing, so parsed JSON never
 * satisfies it; this reads the plain data back without asserting it
 * into a type it cannot honestly have. */
function at(value: unknown, ...path: readonly string[]): unknown {
  let cursor = value;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null) {
      throw new Error(`definition has nothing at ${path.join(".")}`);
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/** The lone step primitive a run's definition carries. */
function foldedStep(definition: Record<string, unknown>): unknown {
  const stepOrder = at(definition, "stepOrder");
  if (!Array.isArray(stepOrder) || typeof stepOrder[0] !== "string") {
    throw new Error("definition carries no single-step stepOrder");
  }
  return at(definition, "steps", stepOrder[0]);
}

const FOLDED_BODY: FoldedBody = {
  systemPrompt: "you are a workbench host",
  toolPackagePins: [],
  grantRequirements: [],
  credentialBindings: [],
  model: "claude-sonnet-5",
};

describe("mintFoldedRun", () => {
  test("writes the folded run rows and deploys nothing", async () => {
    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();
    const persistExtraCalls: unknown[] = [];

    const result = await mintFoldedRun(
      { db: db as never },
      {
        tenantId: "ten_1",
        instanceId: "ins_workbench1",
        triggerAddress: "ins_workbench1@ten1.workbench.test",
        definitionId: "wfd_workbench1",
        persistExtra: async (tx) => {
          persistExtraCalls.push(tx);
        },
      },
    );

    expect(result.sessionId).toBeTruthy();
    expect(result.instancePrincipalId).toBeTruthy();
    // The caller's own row commits inside the same transaction as the
    // principal/session/run inserts, exactly as it does on a launch.
    expect(persistExtraCalls).toHaveLength(1);
    expect(db.inserted.map((row) => row.table)).toEqual([
      principal,
      agentSession,
      workflowRun,
      foldedRun,
    ]);

    // The whole point of a mint: an addressable run with no sidecar
    // traffic and no collector — the first mail wakes it instead.
    expect(sessionService.adoptedDeployCalls).toEqual([]);
    expect(eventCollectors.createCalls).toEqual([]);
  });
});

describe("launchFoldedRun", () => {
  test("resolves sources, writes the folded run rows, and deploys via deployInstanceAtHead", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();
    const persistExtraCalls: unknown[] = [];

    const result = await launchFoldedRun(
      {
        db: db as never,
        sessionService,
        assetService: createFakeAssetService(),
        sidecarRouter: createFakeSidecarRouter(),
        toolGrantsForPins: () => [],
        eventCollectors,
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_workbench1",
        triggerAddress: "ins_workbench1@ten1.workbench.test",
        definitionId: "wfd_workbench1",
        foldedBody: FOLDED_BODY,
        launchLabel: "the workbench host",
        persistExtra: async (tx) => {
          persistExtraCalls.push(tx);
        },
      },
    );

    expect(result.sessionId).toBeTruthy();
    expect(result.instancePrincipalId).toBeTruthy();

    // `persistExtra` ran inside the same transaction handle the
    // principal/session/run inserts used.
    expect(persistExtraCalls).toHaveLength(1);

    expect(eventCollectors.createCalls).toEqual([
      [
        "ins_workbench1@ten1.workbench.test",
        "ten_1",
        result.sessionId,
        "ins_workbench1",
      ],
    ]);
    expect(eventCollectors.abandonCalls).toEqual([]);

    expect(resolveDefinitionSourcesCalls).toHaveLength(1);
    expect(resolveDefinitionSourcesCalls[0]).toMatchObject({
      tenantId: "ten_1",
      fallbackModel: "claude-sonnet-5",
    });

    expect(sessionService.adoptedDeployCalls).toHaveLength(1);
    // The deploy adopts the anchor row `mintFoldedRun` already wrote,
    // and pins the commit the run's own source tree was committed at.
    const deployed = onlyCall(sessionService.adoptedDeployCalls);
    expect(deployed.anchorRunId).toBe("ins_workbench1");
    expect(deployed.deploymentDomain).toBe("ten1.workbench.test");
    expect(deployed.source).toEqual({
      kind: "asset",
      assetId: "ast_definition1",
      package: { format: "source", commitSha: "commit-sha-1" },
    });
    expect(deployed.agentAddress).toBe("ins_workbench1@ten1.workbench.test");
    expect(deployed.config.defaultSource).toBe("off_1");
    expect(deployed.config.tenantId).toBe("ten_1");

    const principalInsert = db.inserted.find((row) => row.table === principal);
    expect(principalInsert?.values).toMatchObject({
      tenantId: "ten_1",
      kind: "workflow",
      refId: "ins_workbench1",
      status: "active",
    });

    const runInsert = db.inserted.find((row) => row.table === workflowRun);
    expect(runInsert?.values).toMatchObject({
      id: "ins_workbench1",
      definitionId: "wfd_workbench1",
      anchorRunId: "ins_workbench1",
      tenantId: "ten_1",
      address: "ins_workbench1@ten1.workbench.test",
      status: "running",
    });

    const sessionInsert = db.inserted.find((row) => row.table === agentSession);
    expect(sessionInsert?.values).toMatchObject({
      tenantId: "ten_1",
      agentId: "wfd_workbench1",
      principalId: result.instancePrincipalId,
      status: "active",
    });

    // The permanent folded-run marker (`./schema.ts`) is written
    // unconditionally, inside the same transaction, regardless of
    // whether the caller supplies `persistExtra` — this is what lets a
    // workbench-owned scoped run listing exclude every folded run with
    // no per-caller opt-in.
    const foldedRunInsert = db.inserted.find((row) => row.table === foldedRun);
    expect(foldedRunInsert?.values).toMatchObject({
      id: "ins_workbench1",
      tenantId: "ten_1",
    });
  });

  // CL-6586: an Ollama-backed offering resolves with `provider:
  // "openai-compatible"` — the accurate wire format — but the sidecar's
  // adapter registry only recognizes a locally-served source under the
  // key "ollama" (`apps/sidecar/src/config.ts`). Left uncorrected, the
  // built-in OpenAI adapter serves the request instead and rejects the
  // offering's `quirks.default` bag. `deployAtHead` must fix the key up
  // before the source reaches the deployed config.
  test('corrects the adapter key to "ollama" for a catalog-resolved Ollama offering', async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_ollama",
          provider: "openai-compatible",
          baseURL: "https://home-mac-studio.tail87f5aa.ts.net/v1",
          apiKey: "placeholder",
          model: "gpt-oss:20b",
          quirks: { default: { numCtx: 131_072, maxOutputTokens: 32_768 } },
        },
      ],
      defaultSource: "off_ollama",
    };
    listVisibleOfferingsResult = [
      { offering: { id: "off_ollama" }, provider: { name: "ollama" } },
    ];
    listVisibleOfferingsCalls.length = 0;

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();

    await launchFoldedRun(
      {
        db: db as never,
        sessionService,
        assetService: createFakeAssetService(),
        sidecarRouter: createFakeSidecarRouter(),
        toolGrantsForPins: () => [],
        eventCollectors,
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_workbench1",
        triggerAddress: "ins_workbench1@ten1.workbench.test",
        definitionId: "wfd_workbench1",
        foldedBody: FOLDED_BODY,
        launchLabel: "the workbench host",
      },
    );

    expect(listVisibleOfferingsCalls).toEqual([[db, "ten_1"]]);
    const deployed = onlyCall(sessionService.adoptedDeployCalls);
    expect(deployed.config.sources).toEqual([
      {
        id: "off_ollama",
        provider: "ollama",
        baseURL: "https://home-mac-studio.tail87f5aa.ts.net/v1",
        apiKey: "placeholder",
        model: "gpt-oss:20b",
        quirks: { default: { numCtx: 131_072, maxOutputTokens: 32_768 } },
      },
    ]);

    // Reset for every test after this one.
    listVisibleOfferingsResult = [];
  });

  // CL-6164: the step's default input selector (`{ from:
  // "trigger.payload" }`) reads the triggering mail's bare `content`
  // verbatim and feeds it straight into `agent.send`, which throws on an
  // empty string — and `content` is legitimately empty for
  // attachments-only mail. A caller that knows its run never reads its
  // input (the workbench host) must be able to pin a literal instead, so
  // an attachments-only first mail cannot crash the run before it opens.
  // The literal now travels in the rendered config, so it must show up
  // in the committed bytes, not in a caller-supplied definition.
  test("the caller's literal input reaches the deployed bytes", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };

    const sessionService = createFakeSessionService();
    const assetService = createFakeAssetService();

    await launchFoldedRun(
      {
        db: createFakeDb() as never,
        sessionService,
        assetService,
        sidecarRouter: createFakeSidecarRouter(),
        toolGrantsForPins: () => [],
        eventCollectors: createFakeEventCollectors(),
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_workbench1",
        triggerAddress: "ins_workbench1@ten1.workbench.test",
        definitionId: "wfd_workbench1",
        foldedBody: FOLDED_BODY,
        launchLabel: "the workbench host",
        mode: { kind: "step", literalInput: "workbench-host anchor turn" },
      },
    );

    const definition = entryDefinition(
      assetService.populateAssetCalls[0]?.tree.files["workflow.js"] ?? "",
    );
    expect(at(foldedStep(definition), "input")).toEqual({
      literal: "workbench-host anchor turn",
    });
  });

  // CL-6149: a pinned tool package's calls failed every call with
  // "No matching grants" because nothing derived `tool:` grants for
  // `toolPackagePins` — the deploy-time capability walk only covers
  // inline tool factories. `deployAtHead` must call `toolGrantsForPins`
  // with the launch's pins and fold the result into `config.grants` (the
  // array the sidecar writes verbatim to `state/grants.json`, the file
  // the spawned child's authz gate actually reads), minted against this
  // run's own principal.
  test("mints config.grants from toolGrantsForPins, scoped to this run's principal", async () => {
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();
    const toolGrantsForPinsCalls: unknown[] = [];

    const pinnedFoldedBody: FoldedBody = {
      ...FOLDED_BODY,
      toolPackagePins: [{ name: "@corbits/memory-tools", version: "0.0.4" }],
    };

    const result = await launchFoldedRun(
      {
        db: db as never,
        sessionService,
        assetService: createFakeAssetService(),
        sidecarRouter: createFakeSidecarRouter(),
        toolGrantsForPins: (pins) => {
          toolGrantsForPinsCalls.push(pins);
          return [
            {
              resource: "tool:@corbits/memory-tools/memory:memory_add",
              action: "invoke",
              effect: "ask",
            },
            {
              resource: "tool:@corbits/memory-tools/memory:memory_list",
              action: "invoke",
              effect: "allow",
            },
          ];
        },
        eventCollectors,
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_workbench1",
        triggerAddress: "ins_workbench1@ten1.workbench.test",
        definitionId: "wfd_workbench1",
        foldedBody: pinnedFoldedBody,
        launchLabel: "the workbench host",
      },
    );

    expect(toolGrantsForPinsCalls).toEqual([pinnedFoldedBody.toolPackagePins]);

    const deployed = onlyCall(sessionService.adoptedDeployCalls);
    expect(deployed.config.principalId).toBe(result.instancePrincipalId);
    expect(deployed.config.grants).toEqual([
      {
        id: expect.any(String),
        resource: "tool:@corbits/memory-tools/memory:memory_add",
        action: "invoke",
        effect: "ask",
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: result.instancePrincipalId,
      },
      {
        id: expect.any(String),
        resource: "tool:@corbits/memory-tools/memory:memory_list",
        action: "invoke",
        effect: "allow",
        origin: "system",
        conditions: null,
        expiresAt: null,
        roleId: null,
        principalId: result.instancePrincipalId,
      },
    ]);
  });

  // A caller-supplied `credentialCipher` must reach `resolveDefinitionSources`
  // on every launch, or an invited agent's credential secret is decrypted
  // (if at all) through the built-in noop fallback instead of the real
  // cipher the composition root writes secrets with — delivering the raw
  // stored value as the provider's API key instead of the plaintext secret.
  test("threads a caller-supplied credentialCipher through to resolveDefinitionSources", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "openai-compatible",
          baseURL: "https://openrouter.ai/api/v1",
          apiKey: "sk-or-v1-real-key",
          model: "anthropic/claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();
    const credentialCipher = {
      encrypt: async (plaintext: string) => plaintext,
      decrypt: async (blob: string) => blob,
    };

    await launchFoldedRun(
      {
        db: db as never,
        sessionService,
        assetService: createFakeAssetService(),
        sidecarRouter: createFakeSidecarRouter(),
        toolGrantsForPins: () => [],
        eventCollectors,
        credentialCipher,
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_invited1",
        triggerAddress: "ins_invited1@ten1.workbench.test",
        definitionId: "wfd_invited1",
        foldedBody: FOLDED_BODY,
        launchLabel: "the invited agent",
      },
    );

    expect(resolveDefinitionSourcesCalls).toHaveLength(1);
    expect(resolveDefinitionSourcesCalls[0]).toMatchObject({
      tenantId: "ten_1",
      credentialCipher,
    });
  });

  test("rolls back the committed rows and abandons the collector when the deploy fails", async () => {
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const deployError = new Error("sidecar unreachable");
    sessionService.deployAdoptedWorkflowFromSource = async () => {
      throw deployError;
    };
    const eventCollectors = createFakeEventCollectors();

    await expect(
      launchFoldedRun(
        {
          db: db as never,
          sessionService,
          assetService: createFakeAssetService(),
          sidecarRouter: createFakeSidecarRouter(),
          toolGrantsForPins: () => [],
          eventCollectors,
        },
        {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
          triggerAddress: "ins_workbench1@ten1.workbench.test",
          definitionId: "wfd_workbench1",
          foldedBody: FOLDED_BODY,
          launchLabel: "the workbench host",
        },
      ),
    ).rejects.toThrow(deployError);

    expect(eventCollectors.abandonCalls).toEqual([
      "ins_workbench1@ten1.workbench.test",
    ]);

    const sessionUpdate = db.updated.find((row) => row.table === agentSession);
    expect(sessionUpdate?.values).toMatchObject({ status: "ended" });

    // The run row and its folded-run marker are rolled back together —
    // a rolled-back launch must leave no marker behind for an id that
    // no longer names a real run.
    expect(db.deleted).toEqual([{ table: workflowRun }, { table: foldedRun }]);

    const principalUpdate = db.updated.find((row) => row.table === principal);
    expect(principalUpdate?.values).toMatchObject({ status: "deactivated" });
  });

  test("marks the run failed (not deleted) when the deploy leaks a running child", async () => {
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    sessionService.deployAdoptedWorkflowFromSource = async () => {
      throw new SessionLaunchError("start", new Error("ack timeout"), true);
    };
    const eventCollectors = createFakeEventCollectors();

    await expect(
      launchFoldedRun(
        {
          db: db as never,
          sessionService,
          assetService: createFakeAssetService(),
          sidecarRouter: createFakeSidecarRouter(),
          toolGrantsForPins: () => [],
          eventCollectors,
        },
        {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
          triggerAddress: "ins_workbench1@ten1.workbench.test",
          definitionId: "wfd_workbench1",
          foldedBody: FOLDED_BODY,
          launchLabel: "the workbench host",
        },
      ),
    ).rejects.toThrow(SessionLaunchError);

    // Neither the run row nor its folded-run marker is deleted: the
    // leaked child is still real and still folded, so both rows must
    // stay.
    expect(db.deleted).toEqual([]);
    const runUpdate = db.updated.find((row) => row.table === workflowRun);
    expect(runUpdate?.values).toEqual({ status: "failed" });
  });

  // `deployAdoptedWorkflowFromSource` resolving means a live child now
  // exists on the sidecar; `sendRunGrants` returning `false` (address not
  // yet routable — a real hub-link drop between the deploy ack and the
  // grants send) must never read as "nothing was deployed." CL-7213: this
  // used to throw a plain `Error`, which the catch's `leaked` check missed
  // entirely, deleting the row for a run that was actually live and now
  // permanently unauthorized and untracked.
  test("marks the run failed (not deleted) when sendRunGrants fails after a successful deploy", async () => {
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();

    await expect(
      launchFoldedRun(
        {
          db: db as never,
          sessionService,
          assetService: createFakeAssetService(),
          sidecarRouter: createFakeSidecarRouter(false),
          toolGrantsForPins: () => [],
          eventCollectors,
        },
        {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
          triggerAddress: "ins_workbench1@ten1.workbench.test",
          definitionId: "wfd_workbench1",
          foldedBody: FOLDED_BODY,
          launchLabel: "the workbench host",
        },
      ),
    ).rejects.toThrow(SessionLaunchError);

    expect(db.deleted).toEqual([]);
    const runUpdate = db.updated.find((row) => row.table === workflowRun);
    expect(runUpdate?.values).toEqual({ status: "failed" });
  });

  // Same class of bug as the `sendRunGrants` case above, but for the
  // other post-deploy step: `markRunDeployClone` runs after the live
  // deploy resolves too, so a plain `Error` out of it must be treated as
  // a leaked deploy for the same reason.
  test("marks the run failed (not deleted) when markRunDeployClone fails after a successful deploy", async () => {
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };

    // A second definition read that differs from the first is what makes
    // `markRunDeployClone` attempt the `workflowDefinition` update at all
    // (see `createFakeDb`'s own doc) — that update is the call this test
    // makes fail.
    const db = createFakeDb("ast_definition1", [
      "wfd_definition1",
      "wfd_definition1_clone",
    ]);
    const originalUpdate = db.update.bind(db);
    db.update = ((table: unknown) => {
      if (table === workflowDefinition) {
        throw new Error("clone marking failed");
      }
      return originalUpdate(table);
    }) as typeof db.update;
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();

    await expect(
      launchFoldedRun(
        {
          db: db as never,
          sessionService,
          assetService: createFakeAssetService(),
          sidecarRouter: createFakeSidecarRouter(),
          toolGrantsForPins: () => [],
          eventCollectors,
        },
        {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
          triggerAddress: "ins_workbench1@ten1.workbench.test",
          definitionId: "wfd_workbench1",
          foldedBody: FOLDED_BODY,
          launchLabel: "the workbench host",
        },
      ),
    ).rejects.toThrow(SessionLaunchError);

    expect(db.deleted).toEqual([]);
    const runUpdate = db.updated.find((row) => row.table === workflowRun);
    expect(runUpdate?.values).toEqual({ status: "failed" });
  });

  test("throws InferenceResolutionError when the tenant catalog has no launchable source", async () => {
    resolveDefinitionSourcesResult = {
      ok: false,
      message: 'No launchable inference source for model "claude-sonnet-5"',
    };

    const db = createFakeDb();

    let caught: unknown;
    try {
      await launchFoldedRun(
        {
          db: db as never,
          sessionService: createFakeSessionService(),
          assetService: createFakeAssetService(),
          sidecarRouter: createFakeSidecarRouter(),
          toolGrantsForPins: () => [],
          eventCollectors: createFakeEventCollectors(),
        },
        {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
          triggerAddress: "ins_workbench1@ten1.workbench.test",
          definitionId: "wfd_workbench1",
          foldedBody: FOLDED_BODY,
          launchLabel: "the workbench host",
        },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InferenceResolutionError);
    const err = caught as { resolutionMessage: string; message: string };
    expect(err.resolutionMessage).toBe(
      'No launchable inference source for model "claude-sonnet-5"',
    );
    expect(err.message).toMatch(/seed a tenant catalog source/);
    expect(err.message).toMatch(/the workbench host/);
  });

  // The reproduction this fixes: a definition pinned to a model from a
  // provider the tenant has since disconnected (or one baked in before
  // any provider was connected at all) must not stay permanently dead
  // once a DIFFERENT provider is connected. `deployAtHead` retries once
  // against `fallbackModel` — the tenant's current live default — when
  // the definition's own pinned model fails to resolve.
  test("retries against fallbackModel when the definition's pinned model has no launchable source", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesQueue = [
      {
        ok: false,
        message: 'No launchable inference source for model "claude-sonnet-5"',
      },
      {
        ok: true,
        sources: [
          {
            id: "off_ollama",
            provider: "ollama",
            baseURL: "https://home-mac-studio.tail87f5aa.ts.net/v1",
            apiKey: "placeholder",
            model: "gpt-oss:20b",
          },
        ],
        defaultSource: "off_ollama",
      },
    ];

    const db = createFakeDb();
    const sessionService = createFakeSessionService();

    const result = await launchFoldedRun(
      {
        db: db as never,
        sessionService,
        assetService: createFakeAssetService(),
        sidecarRouter: createFakeSidecarRouter(),
        toolGrantsForPins: () => [],
        eventCollectors: createFakeEventCollectors(),
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_workbench1",
        triggerAddress: "ins_workbench1@ten1.workbench.test",
        definitionId: "wfd_workbench1",
        // Pinned to a model the tenant no longer (or never did) has a
        // credential for.
        foldedBody: FOLDED_BODY,
        launchLabel: "the workbench host",
        // The tenant's current live default, e.g. the connected Ollama
        // instance's own resolved model.
        fallbackModel: "gpt-oss:20b",
      },
    );

    expect(result.sessionId).toBeTruthy();
    expect(resolveDefinitionSourcesCalls).toHaveLength(2);
    expect(resolveDefinitionSourcesCalls[0]).toMatchObject({
      fallbackModel: "claude-sonnet-5",
    });
    expect(resolveDefinitionSourcesCalls[1]).toMatchObject({
      fallbackModel: "gpt-oss:20b",
    });

    const deployed = onlyCall(sessionService.adoptedDeployCalls);
    expect(deployed.config.defaultSource).toBe("off_ollama");
  });

  test("does not retry when fallbackModel is absent or matches the definition's own pinned model", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesQueue = [];
    resolveDefinitionSourcesResult = {
      ok: false,
      message: 'No launchable inference source for model "claude-sonnet-5"',
    };

    const db = createFakeDb();
    let caught: unknown;
    try {
      await launchFoldedRun(
        {
          db: db as never,
          sessionService: createFakeSessionService(),
          assetService: createFakeAssetService(),
          sidecarRouter: createFakeSidecarRouter(),
          toolGrantsForPins: () => [],
          eventCollectors: createFakeEventCollectors(),
        },
        {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
          triggerAddress: "ins_workbench1@ten1.workbench.test",
          definitionId: "wfd_workbench1",
          foldedBody: FOLDED_BODY,
          launchLabel: "the workbench host",
          // Same name as the definition's own pin -- nothing new to try.
          fallbackModel: "claude-sonnet-5",
        },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InferenceResolutionError);
    expect(resolveDefinitionSourcesCalls).toHaveLength(1);
  });

  test("uses a caller-supplied sources override verbatim, never touching the catalog", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    // Forced to fail if ever consulted: proves the override path skips
    // `resolveDefinitionSources` entirely, not merely that it happens
    // to succeed against it.
    resolveDefinitionSourcesResult = {
      ok: false,
      message: "the catalog must not be consulted when an override is given",
    };
    listVisibleOfferingsCalls.length = 0;

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();

    const override = {
      sources: [
        {
          id: "noop",
          provider: "anthropic",
          baseURL: "https://hub.invalid/api/chat/noop-inference",
          apiKey: "noop",
          model: "noop",
        },
      ],
      defaultSource: "noop",
    };

    const result = await launchFoldedRun(
      {
        db: db as never,
        sessionService,
        assetService: createFakeAssetService(),
        sidecarRouter: createFakeSidecarRouter(),
        toolGrantsForPins: () => [],
        eventCollectors,
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_workbench1",
        triggerAddress: "ins_workbench1@ten1.workbench.test",
        definitionId: "wfd_workbench1",
        foldedBody: FOLDED_BODY,
        launchLabel: "the workbench host",
        sources: override,
      },
    );

    expect(result.sessionId).toBeTruthy();
    expect(resolveDefinitionSourcesCalls).toHaveLength(0);
    expect(listVisibleOfferingsCalls).toHaveLength(0);
    expect(sessionService.adoptedDeployCalls).toHaveLength(1);
    const deployed = sessionService.adoptedDeployCalls[0] as {
      config: { sources: unknown[]; defaultSource: string };
    };
    expect(deployed.config.sources).toEqual(override.sources);
    expect(deployed.config.defaultSource).toBe("noop");
  });

  test("fails loud on a malformed sources override rather than reaching deployInstanceAtHead", async () => {
    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();

    await expect(
      launchFoldedRun(
        {
          db: db as never,
          sessionService,
          assetService: createFakeAssetService(),
          sidecarRouter: createFakeSidecarRouter(),
          toolGrantsForPins: () => [],
          eventCollectors,
        },
        {
          tenantId: "ten_1",
          instanceId: "ins_workbench1",
          triggerAddress: "ins_workbench1@ten1.workbench.test",
          definitionId: "wfd_workbench1",
          foldedBody: FOLDED_BODY,
          launchLabel: "the workbench host",
          // Missing `apiKey`/`model` on the source: malformed.
          sources: {
            sources: [{ id: "noop", provider: "anthropic" }] as never,
            defaultSource: "noop",
          },
        },
      ),
    ).rejects.toThrow(/invalid inference sources override/);

    expect(sessionService.adoptedDeployCalls).toHaveLength(0);
  });
});

describe("wakeFoldedRun", () => {
  test("clears the instance's stale session_asset manifest rows before redeploying the same instance id", async () => {
    // A wake redeploys the SAME instance id; the platform's ordinary
    // launch reserves one session_asset row per (instance, mount path)
    // with no conflict handling, so the previous occurrence's rows must
    // go first or the redeploy dies on the primary key.
    const db = createFakeDb();
    // Two reads share `select`: the session lookup (`.where().orderBy()`)
    // and `deployAtHead`'s definition-asset join (`.innerJoin()`).
    const dbWithSelect = Object.assign(db, {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ assetId: "ast_definition1" }]),
            }),
          }),
          where: () => ({
            orderBy: () => ({
              limit: () => Promise.resolve([{ id: "ses_1" }]),
            }),
          }),
        }),
      }),
    });
    const sessionService = createFakeSessionService();
    await wakeFoldedRun(
      {
        db: dbWithSelect as never,
        sessionService,
        assetService: createFakeAssetService(),
        sidecarRouter: createFakeSidecarRouter(),
        eventCollectors: createFakeEventCollectors(),
        credentialCipher: {} as never,
        toolGrantsForPins: () => [],
      } as never,
      {
        tenantId: "ten_1",
        instanceId: "run_1",
        triggerAddress: "run_1@acme.test",
        principalId: "prn_1",
        foldedBody: FOLDED_BODY,
        sources: {
          sources: [
            {
              id: "off_1",
              provider: "anthropic",
              baseURL: "https://inference.invalid",
              apiKey: "placeholder",
              model: "claude-sonnet-5",
            },
          ],
          defaultSource: "off_1",
        },
      },
    );
    expect(db.deleted.map((d) => d.table)).toContain(sessionAsset);
    expect(sessionService.adoptedDeployCalls).toHaveLength(1);
  });
});

describe("deployAtHead — mcp credential bindings", () => {
  const MCP_BINDING = {
    package: "@corbits/mcp-tools",
    handle: "mcp.exa",
    provider: "mcp:exa",
    locator: "tenant" as const,
  };

  test("fetches and delivers the tenant's mcp bindings when @corbits/mcp-tools is pinned", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };
    buildCredentialDeliveryCalls.length = 0;
    buildCredentialDeliveryResult = {
      ok: true,
      delivery: {
        bindings: [
          {
            handle: "mcp.exa",
            credentialId: "cred_1",
            consumer: "tool:@corbits/mcp-tools",
          },
        ],
        materials: [
          {
            credentialId: "cred_1",
            providerKey: "mcp",
            origin: "https://mcp.exa.ai/mcp",
            secret: "n/a",
          },
        ],
      },
    };

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const assetService = createFakeAssetService();
    const eventCollectors = createFakeEventCollectors();
    const mcpCredentialBindingsForCalls: string[] = [];

    await deployAtHead(
      {
        db: db as never,
        sidecarRouter: createFakeSidecarRouter(),
        assetService,
        sessionService,
        eventCollectors,
        credentialCipher: {} as never,
        toolGrantsForPins: () => [],
        mcpCredentialBindingsFor: async (tenantId: string) => {
          mcpCredentialBindingsForCalls.push(tenantId);
          return [MCP_BINDING];
        },
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_1",
        triggerAddress: "ins_1@ten1.workbench.test",
        principalId: "prn_1",
        sessionId: "ses_1",
        foldedBody: {
          ...FOLDED_BODY,
          toolPackagePins: [{ name: "@corbits/mcp-tools", version: "*" }],
        },
        launchLabel: "myra",
      },
    );

    expect(mcpCredentialBindingsForCalls).toEqual(["ten_1"]);
    expect(buildCredentialDeliveryCalls).toHaveLength(1);
    expect(buildCredentialDeliveryCalls[0]).toMatchObject({
      tenantId: "ten_1",
      bindings: [MCP_BINDING],
    });

    // The deploy front resolves the credential MATERIAL itself from the
    // deployed definition's own bindings, so the cipher — not a
    // pre-built delivery — is what crosses the boundary.
    const deployed = onlyCall(sessionService.adoptedDeployCalls);
    expect(deployed.credentialCipher).toBeDefined();
    expect(deployed.config.grants).toContainEqual(
      expect.objectContaining({
        resource: "credential:cred_1",
        action: "use",
        conditions: { tool: "tool:@corbits/mcp-tools" },
      }),
    );
    // The workflow host derives its per-step consumer bindings from the
    // DEFINITION's own `credentialBindings`, and the definition is now
    // whatever the deployed bytes evaluate to — so the folded-in MCP
    // binding has to be inside the committed tree.
    const entry =
      assetService.populateAssetCalls[0]?.tree.files["workflow.js"] ?? "";
    expect(entryDefinition(entry)["credentialBindings"]).toEqual([MCP_BINDING]);
  });

  test("never calls mcpCredentialBindingsFor when @corbits/mcp-tools is not pinned", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };
    buildCredentialDeliveryCalls.length = 0;
    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const eventCollectors = createFakeEventCollectors();
    let mcpCredentialBindingsForCallCount = 0;

    await deployAtHead(
      {
        db: db as never,
        sidecarRouter: createFakeSidecarRouter(),
        assetService: createFakeAssetService(),
        sessionService,
        eventCollectors,
        credentialCipher: {} as never,
        toolGrantsForPins: () => [],
        mcpCredentialBindingsFor: async () => {
          mcpCredentialBindingsForCallCount += 1;
          return [MCP_BINDING];
        },
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_2",
        triggerAddress: "ins_2@ten1.workbench.test",
        principalId: "prn_2",
        sessionId: "ses_2",
        foldedBody: FOLDED_BODY,
        launchLabel: "myra",
      },
    );

    expect(mcpCredentialBindingsForCallCount).toBe(0);
    expect(buildCredentialDeliveryCalls).toHaveLength(0);
    const deployed = sessionService.adoptedDeployCalls[0] as {
      credentials?: unknown;
    };
    expect(deployed.credentials).toBeUndefined();
  });
});

describe("deployAtHead — pinned-package credential bindings", () => {
  const MANUS_BINDING = {
    package: "@corbits/manus-tools",
    handle: "manus",
    provider: "manus",
    locator: "tenant" as const,
  };

  function catalogSources(): DefinitionSourceResolution {
    return {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };
  }

  test("folds a connected manus binding into delivery and runtimeConfig when manus-tools is pinned", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesResult = catalogSources();
    buildCredentialDeliveryCalls.length = 0;
    buildCredentialDeliveryResult = {
      ok: true,
      delivery: {
        bindings: [
          {
            handle: "manus",
            credentialId: "cred_manus_1",
            consumer: "tool:@corbits/manus-tools",
          },
        ],
        materials: [
          {
            credentialId: "cred_manus_1",
            providerKey: "manus",
            origin: "https://api.manus.ai",
            secret: "n/a",
          },
        ],
      },
    };

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const assetService = createFakeAssetService();
    const eventCollectors = createFakeEventCollectors();
    const pinnedPackageCalls: { tenantId: string; pins: unknown }[] = [];

    await deployAtHead(
      {
        db: db as never,
        sidecarRouter: createFakeSidecarRouter(),
        assetService,
        sessionService,
        eventCollectors,
        credentialCipher: {} as never,
        toolGrantsForPins: () => [],
        pinnedPackageCredentialBindingsFor: async (tenantId, pins) => {
          pinnedPackageCalls.push({ tenantId, pins });
          return [MANUS_BINDING];
        },
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_1",
        triggerAddress: "ins_1@ten1.workbench.test",
        principalId: "prn_1",
        sessionId: "ses_1",
        foldedBody: {
          ...FOLDED_BODY,
          toolPackagePins: [{ name: "@corbits/manus-tools", version: "*" }],
        },
        launchLabel: "myra",
      },
    );

    expect(pinnedPackageCalls).toEqual([
      {
        tenantId: "ten_1",
        pins: [{ name: "@corbits/manus-tools", version: "*" }],
      },
    ]);
    expect(buildCredentialDeliveryCalls).toHaveLength(1);
    expect(buildCredentialDeliveryCalls[0]).toMatchObject({
      tenantId: "ten_1",
      bindings: [MANUS_BINDING],
    });

    const deployed = onlyCall(sessionService.adoptedDeployCalls);
    expect(deployed.credentialCipher).toBeDefined();
    expect(deployed.config.grants).toContainEqual(
      expect.objectContaining({
        resource: "credential:cred_manus_1",
        action: "use",
        conditions: { tool: "tool:@corbits/manus-tools" },
      }),
    );
    const entry =
      assetService.populateAssetCalls[0]?.tree.files["workflow.js"] ?? "";
    expect(entryDefinition(entry)["credentialBindings"]).toEqual([
      MANUS_BINDING,
    ]);
  });

  test("succeeds with no manus binding when the port returns none", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesResult = catalogSources();
    buildCredentialDeliveryCalls.length = 0;

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const assetService = createFakeAssetService();
    const eventCollectors = createFakeEventCollectors();

    await deployAtHead(
      {
        db: db as never,
        sidecarRouter: createFakeSidecarRouter(),
        assetService,
        sessionService,
        eventCollectors,
        credentialCipher: {} as never,
        toolGrantsForPins: () => [],
        pinnedPackageCredentialBindingsFor: async () => [],
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_2",
        triggerAddress: "ins_2@ten1.workbench.test",
        principalId: "prn_2",
        sessionId: "ses_2",
        foldedBody: {
          ...FOLDED_BODY,
          toolPackagePins: [{ name: "@corbits/manus-tools", version: "*" }],
        },
        launchLabel: "myra",
      },
    );

    expect(buildCredentialDeliveryCalls).toHaveLength(0);
    const deployed = sessionService.adoptedDeployCalls[0] as {
      credentials?: unknown;
    };
    expect(deployed.credentials).toBeUndefined();
    const entry =
      assetService.populateAssetCalls[0]?.tree.files["workflow.js"] ?? "";
    expect(entryDefinition(entry)["credentialBindings"] ?? []).toEqual([]);
  });

  test("does not add a manus binding when manus-tools is not pinned", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesResult = catalogSources();
    buildCredentialDeliveryCalls.length = 0;
    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const assetService = createFakeAssetService();
    const eventCollectors = createFakeEventCollectors();
    const pinnedPackageCalls: { tenantId: string; pins: unknown }[] = [];

    await deployAtHead(
      {
        db: db as never,
        sidecarRouter: createFakeSidecarRouter(),
        assetService,
        sessionService,
        eventCollectors,
        credentialCipher: {} as never,
        toolGrantsForPins: () => [],
        pinnedPackageCredentialBindingsFor: async (tenantId, pins) => {
          pinnedPackageCalls.push({ tenantId, pins });
          return [];
        },
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_3",
        triggerAddress: "ins_3@ten1.workbench.test",
        principalId: "prn_3",
        sessionId: "ses_3",
        foldedBody: FOLDED_BODY,
        launchLabel: "myra",
      },
    );

    expect(pinnedPackageCalls).toEqual([
      { tenantId: "ten_1", pins: FOLDED_BODY.toolPackagePins },
    ]);
    expect(buildCredentialDeliveryCalls).toHaveLength(0);
    const entry =
      assetService.populateAssetCalls[0]?.tree.files["workflow.js"] ?? "";
    expect(entryDefinition(entry)["credentialBindings"] ?? []).toEqual([]);
  });

  test("skips a pinned-package handle the definition already binds", async () => {
    resolveDefinitionSourcesCalls.length = 0;
    resolveDefinitionSourcesResult = catalogSources();
    buildCredentialDeliveryCalls.length = 0;
    buildCredentialDeliveryResult = {
      ok: true,
      delivery: {
        bindings: [
          {
            handle: "manus",
            credentialId: "cred_manus_1",
            consumer: "tool:@corbits/manus-tools",
          },
        ],
        materials: [
          {
            credentialId: "cred_manus_1",
            providerKey: "manus",
            origin: "https://api.manus.ai",
            secret: "n/a",
          },
        ],
      },
    };

    const db = createFakeDb();
    const sessionService = createFakeSessionService();
    const assetService = createFakeAssetService();
    const eventCollectors = createFakeEventCollectors();

    await deployAtHead(
      {
        db: db as never,
        sidecarRouter: createFakeSidecarRouter(),
        assetService,
        sessionService,
        eventCollectors,
        credentialCipher: {} as never,
        toolGrantsForPins: () => [],
        pinnedPackageCredentialBindingsFor: async () => [MANUS_BINDING],
      },
      {
        tenantId: "ten_1",
        instanceId: "ins_4",
        triggerAddress: "ins_4@ten1.workbench.test",
        principalId: "prn_4",
        sessionId: "ses_4",
        foldedBody: {
          ...FOLDED_BODY,
          toolPackagePins: [{ name: "@corbits/manus-tools", version: "*" }],
          credentialBindings: [MANUS_BINDING],
        },
        launchLabel: "myra",
      },
    );

    expect(buildCredentialDeliveryCalls).toHaveLength(1);
    expect(buildCredentialDeliveryCalls[0]).toMatchObject({
      bindings: [MANUS_BINDING],
    });
    const entry =
      assetService.populateAssetCalls[0]?.tree.files["workflow.js"] ?? "";
    expect(entryDefinition(entry)["credentialBindings"]).toEqual([
      MANUS_BINDING,
    ]);
  });
});

// CL-6452: a folded run's deployed bytes carry per-run values, so their
// wire hash is unique to the run and the deploy's freeze ensures a fresh
// definition row over the agent's asset, then repoints the run at it.
// That row is a frozen deploy record — marking it keeps it out of the
// candidate set a launch resolves over, so the agent's own definition
// (the one an instructions save or skill pin refreezes in place) is what
// every later launch reads.
describe("deployAtHead — per-run definition records", () => {
  const SOURCES = {
    ok: true as const,
    sources: [
      {
        id: "off_1",
        provider: "anthropic",
        baseURL: "https://inference.invalid",
        apiKey: "placeholder",
        model: "claude-sonnet-5",
      },
    ],
    defaultSource: "off_1",
  };

  const PARAMS = {
    tenantId: "ten_1",
    instanceId: "run_origin1",
    triggerAddress: "run_origin1@ten1.workbench.test",
    principalId: "prn_1",
    sessionId: "ses_1",
    foldedBody: FOLDED_BODY,
    launchLabel: "the invited agent",
  };

  function makeDeps(db: ReturnType<typeof createFakeDb>) {
    return {
      db: db as never,
      sessionService: createFakeSessionService(),
      assetService: createFakeAssetService(),
      sidecarRouter: createFakeSidecarRouter(),
      eventCollectors: createFakeEventCollectors(),
      toolGrantsForPins: () => [],
    };
  }

  test("marks the row the deploy repointed the run at as a per-run record", async () => {
    resolveDefinitionSourcesResult = SOURCES;
    // The deploy minted a fresh definition for this run's bytes and
    // repointed the run at it.
    const db = createFakeDb("ast_agent", ["wfd_authored", "wfd_run_clone"]);

    await deployAtHead(makeDeps(db), PARAMS);

    const originUpdate = db.updated.find(
      (row) => (row.values as { origin?: string }).origin !== undefined,
    );
    expect(originUpdate?.values).toEqual({ origin: "run" });
  });

  test("never demotes the agent's own definition when the deploy left the run on it", async () => {
    resolveDefinitionSourcesResult = SOURCES;
    const db = createFakeDb("ast_agent", ["wfd_authored", "wfd_authored"]);

    await deployAtHead(makeDeps(db), PARAMS);

    expect(
      db.updated.find(
        (row) => (row.values as { origin?: string }).origin !== undefined,
      ),
    ).toBeUndefined();
  });
});

describe("deployAtHead — run.grants production", () => {
  const SOURCES = {
    ok: true as const,
    sources: [
      {
        id: "off_1",
        provider: "anthropic",
        baseURL: "https://inference.invalid",
        apiKey: "placeholder",
        model: "claude-sonnet-5",
      },
    ],
    defaultSource: "off_1",
  };

  const PIN = {
    name: "@corbits/mcp-tools",
    version: "1.0.0",
    integrity: "sha512-deadbeef",
    registry: "https://registry.invalid",
  };

  function makeDeps(sidecarRouter: ReturnType<typeof createFakeSidecarRouter>) {
    return {
      db: createFakeDb() as never,
      sessionService: createFakeSessionService(),
      assetService: createFakeAssetService(),
      sidecarRouter,
      eventCollectors: createFakeEventCollectors(),
      toolGrantsForPins: () => [
        {
          resource: "tool:@corbits/mcp-tools:search",
          action: "invoke" as const,
          effect: "allow" as const,
        },
      ],
    };
  }

  const PARAMS = {
    tenantId: "ten_1",
    instanceId: "run_grants1",
    triggerAddress: "run_grants1@ten1.workbench.test",
    principalId: "prn_1",
    sessionId: "ses_1",
    foldedBody: { ...FOLDED_BODY, toolPackagePins: [PIN] },
    launchLabel: "the workbench host",
  };

  test("sends the run's grants frame for its own self-anchored run id", async () => {
    resolveDefinitionSourcesResult = SOURCES;
    const sidecarRouter = createFakeSidecarRouter();

    await deployAtHead(makeDeps(sidecarRouter), PARAMS);

    expect(sidecarRouter.runGrantsCalls).toHaveLength(1);
    const [call] = sidecarRouter.runGrantsCalls;
    expect(call?.agentAddress).toBe(PARAMS.triggerAddress);
    // A folded run is self-anchored: its run id IS its deployment id.
    expect(call?.runId).toBe(PARAMS.instanceId);
    expect(call?.stepGrants).toEqual([
      expect.objectContaining({
        resource: "tool:@corbits/mcp-tools:search",
        action: "invoke",
        effect: "allow",
        principalId: PARAMS.principalId,
      }),
    ]);
  });

  test("ships the same grant set the deploy carries as config.grants", async () => {
    resolveDefinitionSourcesResult = SOURCES;
    const sidecarRouter = createFakeSidecarRouter();
    const deps = makeDeps(sidecarRouter);

    await deployAtHead(deps, PARAMS);

    const deployed = onlyCall(deps.sessionService.adoptedDeployCalls);
    expect(sidecarRouter.runGrantsCalls[0]?.stepGrants).toEqual(
      deployed.config.grants,
    );
  });

  test("throws when the deployment address is not routable for the frame", async () => {
    resolveDefinitionSourcesResult = SOURCES;
    const sidecarRouter = createFakeSidecarRouter(false);

    await expect(deployAtHead(makeDeps(sidecarRouter), PARAMS)).rejects.toThrow(
      /is not routable for run run_grants1/,
    );
  });
});

// The whole conversion in one test: under the workflow.json retirement a
// folded run's definition is no longer synthesized in memory and handed
// to the hub — it is RENDERED into a per-run source package, COMMITTED
// into the run's own definition asset, and DEPLOYED by pinning that
// commit onto the anchor row the run already owns.
describe("deployAtHead — the code-sourced round trip", () => {
  const SOURCES: DefinitionSourceResolution = {
    ok: true,
    sources: [
      {
        id: "off_1",
        provider: "anthropic",
        baseURL: "https://inference.invalid",
        apiKey: "placeholder",
        model: "claude-sonnet-5",
      },
    ],
    defaultSource: "off_1",
  };

  const PARAMS = {
    tenantId: "ten_1",
    instanceId: "run_rt1",
    triggerAddress: "run_rt1@ten1.workbench.test",
    principalId: "prn_1",
    sessionId: "ses_1",
    foldedBody: {
      ...FOLDED_BODY,
      systemPrompt: "you answer questions",
      toolPackagePins: [{ name: "@corbits/mcp-tools", version: "*" }],
    },
    launchLabel: "the invited agent",
  };

  function makeDeps() {
    return {
      db: createFakeDb() as never,
      sessionService: createFakeSessionService(),
      assetService: createFakeAssetService(),
      sidecarRouter: createFakeSidecarRouter(),
      eventCollectors: createFakeEventCollectors(),
      toolGrantsForPins: () => [],
    };
  }

  test("commits the rendered tree into the run's own definition asset", async () => {
    resolveDefinitionSourcesResult = SOURCES;
    const deps = makeDeps();

    await deployAtHead(deps, PARAMS);

    expect(deps.assetService.populateAssetCalls).toHaveLength(1);
    const commit = onlyCall(deps.assetService.populateAssetCalls);
    // Reuse, not a second asset: the tree lands in the asset the run's
    // definition already points at, on a ref of its own so one asset can
    // back many runs without their bytes colliding.
    expect(commit.assetId).toBe("ast_definition1");
    expect(commit.ref).toBe("refs/heads/runs/run_rt1");
    expect(Object.keys(commit.tree.files).sort()).toEqual([
      "package.json",
      "workflow.js",
    ]);
  });

  test("renders the run's whole config into the deployed bytes", async () => {
    resolveDefinitionSourcesResult = SOURCES;
    const deps = makeDeps();

    await deployAtHead(deps, PARAMS);

    const files = onlyCall(deps.assetService.populateAssetCalls).tree.files;
    const definition = entryDefinition(files["workflow.js"] ?? "");
    // Every field the approved wire hash covers has to be inside the
    // bytes: anything delivered out of band diverges between the
    // approval probe's evaluation and the run child's and fails closed.
    expect(definition).toMatchObject({
      id: "wf_run_rt1",
      triggers: [{ type: "mail", to: "run_rt1@ten1.workbench.test" }],
      stepOrder: ["default"],
    });
    expect(foldedStep(definition)).toMatchObject({
      kind: "step",
      agent: {
        systemPrompt: "you answer questions",
        inference: {
          sources: [{ provider: "anthropic", model: "claude-sonnet-5" }],
        },
        toolPackagePins: [{ name: "@corbits/mcp-tools", version: "*" }],
      },
    });
    // Dependency-free on purpose: an asset tree is a standalone
    // codebase, so anything the closure would have to resolve against a
    // workspace cannot resolve at all.
    expect(JSON.parse(files["package.json"] ?? "")).not.toHaveProperty(
      "dependencies",
    );
  });

  test("deploys the committed pin through the adopting front", async () => {
    resolveDefinitionSourcesResult = SOURCES;
    const deps = makeDeps();

    await deployAtHead(deps, PARAMS);

    expect(deps.sessionService.adoptedDeployCalls).toHaveLength(1);
    const deployed = onlyCall(deps.sessionService.adoptedDeployCalls);
    expect(deployed).toMatchObject({
      tenantId: "ten_1",
      anchorRunId: "run_rt1",
      deploymentDomain: "ten1.workbench.test",
      agentAddress: "run_rt1@ten1.workbench.test",
      entry: "./workflow.js",
      definitionAssetId: "ast_definition1",
      source: {
        kind: "asset",
        assetId: "ast_definition1",
        package: { format: "source", commitSha: "commit-sha-1" },
      },
    });
  });

  test("carries the caller's section mode into the bytes untouched", async () => {
    resolveDefinitionSourcesResult = SOURCES;
    const deps = makeDeps();

    await deployAtHead(deps, {
      ...PARAMS,
      mode: { kind: "section", turnTimeoutMs: 45_000 },
    });

    const definition = entryDefinition(
      onlyCall(deps.assetService.populateAssetCalls).tree.files[
        "workflow.js"
      ] ?? "",
    );
    // The mode selects the shape at render time, so nothing about the
    // deploy call itself differs between the two: section mode is one
    // `onTrigger` section whose body step carries the caller's timeout.
    expect(definition["stepOrder"]).toEqual(["turn"]);
    expect(at(foldedStep(definition), "kind")).toBe("onTrigger");
    expect(
      at(foldedStep(definition), "body", "inline", "steps", "reply", "timeout"),
    ).toBe(45_000);
    expect(deps.sessionService.adoptedDeployCalls).toHaveLength(1);
  });

  test("refuses a run whose definition has no workflow-kind asset", async () => {
    resolveDefinitionSourcesResult = SOURCES;
    const deps = { ...makeDeps(), db: createFakeDb(null) as never };

    await expect(deployAtHead(deps, PARAMS)).rejects.toThrow(
      /no workflow-kind definition asset/,
    );
    expect(deps.sessionService.adoptedDeployCalls).toEqual([]);
  });
});

describe("wakeFoldedRun — the same code-sourced path", () => {
  test("re-renders and re-commits the run's source tree, then adopts its anchor", async () => {
    resolveDefinitionSourcesResult = {
      ok: true,
      sources: [
        {
          id: "off_1",
          provider: "anthropic",
          baseURL: "https://inference.invalid",
          apiKey: "placeholder",
          model: "claude-sonnet-5",
        },
      ],
      defaultSource: "off_1",
    };
    const db = Object.assign(createFakeDb(), {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ assetId: "ast_definition1" }]),
            }),
          }),
          where: () => ({
            orderBy: () => ({
              limit: () => Promise.resolve([{ id: "ses_1" }]),
            }),
          }),
        }),
      }),
    });
    const sessionService = createFakeSessionService();
    const assetService = createFakeAssetService();

    await wakeFoldedRun(
      {
        db: db as never,
        sessionService,
        assetService,
        sidecarRouter: createFakeSidecarRouter(),
        eventCollectors: createFakeEventCollectors(),
        toolGrantsForPins: () => [],
      } as never,
      {
        tenantId: "ten_1",
        instanceId: "ins_woken1",
        triggerAddress: "ins_woken1@ten1.workbench.test",
        principalId: "prn_1",
        foldedBody: FOLDED_BODY,
        // A wake must repin whatever the launch pinned; the literal
        // input is a property of what the run IS.
        mode: { kind: "step", literalInput: "workbench-host anchor turn" },
      },
    );

    expect(assetService.populateAssetCalls[0]?.ref).toBe(
      "refs/heads/runs/ins_woken1",
    );
    const definition = entryDefinition(
      assetService.populateAssetCalls[0]?.tree.files["workflow.js"] ?? "",
    );
    expect(at(foldedStep(definition), "input")).toEqual({
      literal: "workbench-host anchor turn",
    });
    expect(sessionService.adoptedDeployCalls[0]).toMatchObject({
      anchorRunId: "ins_woken1",
      source: { package: { format: "source", commitSha: "commit-sha-1" } },
    });
  });
});
