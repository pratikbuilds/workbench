// The composition root's credential-cipher gate: a self-hosting operator who
// never sets CREDENTIAL_ENCRYPTION_KEY must not silently end up with
// webhook-trigger signing secrets and onboarding OAuth connect state stored
// unencrypted. A missing key hard-fails boot unless the operator explicitly
// opts into dev/test behavior with ALLOW_PLAINTEXT_SECRETS.

import { describe, expect, test } from "bun:test";
import { getLogger } from "@intx/log";
import { tagCredentialCipher } from "@corbits/folded-runs";
import type { HubConfig } from "../src/config.ts";
import { credentialCipherFrom, hubCredentialCipher } from "../src/index.ts";

const log = getLogger(["hub", "test"]);

const baseConfig: HubConfig = {
  databaseUrl: "postgres://workbench:workbench@localhost:5432/workbench",
  baseUrl: "http://localhost:3000",
  sessionSecret: "insecure-test-only-session-secret-0000",
  hubDataDir: ".data/hub",
  hubStaticDir: "apps/hub/public",
  defaultTenantSlug: "workbench",
  signupRateLimit: { windowSeconds: 60, max: 5 },
  signInRateLimit: { windowSeconds: 60, max: 10 },
  socialProviders: {},
  signupMode: "closed",
  allowedEmailDomains: [],
  allowPlaintextSecrets: false,
  allowUnverifiedEmails: false,
  sidecarProvisioners: [],
  envProviderKeys: {},
  envProviderBaseUrls: {},
  envCredentialPlantAdmin: {
    email: "alice@example.com",
    password: "password123",
    orgSlug: "workbench",
  },
  chatIdleReapMs: 30 * 60_000,
};

describe("credentialCipherFrom", () => {
  test("no key and no dev opt-in hard-fails boot, naming the variable, what it protects, and how to generate a key", () => {
    expect(() => credentialCipherFrom(baseConfig, log)).toThrow(
      /CREDENTIAL_ENCRYPTION_KEY/,
    );
    try {
      credentialCipherFrom(baseConfig, log);
      throw new Error("expected credentialCipherFrom to throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("CREDENTIAL_ENCRYPTION_KEY");
      expect(message).toContain("webhook-trigger signing secrets");
      expect(message).toContain("onboarding's OAuth PKCE connect state");
      expect(message).toContain("openssl rand -hex 32");
      expect(message).toContain("ALLOW_PLAINTEXT_SECRETS");
    }
  });

  test("no key with ALLOW_PLAINTEXT_SECRETS set warns and falls back to the noop cipher", async () => {
    const cipher = credentialCipherFrom(
      { ...baseConfig, allowPlaintextSecrets: true },
      log,
    );
    const encrypted = await cipher.encrypt("secret-value", "aad");
    expect(encrypted).toBe("secret-value");
  });

  test("a configured key builds a real cipher that actually encrypts", async () => {
    const cipher = credentialCipherFrom(
      {
        ...baseConfig,
        credentialEncryptionKeyHex: "a".repeat(64),
      },
      log,
    );
    const encrypted = await cipher.encrypt("secret-value", "aad");
    expect(encrypted).not.toBe("secret-value");
  });
});

describe("hubCredentialCipher", () => {
  test("boot tags the cipher built from a configured key", async () => {
    const cipher = hubCredentialCipher(
      {
        ...baseConfig,
        credentialEncryptionKeyHex: "a".repeat(64),
      },
      log,
    );
    expect(cipher).toBe(tagCredentialCipher(cipher));
    const encrypted = await cipher.encrypt("secret-value", "aad");
    expect(encrypted).not.toBe("secret-value");
  });

  test("boot tags the noop cipher when ALLOW_PLAINTEXT_SECRETS is set", async () => {
    const cipher = hubCredentialCipher(
      { ...baseConfig, allowPlaintextSecrets: true },
      log,
    );
    expect(cipher).toBe(tagCredentialCipher(cipher));
    const encrypted = await cipher.encrypt("secret-value", "aad");
    expect(encrypted).toBe("secret-value");
  });

  test("boot still hard-fails when the key is missing and plaintext is not opted in", () => {
    expect(() => hubCredentialCipher(baseConfig, log)).toThrow(
      /CREDENTIAL_ENCRYPTION_KEY/,
    );
  });
});
