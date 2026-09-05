// `POST /provision`, mounted outside the hub's tenant-prefixed routes
// because a brand-new user belongs to no tenant yet: authenticated,
// idempotent, and answering either the provisioning result or the hub's
// `{ error: { code, userMessage, refId } }` envelope. What it decides and why lives
// in ./provision.ts.

import type { AppEnv } from "@intx/hub-api";
import { createExpiringMap } from "@corbits/collections";
import { createNoopCredentialCipher } from "@intx/crypto";
import { CredentialResponse, paginatedSchema } from "@intx/types";
import type { CredentialCipher } from "@intx/types";
import {
  supportedCredentialProviders,
  type SupportedCredentialProvider,
} from "@corbits/connections/credential-test";
import {
  inferenceCredentialName,
  SETUP_AGENT_ASSET_NAME,
  type ModelSource,
  type WorkflowPusher,
} from "@corbits/seeding";
import {
  cookiesFromHeader,
  createHubAPI,
  parseAs,
  type ApiCall,
} from "@corbits/hub-api-client";
import { Hono } from "hono";
import { type } from "arktype";
import type { AccessPolicyStore } from "@workbench/access-policy";
import {
  generateRefId,
  makeErrorEnvelope,
  reportError,
} from "@corbits/error-sink";

import {
  personalTenantSlug,
  provisionPersonalTenantIfNeeded,
  ProvisionError,
  seededWorkflowStatus,
} from "./provision";

import {
  ensureSeeded,
  findPersonalTenant,
  testAndPersistCredential,
  type PersonalTenant,
  type TestAndPersistCredentialResult,
} from "./complete-credential";
import type { BenchProvisioner } from "./bench-provisioning";
import {
  createOAuthConnectRoutes,
  DEFAULT_RETURN_PATH_ALLOWLIST,
  type ConnectorDescriptor,
  type OAuthExchangeResult,
} from "@corbits/connections";
import { CONNECTOR_REGISTRY } from "@workbench/templates/connectors";
import type { PendingSeedStore } from "./pending-seed";
import { exchangeCodeForKey } from "./openrouter-connect";
import { exchangeCodeForToken as exchangeHuggingFaceCodeForToken } from "./huggingface-connect";
import type { ProviderHealthStore } from "@corbits/connections/provider-health";

function assertNonEmpty<T>(arr: T[]): asserts arr is [T, ...T[]] {
  if (arr.length === 0) {
    throw new Error("expected a non-empty array");
  }
}

/**
 * Logs a caught failure's raw detail — the exact text a `CliError` or a
 * generic `Error` carries, which can and does include absolute file
 * paths (a `CliError` wrapping a publish/freshness failure names the
 * package directory on disk) or other internals a user must
 * never see (CL-6360) — behind a `refId`, then returns the envelope the
 * client actually renders: a fixed consumer-language `userMessage` plus
 * that same `refId` so a person can quote it back for support. Never
 * forwards `cause.message` to the client, regardless of error type.
 */
function reportOnboardingError(
  logError: (line: string) => void,
  args: {
    /** The @corbits/error-sink operation name for this call site — one
     * per route action, snake_case, never the failure code itself
     * (CL-7234): a `ProvisionError`'s own `code` is an unbounded
     * per-failure taxonomy, and using it as `operation` would fragment
     * "provisioning is broken" across N sink operations instead of one. */
    operation: string;
    userAction: string;
    code: string;
    userMessage: string;
    cause: unknown;
    tenantId?: string;
    extra?: Record<string, unknown>;
  },
): ReturnType<typeof makeErrorEnvelope> {
  const refId = generateRefId();
  const detail =
    args.cause instanceof Error ? args.cause.message : String(args.cause);
  logError(`[${refId}] ${args.userAction} failed (${args.code}): ${detail}`);
  reportError(args.cause, {
    operation: args.operation,
    refId,
    ...(args.tenantId !== undefined ? { tenantId: args.tenantId } : {}),
    ...(args.extra !== undefined ? { extra: args.extra } : {}),
  });
  return makeErrorEnvelope({
    code: args.code,
    userMessage: args.userMessage,
    refId,
  });
}

const providerIds = supportedCredentialProviders().map((p) => p.id);
assertNonEmpty(providerIds);

const SubmitCredential = type({
  provider: type.enumerated(...providerIds),
  apiKey: "string > 0",
  // Ollama's card collects a URL instead of a key (see the onboarding
  // page's own `ProviderCardButton`/credential form); `apiKey` still
  // carries the fixed `OLLAMA_PLACEHOLDER_SECRET` for that provider, and
  // this optional field carries the actual instance URL. Absent for
  // every other provider.
  "baseURL?": "string > 0",
});

const ProvisionBody = type({
  "name?": "string > 0",
});

export type CreateOnboardingRoutesDeps = {
  hubUrl: string;
  operatorTenantId?: string;
  seedModel?: ModelSource;
  pushWorkflow: WorkflowPusher;
  log: (line: string) => void;
  /** Error-level sibling of `log`: every server-side failure path in
   * these routes reports here so the hub's global logger records it at
   * error severity, not as an info line that vanishes under filtering. */
  logError?: (line: string) => void;
  openrouterConnect?: {
    exchange?: typeof exchangeCodeForKey;
    /** The fast half only — persists the code-exchanged key as a
     * credential, no probe gating it (CL-6123). Never deploys a
     * workflow; see `complete-credential.ts`'s module comment for why
     * the callback route must never run more than this before
     * redirecting. */
    connectCredential?: typeof testAndPersistCredential;
  };
  /** The public OAuth app id from huggingface.co/settings/applications
   * (see docs/onboarding-huggingface-connect.md). Absent disables the
   * connect card's routes without disabling anything else — HF stays
   * available as a paste-a-token provider either way. */
  huggingfaceClientId?: string;
  huggingfaceConnect?: {
    exchange?: typeof exchangeHuggingFaceCodeForToken;
    connectCredential?: typeof testAndPersistCredential;
  };
  /**
   * The background drain these routes hand provisioning work to
   * (CL-6457). No route here ever deploys a workflow itself; the most a
   * route does is write the pending-seed row and nudge this. Absent
   * only means no nudge — the drain's own poll still picks the row up on
   * its next tick, which is why this is a latency optimization rather
   * than a correctness dependency.
   */
  benchProvisioner?: Pick<BenchProvisioner, "wake">;
  /** Test seam standing in for the deploy step, so a route test can
   * prove the response never waits on one. */
  ensureSeededFn?: typeof ensureSeeded;
  /** Test seam for `POST /complete`'s fast half — credential persist and
   * catalog seed, the only work that call still does inline. */
  testAndPersistCredentialFn?: typeof testAndPersistCredential;
  /**
   * The same provider-health signal `@corbits/connections`' own routes
   * write to (CL-6092): a successful `POST /complete` clears any stale
   * needs-attention record for the connected provider, so the shell
   * banner's onboarding-routed "Fix it" (the zero-working-providers case)
   * doesn't survive the very fix it sent someone to make. Absent means no
   * health store is wired in — the clear is a no-op, matching every other
   * optional dep here.
   */
  providerHealth?: ProviderHealthStore;
  /** Server-side custody for a just-connected credential's plaintext
   * key between the OAuth callback and this package's own
   * `/complete-setup` follow-up — see `./pending-seed.ts`'s module
   * comment for why this replaced an HttpOnly cookie (CL-6031). Built
   * from `createDrizzlePendingSeedStore(db, credentialCipher)` in
   * production; tests inject `createInMemoryPendingSeedStore`. */
  pendingSeedStore: PendingSeedStore;
  /** The closed-by-default access-policy gate threaded straight into
   * `provisionPersonalTenantIfNeeded` — see that function's own
   * `accessPolicy` doc comment. Absent means no access-policy package
   * is wired in at all; never a valid production shape. */
  accessPolicy?: {
    store: AccessPolicyStore;
    envSignupMode: "open" | "closed";
    envAllowedDomains: readonly string[];
    allowUnverifiedEmails: boolean;
  };
  /** Seals the OAuth connect state (PKCE verifier included) parked
   * between `/start` and `/callback`, so a hub restart in between
   * doesn't strand it — see `@corbits/connections`' `pkce.ts`. The same `CredentialCipher`
   * every other secret-at-rest seam in the hub shares
   * (`CREDENTIAL_ENCRYPTION_KEY`, `apps/hub`'s `credentialCipherFrom`).
   * Defaults to the identity no-op cipher: fine for dev/test, never for
   * a real deployment. */
  credentialCipher?: CredentialCipher;
};

/**
 * What every provisioning-aware route answers with (CL-6457): where this
 * bench's agents actually are, read from the bench's own asset and
 * deployment state rather than from anything a caller remembers. `ready`
 * means every default workflow is live; `provisioning` means the drain
 * still has work to do.
 *
 * `setupAgentReady` is the only field a waiting surface should ever
 * branch on (CL-6462): it says whether the one agent a person talks to
 * is live, which is the real "can they start?" question. `deployed` and
 * `pending` stay for operators and logs — a count of seed workflows is
 * an implementation detail no person should be made to watch.
 */
type ProvisioningStatusBody = {
  readonly kind: "ready" | "provisioning";
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly setupAgentReady: boolean;
  readonly deployed: string[];
  readonly pending: string[];
};

/**
 * The idempotent-duplicate-callback recovery: when a callback's own
 * single-use state comes back already consumed, that is not on its own
 * proof the connection failed — a browser that fires the same callback
 * twice (a double navigation, a retried request) burns the state on its
 * first, successful arrival and only ever sees `state_expired` on the
 * second. Before reporting that as a failure, check whether this exact
 * session's user already has an active credential for this provider,
 * created recently enough that it can only be the twin of this same
 * round trip — never a coincidence from some unrelated, older connect.
 * A genuinely expired or wrong-session state still finds nothing here
 * and errors honestly. This is best-effort recovery, never load-bearing
 * for correctness: any failure reading the hub (it being briefly
 * unreachable, a malformed response) is treated the same as "found
 * nothing" — the caller falls back to its ordinary `state_expired`
 * ending rather than surfacing a second, unrelated failure mode.
 */
async function recentlyConnectedCredential(
  api: ApiCall,
  cookies: string[],
  args: {
    userId: string;
    userEmail: string;
    provider: SupportedCredentialProvider;
    withinMs: number;
    log: (line: string) => void;
    now?: () => number;
  },
): Promise<PersonalTenant | undefined> {
  const now = args.now ?? Date.now;
  try {
    const expectedSlug = personalTenantSlug(args.userEmail, args.userId);
    const tenant = await findPersonalTenant(api, cookies, expectedSlug);
    if (!tenant) return undefined;

    const listed = await api(
      "GET",
      `/api/tenants/${tenant.tenantId}/credentials`,
      undefined,
      cookies,
    );
    const credentials = parseAs(
      paginatedSchema(CredentialResponse),
      listed.data,
      "credentials response",
    ).data;
    const name = inferenceCredentialName(args.provider);
    const cutoff = now() - args.withinMs;
    const match = credentials.find(
      (credential) =>
        credential.name === name &&
        credential.status === "active" &&
        Date.parse(credential.createdAt) >= cutoff,
    );
    return match ? tenant : undefined;
  } catch (cause) {
    // Never the raw cause detail — this path lists credentials after a
    // connect and can see secret-shaped hub/parse errors (CL-7255).
    const refId = reportError(cause, {
      operation: "onboarding_duplicate_callback_recovery",
      extra: { userId: args.userId },
    });
    args.log(
      `duplicate-callback recovery check failed for user ${args.userId} [${refId}]`,
    );
    return undefined;
  }
}

export function createOnboardingRoutes(
  deps: CreateOnboardingRoutesDeps,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const api = createHubAPI(deps.hubUrl);
  const credentialCipher =
    deps.credentialCipher ?? createNoopCredentialCipher();

  // A simple in-process per-user provision rate limiter. Provisioning is
  // idempotent and safe to retry, but a client stuck in a tight retry loop
  // (or a runaway script) can pile concurrent tenant creates onto the hub.
  // One in-flight or recent provision per user is enough; the window is
  // short because successful provisioning resolves immediately.
  //
  // This router is built once at hub boot and lives for the process —
  // every distinct user who has ever attempted a named create would
  // otherwise sit in this map forever (CL-7233). A TTL equal to the rate
  // limit window itself is exactly the right eviction policy here: an
  // entry has no reason to exist past the window it gates, so
  // `createExpiringMap`'s own `get()` already encodes the rate-limit
  // check — a defined result means "still inside the window".
  const PROVISION_RATE_LIMIT_MS = 10_000;
  const lastProvisionByUser = createExpiringMap<string, number>({
    ttlMs: PROVISION_RATE_LIMIT_MS,
  });

  /**
   * Reads where the bench's agents actually stand. Two hub reads, no
   * writes, no deploys — cheap enough that every provisioning-aware
   * route can answer from it directly.
   */
  async function provisioningStatus(
    cookies: string[],
    tenant: PersonalTenant,
  ): Promise<ProvisioningStatusBody> {
    const { deployed, pending } = await seededWorkflowStatus(
      api,
      cookies,
      tenant.tenantId,
    );
    return {
      kind: pending.length === 0 ? "ready" : "provisioning",
      tenantId: tenant.tenantId,
      tenantSlug: tenant.tenantSlug,
      setupAgentReady: deployed.includes(SETUP_AGENT_ASSET_NAME),
      deployed,
      pending,
    };
  }

  app.post("/provision", async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json(
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage: "Sign in to continue.",
        }),
        401,
      );
    }

    // Optional body: the naming wizard sends `{ name }`; the shell's
    // membership probe may POST with no body and only wants the read path.
    // Parse before rate-limiting so the read probe never burns a create slot.
    // Empty body → probe. Present body that is not valid JSON or fails the
    // schema → 400 (never silently treated as a probe).
    const bodyText = await c.req.text();
    let body: { name?: string } | undefined;
    if (bodyText.trim() === "") {
      body = undefined;
    } else {
      let rawBody: unknown;
      try {
        rawBody = JSON.parse(bodyText) as unknown;
      } catch {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: "That request wasn't valid. Try again.",
          }),
          400,
        );
      }
      const parsed = ProvisionBody(rawBody);
      if (parsed instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: "That request wasn't valid. Try again.",
          }),
          400,
        );
      }
      body = parsed;
    }
    const isCreateAttempt = body?.name !== undefined;

    // Rate-limit only named creates. The two-step first-login flow is
    // probe (no name) → naming submit (with name); gating both would 429
    // anyone who types a name within the window of their membership probe.
    if (isCreateAttempt) {
      const now = Date.now();
      const isRateLimited = lastProvisionByUser.get(user.id) !== undefined;
      if (isRateLimited) {
        return c.json(
          {
            error: {
              ...makeErrorEnvelope({
                code: "rate_limited",
                userMessage:
                  "Too many attempts. Wait a moment, then try again.",
              }).error,
              kind: "transient" as const,
            },
          },
          429,
        );
      }
      lastProvisionByUser.set(user.id, now);
    }

    const cookies = cookiesFromHeader(c.req.header("cookie"));
    try {
      const provisionArgs: Parameters<
        typeof provisionPersonalTenantIfNeeded
      >[0] = {
        api,
        cookies,
        hubUrl: deps.hubUrl,
        userId: user.id,
        userEmail: user.email,
        userEmailVerified: user.emailVerified,
        pushWorkflow: deps.pushWorkflow,
        log: deps.log,
      };
      if (deps.operatorTenantId !== undefined)
        provisionArgs.operatorTenantId = deps.operatorTenantId;
      if (deps.seedModel !== undefined)
        provisionArgs.seedModel = deps.seedModel;
      if (body?.name !== undefined) provisionArgs.displayName = body.name;
      if (deps.accessPolicy !== undefined)
        provisionArgs.accessPolicy = deps.accessPolicy;

      const result = await provisionPersonalTenantIfNeeded(provisionArgs);

      return c.json(result, 200);
    } catch (cause) {
      if (cause instanceof ProvisionError) {
        const status =
          cause.code === "signup_not_allowed"
            ? 403
            : cause.errorKind === "transient"
              ? 503
              : 500;
        const userMessage =
          cause.code === "signup_not_allowed"
            ? "Sign-ups aren't open for this account yet. Contact your workspace admin for access."
            : "Setting up your workbench hit a snag — we're on it. Try again in a moment.";
        const envelope = reportOnboardingError(deps.logError ?? deps.log, {
          operation: "onboarding_provision",
          userAction: `first-login provisioning for user ${user.id}`,
          code: cause.code,
          userMessage,
          cause,
          extra: { userId: user.id, code: cause.code },
        });
        return c.json(
          {
            error: { ...envelope.error, kind: cause.errorKind },
          },
          status,
        );
      }
      // An unrecognized error is treated as transient — the hub may have
      // been momentarily unavailable, and retrying is safe because
      // provisioning is idempotent.
      const envelope = reportOnboardingError(deps.logError ?? deps.log, {
        operation: "onboarding_provision",
        userAction: `first-login provisioning for user ${user.id}`,
        code: "provisioning_failed",
        userMessage:
          "Setting up your workbench hit a snag — we're on it. Try again in a moment.",
        cause,
        extra: { userId: user.id },
      });
      return c.json(
        { error: { ...envelope.error, kind: "transient" as const } },
        503,
      );
    }
  });

  // OAuth connect (OpenRouter, Hugging Face): CL-6028 generalized both
  // providers' start/callback mechanics into `@corbits/connections`'
  // `createOAuthConnectRoutes` — state sealing, PKCE, cookies, rate
  // limiting, and the duplicate-callback recovery shape all live there
  // now, driven by `CONNECTOR_REGISTRY`'s `openrouter`/`huggingface`
  // entries. What stays here, unchanged: persisting the exchanged
  // material (`testAndPersistCredential`, the fast half — no probe, no
  // workflow deploy), the duplicate-callback recovery lookup
  // (`recentlyConnectedCredential`, below), and writing the pending-seed
  // row the deferred `/complete-setup` deploy step reads (see
  // `./pending-seed.ts`). Every test seam this package's deps already
  // exposed (`openrouterConnect`/`huggingfaceConnect` overrides) still
  // works — they're threaded into the registry entries' `oauth.exchange`
  // below.

  /**
   * Adapts `packages/onboarding`'s pre-CL-6028 exchange function shape
   * (`{code, codeVerifier} -> {ok, key}|{ok, message}`, still what
   * `deps.openrouterConnect.exchange` overrides in tests) onto
   * `ConnectorOAuthConfig.exchange`'s generalized shape.
   */
  function adaptOpenRouterExchange(
    exchange: typeof exchangeCodeForKey = deps.openrouterConnect?.exchange ??
      exchangeCodeForKey,
  ) {
    return async (args: {
      code: string;
      codeVerifier?: string;
      redirectUri: string;
      clientId?: string;
    }): Promise<OAuthExchangeResult> => {
      const result = await exchange({
        code: args.code,
        codeVerifier: args.codeVerifier ?? "",
      });
      return result.ok ? { ok: true, apiKey: result.key } : result;
    };
  }

  function adaptHuggingFaceExchange(
    exchange: typeof exchangeHuggingFaceCodeForToken = deps.huggingfaceConnect
      ?.exchange ?? exchangeHuggingFaceCodeForToken,
  ) {
    return async (args: {
      code: string;
      codeVerifier?: string;
      redirectUri: string;
      clientId?: string;
    }): Promise<OAuthExchangeResult> => {
      if (args.clientId === undefined) {
        return {
          ok: false,
          message: "huggingface connect is not configured",
        };
      }
      const result = await exchange({
        code: args.code,
        codeVerifier: args.codeVerifier ?? "",
        redirectUri: args.redirectUri,
        clientId: args.clientId,
      });
      if (!result.ok) return result;
      return result.expiresAt !== undefined
        ? { ok: true, apiKey: result.accessToken, expiresAt: result.expiresAt }
        : { ok: true, apiKey: result.accessToken };
    };
  }

  const openrouterDescriptor = CONNECTOR_REGISTRY["openrouter"];
  const huggingfaceDescriptor = CONNECTOR_REGISTRY["huggingface"];
  if (openrouterDescriptor?.oauth === undefined) {
    throw new Error(
      "@corbits/connections' registry is missing the openrouter oauth-pkce entry",
    );
  }
  if (huggingfaceDescriptor?.oauth === undefined) {
    throw new Error(
      "@corbits/connections' registry is missing the huggingface oauth-pkce entry",
    );
  }
  // ONLY the two providers onboarding's own first-login flow offers.
  // Every other OAuth-capable connector (the GitHub App connect
  // included) belongs to the tenant-scoped `connections/oauth` mount in
  // `apps/hub` — a `/oauth/github/start` here answers the factory's own
  // 404, never a silent fall-through into onboarding's inference-only
  // persistence (CL-6394).
  const oauthRegistry: Readonly<Record<string, ConnectorDescriptor>> = {
    openrouter: {
      ...openrouterDescriptor,
      oauth: {
        ...openrouterDescriptor.oauth,
        exchange: adaptOpenRouterExchange(),
      },
    },
    huggingface: {
      ...huggingfaceDescriptor,
      oauth: {
        ...huggingfaceDescriptor.oauth,
        exchange: adaptHuggingFaceExchange(),
      },
    },
  };

  /** Everything onboarding's own OAuth mount may ever persist for —
   * enforced twice: `oauthRegistry` above keeps any other connector from
   * even starting a flow here (a loud 404), and this narrowing refuses
   * one that somehow reached persistence anyway, instead of an `as`
   * cast letting it fall into inference-only seeding (CL-6394). */
  function onboardingOAuthProvider(
    connectorId: string,
  ): "openrouter" | "huggingface" | undefined {
    if (connectorId === "openrouter" || connectorId === "huggingface") {
      return connectorId;
    }
    return undefined;
  }

  /** The fast half only — persists the exchanged material, no probe,
   * never deploys a workflow. Dispatches to whichever provider's own
   * test-seam override (`deps.openrouterConnect`/`deps.huggingfaceConnect`)
   * applies, defaulting both to `testAndPersistCredential`. */
  async function connectCredential(args: {
    connectorId: string;
    userId: string;
    userEmail: string;
    cookies: string[];
    apiKey: string;
    credentialMetadata?: Record<string, unknown>;
  }): Promise<TestAndPersistCredentialResult> {
    const provider = onboardingOAuthProvider(args.connectorId);
    if (provider === undefined) {
      return {
        kind: "invalid-credential",
        message: `onboarding does not connect ${args.connectorId} — use the workbench's own Connections surface`,
      };
    }
    const impl =
      provider === "openrouter"
        ? (deps.openrouterConnect?.connectCredential ??
          testAndPersistCredential)
        : (deps.huggingfaceConnect?.connectCredential ??
          testAndPersistCredential);
    const connectCredentialArgs = {
      api,
      cookies: args.cookies,
      hubUrl: deps.hubUrl,
      userId: args.userId,
      userEmail: args.userEmail,
      provider,
      apiKey: args.apiKey,
      pushWorkflow: deps.pushWorkflow,
      log: deps.log,
    };
    return impl(
      args.credentialMetadata !== undefined
        ? {
            ...connectCredentialArgs,
            credentialMetadata: args.credentialMetadata,
          }
        : connectCredentialArgs,
    );
  }

  async function recentlyConnected(args: {
    connectorId: string;
    userId: string;
    userEmail: string;
    cookies: string[];
    withinMs: number;
  }): Promise<PersonalTenant | undefined> {
    const provider = onboardingOAuthProvider(args.connectorId);
    if (provider === undefined) return undefined;
    return recentlyConnectedCredential(api, args.cookies, {
      userId: args.userId,
      userEmail: args.userEmail,
      provider,
      withinMs: args.withinMs,
      log: deps.log,
    });
  }

  /** Runs only for a connector whose `oauth.deploysDefaultWorkflows` is
   * true (both OpenRouter and Hugging Face) — writes the plaintext
   * material into the pending-seed store `/complete-setup` reads, so
   * the deferred workflow deploy never blocks this redirect. The
   * browser gets nothing from this call: no cookie, no ciphertext, only
   * the ordinary redirect — see `./pending-seed.ts`'s module comment. */
  async function afterConnected(args: {
    c: import("hono").Context;
    connectorId: string;
    userId: string;
    apiKey: string;
    tenantId: string;
    tenantSlug: string;
    principalId: string;
    tenantDomain: string;
  }): Promise<void> {
    const provider = onboardingOAuthProvider(args.connectorId);
    if (provider === undefined) {
      throw new Error(
        `onboarding's pending-seed store only holds its own providers, not ${args.connectorId}`,
      );
    }
    await deps.pendingSeedStore.put({
      userId: args.userId,
      tenantId: args.tenantId,
      principalId: args.principalId,
      tenantDomain: args.tenantDomain,
      provider,
      apiKey: args.apiKey,
    });
  }

  app.route(
    "/oauth",
    createOAuthConnectRoutes({
      hubUrl: deps.hubUrl,
      log: deps.log,
      credentialCipher,
      registry: oauthRegistry,
      oauthEnv: {
        huggingfaceClientId: deps.huggingfaceClientId,
      },
      connectCredential,
      recentlyConnected,
      afterConnected,
      defaultReturnPath: "/onboarding",
      // The plugins gallery (CL-6090) reuses this same onboarding OAuth
      // route for its one-flow connect panel — `/plugins` joins the
      // default allowlist rather than widening
      // `DEFAULT_RETURN_PATH_ALLOWLIST` itself, per that constant's own
      // doc comment.
      returnPathAllowlist: [...DEFAULT_RETURN_PATH_ALLOWLIST, "/plugins"],
    }),
  );

  app.post("/complete", async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json(
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage: "Sign in to continue.",
        }),
        401,
      );
    }

    const body: unknown = await c.req.json().catch(() => null);
    const parsed = SubmitCredential(body);
    if (parsed instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "invalid_request",
          userMessage: "Pick a provider and enter a key before connecting.",
        }),
        400,
      );
    }

    const cookies = cookiesFromHeader(c.req.header("cookie"));
    const runTestAndPersistCredential =
      deps.testAndPersistCredentialFn ?? testAndPersistCredential;
    const baseCompleteCredentialArgs = {
      api,
      cookies,
      hubUrl: deps.hubUrl,
      userId: user.id,
      userEmail: user.email,
      provider: parsed.provider,
      apiKey: parsed.apiKey,
      pushWorkflow: deps.pushWorkflow,
      log: deps.log,
    };
    // Known once `runTestAndPersistCredential` resolves; a failure
    // before that point (the credential itself, say) has no tenant yet.
    let tenantId: string | undefined;
    try {
      // The fast half, and only the fast half (CL-6457): persist the
      // credential, seed its catalog, answer. Deploying this bench's
      // default workflows is the background drain's job — a request that
      // waits on it is the 2+ minute "Connecting…" this route exists to
      // never reproduce.
      const result = await runTestAndPersistCredential(
        parsed.baseURL !== undefined
          ? { ...baseCompleteCredentialArgs, baseURLOverride: parsed.baseURL }
          : baseCompleteCredentialArgs,
      );

      if (result.kind === "invalid-credential") {
        // `result.message` is the provider's own validation verdict
        // (e.g. "the key was rejected") — already written in consumer
        // language by `testAndPersistCredential`, never raw stack text.
        return c.json(
          makeErrorEnvelope({
            code: "invalid_credential",
            userMessage: result.message,
          }),
          422,
        );
      }
      if (result.kind === "no-personal-bench") {
        return c.json(
          makeErrorEnvelope({
            code: "no_personal_bench",
            userMessage:
              "No personal bench was found for this account yet. Reload and try again.",
          }),
          409,
        );
      }
      // The credential is durably stored — clear any stale
      // needs-attention record for this provider (CL-6092), the same
      // clear-on-success rule `@corbits/connections`' own routes
      // follow. The credential is proven-durable here whether or not the
      // agents have finished deploying.
      deps.providerHealth?.clear(result.tenantId, parsed.provider);
      tenantId = result.tenantId;

      const status = await provisioningStatus(cookies, result);
      if (status.kind === "ready") {
        await deps.pendingSeedStore.clear({
          userId: user.id,
          tenantId: result.tenantId,
        });
        return c.json(status, 200);
      }

      // The row is the drain's work item — durable, so a hub that dies
      // mid-deploy resumes this bench on its next boot rather than
      // stranding it half-provisioned.
      await deps.pendingSeedStore.put({
        userId: user.id,
        tenantId: result.tenantId,
        principalId: result.principalId,
        tenantDomain: result.tenantDomain,
        provider: parsed.provider,
        apiKey: parsed.apiKey,
        ...(parsed.baseURL !== undefined
          ? { baseURLOverride: parsed.baseURL }
          : {}),
      });
      deps.benchProvisioner?.wake();
      return c.json(status, 200);
    } catch (cause) {
      // Neither `ProvisionError` nor `CliError` messages are safe to show
      // verbatim: `CliError` in particular can wrap a publish/freshness
      // failure whose text names absolute file paths on the hub's own
      // disk (CL-6360). The raw detail is logged behind a refId; the
      // client only ever sees a fixed consumer sentence plus that refId.
      const envelope = reportOnboardingError(deps.logError ?? deps.log, {
        operation: "onboarding_complete",
        userAction: `credential setup for user ${user.id}`,
        code: "credential_setup_failed",
        userMessage:
          "Your key was added, but finishing your workbench setup hit a snag — we're on it. Try again in a moment.",
        cause,
        ...(tenantId !== undefined ? { tenantId } : {}),
        extra: { userId: user.id },
      });
      return c.json({ error: envelope.error }, 500);
    }
  });

  // Runs after the onboarding page lands — from a fresh connect
  // (`outcome=connected`) or a plain reload — and drives the slow half
  // the OAuth callback never runs: deploying the default workflows
  // against whichever credential is already on the caller's own
  // personal bench. Already-seeded is answered from a single read, no
  // pending token required, so a returning fully-set-up account (or a
  // second overlapping call once the first finishes) gets the same
  // `seeded` answer without redoing any work. `kind: "unseeded"` (200,
  // not an error) means there is nothing this call can do yet — no
  // pending credential to seed with — and the caller should fall back
  // to the ordinary credential step rather than treat it as a failure.
  app.post("/complete-setup", async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json(
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage: "Sign in to continue.",
        }),
        401,
      );
    }

    const cookies = cookiesFromHeader(c.req.header("cookie"));
    // Known once the tenant lookup below resolves; a lookup failure
    // itself has no tenant yet.
    let tenantId: string | undefined;
    try {
      const expectedSlug = personalTenantSlug(user.email, user.id);
      const tenant = await findPersonalTenant(api, cookies, expectedSlug);
      if (!tenant) {
        return c.json(
          makeErrorEnvelope({
            code: "no_personal_bench",
            userMessage:
              "No personal bench was found for this account yet. Reload and try again.",
          }),
          409,
        );
      }
      tenantId = tenant.tenantId;

      const status = await provisioningStatus(cookies, tenant);
      if (status.kind === "ready") {
        await deps.pendingSeedStore.clear({
          userId: user.id,
          tenantId: tenant.tenantId,
        });
        return c.json(status, 200);
      }

      // Not yet provisioned, and no credential parked to provision with
      // — nothing this call can do, and not a failure: the caller falls
      // back to the ordinary credential step.
      const pending = await deps.pendingSeedStore.read({
        userId: user.id,
        tenantId: tenant.tenantId,
      });
      if (pending === undefined) return c.json({ kind: "unseeded" }, 200);

      deps.benchProvisioner?.wake();
      return c.json(status, 200);
    } catch (cause) {
      // report-error-ignore: CL-7234 — reportOnboardingError itself needs
      // to call reportError; tracked there rather than at each call site
      const envelope = reportOnboardingError(deps.logError ?? deps.log, {
        operation: "onboarding_complete_setup",
        userAction: `complete-setup for user ${user.id}`,
        code: "complete_setup_failed",
        userMessage:
          "Finishing your workbench setup hit a snag — we're on it. Try again in a moment.",
        cause,
        ...(tenantId !== undefined ? { tenantId } : {}),
        extra: { userId: user.id },
      });
      return c.json({ error: envelope.error }, 500);
    }
  });

  // What any surface still waiting on a bench polls for live progress
  // (CL-6457) — how many agents are live, how many are still coming.
  // Read-only and cheap: it deploys nothing and starts nothing, so a
  // client may poll it on a short interval without cost.
  app.get("/provisioning-status", async (c) => {
    const user = c.get("user");
    if (!user) {
      return c.json(
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage: "Sign in to continue.",
        }),
        401,
      );
    }

    const cookies = cookiesFromHeader(c.req.header("cookie"));
    // Known once the tenant lookup below resolves; a lookup failure
    // itself has no tenant yet.
    let tenantId: string | undefined;
    try {
      const expectedSlug = personalTenantSlug(user.email, user.id);
      const tenant = await findPersonalTenant(api, cookies, expectedSlug);
      if (!tenant) {
        return c.json(
          makeErrorEnvelope({
            code: "no_personal_bench",
            userMessage:
              "No personal bench was found for this account yet. Reload and try again.",
          }),
          409,
        );
      }
      tenantId = tenant.tenantId;

      return c.json(await provisioningStatus(cookies, tenant), 200);
    } catch (cause) {
      // report-error-ignore: CL-7234 — reportOnboardingError itself needs
      // to call reportError; tracked there rather than at each call site
      const envelope = reportOnboardingError(deps.logError ?? deps.log, {
        operation: "onboarding_provisioning_status",
        userAction: `provisioning status for user ${user.id}`,
        code: "provisioning_status_failed",
        userMessage:
          "Checking on your agents hit a snag — we're on it. Try again in a moment.",
        cause,
        ...(tenantId !== undefined ? { tenantId } : {}),
        extra: { userId: user.id },
      });
      return c.json({ error: envelope.error }, 500);
    }
  });

  return app;
}
