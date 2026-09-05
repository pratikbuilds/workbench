import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKFLOWS,
  SEED_GRANTS,
  SETUP_AGENT_ASSET_NAME,
} from "@corbits/seeding";
import type { WorkflowPusher } from "@corbits/seeding";
import type { ApiCall } from "@corbits/hub-api-client";
import {
  isFullySeeded,
  personalTenantSlug,
  provisionPersonalTenantIfNeeded,
  seededWorkflowStatus,
} from "../src/provision";

const TENANT_ID = "ten_new";
const PRINCIPAL_ID = "prn_new";
const TENANT_SLUG = "alice-user1";
const DEPLOYMENT_ID = "dep_1";

const MODEL = {
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  baseURL: "https://api.anthropic.com",
  apiKey: "sk-test",
};

const noopPush: WorkflowPusher = async () => ({
  outcome: "pushed" as const,
  commitSha: "a".repeat(40),
});
const TOOLS_ASSET_ID = "ast_corbits_tools";
const SEEDED_MEMORY_TARBALL = {
  filename: "corbits-memory-tools-0.0.4.tgz",
  size: 12,
  integrity: "sha512-seeded",
};

function corbitsToolsAssetRow(tenantId: string) {
  return {
    id: TOOLS_ASSET_ID,
    tenantId,
    kind: "package-registry",
    name: "corbits-tools",
    displayName: null,
    creatorPrincipalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    origin: { tenantId, direct: true },
  };
}

function corbitsToolsRegistryResponse(
  method: string,
  path: string,
  tenantId: string,
  tarballs:
    | readonly { filename: string; size: number; integrity: string }[]
    | "missing",
): { status: number; data: unknown; cookies: string[] } | undefined {
  const inheritedList = `/api/tenants/${tenantId}/assets?kind=package-registry&inherited=true`;
  const localList = `/api/tenants/${tenantId}/assets?kind=package-registry&inherited=false`;
  if (method === "GET" && (path === inheritedList || path === localList)) {
    if (tarballs === "missing") {
      return { status: 200, data: [], cookies: [] };
    }
    return {
      status: 200,
      data: [corbitsToolsAssetRow(tenantId)],
      cookies: [],
    };
  }
  if (
    method === "GET" &&
    path === `/api/tenants/${tenantId}/assets/${TOOLS_ASSET_ID}/tarballs`
  ) {
    if (tarballs === "missing") {
      return { status: 200, data: [], cookies: [] };
    }
    return { status: 200, data: [...tarballs], cookies: [] };
  }
  return undefined;
}

function collector() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

function firstLoginSeedHub(args: { expectedParentId?: string }) {
  let principalsCalls = 0;
  const startedRuns: string[] = [];
  const tarballPuts: string[] = [];
  const api: ApiCall = async (method, path, body) => {
    const registry = corbitsToolsRegistryResponse(
      method,
      path,
      TENANT_ID,
      "missing",
    );
    if (registry !== undefined) return registry;
    if (path.includes("/tarballs/")) {
      tarballPuts.push(`${method} ${path}`);
      throw new Error(`signup must not pack: ${method} ${path}`);
    }
    if (method === "GET" && path === "/api/me/principals") {
      principalsCalls += 1;
      if (principalsCalls === 1) {
        return {
          status: 200,
          data: { data: [], nextCursor: null },
          cookies: [],
        };
      }
      return {
        status: 200,
        data: {
          data: [
            {
              principalId: PRINCIPAL_ID,
              tenantId: TENANT_ID,
              tenantName: "alice's workbench",
              tenantSlug: TENANT_SLUG,
              kind: "user",
              status: "active",
              roles: [{ id: "rol_owner", name: "owner" }],
            },
          ],
          nextCursor: null,
        },
        cookies: [],
      };
    }
    if (method === "POST" && path === "/api/tenants") {
      const parsed = body as {
        parentId?: string;
        slug: string;
        name: string;
      };
      expect(parsed.parentId).toBe(args.expectedParentId);
      expect(parsed.name).toBe("Alice's Lab");
      return {
        status: 201,
        data: {
          id: TENANT_ID,
          name: parsed.name,
          slug: parsed.slug,
          domain: `${parsed.slug}.localhost`,
          ...(args.expectedParentId !== undefined
            ? { parentId: args.expectedParentId }
            : {}),
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        cookies: [],
      };
    }
    if (
      method === "GET" &&
      path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
    ) {
      return {
        status: 200,
        data: { data: [], nextCursor: null },
        cookies: [],
      };
    }
    if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`) {
      return { status: 201, data: {}, cookies: [] };
    }
    if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`) {
      return {
        status: 201,
        data: {
          id: "ast_1",
          tenantId: TENANT_ID,
          kind: "workflow",
          name: "echo",
          displayName: null,
          creatorPrincipalId: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        cookies: [],
      };
    }
    if (method === "POST" && path === `/api/tenants/${TENANT_ID}/git-tokens`) {
      return {
        status: 201,
        data: { id: "tok_1", secret: "s3cret" },
        cookies: [],
      };
    }
    if (
      method === "GET" &&
      path.startsWith(`/api/tenants/${TENANT_ID}/skills/`)
    ) {
      return { status: 404, data: {}, cookies: [] };
    }
    if (method === "POST" && path === `/api/tenants/${TENANT_ID}/skills`) {
      return { status: 201, data: {}, cookies: [] };
    }
    if (
      method === "GET" &&
      path === `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
    ) {
      return { status: 200, data: [], cookies: [] };
    }
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
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
        cookies: [],
      };
    }
    if (
      method === "PUT" &&
      path === `/api/tenants/${TENANT_ID}/agent-definitions/wfd_digest/status`
    ) {
      return {
        status: 200,
        data: { id: "wfd_digest", status: "stopped" },
        cookies: [],
      };
    }
    if (
      method === "GET" &&
      path === `/api/tenants/${TENANT_ID}/workflows/deployments`
    ) {
      return { status: 200, data: [], cookies: [] };
    }
    if (
      method === "POST" &&
      path === `/api/tenants/${TENANT_ID}/workflows/deployments`
    ) {
      return {
        status: 201,
        data: {
          id: DEPLOYMENT_ID,
          tenantId: TENANT_ID,
          definitionAssetId: "ast_1",
          status: "deployed",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        cookies: [],
      };
    }
    if (
      method === "GET" &&
      path === `/api/tenants/${TENANT_ID}/workflows/${DEPLOYMENT_ID}/runs`
    ) {
      return {
        status: 200,
        data: { runIds: [...startedRuns] },
        cookies: [],
      };
    }
    if (
      method === "POST" &&
      path === `/api/tenants/${TENANT_ID}/workflows/${DEPLOYMENT_ID}/mail`
    ) {
      const runId = `run_${startedRuns.length + 1}`;
      startedRuns.push(runId);
      return {
        status: 202,
        data: {
          runId: DEPLOYMENT_ID,
          address: "echo@x",
          messageId: `m${startedRuns.length}`,
        },
        cookies: [],
      };
    }
    throw new Error(`unexpected call: ${method} ${path}`);
  };
  return { api, tarballPuts };
}

describe("personalTenantSlug", () => {
  test("derives a lowercase-kebab slug from the email and a user-id fragment", () => {
    expect(personalTenantSlug("Alice.Smith@example.com", "user_id_1")).toBe(
      "alice-smith-userid1",
    );
  });

  test("never produces an empty component", () => {
    expect(personalTenantSlug("@example.com", "")).toBe("bench-personal");
  });
});

describe("provisionPersonalTenantIfNeeded", () => {
  test("an existing member is left alone: no tenant is created", async () => {
    let tenantCreateCalls = 0;
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return {
          status: 200,
          data: {
            data: [
              {
                principalId: PRINCIPAL_ID,
                tenantId: "ten_existing",
                tenantName: "Existing",
                tenantSlug: "existing",
                kind: "user",
                status: "active",
                roles: [],
              },
            ],
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (method === "POST" && path === "/api/tenants") {
        tenantCreateCalls += 1;
        throw new Error("unexpected tenant creation for an existing member");
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      userEmailVerified: true,
      pushWorkflow: noopPush,
      log: collector().log,
    });

    expect(result).toEqual({ kind: "existing-member" });
    expect(tenantCreateCalls).toBe(0);
  });

  test("losing a concurrent-provisioning race returns the winner's membership instead of erroring", async () => {
    let principalsCalls = 0;
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        principalsCalls += 1;
        if (principalsCalls === 1) {
          return {
            status: 200,
            data: { data: [], nextCursor: null },
            cookies: [],
          };
        }
        // The race's winner already created the bench by the time this
        // caller re-checks after its own create lost with a 409.
        return {
          status: 200,
          data: {
            data: [
              {
                principalId: PRINCIPAL_ID,
                tenantId: TENANT_ID,
                tenantName: "alice's workbench",
                tenantSlug: TENANT_SLUG,
                kind: "user",
                status: "active",
                roles: [{ id: "rol_owner", name: "owner" }],
              },
            ],
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (method === "POST" && path === "/api/tenants") {
        return {
          status: 409,
          data: { error: { code: "conflict", message: "Slug already taken" } },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      userEmailVerified: true,
      displayName: "Alice's Lab",
      pushWorkflow: noopPush,
      log: collector().log,
    });

    expect(result).toEqual({ kind: "existing-member" });
  });

  test("a slug conflict that still leaves the caller benchless is a real failure", async () => {
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return {
          status: 200,
          data: { data: [], nextCursor: null },
          cookies: [],
        };
      }
      if (method === "POST" && path === "/api/tenants") {
        return {
          status: 409,
          data: { error: { code: "conflict", message: "Slug already taken" } },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    await expect(
      provisionPersonalTenantIfNeeded({
        api,
        cookies: ["session=abc"],
        hubUrl: "http://localhost:3000",
        userId: "user_1",
        userEmail: "alice@example.com",
        userEmailVerified: true,
        displayName: "Alice's Lab",
        pushWorkflow: noopPush,
        log: collector().log,
      }),
    ).rejects.toThrow(/slug conflict/);
  });

  test("zero principals with no seed model: provisions the bench and reports the seed skip loudly", async () => {
    let principalsCalls = 0;
    const { lines, log } = collector();
    const api: ApiCall = async (method, path, body) => {
      if (method === "GET" && path === "/api/me/principals") {
        principalsCalls += 1;
        if (principalsCalls === 1) {
          return {
            status: 200,
            data: { data: [], nextCursor: null },
            cookies: [],
          };
        }
        return {
          status: 200,
          data: {
            data: [
              {
                principalId: PRINCIPAL_ID,
                tenantId: TENANT_ID,
                tenantName: "alice's workbench",
                tenantSlug: TENANT_SLUG,
                kind: "user",
                status: "active",
                roles: [{ id: "rol_owner", name: "owner" }],
              },
            ],
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (method === "POST" && path === "/api/tenants") {
        const parsed = body as {
          parentId?: string;
          slug: string;
          name: string;
        };
        expect(parsed.parentId).toBeUndefined();
        expect(parsed.name).toBe("Alice's Lab");
        return {
          status: 201,
          data: {
            id: TENANT_ID,
            name: parsed.name,
            slug: parsed.slug,
            domain: `${parsed.slug}.localhost`,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      userEmailVerified: true,
      displayName: "Alice's Lab",
      pushWorkflow: noopPush,
      log,
    });

    expect(result.kind).toBe("provisioned");
    if (result.kind !== "provisioned") throw new Error("unreachable");
    expect(result.seeded).toBe(false);
    expect(result.seedSkipReason).toContain("ANTHROPIC_API_KEY");
    expect(lines.some((line) => line.includes("ANTHROPIC_API_KEY"))).toBe(true);
  });

  test("zero principals without a display name: returns needs-onboarding and creates nothing", async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    let tenantsPosted = 0;
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return {
          status: 200,
          data: { data: [], nextCursor: null },
          cookies: [],
        };
      }
      if (method === "POST" && path === "/api/tenants") {
        tenantsPosted += 1;
        throw new Error("must not create without a display name");
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      userEmailVerified: true,
      pushWorkflow: noopPush,
      log,
    });

    expect(result).toEqual({ kind: "needs-onboarding" });
    expect(tenantsPosted).toBe(0);
  });

  test("zero principals with a seed model configured: provisions under the operator tenant and seeds the default workflow", async () => {
    const { api, tarballPuts } = firstLoginSeedHub({
      expectedParentId: "ten_operator",
    });
    const { log } = collector();
    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      userEmailVerified: true,
      displayName: "Alice's Lab",
      operatorTenantId: "ten_operator",
      seedModel: MODEL,
      pushWorkflow: noopPush,
      log,
    });

    expect(result).toEqual({
      kind: "provisioned",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      seeded: true,
    });
    expect(tarballPuts).toEqual([]);
  });

  test("an unparented personal root bench does not publish corbits-tools; provision only deploys workflows", async () => {
    const { api, tarballPuts } = firstLoginSeedHub({});
    const { log } = collector();
    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      userEmailVerified: true,
      displayName: "Alice's Lab",
      seedModel: MODEL,
      pushWorkflow: noopPush,
      log,
    });

    expect(result).toEqual({
      kind: "provisioned",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      seeded: true,
    });
    expect(tarballPuts).toEqual([]);
  });

  test("a retry after tenant creation succeeded but seeding failed re-seeds instead of reporting a plain existing member", async () => {
    let assetCreateAttempts = 0;
    const startedRuns: string[] = [];
    let tenantCreated = false;

    const membership = () => ({
      status: 200,
      data: {
        data: tenantCreated
          ? [
              {
                principalId: PRINCIPAL_ID,
                tenantId: TENANT_ID,
                tenantName: "alice's workbench",
                tenantSlug: TENANT_SLUG,
                kind: "user",
                status: "active",
                roles: [{ id: "rol_owner", name: "owner" }],
              },
            ]
          : [],
        nextCursor: null,
      },
      cookies: [],
    });

    const api: ApiCall = async (method, path, body) => {
      const registry = corbitsToolsRegistryResponse(
        method,
        path,
        TENANT_ID,
        "missing",
      );
      if (registry !== undefined) return registry;
      if (method === "GET" && path === "/api/me/principals") {
        return membership();
      }
      if (method === "POST" && path === "/api/tenants") {
        tenantCreated = true;
        const parsed = body as { slug: string };
        return {
          status: 201,
          data: {
            id: TENANT_ID,
            name: "alice's workbench",
            slug: parsed.slug,
            domain: `${parsed.slug}.localhost`,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return {
          status: 200,
          data: {
            id: TENANT_ID,
            name: "alice's workbench",
            slug: TENANT_SLUG,
            domain: `${TENANT_SLUG}.localhost`,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      ) {
        return {
          status: 200,
          data: { data: [], nextCursor: null },
          cookies: [],
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`) {
        return { status: 201, data: {}, cookies: [] };
      }
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        return { status: 200, data: [], cookies: [] };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`) {
        assetCreateAttempts += 1;
        if (assetCreateAttempts === 1) {
          // The first attempt's seeding fails right here, after the
          // tenant itself was already created above.
          return {
            status: 500,
            data: { error: "asset service unavailable" },
            cookies: [],
          };
        }
        return {
          status: 201,
          data: {
            id: "ast_1",
            tenantId: TENANT_ID,
            kind: "workflow",
            name: "echo",
            displayName: null,
            creatorPrincipalId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/git-tokens`
      ) {
        return {
          status: 201,
          data: { id: "tok_1", secret: "s3cret" },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/skills/`)
      ) {
        return { status: 404, data: {}, cookies: [] };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/skills`) {
        return { status: 201, data: {}, cookies: [] };
      }
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        return { status: 200, data: [], cookies: [] };
      }
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
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (
        method === "PUT" &&
        path === `/api/tenants/${TENANT_ID}/agent-definitions/wfd_digest/status`
      ) {
        return {
          status: 200,
          data: { id: "wfd_digest", status: "stopped" },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return { status: 200, data: [], cookies: [] };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return {
          status: 201,
          data: {
            id: DEPLOYMENT_ID,
            tenantId: TENANT_ID,
            definitionAssetId: "ast_1",
            status: "deployed",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/${DEPLOYMENT_ID}/runs`
      ) {
        return {
          status: 200,
          data: { runIds: [...startedRuns] },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/${DEPLOYMENT_ID}/mail`
      ) {
        const runId = `run_${startedRuns.length + 1}`;
        startedRuns.push(runId);
        return {
          status: 202,
          data: {
            runId: DEPLOYMENT_ID,
            address: "echo@x",
            messageId: `m${startedRuns.length}`,
          },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const firstAttempt = provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      userEmailVerified: true,
      displayName: "Alice's Lab",
      seedModel: MODEL,
      pushWorkflow: noopPush,
      log: collector().log,
    });
    await expect(firstAttempt).rejects.toThrow(/asset service unavailable/);
    expect(tenantCreated).toBe(true);

    const { log } = collector();
    const retry = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      userEmailVerified: true,
      seedModel: MODEL,
      pushWorkflow: noopPush,
      log,
    });

    expect(retry).toEqual({
      kind: "existing-member",
      seeded: true,
      tenantId: "ten_new",
    });
    // Attempt 1 fails creating the (only) default workflow's asset. The
    // retry re-runs from scratch: one create call for the default set
    // (assistant, CL-7074), on top of the one failed attempt.
    expect(assetCreateAttempts).toBe(2);
  });

  test("a fully seeded personal bench reports existing-member with seeded: true, and backfills a grant added to SEED_GRANTS after it was provisioned", async () => {
    // Every default workflow already has an active deployment — nothing
    // for this hook to do on the workflow side, but the caller must be
    // able to tell "already seeded" apart from "seeded and unseeded look
    // identical," which is exactly the ambiguity that hid the
    // bench_unseeded defect. This tenant also stands in for CL-6475: it
    // was provisioned before eval-run:*/read existed (CL-6465 added it),
    // so every grant except that one is already planted. The "fully
    // seeded" workflow check must never short-circuit past reconciling
    // it in.
    const missingGrant = { resource: "eval-run:*", action: "read" };
    const alreadyGranted = SEED_GRANTS.filter(
      (g) =>
        !(
          g.resource === missingGrant.resource &&
          g.action === missingGrant.action
        ),
    );
    const grantsPosted: { resource: string; action: string }[] = [];
    const api: ApiCall = async (method, path, body) => {
      const registry = corbitsToolsRegistryResponse(method, path, TENANT_ID, [
        SEEDED_MEMORY_TARBALL,
      ]);
      if (registry !== undefined) return registry;
      if (method === "GET" && path === "/api/me/principals") {
        return {
          status: 200,
          data: {
            data: [
              {
                principalId: PRINCIPAL_ID,
                tenantId: TENANT_ID,
                tenantName: "alice's workbench",
                tenantSlug: TENANT_SLUG,
                kind: "user",
                status: "active",
                roles: [{ id: "rol_owner", name: "owner" }],
              },
            ],
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      ) {
        const resource = new URL(`http://x${path}`).searchParams.get(
          "resource",
        );
        const rows = alreadyGranted
          .filter((g) => g.resource === resource)
          .map((g, index) => ({
            id: `grt_${resource}_${index}`,
            tenantId: TENANT_ID,
            principalId: PRINCIPAL_ID,
            resource: g.resource,
            action: g.action,
            effect: "allow",
            origin: "creator",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }));
        return {
          status: 200,
          data: { data: rows, nextCursor: null },
          cookies: [],
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`) {
        const grant = body as { resource: string; action: string };
        grantsPosted.push({ resource: grant.resource, action: grant.action });
        return { status: 201, data: {}, cookies: [] };
      }
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        return {
          status: 200,
          data: DEFAULT_WORKFLOWS.map((workflow, index) => ({
            id: `ast_${index}`,
            tenantId: TENANT_ID,
            kind: "workflow",
            name: workflow.assetName,
            displayName: workflow.displayName,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            origin: { tenantId: TENANT_ID, direct: true },
          })),
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return {
          status: 200,
          data: DEFAULT_WORKFLOWS.map((_workflow, index) => ({
            definitionAssetId: `ast_${index}`,
            status: "deployed",
          })),
          cookies: [],
        };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return {
          status: 200,
          data: {
            id: TENANT_ID,
            name: "alice's workbench",
            slug: TENANT_SLUG,
            domain: `${TENANT_SLUG}.localhost`,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      userEmailVerified: true,
      // No seedModel needed: nothing left to seed on the workflow side.
      pushWorkflow: noopPush,
      log: collector().log,
    });

    expect(result).toEqual({
      kind: "existing-member",
      seeded: true,
      tenantId: "ten_new",
    });
    // Exactly the one grant this tenant was missing — no more, no less.
    expect(grantsPosted).toEqual([missingGrant]);
  });

  test("a grant-reconcile failure is reported, not thrown -- sign-in still succeeds for a fully seeded bench", async () => {
    const api: ApiCall = async (method, path) => {
      const registry = corbitsToolsRegistryResponse(method, path, TENANT_ID, [
        SEEDED_MEMORY_TARBALL,
      ]);
      if (registry !== undefined) return registry;
      if (method === "GET" && path === "/api/me/principals") {
        return {
          status: 200,
          data: {
            data: [
              {
                principalId: PRINCIPAL_ID,
                tenantId: TENANT_ID,
                tenantName: "alice's workbench",
                tenantSlug: TENANT_SLUG,
                kind: "user",
                status: "active",
                roles: [{ id: "rol_owner", name: "owner" }],
              },
            ],
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      ) {
        // A transient hub failure while reconciling grants.
        return {
          status: 500,
          data: { error: "grants unavailable" },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        return {
          status: 200,
          data: DEFAULT_WORKFLOWS.map((workflow, index) => ({
            id: `ast_${index}`,
            tenantId: TENANT_ID,
            kind: "workflow",
            name: workflow.assetName,
            displayName: workflow.displayName,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            origin: { tenantId: TENANT_ID, direct: true },
          })),
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return {
          status: 200,
          data: DEFAULT_WORKFLOWS.map((_workflow, index) => ({
            definitionAssetId: `ast_${index}`,
            status: "deployed",
          })),
          cookies: [],
        };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return {
          status: 200,
          data: {
            id: TENANT_ID,
            name: "alice's workbench",
            slug: TENANT_SLUG,
            domain: `${TENANT_SLUG}.localhost`,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      userEmailVerified: true,
      pushWorkflow: noopPush,
      log: collector().log,
    });

    expect(result).toEqual({
      kind: "existing-member",
      seeded: true,
      tenantId: "ten_new",
    });
  });

  test("half-provisioned personal bench without a seed model returns existing-member (not stuck)", async () => {
    // Without ANTHROPIC_API_KEY the server has no seed model. Membership of a
    // personal bench must still resolve — recovery of "I have a bench" must
    // not depend on a seed credential that may never exist. Seeding itself is
    // skipped (nothing to seed with); the user is not stranded in a loop.
    let assetListCalls = 0;
    const api: ApiCall = async (method, path) => {
      const registry = corbitsToolsRegistryResponse(
        method,
        path,
        TENANT_ID,
        "missing",
      );
      if (registry !== undefined) return registry;
      if (method === "GET" && path === "/api/me/principals") {
        return {
          status: 200,
          data: {
            data: [
              {
                principalId: PRINCIPAL_ID,
                tenantId: TENANT_ID,
                tenantName: "alice's workbench",
                tenantSlug: TENANT_SLUG,
                kind: "user",
                status: "active",
                roles: [{ id: "rol_owner", name: "owner" }],
              },
            ],
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      ) {
        // Grant reconciliation runs regardless of seed-model
        // availability -- it needs no model, only the hub API.
        return {
          status: 200,
          data: { data: [], nextCursor: null },
          cookies: [],
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`) {
        return { status: 201, data: {}, cookies: [] };
      }
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        assetListCalls += 1;
        // Tenant-local assets empty — not fully seeded.
        return { status: 200, data: [], cookies: [] };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return { status: 200, data: [], cookies: [] };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return {
          status: 200,
          data: {
            id: TENANT_ID,
            name: "alice's workbench",
            slug: TENANT_SLUG,
            domain: `${TENANT_SLUG}.localhost`,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      userEmailVerified: true,
      // No seedModel — hub without ANTHROPIC_API_KEY.
      pushWorkflow: noopPush,
      log: collector().log,
    });

    // seeded: false is the typed bench_unseeded condition — the caller
    // has a real membership, but the onboarding UI must keep the
    // credential step open rather than read this as finished setup.
    expect(result).toEqual({
      kind: "existing-member",
      seeded: false,
      tenantId: "ten_new",
    });
    // Completeness was checked (tenant-local assets listed) even without a
    // seed model — membership recovery does not short-circuit before that.
    expect(assetListCalls).toBe(1);
  });

  test("isFullySeeded lists tenant-local assets only (inherited=false)", async () => {
    // Root-tenant trees can surface the parent's workflow assets when
    // listing with inherited=true. Those must not satisfy the seed check —
    // only tenant-local assets count. Assert the query uses inherited=false
    // and that empty local assets trigger a re-seed when a seed model exists.
    let listedInherited = false;
    let listedLocal = false;
    let assetCreateCount = 0;
    const startedRuns: string[] = [];

    const api: ApiCall = async (method, path, body) => {
      const registry = corbitsToolsRegistryResponse(
        method,
        path,
        TENANT_ID,
        "missing",
      );
      if (registry !== undefined) return registry;
      if (method === "GET" && path === "/api/me/principals") {
        return {
          status: 200,
          data: {
            data: [
              {
                principalId: PRINCIPAL_ID,
                tenantId: TENANT_ID,
                tenantName: "alice's workbench",
                tenantSlug: TENANT_SLUG,
                kind: "user",
                status: "active",
                roles: [{ id: "rol_owner", name: "owner" }],
              },
            ],
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return {
          status: 200,
          data: {
            id: TENANT_ID,
            name: "alice's workbench",
            slug: TENANT_SLUG,
            domain: `${TENANT_SLUG}.localhost`,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      ) {
        return {
          status: 200,
          data: { data: [], nextCursor: null },
          cookies: [],
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`) {
        return { status: 201, data: {}, cookies: [] };
      }
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        listedLocal = true;
        return { status: 200, data: [], cookies: [] };
      }
      if (
        method === "GET" &&
        path.includes("kind=workflow") &&
        path.includes("inherited=true")
      ) {
        listedInherited = true;
        throw new Error("must not list inherited assets for seed completeness");
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`) {
        assetCreateCount += 1;
        const name =
          typeof body === "object" &&
          body !== null &&
          "name" in body &&
          typeof (body as { name: unknown }).name === "string"
            ? (body as { name: string }).name
            : `wf_${assetCreateCount}`;
        return {
          status: 201,
          data: {
            id: `ast_${assetCreateCount}`,
            tenantId: TENANT_ID,
            kind: "workflow",
            name,
            displayName: null,
            creatorPrincipalId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/git-tokens`
      ) {
        return {
          status: 201,
          data: { id: "tok_1", secret: "s3cret" },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/skills/`)
      ) {
        return { status: 404, data: {}, cookies: [] };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/skills`) {
        return { status: 201, data: {}, cookies: [] };
      }
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        return { status: 200, data: [], cookies: [] };
      }
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
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (
        method === "PUT" &&
        path === `/api/tenants/${TENANT_ID}/agent-definitions/wfd_digest/status`
      ) {
        return {
          status: 200,
          data: { id: "wfd_digest", status: "stopped" },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return { status: 200, data: [], cookies: [] };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return {
          status: 201,
          data: {
            id: DEPLOYMENT_ID,
            tenantId: TENANT_ID,
            definitionAssetId: `ast_${assetCreateCount}`,
            status: "deployed",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/${DEPLOYMENT_ID}/runs`
      ) {
        return {
          status: 200,
          data: { runIds: [...startedRuns] },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/${DEPLOYMENT_ID}/mail`
      ) {
        const runId = `run_${startedRuns.length + 1}`;
        startedRuns.push(runId);
        return {
          status: 202,
          data: {
            runId: DEPLOYMENT_ID,
            address: "echo@x",
            messageId: `m${startedRuns.length}`,
          },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      userEmailVerified: true,
      seedModel: MODEL,
      pushWorkflow: noopPush,
      log: collector().log,
    });

    expect(listedLocal).toBe(true);
    expect(listedInherited).toBe(false);
    // Empty tenant-local assets must re-seed, not claim "already seeded"
    // from an ancestor's inherited catalog.
    expect(result).toEqual({
      kind: "existing-member",
      seeded: true,
      tenantId: "ten_new",
    });
    expect(assetCreateCount).toBeGreaterThan(0);
  });

  test("a tenant with zero workflow definitions recovers a live assistant deployment on sign-in (CL-6510)", async () => {
    // Reproduces the live bug verbatim: a personal bench with a real
    // membership and 0 rows in workflow_definition — exactly
    // tnt_b780a4d8050c8d679f107642809ab7ab's shape — hitting sign-in
    // with a seed model configured. The bar this test holds itself to:
    // not "seedTenant was called", but that the same read the app's own
    // `/provisioning-status` route and `findMyraDefinition` depend on
    // (an "assistant"-named asset with a live deployment) is genuinely
    // there afterward.
    const assets: { id: string; name: string }[] = [];
    const deployments: { id: string; definitionAssetId: string }[] = [];
    const startedRuns: Record<string, string[]> = {};

    const api: ApiCall = async (method, path, body) => {
      const registry = corbitsToolsRegistryResponse(
        method,
        path,
        TENANT_ID,
        "missing",
      );
      if (registry !== undefined) return registry;
      if (method === "GET" && path === "/api/me/principals") {
        return {
          status: 200,
          data: {
            data: [
              {
                principalId: PRINCIPAL_ID,
                tenantId: TENANT_ID,
                tenantName: "alice's team",
                tenantSlug: TENANT_SLUG,
                kind: "user",
                status: "active",
                roles: [{ id: "rol_owner", name: "owner" }],
              },
            ],
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return {
          status: 200,
          data: {
            id: TENANT_ID,
            name: "alice's team",
            slug: TENANT_SLUG,
            domain: `${TENANT_SLUG}.localhost`,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      ) {
        return {
          status: 200,
          data: { data: [], nextCursor: null },
          cookies: [],
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`) {
        return { status: 201, data: {}, cookies: [] };
      }
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        // 0 rows, exactly like the live tenant, until seedTenant creates
        // some — every subsequent read reflects whatever exists so far.
        return {
          status: 200,
          data: assets.map((asset) => ({
            id: asset.id,
            tenantId: TENANT_ID,
            kind: "workflow",
            name: asset.name,
            displayName: null,
            creatorPrincipalId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            origin: { tenantId: TENANT_ID, direct: true },
          })),
          cookies: [],
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`) {
        const name =
          typeof body === "object" && body !== null && "name" in body
            ? String((body as { name: unknown }).name)
            : `wf_${assets.length + 1}`;
        const asset = { id: `ast_${assets.length + 1}`, name };
        assets.push(asset);
        return {
          status: 201,
          data: {
            id: asset.id,
            tenantId: TENANT_ID,
            kind: "workflow",
            name,
            displayName: null,
            creatorPrincipalId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/git-tokens`
      ) {
        return {
          status: 201,
          data: { id: "tok_1", secret: "s3cret" },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/skills/`)
      ) {
        return { status: 404, data: {}, cookies: [] };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/skills`) {
        return { status: 201, data: {}, cookies: [] };
      }
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
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (
        method === "PUT" &&
        path === `/api/tenants/${TENANT_ID}/agent-definitions/wfd_digest/status`
      ) {
        return {
          status: 200,
          data: { id: "wfd_digest", status: "stopped" },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return {
          status: 200,
          data: deployments.map((deployment) => ({
            id: deployment.id,
            tenantId: TENANT_ID,
            definitionAssetId: deployment.definitionAssetId,
            status: "deployed",
            createdAt: "2026-01-01T00:00:00.000Z",
          })),
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        const definitionAssetId =
          assets[assets.length - 1]?.id ?? "ast_unknown";
        const deployment = {
          id: `dep_${deployments.length + 1}`,
          definitionAssetId,
        };
        deployments.push(deployment);
        startedRuns[deployment.id] = [];
        return {
          status: 201,
          data: {
            id: deployment.id,
            tenantId: TENANT_ID,
            definitionAssetId,
            status: "deployed",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      const runsMatch =
        /^\/api\/tenants\/ten_new\/workflows\/(dep_\d+)\/runs$/.exec(path);
      if (method === "GET" && runsMatch) {
        const deploymentId = runsMatch[1] as string;
        return {
          status: 200,
          data: { runIds: [...(startedRuns[deploymentId] ?? [])] },
          cookies: [],
        };
      }
      const mailMatch =
        /^\/api\/tenants\/ten_new\/workflows\/(dep_\d+)\/mail$/.exec(path);
      if (method === "POST" && mailMatch) {
        const deploymentId = mailMatch[1] as string;
        const runId = `run_${(startedRuns[deploymentId]?.length ?? 0) + 1}`;
        startedRuns[deploymentId] = [
          ...(startedRuns[deploymentId] ?? []),
          runId,
        ];
        return {
          status: 202,
          data: { runId: deploymentId, address: "x@x", messageId: runId },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    // Confirm the bug is real before recovering from it: no assistant
    // asset, no live deployment.
    const before = await isFullySeeded(api, ["session=abc"], TENANT_ID);
    expect(before).toBe(false);

    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      userEmailVerified: true,
      seedModel: MODEL,
      pushWorkflow: noopPush,
      log: collector().log,
    });

    expect(result).toEqual({
      kind: "existing-member",
      seeded: true,
      tenantId: TENANT_ID,
    });

    // The verification bar: the same read `findMyraDefinition` and the
    // `/provisioning-status` route's `setupAgentReady` depend on now
    // resolves the assistant, not merely "seedTenant ran".
    const status = await seededWorkflowStatus(api, ["session=abc"], TENANT_ID);
    expect(status.deployed).toContain(SETUP_AGENT_ASSET_NAME);
    expect(status.pending).not.toContain(SETUP_AGENT_ASSET_NAME);
  });

  test("isFullySeeded is false when corbits-tools exists but has no tarballs", async () => {
    const api: ApiCall = async (method, path) => {
      const registry = corbitsToolsRegistryResponse(
        method,
        path,
        TENANT_ID,
        [],
      );
      if (registry !== undefined) return registry;
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        return {
          status: 200,
          data: DEFAULT_WORKFLOWS.map((workflow, index) => ({
            id: `ast_${index}`,
            tenantId: TENANT_ID,
            kind: "workflow",
            name: workflow.assetName,
            displayName: workflow.displayName,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            origin: { tenantId: TENANT_ID, direct: true },
          })),
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return {
          status: 200,
          data: DEFAULT_WORKFLOWS.map((_workflow, index) => ({
            definitionAssetId: `ast_${index}`,
            status: "deployed",
          })),
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    expect(await isFullySeeded(api, ["session=abc"], TENANT_ID)).toBe(false);
  });

  test("isFullySeeded is true when workflows are live and corbits-tools carries memory-tools", async () => {
    const api: ApiCall = async (method, path) => {
      const registry = corbitsToolsRegistryResponse(method, path, TENANT_ID, [
        SEEDED_MEMORY_TARBALL,
      ]);
      if (registry !== undefined) return registry;
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        return {
          status: 200,
          data: DEFAULT_WORKFLOWS.map((workflow, index) => ({
            id: `ast_${index}`,
            tenantId: TENANT_ID,
            kind: "workflow",
            name: workflow.assetName,
            displayName: workflow.displayName,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            origin: { tenantId: TENANT_ID, direct: true },
          })),
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return {
          status: 200,
          data: DEFAULT_WORKFLOWS.map((_workflow, index) => ({
            definitionAssetId: `ast_${index}`,
            status: "deployed",
          })),
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    expect(await isFullySeeded(api, ["session=abc"], TENANT_ID)).toBe(true);
  });

  test("sign-in does not republish an empty inherited corbits-tools registry", async () => {
    const api: ApiCall = async (method, path) => {
      const registry = corbitsToolsRegistryResponse(
        method,
        path,
        TENANT_ID,
        [],
      );
      if (registry !== undefined) return registry;
      if (method === "GET" && path === "/api/me/principals") {
        return {
          status: 200,
          data: {
            data: [
              {
                principalId: PRINCIPAL_ID,
                tenantId: TENANT_ID,
                tenantName: "alice's workbench",
                tenantSlug: TENANT_SLUG,
                kind: "user",
                status: "active",
                roles: [{ id: "rol_owner", name: "owner" }],
              },
            ],
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      ) {
        return {
          status: 200,
          data: { data: [], nextCursor: null },
          cookies: [],
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`) {
        return { status: 201, data: {}, cookies: [] };
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return {
          status: 200,
          data: {
            id: TENANT_ID,
            name: "alice's workbench",
            slug: TENANT_SLUG,
            domain: `${TENANT_SLUG}.localhost`,
            parentId: "ten_operator",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        return {
          status: 200,
          data: DEFAULT_WORKFLOWS.map((workflow, index) => ({
            id: `ast_${index}`,
            tenantId: TENANT_ID,
            kind: "workflow",
            name: workflow.assetName,
            displayName: workflow.displayName,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            origin: { tenantId: TENANT_ID, direct: true },
          })),
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return {
          status: 200,
          data: DEFAULT_WORKFLOWS.map((_workflow, index) => ({
            definitionAssetId: `ast_${index}`,
            status: "deployed",
          })),
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await provisionPersonalTenantIfNeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      userEmailVerified: true,
      pushWorkflow: noopPush,
      log: collector().log,
    });

    expect(result).toEqual({
      kind: "existing-member",
      seeded: false,
      tenantId: TENANT_ID,
    });
  });
});
