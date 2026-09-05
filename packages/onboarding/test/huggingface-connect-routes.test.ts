// The Hugging Face connect routes' contract with the browser: /start
// parks a single-use state in an HttpOnly cookie and sends the user to
// HF's consent page with a real S256 challenge, a client id, and the
// requested scope; /callback only ever exchanges a code whose state
// round-tripped intact (both in the cookie and echoed back in the
// query string — HF, unlike OpenRouter, supports `state`), and runs
// only the fast half — `connectCredential` proves and persists the
// token, never deploys a workflow — before redirecting. Cross-user/
// replay/single-use/duplicate-callback-recovery guarantees mirror
// `openrouter-connect-routes.test.ts`'s coverage for the same shape.
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
import { s256Challenge } from "@corbits/connections";
import {
  createInMemoryPendingSeedStore,
  type PendingSeedStore,
} from "../src/pending-seed";

// Stands in for a stable `CREDENTIAL_ENCRYPTION_KEY`: a fresh cipher
// built from these same bytes is indistinguishable, to the state store,
// from the cipher a still-running process already had — which is
// exactly what a restart needs to be true.
const RESTART_STABLE_KEY = Buffer.alloc(32, 5);

const MOCK_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** Mirrors `openrouter-connect-routes.test.ts`'s `mockHub` — enough of
 * the hub for `testAndPersistCredential`'s real fast half to run
 * end to end for a Hugging Face connection, tracking the credential it
 * plants so the duplicate-callback recovery check can find it. Never
 * wires up a workflow-deploy route at all. */
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
          tenantName: "user_1's workbench",
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
      name: "user_1's workbench",
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
        canonicalName: "deepseek-ai/DeepSeek-V4-Flash",
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
        name: "huggingface",
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
      name: "huggingface-default",
      type: "oauth_token",
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
        name: "huggingface",
        plugin: "openai-compatible",
        baseURL: "https://router.huggingface.co/v1",
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
    CreateOnboardingRoutesDeps["huggingfaceConnect"]
  >["connectCredential"]
> = (args) => testAndPersistCredential(args);

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
  overrides: Partial<CreateOnboardingRoutesDeps> & {
    readonly omitClientId?: boolean;
  } = {},
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
  if (overrides.omitClientId !== true) {
    deps.huggingfaceClientId = overrides.huggingfaceClientId ?? "hf_client_1";
  }
  if (overrides.huggingfaceConnect !== undefined)
    deps.huggingfaceConnect = overrides.huggingfaceConnect;
  if (overrides.credentialCipher !== undefined)
    deps.credentialCipher = overrides.credentialCipher;
  return mountAuthenticated(createOnboardingRoutes(deps), session);
}

function stateCookie(startResponse: Response): string {
  const setCookie = startResponse.headers.get("set-cookie") ?? "";
  const match = /workbench_huggingface_connect=([^;]+)/.exec(setCookie);
  if (!match?.[1]) throw new Error(`no state cookie in: ${setCookie}`);
  return `workbench_huggingface_connect=${match[1]}`;
}

async function startConnect(app: Hono<AppEnv>) {
  const response = await app.request("/api/onboarding/oauth/huggingface/start");
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  return { response, location };
}

describe("GET /oauth/huggingface/start", () => {
  test("redirects to Hugging Face with an S256 challenge, client id, scope, and echoed state", async () => {
    const app = connectRoutes({ hubUrl: "https://bench.example.com" });

    const { response, location } = await startConnect(app);

    expect(location.origin).toBe("https://huggingface.co");
    expect(location.pathname).toBe("/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("hf_client_1");
    expect(location.searchParams.get("scope")).toBe("openid inference-api");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://bench.example.com/api/onboarding/oauth/huggingface/callback",
    );
    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();
    const setCookie = response.headers.get("set-cookie") ?? "";
    // The state cookie carries the sealed state as its value; Hono
    // percent-encodes it in `Set-Cookie`, so compare decoded rather than
    // as a raw substring.
    const cookieMatch = /workbench_huggingface_connect=([^;]+)/.exec(setCookie);
    expect(
      cookieMatch?.[1] !== undefined
        ? decodeURIComponent(cookieMatch[1])
        : undefined,
    ).toBe(state ?? undefined);
    expect(setCookie).toContain("HttpOnly");
  });

  test("without a configured client id, the flow reports not_configured and parks nothing", async () => {
    const app = connectRoutes({ omitClientId: true });

    const response = await app.request(
      "/api/onboarding/oauth/huggingface/start",
    );

    expect(response.status).toBe(302);
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("connect")).toBe("huggingface");
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("not_configured");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("rapid connect starts from the same user are rate-limited", async () => {
    const app = connectRoutes();

    await startConnect(app);
    const second = await app.request("/api/onboarding/oauth/huggingface/start");

    expect(second.status).toBe(302);
    const redirect = new URL(
      second.headers.get("location") ?? "",
      "https://bench.example.com",
    );
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("rate_limited");
  });
});

describe("GET /oauth/huggingface/callback", () => {
  test("happy path: exchanges the code with the verifier behind the challenge, connects with expiry metadata, and reports success without deploying anything", async () => {
    const exchanges: {
      code: string;
      codeVerifier: string;
      redirectUri: string;
      clientId: string;
    }[] = [];
    const connections: {
      provider: string;
      apiKey: string;
      userId: string;
      credentialMetadata?: Record<string, unknown>;
    }[] = [];
    const pendingSeedStore: PendingSeedStore = createInMemoryPendingSeedStore(
      createNoopCredentialCipher(),
    );
    const app = connectRoutes({
      pendingSeedStore,
      huggingfaceConnect: {
        exchange: async ({ code, codeVerifier, redirectUri, clientId }) => {
          exchanges.push({ code, codeVerifier, redirectUri, clientId });
          return {
            ok: true,
            accessToken: "hf_oauth_minted",
            expiresAt: "2026-08-13T20:00:00.000Z",
          };
        },
        connectCredential: async (args) => {
          const connection = {
            provider: args.provider,
            apiKey: args.apiKey,
            userId: args.userId,
          };
          connections.push(
            args.credentialMetadata !== undefined
              ? { ...connection, credentialMetadata: args.credentialMetadata }
              : connection,
          );
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
    const state = location.searchParams.get("state") ?? "";

    const response = await app.request(
      `/api/onboarding/oauth/huggingface/callback?code=auth_code_1&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
    );

    expect(response.status).toBe(302);
    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://bench.example.com",
    );
    expect(redirect.pathname).toBe("/onboarding");
    expect(redirect.searchParams.get("connect")).toBe("huggingface");
    expect(redirect.searchParams.get("outcome")).toBe("connected");
    expect(redirect.searchParams.get("tenantSlug")).toBe("alice-user1");
    // The minted token reaches the connect path but never a URL.
    expect(redirect.toString()).not.toContain("hf_oauth_minted");

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.code).toBe("auth_code_1");
    expect(exchanges[0]?.clientId).toBe("hf_client_1");
    expect(exchanges[0]?.redirectUri).toBe(
      "https://bench.example.com/api/onboarding/oauth/huggingface/callback",
    );
    expect(
      exchanges[0] && (await s256Challenge(exchanges[0].codeVerifier)),
    ).toBe(location.searchParams.get("code_challenge") ?? "");

    expect(connections).toEqual([
      {
        provider: "huggingface",
        apiKey: "hf_oauth_minted",
        userId: "user_1",
        credentialMetadata: { expiresAt: "2026-08-13T20:00:00.000Z" },
      },
    ]);

    // The plaintext token is carried forward for the deferred deploy
    // step server-side, in the pending-seed store — never as a cookie
    // (this response still clears the connect-state cookies, but never
    // sets the pre-CL-6031 `workbench_pending_seed` one) or a redirect
    // query parameter.
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
      provider: "huggingface",
      apiKey: "hf_oauth_minted",
    });
  });

  test("a callback whose query state disagrees with the cookie never exchanges", async () => {
    let exchanged = 0;
    const app = connectRoutes({
      huggingfaceConnect: {
        exchange: async () => {
          exchanged += 1;
          return { ok: true, accessToken: "hf_oauth_minted" };
        },
      },
    });
    const { response: started } = await startConnect(app);
    const cookie = stateCookie(started);

    const response = await app.request(
      "/api/onboarding/oauth/huggingface/callback?code=auth_code_1&state=not-the-real-state",
      { headers: { cookie } },
    );

    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("state_expired");
    expect(exchanged).toBe(0);
  });

  test("another user's session cannot redeem a stolen state cookie", async () => {
    let exchanged = 0;
    let connected = 0;
    const session = { userId: "user_1" };
    const app = connectRoutes(
      {
        huggingfaceConnect: {
          exchange: async () => {
            exchanged += 1;
            return { ok: true, accessToken: "hf_oauth_minted" };
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
    const { response: started, location } = await startConnect(app);
    const cookie = stateCookie(started);
    const state = location.searchParams.get("state") ?? "";

    session.userId = "user_2";
    const response = await app.request(
      `/api/onboarding/oauth/huggingface/callback?code=auth_code_1&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
    );

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
    // Mirrors the OpenRouter regression test: a browser that fires this
    // exact callback twice must not see `state_expired` for a
    // connection that actually succeeded.
    const server = Bun.serve({ port: 0, fetch: mockHub().fetch });
    try {
      const app = connectRoutes({
        hubUrl: `http://localhost:${server.port}`,
        huggingfaceConnect: {
          exchange: async () => ({ ok: true, accessToken: "hf_oauth_minted" }),
          connectCredential: connectCredentialAgainstMockHub,
        },
      });
      const { response: started, location } = await startConnect(app);
      const cookie = stateCookie(started);
      const state = location.searchParams.get("state") ?? "";
      const path = `/api/onboarding/oauth/huggingface/callback?code=auth_code_1&state=${encodeURIComponent(state)}`;

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

  test("survives a hub restart between /start and /callback, and still recovers as connected after it", async () => {
    // /start runs against the pre-restart app; a fresh app (a new
    // `createOnboardingRoutes` call, a fresh in-memory state store, the
    // works) stands in for the process that comes back up after a
    // restart. The only thing they share is the cipher key — exactly
    // what a stable `CREDENTIAL_ENCRYPTION_KEY` gives a real restart.
    const beforeRestart = connectRoutes({
      credentialCipher: createEnvKeyCredentialCipher(RESTART_STABLE_KEY),
    });
    const { response: started, location } = await startConnect(beforeRestart);
    const cookie = stateCookie(started);
    const state = location.searchParams.get("state") ?? "";

    const server = Bun.serve({ port: 0, fetch: mockHub().fetch });
    try {
      const afterRestart = connectRoutes({
        hubUrl: `http://localhost:${server.port}`,
        credentialCipher: createEnvKeyCredentialCipher(RESTART_STABLE_KEY),
        huggingfaceConnect: {
          exchange: async () => ({ ok: true, accessToken: "hf_oauth_minted" }),
          connectCredential: connectCredentialAgainstMockHub,
        },
      });
      const path = `/api/onboarding/oauth/huggingface/callback?code=auth_code_1&state=${encodeURIComponent(state)}`;

      const first = await afterRestart.request(path, { headers: { cookie } });
      expect(
        new URL(
          first.headers.get("location") ?? "",
          "https://x",
        ).searchParams.get("outcome"),
      ).toBe("connected");

      // Replaying the same cookie and query state against the
      // post-restart app — no new /start — recovers as connected too,
      // since the first request's connect already persisted the
      // credential.
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
      huggingfaceConnect: {
        exchange: async () => ({
          ok: false,
          message: "Hugging Face rejected the code exchange with status 400",
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
    const { response: started, location } = await startConnect(app);
    const state = location.searchParams.get("state") ?? "";

    const response = await app.request(
      `/api/onboarding/oauth/huggingface/callback?code=expired_code&state=${encodeURIComponent(state)}`,
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

  test("a minted token that fails its probe is a key_rejected ending, not a success", async () => {
    const app = connectRoutes({
      huggingfaceConnect: {
        exchange: async () => ({ ok: true, accessToken: "hf_oauth_minted" }),
        connectCredential: async () => ({
          kind: "invalid-credential",
          message: "invalid token",
        }),
      },
    });
    const { response: started, location } = await startConnect(app);
    const state = location.searchParams.get("state") ?? "";

    const response = await app.request(
      `/api/onboarding/oauth/huggingface/callback?code=auth_code_1&state=${encodeURIComponent(state)}`,
      { headers: { cookie: stateCookie(started) } },
    );

    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("outcome")).toBe("error");
    expect(redirect.searchParams.get("code")).toBe("key_rejected");
  });

  test("a thrown connect failure surfaces honestly without leaking the token", async () => {
    const lines: string[] = [];
    const app = connectRoutes({
      log: (line) => lines.push(line),
      huggingfaceConnect: {
        exchange: async () => ({ ok: true, accessToken: "hf_oauth_minted" }),
        connectCredential: async () => {
          throw new Error("the hub rejected the credential");
        },
      },
    });
    const { response: started, location } = await startConnect(app);
    const state = location.searchParams.get("state") ?? "";

    const response = await app.request(
      `/api/onboarding/oauth/huggingface/callback?code=auth_code_1&state=${encodeURIComponent(state)}`,
      { headers: { cookie: stateCookie(started) } },
    );

    const redirect = new URL(
      response.headers.get("location") ?? "",
      "https://x",
    );
    expect(redirect.searchParams.get("code")).toBe("setup_failed");
    expect(lines.join("\n")).not.toContain("hf_oauth_minted");
  });

  test("never triggers a workflow deploy call — the fast half only proves and persists the token", async () => {
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
        huggingfaceConnect: {
          exchange: async () => ({ ok: true, accessToken: "hf_oauth_minted" }),
          connectCredential: connectCredentialAgainstMockHub,
        },
      });
      const { response: started, location } = await startConnect(app);
      const state = location.searchParams.get("state") ?? "";

      const response = await app.request(
        `/api/onboarding/oauth/huggingface/callback?code=auth_code_1&state=${encodeURIComponent(state)}`,
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
