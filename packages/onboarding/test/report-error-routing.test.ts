// CL-7234: every caught failure in this package's routes, background
// drain, and env-credential-plant paths must reach @corbits/error-sink's
// reportError with the operation/tenant context it expects — the same
// precedent ../src/provision.ts already sets. This mocks
// @corbits/error-sink and dynamically imports each module under test
// afterward (the same recipe packages/workflow-deploy-source and
// packages/webhook-triggers already use for this exact kind of
// assertion), since a static top-level import would bind the real
// module before any mock could apply.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppEnv } from "@intx/hub-api";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createNoopCredentialCipher } from "@intx/crypto";

let reportErrorCalls: [unknown, Record<string, unknown>][] = [];
beforeEach(async () => {
  reportErrorCalls = [];
  await mock.module("@corbits/error-sink", () => ({
    reportError: (error: unknown, context: Record<string, unknown>) => {
      reportErrorCalls.push([error, context]);
      return "ref_test";
    },
  }));
});
afterEach(() => {
  mock.restore();
});

const { createOnboardingRoutes } = await import("../src/routes");
const { createInMemoryPendingSeedStore } = await import("../src/pending-seed");
const { createBenchProvisioner } = await import("../src/bench-provisioning");
const { plantEnvProviderCredentials } =
  await import("../src/plant-env-credentials");

const pendingSeedStore = createInMemoryPendingSeedStore(
  createNoopCredentialCipher(),
);

const asUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", { id: "user_1", email: "user_1@example.com" } as never);
  await next();
};

function mountAuthenticated(routes: Hono<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", asUser);
  app.route("/", routes);
  return app;
}

describe("routes.ts routes caught errors through reportError", () => {
  test("a failure with no tenant known yet reports operation + userId, no tenantId", async () => {
    const routes = createOnboardingRoutes({
      hubUrl: "http://127.0.0.1:0",
      pushWorkflow: async () => ({
        outcome: "pushed" as const,
        commitSha: "a".repeat(40),
      }),
      log: () => undefined,
      pendingSeedStore,
    });
    const app = mountAuthenticated(routes);

    const response = await app.request("/provision", { method: "POST" });

    expect(response.status).toBe(503);
    expect(reportErrorCalls).toHaveLength(1);
    const [, context] = reportErrorCalls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(context.operation).toBe("onboarding_provision");
    expect(context.tenantId).toBeUndefined();
    expect((context.extra as { userId: string }).userId).toBe("user_1");
  });

  test("a provisioning-status failure after the tenant is found reports its tenantId", async () => {
    // Matches complete-setup-routes.test.ts's fixture shape exactly:
    // personalTenantSlug("user_1@example.com", "user_1") === "user-1-user1".
    const TENANT_ID = "ten_1";
    const TENANT_SLUG = "user-1-user1";
    const hub = new Hono();
    hub.get("/api/me/principals", (c) =>
      c.json({
        data: [
          {
            principalId: "prn_1",
            tenantId: TENANT_ID,
            tenantName: "user_1's workbench",
            tenantSlug: TENANT_SLUG,
            kind: "user",
            status: "active",
            roles: [],
          },
        ],
        nextCursor: null,
      }),
    );
    hub.get(`/api/tenants/${TENANT_ID}`, (c) =>
      c.json({
        id: TENANT_ID,
        name: "user_1's workbench",
        slug: TENANT_SLUG,
        domain: "user-1-user1.bench.local",
        parentId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    // Malformed on purpose: seededWorkflowNames' own parseAs rejects this,
    // throwing well after tenantId is already known.
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) =>
      c.json({ notAnArray: true }),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const routes = createOnboardingRoutes({
        hubUrl: `http://localhost:${server.port}`,
        pushWorkflow: async () => ({
          outcome: "pushed" as const,
          commitSha: "a".repeat(40),
        }),
        log: () => undefined,
        pendingSeedStore,
      });
      const app = mountAuthenticated(routes);

      const response = await app.request("/provisioning-status");

      expect(response.status).toBe(500);
      expect(reportErrorCalls).toHaveLength(1);
      const [, context] = reportErrorCalls[0] as [
        unknown,
        Record<string, unknown>,
      ];
      expect(context.operation).toBe("onboarding_provisioning_status");
      expect(context.tenantId).toBe(TENANT_ID);
      expect((context.extra as { userId: string }).userId).toBe("user_1");
    } finally {
      server.stop(true);
    }
  });
});

describe("bench-provisioning.ts's whole-drain failure reports through reportError", () => {
  test("a listDue failure (not scoped to any one bench) reports operation only", async () => {
    const provisioner = createBenchProvisioner({
      api: (async () => {
        throw new Error("unused");
      }) as unknown as Parameters<typeof createBenchProvisioner>[0]["api"],
      hubUrl: "https://bench.example.com",
      store: {
        listDue: async () => {
          throw new Error("db unreachable");
        },
        read: async () => undefined,
        put: async () => undefined,
        clear: async () => undefined,
      },
      pushWorkflow: async () => ({
        outcome: "pushed" as const,
        commitSha: "a".repeat(40),
      }),
      sessionFor: async () => ["better-auth.session_token=minted"],
      log: () => undefined,
    });

    provisioner.wake();
    // wake() is fire-and-forget; give its internal drainOnce().catch a
    // turn to run before asserting.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(reportErrorCalls).toHaveLength(1);
    const [, context] = reportErrorCalls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(context.operation).toBe("bench_provisioning_drain");
    expect(context.tenantId).toBeUndefined();
  });
});

describe("plant-env-credentials.ts catches report through reportError and never leak the raw cause", () => {
  // No existing provider row for any credential this test plants — the
  // real network calls `findProviderId`/`findActiveCredential` make
  // aren't overridable test seams, so the fake `api` has to answer them
  // honestly (empty pages) to reach the seedCatalogFn override at all.
  const noExistingProvidersApi: Parameters<
    typeof plantEnvProviderCredentials
  >[0]["api"] = async (_method, path) => {
    if (path.includes("/providers")) {
      return { status: 200, data: { data: [], nextCursor: null }, cookies: [] };
    }
    throw new Error(`unexpected call in test fake: ${path}`);
  };

  test("a catalog-plant failure reports tenantId + provider, and sanitizes a secret-shaped cause message", async () => {
    const outcomes = await plantEnvProviderCredentials({
      api: noExistingProvidersApi,
      cookies: [],
      tenantId: "tnt_env",
      envProviderKeys: { anthropic: "sk-ant-real-secret-value-123456" },
      log: () => undefined,
      testCredential: async () => ({ ok: true }),
      seedCatalogFn: async () => {
        throw new Error("seed failed for key sk-ant-real-secret-value-123456");
      },
    });

    expect(outcomes).toEqual([
      {
        provider: "anthropic",
        status: "failed",
        message: expect.stringContaining("[redacted]") as unknown as string,
      },
    ]);
    expect(outcomes[0]?.message).not.toContain("sk-ant-real-secret-value");

    expect(reportErrorCalls).toHaveLength(1);
    const [cause, context] = reportErrorCalls[0] as [
      unknown,
      Record<string, unknown>,
    ];
    expect(context.operation).toBe("env_credential_plant");
    expect(context.tenantId).toBe("tnt_env");
    expect(context.extra).toEqual({ provider: "anthropic" });
    // reportError itself is the one place the unredacted cause is
    // still allowed to travel — error-sink does its own redaction pass
    // before anything reaches a log sink.
    expect(cause).toBeInstanceOf(Error);
  });
});

describe("recentlyConnectedCredential reports through reportError and still finds nothing", () => {
  test("a hub failure during duplicate-callback recovery reports operation + userId and still ends as state_expired", async () => {
    // A principals page arktype will reject, with the secret in a union
    // field so the parse summary echoes it. `not.toContain` is otherwise a
    // tautology — a type-mismatch summary is `was string` and never
    // mentions the value (CL-7255).
    const SECRET = "sk-or-v1-thisisafakesecretvalue";
    const logs: string[] = [];
    const hub = new Hono();
    hub.get("/api/me/principals", (c) =>
      c.json({
        data: [
          {
            principalId: "prn_1",
            tenantId: "ten_1",
            tenantName: "user_1's workbench",
            tenantSlug: "user-1-user1",
            kind: SECRET,
            status: "active",
            roles: [],
          },
        ],
        nextCursor: null,
      }),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const routes = createOnboardingRoutes({
        hubUrl: `http://localhost:${server.port}`,
        pushWorkflow: async () => ({
          outcome: "pushed" as const,
          commitSha: "a".repeat(40),
        }),
        log: (line) => {
          logs.push(line);
        },
        pendingSeedStore,
      });
      const app = mountAuthenticated(routes);

      const response = await app.request(
        "/oauth/openrouter/callback?code=auth_code_1",
        {
          headers: {
            cookie: "workbench_openrouter_connect=not-a-real-state",
          },
        },
      );

      expect(response.status).toBe(302);
      const redirect = new URL(
        response.headers.get("location") ?? "",
        "https://x",
      );
      expect(redirect.searchParams.get("outcome")).toBe("error");
      expect(redirect.searchParams.get("code")).toBe("state_expired");

      expect(reportErrorCalls).toHaveLength(1);
      const [cause, context] = reportErrorCalls[0] as [
        unknown,
        Record<string, unknown>,
      ];
      expect(context.operation).toBe("onboarding_duplicate_callback_recovery");
      expect(context.tenantId).toBeUndefined();
      expect((context.extra as { userId: string }).userId).toBe("user_1");
      // reportError is the one place the unredacted cause may travel —
      // error-sink redacts before anything reaches a log sink.
      expect(cause).toBeInstanceOf(Error);
      const causeMessage =
        cause instanceof Error ? cause.message : String(cause);
      expect(causeMessage).toContain(SECRET);
      expect(JSON.stringify({ logs, context })).not.toContain(SECRET);
    } finally {
      server.stop(true);
    }
  });
});
