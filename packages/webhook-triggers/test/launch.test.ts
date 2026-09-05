// Proves `launchWebhookTrigger`'s post-launch mail send is hardened the
// same way `apps/hub/src/routine-launcher.test.ts` proves its own copy
// of this shape: a delivery already accepted has already committed a
// real run, so an exhausted `sendFoldedMailWithRetry` must not throw
// past this function (or `createWebhookIngressRoutes` would reject an
// already-launched delivery, and a retried webhook client would then
// mint a duplicate run for the same event).
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let reportErrorCalls: unknown[] = [];

const actualFoldedRuns = await import("@corbits/folded-runs");

const FOLDED_BODY = {
  systemPrompt: "you are a webhook-triggered agent",
  toolPackagePins: [],
  grantRequirements: [],
  credentialBindings: [],
  model: "claude-sonnet-5",
};

let launchFoldedRunCalls: unknown[] = [];
let sendFoldedMailWithRetryCalls: unknown[] = [];
let sendFoldedMailWithRetryResult: unknown = { ok: true, mail: { id: "m_1" } };

mock.module("@corbits/folded-runs", () => ({
  ...actualFoldedRuns,
  readDefinitionProjection: async () => ({ __fake: true }),
  readFoldedBody: () => FOLDED_BODY,
  launchFoldedRun: async (...args: unknown[]) => {
    launchFoldedRunCalls.push(args);
    return {
      instancePrincipalId: "prn_run1",
      sessionId: "ses_run1",
      sourcesDigest: "digest_run1",
    };
  },
  sendFoldedMailWithRetry: async (...args: unknown[]) => {
    sendFoldedMailWithRetryCalls.push(args);
    return sendFoldedMailWithRetryResult;
  },
}));

beforeEach(async () => {
  reportErrorCalls = [];
  await mock.module("@corbits/error-sink", () => ({
    reportError: (...args: unknown[]) => {
      reportErrorCalls.push(args);
      return "ref_test";
    },
  }));
});

afterEach(() => {
  mock.restore();
});

const { launchWebhookTrigger } = await import("../src/launch");

const DEFINITION_ROW = {
  id: "wfd_1",
  tenantId: "ten_1",
  status: "deployed" as const,
  assetId: "ast_1",
};

const TENANT_ROW = {
  id: "ten_1",
  domain: "acme.workbench.test",
};

function createFakeDb() {
  return {
    query: {
      workflowDefinition: { findFirst: async () => DEFINITION_ROW },
      tenant: { findFirst: async () => TENANT_ROW },
    },
  };
}

const TRIGGER = {
  id: "wht_1",
  tenantId: "ten_1",
  name: "Deploy hook",
  workflowDefinitionId: "wfd_1",
  inputTemplate: "deployed: {{status}}",
  secret: "shh",
  enabled: true,
  createdBy: "usr_1",
  createdAt: new Date(),
  lastFiredAt: null,
};

const taggedCipher = {
  encrypt: async (plaintext: string) => plaintext,
  decrypt: async (blob: string) => blob,
};

let persistLaunchCalls: unknown[] = [];
let recordLaunchSourcesCalls: unknown[] = [];
const persistedLaunchExtra = async () => {};

function baseDeps() {
  return {
    db: createFakeDb() as never,
    sessionService: {} as never,
    assetService: {} as never,
    sidecarRouter: {} as never,
    toolGrantsForPins: () => [],
    eventCollectors: {} as never,
    credentialCipher: taggedCipher,
    cryptoProviderCache: { get: async () => ({}) as never },
    launchMode: { kind: "section" as const, turnTimeoutMs: 60_000 },
    persistLaunch: (input: unknown) => {
      persistLaunchCalls.push(input);
      return persistedLaunchExtra;
    },
    recordLaunchSources: async (input: unknown) => {
      recordLaunchSourcesCalls.push(input);
    },
  };
}

describe("launchWebhookTrigger", () => {
  test("still returns the launched run when input delivery fails after every retry", async () => {
    launchFoldedRunCalls = [];
    sendFoldedMailWithRetryCalls = [];
    reportErrorCalls = [];
    const deliveryError = new Error("sidecar unreachable");
    sendFoldedMailWithRetryResult = {
      ok: false,
      error: deliveryError,
      attempts: 3,
    };

    const result = await launchWebhookTrigger(baseDeps(), TRIGGER, {
      status: "ok",
    });

    expect(result.instanceId).toBeTruthy();
    expect(result.triggerAddress).toContain(result.instanceId);
    expect(launchFoldedRunCalls).toHaveLength(1);
    expect(sendFoldedMailWithRetryCalls).toHaveLength(1);
  });

  test("reports the exhausted delivery failure with the run's context", async () => {
    launchFoldedRunCalls = [];
    sendFoldedMailWithRetryCalls = [];
    reportErrorCalls = [];
    const deliveryError = new Error("sidecar unreachable");
    sendFoldedMailWithRetryResult = {
      ok: false,
      error: deliveryError,
      attempts: 3,
    };

    const result = await launchWebhookTrigger(baseDeps(), TRIGGER, {
      status: "ok",
    });

    expect(reportErrorCalls).toHaveLength(1);
    const [cause, context] = reportErrorCalls[0] as [
      unknown,
      {
        operation: string;
        tenantId: string;
        agentId: string;
        extra: Record<string, unknown>;
      },
    ];
    expect(cause).toBe(deliveryError);
    expect(context.operation).toBe("webhookTriggers.launch.deliverInput");
    expect(context.tenantId).toBe(TRIGGER.tenantId);
    expect(context.agentId).toBe(result.triggerAddress);
    expect(context.extra).toEqual({
      instanceId: result.instanceId,
      triggerId: TRIGGER.id,
      attempts: 3,
    });
  });

  test("does not report anything when delivery succeeds", async () => {
    launchFoldedRunCalls = [];
    sendFoldedMailWithRetryCalls = [];
    reportErrorCalls = [];
    sendFoldedMailWithRetryResult = { ok: true, mail: { id: "m_1" } };

    await launchWebhookTrigger(baseDeps(), TRIGGER, { status: "ok" });

    expect(reportErrorCalls).toHaveLength(0);
  });

  test("returns the launched run normally when delivery succeeds", async () => {
    launchFoldedRunCalls = [];
    sendFoldedMailWithRetryCalls = [];
    sendFoldedMailWithRetryResult = { ok: true, mail: { id: "m_1" } };

    const result = await launchWebhookTrigger(baseDeps(), TRIGGER, {
      status: "ok",
    });

    expect(result.instanceId).toBeTruthy();
    expect(sendFoldedMailWithRetryCalls).toHaveLength(1);
    const [, params] = sendFoldedMailWithRetryCalls[0] as [
      unknown,
      { content: string; sessionId: string },
    ];
    expect(params.content).toBe("deployed: ok");
    expect(params.sessionId).toBe("ses_run1");
  });

  // CL-6367: a webhook-driven run with no stable-id -> current-run
  // mapping could never be relaunched after its sidecar died — the
  // terminal sweep and the wake path both resolve through that mapping.
  test("launches as a section and persists the relaunch mapping with the run", async () => {
    launchFoldedRunCalls = [];
    sendFoldedMailWithRetryCalls = [];
    persistLaunchCalls = [];
    recordLaunchSourcesCalls = [];
    sendFoldedMailWithRetryResult = { ok: true, mail: { id: "m_1" } };

    const result = await launchWebhookTrigger(baseDeps(), TRIGGER, {
      status: "ok",
    });

    const [, params] = launchFoldedRunCalls[0] as [
      unknown,
      { mode: unknown; persistExtra: unknown },
    ];
    expect(params.mode).toEqual({ kind: "section", turnTimeoutMs: 60_000 });
    expect(params.persistExtra).toBe(persistedLaunchExtra);
    expect(persistLaunchCalls).toEqual([
      {
        tenantId: "ten_1",
        instanceId: result.instanceId,
        foldedBody: FOLDED_BODY,
      },
    ]);
    // CL-6687: the mapping row is written before the deploy resolves the
    // inference chain, so the digest a rotation check compares against
    // has to land in a second write once the launch returns.
    expect(recordLaunchSourcesCalls).toEqual([
      { instanceId: result.instanceId, sourcesDigest: "digest_run1" },
    ]);
  });

  // Catalog secrets are encrypted at rest. Without the boot-tagged cipher
  // on this path, launchFoldedRun would hand ciphertext to the provider as
  // an API key. Tag construction is the fail-closed gate.
  test("threads the tagged credentialCipher into launchFoldedRun", async () => {
    launchFoldedRunCalls = [];
    sendFoldedMailWithRetryCalls = [];
    sendFoldedMailWithRetryResult = { ok: true, mail: { id: "m_1" } };

    await launchWebhookTrigger(baseDeps(), TRIGGER, { status: "ok" });

    expect(launchFoldedRunCalls).toHaveLength(1);
    const [foldedDeps] = launchFoldedRunCalls[0] as [
      { credentialCipher: unknown },
      unknown,
    ];
    expect(foldedDeps.credentialCipher).toBe(taggedCipher);
  });

  test("refuses to launch when credentialCipher is missing", async () => {
    launchFoldedRunCalls = [];
    await expect(
      launchWebhookTrigger(
        { ...baseDeps(), credentialCipher: undefined as never },
        TRIGGER,
        { status: "ok" },
      ),
    ).rejects.toThrow(/missing or has the wrong shape/);
    expect(launchFoldedRunCalls).toHaveLength(0);
  });

  test("refuses to launch when credentialCipher has the wrong shape", async () => {
    launchFoldedRunCalls = [];
    await expect(
      launchWebhookTrigger(
        { ...baseDeps(), credentialCipher: {} as never },
        TRIGGER,
        { status: "ok" },
      ),
    ).rejects.toThrow(/missing or has the wrong shape/);
    expect(launchFoldedRunCalls).toHaveLength(0);
  });
});
