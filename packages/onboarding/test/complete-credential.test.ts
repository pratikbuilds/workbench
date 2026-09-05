import { describe, expect, test } from "bun:test";
import type { WorkflowPusher } from "@corbits/seeding";
import { CATALOG_SEEDS, SETUP_AGENT_ASSET_NAME } from "@corbits/seeding";
import { type ApiCall, SidecarUnavailableError } from "@corbits/hub-api-client";
import { pristineScheduledDefinitionHandshake } from "../../seeding/test/helpers";
import {
  completeCredentialSetup,
  ensureSeeded,
  modelSourceFor,
  testAndPersistCredential,
} from "../src/complete-credential";

// A key that was never probed (CL-6123 dropped the onboarding probe)
// must not be proven with a billed call either: seedTenant runs with
// confirmDeployments: false so a valid, credit-less account is not
// turned into a false "setup failed" by a workflow trigger it never
// asked for.
function expectNoConfirmation(
  seedTenantCalls: { confirmDeployments?: boolean }[],
) {
  expect(seedTenantCalls).toHaveLength(1);
  expect(seedTenantCalls[0]?.confirmDeployments).toBe(false);
}

const TENANT_ID = "ten_personal";
const PRINCIPAL_ID = "prn_personal";
const TENANT_SLUG = "alice-user1";

const noopPush: WorkflowPusher = async () => ({
  outcome: "pushed" as const,
  commitSha: "a".repeat(40),
});

// Stubs for the provider/credential half of the shared persist-and-seed
// sequence (CL-6394) — paired with every stubbed `seedCatalogFn` so a
// test that fakes the catalog side never dials the real credential
// endpoints either.
const stubPersistFns = {
  ensureProviderFn: async (
    _api: unknown,
    _cookies: string[],
    args: { name: string },
  ) => `prv_${args.name}`,
  ensureCredentialFn: async (
    _api: unknown,
    _cookies: string[],
    args: { providerId: string },
  ) => `cred_${args.providerId}`,
};

function collector() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

function seedHandshake(method: string, path: string) {
  const handshake = pristineScheduledDefinitionHandshake(
    method,
    path,
    TENANT_ID,
  );
  if (handshake === undefined) return undefined;
  return { ...handshake, cookies: [] };
}

function principalsResponse() {
  return {
    status: 200,
    data: {
      data: [
        {
          principalId: PRINCIPAL_ID,
          tenantId: TENANT_ID,
          tenantName: "Alice's workbench",
          tenantSlug: TENANT_SLUG,
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

function tenantResponse() {
  return {
    status: 200,
    data: {
      id: TENANT_ID,
      name: "Alice's workbench",
      slug: TENANT_SLUG,
      domain: "alice-user1.bench.local",
      parentId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    cookies: [],
  };
}

function resolvedCatalogResponse(
  models: {
    canonicalName: string;
    providerName: string;
    priority?: number;
    capabilities?: string[];
  }[],
) {
  return {
    status: 200,
    data: models.map((model, index) => ({
      id: `mdl_${index}`,
      canonicalName: model.canonicalName,
      offerings: [
        {
          offeringId: `off_${index}`,
          providerId: "cpv_1",
          providerName: model.providerName,
          plugin: "openai-compatible",
          priority: model.priority ?? 0,
          deploymentTags: [],
          capabilities: model.capabilities ?? [],
          pricing: [],
        },
      ],
    })),
    cookies: [],
  };
}

function ownedCatalogModelsResponse(canonicalNames: string[]) {
  return {
    status: 200,
    data: {
      data: canonicalNames.map((canonicalName, index) => ({
        id: `own_mdl_${index}`,
        tenantId: TENANT_ID,
        canonicalName,
        disabled: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      })),
      nextCursor: null,
    },
    cookies: [],
  };
}

describe("modelSourceFor", () => {
  test("every other provider ignores a baseURLOverride and never calls the hub", async () => {
    const api: ApiCall = (async () => {
      throw new Error("must not be called for a fixed curated provider");
    }) as ApiCall;
    expect(
      await modelSourceFor(
        api,
        ["session=abc"],
        TENANT_ID,
        "anthropic",
        "sk-ant",
        "https://ignored",
      ),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      baseURL: "https://api.anthropic.com",
      apiKey: "sk-ant",
    });
  });

  // CL-6366 red/green: a fresh instance whose live catalog carries only
  // llama3.2 (the curated default name is absent entirely) still resolves
  // to what the instance actually serves, never a pin it can't answer for.
  test("ollama resolves to the instance's own seeded model, never the curated pin it may lack", async () => {
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/models`) {
        return resolvedCatalogResponse([
          {
            canonicalName: "llama3.2",
            providerName: "ollama",
            capabilities: ["plain-text", "plain-text-streaming"],
          },
        ]);
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    expect(
      await modelSourceFor(api, ["session=abc"], TENANT_ID, "ollama", "ollama"),
    ).toEqual({
      provider: "openai-compatible",
      model: "llama3.2",
      baseURL: "http://localhost:11434/v1",
      apiKey: "ollama",
    });
  });

  // CL-6366 red/green: an alphabetical-first embedding pull must never
  // win over a completion-capable model just because its name sorts
  // first — real capability data, not name order, decides.
  test("ollama prefers a completion-capable model over an alphabetically-earlier embedding model", async () => {
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/models`) {
        return resolvedCatalogResponse([
          {
            canonicalName: "all-minilm",
            providerName: "ollama",
            capabilities: [],
          },
          {
            canonicalName: "llama3.2",
            providerName: "ollama",
            capabilities: ["plain-text", "plain-text-streaming"],
          },
        ]);
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await modelSourceFor(
      api,
      ["session=abc"],
      TENANT_ID,
      "ollama",
      "ollama",
    );
    expect(result.model).toBe("llama3.2");
  });

  test("ollama prefers the curated name among completion-capable candidates when the instance offers it", async () => {
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/models`) {
        return resolvedCatalogResponse([
          {
            canonicalName: "llama3.2",
            providerName: "ollama",
            capabilities: ["plain-text"],
          },
          {
            canonicalName: "gpt-oss:20b",
            providerName: "ollama",
            capabilities: ["plain-text"],
          },
        ]);
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        return ownedCatalogModelsResponse(["llama3.2", "gpt-oss:20b"]);
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await modelSourceFor(
      api,
      ["session=abc"],
      TENANT_ID,
      "ollama",
      "ollama",
    );
    expect(result.model).toBe("gpt-oss:20b");
  });

  // CL-7185: discovery includes the inherited curated name, but this
  // tenant's own catalog only lists the model the instance actually
  // pulled. Prefer the owned name, never the inherited pin.
  test("ollama prefers a tenant-owned model over an inherited curated name the instance does not own", async () => {
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/models`) {
        return resolvedCatalogResponse([
          {
            canonicalName: "gpt-oss:20b",
            providerName: "ollama",
            capabilities: ["plain-text"],
          },
          {
            canonicalName: "llama3.2",
            providerName: "ollama",
            capabilities: ["plain-text"],
          },
        ]);
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        return ownedCatalogModelsResponse(["llama3.2"]);
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await modelSourceFor(
      api,
      ["session=abc"],
      TENANT_ID,
      "ollama",
      "ollama",
    );
    expect(result.model).toBe("llama3.2");
  });

  // CL-7185: an empty owned list means inherit-only — keep discovery's
  // curated preference rather than failing open to "no candidates".
  test("ollama keeps the discovery pick when the tenant owns no catalog models", async () => {
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/models`) {
        return resolvedCatalogResponse([
          {
            canonicalName: "gpt-oss:20b",
            providerName: "ollama",
            capabilities: ["plain-text"],
          },
          {
            canonicalName: "llama3.2",
            providerName: "ollama",
            capabilities: ["plain-text"],
          },
        ]);
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        return ownedCatalogModelsResponse([]);
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await modelSourceFor(
      api,
      ["session=abc"],
      TENANT_ID,
      "ollama",
      "ollama",
    );
    expect(result.model).toBe("gpt-oss:20b");
  });

  test("ollama's baseURLOverride is normalized to the /v1 form", async () => {
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}/models`) {
        return resolvedCatalogResponse([
          {
            canonicalName: "qwen3.8:27b",
            providerName: "ollama",
            capabilities: ["plain-text"],
          },
        ]);
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    expect(
      await modelSourceFor(
        api,
        ["session=abc"],
        TENANT_ID,
        "ollama",
        "ollama",
        "https://home-mac.example.ts.net",
      ),
    ).toEqual({
      provider: "openai-compatible",
      model: "qwen3.8:27b",
      baseURL: "https://home-mac.example.ts.net/v1",
      apiKey: "ollama",
    });
  });
});

describe("completeCredentialSetup", () => {
  // CL-6123: onboarding no longer probes a submitted key before storing
  // it — any key, wrong or right, is stored and seeded immediately. A
  // wrong key is caught later, the first time it's actually dialed, and
  // surfaces in-chat through the credential-error + "Fix this
  // connection" flow (CL-6092), not here.
  test("an unproven key is stored and seeded immediately, with no probe call", async () => {
    const seedCatalogCalls: unknown[] = [];
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await completeCredentialSetup({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "anthropic",
      apiKey: "sk-ant-never-probed",
      pushWorkflow: noopPush,
      log: collector().log,
      ...stubPersistFns,
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
        return { hasCompletionCapableModel: true };
      },
      seedTenantFn: async () => {},
    });

    expect(result.kind).toBe("seeded");
    expect(seedCatalogCalls).toHaveLength(1);
  });

  test("a valid key with no personal bench yet is reported, not guessed at", async () => {
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return {
          status: 200,
          data: { data: [], nextCursor: null },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await completeCredentialSetup({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "anthropic",
      apiKey: "sk-ant-good",
      pushWorkflow: noopPush,
      log: collector().log,
    });

    expect(result).toEqual({ kind: "no-personal-bench" });
  });

  test("a valid Anthropic key seeds the catalog, the tenant, and reports what ran", async () => {
    const seedCatalogCalls: unknown[] = [];
    const seedTenantCalls: {
      model: { provider: string; model: string };
      confirmDeployments?: boolean;
    }[] = [];
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await completeCredentialSetup({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "anthropic",
      apiKey: "sk-ant-good",
      pushWorkflow: noopPush,
      log: collector().log,
      ...stubPersistFns,
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
        return { hasCompletionCapableModel: true };
      },
      seedTenantFn: async (args) => {
        seedTenantCalls.push(args as never);
      },
    });

    expect(result).toEqual({
      kind: "seeded",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      workflows: ["assistant"],
    });
    expect(seedCatalogCalls).toHaveLength(1);
    expect(seedTenantCalls[0]?.model.provider).toBe("anthropic");
    expectNoConfirmation(seedTenantCalls);
  });

  test("a valid OpenAI key seeds its own catalog and routines", async () => {
    const seedCatalogCalls: unknown[] = [];
    const seedTenantCalls: { model: { provider: string; model: string } }[] =
      [];
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await completeCredentialSetup({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "openai",
      apiKey: "sk-good",
      pushWorkflow: noopPush,
      log: collector().log,
      ...stubPersistFns,
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
        return { hasCompletionCapableModel: true };
      },
      seedTenantFn: async (args) => {
        seedTenantCalls.push(args as never);
      },
    });

    expect(result).toEqual({
      kind: "seeded",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      workflows: ["assistant"],
    });
    expect(seedCatalogCalls).toHaveLength(1);
    expect(seedTenantCalls).toHaveLength(1);
    expect(seedTenantCalls[0]?.model.provider).toBe("openai");
  });

  test("a valid Groq key seeds the shared OpenAI-compatible catalog and routines", async () => {
    const seedCatalogCalls: { provider?: string }[] = [];
    const seedTenantCalls: { model: { provider: string; model: string } }[] =
      [];
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await completeCredentialSetup({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "groq",
      apiKey: "gsk-good",
      pushWorkflow: noopPush,
      log: collector().log,
      ...stubPersistFns,
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args as never);
        return { hasCompletionCapableModel: true };
      },
      seedTenantFn: async (args) => {
        seedTenantCalls.push(args as never);
      },
    });

    expect(result).toEqual({
      kind: "seeded",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      workflows: ["assistant"],
    });
    expect(seedCatalogCalls).toHaveLength(1);
    expect(seedCatalogCalls[0]?.provider).toBe("groq");
    expect(seedTenantCalls).toHaveLength(1);
    expect(seedTenantCalls[0]?.model.provider).toBe("openai-compatible");
  });

  test("a Hugging Face connect token stores its expiry as oauth_token credential metadata", async () => {
    const seedCatalogCalls: {
      provider?: string;
      credentialType?: string;
      credentialMetadata?: Record<string, unknown>;
    }[] = [];
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await completeCredentialSetup({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "huggingface",
      apiKey: "hf_oauth_minted",
      credentialMetadata: { expiresAt: "2026-08-13T20:00:00.000Z" },
      pushWorkflow: noopPush,
      log: collector().log,
      ...stubPersistFns,
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args as never);
        return { hasCompletionCapableModel: true };
      },
      seedTenantFn: async () => {},
    });

    expect(result.kind).toBe("seeded");
    expect(seedCatalogCalls).toEqual([
      expect.objectContaining({
        provider: "huggingface",
        credentialType: "oauth_token",
        credentialMetadata: { expiresAt: "2026-08-13T20:00:00.000Z" },
      }),
    ]);
  });

  test("a reconnect against an expired Hugging Face credential rotates it and still reports seeded", async () => {
    const TIMESTAMP = "2026-01-01T00:00:00.000Z";
    const staleCredentialRow = () => ({
      id: "cre_old",
      tenantId: TENANT_ID,
      providerId: "prv_1",
      name: "Hugging Face",
      type: "oauth_token",
      status: "expired",
      metadata: { expiresAt: "2026-01-01T00:00:00.000Z" },
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    });
    let patchCalls = 0;
    let patchBody: unknown;

    const api: ApiCall = async (method, path, body) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`) {
        return {
          status: 201,
          data: {
            id: "prv_1",
            tenantId: TENANT_ID,
            name: "huggingface",
            plugin: "openai-compatible",
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/credentials`
      ) {
        return { status: 409, data: { error: "name taken" }, cookies: [] };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/credentials`
      ) {
        return {
          status: 200,
          data: { data: [staleCredentialRow()], nextCursor: null },
          cookies: [],
        };
      }
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
            metadata: { expiresAt: "2026-08-13T20:00:00.000Z" },
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        return {
          status: 201,
          data: {
            id: "mdl_1",
            tenantId: TENANT_ID,
            canonicalName: "deepseek-ai/DeepSeek-V4-Flash",
            disabled: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      ) {
        return {
          status: 201,
          data: {
            id: "cpv_1",
            tenantId: TENANT_ID,
            name: "huggingface",
            plugin: "openai-compatible",
            baseURL: "https://router.huggingface.co/v1",
            credentialId: "cre_old",
            disabled: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      ) {
        return {
          status: 201,
          data: {
            id: "off_1",
            tenantId: TENANT_ID,
            modelId: "mdl_1",
            providerId: "cpv_1",
            priority: 0,
            deploymentTags: [],
            capabilities: [],
            quirks: null,
            disabled: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        (path === `/api/tenants/${TENANT_ID}/catalog/offerings` ||
          path.startsWith(`/api/tenants/${TENANT_ID}/catalog/offerings?`))
      ) {
        return {
          status: 200,
          data: { data: [], nextCursor: null },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await completeCredentialSetup({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "huggingface",
      apiKey: "hf_freshly_minted_token",
      credentialMetadata: { expiresAt: "2026-08-13T20:00:00.000Z" },
      pushWorkflow: noopPush,
      log: collector().log,
      // The real seedCatalog runs here (not mocked) so the rotation
      // actually happens through ensureCredential; only the workflow
      // deploy side is stubbed, since it is not this defect's concern.
      seedTenantFn: async () => {},
    });

    expect(result.kind).toBe("seeded");
    expect(patchCalls).toBe(1);
    expect(patchBody).toEqual({
      secret: "hf_freshly_minted_token",
      status: "active",
      metadata: { expiresAt: "2026-08-13T20:00:00.000Z" },
    });
  });

  test("a valid key seeds every default workflow without any deploy-confirmation trigger call", async () => {
    // No `seedTenantFn` override here: the real `seedTenant` runs, so
    // this is the actual code path a connect callback drives end to
    // end (only `seedCatalogFn` is stubbed — the catalog side is
    // unrelated to this defect and already covered above). A fake
    // `api` that throws on any workflow run-listing or mail-trigger
    // call proves `completeCredentialSetup` never asks seedTenant to
    // confirm a deployment by triggering real inference — the fix for
    // the false "setup failed" a credit-less but valid key used to get.
    const TIMESTAMP = "2026-01-01T00:00:00.000Z";
    const assets: { name: string; id: string }[] = [];
    const deployments: { definitionAssetId: string; id: string }[] = [];
    const api: ApiCall = async (method, path, body) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
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
        const name = (body as { name: string }).name;
        const id = `ast_${name}`;
        assets.push({ name, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            kind: "workflow",
            name,
            displayName: name,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
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
          data: assets.map((a) => ({
            id: a.id,
            tenantId: TENANT_ID,
            kind: "workflow",
            name: a.name,
            displayName: a.name,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
            origin: { tenantId: TENANT_ID, direct: true },
          })),
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
      const handshake = seedHandshake(method, path);
      if (handshake) return handshake;
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return {
          status: 200,
          data: deployments.map((d) => ({
            id: d.id,
            tenantId: TENANT_ID,
            definitionAssetId: d.definitionAssetId,
            status: "deployed",
            createdAt: TIMESTAMP,
          })),
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        const assetId = (body as { source: { assetId: string } }).source
          .assetId;
        const id = `dep_${assetId}`;
        deployments.push({ definitionAssetId: assetId, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            definitionAssetId: assetId,
            status: "deployed",
            createdAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path.includes("/workflows/") &&
        path.endsWith("/runs")
      ) {
        throw new Error(
          `unexpected run-listing call for an unproven, never-triggered key: ${method} ${path}`,
        );
      }
      if (
        method === "POST" &&
        path.includes("/workflows/") &&
        path.endsWith("/mail")
      ) {
        throw new Error(
          `unexpected workflow trigger call for an unproven, never-triggered key: ${method} ${path}`,
        );
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await completeCredentialSetup({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "anthropic",
      apiKey: "sk-ant-good",
      pushWorkflow: noopPush,
      log: collector().log,
      ...stubPersistFns,
      seedCatalogFn: async () => ({ hasCompletionCapableModel: true }),
    });

    expect(result.kind).toBe("seeded");
    if (result.kind === "seeded") {
      expect(result.workflows).toEqual(["assistant"]);
    }
  });

  test("a second credential save for the same account is idempotent — no duplicate assets, deployments, grants, or catalog rows", async () => {
    // Two credential saves racing (or a person resubmitting the same
    // provider) must not double-seed: seedCatalog and seedTenant's
    // ensure-then-create helpers already tolerate a 409 on the second
    // create by listing the existing row instead, and this proves that
    // tolerance holds end to end through `completeCredentialSetup`,
    // called twice, with the real (non-mocked) seedCatalog and
    // seedTenant driving a stateful fake hub.
    const TIMESTAMP = "2026-01-01T00:00:00.000Z";
    type Row = { name: string; id: string };
    const grants: { resource: string; action: string }[] = [];
    const assets: Row[] = [];
    const deployments: { definitionAssetId: string; id: string }[] = [];
    const catalogModels: Row[] = [];
    const catalogProviders: Row[] = [];
    const catalogOfferings: {
      id: string;
      modelId: string;
      providerId: string;
      priority: number;
    }[] = [];
    const providers: Row[] = [];
    const credentials: Row[] = [];
    let assetCreatePosts = 0;
    let deploymentCreatePosts = 0;
    let catalogModelCreatePosts = 0;
    let catalogProviderCreatePosts = 0;
    let catalogOfferingCreatePosts = 0;
    let credentialCreatePosts = 0;
    let credentialRotatePatches = 0;

    const api: ApiCall = async (method, path, body) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      ) {
        return {
          status: 200,
          data: {
            data: grants.map((g, index) => ({
              id: `grt_${index}`,
              tenantId: TENANT_ID,
              resource: g.resource,
              action: g.action,
              effect: "allow",
              principalId: PRINCIPAL_ID,
              origin: "creator",
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
            })),
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`) {
        const g = body as { resource: string; action: string };
        grants.push({ resource: g.resource, action: g.action });
        return { status: 201, data: {}, cookies: [] };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`) {
        const name = (body as { name: string }).name;
        const existing = assets.find((a) => a.name === name);
        if (existing) return { status: 409, data: {}, cookies: [] };
        assetCreatePosts += 1;
        const id = `ast_${name}`;
        assets.push({ name, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            kind: "workflow",
            name,
            displayName: name,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
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
          data: assets.map((a) => ({
            id: a.id,
            tenantId: TENANT_ID,
            kind: "workflow",
            name: a.name,
            displayName: a.name,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
            origin: { tenantId: TENANT_ID, direct: true },
          })),
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
      const handshake = seedHandshake(method, path);
      if (handshake) return handshake;
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return {
          status: 200,
          data: deployments.map((d) => ({
            id: d.id,
            tenantId: TENANT_ID,
            definitionAssetId: d.definitionAssetId,
            status: "deployed",
            createdAt: TIMESTAMP,
          })),
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        deploymentCreatePosts += 1;
        const assetId = (body as { source: { assetId: string } }).source
          .assetId;
        const id = `dep_${assetId}`;
        deployments.push({ definitionAssetId: assetId, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            definitionAssetId: assetId,
            status: "deployed",
            createdAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/workflows/runs/`) &&
        path.endsWith("/health")
      ) {
        return {
          status: 200,
          data: { liveness: "ok", readiness: "ok", lastCheckedAt: null },
          cookies: [],
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/providers`) {
        const name = (body as { name: string }).name;
        const existing = providers.find((p) => p.name === name);
        if (existing) return { status: 409, data: {}, cookies: [] };
        const id = `prv_${name}`;
        providers.push({ name, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            name,
            plugin: "anthropic",
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/providers?inherited=false`
      ) {
        return {
          status: 200,
          data: {
            data: providers.map((p) => ({
              id: p.id,
              tenantId: TENANT_ID,
              name: p.name,
              plugin: "anthropic",
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
            })),
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/credentials`
      ) {
        const name = (body as { name: string }).name;
        const existing = credentials.find((c) => c.name === name);
        if (existing) return { status: 409, data: {}, cookies: [] };
        credentialCreatePosts += 1;
        const id = `cre_${name}`;
        credentials.push({ name, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            providerId: "prv_anthropic",
            name,
            type: "api_key",
            status: "active",
            metadata: null,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/credentials`
      ) {
        return {
          status: 200,
          data: {
            data: credentials.map((c) => ({
              id: c.id,
              tenantId: TENANT_ID,
              providerId: "prv_anthropic",
              name: c.name,
              type: "api_key",
              status: "active",
              metadata: null,
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
            })),
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (
        method === "PATCH" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/credentials/`)
      ) {
        // The second `completeCredentialSetup` call is itself an
        // explicit user submission (`testAndPersistCredential` always
        // sets `credentialVerified: true`, no probe required — CL-6123),
        // so `ensureCredential` rotates the existing api_key row instead
        // of leaving it untouched — this is the fix under test here,
        // not a duplicate creation, so `credentialCreatePosts` still
        // stays at 1.
        credentialRotatePatches += 1;
        const id = path.split("/").pop() as string;
        return {
          status: 200,
          data: {
            id,
            tenantId: TENANT_ID,
            providerId: "prv_anthropic",
            name: "Anthropic",
            type: "api_key",
            status: "active",
            metadata: null,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        const canonicalName = (body as { canonicalName: string }).canonicalName;
        const existing = catalogModels.find((m) => m.name === canonicalName);
        if (existing) return { status: 409, data: {}, cookies: [] };
        catalogModelCreatePosts += 1;
        const id = `mdl_${canonicalName}`;
        catalogModels.push({ name: canonicalName, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            canonicalName,
            disabled: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/models`
      ) {
        return {
          status: 200,
          data: {
            data: catalogModels.map((m) => ({
              id: m.id,
              tenantId: TENANT_ID,
              canonicalName: m.name,
              disabled: false,
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
            })),
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      ) {
        const name = (body as { name: string }).name;
        const existing = catalogProviders.find((p) => p.name === name);
        if (existing) return { status: 409, data: {}, cookies: [] };
        catalogProviderCreatePosts += 1;
        const id = `cpv_${name}`;
        catalogProviders.push({ name, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            name,
            plugin: "anthropic",
            baseURL: "https://api.anthropic.com",
            credentialId: "cre_anthropic-default",
            disabled: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/catalog/providers`
      ) {
        return {
          status: 200,
          data: {
            data: catalogProviders.map((p) => ({
              id: p.id,
              tenantId: TENANT_ID,
              name: p.name,
              plugin: "anthropic",
              baseURL: "https://api.anthropic.com",
              credentialId: "cre_anthropic-default",
              disabled: false,
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
            })),
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/catalog/offerings`
      ) {
        const b = body as {
          modelId: string;
          providerId: string;
          priority: number;
        };
        const existing = catalogOfferings.find(
          (o) => o.modelId === b.modelId && o.providerId === b.providerId,
        );
        if (existing) return { status: 409, data: {}, cookies: [] };
        catalogOfferingCreatePosts += 1;
        const id = `off_${catalogOfferings.length + 1}`;
        catalogOfferings.push({
          id,
          modelId: b.modelId,
          providerId: b.providerId,
          priority: b.priority,
        });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            modelId: b.modelId,
            providerId: b.providerId,
            priority: b.priority,
            deploymentTags: [],
            capabilities: [],
            quirks: null,
            disabled: false,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        (path === `/api/tenants/${TENANT_ID}/catalog/offerings` ||
          path.startsWith(`/api/tenants/${TENANT_ID}/catalog/offerings?`))
      ) {
        return {
          status: 200,
          data: {
            data: catalogOfferings.map((o) => ({
              id: o.id,
              tenantId: TENANT_ID,
              modelId: o.modelId,
              providerId: o.providerId,
              priority: o.priority,
              deploymentTags: [],
              capabilities: [],
              quirks: null,
              disabled: false,
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
            })),
            nextCursor: null,
          },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const submitCredential = () =>
      completeCredentialSetup({
        api,
        cookies: ["session=abc"],
        hubUrl: "http://localhost:3000",
        userId: "user_1",
        userEmail: "alice@example.com",
        provider: "anthropic",
        apiKey: "sk-ant-good",
        pushWorkflow: noopPush,
        log: collector().log,
      });

    const first = await submitCredential();
    expect(first.kind).toBe("seeded");
    const second = await submitCredential();
    expect(second.kind).toBe("seeded");

    // Every ensure-then-create helper hit its 409 branch on the second
    // pass and listed the row it already created on the first — nothing
    // was ever created twice. Anthropic's curated seed is several models
    // (one POST each for model and offering); the rest of the chain is
    // still a single provider/credential row.
    const anthropicCatalogSize = CATALOG_SEEDS.anthropic.models.length;
    expect(assetCreatePosts).toBe(1);
    expect(deploymentCreatePosts).toBe(1);
    expect(catalogModelCreatePosts).toBe(anthropicCatalogSize);
    expect(catalogProviderCreatePosts).toBe(1);
    expect(catalogOfferingCreatePosts).toBe(anthropicCatalogSize);
    expect(credentialCreatePosts).toBe(1);
    // The second pass is itself an explicit submission and rotates the
    // existing row rather than leaving it untouched (the CL-6103 fix,
    // updated by CL-6123 to no longer require a probe first).
    expect(credentialRotatePatches).toBe(1);
    expect(assets.length).toBe(1);
    expect(deployments.length).toBe(1);
  });

  test("a pasted key with no metadata stays an ordinary api_key credential", async () => {
    const seedCatalogCalls: { credentialType?: string }[] = [];
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    await completeCredentialSetup({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "huggingface",
      apiKey: "hf_pasted_pat",
      pushWorkflow: noopPush,
      log: collector().log,
      ...stubPersistFns,
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args as never);
        return { hasCompletionCapableModel: true };
      },
      seedTenantFn: async () => {},
    });

    expect(seedCatalogCalls).toEqual([
      expect.objectContaining({ credentialType: "api_key" }),
    ]);
  });

  // CL-6264: the credential-persist half already succeeded (the tenant,
  // principal, and credential are real and durable) by the time the
  // deploy step hits a sidecar-unavailable failure, so `/complete`'s own
  // route can write a pending-seed row for the retry path — it needs
  // `principalId`/`tenantDomain` threaded all the way out here to do it.
  test("a sidecar-unavailable deploy still reports the durable tenant identity, not just deployed/pending", async () => {
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
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
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return { status: 200, data: [], cookies: [] };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await completeCredentialSetup({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "anthropic",
      apiKey: "sk-ant-good",
      pushWorkflow: noopPush,
      log: collector().log,
      ...stubPersistFns,
      seedCatalogFn: async () => ({ hasCompletionCapableModel: true }),
      seedTenantFn: async () => {
        throw new SidecarUnavailableError(
          "the hub could not deploy workflow echo: the sidecar is unavailable",
          "start the stack (`bun run dev` runs the hub and sidecar together), wait for the sidecar to connect, then re-run: workbench seed",
        );
      },
    });

    expect(result).toEqual({
      kind: "seeded-pending-agents",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      principalId: PRINCIPAL_ID,
      tenantDomain: "alice-user1.bench.local",
      deployed: [],
      pending: ["assistant"],
      message: "Your workbench is ready — agents will come online shortly.",
    });
  });
});

describe("testAndPersistCredential (the fast half)", () => {
  test("proves and persists the key, but never deploys a workflow", async () => {
    let seedTenantCalled = false;
    const seedCatalogCalls: unknown[] = [];
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      // Any workflow-shaped call proves this half reached past its
      // remit — `testAndPersistCredential` should never touch these.
      if (path.includes("/workflows/") || path.endsWith("/assets")) {
        throw new Error(`unexpected workflow-shaped call: ${method} ${path}`);
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await testAndPersistCredential({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "anthropic",
      apiKey: "sk-ant-good",
      pushWorkflow: async () => {
        seedTenantCalled = true;
        return { outcome: "pushed" as const, commitSha: "a".repeat(40) };
      },
      log: collector().log,
      ...stubPersistFns,
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
        return { hasCompletionCapableModel: true };
      },
    });

    expect(result).toEqual({
      kind: "connected",
      tenantId: TENANT_ID,
      tenantSlug: TENANT_SLUG,
      principalId: PRINCIPAL_ID,
      tenantDomain: "alice-user1.bench.local",
    });
    expect(seedCatalogCalls).toHaveLength(1);
    expect(seedTenantCalled).toBe(false);
  });

  test("an unproven key still reaches and persists on the tenant — no probe gates this", async () => {
    const seedCatalogCalls: unknown[] = [];
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await testAndPersistCredential({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "anthropic",
      apiKey: "sk-ant-never-probed",
      pushWorkflow: noopPush,
      log: collector().log,
      ...stubPersistFns,
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
        return { hasCompletionCapableModel: true };
      },
    });

    expect(result.kind).toBe("connected");
    expect(seedCatalogCalls).toHaveLength(1);
  });

  // CL-6105: the Plugins gallery resolves a connector's connection status
  // by `GET .../credentials/resolve/:name`, looking that credential up by
  // the connector's own `descriptor.displayName` ("OpenRouter"). Seeding
  // it under the catalog-seed convention (`openrouter-default`) instead
  // — as `seedCatalog` does by default — left a freshly connected
  // OpenRouter credential permanently invisible to that gallery: the
  // callback redirected back with `outcome=connected`, but the card kept
  // reading "not connected" because the two write/read paths disagreed
  // on the row's name.
  test("seeds the OAuth connect flow's credential under the Plugins gallery's own lookup name", async () => {
    const seedCatalogCalls: { credentialName?: string }[] = [];
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return principalsResponse();
      }
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`) {
        return tenantResponse();
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await testAndPersistCredential({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "openrouter",
      apiKey: "sk-or-good",
      pushWorkflow: noopPush,
      log: collector().log,
      ...stubPersistFns,
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
        return { hasCompletionCapableModel: true };
      },
    });

    expect(result.kind).toBe("connected");
    expect(seedCatalogCalls).toHaveLength(1);
    expect(seedCatalogCalls[0]?.credentialName).toBe("OpenRouter");
  });

  test("a valid key with no personal bench yet is reported, not guessed at", async () => {
    const api: ApiCall = async (method, path) => {
      if (method === "GET" && path === "/api/me/principals") {
        return {
          status: 200,
          data: { data: [], nextCursor: null },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await testAndPersistCredential({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      userId: "user_1",
      userEmail: "alice@example.com",
      provider: "anthropic",
      apiKey: "sk-ant-good",
      pushWorkflow: noopPush,
      log: collector().log,
    });

    expect(result).toEqual({ kind: "no-personal-bench" });
  });
});

describe("ensureSeeded (the slow half)", () => {
  const TENANT: {
    tenantId: string;
    tenantSlug: string;
    principalId: string;
    tenantDomain: string;
  } = {
    tenantId: TENANT_ID,
    tenantSlug: TENANT_SLUG,
    principalId: PRINCIPAL_ID,
    tenantDomain: "alice-user1.bench.local",
  };

  test("deploys every default workflow against the connected provider's own model, unconfirmed", async () => {
    const seedTenantCalls: {
      model: { provider: string; model: string };
      confirmDeployments?: boolean;
    }[] = [];

    const result = await ensureSeeded({
      api: (async () => {
        throw new Error(
          "the real api must not be called — seedTenantFn is stubbed",
        );
      }) as ApiCall,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      pushWorkflow: noopPush,
      log: collector().log,
      tenant: TENANT,
      provider: "anthropic",
      apiKey: "sk-ant-good",
      seedTenantFn: async (args) => {
        seedTenantCalls.push(args as never);
      },
    });

    expect(result).toEqual({
      kind: "seeded",
      workflows: ["assistant"],
    });
    expectNoConfirmation(seedTenantCalls);
    expect(seedTenantCalls[0]?.model.provider).toBe("anthropic");
  });

  test("deploys the setup agent before anything else, so a waiting person can start as soon as she is live", async () => {
    // CL-6462. This is the deploy path the background drain runs
    // (bench-provisioning's `runOnce` → `ensureSeeded` → `seedTenant`),
    // and `seedTenant` works through the list in order at ~20s each — so
    // the order handed in here is the order a fresh signup experiences.
    // CL-7074 narrowed DEFAULT_WORKFLOWS to just the setup agent, so
    // "before anything else" is now trivially satisfied by being the
    // only entry — this still pins that fact rather than assuming it.
    const workflowOrder: string[] = [];

    await ensureSeeded({
      api: (async () => {
        throw new Error(
          "the real api must not be called — seedTenantFn is stubbed",
        );
      }) as ApiCall,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      pushWorkflow: noopPush,
      log: collector().log,
      tenant: TENANT,
      provider: "anthropic",
      apiKey: "sk-ant-good",
      seedTenantFn: async (args) => {
        for (const workflow of args.workflows ?? []) {
          workflowOrder.push(workflow.assetName);
        }
      },
    });

    expect(workflowOrder[0]).toBe(SETUP_AGENT_ASSET_NAME);
  });

  test("two overlapping calls for the same tenant never double-deploy — the same 409-then-list tolerance seedTenant already has", async () => {
    const TIMESTAMP = "2026-01-01T00:00:00.000Z";
    type Row = { name: string; id: string };
    const grants: { resource: string; action: string }[] = [];
    const assets: Row[] = [];
    const deployments: { definitionAssetId: string; id: string }[] = [];
    let assetCreatePosts = 0;
    let deploymentCreatePosts = 0;

    const api: ApiCall = async (method, path, body) => {
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      ) {
        return {
          status: 200,
          data: {
            data: grants.map((g, index) => ({
              id: `grt_${index}`,
              tenantId: TENANT_ID,
              resource: g.resource,
              action: g.action,
              effect: "allow",
              principalId: PRINCIPAL_ID,
              origin: "creator",
              createdAt: TIMESTAMP,
              updatedAt: TIMESTAMP,
            })),
            nextCursor: null,
          },
          cookies: [],
        };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/grants`) {
        const g = body as { resource: string; action: string };
        grants.push({ resource: g.resource, action: g.action });
        return { status: 201, data: {}, cookies: [] };
      }
      if (method === "POST" && path === `/api/tenants/${TENANT_ID}/assets`) {
        const name = (body as { name: string }).name;
        const existing = assets.find((a) => a.name === name);
        if (existing) return { status: 409, data: {}, cookies: [] };
        assetCreatePosts += 1;
        const id = `ast_${name}`;
        assets.push({ name, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            kind: "workflow",
            name,
            displayName: name,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
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
          data: assets.map((a) => ({
            id: a.id,
            tenantId: TENANT_ID,
            kind: "workflow",
            name: a.name,
            displayName: a.name,
            creatorPrincipalId: PRINCIPAL_ID,
            createdAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
            origin: { tenantId: TENANT_ID, direct: true },
          })),
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
      const handshake = seedHandshake(method, path);
      if (handshake) return handshake;
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return {
          status: 200,
          data: deployments.map((d) => ({
            id: d.id,
            tenantId: TENANT_ID,
            definitionAssetId: d.definitionAssetId,
            status: "deployed",
            createdAt: TIMESTAMP,
          })),
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/workflows/runs/`) &&
        path.endsWith("/health")
      ) {
        return {
          status: 200,
          data: { liveness: "ok", readiness: "ok", lastCheckedAt: null },
          cookies: [],
        };
      }
      if (
        method === "POST" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        deploymentCreatePosts += 1;
        const assetId = (body as { source: { assetId: string } }).source
          .assetId;
        const id = `dep_${assetId}`;
        deployments.push({ definitionAssetId: assetId, id });
        return {
          status: 201,
          data: {
            id,
            tenantId: TENANT_ID,
            definitionAssetId: assetId,
            status: "deployed",
            createdAt: TIMESTAMP,
          },
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const runEnsureSeeded = () =>
      ensureSeeded({
        api,
        cookies: ["session=abc"],
        hubUrl: "http://localhost:3000",
        pushWorkflow: noopPush,
        log: collector().log,
        tenant: TENANT,
        provider: "anthropic",
        apiKey: "sk-ant-good",
      });

    // Two overlapping calls, exactly like two concurrent
    // `/complete-setup` requests reading the same still-valid pending
    // token, running back to back against the same stateful fake hub.
    const [first, second] = await Promise.all([
      runEnsureSeeded(),
      runEnsureSeeded(),
    ]);

    expect(first.kind).toBe("seeded");
    expect(second.kind).toBe("seeded");
    expect(assetCreatePosts).toBe(1);
    expect(deploymentCreatePosts).toBe(1);
    expect(assets.length).toBe(1);
    expect(deployments.length).toBe(1);
  });

  // CL-6264: tonight's live failure — completeCredentialSetup ->
  // seedTenant -> deployWorkflow hit sidecar_unavailable and the whole
  // flow failed, even though the credential, tenant, grants, and assets
  // all durably succeeded. `ensureSeeded` must parse that specific
  // `CliError` subclass and report an honest partial state instead of
  // throwing.
  test("a sidecar-unavailable deploy reports which workflows deployed and which are pending, instead of failing the whole flow", async () => {
    const TIMESTAMP = "2026-01-01T00:00:00.000Z";
    const assetRow = (name: string) => ({
      id: `ast_${name}`,
      tenantId: TENANT_ID,
      kind: "workflow",
      name,
      displayName: name,
      creatorPrincipalId: PRINCIPAL_ID,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      origin: { tenantId: TENANT_ID, direct: true },
    });
    const api: ApiCall = async (method, path) => {
      if (
        method === "GET" &&
        path ===
          `/api/tenants/${TENANT_ID}/assets?kind=workflow&inherited=false`
      ) {
        return {
          status: 200,
          data: [assetRow("echo"), assetRow("assistant")],
          cookies: [],
        };
      }
      if (
        method === "GET" &&
        path === `/api/tenants/${TENANT_ID}/workflows/deployments`
      ) {
        return {
          status: 200,
          data: [
            { definitionAssetId: "ast_echo", status: "deployed" },
            { definitionAssetId: "ast_assistant", status: "deployed" },
          ],
          cookies: [],
        };
      }
      throw new Error(`unexpected call: ${method} ${path}`);
    };

    const result = await ensureSeeded({
      api,
      cookies: ["session=abc"],
      hubUrl: "http://localhost:3000",
      pushWorkflow: noopPush,
      log: collector().log,
      tenant: TENANT,
      provider: "anthropic",
      apiKey: "sk-ant-good",
      seedTenantFn: async () => {
        throw new SidecarUnavailableError(
          "the hub could not deploy workflow workbench-digest: the sidecar is unavailable",
          "start the stack (`bun run dev` runs the hub and sidecar together), wait for the sidecar to connect, then re-run: workbench seed",
        );
      },
    });

    expect(result).toEqual({
      kind: "seeded-pending-agents",
      deployed: ["assistant"],
      pending: [],
      message: "Your workbench is ready — agents will come online shortly.",
    });
  });

  test("a non-sidecar deploy failure still fails the flow loudly", async () => {
    await expect(
      ensureSeeded({
        api: (async () => {
          throw new Error("api must not be called before seedTenantFn runs");
        }) as ApiCall,
        cookies: ["session=abc"],
        hubUrl: "http://localhost:3000",
        pushWorkflow: noopPush,
        log: collector().log,
        tenant: TENANT,
        provider: "anthropic",
        apiKey: "sk-ant-good",
        seedTenantFn: async () => {
          throw new Error("the hub rejected the deployment with status 500");
        },
      }),
    ).rejects.toThrow("the hub rejected the deployment with status 500");
  });
});
