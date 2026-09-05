// "Connecting should deploy nothing" (CL-6457), asserted at the route
// layer. The live repro: pasting a key sat on "Connecting…" for 2+
// minutes because `POST /complete` deployed five default workflows —
// ~20s each — before it answered. The fix is structural, so the test is
// too: the deploy step is handed in as a seam that takes five seconds
// and records when it ran, and the route has to answer long before it
// could possibly have waited on that. A route that ever awaits a deploy
// again fails here on the clock, not on a mock's call count alone.
import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@intx/hub-api";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import type { CredentialCipher } from "@intx/types";
import { DEFAULT_WORKFLOWS, SETUP_AGENT_ASSET_NAME } from "@corbits/seeding";
import { createOnboardingRoutes } from "../src/routes";
import {
  createInMemoryPendingSeedStore,
  type PendingSeedStore,
} from "../src/pending-seed";

const TEST_KEY = Buffer.alloc(32, 44);
function testCipher(): CredentialCipher {
  return createEnvKeyCredentialCipher(TEST_KEY);
}

const TENANT_ID = "ten_1";
const PRINCIPAL_ID = "prn_1";
const TENANT_SLUG = "user-1-user1";
const TENANT_DOMAIN = "user-1-user1.bench.local";
const ALL_WORKFLOWS = DEFAULT_WORKFLOWS.map((workflow) => workflow.assetName);

function asUser(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("user", { id: "user_1", email: "user_1@example.com" } as never);
    await next();
  };
}

/** A hub that answers only the reads the fast half performs. Any deploy
 * traffic would have to go somewhere else entirely — and the deploy seam
 * below proves it never even starts. */
function fakeHub(args: { seededWorkflows?: string[] } = {}) {
  const seeded = args.seededWorkflows ?? [];
  const hub = new Hono();
  const requests: string[] = [];
  hub.use("*", async (c, next) => {
    requests.push(`${c.req.method} ${new URL(c.req.url).pathname}`);
    await next();
  });
  hub.get("/api/me/principals", (c) =>
    c.json({
      data: [
        {
          principalId: PRINCIPAL_ID,
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
  hub.get("/api/tenants/:id", (c) =>
    c.json({
      id: TENANT_ID,
      name: "user_1's workbench",
      slug: TENANT_SLUG,
      domain: TENANT_DOMAIN,
      parentId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  hub.get("/api/tenants/:id/assets", (c) =>
    c.json(
      seeded.map((name, index) => ({
        id: `ast_${index}`,
        tenantId: TENANT_ID,
        kind: "workflow",
        name,
        displayName: name,
        creatorPrincipalId: PRINCIPAL_ID,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        origin: { tenantId: TENANT_ID, direct: true },
      })),
    ),
  );
  hub.get("/api/tenants/:id/workflows/deployments", (c) =>
    c.json(
      seeded.map((_name, index) => ({
        definitionAssetId: `ast_${index}`,
        status: "deployed",
      })),
    ),
  );
  return { hub, requests };
}

function routeDeps(args: {
  hubUrl: string;
  store: PendingSeedStore;
  onDeploy?: () => void;
  deployDelayMs?: number;
}) {
  return {
    hubUrl: args.hubUrl,
    pushWorkflow: async () => ({
      outcome: "pushed" as const,
      commitSha: "a".repeat(40),
    }),
    log: () => undefined,
    pendingSeedStore: args.store,
    testAndPersistCredentialFn: async () => ({
      kind: "connected" as const,
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      principalId: PRINCIPAL_ID,
      tenantDomain: TENANT_DOMAIN,
    }),
    ensureSeededFn: async () => {
      args.onDeploy?.();
      await new Promise((resolve) =>
        setTimeout(resolve, args.deployDelayMs ?? 0),
      );
      return { kind: "seeded" as const, workflows: ALL_WORKFLOWS };
    },
  };
}

function mountAuthenticated(routes: Hono<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", asUser());
  app.route("/api/onboarding", routes);
  return app;
}

describe("POST /complete — connecting deploys nothing", () => {
  test("answers in a moment even when a deploy would take five seconds", async () => {
    const { hub, requests } = fakeHub();
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const store = createInMemoryPendingSeedStore(testCipher());
    let deployStarted = false;
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({
            hubUrl: `http://localhost:${server.port}`,
            store,
            deployDelayMs: 5_000,
            onDeploy: () => {
              deployStarted = true;
            },
          }),
        ),
      );

      const startedAt = Date.now();
      const response = await app.request("/api/onboarding/complete", {
        method: "POST",
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-x" }),
        headers: { "content-type": "application/json" },
      });
      const elapsedMs = Date.now() - startedAt;

      expect(response.status).toBe(200);
      expect(elapsedMs).toBeLessThan(1_000);
      // The response never waited on a deploy — the whole point.
      expect(deployStarted).toBe(false);
      // And nothing deploy-shaped was even attempted against the hub.
      expect(
        requests.filter(
          (line) =>
            line.includes("/workflows/deployments") && line.startsWith("POST"),
        ),
      ).toEqual([]);
      expect(
        requests.filter((line) =>
          line.startsWith("POST /api/tenants/ten_1/assets"),
        ),
      ).toEqual([]);
    } finally {
      server.stop(true);
    }
  });

  test("reports the bench as provisioning, naming the agents still to come", async () => {
    const { hub } = fakeHub();
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const store = createInMemoryPendingSeedStore(testCipher());
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({ hubUrl: `http://localhost:${server.port}`, store }),
        ),
      );

      const response = await app.request("/api/onboarding/complete", {
        method: "POST",
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-x" }),
        headers: { "content-type": "application/json" },
      });
      const body = (await response.json()) as {
        kind: string;
        tenantSlug: string;
        deployed: string[];
        pending: string[];
      };

      expect(body.kind).toBe("provisioning");
      expect(body.tenantSlug).toBe(TENANT_SLUG);
      expect(body.deployed).toEqual([]);
      expect(body.pending).toEqual(ALL_WORKFLOWS);
    } finally {
      server.stop(true);
    }
  });

  test("hands the drain a pending row carrying the key it will deploy against", async () => {
    const { hub } = fakeHub();
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const store = createInMemoryPendingSeedStore(testCipher());
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({ hubUrl: `http://localhost:${server.port}`, store }),
        ),
      );

      await app.request("/api/onboarding/complete", {
        method: "POST",
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-x" }),
        headers: { "content-type": "application/json" },
      });

      expect(
        await store.read({ userId: "user_1", tenantId: TENANT_ID }),
      ).toEqual({
        userId: "user_1",
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_ID,
        tenantDomain: TENANT_DOMAIN,
        provider: "anthropic",
        apiKey: "sk-ant-x",
      });
    } finally {
      server.stop(true);
    }
  });

  test("an already-provisioned bench reconnecting reports ready, with nothing left pending", async () => {
    const { hub } = fakeHub({ seededWorkflows: ALL_WORKFLOWS });
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const store = createInMemoryPendingSeedStore(testCipher());
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({ hubUrl: `http://localhost:${server.port}`, store }),
        ),
      );

      const response = await app.request("/api/onboarding/complete", {
        method: "POST",
        body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-x" }),
        headers: { "content-type": "application/json" },
      });
      const body = (await response.json()) as {
        kind: string;
        pending: string[];
      };

      expect(body.kind).toBe("ready");
      expect(body.pending).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
});

describe("GET /provisioning-status", () => {
  // CL-7074 narrowed DEFAULT_WORKFLOWS to just the setup agent, so the
  // "some deployed, some still pending" progress bar this route used to
  // report (CL-6462, when the default set was echo/assistant/
  // workbench-digest) can no longer happen for a real bench: with one
  // default workflow, provisioning-status is binary — nothing deployed
  // yet (`provisioning`, setup agent not ready) or fully deployed
  // (`ready`). This test replaces the old two-test "partial progress"
  // coverage with that binary reality; `setupAgentReady` and
  // `kind: "ready"` are asserted at their other call sites below.
  test("reports provisioning, with the setup agent not yet ready, before she deploys", async () => {
    const { hub } = fakeHub({ seededWorkflows: [] });
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const store = createInMemoryPendingSeedStore(testCipher());
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({ hubUrl: `http://localhost:${server.port}`, store }),
        ),
      );

      const response = await app.request("/api/onboarding/provisioning-status");
      const body = (await response.json()) as {
        kind: string;
        setupAgentReady: boolean;
        deployed: string[];
        pending: string[];
      };

      expect(response.status).toBe(200);
      expect(body.kind).toBe("provisioning");
      expect(body.setupAgentReady).toBe(false);
      expect(body.deployed).toEqual([]);
      expect(body.pending).toEqual(ALL_WORKFLOWS);
    } finally {
      server.stop(true);
    }
  });

  test("a bench whose other workflows landed first is not reported as chat-ready", async () => {
    const others = ALL_WORKFLOWS.filter(
      (name) => name !== SETUP_AGENT_ASSET_NAME,
    );
    const { hub } = fakeHub({ seededWorkflows: others });
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const store = createInMemoryPendingSeedStore(testCipher());
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({ hubUrl: `http://localhost:${server.port}`, store }),
        ),
      );

      const response = await app.request("/api/onboarding/provisioning-status");
      const body = (await response.json()) as { setupAgentReady: boolean };

      expect(body.setupAgentReady).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("reports ready once every agent is live", async () => {
    const { hub } = fakeHub({ seededWorkflows: ALL_WORKFLOWS });
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const store = createInMemoryPendingSeedStore(testCipher());
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({ hubUrl: `http://localhost:${server.port}`, store }),
        ),
      );

      const response = await app.request("/api/onboarding/provisioning-status");
      const body = (await response.json()) as { kind: string };

      expect(body.kind).toBe("ready");
    } finally {
      server.stop(true);
    }
  });
});

describe("POST /complete-setup — no longer deploys inline either", () => {
  test("returns provisioning status without waiting on a deploy", async () => {
    const { hub } = fakeHub();
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const store = createInMemoryPendingSeedStore(testCipher());
    let deployStarted = false;
    try {
      await store.put({
        userId: "user_1",
        tenantId: TENANT_ID,
        principalId: PRINCIPAL_ID,
        tenantDomain: TENANT_DOMAIN,
        provider: "openrouter",
        apiKey: "sk-or-v1-minted",
      });
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({
            hubUrl: `http://localhost:${server.port}`,
            store,
            deployDelayMs: 5_000,
            onDeploy: () => {
              deployStarted = true;
            },
          }),
        ),
      );

      const startedAt = Date.now();
      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });
      const elapsedMs = Date.now() - startedAt;
      const body = (await response.json()) as { kind: string };

      expect(response.status).toBe(200);
      expect(elapsedMs).toBeLessThan(1_000);
      expect(deployStarted).toBe(false);
      expect(body.kind).toBe("provisioning");
      // The row stays: it is the drain's work item, not a spent token.
      expect(
        await store.read({ userId: "user_1", tenantId: TENANT_ID }),
      ).toBeDefined();
    } finally {
      server.stop(true);
    }
  });

  test("still reports unseeded when there is nothing to provision with yet", async () => {
    const { hub } = fakeHub();
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const store = createInMemoryPendingSeedStore(testCipher());
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes(
          routeDeps({ hubUrl: `http://localhost:${server.port}`, store }),
        ),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });
      const body = (await response.json()) as { kind: string };

      expect(body.kind).toBe("unseeded");
    } finally {
      server.stop(true);
    }
  });
});
