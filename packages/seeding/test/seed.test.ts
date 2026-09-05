import { describe, expect, test } from "bun:test";
import { installDisposableHubDataDir } from "../../../test/disposable-hub-data-dir";
import {
  HubApiError,
  isSidecarUnavailableError,
} from "@corbits/hub-api-client";
import {
  CATALOG_TEST_WORKFLOWS,
  CATALOG_WORKFLOWS,
  DEFAULT_WORKFLOWS,
  NOOP_MODEL_SOURCE,
  reconcileSeedGrants,
  SEED_GRANTS,
  seedCatalog,
  seedTenant,
  SETUP_AGENT_ASSET_NAME,
  type SeedTenantArgs,
  type WorkflowPusher,
} from "../src/seed";
import { DEFAULT_SKILLS } from "../src/default-skills";
import { CATALOG_SEEDS } from "../src/catalog-seed-data";
import { OLLAMA_MODEL_DEFAULTS } from "@corbits/inference-catalog/ollama-context-defaults";
import {
  assetRow,
  collector,
  deploymentRow,
  emptyPage,
  fakeAPI,
  pristineScheduledDefinitionHandshake,
  TENANT_DOMAIN,
  TENANT_ID,
  PRINCIPAL_ID,
  type FakeHandler,
} from "./helpers";

installDisposableHubDataDir();

const MODEL = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  baseURL: "https://api.anthropic.com",
  apiKey: "sk-test",
};

const instantSleep = async (_ms: number) => {};

const recordingPusher = () => {
  const pushes: { remoteUrl: string; workflowJson: string }[] = [];
  const push: WorkflowPusher = async (args) => {
    pushes.push({ remoteUrl: args.remoteUrl, workflowJson: args.workflowJson });
    return { outcome: "pushed", commitSha: "a".repeat(40) };
  };
  return { pushes, push };
};

function args(
  overrides: Partial<SeedTenantArgs> & Pick<SeedTenantArgs, "api">,
): SeedTenantArgs {
  const { log } = collector();
  return {
    cookies: ["session=abc"],
    hubUrl: "http://localhost:3000",
    tenant: {
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      domain: TENANT_DOMAIN,
    },
    model: MODEL,
    pushWorkflow: recordingPusher().push,
    log,
    sleep: instantSleep,
    runStartTimeoutMs: 3,
    runPollIntervalMs: 1,
    ...overrides,
  };
}

// Shared routes every seed run makes before touching workflow state:
// planting the seed grants.
function baseRoutes(method: string, path: string) {
  if (method === "GET" && path.startsWith(`/api/tenants/${TENANT_ID}/grants?`))
    return emptyPage();
  if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`)
    return { status: 201, data: {} };
  if (method === "POST" && path === `/api/tenants/${TENANT_ID}/git-tokens`)
    return { status: 201, data: { id: "tok_1", secret: "s3cret" } };
  if (method === "GET" && path.startsWith(`/api/tenants/${TENANT_ID}/skills/`))
    return { status: 404, data: {} };
  if (method === "POST" && path === `/api/tenants/${TENANT_ID}/skills`)
    return { status: 201, data: {} };
  if (
    method === "GET" &&
    path === `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
  )
    return { status: 200, data: [] };
  if (
    method === "GET" &&
    path === `/api/tenants/${TENANT_ID}/workflows/deployments`
  )
    return { status: 200, data: [] };
  const handshake = pristineScheduledDefinitionHandshake(method, path);
  if (handshake) return handshake;
  return undefined;
}

describe("reconcileSeedGrants", () => {
  function grantsAPI(
    granted: () => readonly { resource: string; action: string }[],
    posted: { resource: string; action: string }[],
  ) {
    return fakeAPI((method, path, body) => {
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      ) {
        const resource = new URL(`http://x${path}`).searchParams.get(
          "resource",
        );
        const rows = granted()
          .filter((g) => g.resource === resource)
          .map((g, index) => ({
            id: `grt_${resource}_${index}`,
            tenantId: TENANT_ID,
            principalId: PRINCIPAL_ID,
            resource: g.resource,
            action: g.action,
            effect: "allow" as const,
            origin: "creator" as const,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }));
        return { status: 200, data: { data: rows, nextCursor: null } };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`) {
        const grant = body as { resource: string; action: string };
        posted.push({ resource: grant.resource, action: grant.action });
        return { status: 201, data: {} };
      }
      return undefined;
    });
  }

  test("plants exactly the declared SEED_GRANTS set, nothing more", async () => {
    const posted: { resource: string; action: string }[] = [];
    const api = grantsAPI(() => [], posted);
    const { log } = collector();

    await reconcileSeedGrants(
      api,
      ["session=abc"],
      TENANT_ID,
      PRINCIPAL_ID,
      log,
    );

    expect(posted).toEqual(
      SEED_GRANTS.map((g) => ({ resource: g.resource, action: g.action })),
    );
  });

  test("backfills a grant added to SEED_GRANTS after the tenant was already seeded", async () => {
    // Simulates a tenant provisioned before eval-run:*/read existed
    // (CL-6465): every grant except that one is already planted.
    const alreadyGranted = SEED_GRANTS.filter(
      (g) => !(g.resource === "eval-run:*" && g.action === "read"),
    );
    const posted: { resource: string; action: string }[] = [];
    const api = grantsAPI(() => alreadyGranted, posted);
    const { log } = collector();

    await reconcileSeedGrants(
      api,
      ["session=abc"],
      TENANT_ID,
      PRINCIPAL_ID,
      log,
    );

    expect(posted).toEqual([{ resource: "eval-run:*", action: "read" }]);
  });

  test("reconciling twice never duplicates a grant", async () => {
    const granted: { resource: string; action: string }[] = [];
    const posted: { resource: string; action: string }[] = [];
    const api = grantsAPI(() => granted, posted);
    const { log } = collector();

    await reconcileSeedGrants(
      api,
      ["session=abc"],
      TENANT_ID,
      PRINCIPAL_ID,
      log,
    );
    granted.push(...posted);
    expect(posted).toHaveLength(SEED_GRANTS.length);

    posted.length = 0;
    await reconcileSeedGrants(
      api,
      ["session=abc"],
      TENANT_ID,
      PRINCIPAL_ID,
      log,
    );

    expect(posted).toEqual([]);
  });
});

describe("seedTenant", () => {
  test("fresh run pushes, deploys, and confirms the echo workflow", async () => {
    const { lines, log } = collector();
    const { pushes, push } = recordingPusher();
    let runsCalls = 0;
    const handler: FakeHandler = (method, path, _body) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_1", "echo") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 201,
          data: deploymentRow("dep_1", "ast_1", "deployed"),
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls === 1 ? [] : ["run_1"] },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/mail`
      )
        return {
          status: 202,
          data: {
            runId: "dep_1",
            address: `ins_dep_1@${TENANT_DOMAIN}`,
            messageId: "<m1@workbench.localhost>",
          },
        };
      return undefined;
    };

    const echoOnly = CATALOG_WORKFLOWS.filter((w) => w.assetName === "echo");
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        workflows: echoOnly,
      }),
    );

    expect(pushes).toHaveLength(1);
    const push0 = pushes[0];
    if (!push0) throw new Error("expected one workflow push");
    expect(push0.remoteUrl).toBe(
      `http://localhost:3000/api/tenants/${TENANT_ID}/assets/workflow/echo.git`,
    );
    const definition = JSON.parse(push0.workflowJson) as {
      id: string;
      triggers: { type: string; to: string }[];
      stepOrder: string[];
    };
    expect(definition.id).toBe("wf_echo");
    expect(definition.triggers[0]?.to).toBe(`echo@${TENANT_DOMAIN}`);
    expect(definition.stepOrder).toEqual(["echo"]);

    const output = lines.join("\n");
    expect(output).toContain("created workflow asset echo");
    expect(output).toContain("deployed workflow echo as dep_1");
    expect(output).toContain("confirmed workflow echo: run run_1 started");
    expect(output).toContain("seed complete: 1 workflow(s)");
  });

  // CL-6465: `@corbits/evals`' read routes (mounted at
  // `/eval-runs/runs` and `/eval-runs/runs/:runId` in the hub) gate on
  // this resource. Without it here, every newly seeded tenant would
  // get a 403 from a UI that lists eval runs.
  test("plants the eval-run:*/read grant", async () => {
    const { log } = collector();
    const { push } = recordingPusher();
    const grantsPosted: { resource: string; action: string }[] = [];
    let runsCalls = 0;
    const handler: FakeHandler = (method, path, body) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`) {
        const grant = body as { resource: string; action: string };
        grantsPosted.push({ resource: grant.resource, action: grant.action });
        return { status: 201, data: {} };
      }
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_1", "echo") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 201,
          data: deploymentRow("dep_1", "ast_1", "deployed"),
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls === 1 ? [] : ["run_1"] },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/mail`
      )
        return {
          status: 202,
          data: {
            runId: "dep_1",
            address: `ins_dep_1@${TENANT_DOMAIN}`,
            messageId: "<m1@workbench.localhost>",
          },
        };
      return undefined;
    };

    const echoOnly = CATALOG_WORKFLOWS.filter((w) => w.assetName === "echo");
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        workflows: echoOnly,
      }),
    );

    expect(grantsPosted).toContainEqual({
      resource: "eval-run:*",
      action: "read",
    });
  });

  test("deploys workflows without publishing the corbits-tools registry", async () => {
    const { pushes, push } = recordingPusher();
    const registryListCalls: string[] = [];
    let runsCalls = 0;
    const handler: FakeHandler = (method, path, _body) => {
      if (
        path.includes("kind=package-registry") ||
        path.includes("/tarballs")
      ) {
        registryListCalls.push(`${method} ${path}`);
      }
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_1", "echo") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 201,
          data: deploymentRow("dep_1", "ast_1", "deployed"),
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls === 1 ? [] : ["run_1"] },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/mail`
      )
        return {
          status: 202,
          data: {
            runId: "dep_1",
            address: `ins_dep_1@${TENANT_DOMAIN}`,
            messageId: "<m1@workbench.localhost>",
          },
        };
      return undefined;
    };

    const echoOnly = CATALOG_WORKFLOWS.filter((w) => w.assetName === "echo");
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        workflows: echoOnly,
      }),
    );

    expect(registryListCalls).toEqual([]);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.remoteUrl).toContain("/echo.git");
  });

  test("fresh run pushes, deploys, and confirms the assistant workflow", async () => {
    const { lines, log } = collector();
    const { pushes, push } = recordingPusher();
    let runsCalls = 0;
    const handler: FakeHandler = (method, path, _body) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_2", "assistant") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 201,
          data: deploymentRow("dep_2", "ast_2", "deployed"),
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_2/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls === 1 ? [] : ["run_1"] },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_2/mail`
      )
        return {
          status: 202,
          data: {
            runId: "dep_2",
            address: `ins_dep_2@${TENANT_DOMAIN}`,
            messageId: "<m4@workbench.localhost>",
          },
        };
      return undefined;
    };

    const assistantOnly = DEFAULT_WORKFLOWS.filter(
      (w) => w.assetName === "assistant",
    );
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        workflows: assistantOnly,
      }),
    );

    expect(pushes).toHaveLength(1);
    const push0 = pushes[0];
    if (!push0) throw new Error("expected one workflow push");
    expect(push0.remoteUrl).toBe(
      `http://localhost:3000/api/tenants/${TENANT_ID}/assets/workflow/assistant.git`,
    );
    const definition = JSON.parse(push0.workflowJson) as {
      id: string;
      triggers: { type: string; to: string }[];
      stepOrder: string[];
    };
    expect(definition.id).toBe("wf_assistant");
    expect(definition.triggers[0]?.to).toBe(`assistant@${TENANT_DOMAIN}`);
    expect(definition.stepOrder).toEqual(["assistant"]);

    const output = lines.join("\n");
    expect(output).toContain("created workflow asset assistant (Myra)");
    expect(output).toContain("deployed workflow assistant as dep_2");
    expect(output).toContain("confirmed workflow assistant: run run_1 started");
    expect(output).toContain("seed complete: 1 workflow(s)");
  });

  test("re-run skips the asset, definition, and deployment but still confirms", async () => {
    const { lines, log } = collector();
    const push: WorkflowPusher = async () => ({
      outcome: "unchanged" as const,
      commitSha: "b".repeat(40),
    });
    let runsCalls = 0;
    const handler: FakeHandler = (method, path) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 409, data: { error: "name taken" } };
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      )
        return {
          status: 200,
          data: [
            {
              ...assetRow("ast_1", "echo"),
              origin: { tenantId: TENANT_ID, direct: true },
            },
          ],
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 200,
          data: [deploymentRow("dep_1", "ast_1", "deployed")],
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/runs/dep_1/health`
      )
        return {
          status: 200,
          data: { liveness: "ok", readiness: "ok", lastCheckedAt: null },
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls === 1 ? ["run_1"] : ["run_1", "run_2"] },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/mail`
      )
        return {
          status: 202,
          data: {
            runId: "dep_1",
            address: `ins_dep_1@${TENANT_DOMAIN}`,
            messageId: "<m2@workbench.localhost>",
          },
        };
      return baseRoutes(method, path);
    };

    const echoOnly = CATALOG_WORKFLOWS.filter((w) => w.assetName === "echo");
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        workflows: echoOnly,
      }),
    );

    const output = lines.join("\n");
    expect(output).toContain("workflow asset echo already exists (skipped)");
    expect(output).toContain(
      "workflow source for echo already current (skipped)",
    );
    expect(output).toContain(
      "workflow echo already deployed as dep_1 (skipped)",
    );
    expect(output).toContain("confirmed workflow echo: run run_2 started");
  });

  test("a deployment orphaned by a stack restart is redeployed, not skipped", async () => {
    const { lines, log } = collector();
    const push: WorkflowPusher = async () => ({
      outcome: "unchanged" as const,
      commitSha: "b".repeat(40),
    });
    let runsCalls = 0;
    const handler: FakeHandler = (method, path) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 409, data: { error: "name taken" } };
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      )
        return {
          status: 200,
          data: [
            {
              ...assetRow("ast_1", "echo"),
              origin: { tenantId: TENANT_ID, direct: true },
            },
          ],
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 200,
          // dep_1 is a survivor from before the stack restarted: its
          // workflow_run row still reads "deployed", but no sidecar
          // owns its address anymore.
          data: [deploymentRow("dep_1", "ast_1", "deployed")],
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/runs/dep_1/health`
      )
        return {
          status: 200,
          data: {
            liveness: "unhealthy",
            readiness: "not_ready",
            lastCheckedAt: null,
          },
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 201,
          data: deploymentRow("dep_2", "ast_1", "deployed"),
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_2/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls === 1 ? [] : ["run_1"] },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_2/mail`
      )
        return {
          status: 202,
          data: {
            runId: "dep_2",
            address: `ins_dep_2@${TENANT_DOMAIN}`,
            messageId: "<m3@workbench.localhost>",
          },
        };
      return baseRoutes(method, path);
    };

    const echoOnly = CATALOG_WORKFLOWS.filter((w) => w.assetName === "echo");
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        workflows: echoOnly,
      }),
    );

    const output = lines.join("\n");
    expect(output).toContain(
      "workflow echo's deployment dep_1 is stale (its sidecar is gone); redeploying",
    );
    expect(output).toContain("deployed workflow echo as dep_2");
    expect(output).toContain("confirmed workflow echo: run run_1 started");
    expect(output).not.toContain("not routable");
  });

  test("an unreachable deployment address names the sidecar as the fix", async () => {
    const handler: FakeHandler = (method, path) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_1", "echo") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 201,
          data: deploymentRow("dep_1", "ast_1", "deployed"),
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/runs`
      )
        return { status: 200, data: { runIds: [] } };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/mail`
      )
        return {
          status: 409,
          data: { error: { code: "deployment_unreachable" } },
        };
      return undefined;
    };

    let caught: unknown;
    try {
      await seedTenant(args({ api: fakeAPI(handler) }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HubApiError);
    expect((caught as HubApiError).message).toContain("not routable");
    expect((caught as HubApiError).fix).toContain("sidecar");
  });

  test("a deploy that succeeds but never starts a run is a failure, not a success", async () => {
    const handler: FakeHandler = (method, path) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_1", "echo") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 201,
          data: deploymentRow("dep_1", "ast_1", "deployed"),
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/runs`
      )
        return { status: 200, data: { runIds: [] } };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_1/mail`
      )
        return {
          status: 202,
          data: {
            runId: "dep_1",
            address: `ins_dep_1@${TENANT_DOMAIN}`,
            messageId: "<m3@workbench.localhost>",
          },
        };
      return undefined;
    };

    expect(seedTenant(args({ api: fakeAPI(handler) }))).rejects.toThrow(
      /no run started/,
    );
  });

  test("a sidecar-unavailable deploy fails with the start-the-stack fix", async () => {
    const handler: FakeHandler = (method, path) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_1", "echo") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 502,
          data: { error: { code: "sidecar_unavailable" } },
        };
      return undefined;
    };

    let caught: unknown;
    try {
      await seedTenant(args({ api: fakeAPI(handler) }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HubApiError);
    expect((caught as HubApiError).fix).toContain("bun run dev");
    // Onboarding's `ensureSeeded` parses this exact class to finish the
    // request successfully with a partial-seed report, rather than
    // failing the whole onboarding flow the way a generic `HubApiError`
    // still does — the 409/not-routable case above stays a plain
    // `HubApiError` on purpose, since only this 502 branch is the "durable
    // state intact, sidecar just isn't up yet" condition onboarding
    // recovers from.
    expect(isSidecarUnavailableError(caught)).toBe(true);
  });

  test("an empty default workflow set is an error", async () => {
    const api = fakeAPI(() => {
      throw new Error("no hub call should happen for an empty set");
    });
    expect(seedTenant(args({ api, workflows: [] }))).rejects.toThrow(
      /zero workflows/,
    );
  });

  test("the default set is non-empty and leads with the setup agent", () => {
    // CL-6462: the one agent a person talks to deploys before anything
    // else, so a fresh signup can start the moment she is live instead
    // of waiting out the whole set.
    expect(DEFAULT_WORKFLOWS.length).toBeGreaterThan(0);
    expect(DEFAULT_WORKFLOWS[0]?.assetName).toBe(SETUP_AGENT_ASSET_NAME);
  });

  test("the default set is Myra only; echo is deployed on demand from the catalog", () => {
    // CL-7074: a fresh signup no longer pays a git push and sidecar
    // probe for workflows nobody asked for.
    expect(DEFAULT_WORKFLOWS.map((w) => w.assetName)).toEqual(["assistant"]);
    expect(CATALOG_WORKFLOWS.map((w) => w.assetName)).toContain("echo");
  });

  test("the seeded assistant is productized under the Myra display name", () => {
    // Every personal bench provisioning deploys DEFAULT_WORKFLOWS, which
    // includes the assistant. Its display name is the productized label
    // Myra — seed stamps it onto the asset at create time, so the seeded
    // assistant surfaces as Myra rather than the generic "Assistant".
    const assistant = DEFAULT_WORKFLOWS.find(
      (w) => w.assetName === "assistant",
    );
    expect(assistant).toBeDefined();
    expect(assistant?.displayName).toBe("Myra");
  });

  test("NOOP_MODEL_SOURCE resolves to the hub's own noop-inference endpoint", () => {
    const resolved = NOOP_MODEL_SOURCE("http://localhost:3000");
    expect(resolved.baseURL).toBe(
      "http://localhost:3000/api/chat/noop-inference",
    );
    expect(resolved.model).toBe("noop");
  });

  test("echo and assistant carry no modelSource override, so they deploy against the tenant's real model", () => {
    const realModelWorkflows = [
      ...CATALOG_WORKFLOWS,
      ...DEFAULT_WORKFLOWS,
    ].filter((w) => w.assetName === "echo" || w.assetName === "assistant");
    expect(realModelWorkflows).toHaveLength(2);
    for (const workflow of realModelWorkflows) {
      expect(workflow.modelSource).toBeUndefined();
    }
  });

  test("the default set consumed by real tenant provisioning is assistant only; every other workflows/ source package is an on-demand catalog entry", () => {
    // provisionPersonalTenantIfNeeded (@workbench/onboarding) deploys
    // DEFAULT_WORKFLOWS for every real signup (CL-7074: Myra only). Every
    // other workflows/<name> source package with a builder — echo,
    // workbench-digest, last-30-days-research, code-review, granola-call,
    // morning-brief, exa-topic-watch, process-granola-call,
    // attio-task-agent, pain-point-collateral,
    // reddit-opportunity-scanner, collateral-generation, diligence-brief
    // — deploys on demand (CL-7073) from CATALOG_WORKFLOWS, never
    // automatically onto a real signup. The catalog-test workflows exist
    // only to exercise the platform continuously and must never reach a
    // real user through either array — they are seeded only via the
    // explicit CATALOG_TEST_WORKFLOWS opt-in.
    expect(DEFAULT_WORKFLOWS.map((w) => w.assetName)).toEqual(["assistant"]);
    expect(CATALOG_WORKFLOWS.map((w) => w.assetName)).toEqual([
      "echo",
      "workbench-digest",
      "last-30-days-research",
      "code-review",
      "granola-call",
      "morning-brief",
      "exa-topic-watch",
      "process-granola-call",
      "attio-task-agent",
      "pain-point-collateral",
      "reddit-opportunity-scanner",
      "collateral-generation",
      "diligence-brief",
    ]);
  });

  test("catalog-test workflows declare a modelSource override; defaults and on-demand catalog workflows do not", () => {
    // Defaults (assistant) and the on-demand catalog (echo,
    // workbench-digest, last-30-days-research) deploy against the
    // tenant's real model. Catalog-test entries stay free via
    // NOOP_MODEL_SOURCE.
    for (const workflow of [...DEFAULT_WORKFLOWS, ...CATALOG_WORKFLOWS]) {
      expect(workflow.modelSource).toBeUndefined();
    }
    for (const workflow of CATALOG_TEST_WORKFLOWS) {
      expect(workflow.modelSource).toBeDefined();
    }
  });

  test("the catalog-test set includes the heartbeat workflow", () => {
    expect(CATALOG_TEST_WORKFLOWS.map((w) => w.assetName)).toContain(
      "heartbeat",
    );
  });

  test("heartbeat pins its deploy source at noop-inference, never the tenant's real model", () => {
    const heartbeat = CATALOG_TEST_WORKFLOWS.find(
      (w) => w.assetName === "heartbeat",
    );
    if (!heartbeat) throw new Error("expected the heartbeat workflow");
    const resolved = heartbeat.modelSource?.("http://localhost:3000");
    expect(resolved).toEqual(NOOP_MODEL_SOURCE("http://localhost:3000"));
  });

  test("fresh run pushes, deploys, and confirms the heartbeat workflow against the noop source", async () => {
    const { lines, log } = collector();
    const { pushes, push } = recordingPusher();
    let runsCalls = 0;
    let deployedSources: unknown;
    const handler: FakeHandler = (method, path, body) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_3", "heartbeat") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        deployedSources = body;
        return {
          status: 201,
          data: deploymentRow("dep_3", "ast_3", "deployed"),
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_3/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls === 1 ? [] : ["run_1"] },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_3/mail`
      )
        return {
          status: 202,
          data: {
            runId: "dep_3",
            address: `ins_dep_3@${TENANT_DOMAIN}`,
            messageId: "<m5@workbench.localhost>",
          },
        };
      return undefined;
    };

    const heartbeatOnly = CATALOG_TEST_WORKFLOWS.filter(
      (w) => w.assetName === "heartbeat",
    );
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        workflows: heartbeatOnly,
      }),
    );

    expect(pushes).toHaveLength(1);
    const push0 = pushes[0];
    if (!push0) throw new Error("expected one workflow push");
    const definition = JSON.parse(push0.workflowJson) as {
      id: string;
      triggers: { type: string; to: string }[];
      stepOrder: string[];
    };
    expect(definition.id).toBe("wf_heartbeat");
    expect(definition.triggers[0]?.to).toBe(`heartbeat@${TENANT_DOMAIN}`);
    expect(definition.stepOrder).toEqual(["heartbeat"]);

    // The deploy's own source, not the tenant's real MODEL, is what
    // proves the noop pin took effect: it must name the noop provider
    // fixture, not the ordinary anthropic/claude-sonnet-4-5 model this
    // test file's `args()` helper hands every other workflow.
    const deployedBody = deployedSources as { sources: { model: string }[] };
    expect(deployedBody.sources[0]?.model).toBe("noop");

    const output = lines.join("\n");
    expect(output).toContain("deployed workflow heartbeat as dep_3");
    expect(output).toContain("confirmed workflow heartbeat: run run_1 started");
  });

  test("the on-demand catalog includes the workbench-digest automation", () => {
    expect(CATALOG_WORKFLOWS.map((w) => w.assetName)).toContain(
      "workbench-digest",
    );
  });

  test("workbench-digest is automatable with a friendly display name and no noop pin", () => {
    const workbenchDigest = CATALOG_WORKFLOWS.find(
      (w) => w.assetName === "workbench-digest",
    );
    if (!workbenchDigest)
      throw new Error("expected the workbench-digest workflow");
    expect(workbenchDigest.displayName).toBe("Workbench digest");
    expect(workbenchDigest.automatable).toBe(true);
    expect(workbenchDigest.modelSource).toBeUndefined();
    expect(workbenchDigest.startStopped).toBe(true);
  });

  test("echo and assistant are not automatable", () => {
    for (const name of ["echo", "assistant"] as const) {
      const workflow = [...CATALOG_WORKFLOWS, ...DEFAULT_WORKFLOWS].find(
        (w) => w.assetName === name,
      );
      if (!workflow) throw new Error(`expected ${name}`);
      expect(workflow.automatable).toBe(false);
      expect(workflow.displayName.length).toBeGreaterThan(0);
    }
  });

  test("the catalog-test set is heartbeat only (workbench-digest moved to defaults)", () => {
    expect(CATALOG_TEST_WORKFLOWS.map((w) => w.assetName)).toEqual([
      "heartbeat",
    ]);
  });

  test("fresh run pushes, deploys, and confirms the workbench-digest workflow against the tenant model", async () => {
    const { lines, log } = collector();
    const { pushes, push } = recordingPusher();
    let runsCalls = 0;
    let deployedSources: unknown;
    const handler: FakeHandler = (method, path, body) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_4", "workbench-digest") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        deployedSources = body;
        return {
          status: 201,
          data: deploymentRow("dep_4", "ast_4", "deployed"),
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_4/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls === 1 ? [] : ["run_1"] },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_4/mail`
      )
        return {
          status: 202,
          data: {
            runId: "dep_4",
            address: `ins_dep_4@${TENANT_DOMAIN}`,
            messageId: "<m6@workbench.localhost>",
          },
        };
      return undefined;
    };

    const digestOnly = CATALOG_WORKFLOWS.filter(
      (w) => w.assetName === "workbench-digest",
    );
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        workflows: digestOnly,
      }),
    );

    expect(pushes).toHaveLength(1);
    const push0 = pushes[0];
    if (!push0) throw new Error("expected one workflow push");
    const definition = JSON.parse(push0.workflowJson) as {
      id: string;
      triggers: { type: string; cron?: string }[];
      stepOrder: string[];
    };
    expect(definition.id).toBe("wf_workbench_digest");
    expect(definition.triggers).toEqual([
      { type: "schedule", cron: "0 9 * * *" },
    ]);
    expect(definition.stepOrder).toEqual(["workbench-digest"]);

    // Defaults deploy against the tenant's real model (not noop).
    const deployedBody = deployedSources as { sources: { model: string }[] };
    expect(deployedBody.sources[0]?.model).not.toBe("noop");

    const output = lines.join("\n");
    expect(output).toContain("deployed workflow workbench-digest as dep_4");
    expect(output).toContain(
      "confirmed workflow workbench-digest: run run_1 started",
    );
    expect(output).toContain(
      "stopped definition workbench-digest so its native schedule does not fire until restored",
    );
  });

  test("startStopped skips a member-restored digest instead of re-archiving it", async () => {
    const { lines, log } = collector();
    let puts = 0;
    let runsCalls = 0;
    const handler: FakeHandler = (method, path) => {
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/workflows/definitions`)
      ) {
        return {
          status: 200,
          data: {
            data: [
              {
                id: "wfd_digest",
                tenantId: TENANT_ID,
                name: "workbench-digest",
                currentVersion: "1",
                status: "deployed",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-02T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          },
        };
      }
      if (method === "PUT" && path.includes("/agent-definitions/")) {
        puts += 1;
        throw new Error("must not re-stop a touched definition");
      }
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_4", "workbench-digest") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 201,
          data: deploymentRow("dep_4", "ast_4", "deployed"),
        };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_4/runs`
      ) {
        runsCalls += 1;
        return {
          status: 200,
          data: { runIds: runsCalls === 1 ? [] : ["run_1"] },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/dep_4/mail`
      )
        return {
          status: 202,
          data: {
            runId: "dep_4",
            address: `ins_dep_4@${TENANT_DOMAIN}`,
            messageId: "<m6@workbench.localhost>",
          },
        };
      return undefined;
    };

    await seedTenant(
      args({
        api: fakeAPI(handler),
        log,
        workflows: CATALOG_WORKFLOWS.filter(
          (w) => w.assetName === "workbench-digest",
        ),
      }),
    );

    expect(puts).toBe(0);
    expect(lines.join("\n")).toContain(
      "definition workbench-digest was touched; leaving status deployed",
    );
  });

  test("startStopped pages past the first definitions page to find digest", async () => {
    const { lines, log } = collector();
    let puts = 0;
    let definitionPages = 0;
    const handler: FakeHandler = (method, path) => {
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/workflows/definitions`)
      ) {
        definitionPages += 1;
        if (!path.includes("cursor=")) {
          return {
            status: 200,
            data: {
              data: [
                {
                  id: "wfd_other",
                  tenantId: TENANT_ID,
                  name: "echo",
                  currentVersion: "1",
                  status: "deployed",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              ],
              nextCursor: "page2",
            },
          };
        }
        return {
          status: 200,
          data: {
            data: [
              {
                id: "wfd_digest",
                tenantId: TENANT_ID,
                name: "workbench-digest",
                currentVersion: "1",
                status: "deployed",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          },
        };
      }
      if (
        method === "PUT" &&
        path === `/api/tenants/${TENANT_ID}/agent-definitions/wfd_digest/status`
      ) {
        puts += 1;
        return { status: 200, data: { id: "wfd_digest", status: "stopped" } };
      }
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
        return { status: 201, data: assetRow("ast_4", "workbench-digest") };
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 201,
          data: deploymentRow("dep_4", "ast_4", "deployed"),
        };
      return undefined;
    };

    await seedTenant(
      args({
        api: fakeAPI(handler),
        log,
        workflows: CATALOG_WORKFLOWS.filter(
          (w) => w.assetName === "workbench-digest",
        ),
        confirmDeployments: false,
      }),
    );

    expect(definitionPages).toBe(2);
    expect(puts).toBe(1);
    expect(lines.join("\n")).toContain(
      "stopped definition workbench-digest so its native schedule does not fire until restored",
    );
  });

  test("confirmDeployments: false deploys every default workflow without triggering or confirming any of them", async () => {
    // The onboarding connect flow's seam: the key was already proven
    // with a free probe, so seeding must never spend the connecting
    // user's own balance on a real inference call. Any POST to a
    // workflow's mail-trigger endpoint here is exactly the bug this
    // flag exists to prevent, so the fake handler fails the test the
    // moment one arrives instead of quietly answering it.
    const { lines, log } = collector();
    const { pushes, push } = recordingPusher();
    const handler: FakeHandler = (method, path, body) => {
      const base = baseRoutes(method, path);
      if (base) return base;
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`) {
        const name = (body as { name: string }).name;
        return { status: 201, data: assetRow(`ast_${name}`, name) };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return { status: 200, data: [] };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      )
        return {
          status: 201,
          data: deploymentRow("dep_x", "ast_x", "deployed"),
        };
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/workflows/`) &&
        path.endsWith("/runs")
      ) {
        throw new Error(
          `unexpected run-listing call with confirmDeployments: false — ${method} ${path}`,
        );
      }
      if (
        method === "POST" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/workflows/`) &&
        path.endsWith("/mail")
      ) {
        throw new Error(
          `unexpected workflow trigger call with confirmDeployments: false — ${method} ${path}`,
        );
      }
      return undefined;
    };

    // Deploy the full default set plus the on-demand catalog (which
    // still carries workbench-digest's startStopped handshake) so this
    // test keeps covering both a plain deploy and the stop-pristine
    // path with confirmDeployments off, regardless of which set a real
    // signup deploys by default.
    const workflows = [...DEFAULT_WORKFLOWS, ...CATALOG_WORKFLOWS];
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        confirmDeployments: false,
        workflows,
      }),
    );

    expect(pushes).toHaveLength(workflows.length);
    // CL-6462: deploy order is the product decision — the setup agent is
    // pushed and deployed before any other seeded workflow, so someone
    // who just connected can start talking while the rest converge.
    expect(pushes[0]?.remoteUrl).toContain(
      `/assets/workflow/${SETUP_AGENT_ASSET_NAME}.git`,
    );
    const output = lines.join("\n");
    for (const workflow of workflows) {
      expect(output).not.toContain(`confirmed workflow ${workflow.assetName}`);
    }
    expect(output).toContain(
      `seed complete: ${workflows.length} workflow(s) deployed`,
    );
    expect(output).not.toContain("deployed and confirmed");
    expect(output).toContain(
      "stopped definition workbench-digest so its native schedule does not fire until restored",
    );
  });
});

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function providerRow(id: string, name: string, plugin: string = name) {
  return {
    id,
    tenantId: TENANT_ID,
    name,
    plugin,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function credentialRow(id: string, providerId: string, name: string) {
  return {
    id,
    tenantId: TENANT_ID,
    providerId,
    name,
    type: "api_key",
    status: "active",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function catalogModelRow(id: string, canonicalName: string) {
  return {
    id,
    tenantId: TENANT_ID,
    canonicalName,
    disabled: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function catalogProviderRow(
  id: string,
  name: string,
  credentialId: string,
  plugin: string = name,
  baseURL = "https://api.anthropic.com",
) {
  return {
    id,
    tenantId: TENANT_ID,
    name,
    plugin,
    baseURL,
    credentialId,
    disabled: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function catalogOfferingRow(id: string, modelId: string, providerId: string) {
  return {
    id,
    tenantId: TENANT_ID,
    modelId,
    providerId,
    priority: 0,
    deploymentTags: [],
    capabilities: [],
    quirks: null,
    disabled: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

describe("default skills seeding", () => {
  const workflowRoutes = (method: string, path: string) => {
    if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`)
      return { status: 201, data: assetRow("ast_1", "echo") };
    if (
      method === "GET" &&
      path === `/api/tenants/${TENANT_ID}/workflows/deployments`
    )
      return { status: 200, data: [] };
    if (
      method === "POST" &&
      path === `/api/tenants/${TENANT_ID}/workflows/deployments`
    )
      return { status: 201, data: deploymentRow("dep_1", "ast_1", "deployed") };
    if (
      method === "GET" &&
      path === `/api/tenants/${TENANT_ID}/workflows/dep_1/runs`
    )
      return { status: 200, data: { runIds: ["run_1"] } };
    if (
      method === "POST" &&
      path === `/api/tenants/${TENANT_ID}/workflows/dep_1/mail`
    )
      return {
        status: 202,
        data: {
          runId: "dep_1",
          address: `ins_dep_1@${TENANT_DOMAIN}`,
          messageId: "<m1@workbench.localhost>",
        },
      };
    return undefined;
  };

  test("a fresh tenant gets every default skill created tenant-scoped", async () => {
    const { log } = collector();
    const { push } = recordingPusher();
    const skillPosts: unknown[] = [];
    const handler: FakeHandler = (method, path, body) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/skills`) {
        skillPosts.push(body);
        return { status: 201, data: {} };
      }
      const base = baseRoutes(method, path);
      if (base) return base;
      return workflowRoutes(method, path);
    };

    const echoOnly = CATALOG_WORKFLOWS.filter((w) => w.assetName === "echo");
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        workflows: echoOnly,
        confirmDeployments: false,
      }),
    );

    expect(skillPosts.map((b) => (b as { name: string }).name)).toEqual(
      DEFAULT_SKILLS.map((s) => s.name),
    );
    for (const body of skillPosts) {
      expect(body as object).toMatchObject({ scope: "tenant" });
      expect((body as { body: string }).body.length).toBeGreaterThan(200);
    }
  });

  test("an already-seeded skill is skipped, never re-created", async () => {
    const { lines, log } = collector();
    const { push } = recordingPusher();
    const handler: FakeHandler = (method, path) => {
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/skills/`)
      )
        return { status: 200, data: { skill: {} } };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/skills`)
        throw new Error("must not re-create an existing skill");
      const base = baseRoutes(method, path);
      if (base) return base;
      return workflowRoutes(method, path);
    };

    const echoOnly = CATALOG_WORKFLOWS.filter((w) => w.assetName === "echo");
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        workflows: echoOnly,
        confirmDeployments: false,
      }),
    );

    expect(lines.some((l) => l.includes("already exists"))).toBe(true);
  });

  test("a skill the by-name GET misses but the create route rejects as a conflict is skipped, not fatal", async () => {
    // Reproduces the live incident: a half-seeded tenant re-running
    // `workbench seed` hit `409 already exists` on skill creation and
    // aborted the whole run, even though the hub's own error advice was
    // "re-run: workbench seed". A step that already succeeded must never
    // kill a re-run.
    const { lines, log } = collector();
    const { push } = recordingPusher();
    const conflictingSkillName = DEFAULT_SKILLS[0]?.name;
    if (conflictingSkillName === undefined) {
      throw new Error("DEFAULT_SKILLS must not be empty for this test");
    }
    const handler: FakeHandler = (method, path) => {
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/skills/`)
      )
        return { status: 404, data: {} };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/skills`)
        return {
          status: 409,
          data: {
            code: "conflict",
            message: `a skill named "${conflictingSkillName}" already exists in this workbench`,
          },
        };
      const base = baseRoutes(method, path);
      if (base) return base;
      return workflowRoutes(method, path);
    };

    const echoOnly = CATALOG_WORKFLOWS.filter((w) => w.assetName === "echo");
    await seedTenant(
      args({
        api: fakeAPI(handler),
        pushWorkflow: push,
        log,
        workflows: echoOnly,
        confirmDeployments: false,
      }),
    );

    expect(lines.some((l) => l.includes("already exists"))).toBe(true);
  });
});

describe("seedCatalog", () => {
  test("no apiKey and no placeholderCredential plants only the catalog model", async () => {
    const { lines, log } = collector();
    let providerPosts = 0;
    const handler: FakeHandler = (method, path) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`) {
        providerPosts += 1;
        return { status: 201, data: providerRow("prv_1", "anthropic") };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 201,
          data: catalogModelRow("mdl_1", "claude-sonnet-5"),
        };
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      log,
    });

    expect(providerPosts).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("created catalog model claude-sonnet-5");
    expect(output).toContain("seeded without a credential");
  });

  test("fresh run creates the full provider-to-offering chain", async () => {
    const { lines, log } = collector();
    const modelPosts: string[] = [];
    const offeringPosts: { modelId: string; providerId: string }[] = [];
    const handler: FakeHandler = (method, path, body) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return { status: 201, data: providerRow("prv_1", "anthropic") };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 201,
          data: credentialRow("cre_1", "prv_1", "anthropic-default"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        const canonicalName = (body as { canonicalName: string }).canonicalName;
        modelPosts.push(canonicalName);
        return {
          status: 201,
          data: catalogModelRow(`mdl_${modelPosts.length}`, canonicalName),
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 201,
          data: catalogProviderRow("cpv_1", "anthropic", "cre_1"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      ) {
        // Every Anthropic Direct model in the curated six is an
        // exact-deployment probe in the pinned catalog, so each offering
        // carries what that probe observed rather than an empty list.
        const offeringBody = body as {
          modelId: string;
          providerId: string;
          priority: number;
          capabilities: string[];
        };
        expect(offeringBody.providerId).toBe("cpv_1");
        expect(offeringBody.priority).toBe(offeringPosts.length);
        expect(offeringBody.capabilities.length).toBeGreaterThan(0);
        expect(offeringBody.capabilities).toContain("plain-text");
        expect(offeringBody.capabilities).toContain(
          "function-calling-multi-turn",
        );
        offeringPosts.push(offeringBody);
        return {
          status: 201,
          data: catalogOfferingRow(
            `off_${offeringPosts.length}`,
            offeringBody.modelId,
            offeringBody.providerId,
          ),
        };
      }
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      apiKey: "sk-test",
      log,
    });

    expect(modelPosts).toEqual([
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-haiku-4-5-20251001",
      "claude-fable-5",
      "claude-sonnet-4-6",
    ]);
    expect(offeringPosts.map((o) => o.modelId)).toEqual([
      "mdl_1",
      "mdl_2",
      "mdl_3",
      "mdl_4",
      "mdl_5",
      "mdl_6",
    ]);

    const output = lines.join("\n");
    expect(output).toContain("created provider anthropic");
    expect(output).toContain("created credential anthropic-default");
    expect(output).toContain("created catalog model claude-sonnet-5");
    expect(output).toContain("created catalog provider anthropic");
    expect(output).toContain("created catalog offering");
    expect(output).toContain(
      "catalog ready: anthropic/claude-sonnet-5, claude-opus-5, claude-opus-4-8, claude-haiku-4-5-20251001, claude-fable-5, claude-sonnet-4-6",
    );
  });

  test("fresh run gives the declared Anthropic default the lowest distinct priority", async () => {
    const { log } = collector();
    const modelNamesById = new Map<string, string>();
    const offeringPosts: { modelId: string; priority: number }[] = [];
    const handler: FakeHandler = (method, path, body) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return { status: 201, data: providerRow("prv_1", "anthropic") };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 201,
          data: credentialRow("cre_1", "prv_1", "anthropic-default"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        const canonicalName = (body as { canonicalName: string }).canonicalName;
        const modelId = `mdl_${modelNamesById.size + 1}`;
        modelNamesById.set(modelId, canonicalName);
        return {
          status: 201,
          data: catalogModelRow(modelId, canonicalName),
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 201,
          data: catalogProviderRow("cpv_1", "anthropic", "cre_1"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      ) {
        const offering = body as { modelId: string; priority: number };
        offeringPosts.push(offering);
        return {
          status: 201,
          data: catalogOfferingRow(
            `off_${offeringPosts.length}`,
            offering.modelId,
            "cpv_1",
          ),
        };
      }
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      apiKey: "sk-test",
      log,
    });

    const priorities = offeringPosts.map((offering) => offering.priority);
    const sonnet = offeringPosts.find(
      (offering) => modelNamesById.get(offering.modelId) === "claude-sonnet-5",
    );
    expect(new Set(priorities).size).toBe(offeringPosts.length);
    expect(sonnet?.priority).toBe(Math.min(...priorities));
  });

  test("re-run updates a legacy offering to its computed priority", async () => {
    const { log } = collector();
    const patchedOfferings: { id: string; priority: number }[] = [];
    const handler: FakeHandler = (method, path, body) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return { status: 201, data: providerRow("prv_1", "anthropic") };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 201,
          data: credentialRow("cre_1", "prv_1", "anthropic-default"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        const canonicalName = (body as { canonicalName: string }).canonicalName;
        const modelId =
          canonicalName === "claude-opus-5" ? "mdl_legacy" : "mdl_new";
        return { status: 201, data: catalogModelRow(modelId, canonicalName) };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 201,
          data: catalogProviderRow("cpv_1", "anthropic", "cre_1"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      ) {
        const offering = body as { modelId: string };
        if (offering.modelId === "mdl_legacy")
          return { status: 409, data: { error: "already exists" } };
        return {
          status: 201,
          data: catalogOfferingRow(
            `off_${offering.modelId}`,
            offering.modelId,
            "cpv_1",
          ),
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      )
        return {
          status: 200,
          data: {
            data: [
              catalogOfferingRow(
                "off_other_provider",
                "mdl_legacy",
                "cpv_other",
              ),
            ],
            nextCursor: "second-page",
          },
        };
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/catalog/offerings?cursor=second-page`
      )
        return {
          status: 200,
          data: {
            data: [catalogOfferingRow("off_legacy", "mdl_legacy", "cpv_1")],
            nextCursor: null,
          },
        };
      if (
        method === "PATCH" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings/off_legacy`
      ) {
        const patch = body as { priority: number };
        patchedOfferings.push({ id: "off_legacy", priority: patch.priority });
        return {
          status: 200,
          data: {
            ...catalogOfferingRow("off_legacy", "mdl_legacy", "cpv_1"),
            priority: patch.priority,
          },
        };
      }
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      apiKey: "sk-test",
      log,
    });

    expect(patchedOfferings).toEqual([{ id: "off_legacy", priority: 1 }]);
  });

  test("an Ollama offering's quirks carry that model's real context-window ceiling, not the built-in 4096 default", async () => {
    const { log } = collector();
    const offeringBodies: Record<string, unknown>[] = [];
    const handler: FakeHandler = (method, path, body) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return { status: 201, data: providerRow("prv_1", "ollama") };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 201,
          data: credentialRow("cre_1", "prv_1", "ollama-default"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        const modelBody = body as { canonicalName: string };
        return {
          status: 201,
          data: catalogModelRow(
            `mdl_${modelBody.canonicalName}`,
            modelBody.canonicalName,
          ),
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 201,
          data: catalogProviderRow(
            "cpv_1",
            "ollama",
            "cre_1",
            "openai-compatible",
            "http://127.0.0.1:1/v1",
          ),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      ) {
        offeringBodies.push(body as Record<string, unknown>);
        return {
          status: 201,
          data: catalogOfferingRow("off_1", "mdl_1", "cpv_1"),
        };
      }
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      provider: "ollama",
      // Port 1 on loopback refuses instantly (nothing ever listens there),
      // so this test's own `fetchOllamaModelCatalog` probe fails fast and
      // falls back to the curated static seed, instead of depending on
      // whatever Ollama instance (if any) happens to be reachable from
      // wherever this test runs.
      baseURLOverride: "http://127.0.0.1:1/v1",
      apiKey: "unused",
      log,
    });

    const gptOssDefault = OLLAMA_MODEL_DEFAULTS["gpt-oss:20b"];
    const qwenDefault = OLLAMA_MODEL_DEFAULTS["qwen3.8:27b"];
    if (gptOssDefault === undefined || qwenDefault === undefined) {
      throw new Error("missing fixture entry");
    }
    const gptOss = offeringBodies.find(
      (entry) => entry["modelId"] === "mdl_gpt-oss:20b",
    );
    expect(gptOss?.["quirks"]).toEqual({ default: gptOssDefault });
    const qwen = offeringBodies.find(
      (entry) => entry["modelId"] === "mdl_qwen3.8:27b",
    );
    expect(qwen?.["quirks"]).toEqual({ default: qwenDefault });
    expect(
      (qwen?.["quirks"] as { default: { numCtx: number } })?.default?.numCtx,
    ).toBeLessThan(
      (gptOss?.["quirks"] as { default: { numCtx: number } })?.default?.numCtx,
    );
  });

  test("an oauth_token credential with metadata posts both through to the credential row", async () => {
    const { log } = collector();
    let credentialBody: unknown;
    const handler: FakeHandler = (method, path, body) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return { status: 201, data: providerRow("prv_1", "huggingface") };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/credentials`
      ) {
        credentialBody = body;
        return {
          status: 201,
          data: credentialRow("cre_1", "prv_1", "huggingface-default"),
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 201,
          data: catalogModelRow("mdl_1", "deepseek-ai/DeepSeek-V4-Flash"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 201,
          data: catalogProviderRow(
            "cpv_1",
            "huggingface",
            "cre_1",
            "openai-compatible",
            "https://router.huggingface.co/v1",
          ),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      )
        return {
          status: 201,
          data: catalogOfferingRow("off_1", "mdl_1", "cpv_1"),
        };
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      provider: "huggingface",
      apiKey: "hf_oauth_minted",
      credentialType: "oauth_token",
      credentialMetadata: { expiresAt: "2026-08-13T20:00:00.000Z" },
      log,
    });

    expect(credentialBody).toMatchObject({
      type: "oauth_token",
      metadata: { expiresAt: "2026-08-13T20:00:00.000Z" },
    });
  });

  // A reconnect after the expiry sweep has already flipped the stored
  // row to `expired`: the credential name conflicts (409) because the
  // stale row is still there, so this only succeeds if the fresh token
  // and its new expiry are rotated onto that row rather than discarded
  // in favor of reusing the stale one.
  test("a name conflict on an expired oauth_token reconnect rotates the stale row", async () => {
    const { lines, log } = collector();
    let patchCalls = 0;
    let postCredentialCalls = 0;
    let offeringPosts = 0;
    let patchBody: unknown;

    const staleCredentialRow = () => ({
      id: "cre_old",
      tenantId: TENANT_ID,
      providerId: "prv_1",
      name: "huggingface-default",
      type: "oauth_token",
      status: "expired",
      metadata: { expiresAt: "2026-01-01T00:00:00.000Z" },
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });

    const handler: FakeHandler = (method, path, body) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return { status: 201, data: providerRow("prv_1", "huggingface") };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/credentials`
      ) {
        postCredentialCalls += 1;
        // The credential name "huggingface-default" already exists (the
        // expired row from before this reconnect), so creation conflicts.
        return { status: 409, data: { error: "name taken" } };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 200,
          data: { data: [staleCredentialRow()], nextCursor: null },
        };
      if (
        method === "PATCH" &&
        path === `/api/tenants/${TENANT_ID}/credentials/cre_old`
      ) {
        patchCalls += 1;
        patchBody = body;
        return {
          status: 200,
          data: {
            ...staleCredentialRow(),
            status: "active",
            metadata: { expiresAt: "2026-09-01T00:00:00.000Z" },
          },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 201,
          data: catalogModelRow("mdl_1", "deepseek-ai/DeepSeek-V4-Flash"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 201,
          data: catalogProviderRow(
            "cpv_1",
            "huggingface",
            "cre_old",
            "openai-compatible",
            "https://router.huggingface.co/v1",
          ),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      ) {
        const providersBeforeHuggingFace = Object.entries(CATALOG_SEEDS).slice(
          0,
          Object.keys(CATALOG_SEEDS).indexOf("huggingface"),
        );
        expect((body as { priority: number }).priority).toBe(
          providersBeforeHuggingFace.reduce(
            (offset, [, providerSeed]) => offset + providerSeed.models.length,
            0,
          ) + offeringPosts,
        );
        offeringPosts += 1;
        return {
          status: 201,
          data: catalogOfferingRow("off_1", "mdl_1", "cpv_1"),
        };
      }
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      provider: "huggingface",
      apiKey: "hf_freshly_minted_token",
      credentialType: "oauth_token",
      credentialMetadata: { expiresAt: "2026-09-01T00:00:00.000Z" },
      log,
    });

    expect(postCredentialCalls).toBe(1);
    // The fix: the name conflict is followed by a PATCH that carries the
    // freshly minted token, its new expiry, and restores `active` status
    // — never a silent reuse of the stale, already-expired row.
    expect(patchCalls).toBe(1);
    expect(patchBody).toEqual({
      secret: "hf_freshly_minted_token",
      status: "active",
      metadata: { expiresAt: "2026-09-01T00:00:00.000Z" },
    });
    expect(lines.some((line) => line.includes("rotated credential"))).toBe(
      true,
    );
  });

  test("a name conflict on an already-active oauth_token credential is left untouched", async () => {
    const { log } = collector();
    let patchCalls = 0;

    const activeCredentialRow = () => ({
      id: "cre_active",
      tenantId: TENANT_ID,
      providerId: "prv_1",
      name: "huggingface-default",
      type: "oauth_token",
      status: "active",
      metadata: { expiresAt: "2026-09-01T00:00:00.000Z" },
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });

    const handler: FakeHandler = (method, path) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return { status: 201, data: providerRow("prv_1", "huggingface") };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return { status: 409, data: { error: "name taken" } };
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 200,
          data: { data: [activeCredentialRow()], nextCursor: null },
        };
      if (method === "PATCH") {
        patchCalls += 1;
        return { status: 200, data: activeCredentialRow() };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 201,
          data: catalogModelRow("mdl_1", "deepseek-ai/DeepSeek-V4-Flash"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 201,
          data: catalogProviderRow(
            "cpv_1",
            "huggingface",
            "cre_active",
            "openai-compatible",
            "https://router.huggingface.co/v1",
          ),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      )
        return {
          status: 201,
          data: catalogOfferingRow("off_1", "mdl_1", "cpv_1"),
        };
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      provider: "huggingface",
      apiKey: "hf_same_token_again",
      credentialType: "oauth_token",
      credentialMetadata: { expiresAt: "2026-09-01T00:00:00.000Z" },
      log,
    });

    // A plain idempotent re-seed of a still-active connection never
    // rotates — only a genuinely stale (non-active) row does.
    expect(patchCalls).toBe(0);
  });

  // CL-7236: an interactive MCP OAuth reconnect (packages/connections/src/
  // mcp-oauth-routes.ts) passes `credentialVerified: true` after a
  // completed OAuth exchange — a user re-authorizing an integration whose
  // stored row hasn't technically expired yet (refreshed provider-side
  // scopes, or a proactive reconnect). Before the fix, the oauth_token
  // branch of `shouldRotate` looked only at `existing.status`, ignoring
  // `verified` entirely: zero PATCH calls, and the stale row's id returned
  // as though the reconnect had worked.
  test("a name conflict on a verified oauth_token reconnect rotates the still-active row", async () => {
    const { lines, log } = collector();
    let patchCalls = 0;
    let patchBody: unknown;

    const activeCredentialRow = () => ({
      id: "cre_active",
      tenantId: TENANT_ID,
      providerId: "prv_1",
      name: "huggingface-default",
      type: "oauth_token",
      status: "active",
      metadata: { expiresAt: "2026-09-01T00:00:00.000Z" },
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });

    const handler: FakeHandler = (method, path, body) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return { status: 201, data: providerRow("prv_1", "huggingface") };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return { status: 409, data: { error: "name taken" } };
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 200,
          data: { data: [activeCredentialRow()], nextCursor: null },
        };
      if (
        method === "PATCH" &&
        path === `/api/tenants/${TENANT_ID}/credentials/cre_active`
      ) {
        patchCalls += 1;
        patchBody = body;
        return {
          status: 200,
          data: {
            ...activeCredentialRow(),
            metadata: { expiresAt: "2026-10-01T00:00:00.000Z" },
          },
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 201,
          data: catalogModelRow("mdl_1", "deepseek-ai/DeepSeek-V4-Flash"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 201,
          data: catalogProviderRow(
            "cpv_1",
            "huggingface",
            "cre_active",
            "openai-compatible",
            "https://router.huggingface.co/v1",
          ),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      )
        return {
          status: 201,
          data: catalogOfferingRow("off_1", "mdl_1", "cpv_1"),
        };
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      provider: "huggingface",
      apiKey: "hf_freshly_reauthorized_token",
      credentialType: "oauth_token",
      credentialVerified: true,
      credentialMetadata: { expiresAt: "2026-10-01T00:00:00.000Z" },
      log,
    });

    expect(patchCalls).toBe(1);
    expect(patchBody).toEqual({
      secret: "hf_freshly_reauthorized_token",
      status: "active",
      metadata: { expiresAt: "2026-10-01T00:00:00.000Z" },
    });
    expect(lines.some((line) => line.includes("rotated credential"))).toBe(
      true,
    );
  });

  // A regenerated OpenRouter key, or a retry after a bad paste, reconnects
  // under the same stable credential name — the caller has already proven
  // the fresh key against the provider's own probe (`credentialVerified:
  // true`), so the name conflict must rotate the stored secret rather
  // than silently keeping the stale one while claiming connected.
  test("a name conflict on a verified api_key reconnect rotates the stored secret", async () => {
    const { lines, log } = collector();
    let patchCalls = 0;
    let patchBody: unknown;

    const activeCredentialRow = () => ({
      id: "cre_active",
      tenantId: TENANT_ID,
      providerId: "prv_1",
      name: "openrouter-default",
      type: "api_key",
      status: "active",
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });

    const handler: FakeHandler = (method, path, body) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return { status: 201, data: providerRow("prv_1", "openrouter") };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return { status: 409, data: { error: "name taken" } };
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 200,
          data: { data: [activeCredentialRow()], nextCursor: null },
        };
      if (
        method === "PATCH" &&
        path === `/api/tenants/${TENANT_ID}/credentials/cre_active`
      ) {
        patchCalls += 1;
        patchBody = body;
        return { status: 200, data: { ...activeCredentialRow() } };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 201,
          data: catalogModelRow("mdl_1", "anthropic/claude-sonnet-5"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 201,
          data: catalogProviderRow(
            "cpv_1",
            "openrouter",
            "cre_active",
            "openai-compatible",
            "https://openrouter.ai/api/v1",
          ),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      )
        return {
          status: 201,
          data: catalogOfferingRow("off_1", "mdl_1", "cpv_1"),
        };
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      provider: "openrouter",
      apiKey: "sk-or-freshly-regenerated",
      credentialName: "openrouter-default",
      credentialVerified: true,
      log,
    });

    expect(patchCalls).toBe(1);
    expect(patchBody).toEqual({
      secret: "sk-or-freshly-regenerated",
      status: "active",
      metadata: undefined,
    });
    expect(lines.some((line) => line.includes("rotated credential"))).toBe(
      true,
    );
  });

  test("re-run finds every step already seeded and creates nothing twice", async () => {
    const { lines, log } = collector();
    let providerPosts = 0;
    let credentialPosts = 0;
    let modelPosts = 0;
    let catalogProviderPosts = 0;
    let offeringPosts = 0;
    const anthropicModels = [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-haiku-4-5-20251001",
      "claude-fable-5",
      "claude-sonnet-4-6",
    ];
    const handler: FakeHandler = (method, path) => {
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`) {
        providerPosts += 1;
        return { status: 409, data: { error: "name taken" } };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/providers?inherited=false`
      )
        return {
          status: 200,
          data: { data: [providerRow("prv_1", "anthropic")], nextCursor: null },
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/credentials`
      ) {
        credentialPosts += 1;
        return { status: 409, data: { error: "name taken" } };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 200,
          data: {
            data: [credentialRow("cre_1", "prv_1", "anthropic-default")],
            nextCursor: null,
          },
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        modelPosts += 1;
        return { status: 409, data: { error: "name taken" } };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 200,
          data: {
            data: anthropicModels.map((name, index) =>
              catalogModelRow(`mdl_${index + 1}`, name),
            ),
            nextCursor: null,
          },
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      ) {
        catalogProviderPosts += 1;
        return { status: 409, data: { error: "name taken" } };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      )
        return {
          status: 200,
          data: {
            data: [catalogProviderRow("cpv_1", "anthropic", "cre_1")],
            nextCursor: null,
          },
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      ) {
        offeringPosts += 1;
        return { status: 409, data: { error: "already exists" } };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      )
        return {
          status: 200,
          data: {
            data: anthropicModels.map((_, index) => ({
              ...catalogOfferingRow(
                `off_${index + 1}`,
                `mdl_${index + 1}`,
                "cpv_1",
              ),
              priority: index,
            })),
            nextCursor: null,
          },
        };
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      apiKey: "sk-test",
      log,
    });

    expect(providerPosts).toBe(1);
    expect(credentialPosts).toBe(1);
    expect(modelPosts).toBe(6);
    expect(catalogProviderPosts).toBe(1);
    expect(offeringPosts).toBe(6);

    const output = lines.join("\n");
    expect(output).toContain("provider anthropic already exists (skipped)");
    expect(output).toContain(
      "credential anthropic-default already exists (skipped",
    );
    expect(output).toContain(
      "catalog model claude-sonnet-5 already exists (skipped)",
    );
    expect(output).toContain(
      "catalog provider anthropic already exists (skipped)",
    );
    expect(output).toContain("catalog offering already exists (skipped)");
  });

  test("a non-default provider plants its own curated multi-model catalog under the 'openai-compatible' plugin", async () => {
    const { lines, log } = collector();
    const modelPosts: string[] = [];
    const offeringPosts: { modelId: string; providerId: string }[] = [];
    const handler: FakeHandler = (method, path, body) => {
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        const canonicalName = (body as { canonicalName: string }).canonicalName;
        modelPosts.push(canonicalName);
        return {
          status: 201,
          data: catalogModelRow(`mdl_${modelPosts.length}`, canonicalName),
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`) {
        expect(body).toMatchObject({
          name: "groq",
          plugin: "openai-compatible",
        });
        return {
          status: 201,
          data: providerRow("prv_1", "groq", "openai-compatible"),
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/credentials`)
        return {
          status: 201,
          data: credentialRow("cre_1", "prv_1", "groq-default"),
        };
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      ) {
        expect(body).toMatchObject({
          name: "groq",
          plugin: "openai-compatible",
          baseURL: "https://api.groq.com/openai/v1",
        });
        return {
          status: 201,
          data: catalogProviderRow(
            "cpv_1",
            "groq",
            "cre_1",
            "openai-compatible",
            "https://api.groq.com/openai/v1",
          ),
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      ) {
        const offering = body as { modelId: string; providerId: string };
        offeringPosts.push(offering);
        return {
          status: 201,
          data: catalogOfferingRow(
            `off_${offeringPosts.length}`,
            offering.modelId,
            offering.providerId,
          ),
        };
      }
      return undefined;
    };

    await seedCatalog({
      api: fakeAPI(handler),
      cookies: [],
      tenantId: TENANT_ID,
      provider: "groq",
      apiKey: "gsk-test",
      log,
    });

    expect(modelPosts).toEqual([
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "openai/gpt-oss-120b",
    ]);
    expect(offeringPosts).toHaveLength(3);
    expect(offeringPosts.every((o) => o.providerId === "cpv_1")).toBe(true);

    const output = lines.join("\n");
    expect(output).toContain(
      "catalog ready: groq/llama-3.3-70b-versatile, llama-3.1-8b-instant, openai/gpt-oss-120b",
    );
  });

  test("an unexpected status from the provider route is a loud failure", async () => {
    const { log } = collector();
    const handler: FakeHandler = (method, path) => {
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      )
        return {
          status: 201,
          data: catalogModelRow("mdl_1", "claude-sonnet-5"),
        };
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`)
        return { status: 500, data: { error: "boom" } };
      return undefined;
    };

    expect(
      seedCatalog({
        api: fakeAPI(handler),
        cookies: [],
        tenantId: TENANT_ID,
        apiKey: "sk-test",
        log,
      }),
    ).rejects.toThrow(HubApiError);
  });
});
