// The connect routes' contract with the browser: /start parks a
// single-use state in an HttpOnly cookie and sends the user to
// OpenRouter's consent page with a real S256 challenge over a
// hub-origin callback URL; /callback only ever exchanges a code whose
// state round-tripped intact, and runs only the fast half —
// `connectCredential` proves and persists the key, never deploys a
// workflow — before redirecting. Every ending — connected, state gone
// stale, exchange refused — lands back in the wizard as query
// parameters with no key material in any URL.
import { describe, expect, test } from "bun:test";
import type { AppEnv } from "@intx/hub-api";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  createEnvKeyCredentialCipher,
  createNoopCredentialCipher,
} from "@intx/crypto";
import { createOnboardingRoutes } from "../src/routes";
import type { CreateOnboardingRoutesDeps } from "../src/routes";
import { testAndPersistCredential } from "../src/complete-credential";
import { s256Challenge } from "../src/openrouter-connect";
import {
  createInMemoryPendingSeedStore,
  type PendingSeedStore,
} from "../src/pending-seed";

const MOCK_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/**
 * A minimal, stateful stand-in for the hub: enough of
 * `/api/me/principals`, `/api/tenants/:id`, and the catalog-seed POST
 * routes for `testAndPersistCredential`'s real (unmocked) fast half to
 * run end to end, tracking the credential it plants so a later
 * `GET .../credentials` — the duplicate-callback recovery check — can
 * see it. Never wires up a `/workflows/deployments` route at all: a
 * test that reaches one fails loudly with a 404, which is exactly the
 * proof this suite wants that the fast half never asks for a deploy.
 */
function mockHub() {
  const credentials: {
    id: string;
    tenantId: string;
    providerId: string;
    name: string;
    type: string;
    status: string;
    metadata: unknown;
    createdAt: string;
    updatedAt: string;
  }[] = [];
  const hub = new Hono();
  hub.get("/api/me/principals", (c) =>
    c.json({
      data: [
        {
          principalId: "prn_1",
          tenantId: "ten_1",
          tenantName: "Alice's workbench",
          tenantSlug: "user-1-user1",
          kind: "user",
          status: "active",
          roles: [],
        },
      ],
      nextCursor: null,
    }),
  );
  hub.get("/api/tenants/ten_1", (c) =>
    c.json({
      id: "ten_1",
      name: "Alice's workbench",
      slug: "user-1-user1",
      domain: "user-1-user1.bench.local",
      parentId: null,
      createdAt: MOCK_TIMESTAMP,
      updatedAt: MOCK_TIMESTAMP,
    }),
  );
  hub.post("/api/tenants/ten_1/catalog/models", (c) =>
    c.json(
      {
        id: "mdl_1",
        tenantId: "ten_1",
        canonicalName: "anthropic/claude-sonnet-5",
        disabled: false,
        createdAt: MOCK_TIMESTAMP,
        updatedAt: MOCK_TIMESTAMP,
      },
      201,
    ),
  );
  hub.post("/api/tenants/ten_1/providers", (c) =>
    c.json(
      {
        id: "prv_1",
        tenantId: "ten_1",
        name: "openrouter",
        plugin: "openai-compatible",
        createdAt: MOCK_TIMESTAMP,
        updatedAt: MOCK_TIMESTAMP,
      },
      201,
    ),
  );
  hub.post("/api/tenants/ten_1/credentials", (c) => {
    const row = {
      id: "cre_1",
      tenantId: "ten_1",
      providerId: "prv_1",
      name: "openrouter-default",
      type: "api_key",
      status: "active",
      metadata: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    credentials.push(row);
    return c.json(row, 201);
  });
  hub.get("/api/tenants/ten_1/credentials", (c) =>
    c.json({ data: credentials, nextCursor: null }),
  );
  hub.post("/api/tenants/ten_1/catalog/providers", (c) =>
    c.json(
      {
        id: "cpv_1",
        tenantId: "ten_1",
        name: "openrouter",
        plugin: "openai-compatible",
        baseURL: "https://openrouter.ai/api/v1",
        credentialId: "cre_1",
        disabled: false,
        createdAt: MOCK_TIMESTAMP,
        updatedAt: MOCK_TIMESTAMP,
      },
      201,
    ),
  );
  hub.post("/api/tenants/ten_1/catalog/offerings", (c) =>
    c.json(
      {
        id: "off_1",
        tenantId: "ten_1",
        modelId: "mdl_1",
        providerId: "cpv_1",
        priority: 0,
        deploymentTags: [],
        capabilities: [],
        quirks: null,
        disabled: false,
        createdAt: MOCK_TIMESTAMP,
        updatedAt: MOCK_TIMESTAMP,
      },
      201,
    ),
  );
  hub.get("/api/tenants/ten_1/catalog/offerings", (c) =>
    c.json({ data: [], nextCursor: null }),
  );
  return hub;
}

/** The fast half, run for real — CL-6123 dropped the probe that used to
 * need stubbing out here, so this now just forwards to the real
 * `testAndPersistCredential` unchanged. */
const connectCredentialAgainstMockHub: NonNullable<
  NonNullable<
    CreateOnboardingRoutesDeps["openrouterConnect"]
  >["connectCredential"]
> = (args) => testAndPersistCredential(args);

// Stands in for a stable `CREDENTIAL_ENCRYPTION_KEY`: a fresh cipher
// built from these same bytes is indistinguishable, to the state store,
// from the cipher a still-running process already had — which is
// exactly what a restart needs to be true.
const RESTART_STABLE_KEY = Buffer.alloc(32, 3);

// The signed-in user is read per request from a mutable session, so a
// test can swap identities mid-flow — the cross-user callback guarantee
// has to be pinned at the HTTP layer, not only in the state store.
function asUser(session: { userId: string }): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("user", {
      id: session.userId,
      email: `${session.userId}@example.com`,
    } as never);
    await next();
  };
}

function mountAuthenticated(
  routes: Hono<AppEnv>,
  session: { userId: string },
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", asUser(session));
  app.route("/api/onboarding", routes);
  return app;
}

function connectRoutes(
  overrides: Partial<CreateOnboardingRoutesDeps> = {},
  session: { userId: string } = { userId: "user_1" },
): Hono<AppEnv> {
  const deps: CreateOnboardingRoutesDeps = {
    hubUrl: overrides.hubUrl ?? "https://bench.example.com",
    pushWorkflow:
      overrides.pushWorkflow ??
      (async () => ({ outcome: "pushed" as const, commitSha: "a".repeat(40) })),
    log: overrides.log ?? (() => undefined),
    pendingSeedStore:
      overrides.pendingSeedStore ??
      createInMemoryPendingSeedStore(createNoopCredentialCipher()),
  };
  if (overrides.openrouterConnect !== undefined)
    deps.openrouterConnect = overrides.openrouterConnect;
  if (overrides.credentialCipher !== undefined)
    deps.credentialCipher = overrides.credentialCipher;
  return mountAuthenticated(createOnboardingRoutes(deps), session);
}

function stateCookie(startResponse: Response): string {
  const setCookie = startResponse.headers.get("set-cookie") ?? "";
  const match = /workbench_openrouter_connect=([^;]+)/.exec(setCookie);
  if (!match?.[1]) throw new Error(`no state cookie in: ${setCookie}`);
  return `workbench_openrouter_connect=${match[1]}`;
}

async function startConnect(app: Hono<AppEnv>) {
  const response = await app.request("/api/onboarding/oauth/openrouter/start");
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  return { response, location };
}

describe("GET /oauth/openrouter/start", () => {
  test("redirects to OpenRouter with an S256 challenge and the hub-origin callback", async () => {
    const app = connectRoutes({ hubUrl: "https://bench.example.com" });

    const { response, location } = await startConnect(app);

    expect(location.origin).toBe("https://openrouter.ai");
    expect(location.pathname).toBe("/auth");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(location.searchParams.get("callback_url")).toBe(
      "https://bench.example.com/api/onboarding/oauth/openrouter/callback",
    );
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("workbench_openrouter_connect=");
    expect(setCookie).toContain("HttpOnly");
  });

  // CL-6394: onboarding's OAuth mount serves ONLY its own first-login
  // providers. A GitHub start here must refuse loudly — before this,
  // github fell through onboarding's inference-only persistence and
  // crashed AFTER a successful token exchange. The GitHub App connect
  // lives on the tenant-scoped `connections/oauth` mount instead.
  test("a github start on the onboarding mount is a loud 404, never a fall-through", async () => {
    const app = connectRoutes();

    const response = await app.request("/api/onboarding/oauth/github/start");

    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("not_found");
  });

  test("derives the callback origin from configuration, not the request host", async () => {
    const app = connectRoutes({ hubUrl: "http://localhost:3000" });

    const { location } = await startConnect(app);

    expect(location.searchParams.get("callback_url")).toBe(
      "http://localhost:3000/api/onboarding/oauth/openrouter/callback",
    );
  });

  test("rapid connect starts from the same user are rate-limited", async () => {
    const app = connectRoutes();

    await startConnect(app);
    const second = await app.request("/api/onboarding/oauth/openrouter/start");

    expect(second.status).toBe(302);
    const redirect = new URL(
      second.headers.get("location") ?? "",
      "https://bench.example.com",
    );
    expect(redirect.pathname).toBe("/onboarding");
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("rate_limited");
    // A rate-limited start parks nothing: no state cookie is set.
    expect(second.headers.get("set-cookie")).toBeNull();
  });
});

describe("GET /oauth/openrouter/callback", () => {
  test("happy path: exchanges the code with the verifier behind the challenge, connects, and reports success without deploying anything", async () => {
    const exchanges: { code: string; codeVerifier: string }[] = [];
    const connections: {
      provider: string;
      apiKey: string;
      userId: string;
    }[] = [];
    const pendingSeedStore: PendingSeedStore = createInMemoryPendingSeedStore(
      createNoopCredentialCipher(),
    );
    const app = connectRoutes({
      pendingSeedStore,
      openrouterConnect: {
        exchange: async ({ code, codeVerifier }) => {
          exchanges.push({ code, codeVerifier });
          return { ok: true, key: "sk-or-v1-minted" };
        },
        connectCredential: async (args) => {
          connections.push({
            provider: args.provider,
            apiKey: args.apiKey,
            userId: args.userId,
          });
          return {
            kind: "connected",
            tenantId: "ten_1",
            tenantSlug: "alice-user1",
            principalId: "prn_1",
            tenantDomain: "alice-user1.bench.local",
          };
        },
      },
    });

    const { response: started, location } = await startConnect(app);
    const cookie = stateCookie(started);

    const response = await app.request(
      "/api/onboarding/oauth/openrouter/callback?code=auth_code_1",
      { headers: { cookie } },
    );

    expect(response.status).toBe(302);
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://bench.example.com",
    );
    expect(redirect.pathname).toBe("/onboarding");
    expect(redirect.searchParams.get("connect")).toBe("openrouter");
    expect(redirect.searchParams.get("outcome")).toBe("connected");
    expect(redirect.searchParams.get("tenantSlug")).toBe("alice-user1");
    // The minted key reaches the connect path but never a URL.
    expect(redirect.toString()).not.toContain("sk-or-v1-minted");

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.code).toBe("auth_code_1");
    // The verifier handed to the exchange is the one whose S256 was
    // sent to OpenRouter at /start — the round trip is real PKCE.
    expect(
      exchanges[0] && (await s256Challenge(exchanges[0].codeVerifier)),
    ).toBe(location.searchParams.get("code_challenge") ?? "");

    // The minted key connects as an ordinary openrouter credential —
    // the same generalized path a pasted key takes.
    expect(connections).toEqual([
      { provider: "openrouter", apiKey: "sk-or-v1-minted", userId: "user_1" },
    ]);

    // The plaintext key is carried forward for the deferred deploy step
    // server-side, in the pending-seed store — never as a cookie (this
    // response still clears the connect-state cookies, but never sets
    // the pre-CL-6031 `workbench_pending_seed` one) or a redirect query
    // parameter.
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).not.toContain("workbench_pending_seed=");
    const pending = await pendingSeedStore.read({
      userId: "user_1",
      tenantId: "ten_1",
    });
    expect(pending).toEqual({
      userId: "user_1",
      tenantId: "ten_1",
      principalId: "prn_1",
      tenantDomain: "alice-user1.bench.local",
      provider: "openrouter",
      apiKey: "sk-or-v1-minted",
    });
  });

  test("a callback without the state cookie never exchanges", async () => {
    let exchanged = 0;
    const app = connectRoutes({
      openrouterConnect: {
        exchange: async () => {
          exchanged += 1;
          return { ok: true, key: "sk-or-v1-minted" };
        },
      },
    });
    await startConnect(app);

    const response = await app.request(
      "/api/onboarding/oauth/openrouter/callback?code=auth_code_1",
    );

    expect(response.status).toBe(302);
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://bench.example.com",
    );
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("state_expired");
    expect(exchanged).toBe(0);
  });

  test("another user's session cannot redeem a stolen state cookie", async () => {
    // Login-CSRF guard: an attacker who lures a victim into finishing
    // the attacker's own flow (or replays a leaked cookie) must never
    // get a key exchanged or a bench seeded under the wrong session.
    // The recovery check (a real credential lookup) is exercised here
    // too — for a user that plainly has no such tenant, it comes back
    // empty and the honest state_expired ending still wins.
    let exchanged = 0;
    let connected = 0;
    const session = { userId: "user_1" };
    const app = connectRoutes(
      {
        openrouterConnect: {
          exchange: async () => {
            exchanged += 1;
            return { ok: true, key: "sk-or-v1-minted" };
          },
          connectCredential: async () => {
            connected += 1;
            return {
              kind: "connected",
              tenantId: "ten_1",
              tenantSlug: "alice-user1",
              principalId: "prn_1",
              tenantDomain: "alice-user1.bench.local",
            };
          },
        },
      },
      session,
    );
    const { response: started } = await startConnect(app);
    const cookie = stateCookie(started);

    session.userId = "user_2";
    const response = await app.request(
      "/api/onboarding/oauth/openrouter/callback?code=auth_code_1",
      { headers: { cookie } },
    );

    expect(response.status).toBe(302);
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("state_expired");
    expect(exchanged).toBe(0);
    expect(connected).toBe(0);
  });

  test("a duplicate callback with the same code recovers as connected instead of state_expired", async () => {
    // The live defect this fix targets: a browser that fires the exact
    // same callback twice (one code, two requests) burns the single-use
    // state on whichever request wins the race. Before this fix the
    // loser reported `state_expired` for a connection that actually
    // succeeded. Now it finds the winner's just-persisted credential and
    // reports the same `connected` ending.
    const server = Bun.serve({ port: 0, fetch: mockHub().fetch });
    try {
      const app = connectRoutes({
        hubUrl: `http://localhost:${server.port}`,
        openrouterConnect: {
          exchange: async () => ({ ok: true, key: "sk-or-v1-minted" }),
          connectCredential: connectCredentialAgainstMockHub,
        },
      });
      const { response: started } = await startConnect(app);
      const cookie = stateCookie(started);
      const path = "/api/onboarding/oauth/openrouter/callback?code=auth_code_1";

      const first = await app.request(path, { headers: { cookie } });
      const second = await app.request(path, { headers: { cookie } });

      expect(
        new URL(
          first.headers.get("location") ?? "",
          "https://x",
        ).searchParams.get("outcome"),
      ).toBe("connected");
      const secondRedirect = new URL(
        second.headers.get("location") ?? "",
        "https://x",
      );
      expect(secondRedirect.searchParams.get("outcome")).toBe("connected");
      expect(secondRedirect.searchParams.get("tenantSlug")).toBe(
        "user-1-user1",
      );
    } finally {
      server.stop(true);
    }
  });

  test("a genuinely stale state (no matching recent credential) still errors honestly", async () => {
    const app = connectRoutes({
      openrouterConnect: {
        exchange: async () => ({ ok: true, key: "sk-or-v1-minted" }),
        connectCredential: async () => ({
          kind: "connected",
          tenantId: "ten_1",
          tenantSlug: "alice-user1",
          principalId: "prn_1",
          tenantDomain: "alice-user1.bench.local",
        }),
      },
    });
    await startConnect(app);
    const path = "/api/onboarding/oauth/openrouter/callback?code=auth_code_1";

    // A replay with no prior successful connect at all (no /start ever
    // happened for this exact state before the browser sent it) — the
    // recovery check finds no personal bench and no credential, so the
    // honest ending still wins.
    const replayed = await app.request(path, {
      headers: { cookie: "workbench_openrouter_connect=not-a-real-state" },
    });

    expect(
      new URL(
        replayed.headers.get("location") ?? "",
        "https://x",
      ).searchParams.get("code"),
    ).toBe("state_expired");
  });

  test("survives a hub restart between /start and /callback, and still recovers as connected after it", async () => {
    // /start runs against the pre-restart app; a fresh app (a new
    // `createOnboardingRoutes` call, a fresh in-memory state store, the
    // works) stands in for the process that comes back up after a
    // restart. The only thing they share is the cipher key — exactly
    // what a stable `CREDENTIAL_ENCRYPTION_KEY` gives a real restart.
    const beforeRestart = connectRoutes({
      credentialCipher: createEnvKeyCredentialCipher(RESTART_STABLE_KEY),
    });
    const { response: started } = await startConnect(beforeRestart);
    const cookie = stateCookie(started);

    const server = Bun.serve({ port: 0, fetch: mockHub().fetch });
    try {
      const afterRestart = connectRoutes({
        hubUrl: `http://localhost:${server.port}`,
        credentialCipher: createEnvKeyCredentialCipher(RESTART_STABLE_KEY),
        openrouterConnect: {
          exchange: async () => ({ ok: true, key: "sk-or-v1-minted" }),
          connectCredential: connectCredentialAgainstMockHub,
        },
      });
      const path = "/api/onboarding/oauth/openrouter/callback?code=auth_code_1";

      const first = await afterRestart.request(path, { headers: { cookie } });
      expect(
        new URL(
          first.headers.get("location") ?? "",
          "https://x",
        ).searchParams.get("outcome"),
      ).toBe("connected");

      // Replaying the same cookie against the post-restart app — no new
      // /start, same state — recovers as connected too, since the first
      // request's connect already persisted the credential.
      const replay = await afterRestart.request(path, { headers: { cookie } });
      expect(
        new URL(
          replay.headers.get("location") ?? "",
          "https://x",
        ).searchParams.get("outcome"),
      ).toBe("connected");
    } finally {
      server.stop(true);
    }
  });

  test("an exchange failure is reported as such and never reaches connect", async () => {
    let connected = 0;
    const lines: string[] = [];
    const app = connectRoutes({
      log: (line) => lines.push(line),
      openrouterConnect: {
        exchange: async () => ({
          ok: false,
          message: "OpenRouter rejected the code exchange with status 403",
        }),
        connectCredential: async () => {
          connected += 1;
          return {
            kind: "connected",
            tenantId: "ten_1",
            tenantSlug: "alice-user1",
            principalId: "prn_1",
            tenantDomain: "alice-user1.bench.local",
          };
        },
      },
    });
    const { response: started } = await startConnect(app);

    const response = await app.request(
      "/api/onboarding/oauth/openrouter/callback?code=expired_code",
      { headers: { cookie: stateCookie(started) } },
    );

    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("exchange_failed");
    expect(connected).toBe(0);
    expect(lines.some((line) => line.includes("code exchange failed"))).toBe(
      true,
    );
  });

  test("a minted key that fails its probe is a key_rejected ending, not a success", async () => {
    const app = connectRoutes({
      openrouterConnect: {
        exchange: async () => ({ ok: true, key: "sk-or-v1-minted" }),
        connectCredential: async () => ({
          kind: "invalid-credential",
          message: "invalid api key",
        }),
      },
    });
    const { response: started } = await startConnect(app);

    const response = await app.request(
      "/api/onboarding/oauth/openrouter/callback?code=auth_code_1",
      { headers: { cookie: stateCookie(started) } },
    );

    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("key_rejected");
  });

  test("a thrown connect failure surfaces honestly without leaking the key", async () => {
    const lines: string[] = [];
    const app = connectRoutes({
      log: (line) => lines.push(line),
      openrouterConnect: {
        exchange: async () => ({ ok: true, key: "sk-or-v1-minted" }),
        connectCredential: async () => {
          throw new Error("the hub rejected the credential");
        },
      },
    });
    const { response: started } = await startConnect(app);

    const response = await app.request(
      "/api/onboarding/oauth/openrouter/callback?code=auth_code_1",
      { headers: { cookie: stateCookie(started) } },
    );

    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("code")).toBe("setup_failed");
    expect(lines.join("\n")).not.toContain("sk-or-v1-minted");
  });

  test("never triggers a workflow deploy call — the fast half only proves and persists the key", async () => {
    // The core of this defect: the callback must return in the time it
    // takes to prove and store a key, never the minutes a full workflow
    // deploy-and-confirm chain can take. `connectCredential`'s default
    // (`testAndPersistCredential`) never calls `seedTenant`, so nothing
    // here should ever reach a `/workflows/deployments`-or-`/assets`-shaped
    // path — `mockHub()` never wires either up, so reaching one 404s
    // loudly instead of silently succeeding.
    let deployPosts = 0;
    const hub = mockHub();
    hub.post("/api/tenants/:tenantId/workflows/deployments", (c) => {
      deployPosts += 1;
      return c.json({ error: "unexpected deploy call" }, 500);
    });
    hub.post("/api/tenants/:tenantId/assets", (c) => {
      deployPosts += 1;
      return c.json({ error: "unexpected asset call" }, 500);
    });
    const server = Bun.serve({ port: 0, fetch: hub.fetch });
    try {
      const app = connectRoutes({
        hubUrl: `http://localhost:${server.port}`,
        openrouterConnect: {
          exchange: async () => ({ ok: true, key: "sk-or-v1-minted" }),
          connectCredential: connectCredentialAgainstMockHub,
        },
      });
      const { response: started } = await startConnect(app);

      const response = await app.request(
        "/api/onboarding/oauth/openrouter/callback?code=auth_code_1",
        { headers: { cookie: stateCookie(started) } },
      );

      const redirect = new URL(
        response.headers.get("location") ?? "",
        "https://x",
      );
      expect(redirect.searchParams.get("outcome")).toBe("connected");
      expect(deployPosts).toBe(0);
    } finally {
      server.stop(true);
    }
  });
});
