// `POST /complete-setup` reports where a bench stands; it never
// deploys. CL-6457 moved every workflow deploy onto the background
// drain in `../src/bench-provisioning.ts`, because a request that
// waits on deploys is the two-minute "Connecting…" onboarding was
// stuck behind. What is left here is a status reporter over two cheap
// hub reads, and it has to answer three cases correctly: every default
// workflow live (`ready` — clear the pending row, the drain has
// nothing left to do), still deploying with a pending row parked
// (`provisioning` — nudge the drain and leave the row alone, it is the
// drain's durable work item), and nothing live with no row to work
// from (`unseeded`, a 200 and not an error, telling the caller to fall
// back to the ordinary credential step).
//
// The deploying itself — its idempotency, its retries, its
// half-provisioned recovery — is covered where it now lives, in
// `./bench-provisioning.test.ts`.
//
// CL-6031 moved the pending credential off the browser: what used to
// be a sealed HttpOnly cookie is now a row in
// `createInMemoryPendingSeedStore` (the same store shape
// `createDrizzlePendingSeedStore` gives Postgres — see
// `../src/pending-seed.test.ts` for that logic's own direct coverage),
// written by calling `store.put(...)` the way the OAuth callback would,
// instead of round-tripping a cookie header.
import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@intx/hub-api";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import type { CredentialCipher } from "@intx/types";
import { DEFAULT_WORKFLOWS } from "@corbits/seeding";
import { createOnboardingRoutes } from "../src/routes";
import {
  createInMemoryPendingSeedStore,
  type PendingSeedStore,
} from "../src/pending-seed";

const TEST_KEY = Buffer.alloc(32, 21);
function testCipher(): CredentialCipher {
  return createEnvKeyCredentialCipher(TEST_KEY);
}

const TENANT_ID = "ten_1";
const PRINCIPAL_ID = "prn_1";
const TENANT_SLUG = "user-1-user1";
const TENANT_DOMAIN = "user-1-user1.bench.local";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function asUser(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("user", { id: "user_1", email: "user_1@example.com" } as never);
    await next();
  };
}

function mountAuthenticated(routes: Hono<AppEnv>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", asUser());
  app.route("/api/onboarding", routes);
  return app;
}

function principalsRoute(hub: Hono) {
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
  hub.get(`/api/tenants/${TENANT_ID}`, (c) =>
    c.json({
      id: TENANT_ID,
      name: "user_1's workbench",
      slug: TENANT_SLUG,
      domain: TENANT_DOMAIN,
      parentId: null,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    }),
  );
}

async function withPendingSeed(
  store: PendingSeedStore,
  args: { userId?: string; ttlMs?: number } = {},
): Promise<void> {
  await store.put(
    {
      userId: args.userId ?? "user_1",
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      tenantDomain: TENANT_DOMAIN,
      provider: "openrouter",
      apiKey: "sk-or-v1-minted",
    },
    args.ttlMs !== undefined ? { ttlMs: args.ttlMs } : {},
  );
}

describe("POST /complete-setup", () => {
  test("requires authentication", async () => {
    const app = new Hono<AppEnv>();
    app.route(
      "/api/onboarding",
      createOnboardingRoutes({
        hubUrl: "https://bench.example.com",
        pushWorkflow: async () => ({
          outcome: "pushed" as const,
          commitSha: "a".repeat(40),
        }),
        log: () => undefined,
        pendingSeedStore: createInMemoryPendingSeedStore(testCipher()),
      }),
    );

    const response = await app.request("/api/onboarding/complete-setup", {
      method: "POST",
    });

    expect(response.status).toBe(401);
  });

  test("no personal bench yet reports 409, not a fabricated seed", async () => {
    const hub = new Hono();
    hub.get("/api/me/principals", (c) =>
      c.json({ data: [], nextCursor: null }),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
          pendingSeedStore: createInMemoryPendingSeedStore(testCipher()),
        }),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("no_personal_bench");
    } finally {
      server.stop(true);
    }
  });

  test("an already fully seeded bench reports ready without needing a pending row", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) =>
      c.json(
        DEFAULT_WORKFLOWS.map((workflow, index) => ({
          id: `ast_${index}`,
          tenantId: TENANT_ID,
          kind: "workflow",
          name: workflow.assetName,
          displayName: workflow.displayName,
          creatorPrincipalId: PRINCIPAL_ID,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
          origin: { tenantId: TENANT_ID, direct: true },
        })),
      ),
    );
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json(
        DEFAULT_WORKFLOWS.map((_workflow, index) => ({
          definitionAssetId: `ast_${index}`,
          status: "deployed",
        })),
      ),
    );
    let ensureSeededCalls = 0;
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
          pendingSeedStore: createInMemoryPendingSeedStore(testCipher()),
          ensureSeededFn: async () => {
            ensureSeededCalls += 1;
            return { kind: "seeded", workflows: [] };
          },
        }),
      );

      // No pending-seed row at all — an already-seeded bench must
      // answer from the read alone, no pending row required.
      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        kind: string;
        tenantSlug: string;
        deployed: string[];
        pending: string[];
      };
      expect(body.kind).toBe("ready");
      expect(body.tenantSlug).toBe(TENANT_SLUG);
      expect(body.deployed.sort()).toEqual(
        DEFAULT_WORKFLOWS.map((w) => w.assetName).sort(),
      );
      expect(body.pending).toEqual([]);
      expect(ensureSeededCalls).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("unseeded with no pending row reports unseeded, not an error", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
          pendingSeedStore: createInMemoryPendingSeedStore(testCipher()),
        }),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string };
      expect(body.kind).toBe("unseeded");
    } finally {
      server.stop(true);
    }
  });

  test("a bench still deploying reports provisioning and never deploys inline", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const pendingSeedStore = createInMemoryPendingSeedStore(testCipher());
    try {
      let ensureSeededCalls = 0;
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
          pendingSeedStore,
          ensureSeededFn: async () => {
            ensureSeededCalls += 1;
            return { kind: "seeded", workflows: [] };
          },
        }),
      );
      await withPendingSeed(pendingSeedStore);

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        kind: string;
        tenantId: string;
        tenantSlug: string;
        setupAgentReady: boolean;
        deployed: string[];
        pending: string[];
      };
      expect(body).toEqual({
        kind: "provisioning",
        tenantId: TENANT_ID,
        tenantSlug: TENANT_SLUG,
        setupAgentReady: false,
        deployed: [],
        pending: DEFAULT_WORKFLOWS.map((w) => w.assetName),
      });
      // The point of CL-6457: a pending row in front of it is not a
      // licence to deploy on the request path. The seam still exists,
      // it just belongs to the drain now.
      expect(ensureSeededCalls).toBe(0);
      // And the row stays exactly where it is — it is the drain's
      // durable work item, not this request's scratch state.
      const stillThere = await pendingSeedStore.read({
        userId: "user_1",
        tenantId: TENANT_ID,
      });
      expect(stillThere).toBeDefined();
    } finally {
      server.stop(true);
    }
  });

  test("a still-provisioning bench nudges the drain instead of waiting on it", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const pendingSeedStore = createInMemoryPendingSeedStore(testCipher());
    try {
      let wakes = 0;
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
          pendingSeedStore,
          benchProvisioner: {
            wake: () => {
              wakes += 1;
            },
          },
        }),
      );
      await withPendingSeed(pendingSeedStore);

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string };
      expect(body.kind).toBe("provisioning");
      // Without the nudge a freshly parked row waits out the drain's
      // whole tick interval before anything happens — the reason a
      // waiting onboarding page calls this route at all.
      expect(wakes).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("an already fully seeded bench also clears a stray pending row, not just the never-written case", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) =>
      c.json(
        DEFAULT_WORKFLOWS.map((workflow, index) => ({
          id: `ast_${index}`,
          tenantId: TENANT_ID,
          kind: "workflow",
          name: workflow.assetName,
          displayName: workflow.displayName,
          creatorPrincipalId: PRINCIPAL_ID,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
          origin: { tenantId: TENANT_ID, direct: true },
        })),
      ),
    );
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json(
        DEFAULT_WORKFLOWS.map((_workflow, index) => ({
          definitionAssetId: `ast_${index}`,
          status: "deployed",
        })),
      ),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const pendingSeedStore = createInMemoryPendingSeedStore(testCipher());
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
          pendingSeedStore,
        }),
      );

      // The drain finished this bench a moment ago but its row is
      // still sitting there — a crash between the last deploy and the
      // clear, or a connect that parked a fresh row over an already
      // complete bench. A `ready` read is the authority: the row has no
      // work left in it and must not be left for the drain to pick up
      // again.
      await withPendingSeed(pendingSeedStore);

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string };
      expect(body.kind).toBe("ready");
      const stillThere = await pendingSeedStore.read({
        userId: "user_1",
        tenantId: TENANT_ID,
      });
      expect(stillThere).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("an expired pending row is cleared rather than left to linger unused", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const pendingSeedStore = createInMemoryPendingSeedStore(testCipher());
    try {
      await withPendingSeed(pendingSeedStore, { ttlMs: -1 });
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
          pendingSeedStore,
        }),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string };
      expect(body.kind).toBe("unseeded");
      const stillThere = await pendingSeedStore.read({
        userId: "user_1",
        tenantId: TENANT_ID,
      });
      expect(stillThere).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });

  test("a pending row written for a different user is invisible to this session", async () => {
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const pendingSeedStore = createInMemoryPendingSeedStore(testCipher());
    try {
      await withPendingSeed(pendingSeedStore, { userId: "someone_else" });
      let ensureSeededCalls = 0;
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
          pendingSeedStore,
          ensureSeededFn: async () => {
            ensureSeededCalls += 1;
            return { kind: "seeded", workflows: [] };
          },
        }),
      );

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string };
      expect(body.kind).toBe("unseeded");
      expect(ensureSeededCalls).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("two overlapping calls both report provisioning and neither deploys", async () => {
    // Two "finish setup" requests racing (a double effect fire, a
    // retried fetch) used to be this route's sharpest edge, because
    // both would deploy. Post-CL-6457 the route deploys nothing at all,
    // so the only thing left to hold is that overlapping callers get
    // the same honest status and still start no work of their own. The
    // dedupe that matters now lives one layer down and is covered
    // there: "overlapping drains never double-deploy the same bench" in
    // ./bench-provisioning.test.ts.
    const hub = new Hono();
    // Deterministic overlap, not a race against real wall-clock
    // scheduling: `findPersonalTenant` is the first hub call each
    // `/complete-setup` request makes, so gating it on "both requests
    // have arrived" guarantees the two calls are genuinely in flight
    // together every run, rather than hoping `Promise.all` happens to
    // interleave that way under whatever load the machine is under.
    let arrivals = 0;
    let releaseArrivals: () => void = () => undefined;
    const bothArrived = new Promise<void>((resolve) => {
      releaseArrivals = resolve;
    });
    hub.get("/api/me/principals", async (c) => {
      arrivals += 1;
      if (arrivals >= 2) releaseArrivals();
      else await bothArrived;
      return c.json({
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
      });
    });
    hub.get(`/api/tenants/${TENANT_ID}`, (c) =>
      c.json({
        id: TENANT_ID,
        name: "user_1's workbench",
        slug: TENANT_SLUG,
        domain: TENANT_DOMAIN,
        parentId: null,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      }),
    );
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) => c.json([]));
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const pendingSeedStore = createInMemoryPendingSeedStore(testCipher());
    try {
      let ensureSeededCalls = 0;
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
          pendingSeedStore,
          ensureSeededFn: async () => {
            ensureSeededCalls += 1;
            return { kind: "seeded", workflows: [] };
          },
        }),
      );
      await withPendingSeed(pendingSeedStore);

      const [first, second] = await Promise.all([
        app.request("/api/onboarding/complete-setup", {
          method: "POST",
        }),
        app.request("/api/onboarding/complete-setup", {
          method: "POST",
        }),
      ]);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstBody = (await first.json()) as { kind: string };
      const secondBody = (await second.json()) as { kind: string };
      expect(firstBody.kind).toBe("provisioning");
      expect(secondBody.kind).toBe("provisioning");
      expect(ensureSeededCalls).toBe(0);

      // One work item, however many callers ask about it.
      const stillThere = await pendingSeedStore.read({
        userId: "user_1",
        tenantId: TENANT_ID,
      });
      expect(stillThere).toBeDefined();
    } finally {
      server.stop(true);
    }
  });

  // CL-6264, re-homed by CL-6457: a bench that got partway through its
  // workflows must read as still provisioning, and must keep its
  // pending row so the drain can finish the rest. The convergence
  // itself — deploying only what is missing on a later pass — is
  // covered by "a half-provisioned bench keeps its row and converges on
  // a later pass" in ./bench-provisioning.test.ts.
  //
  // CL-7074 narrowed DEFAULT_WORKFLOWS to just the setup agent, so
  // "partway through" no longer means "one of several live, the rest
  // pending" — it means the one default workflow's asset exists but
  // has not gone live yet (the sidecar push landed, the deploy
  // confirmation has not).
  test("a bench whose agent is not yet live keeps its pending row for the drain", async () => {
    const liveWorkflow = DEFAULT_WORKFLOWS[0];
    if (liveWorkflow === undefined) {
      throw new Error("DEFAULT_WORKFLOWS is empty");
    }
    const hub = new Hono();
    principalsRoute(hub);
    hub.get(`/api/tenants/${TENANT_ID}/assets`, (c) =>
      c.json(
        DEFAULT_WORKFLOWS.map((workflow, index) => ({
          id: `ast_${index}`,
          tenantId: TENANT_ID,
          kind: "workflow",
          name: workflow.assetName,
          displayName: workflow.displayName,
          creatorPrincipalId: PRINCIPAL_ID,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
          origin: { tenantId: TENANT_ID, direct: true },
        })),
      ),
    );
    // The asset exists, but no deployment has gone live yet.
    hub.get(`/api/tenants/${TENANT_ID}/workflows/deployments`, (c) =>
      c.json([]),
    );
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    const pendingSeedStore = createInMemoryPendingSeedStore(testCipher());
    try {
      const app = mountAuthenticated(
        createOnboardingRoutes({
          hubUrl: `http://localhost:${server.port}`,
          pushWorkflow: async () => ({
            outcome: "pushed" as const,
            commitSha: "a".repeat(40),
          }),
          log: () => undefined,
          pendingSeedStore,
        }),
      );
      await withPendingSeed(pendingSeedStore);

      const response = await app.request("/api/onboarding/complete-setup", {
        method: "POST",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        kind: string;
        tenantId: string;
        tenantSlug: string;
        setupAgentReady: boolean;
        deployed: string[];
        pending: string[];
      };
      expect(body).toEqual({
        kind: "provisioning",
        tenantId: TENANT_ID,
        tenantSlug: TENANT_SLUG,
        setupAgentReady: false,
        deployed: [],
        pending: [liveWorkflow.assetName],
      });

      // Not finished yet — clearing the row here would strand the
      // remaining agents with nothing left to deploy them.
      const stillThere = await pendingSeedStore.read({
        userId: "user_1",
        tenantId: TENANT_ID,
      });
      expect(stillThere).toBeDefined();
    } finally {
      server.stop(true);
    }
  });
});
