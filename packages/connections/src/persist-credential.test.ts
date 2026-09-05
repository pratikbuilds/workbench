// The shared persist-and-seed sequence (CL-6394): one place decides
// which connectors seed a model catalog — a non-inference connector
// (GitHub) must never reach `CATALOG_SEEDS`, the exact fall-through
// that crashed the hosted one-click connect when three parallel copies
// of this sequence disagreed.
import { describe, expect, test } from "bun:test";
import type {
  EnsureCredentialArgs,
  EnsureProviderArgs,
  SeedCatalogArgs,
} from "@corbits/seeding";
import type { ConnectorDescriptor } from "./descriptor";
import {
  isInferenceProvider,
  persistConnectorCredential,
  type PersistConnectorCredentialArgs,
} from "./persist-credential";
/** Minimal fixtures standing in for the real connector set a build's own
 * `templates/connectors.ts` carries — this package holds no concrete
 * connector set of its own (CL-7384), so its own tests build only the
 * fields `persistConnectorCredential` actually reads. */
const FIXTURE_REGISTRY: Readonly<Record<string, ConnectorDescriptor>> = {
  github: {
    id: "github",
    displayName: "GitHub",
    authKind: "api-key",
    credentialPlugin: "http",
    docsUrl: "https://github.com/settings/tokens",
    feedsTools: ["@corbits/github-tools"],
  },
  manus: {
    id: "manus",
    displayName: "Manus",
    authKind: "api-key",
    credentialPlugin: "http-x-manus-api-key",
    docsUrl: "https://open.manus.ai/docs/v2/introduction",
    feedsTools: ["@corbits/manus-tools"],
  },
  openrouter: {
    id: "openrouter",
    displayName: "OpenRouter",
    authKind: "oauth-pkce",
    credentialPlugin: "http",
    docsUrl: "https://openrouter.ai",
    feedsTools: [],
  },
  huggingface: {
    id: "huggingface",
    displayName: "Hugging Face",
    authKind: "oauth-pkce",
    credentialPlugin: "http",
    docsUrl: "https://huggingface.co/settings/tokens",
    feedsTools: [],
  },
  ollama: {
    id: "ollama",
    displayName: "Ollama",
    authKind: "api-key",
    credentialPlugin: "http",
    docsUrl: "https://ollama.com",
    feedsTools: [],
    credentialInputKind: "url",
  },
  gmail: {
    id: "gmail",
    displayName: "Gmail",
    authKind: "oauth-code",
    credentialPlugin: "http",
    docsUrl: "https://developers.google.com/gmail/api",
    feedsTools: [],
  },
};

const noApi = () => {
  throw new Error("the api must only be reached through the injected fns");
};

function recordingFns() {
  const providers: EnsureProviderArgs[] = [];
  const credentials: EnsureCredentialArgs[] = [];
  const seeds: SeedCatalogArgs[] = [];
  return {
    providers,
    credentials,
    seeds,
    fns: {
      ensureProviderFn: async (
        _api: unknown,
        _cookies: string[],
        args: EnsureProviderArgs,
      ) => {
        providers.push(args);
        return `prv_${args.name}`;
      },
      ensureCredentialFn: async (
        _api: unknown,
        _cookies: string[],
        args: EnsureCredentialArgs,
      ) => {
        credentials.push(args);
        return `cred_${args.providerId}`;
      },
      seedCatalogFn: async (args: SeedCatalogArgs) => {
        seeds.push(args);
        return { hasCompletionCapableModel: true };
      },
    },
  };
}

function descriptorOrThrow(id: string): ConnectorDescriptor {
  const descriptor = FIXTURE_REGISTRY[id];
  if (descriptor === undefined) throw new Error(`no descriptor for ${id}`);
  return descriptor;
}

describe("persistConnectorCredential", () => {
  test("github (non-inference) persists provider + credential and never seeds a catalog", async () => {
    const { providers, credentials, seeds, fns } = recordingFns();
    const result = await persistConnectorCredential({
      api: noApi as never,
      cookies: [],
      tenantId: "tnt_1",
      descriptor: descriptorOrThrow("github"),
      secret: "gho_exchanged-token",
      log: () => undefined,
      ...fns,
    });

    expect(providers).toEqual([
      { tenantId: "tnt_1", name: "github", plugin: "http" },
    ]);
    expect(credentials).toEqual([
      {
        tenantId: "tnt_1",
        providerId: "prv_github",
        name: "GitHub",
        secret: "gho_exchanged-token",
        type: "api_key",
        verified: true,
      },
    ]);
    expect(seeds).toEqual([]);
    expect(result.credentialId).toBe("cred_prv_github");
  });

  test("manus persists the production API origin so origin-pin can resolve", async () => {
    const { providers, seeds, fns } = recordingFns();
    await persistConnectorCredential({
      api: noApi as never,
      cookies: [],
      tenantId: "tnt_1",
      descriptor: descriptorOrThrow("manus"),
      secret: "manus_key",
      log: () => undefined,
      ...fns,
    });

    expect(providers).toEqual([
      {
        tenantId: "tnt_1",
        name: "manus",
        plugin: "http-x-manus-api-key",
        apiBaseUrl: "https://api.manus.ai",
      },
    ]);
    expect(seeds).toEqual([]);
  });

  test("an inference provider seeds its catalog under the same credential name", async () => {
    const { credentials, seeds, fns } = recordingFns();
    await persistConnectorCredential({
      api: noApi as never,
      cookies: [],
      tenantId: "tnt_1",
      descriptor: descriptorOrThrow("openrouter"),
      secret: "sk-or-abc",
      log: () => undefined,
      ...fns,
    });

    expect(credentials).toHaveLength(1);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      tenantId: "tnt_1",
      provider: "openrouter",
      apiKey: "sk-or-abc",
      credentialName: "OpenRouter",
      credentialType: "api_key",
      credentialVerified: true,
    });
  });

  test("credential metadata types the row oauth_token and rides into the seed", async () => {
    const { credentials, seeds, fns } = recordingFns();
    await persistConnectorCredential({
      api: noApi as never,
      cookies: [],
      tenantId: "tnt_1",
      descriptor: descriptorOrThrow("huggingface"),
      secret: "hf_token",
      credentialMetadata: { expiresAt: "2026-09-01T00:00:00Z" },
      log: () => undefined,
      ...fns,
    });

    expect(credentials[0]).toMatchObject({
      type: "oauth_token",
      metadata: { expiresAt: "2026-09-01T00:00:00Z" },
    });
    expect(seeds[0]).toMatchObject({
      credentialType: "oauth_token",
      credentialMetadata: { expiresAt: "2026-09-01T00:00:00Z" },
    });
  });

  test("a url-kind connect stores the URL on the provider row and threads the base-URL seam", async () => {
    const { providers, seeds, fns } = recordingFns();
    await persistConnectorCredential({
      api: noApi as never,
      cookies: [],
      tenantId: "tnt_1",
      descriptor: descriptorOrThrow("ollama"),
      secret: "placeholder-not-a-real-key",
      baseURLOverride: "http://localhost:11434",
      log: () => undefined,
      ...fns,
    });

    expect(providers[0]).toMatchObject({
      name: "ollama",
      apiBaseUrl: "http://localhost:11434",
    });
    expect(seeds[0]).toMatchObject({
      provider: "ollama",
      baseURLOverride: "http://localhost:11434",
    });
  });
});

describe("isInferenceProvider", () => {
  test("splits inference providers from tool connectors", () => {
    expect(isInferenceProvider("anthropic")).toBe(true);
    expect(isInferenceProvider("openrouter")).toBe(true);
    expect(isInferenceProvider("github")).toBe(false);
    expect(isInferenceProvider("linear")).toBe(false);
    expect(isInferenceProvider("manus")).toBe(false);
  });
});

test("a refresh secret rides into the credential row alongside oauth_token typing", async () => {
  const { credentials, fns } = recordingFns();
  await persistConnectorCredential({
    api: noApi as never,
    cookies: [],
    tenantId: "tnt_1",
    descriptor: descriptorOrThrow("gmail"),
    secret: "ya29.token",
    credentialMetadata: { expiresAt: "2026-09-01T00:00:00Z" },
    refreshSecret: "1//refresh",
    log: () => undefined,
    ...fns,
  });

  expect(credentials[0]).toMatchObject({
    type: "oauth_token",
    refreshSecret: "1//refresh",
  });
});

test("persist does not take a credentialCipher — wiring is asserted at tag construction and hub boot, not per persist", () => {
  type PersistHasCipher =
    "credentialCipher" extends keyof PersistConnectorCredentialArgs
      ? true
      : false;
  const persistHasCipher: PersistHasCipher = false;
  expect(persistHasCipher).toBe(false);
});
