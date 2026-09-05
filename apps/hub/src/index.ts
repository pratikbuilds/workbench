// Composition root for the hub, wired in the platform's own idiom:
// config, then database, then auth, then the platform app. The only
// additions to the platform's shape are serving the web interface from
// this origin and mounting each extension's routes — one explicit
// import and one app.route line inside the platform's native tenant
// middleware.

import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  createApprovalStore,
  createDB,
  createGrantStore,
  createSidecarAllocationStore,
  createSignalCorrelationStore,
  createWorkflowRunDispatchStore,
  listVisibleOfferings,
  resolveCredentialByName,
  resolveCredentialRequirement,
} from "@intx/db";
import {
  asset as assetTable,
  model,
  modelPricing,
  tenant as tenantTable,
  workflowDefinition,
} from "@intx/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
  createEnvKeyCredentialCipher,
  createNoopCredentialCipher,
} from "@intx/crypto";
import { timeWindowEvaluator } from "@intx/authz";
import type { ConditionRegistry } from "@intx/types/authz";
import { credentialAad } from "@intx/types";
import type { CredentialCipher } from "@intx/types";
import {
  createApp,
  createMailTriggeredRunGrantsMaterializer,
  createRequireGrant,
  readDurableWorkflowRunLifecycles,
  resolveDefinitionSources,
  type AppEnv,
  type TenantEnv,
} from "@intx/hub-api";
import {
  deriveRunAddress,
  deriveRunAgentId,
  WorkflowDefinitionInvalidError,
} from "@intx/workflow-deploy";
import type { HarnessConfig } from "@intx/types/runtime";
// CL-7362: computes the preview's wire hash from the probed-but-unapproved
// projection `installAndApproveWorkflowSource` returns on `grants_not_approved`
// — the gate itself only stamps this hash on the `ok:true` arm.

import {
  createAgentDefinitionDraftRoutes,
  createAgentDefinitionRoutes,
  createDefinitionAssetHistory,
  createDrizzleDefinitionSkillsStore,
  createWorkflowAgentCreateRoutes,
  createWorkflowCapabilityRoutes,
  createWorkflowSkillPinRoutes,
  type CapabilityInventoryProvider,
  createMyraAgentDefinitionDrafting,
  isPlannerCreatedDefinitionName,
  resolveMyraDefinitionIdFromDb,
  type InventoryAgent,
  type InventoryModel,
  type InventorySources,
  type InventoryToolPackage,
} from "@corbits/agent-directory";

import {
  AGENT_SECTION_MODE,
  DEFAULT_TURN_CLAIM_TTL_MS,
  createArtifactDeliveryHandler,
  createDrizzleAgentTurnStore,
  createInMemoryTurnClaimStore,
  createWorkbenchHostInferencePreferencesResolver,
  createWorkbenchSubscriberRegistry,
  createWorkbenchTenancyRoutes,
  createWorkbenchTurnQueue,
  createTurnCancelRegistry,
  createChatOrchestrator,
  createChatRoutes,
  joinRunParticipant,
  createDrizzleBlockResponseStore,
  createDrizzleWorkbenchTenancyStore,
  createDrizzleChatStore,
  createDrizzleClientIdStore,
  createDrizzlePinStore,
  createDrizzleReactionStore,
  createDrizzleRoomMessageStore,
  createDrizzleThreadStore,
  createDrizzleTurnMailCorrelationStore,
  createDrizzleWriteClaimStore,
  createHubChatPlatform,
  createNoopInferenceRoutes,
  createRelaunchNoticePoster,
  createWorkflowParticipantRoutes,
  isWorkbenchHostDefinitionName,
  listConnectedProviders,
  listDefaultInferencePreferences,
  localPartOf,
  parseParticipants,
  postRoomMessage,
  recordSourcesDigest,
  startWorkflowCommand,
  settleConnectedService,
  workbenchLaunchPersistExtra,
} from "@corbits/chat";
import {
  createDrizzleMailboxWriter,
  type MailboxFanoutDeps,
} from "@corbits/chat/mailbox-fanout";
import type { RelaunchNoticePort } from "@corbits/chat";
import { reportError } from "@corbits/error-sink";
import type { FinalizedTurnToolCall } from "@corbits/turn-artifacts";
import { decodedOrNull } from "@corbits/url-path";
import {
  createCryptoProviderCache,
  lookupFoldedRunReconnectKey,
  tagCredentialCipher,
} from "@corbits/folded-runs";
import { createTopLevelRunRoutes } from "@corbits/run-scope";
import {
  createInboxRoutes,
  createWorkbenchMailboxDelivery,
  WORKBENCH_MAILBOX_VOCABULARY,
} from "@corbits/inbox";
import {
  applyInsightsMigrations,
  createDrizzleRunTraceReader,
  createDrizzleTurnTextSnapshotReader,
  createInsightsRoutes,
  createPostgresTurnLatencyStore,
  createPostgresUsageStore,
  createTurnLatencyTracker,
  createUsageSink,
  withTurnPartPersistGuard,
} from "@corbits/insights";
import {
  applyPreferencesMigrations,
  createPostgresPreferencesStore,
  createPreferencesRoutes,
} from "@corbits/preferences";
import {
  applyBenchMigrations,
  createBenchRoutes,
  createPostgresBenchSettingsStore,
} from "@corbits/bench";
import {
  applyEvalsMigrations,
  createEvalRunRoutes,
  createPostgresEvalRunStore,
} from "@corbits/evals";
import {
  applyInferenceCatalogMigrations,
  createBenchModelPolicyRoutes,
  createPostgresBenchModelPolicyStore,
  createWorkflowCatalogRoutes,
} from "@corbits/inference-catalog";
import {
  createDrizzleSidecarPlacementStore,
  createSidecarPlacementRoutes,
} from "@corbits/sidecar-placement";
import { generateId } from "@intx/hub-common";

import { ensureDefaultTenant } from "./default-tenant";
import { runSystemSeed } from "./system-seed";
import {
  createInMemoryMailboxEventBus,
  createMailboxDb,
  mountMailbox,
} from "@corbits/mailbox";
import {
  createCommandRegistry,
  createCommandRoutes,
  createWorkflowCommandPlugin,
} from "@corbits/commands";
import {
  createDrizzleRepoReviewLeaseStore,
  createDrizzleWebhookTriggerStore,
  createWebhookIngressRoutes,
  createWebhookTriggerRoutes,
  generateWebhookSecret,
  launchWebhookTrigger,
} from "@corbits/webhook-triggers";
import {
  deliveryWorkbenchRequiredForWorkflowName,
  isConversationalWorkflowName,
  workflowDisplayName,
  workbenchTemplateLibraryEntries,
} from "@workbench/templates";
import { createConnectGithubRoutes } from "@corbits/connections/connect-github-routes";
import { webhookTriggerName } from "@corbits/connections/connect-github-setup";
import { createTemplateBlockRoutes } from "./templates/template-block-routes";
import {
  createWorkflowDetailRoute,
  createScheduledWorkflowRoutes,
  renderWorkflowSourceTree,
  WORKFLOW_SOURCE_ENTRY,
} from "@corbits/workflows";
import {
  createSidecarProvisioner as createE2BSidecarProvisioner,
  readProvisionerConfig as readE2BProvisionerConfig,
} from "@corbits/e2b-sandbox-sidecar";
import {
  createDrizzleRunKeyHistoryStore,
  createRunKeyHistoryListener,
  createRunKeyHistoryRoutes,
  lookupRunKeyHistoryReconnectKey,
} from "@corbits/run-key-history";
import {
  createDrizzleWorkflowDeploySourceStore,
  withDeploySourceRecording,
} from "@corbits/workflows";
import { runOneShotFoldedPrompt } from "@corbits/folded-run-one-shot";

import {
  createEventCollectorRegistry,
  createHubSessionLookups,
  createHubSessionOrchestrator,
  createSessionService,
  createSidecarAllocationReconciler,
  createSidecarPluginRegistry,
  createSidecarCredentialResolver,
  createSidecarRouter,
  createWorkflowAllocationService,
  createWorkflowDispatchService,
  DEFAULT_ASSET_REF,
  type AgentRepoStore,
  type EventCollectorRegistry,
  type WsHandle,
} from "@intx/hub-sessions";
import { createLaunchCaches } from "./launch-caches";
import { hubErrorHandler } from "./hub-error-handler";
import { wireMailRedelivery } from "./mail-redelivery";
import { getLogger, setup } from "@intx/log";
import { hexEncode } from "@intx/types";
import {
  createToolAllowanceRegistry,
  withGrantAllowance,
} from "@corbits/approvals";
import {
  createMcpCallClassifier,
  MCP_CALL_TOOL,
  mcpTools,
} from "@corbits/mcp-tools";
import {
  createAllowanceAutoApprover,
  createMcpServerToolsAllowanceLoader,
  createRegisteredApprovalFinder,
  createTenantGrantLister,
} from "./grant-allowance";
import { createDockerSidecarProvisioner } from "@corbits/docker-provisioner";
import {
  createProcessSidecarProvisioner,
  readProcessProvisionerConfig,
} from "@corbits/process-provisioner";
import { getArtifact, writeArtifactVersion } from "@corbits/artifacts";
import {
  createArtifactDbStore,
  createArtifactRoutes,
  createTemplateLibraryDbStore,
  createTemplateLibraryRoutes,
  createTemplateLibrarySeeder,
  createUnavailableArtifactRoutes,
  createUnavailableTemplateLibraryRoutes,
  createUnavailableWorkflowArtifactRoutes,
  createWorkflowArtifactDbStore,
  createWorkflowArtifactRoutes,
  createWorkflowRunAuthenticator,
} from "@corbits/artifacts-hub";
import {
  createArtifactDocPersistence,
  createPresenceRoomRegistry,
  createPresenceRoutes,
  type PresenceRoomKey,
} from "@corbits/presence";
import { supportedCredentialProviders } from "@corbits/connections/credential-test";
import {
  CATALOG_WORKFLOWS,
  catalogWorkflowDeployableOnThisPin,
  createGitWorkflowPusher,
} from "@corbits/seeding";
import { createHubAPI } from "@corbits/hub-api-client";
import {
  createDrizzlePendingSeedStore,
  createBenchProvisioner,
  createOnboardingRoutes,
} from "@workbench/onboarding";
import {
  createConnectionRoutes,
  isInferenceProvider,
  createMcpOAuthRoutes,
  createMcpServerRoutes,
  createOAuthConnectRoutes,
  createTenantConnectCredential,
  createWorkflowConnectionRoutes,
  DEFAULT_RETURN_PATH_ALLOWLIST,
  listMcpServerConnections,
} from "@corbits/connections";
import type { ServiceConnectedHook } from "@corbits/connections";
import {
  CONNECTOR_REGISTRY,
  MCP_PRESETS,
} from "@workbench/templates/connectors";
import {
  createProviderHealthPort,
  createProviderHealthStore,
} from "@corbits/connections/provider-health";
import {
  applyAccessPolicyMigrations,
  createAccessPolicyRoutes,
  createDrizzleAccessPolicyStore,
} from "@workbench/access-policy";
import { guardedHubApp, resolveCallerRoleNames } from "./tenant-create-guard";
import {
  createInMemoryNotifyDispatchStore,
  createSinkRegistry,
} from "@corbits/notify";
import { mountMemory } from "./memory-mount";
import { mountSkills } from "./skills-mount";
import {
  createUnavailableWorkflowMemoryRoutes,
  createWorkflowMemoryRoutes,
  createWorkflowMemoryStore,
} from "@corbits/memory-hub";
import { createSkillRoutes, createWorkflowSkillRoutes } from "@corbits/skills";
import {
  createWorkflowAuthorRegistry,
  createWorkflowAuthorRoutes,
  WorkflowAuthorError,
  type WorkflowDeployer,
} from "@corbits/workflows";
import { mountArtifacts } from "./artifacts-mount";
import { mountWorkbenchSlackTag } from "./slack-tag-mount";
import {
  createCredentialExpirySweep,
  createDrizzleCredentialExpirySweepStore,
} from "./credential-expiry-sweep";
import {
  createDrizzleInboxUnsnoozeSweepStore,
  createInboxUnsnoozeSweep,
} from "./inbox-unsnooze-sweep";

import { type } from "arktype";
import { betterAuth } from "better-auth";
import { createBenchSessionMinter } from "./bench-session";
import {
  hasRepoGrantViaHttp,
  mintRepoGrantViaHttp,
} from "./native-repo-grants";
import { createSignInAttemptLimiter } from "./sign-in-rate-limit";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { type Context, Hono, type Next } from "hono";

import { upgradeWebSocket, websocket } from "hono/bun";
import {
  CORBITS_TOOLS_REGISTRY,
  describeCorbitsToolPackages,
  publishCorbitsToolsRegistry,
} from "@corbits/tool-registry-publish";
import {
  readHubConfig,
  type HubConfig,
  type SidecarProvisionerConfig,
} from "./config";
import type { SidecarProvisioner } from "@intx/hub-sessions";
import { scheduleEnvProviderCredentialPlant } from "./env-credential-plant";
import { withTurnPartWriteDefaults } from "./turn-part-content-default";
import { createBootAssetWiring, REGISTRIES } from "./asset-service-factory";
import {
  claimScheduleMinuteFromDb,
  createWorkflowScheduler,
  launchScheduledDefinitionFromDb,
  listScheduledDefinitionsFromDb,
  runNowScheduledDefinition,
  type ScheduledDeliveryJoinDeps,
} from "./workflow-scheduler";
import { createToolGrantsForPins } from "./tool-grants";
import { createMcpCredentialBindingsFor } from "./mcp-credential-bindings";
import { reconcilePinnedToolPackagesAfterConnect } from "./connection-live-reconcile";
import { createPinnedPackageCredentialBindingsFor } from "./pinned-package-credential-bindings";
import { drainHubServer, shutdownHub } from "./shutdown";
import {
  createInFlightRequestTracker,
  withInFlightRequestTracking,
} from "./in-flight-requests";

// Host policy constants, not configuration.
const MAX_TARBALL_BYTES = 10 * 1024 * 1024;
// In-repo tool packages (`packages/granola-tools`, `packages/linear-tools`,
// `packages/skills-tools`) are unpublished to npm and stay that way:
// they are workbench-specific integration bundles, not general-purpose
// npm packages, so publishing them to a public registry would be the
// wrong distribution surface for what they are. `@intx/hub-sessions`
// already resolves any `package-registry`-kind asset visible to a
// tenant as a named tool-package registry (see `session-service.ts`'s
// `buildAndResolve`), ahead of the statically-configured HTTP
// registries on a name collision — the platform-native alternative to
// npm publishing the CL-5999 capability audit called for. Routing the
// `@corbits` scope at this registry name means a `@corbits/*` pin
// resolves only once an operator publishes a `package-registry` asset
// named `CORBITS_TOOLS_REGISTRY` with the package's tarball —
// `workbench setup` does exactly that onto the root tenant via
// `@corbits/tool-registry-publish`; descendants inherit it, and
// `seedTenant` does not pack. Until then, resolution fails loud
// rather than silently falling through to npmjs (which could never
// carry an unpublished scope anyway).
const TENANT_PREFIX = "/api/tenants/:tenantId";
const SIGN_UP_EMAIL_PATH = "/sign-up/email";
const SIGN_IN_EMAIL_PATH = "/sign-in/email";
const SignInEmailBody = type({ email: "string" });
// Chat residents carry a real hub-driven idle-reap again (reversing
// CL-5477's removal): the sidecar's own park/wake scheme it was meant to
// replace has itself been retired in favor of a simpler reap-and-relaunch
// model. `createHubChatPlatform`'s `lifecycle` binding below tags every
// idle eviction with `@corbits/agent-lifecycle`'s
// `IDLE_HIBERNATE_UNDEPLOY_REASON`, which the sidecar's `agent.undeploy`
// handler matches to choose the state-preserving teardown flavor
// (`reclaimDirs: false` — deployment record, step-state, and slug all
// survive) rather than the destructive default a caller-initiated
// undeploy gets. That is what makes this safe to re-enable where the old
// bare `"idle"`-tagged undeploy this ticket's `CHAT_IDLE_SLEEP_MS`
// emergency bump (8ca85543) band-aided around was genuinely lossy: a
// later `wakeByAddress` relaunch resumes the same run rather than
// starting a fresh one.

// Signup mode is operator-controlled (WORKBENCH_SIGNUP). Default closed:
// self-serve email signup is rejected; owners add users or share a
// copy-link invite (docs/TENANCY.md). Open mode keeps email+password
// signup and the existing rate limit. Email delivery of invites is out
// of scope.
// Email+password sign-in is always wired up. Google/GitHub OAuth are
// wired up too, but only the providers `readHubConfig` found a full
// credential pair for — better-auth's own `socialProviders` map is
// literally the set config.socialProviders resolved to, so a provider
// with no credential here never appears on the hub's auth handler no
// matter what the client asks for. OTP verification returns once a
// transactional-email credential and real UI exist for it; wiring it
// in ahead of that would be dead surface that also risks logging a
// verification secret with nowhere honest to send it.
function dbConfigFromUrl(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
  };
}

// Serves the single-page application from the hub origin: a real file
// when one exists, index.html otherwise so client-side routes deep-link,
// and never anything under /api, which stays with the platform routes.
export function createStaticHandler(staticDir: string) {
  return async (c: Context<AppEnv>, next: Next) => {
    if (c.req.path === "/api" || c.req.path.startsWith("/api/")) return next();
    const decodedPath = decodedOrNull(c.req.path);
    if (decodedPath === null) return next();
    const rel = path.normalize(decodedPath).replace(/^[/\\]+/, "");
    if (rel === ".." || rel.startsWith(`..${path.sep}`)) return next();
    const asset = Bun.file(path.join(staticDir, rel));
    if (await asset.exists()) return new Response(asset);
    const index = Bun.file(path.join(staticDir, "index.html"));
    if (await index.exists()) return new Response(index);
    return next();
  };
}

/**
 * The `CredentialCipher` (see `@intx/types`) every secret-at-rest seam
 * in this composition root shares — `webhookTriggerStore`'s signing
 * secrets, `@workbench/onboarding`'s in-flight OAuth connect state
 * (the PKCE verifier parked between `/start` and `/callback`, sealed
 * into the state itself so it survives a restart between the two), and
 * (since CL-6031) the same package's `pending_seed` table — a
 * just-connected credential's plaintext key, parked server-side
 * between the OAuth callback and the onboarding page's own
 * `/complete-setup` follow-up (see `packages/onboarding/src/pending-seed.ts`).
 * A real key (`CREDENTIAL_ENCRYPTION_KEY`) builds an AES-256-GCM
 * cipher. An unset key hard-fails boot — a self-hosting operator who
 * forgets this variable must not silently end up storing those secrets
 * in the clear — unless `ALLOW_PLAINTEXT_SECRETS` opts into the
 * identity no-op cipher with a boot warning, for dev/test only.
 */
export function credentialCipherFrom(
  config: HubConfig,
  log: ReturnType<typeof getLogger>,
): CredentialCipher {
  if (config.credentialEncryptionKeyHex === undefined) {
    if (!config.allowPlaintextSecrets) {
      throw new Error(
        [
          "CREDENTIAL_ENCRYPTION_KEY is not set.",
          "It encrypts secrets at rest — webhook-trigger signing secrets,",
          "onboarding's OAuth PKCE connect state, and its pending-seed",
          "table — so the hub refuses to boot without it. Generate one and",
          "add it to .env:",
          "",
          "  openssl rand -hex 32",
          "",
          "For local dev/test only, set ALLOW_PLAINTEXT_SECRETS=1 instead to",
          "boot with those secrets stored unencrypted; never do this for a",
          "real deployment.",
        ].join("\n"),
      );
    }
    log.warn`No CREDENTIAL_ENCRYPTION_KEY configured; secrets (e.g. webhook-trigger signing secrets, onboarding OAuth connect state, onboarding's pending-seed table) will NOT be encrypted at rest. ALLOW_PLAINTEXT_SECRETS is set — expected in dev/test only, never for a real deployment.`;
    return createNoopCredentialCipher();
  }
  return createEnvKeyCredentialCipher(
    Buffer.from(config.credentialEncryptionKeyHex, "hex"),
  );
}

/**
 * Hub-boot mint of the process-wide credential cipher: build from
 * config, then runtime-tag the result. Missing or wrong-shape input
 * fails closed — the hub does not boot.
 */
export function hubCredentialCipher(
  config: HubConfig,
  log: ReturnType<typeof getLogger>,
): CredentialCipher {
  return tagCredentialCipher(credentialCipherFrom(config, log));
}

/**
 * Instantiates one configured sidecar-provisioner backend. This is the
 * extension point named in `.env.example` and `apps/hub/src/config.ts`:
 * a new backend gets a case here once its config member exists on
 * `SidecarProvisionerConfig`.
 */
function buildSidecarProvisioner(
  config: SidecarProvisionerConfig,
  hubDataDir: string,
  hubWebSocketUrl: string,
): SidecarProvisioner {
  switch (config.id) {
    case "process":
      // Same derivation as the other two backends: the hub-side
      // allocation state lives under the hub's own data dir, and so do
      // the per-allocation directories each spawned sidecar uses as its
      // own SIDECAR_DATA_DIR.
      return createProcessSidecarProvisioner({
        config: readProcessProvisionerConfig({
          env: {
            ...(config.sidecarEntryPath === undefined
              ? {}
              : {
                  PROCESS_PROVISIONER_SIDECAR_ENTRY: config.sidecarEntryPath,
                }),
            ...(config.runtimePath === undefined
              ? {}
              : { PROCESS_PROVISIONER_RUNTIME: config.runtimePath }),
          },
          dataDir: path.resolve(hubDataDir, "process-provisioner"),
          hubWebSocketUrl,
        }),
      });
    case "docker":
      return createDockerSidecarProvisioner({
        config: {
          image: config.image,
          stateFilePath: path.resolve(
            hubDataDir,
            "docker-provisioner",
            "state.json",
          ),
        },
      });
    case "e2b":
      // Same derivation as docker's: the backend's hub-side allocation
      // state (generation fences, destroy tombstones, sandbox refs) lives
      // under the hub's own data dir. Distinct from the sandbox's own
      // SIDECAR_DATA_DIR, which start-sidecar.ts creates inside the VM.
      return createE2BSidecarProvisioner({
        config: readE2BProvisionerConfig(
          {
            E2B_API_KEY: config.apiKey,
            E2B_TEMPLATE: config.template,
            ...(config.sandboxTimeoutMs === undefined
              ? {}
              : { E2B_SANDBOX_TIMEOUT_MS: config.sandboxTimeoutMs }),
          },
          path.resolve(hubDataDir, "e2b-provisioner"),
        ),
      });
  }
}

export async function createHub(config: HubConfig) {
  const { db, close } = createDB(dbConfigFromUrl(config.databaseUrl));
  const { db: mailboxDb, close: closeMailbox } = createMailboxDb(
    config.databaseUrl,
  );
  const mailboxBus = createInMemoryMailboxEventBus();
  // Delivery adapter for `@corbits/notify` — kept at the composition root so
  // routine / approval / mention writers can inject it without the hub
  // re-implementing mailbox writes. The credential-expiry sweep below is
  // its first live caller; approval/run-failure/mention still have no
  // writer wired to this adapter.
  const mailboxDelivery = createWorkbenchMailboxDelivery({
    db: mailboxDb,
    bus: mailboxBus,
  });
  const log = getLogger(["hub", "auth"]);
  // Built once, tagged, and shared by every secret-at-rest seam in this
  // composition root — see `hubCredentialCipher`.
  const credentialCipher = hubCredentialCipher(config, log);

  const auth = betterAuth({
    baseURL: config.baseUrl,
    secret: config.sessionSecret,
    database: drizzleAdapter(db, { provider: "pg" }),
    emailAndPassword: { enabled: true },
    socialProviders: config.socialProviders,
    // Client-IP resolution for the sign-up rate limit below. Railway's docs
    // (docs.railway.com/networking/public-networking/specs-and-limits) list
    // `X-Real-IP` as the header its edge sets for the client's address —
    // that's the only claim about it this codebase can actually stand
    // behind. It is deliberately NOT relied on for sign-in: Railway's
    // private networking lets any same-project service (sidecars included)
    // reach this hub directly, bypassing the edge, and with no
    // `trustedProxies` configured (Railway publishes no stable edge CIDR
    // list to populate one with) a single-value header is trusted verbatim
    // regardless of who set it. That's an acceptable, low-stakes gap for
    // sign-up's coarse throttling — a closed-by-default, operator-gated
    // path — but not for brute-force resistance on sign-in, which is why
    // sign-in has its own account-keyed limiter instead (see
    // `sign-in-rate-limit.ts`).
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["x-real-ip"],
      },
    },
    rateLimit: {
      // Explicit and always on: better-auth's own default only enables
      // this in production (`enabled ?? isProduction`), which would
      // leave it silently untested in dev and CI. Loudly true here
      // instead of inferred from NODE_ENV.
      enabled: true,
      customRules: {
        [SIGN_UP_EMAIL_PATH]: {
          window: config.signupRateLimit.windowSeconds,
          max: config.signupRateLimit.max,
        },
        // `false` fully disables better-auth's own built-in special rule
        // for /sign-in* (3 attempts / 10 seconds, keyed on the client IP
        // above) rather than leaving it running in parallel as a second,
        // weaker mechanism: that IP key is exactly what CL-6494's
        // private-network bypass defeats, so enforcement for this path
        // lives entirely in `signInAttemptLimiter` below instead.
        [SIGN_IN_EMAIL_PATH]: false,
      },
    },
    // No mailer is wired up anywhere in this stack, so better-auth can
    // never actually verify an address -- `emailVerified` would stay
    // false forever and every self-serve signup would dead-end at
    // @workbench/access-policy's gate. `allowUnverifiedEmails`
    // (ALLOW_UNVERIFIED_EMAILS, dev/test only) auto-verifies at the
    // source instead of leaving each downstream consumer of
    // `emailVerified` to separately special-case it.
    databaseHooks: config.allowUnverifiedEmails
      ? {
          user: {
            create: {
              before: async (user: { email: string }) => {
                log.info`ALLOW_UNVERIFIED_EMAILS is set: auto-verifying ${user.email} at account creation (dev/test only)`;
                return { data: { ...user, emailVerified: true } };
              },
            },
          },
        }
      : undefined,
  });
  // The root tenant must exist before the first sign-in can provision a
  // personal bench under it; boot is the one moment the hub can
  // guarantee that ordering. Boot seeds the admin account and its owner
  // membership too — `workbench setup` then adopts the root instead of
  // colliding with it, and the root's policy row has an editor. Failure
  // here fails the boot loudly — a hub without its root tenant cannot
  // serve first logins.
  const operatorTenantId = await ensureDefaultTenant(
    db,
    auth,
    config.envCredentialPlantAdmin,
    config.defaultTenantSlug,
  );
  // Account-keyed sign-in rate limit (CL-6494) — see `sign-in-rate-limit.ts`
  // for why this replaces better-auth's own IP-keyed sign-in enforcement
  // entirely rather than composing with it.
  const signInAttemptLimiter = createSignInAttemptLimiter(
    config.signInRateLimit.windowSeconds,
    config.signInRateLimit.max,
  );
  const { signingKey, agentRepoStore, assetService } =
    await createBootAssetWiring({
      db,
      dataDir: config.hubDataDir,
      ...(config.allowGitInsideWorkTree === true
        ? { allowGitInsideWorkTree: true }
        : {}),
    });
  const baseLookups = createHubSessionLookups({ db, agentRepoStore });
  // Shared with `createRunKeyHistoryListener` below: one store instance
  // for the process, read here ahead of `workflow_run` and written to
  // there off every `agent.deploy.ack`.
  const runKeyHistoryStore = createDrizzleRunKeyHistoryStore(db);
  // A folded run (a workbench host, an invited agent) settles
  // "completed" between message occurrences as part of its own normal
  // wake/redeploy cycle — not "done forever" the way a one-shot
  // workflow deployment's "completed" is. The platform's own
  // `lookupPublicKey` gates the reconnect-ownership challenge on
  // `isLiveWorkflowRunStatus` ("deployed"/"running" only), so a folded
  // run reconnecting mid-cycle (its sidecar dials back in, e.g. after a
  // hub restart, while the run happens to be between occurrences) fails
  // that challenge and gets torn down even though nothing about it
  // actually ended. Falling back to `lookupFoldedRunReconnectKey` for a
  // "completed" folded run keeps its reconnect honest without loosening
  // the gate for a real workflow deployment or for a folded run that is
  // genuinely gone ("failed"/"cancelled" still fail closed).
  // CL-6345: the grant-allowance gate wraps `registerSignalCorrelation`
  // so a parked read-only call whose resource a standing grant covers is
  // auto-approved right after its approval row lands — no card for a
  // human, the ledgered row still records the decision. The gate's deps
  // (dispatch service, grant store, approval stores) don't exist yet at
  // this point in the composition, so the wrapper reads through this ref,
  // assigned once they do; until then every registration takes the plain
  // parked path.
  const grantAllowanceGateRef: {
    current?: (
      args: Parameters<typeof baseLookups.registerSignalCorrelation>[0],
    ) => Promise<void>;
  } = {};
  // CL-6499 (native multi-step routines): materializes a mail-triggered
  // run's authorization grants from its deploy-approved snapshot, so
  // ANY plain mail delivered to a workflow deployment's address — not
  // only the dedicated `POST /workflows/:id/mail` HTTP trigger route,
  // which stages this itself inline — starts a properly authorized
  // run. Without this wired, `sidecarRouter.routeMail` alone would
  // deliver the mail but leave the run's `runs/<runId>/grants.json`
  // unwritten, and its `onRunStart` barrier would never resolve. This
  // is the one piece of plumbing `apps/hub/src/native-workflow-routine-launch.ts`
  // relies on to trigger a native multi-step deployment safely.
  const mailTriggeredRunGrants = createMailTriggeredRunGrantsMaterializer({
    db,
    grantStore: createGrantStore(db),
  });
  const lookups = {
    ...baseLookups,
    materializeMailTriggeredRunGrants: mailTriggeredRunGrants,
    async registerSignalCorrelation(
      args: Parameters<typeof baseLookups.registerSignalCorrelation>[0],
    ): Promise<void> {
      const gate = grantAllowanceGateRef.current;
      if (gate !== undefined) return gate(args);
      return baseLookups.registerSignalCorrelation(args);
    },
    async lookupPublicKey(agentAddress: string): Promise<string | null> {
      // CL-6281: the repair runs before `baseLookups` because the case
      // it exists for is exactly the one `baseLookups` answers WRONGLY —
      // a live run whose `workflow_run.public_key` missed its own
      // `agent.deploy.ack` — so deferring to that answer would never
      // reach the repair at all. It cannot widen which runs may
      // reconnect: it reads the same `liveWorkflowRunStatuses` gate
      // `baseLookups` does, so a retired run still fails closed here.
      // See `@corbits/run-key-history`'s `reconnect.ts` for why
      // preferring this package's own record on disagreement is safe.
      const reconciled = await lookupRunKeyHistoryReconnectKey(
        db,
        runKeyHistoryStore,
        agentAddress,
      );
      if (reconciled !== null) return reconciled;
      const key = await baseLookups.lookupPublicKey(agentAddress);
      if (key !== null) return key;
      return lookupFoldedRunReconnectKey(db, agentAddress);
    },
  };
  const hubPublicKey = hexEncode(signingKey.publicKey);
  // CL-6149: a folded run's pinned tool packages (`toolPackagePins`)
  // carry no grants of their own — the deploy-time capability walk
  // (`vendor/intx/workflow-deploy/src/capability-walk.ts`) only derives
  // `tool:` grants for inline tool factories, so a pinned package's
  // tools failed every call closed with "No matching grants". Every
  // `@corbits/*-tools` package's namespaced tool ids and approval marks
  // are read once here (`describeCorbitsToolPackages`), so
  // `toolGrantsForPins` — the port every `FoldedRunsDeps` below is
  // built with — can synchronously turn a launch's pins into the
  // `tool:<qualifiedId>` grants `@corbits/folded-runs`' `deployAtHead`
  // mints against the run's own principal.
  const toolGrantsForPins = createToolGrantsForPins(
    await describeCorbitsToolPackages(),
  );
  // See `./mcp-credential-bindings.ts`'s own doc.
  const mcpCredentialBindingsFor = createMcpCredentialBindingsFor(db);
  // Same owning check GET /connections uses — see
  // `@corbits/connections`' `workflow-connection-routes.ts` and the
  // `createWorkflowConnectionRoutes` wiring below. Not
  // `listConnectedProviders` (catalog-only).
  const isConnectorConnected = async (tenantId: string, connectorId: string) =>
    (await resolveCredentialRequirement(
      db,
      tenantId,
      { providerName: connectorId, source: "tenant" },
      null,
      null,
    )) !== null;
  const pinnedPackageCredentialBindingsFor =
    createPinnedPackageCredentialBindingsFor(isConnectorConnected);
  // One resolver serves both seams, exactly as @intx/hub-sessions's own
  // reference host wires them: `resolve` turns a presented bearer token
  // into a verified identity at the handshake, and `isCurrent`
  // revalidates that identity at the registration, readiness, and
  // routing boundaries. Without the second one the router falls back to
  // its always-true default, and a provisioner-issued token stays
  // accepted after its allocation was superseded or destroyed — which a
  // process-provisioned sidecar reaches easily, since a child that
  // outlives its allocation keeps reconnecting to the same hub.
  const sidecarCredentials = createSidecarCredentialResolver({ db });
  const sidecarRouter = createSidecarRouter({
    hubPublicKey,
    authenticateSidecar: async ({ token }) => sidecarCredentials.resolve(token),
    validateSidecarIdentity: sidecarCredentials.isCurrent,
    lookups,
  });
  // A finalized turn's persisted-artifact tool-call results become
  // delivery file parts (CL-6000) via `createArtifactDeliveryHandler`,
  // built once `chatStore`/`chatPlatform` exist further down this
  // composition. `onTurnFinalized` itself must be supplied at
  // `createEventCollectorRegistry` construction time, before those
  // deps exist, so this indirection ref is set once they do and every
  // call before that point is a harmless no-op.
  // Process-lifetime provider-health signal (CL-6092): the one store
  // both the chat orchestrator's classified-failure port and
  // `GET .../connections/provider-health` read/write, so a runtime
  // failure a turn just reported is visible to the shell banner on its
  // very next poll. In-memory by design — see `provider-health.ts`'s own
  // header for why this never needs to survive a restart.
  const providerHealthStore = createProviderHealthStore();
  const artifactDeliveryHandlerRef: {
    current?: (
      agentAddress: string,
      turn: {
        turnId: string;
        toolCalls: FinalizedTurnToolCall[];
        errors: readonly { category: string; message: string }[];
      },
    ) => void;
  } = {};
  // Package-owned insights tables, migrated ahead of the event collector
  // registry so `usageSink` is live before the first `inference.usage`
  // event can arrive.
  await applyInsightsMigrations(config.databaseUrl);
  const insightsUsage = createPostgresUsageStore(config.databaseUrl);
  const insightsLatency = createPostgresTurnLatencyStore(config.databaseUrl);
  const usageSink = createUsageSink({
    store: insightsUsage.store,
    generateId: () => generateId("inferenceTurn"),
  });
  // CL-6257: per-message-run stage latency (message-received →
  // reactor.start → inference.start → first-token → reply-posted). The
  // vendored event collector never persists the events this reads (see
  // @corbits/insights' latency-tracker.ts header) and isn't ours to edit,
  // so this observes the same InferenceEvent stream from outside it by
  // wrapping `eventCollectors` below — the same seam `withTurnPartPersistGuard`
  // already uses on the `db` handle passed into the vendored registry.
  const turnLatency = createTurnLatencyTracker({
    store: insightsLatency.store,
    generateId: () => generateId("inferenceTurn"),
  });
  const baseEventCollectors = createEventCollectorRegistry({
    // `withTurnPartPersistGuard` (see @corbits/insights) wraps
    // `withTurnPartWriteDefaults`: it retries a turn_part insert once on
    // the collector's known turn_id/session_id FK race and makes any
    // surviving loss loud (error-level cause, counted) instead of a
    // swallowed WRN.
    db: withTurnPartPersistGuard(withTurnPartWriteDefaults(db)),
    onTurnFinalized: (agentAddress, turn) => {
      artifactDeliveryHandlerRef.current?.(agentAddress, turn);
    },
    // Per-turn usage, emitted once when the collector finalizes a turn.
    onUsage: (_agentAddress, usage) => {
      void usageSink
        .handle({
          turnId: usage.turnId,
          tenantId: usage.tenantId,
          sessionId: usage.sessionId,
          provider: usage.provider,
          model: usage.model,
          tokens: usage.usage,
        })
        .catch((err: unknown) => {
          log.warn`Failed to record usage for turn ${usage.turnId}: ${err instanceof Error ? err.message : String(err)}`;
        });
    },
  });
  // Wraps every `EventCollectorRegistry` call the vendored session
  // orchestrator makes: `create`/`dispatch`/`abandon` also feed
  // `turnLatency`, which is the only place tenantId/sessionId land
  // against an agentAddress for the raw event stream (the registry keeps
  // that mapping private). Every other method passes straight through.
  const eventCollectors: EventCollectorRegistry = {
    ...baseEventCollectors,
    create(agentAddress, tenantId, sessionId, runId) {
      turnLatency.onSessionCreate(agentAddress, tenantId, sessionId);
      baseEventCollectors.create(agentAddress, tenantId, sessionId, runId);
    },
    dispatch(agentAddress, event) {
      turnLatency.onEvent(agentAddress, event);
      baseEventCollectors.dispatch(agentAddress, event);
      // Mirrors the registry's own `isTerminal` check (event-collector-registry.ts)
      // so `turnLatency`'s per-agentAddress session map is cleared on the
      // same terminal events that make the registry drop its own collector
      // — otherwise a session that ends without `abandon()` never frees.
      const isTerminal =
        event.type === "reactor.done" ||
        (event.type === "reactor.error" && event.data.fatal);
      if (isTerminal) turnLatency.onSessionEnd(agentAddress);
    },
    abandon(agentAddress) {
      turnLatency.onSessionEnd(agentAddress);
      baseEventCollectors.abandon(agentAddress);
    },
  };
  createHubSessionOrchestrator({
    events: sidecarRouter.events,
    router: sidecarRouter,
    db,
    eventCollectors,
    agentRepoStore,
  });
  // A second, independent listener on the same `agent.deploy.ack` event
  // `createHubSessionOrchestrator` already reacts to above: that vendor
  // listener owns `workflow_run.public_key`'s live value, this one
  // maintains a decoupled append-only history so a historical signature
  // stays re-provable after a key rotation. It never reads
  // `workflow_run` — only its own last-recorded entry per address — so
  // it cannot race vendor's independent write to that row on the same
  // event.
  createRunKeyHistoryListener({
    events: sidecarRouter.events,
    store: runKeyHistoryStore,
  });
  // CL-6225: the launch path re-reads every tool-package tarball and
  // rebuilds a full git pack of every attached asset on every agent
  // launch; both reads are pure functions of an immutable commit SHA (see
  // `./launch-caches.ts`). Only `createSessionService`'s launch path gets
  // the cached wrapper — the smart-HTTP git routes and the asset REST
  // routes below keep the raw `agentRepoStore`/`assetService` because they
  // serve requests under per-request principals the cache is not sound
  // for (see `./launch-caches.ts`'s header comment).
  const launchCaches = createLaunchCaches({
    assetService,
    repoStore: agentRepoStore.repoStore,
  });
  const launchAgentRepoStore: AgentRepoStore = {
    writeDeployTree: agentRepoStore.writeDeployTree,
    createDeployPack: agentRepoStore.createDeployPack,
    receiveAgentStatePack: agentRepoStore.receiveAgentStatePack,
    receiveWorkflowRunPack: agentRepoStore.receiveWorkflowRunPack,
    getDeployRef: agentRepoStore.getDeployRef,
    getSigningPublicKey: agentRepoStore.getSigningPublicKey,
    repoStore: launchCaches.repoStore,
  };
  // Shared placement's code-sourced deploys previously left their
  // `WorkflowDefinitionSource` durable nowhere on the hub -- only on the
  // sidecar's local `deployment.json` (CL-6581). Wrapping the two deploy
  // methods here, at the composition root, records that source into
  // Postgres on every deploy without touching vendored
  // `session-service.ts`; exclusive placement already persists its own via
  // `workflow_run_launch_spec`, untouched.
  const workflowDeploySourceStore = createDrizzleWorkflowDeploySourceStore(db);
  const sessionService = withDeploySourceRecording(
    createSessionService({
      sidecarRouter,
      agentRepoStore: launchAgentRepoStore,
      assetService: launchCaches.assetService,
      db,
      toolPackageRegistries: {
        httpRegistries: REGISTRIES,
        defaultRegistry: "npmjs",
        scopeRouting: [{ scope: "@corbits", registry: CORBITS_TOOLS_REGISTRY }],
      },
    }),
    workflowDeploySourceStore,
  );
  const hubWebSocketUrl =
    config.sidecarWebSocketUrl ??
    `${config.baseUrl.replace(/^http/, "ws")}/api/sidecars/ws`;
  // Provisioner plugins are injected at the application composition
  // boundary, mirroring @intx/hub-sessions's own reference wiring. An
  // install that configures nothing registers the `process` backend
  // (`@corbits/process-provisioner`) as the sole default, so a
  // workbench's "run this workbench on its own sidecar" setting works on
  // one server with no operator setup; `SIDECAR_PROVISIONERS` is the one
  // variable that changes where sidecars run. Adding a new backend here
  // is: implement `SidecarProvisioner` in its own package, add a case to
  // `buildSidecarProvisioner`, and add its id to
  // `apps/hub/src/config.ts`'s `SIDECAR_PROVISIONER_IDS`.
  const sidecarPlugins = createSidecarPluginRegistry({
    provisioners: config.sidecarProvisioners.map((provisionerConfig) =>
      buildSidecarProvisioner(
        provisionerConfig,
        config.hubDataDir,
        hubWebSocketUrl,
      ),
    ),
    ...(config.defaultSidecarProvisionerId !== undefined
      ? { defaultProvisionerId: config.defaultSidecarProvisionerId }
      : {}),
  });
  const workflowAllocationService = createWorkflowAllocationService({
    db,
    plugins: sidecarPlugins,
    preparedDeployer: sessionService,
    credentialCipher,
    allocationRouter: sidecarRouter,
  });
  const sidecarAllocationStore = createSidecarAllocationStore(db);
  const workflowDispatchService = createWorkflowDispatchService({
    dispatchStore: createWorkflowRunDispatchStore(db),
    allocationStore: sidecarAllocationStore,
    router: sidecarRouter,
    resolveAnchorAddress: async (anchorRunId) => {
      const row = await db.query.workflowRun.findFirst({
        where: (run, { eq: equals }) => equals(run.id, anchorRunId),
        columns: { address: true },
      });
      return row?.address ?? null;
    },
  });
  const sidecarAllocationReconciler = createSidecarAllocationReconciler({
    allocationStore: sidecarAllocationStore,
    plugins: sidecarPlugins,
    router: sidecarRouter,
    hubWebSocketUrl,
    onReady: async (allocation) => {
      await workflowAllocationService.deployReadyAllocation(allocation);
      await workflowDispatchService.requeueForReadyAllocation(
        allocation.anchorRunId,
      );
    },
  });
  await sidecarAllocationReconciler.initialize();
  sidecarRouter.events.on("sidecar.disconnect", ({ allocated }) => {
    if (allocated === undefined) return;
    return sidecarAllocationReconciler.handleDisconnect(allocated);
  });
  sidecarRouter.events.on("sidecar.allocated.connected", (allocated) =>
    sidecarAllocationReconciler.handleConnected(allocated),
  );
  sidecarRouter.events.on(
    "mail.inbound.acknowledged",
    ({ messageId, allocated }) => {
      if (allocated === undefined) return;
      return workflowDispatchService.acknowledge({ ...allocated, messageId });
    },
  );
  const sidecarAllocationLog = getLogger(["hub", "sidecar-allocation"]);
  const ALLOCATION_RECONCILIATION_INTERVAL_MS = 1_000;
  const ALLOCATION_CONNECTION_REPAIR_INTERVAL_MS = 30_000;
  let nextAllocationConnectionRepairAt =
    Date.now() + ALLOCATION_CONNECTION_REPAIR_INTERVAL_MS;
  let sidecarAllocationReconciliationStopped = false;
  let sidecarAllocationReconciliationTimer:
    ReturnType<typeof setTimeout> | undefined;
  function scheduleAllocationReconciliation(delayMs: number): void {
    if (sidecarAllocationReconciliationStopped) return;
    const timer = setTimeout(() => {
      void reconcileSidecarAllocations();
    }, delayMs);
    timer.unref?.();
    sidecarAllocationReconciliationTimer = timer;
  }
  async function reconcileSidecarAllocations(): Promise<void> {
    try {
      await sidecarAllocationReconciler.reconcileUntilIdle();
      await workflowDispatchService.reconcileUntilIdle();
      if (Date.now() >= nextAllocationConnectionRepairAt) {
        nextAllocationConnectionRepairAt =
          Date.now() + ALLOCATION_CONNECTION_REPAIR_INTERVAL_MS;
        await sidecarAllocationReconciler.repairUnscheduledConnections();
      }
    } catch (error) {
      sidecarAllocationLog.error`Sidecar allocation reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      scheduleAllocationReconciliation(ALLOCATION_RECONCILIATION_INTERVAL_MS);
    }
  }
  scheduleAllocationReconciliation(ALLOCATION_RECONCILIATION_INTERVAL_MS);
  const app = createApp({
    workflowAllocationService,
    workflowDispatchService,
    credentialCipher,
    getSession: async (headers) => {
      const result = await auth.api.getSession({ headers });
      return result ? { user: result.user, session: result.session } : null;
    },
    authHandler: async (c) => {
      // Gate self-serve email signup. Sign-in stays open; only the
      // sign-up/email path is product-controlled (docs/TENANCY.md).
      if (c.req.method === "POST" && c.req.path.endsWith(SIGN_UP_EMAIL_PATH)) {
        if (config.signupMode === "closed") {
          return c.json(
            {
              error: "signup_closed",
              message:
                "Self-serve signup is disabled. Ask an owner for an invite.",
            },
            403,
          );
        }
        if (config.allowedEmailDomains.length > 0) {
          let email = "";
          try {
            const body: unknown = await c.req.raw.clone().json();
            if (
              body !== null &&
              typeof body === "object" &&
              "email" in body &&
              typeof (body as { email: unknown }).email === "string"
            ) {
              email = (body as { email: string }).email.toLowerCase();
            }
          } catch {
            email = "";
          }
          const at = email.lastIndexOf("@");
          const domain = at >= 0 ? email.slice(at + 1) : "";
          const allow = new Set(
            config.allowedEmailDomains.map((d) => d.toLowerCase()),
          );
          if (!allow.has(domain)) {
            return c.json(
              {
                error: "email_domain_not_allowed",
                message: "That email domain is not allowed to sign up.",
              },
              403,
            );
          }
        }
      }
      // Account-keyed sign-in brute-force protection (CL-6494, hardened
      // CL-6521) — see `sign-in-rate-limit.ts` for why this fully replaces
      // better-auth's own IP-keyed enforcement for this path instead of
      // running beside it, and for why only failures ever consume budget.
      if (c.req.method === "POST" && c.req.path.endsWith(SIGN_IN_EMAIL_PATH)) {
        let email: string | undefined;
        try {
          const body: unknown = await c.req.raw.clone().json();
          const parsed = SignInEmailBody(body);
          if (!(parsed instanceof type.errors)) email = parsed.email;
        } catch {
          email = undefined;
        }
        // A body that doesn't parse to `{ email: string }` never touches
        // the limiter at all — there is no account to key a bucket on,
        // and better-auth will reject the request on its own terms.
        const response = await auth.handler(c.req.raw);
        if (email === undefined) return response;
        if (response.status >= 200 && response.status < 300) {
          signInAttemptLimiter.recordSuccess(email);
          return response;
        }
        const decision = signInAttemptLimiter.recordFailure(email);
        if (!decision.allowed) {
          return c.json(
            {
              error: "rate_limited",
              message: `Too many sign-in attempts. Try again in ${decision.retryAfterSeconds} second${decision.retryAfterSeconds === 1 ? "" : "s"}.`,
            },
            429,
            { "Retry-After": decision.retryAfterSeconds.toString() },
          );
        }
        return response;
      }
      return auth.handler(c.req.raw);
    },
    db,
    sidecarRouter,
    sessionService,
    eventCollectors,
    assetService,
    repoStore: agentRepoStore.repoStore,
    maxTarballBytes: MAX_TARBALL_BYTES,
    // Lets a workflow-run agent deploy through the same
    // `/workflows/deployments` route a human session uses (see
    // `@intx/hub-api`'s `workflow-run-deploy-auth` middleware) -- the same
    // sidecar-bearer + run-address credential every other workflow-run write
    // surface below already authenticates with.
    workflowRunAuthenticator: createWorkflowRunAuthenticator({ db }),
    sidecarWsHandler: upgradeWebSocket((_c) => {
      let handle: WsHandle;
      return {
        onOpen(_evt, ws) {
          handle = { send: (d: string) => ws.send(d), close: () => ws.close() };
          sidecarRouter.handleOpen(handle);
        },
        onMessage(evt, _ws) {
          if (typeof evt.data === "string")
            sidecarRouter.handleMessage(handle, evt.data);
        },
        onClose: () => sidecarRouter.handleClose(handle),
      };
    }),
  });

  // Without this, any exception escaping a route (extension or platform
  // alike) falls through to Hono's built-in handler: a bare 500 with
  // nothing reported. See `hubErrorHandler`'s own doc comment.
  app.onError(hubErrorHandler());

  // One in-process presence room registry for this process, constructed
  // here in the composition root — the same pattern `workbenchSubscribers`
  // above uses. Presence rooms are ephemeral and process-local by design
  // (see `@corbits/presence`'s docs/presence.md); the registry is built
  // here rather than inside `createPresenceRoutes` itself so the
  // co-editing doc-persistence wiring below (which needs the artifacts
  // engine, mounted further down once its own DB handle resolves) can
  // share the exact same registry the routes below serve traffic
  // through — the same way `startWorkflowCommand` shares
  // `workbenchSubscribers`.
  const presenceRoomRegistry = createPresenceRoomRegistry();
  // Indirection so the join route can call into artifact-doc seeding
  // before the artifacts engine (mounted later, once its DB handle is
  // known) exists. `createPresenceRoutes` is constructed once, here, so
  // its `onJoin` hook has to be a stable function that reads whatever
  // `artifactSeedOnJoin` currently points to — `undefined` (a no-op)
  // until the artifacts mount below assigns it, or forever if the
  // artifacts plane never mounts.
  let artifactSeedOnJoin:
    ((key: PresenceRoomKey, principalId: string) => Promise<void>) | undefined;

  // Chat's own grant store/condition registry, built the same way
  // `createApp` builds its default when none is supplied (see
  // `@intx/hub-api`'s `mountHubRoutes`): a db-backed grant store and
  // the time-window condition evaluator. `createRequireGrant` is the
  // published construction the platform's own internal instance is
  // not exported for.
  const chatGrantStore = createGrantStore(db);
  const chatConditionRegistry: ConditionRegistry = {
    time_window: timeWindowEvaluator,
  };
  // CL-6345: arm the grant-allowance gate declared up at `lookups`. The
  // one annotation today is `mcp_call` (registered under both its bare
  // and pinned-namespaced names): a downstream MCP tool the server
  // itself marks `readOnlyHint: true`, called on a connection whose
  // `mcp:<slug>` resource an `allow`/"read" grant covers, is
  // auto-approved through the native resolve machinery; every other
  // parked call — writes, unverified claims, uncovered connections —
  // waits for a human exactly as before.
  {
    const mcpCallClassify = createMcpCallClassifier(
      createMcpServerToolsAllowanceLoader({ db, credentialCipher }),
    );
    const allowanceLog = (line: string) => log.info`${line}`;
    grantAllowanceGateRef.current = withGrantAllowance(
      (args) => baseLookups.registerSignalCorrelation(args),
      {
        registry: createToolAllowanceRegistry([
          {
            tool: MCP_CALL_TOOL,
            grantAction: "read",
            classify: mcpCallClassify,
          },
          {
            tool: `${mcpTools.id}:${MCP_CALL_TOOL}`,
            grantAction: "read",
            classify: mcpCallClassify,
          },
        ]),
        findRegisteredApproval: createRegisteredApprovalFinder(db),
        listTenantGrants: createTenantGrantLister(db),
        autoApprove: createAllowanceAutoApprover(
          {
            db,
            sidecarRouter,
            workflowDispatchService,
            readRunLifecycles: async (
              agentAddress,
              topLevelRunId,
              targetRunId,
            ) => {
              const lifecycles = await readDurableWorkflowRunLifecycles(
                agentRepoStore.repoStore,
                agentAddress,
                [topLevelRunId, targetRunId],
              );
              return {
                topLevel: lifecycles.get(topLevelRunId) ?? "absent",
                target: lifecycles.get(targetRunId) ?? "absent",
              };
            },
            grantStore: chatGrantStore,
            conditionRegistry: chatConditionRegistry,
            approvalStore: createApprovalStore(db),
            signalCorrelationStore: createSignalCorrelationStore(db),
          },
          allowanceLog,
        ),
        log: allowanceLog,
      },
    );
  }
  // Mounted here (not up with the registry construction above) because
  // its `/update` route's grant gate needs `chatGrantStore`/
  // `chatConditionRegistry`, which don't exist yet up there — the same
  // reason `artifactSeedOnJoin`'s indirection exists, just for a
  // dependency that's ready sooner.
  app.route(
    `${TENANT_PREFIX}/presence`,
    createPresenceRoutes({
      registry: presenceRoomRegistry,
      onJoin: (key, principalId) => artifactSeedOnJoin?.(key, principalId),
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  // Memory plane (optional): firm-memory HTTP under
  // `/api/tenants/:tenantId/memory/*`, same `DATABASE_URL` as the control
  // plane, isolated in its own `memory` schema. Degrades when EMBED_* is
  // unset — see memory-mount.ts. Captured (not discarded) here, before
  // `chatOrchestrator`/`createArtifactDeliveryHandler` below, so the
  // in-process `Memory` handle can be threaded into both: a finalized
  // turn's persisted artifact and the bounded daily transcript digest
  // (CL-5852) both write through this same handle, never a second
  // connection or the plane's own tenant-session-gated HTTP routes.
  const memoryHandle = await mountMemory({
    app,
    grantStore: chatGrantStore,
    conditionRegistry: chatConditionRegistry,
  });
  const chatStore = createDrizzleChatStore(db);
  const threadStore = createDrizzleThreadStore(db);
  const blockResponseStore = createDrizzleBlockResponseStore(db);
  const reactionStore = createDrizzleReactionStore(db);
  const pinStore = createDrizzlePinStore(db);
  // Durable redelivery-dedup for the finalized-turn write surfaces
  // (CL-6039) — see `WriteClaimStore`'s own doc comment. Same `db`
  // handle as every other Drizzle store above, never a second
  // connection.
  const writeClaims = createDrizzleWriteClaimStore(db);
  // Durable dispatch-mail -> source-message correlation (CL-6314) — the
  // record the reply path reads back to thread an agent's answer under
  // the message that woke its turn. Same `db` handle, same reasoning.
  const turnMailCorrelation = createDrizzleTurnMailCorrelationStore(db);
  // Mounted outside the tenant prefix — the sidecar reaches it as a
  // plain inference endpoint, never through tenant-scoped auth, the
  // same way it reaches a real provider's API. Pinned by the heartbeat
  // and workbench-digest workflows' seeds (`@corbits/seeding`), whose
  // agents never produce text. `config.baseUrl` (not `localhost`) is
  // what makes the URL usable from a sidecar on another machine.
  app.route("/api/chat/noop-inference", createNoopInferenceRoutes());
  const selfApi = createHubAPI(config.baseUrl);
  const sessionFor = createBenchSessionMinter({
    auth,
    log: (line) => log.warn`${line}`,
  });
  const chatTenancy = createDrizzleWorkbenchTenancyStore(db, {
    conditionRegistry: chatConditionRegistry,
    api: selfApi,
  });
  // Mounted outside the tenant prefix, like `/api/onboarding`: the bench
  // switcher asks this across every tenant a signed-in user belongs to,
  // not one tenant at a time (see `apps/web/src/bench-context.tsx`).
  app.route(
    "/api/workbench-tenancies",
    createWorkbenchTenancyRoutes({ tenancy: chatTenancy }),
  );
  // The chat platform's invite-launch fallback: a definition with no
  // model requirements of its own resolves the tenant-catalog default.
  const workbenchHostInferencePreferencesResolver =
    createWorkbenchHostInferencePreferencesResolver((tenantId) =>
      listDefaultInferencePreferences(db, tenantId),
    );
  // Where a relaunch announces itself in the room (see `@corbits/chat`'s
  // `relaunch-notice.ts`). Armed further down, once the room-message
  // store the poster writes through exists — the platform that fires
  // notices has to be constructed first, since the sweep that triggers
  // most of them hangs off it.
  const relaunchNoticeRef: RelaunchNoticePort = {};
  // One CryptoProviderCache for the whole hub process (CL-7284). Chat
  // sendMail keys by workbench id; webhook, routine, and agent-definition
  // drafting first-turn mail key by the launched run's instance id. New
  // workbenches and run ids are `run_` (`generateId("workflowRun")`);
  // older workbenches are `ins_` (`generateId("instance")`). They share a
  // string shape — a second cache for the same id would mint a different
  // signing key. generateId uniqueness keeps distinct entities from
  // colliding; sharing the cache keeps the same entity from rotating keys
  // across consumers. TTL-bounded by `createCryptoProviderCache` itself
  // (CL-7223).
  const cryptoProviders = createCryptoProviderCache();
  const chatPlatform = createHubChatPlatform({
    db,
    sessionService,
    assetService,
    sidecarRouter,
    eventCollectors,
    credentialCipher,
    toolGrantsForPins,
    mcpCredentialBindingsFor,
    pinnedPackageCredentialBindingsFor,
    cryptoProviders,
    // Chat residents are undeployed on idle again (see the comment above
    // this function): `chatIdleReapMs` (env-overridable via
    // `WORKBENCH_CHAT_IDLE_REAP_MS`, default 30 minutes) is
    // state-preserving (`IDLE_HIBERNATE_UNDEPLOY_REASON`), unlike a
    // destructive undeploy.
    lifecycle: { idleSleepMs: config.chatIdleReapMs },
    //
    // A hand-authored definition with no model requirements of its own
    // (see `@corbits/agent-directory`'s `createAgentDefinitionCore`
    // doc) still launches on invite by falling back to this same
    // tenant-catalog default, instead of 409ing `not_launchable`.
    workbenchHostInferencePreferences:
      workbenchHostInferencePreferencesResolver,
    relaunchNotice: relaunchNoticeRef,
  });
  wireMailRedelivery({ sidecarRouter, chatPlatform });
  // The one SSE subscriber registry for this process's workbench events
  // (see `@corbits/chat`'s `workbench-events.ts`), constructed here in
  // the composition root and shared by every consumer below: the chat
  // router bridges it onto `/workbenches/:id/stream`, the
  // workflow-command path publishes through the same instance so a
  // command-started workflow's join event reaches an open stream
  // immediately (exactly like `POST .../invite`'s does), and the
  // orchestrator publishes every message it posts onto a workbench's
  // timeline.
  const workbenchSubscribers = createWorkbenchSubscriberRegistry();
  // One in-flight turn per workbench (CL-6331), shared by every send
  // surface below the same way `workbenchSubscribers` is: the chat
  // router, the workflow-participant router (a workflow child's own
  // sends), and the Slack tag mount all route through this one queue,
  // so a burst arriving through any of them for the same workbench
  // still serializes against the others rather than each queue only
  // seeing its own slice of the traffic.
  const turnQueue = createWorkbenchTurnQueue({
    claims: createInMemoryTurnClaimStore({ ttlMs: DEFAULT_TURN_CLAIM_TTL_MS }),
    publish: workbenchSubscribers.publish,
  });
  // The live abort seam a running turn is reachable through (CL-7201) —
  // shared the same way `turnQueue` above is, so a cancel request lands
  // wherever a workbench's turn was actually dispatched from.
  const turnCancellation = createTurnCancelRegistry();
  // The room timeline store (CL-6327): a workbench's own messages, held
  // as workbench data rather than platform mail.
  const roomMessages = createDrizzleRoomMessageStore(db);
  relaunchNoticeRef.current = createRelaunchNoticePoster({
    store: chatStore,
    roomMessages,
    publish: workbenchSubscribers.publish,
  });
  // Built once, beside the platform, for the process's lifetime: turns
  // an invited agent's `connector.reply` events into workbench messages,
  // and a gate-blocked run's approval park into an in-chat approve
  // block, by subscribing to the sidecar's own event stream, replacing
  // the old per-agent reply-bridge machinery armed (and re-armed) from
  // inside the routes. `chatPlatform.recordActivity` is the same
  // idle-sleep lifecycle `chatPlatform` itself drives — wiring it here
  // too is what keeps a replying agent's activity clock current even
  // though the reply never goes through `chatPlatform.sendMail`'s own
  // `recordActivity` call. `approvals` is the same `ApprovalStore` the
  // platform's own approve/reject routes read and write — this
  // orchestrator only ever reads it.
  const agentTurns = createDrizzleAgentTurnStore(db);
  const chatOrchestratorDeps: Parameters<typeof createChatOrchestrator>[0] = {
    db,
    agentTurns,
    store: chatStore,
    roomMessages,
    publish: workbenchSubscribers.publish,
    platform: chatPlatform,
    events: sidecarRouter.events,
    approvals: createApprovalStore(db),
    recordActivity: chatPlatform.recordActivity,
    claims: writeClaims,
    threads: threadStore,
    turnMailCorrelation,
    connectorRegistry: CONNECTOR_REGISTRY,
  };
  if (memoryHandle !== undefined) {
    chatOrchestratorDeps.memory = memoryHandle.memory;
  }
  const chatOrchestrator = createChatOrchestrator(chatOrchestratorDeps);
  // CL-6644: a loud, unconditional boot confirmation that message intake
  // is actually wired — a composition-root mistake here (an import
  // dropped, a construction reordered, an argument omitted) type-checks
  // fine but produces a hub that accepts messages into a void: no
  // dispatch, no error, no notice, just a message that persists and is
  // never asked of anyone. This can't detect every such mistake (the
  // pieces below are non-optional local bindings, not feature-flagged),
  // but it turns "intake is wired" from an assumption nothing checks
  // into a line every boot log carries — the next investigation starts
  // by grepping for this instead of re-deriving the whole call chain.
  getLogger(["hub", "chat-intake"]).info(
    "Chat message intake wired: turnQueue={hasTurnQueue} " +
      "chatOrchestrator={hasOrchestrator} chatPlatform={hasPlatform}",
    {
      hasTurnQueue: turnQueue !== undefined,
      hasOrchestrator: chatOrchestrator !== undefined,
      hasPlatform: chatPlatform !== undefined,
    },
  );
  // A room participant that died with its sidecar is otherwise silently
  // dead until somebody writes into it, and the turn the crash
  // interrupted never surfaces at all — the run that died never sends
  // the `message.run.ended` the orchestrator's turn-drop notice hangs
  // off. The sweep finds those runs and relaunches each one, posting
  // its notice.
  //
  // A series of passes rather than one, because "this run is dead" is
  // not knowable at the instant the execution plane comes back: the
  // terminal event is committed to the run's durable log by the dying
  // sidecar and reaches `workflow_run.status` only once the restarted
  // sidecar has packed it back to the hub, seconds later. The series is
  // bounded and re-armed by a sidecar disconnect, which is the one
  // event that can newly orphan a room.
  const relaunchSweepLog = getLogger(["chat", "relaunch-sweep"]);
  const RELAUNCH_SWEEP_DELAYS_MS = [0, 2_000, 5_000, 15_000, 45_000];
  // Bumped by every reschedule so a pass still in flight from the
  // previous series retires instead of continuing beside the new one.
  let relaunchSweepSeries = 0;
  let relaunchSweepTimer: ReturnType<typeof setTimeout> | undefined;
  function runNextRelaunchSweepPass(series: number, pass: number): void {
    const delay = RELAUNCH_SWEEP_DELAYS_MS[pass];
    if (delay === undefined || series !== relaunchSweepSeries) return;
    const timer = setTimeout(() => {
      void chatPlatform
        .sweepTerminalRuns()
        .catch((cause: unknown) => {
          relaunchSweepLog.error`relaunch sweep pass failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`;
        })
        .finally(() => {
          runNextRelaunchSweepPass(series, pass + 1);
        });
    }, delay);
    timer.unref?.();
    relaunchSweepTimer = timer;
  }
  function scheduleRelaunchSweep(): void {
    clearTimeout(relaunchSweepTimer);
    relaunchSweepSeries += 1;
    runNextRelaunchSweepPass(relaunchSweepSeries, 0);
  }
  scheduleRelaunchSweep();
  sidecarRouter.events.on("sidecar.disconnect", () => {
    scheduleRelaunchSweep();
  });
  // Now that `chatStore`/`chatPlatform` exist, arm the finalized-turn
  // artifact-delivery ref declared beside `eventCollectors` above.
  // `memory` (absent when the plane isn't mounted) lets this handler
  // also record a memory entry for each persisted artifact (CL-5852).
  const artifactDeliveryHandlerDeps: Parameters<
    typeof createArtifactDeliveryHandler
  >[0] = {
    db,
    store: chatStore,
    roomMessages,
    publish: workbenchSubscribers.publish,
    platform: chatPlatform,
    events: sidecarRouter.events,
    approvals: createApprovalStore(db),
    claims: writeClaims,
    agentTurns,
    threads: threadStore,
    turnMailCorrelation,
    providerHealth: createProviderHealthPort(providerHealthStore),
    listConnectedProviders: (tenantId) => listConnectedProviders(db, tenantId),
  };
  if (memoryHandle !== undefined) {
    artifactDeliveryHandlerDeps.memory = memoryHandle.memory;
  }
  artifactDeliveryHandlerRef.current = createArtifactDeliveryHandler(
    artifactDeliveryHandlerDeps,
  );
  // The "/name args" and "@name args" command registry: every tenant's
  // invitable workflow definitions, exposed as commands by
  // `createWorkflowCommandPlugin`, resolved fresh on every list/lookup
  // so a newly-deployed definition is a command on its very next use —
  // no re-registration step. `startWorkflow` is `@corbits/chat`'s own
  // `startWorkflowCommand`, sharing the exact invite-then-send core
  // `POST .../invite` uses, including its live `publish` — bound to
  // `workbenchSubscribers` above, the same registry `createChatRoutes`
  // is given below.
  const commandRegistry = createCommandRegistry();
  commandRegistry.registerCommandPlugin(
    createWorkflowCommandPlugin({
      listInvitableDefinitions: (tenantId) =>
        chatPlatform.listInvitableDefinitions(tenantId),
      startWorkflow: (input) =>
        startWorkflowCommand(
          {
            store: chatStore,
            platform: chatPlatform,
            roomMessages,
            publish: workbenchSubscribers.publish,
          },
          input,
        ),
    }),
  );

  // The one "is this a conversational agent?" ruling, shared by every
  // picker that offers agents to a person and by a routine's `"agent"`-kind
  // trigger-field validation below: a catalog workflow whose entry says
  // `conversational: false` (routine/automation material — Echo, "Last 30
  // days research report", …) and workbench-host anchor definitions
  // (chat's own plumbing, never a person-facing agent) belong in neither.
  // `isConversationalWorkflowName`, not `isAutomatableWorkflowName`: a
  // non-automatable utility workflow (Echo, the research report a routine
  // delivers) is still not conversational, and the old automatable-only
  // check let both leak into every agent picker (CL-6649).
  const isConversationalAgentDefinition = (definition: { name: string }) =>
    isConversationalWorkflowName(definition.name) &&
    !isWorkbenchHostDefinitionName(definition.name);

  // A second, narrower ruling layered on top of the ruling above, for
  // LISTING/PICKER surfaces only. A planner-created agent (the
  // now-deleted tasks primitive's planner `{create}` branch, CL-6051;
  // see `@corbits/agent-directory`'s `stale-task-agent-naming.ts`)
  // existed for exactly one now-retired task; any that still linger
  // must stay out of a picker meant for agents a person deliberately
  // keeps around. Wired into every picker surface:
  // chat's invite/new-chat dialogs (`chatDeps.isInvitableDefinition` below)
  // and the agent-definition drafting inventory
  // (`listMyraConversationalAgents` below).
  const isPickerListableDefinition = (definition: { name: string }) =>
    isConversationalAgentDefinition(definition) &&
    !isPlannerCreatedDefinitionName(definition.name);

  const chatDeps: Parameters<typeof createChatRoutes>[0] = {
    store: chatStore,
    roomMessages,
    platform: chatPlatform,
    tenancy: chatTenancy,
    threads: threadStore,
    turnMailCorrelation,
    agentTurns,
    turnTextSnapshot: (input) =>
      createDrizzleTurnTextSnapshotReader(db).read(input),
    blockResponses: blockResponseStore,
    reactions: reactionStore,
    pins: pinStore,
    clientIds: createDrizzleClientIdStore(db),
    workbenchSubscribers,
    turnQueue,
    turnCancellation,
    requireGrant: createRequireGrant({
      grantStore: chatGrantStore,
      conditionRegistry: chatConditionRegistry,
    }),
    isInvitableDefinition: isPickerListableDefinition,
    turnTimeoutMs: DEFAULT_TURN_CLAIM_TTL_MS,
    resolvePrincipalName: async (_tenantId, principalId) => {
      const principalRow = await db.query.principal.findFirst({
        where: (p, { eq: equals }) => equals(p.id, principalId),
        columns: { kind: true, refId: true },
      });
      if (principalRow === undefined || principalRow.kind !== "user") {
        return undefined;
      }
      const userRow = await db.query.user.findFirst({
        where: (u, { eq: equals }) => equals(u.id, principalRow.refId),
        columns: { name: true },
      });
      return userRow?.name ?? undefined;
    },
    commands: commandRegistry,
    // The same native undeploy call the idle-sleep lifecycle uses to
    // tear an invited agent's instance down (see `chatPlatform`'s own
    // `lifecycle.undeploy` above) — wired here too so removing an agent
    // from a workbench's participants releases its running instance the
    // same way, rather than leaving it deployed with nothing routing
    // messages to it.
    releaseAgentInstance: (address, reason) =>
      sidecarRouter.sendAgentUndeploy(address, reason),
    // CL-7450: fans a sent human message into every human participant's
    // `@corbits/mailbox` inbox, on the same `mailboxDb`/`mailboxBus` every
    // other mailbox consumer in this file shares. `resolveKnownPrincipalIds`
    // reads the control plane's own `principal` table directly (the
    // authoritative "is this a real principal in this tenant" check),
    // rather than `@corbits/mailbox`'s FK, so an unknown participant is a
    // reported skip, not a database error deep in a transaction.
    mailbox: {
      writer: createDrizzleMailboxWriter(mailboxDb, mailboxBus),
      resolveKnownPrincipalIds: async (tenantId, candidateIds) => {
        if (candidateIds.length === 0) return new Set();
        const rows = await db.query.principal.findMany({
          where: (p, { eq: equals, and: andAll }) =>
            andAll(equals(p.tenantId, tenantId), inArray(p.id, candidateIds)),
          columns: { id: true },
        });
        return new Set(rows.map((row) => row.id));
      },
      // A row's Message-ID always addresses under the row's OWN tenant's
      // domain, never the acting caller's — see `mailbox-fanout.ts`'s
      // `MailboxFanoutDeps.resolveTenantDomain` doc comment. Same
      // `tenant` lookup `workflowDeployer.deploy` above uses for the
      // identical reason (an instance's trigger address, minted against
      // its own tenant's domain).
      resolveTenantDomain: async (tenantId) => {
        const tenantRow = await db.query.tenant.findFirst({
          where: eq(tenantTable.id, tenantId),
        });
        if (tenantRow === undefined) {
          throw new Error(`no tenant "${tenantId}" to address a mailbox from`);
        }
        return tenantRow.domain;
      },
    } satisfies MailboxFanoutDeps,
  };
  app.route(`${TENANT_PREFIX}/chat`, createChatRoutes(chatDeps));
  // Myra's workflow-run chat surfaces (`@corbits/agent-directory-tools`'
  // `create_agent` default mint-dm + invite for non-chat kinds): the
  // workflow-run-authenticated counterpart to browser chat routes,
  // self-WORKBENCH scoped — see `@corbits/chat`'s
  // `workflow-participant-routes.ts` for the [Intx/repo gap] this resolves
  // around (no direct run-address -> workbench index; resolved by scanning
  // the tenant's workbench participant lists).
  app.route(
    "/api/workflow-chat",
    createWorkflowParticipantRoutes({
      store: chatStore,
      platform: chatPlatform,
      roomMessages,
      publish: workbenchSubscribers.publish,
      turnQueue,
      turnCancellation,
      turnMailCorrelation,
      authenticator: createWorkflowRunAuthenticator({ db }),
      tenancy: chatTenancy,
      sessionFor,
    }),
  );
  // Slack tag ingress (CL-5288 Phase 1): mounted OUTSIDE the tenant
  // prefix and outside session auth, like the webhook ingress below —
  // Slack is not a principal, and this route resolves its own
  // Interchange identity per message (see `./slack-tag-mount.ts` and
  // `@corbits/slack-tag`'s signature-verification-gated dispatch). A
  // missing SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET pair is a valid
  // configuration — the mount is silently skipped.
  const slackTagMount = await mountWorkbenchSlackTag({
    app,
    db,
    databaseUrl: config.databaseUrl,
    chatStore,
    chatPlatform,
    roomMessages,
    chatTenancy,
    sessionFor,
    workbenchSubscribers,
    turnQueue,
    turnCancellation,
    turnMailCorrelation,
  });
  // Tells the routine trigger popover whether a Slack-bound webhook
  // trigger is honestly offerable in this deployment — no session or
  // tenant required to ask, the same reasoning as `/api/auth-config`
  // above. Only a boolean crosses this route, never the credential pair
  // itself.
  app.get("/api/deployment-capabilities", (c) =>
    c.json({ slackConfigured: slackTagMount.mounted }),
  );
  // Product inbox over `@corbits/mailbox` — three groups, mark-all-read
  // (mentions + deliveries only), clear-done. The raw package surface
  // (including SSE events) mounts under `/mailbox` for hosts and tools
  // that need the universal API.
  app.route(
    `${TENANT_PREFIX}/inbox`,
    createInboxRoutes({ db: mailboxDb, bus: mailboxBus }),
  );
  // Insights usage sink + read API. Package-owned tables are migrated
  // at hub start (idempotent ledger); the store is Postgres-backed so
  // numbers survive restarts. Absent rates / pre-sink history stay null.
  // runTraceReader reads the platform's own workflow_run /
  // inference_turn / turn_part tables directly
  // (see @corbits/insights' createDrizzleRunTraceReader) — no new storage,
  // same `db` handle every other platform-table reader in this file uses.
  // The sink itself is constructed earlier, alongside `eventCollectors`
  // (see the `onUsage` hook on `createEventCollectorRegistry` above),
  // which reports each finalized turn's usage with its run identity.
  app.route(
    `${TENANT_PREFIX}/insights`,
    createInsightsRoutes({
      store: insightsUsage.store,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      runTraceReader: createDrizzleRunTraceReader(db),
      latencyStore: insightsLatency.store,
      // Same `db` handle every other platform-table reader in this file
      // uses — lets /usage, /activity, /tools, and /scope roll up a
      // workspace parent's child workbenches (see resolveScope in
      // @corbits/insights' routes.ts).
      db,
    }),
  );
  // A workflow definition's own detail page (CL-7371): what it is,
  // whether it can run right now, its steps, and its access surface.
  // Mounted alongside — not inside — the vendored
  // `createWorkflowDefinitionRoutes` (`vendor/intx/hub-api/src/app.ts`
  // already mounts that one at this same `/workflows/definitions`
  // prefix): this GET is a Workbench-owned read composed over native
  // rows plus `@corbits/workflows`'s `./deploy-source`, so it lives in
  // `@corbits/workflows`'s `./detail`, not the vendored tree.
  app.route(
    `${TENANT_PREFIX}/workflows/definitions`,
    createWorkflowDetailRoute({
      db,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  const scheduledDeliveryJoinDeps: ScheduledDeliveryJoinDeps = {
    deliveryWorkbenchRequired: deliveryWorkbenchRequiredForWorkflowName,
    resolveDeliveryWorkbench: async (tenantId) => {
      const rows = await chatStore.listWorkbenchSettings(tenantId);
      const first = [...rows].sort((a, b) =>
        a.workbenchId.localeCompare(b.workbenchId),
      )[0];
      return first?.workbenchId;
    },
    joinDeliveryWorkbench: (input) =>
      joinRunParticipant({ store: chatStore }, input),
  };
  app.route(
    `${TENANT_PREFIX}/workflows`,
    createScheduledWorkflowRoutes({
      db,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      catalogAssetNames: CATALOG_WORKFLOWS.map(
        (workflow) => workflow.assetName,
      ),
      catalogWorkflowDeployable: catalogWorkflowDeployableOnThisPin,
      runNow: async (args) =>
        runNowScheduledDefinition(
          { db, sidecarRouter, ...scheduledDeliveryJoinDeps },
          {
            tenantId: args.tenantId,
            definitionId: args.definitionId,
            principalId: args.principalId,
            fromDomain: args.fromDomain,
            content: args.content,
            name: args.name,
            definitionAssetId: args.assetId,
          },
        ),
    }),
  );
  // Run key identity diagnostics: read side of the append-only
  // `run_key_history` table above — per-run key lifecycle, divergence
  // against `workflow_run.public_key`, and tenant-wide counts by
  // identity state, so diagnosing a stranded run never again requires
  // hand-comparing a sidecar's on-disk key against this table.
  app.route(
    `${TENANT_PREFIX}/run-key-history`,
    createRunKeyHistoryRoutes({
      db,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  // Preferences: a single per-(tenant, principal) JSONB bag for small UI
  // choices a surface wants to remember across reload (col2 collapse,
  // theme, ...). Package-owned table, migrated at hub start like insights.
  await applyPreferencesMigrations(config.databaseUrl);
  const preferences = createPostgresPreferencesStore(config.databaseUrl);
  app.route(
    `${TENANT_PREFIX}/preferences`,
    createPreferencesRoutes({
      store: preferences.store,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  // Bench model policy: what a bench will and will not spend inference on.
  // Package-owned table, migrated at hub start like insights and
  // preferences. A bench with no row is unconstrained, so a freshly
  // connected bench needs no configuration to get an answer.
  await applyInferenceCatalogMigrations(config.databaseUrl);
  const benchModelPolicy = createPostgresBenchModelPolicyStore(
    config.databaseUrl,
  );
  app.route(
    `${TENANT_PREFIX}/bench-model-policy`,
    createBenchModelPolicyRoutes({
      store: benchModelPolicy.store,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  // Bench purpose/type: benches are Interchange tenants, so this is a
  // package-owned side-table keyed by tenant id, migrated at hub start
  // like insights and preferences.
  await applyBenchMigrations(config.databaseUrl);
  const benchSettings = createPostgresBenchSettingsStore(config.databaseUrl);
  app.route(
    `${TENANT_PREFIX}/bench-settings`,
    createBenchRoutes({
      store: benchSettings.store,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  // Eval run history: read-only surface over the package-owned
  // `evals.run` table, migrated at hub start like insights and
  // bench-settings. Eval runs aren't tenant-owned (same as
  // run-key-history), so the tenant prefix here is only the grant gate.
  await applyEvalsMigrations(config.databaseUrl);
  const evalRuns = createPostgresEvalRunStore(config.databaseUrl);
  app.route(
    `${TENANT_PREFIX}/eval-runs`,
    createEvalRunRoutes({
      store: evalRuns.store,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  app.route(
    `${TENANT_PREFIX}/sidecar-placement`,
    createSidecarPlacementRoutes({
      store: createDrizzleSidecarPlacementStore(db),
      hasProvisioner: config.sidecarProvisioners.length > 0,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  {
    const mailboxApp = new Hono<TenantEnv>();
    mountMailbox(mailboxApp, {
      db: mailboxDb,
      bus: mailboxBus,
      vocabulary: WORKBENCH_MAILBOX_VOCABULARY,
      resolvePrincipal: (ctx) => {
        // Mounted under the hub tenant middleware; principal + tenant are set.
        const c = ctx as {
          get(key: "tenant" | "principal"): { id: string };
        };
        return {
          tenantId: c.get("tenant").id,
          principalId: c.get("principal").id,
        };
      },
    });
    app.route(`${TENANT_PREFIX}/mailbox`, mailboxApp);
  }

  // Agent definitions a person authors by hand from the Agents page's

  // create form, materialized the same way the platform's own starter
  // agents are (see `@corbits/agent-directory`'s doc comment). Shares
  // `chatGrantStore`/`chatConditionRegistry` with every other extension
  // mounted here — there is nothing chat-specific about that pair, it
  // is just this composition root's one db-backed grant store.
  // The skill registry over native `kind:"skill"` assets, plus the two
  // surfaces it serves: the tenant-session one the Skills settings
  // section calls, and the run-authenticated one a workflow child's
  // `@corbits/tools-skills` bundle calls (mounted outside the tenant
  // prefix below, beside `/api/workflow-memory`).
  const skills = mountSkills({
    db,
    assetService,
    repoStore: agentRepoStore.repoStore,
  });
  const definitionSkillsStore = createDrizzleDefinitionSkillsStore(db);
  app.route(
    `${TENANT_PREFIX}/skills`,
    createSkillRoutes({
      registry: skills.registry,
      pinnedBy: skills.pinnedBy,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );
  app.route(
    "/api/workflow-skills",
    createWorkflowSkillRoutes({
      authenticator: createWorkflowRunAuthenticator({ db }),
      registry: skills.registry,
    }),
  );
  // CL-7361: the `deploy` half of the run-authenticated deployer this
  // route's registry calls — the SAME `sessionService.
  // deployWorkflowFromSource` call (already `withDeploySourceRecording`-
  // wrapped above) the native `POST /workflows/deployments` route's own
  // non-exclusive branch makes, not a reimplementation of install/probe/
  // gate/freeze. Inference sources are resolved server-side from the
  // tenant's catalog (`resolveDefinitionSources`) exactly as
  // `agent-definitions`' `tenantDefaultModel` does above — an agent never
  // supplies or sees a provider secret. Exclusive sidecar placement is out
  // of scope: an agent-authored deploy always lands on shared capacity.
  // Thin adapter over Interchange's native deploy: `registry.deploy()`
  // (packages/agent-workflow-authoring) already resolves and authorizes the
  // asset (own-tenant row check, `workflow:*`/create) before calling this,
  // so this seam receives the already-resolved `assetId`/`assetName`
  // rather than re-querying `assetTable` — the only work this adapter adds
  // on top of native `sessionService.deployWorkflowFromSource` is
  // server-side inference-source resolution (`resolveDefinitionSources`),
  // because the native `/workflows/deployments` route requires the caller
  // to supply `sources` directly and an agent caller must never see a
  // provider secret to do that itself. `modelRequirements: null` is
  // deliberate: a workflow's own declared model needs (if any) are not
  // considered at this step, matching `agent-definitions`' identical
  // tenant-default resolution above; deploy always resolves against the
  // tenant's default/first-preference model.
  //
  // `wf_deploy_preview` (CL-7362) is NOT wired through this
  // deployer, and is not a probe-without-freeze call into native
  // `sessionService` — a reviewed vendored delta that would have enabled
  // that was reverted (see VENDORED.md). Instead `registry.previewDeploy`
  // (packages/agent-workflow-authoring) does a static, read-only render of
  // the already-committed source at `commitSha` straight off `RepoStore`,
  // parsing `package.json` and the entry module text; it never touches
  // install/probe/gate/freeze, so it truly cannot deploy anything.
  const workflowDeployer: WorkflowDeployer = {
    async deploy({ tenantId, principalId, assetId, commitSha, entry }) {
      const tenantRow = await db.query.tenant.findFirst({
        where: eq(tenantTable.id, tenantId),
      });
      if (tenantRow === undefined) {
        throw new WorkflowAuthorError(
          "not_found",
          `tenant ${tenantId} not found`,
        );
      }

      const fallbackModel =
        (await workbenchHostInferencePreferencesResolver(tenantId))[0]?.model ??
        null;
      const resolution = await resolveDefinitionSources({
        db,
        tenantId,
        modelRequirements: null,
        fallbackModel,
        invokerPreferences: {},
        credentialCipher,
      });
      if (!resolution.ok) {
        throw new WorkflowAuthorError("invalid", resolution.message);
      }

      const anchorRunId = generateId("workflowRun");
      const agentAddress = deriveRunAddress({
        runId: anchorRunId,
        domain: tenantRow.domain,
      });
      const config: HarnessConfig = {
        sessionId: generateId("session"),
        agentId: deriveRunAgentId({ runId: anchorRunId }),
        tenantId,
        principalId,
        agentAddress,
        systemPrompt: "",
        tools: [],
        grants: [],
        sources: resolution.sources,
        defaultSource: resolution.defaultSource,
      };

      try {
        const result = await sessionService.deployWorkflowFromSource({
          tenantId,
          anchorRunId,
          deploymentDomain: tenantRow.domain,
          agentAddress,
          source: {
            kind: "asset",
            assetId,
            package: { format: "source", commitSha },
          },
          entry,
          definitionAssetId: assetId,
          config,
        });
        return {
          deploymentId: result.anchorRunId,
          definitionAssetId: assetId,
          status: "deployed",
        };
      } catch (err) {
        // Mirrors `@intx/hub-api`'s own `/workflows/deployments` route: an
        // install/gate rejection or an unapproved source chain is a
        // client/definition error; anything else (a missing commit, an
        // unreachable sidecar) is reported as `unavailable` rather than
        // guessed apart, exactly as the native route's own catch-all does.
        if (err instanceof WorkflowDefinitionInvalidError) {
          throw new WorkflowAuthorError("invalid", err.message);
        }
        throw new WorkflowAuthorError(
          "unavailable",
          err instanceof Error ? err.message : "Failed to deploy workflow",
        );
      }
    },
  };
  // Agent-authored workflows (CL-7360, CL-7361): an agent publishes a
  // workflow codebase as a native `kind:"workflow"` asset AND deploys it,
  // both through this workflow-run-authenticated surface — `deploy`
  // reaches the exact same `sessionService.deployWorkflowFromSource` the
  // tenant-session `/workflows/deployments` route drives (`workflowDeployer`
  // above), never a second gating path. Unlike `/api/workflow-skills`
  // above, every write here also runs a real `chatGrantStore`
  // authorization check (`asset:*`/create, `asset:<id>`/write,
  // `workflow:*`/create) before reaching `RepoStore` or the deploy call,
  // because authoring and deploying are side effects, not a markdown
  // skill edit.
  app.route(
    "/api/workflow-workflow-authoring",
    createWorkflowAuthorRoutes({
      authenticator: createWorkflowRunAuthenticator({ db }),
      registry: createWorkflowAuthorRegistry({
        db,
        assetService,
        repoStore: agentRepoStore.repoStore,
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
        deployer: workflowDeployer,
      }),
    }),
  );
  // The guided-capability-add fail-closed check reuses the exact same
  // listers `plannerInventorySources` (below) wires — both this provider
  // and the drafting inventory read `InventorySources`/`PlannerInventory`
  // from `@corbits/agent-directory` directly, and the tenant's live
  // inventory of usable tool packages, skills, and models is never
  // assembled twice: both share the same
  // `listMyraUsableToolPackages`/`listMyraModels`/`skills.registry.list`
  // functions (declared further down this file, hoisted).
  const capabilityInventory: CapabilityInventoryProvider = {
    async resolve({ tenantId, principalId }) {
      const [toolPackages, tenantSkills, models] = await Promise.all([
        listMyraUsableToolPackages(tenantId),
        skills.registry.list({ tenantId, principalId }),
        listMyraModels(tenantId),
      ]);
      return {
        toolPackages: toolPackages.map((entry) => ({ name: entry.name })),
        skills: tenantSkills.map((entry) => ({ name: entry.name })),
        models: models.map((entry) => ({
          canonicalName: entry.canonicalName,
        })),
      };
    },
  };

  app.route(
    `${TENANT_PREFIX}/agent-definitions`,
    createAgentDefinitionRoutes({
      db,
      assetService,
      deployer: workflowDeployer,
      skillIndex: skills.skillIndex,
      skillsStore: definitionSkillsStore,
      history: createDefinitionAssetHistory({
        repoStore: agentRepoStore.repoStore,
      }),
      capabilityInventory,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      // A definition created with no `model` still declares one — the
      // same tenant-catalog default a fresh workbench host resolves —
      // rather than staying empty and 409ing `not_launchable` at
      // invite time.
      tenantDefaultModel: async (tenantId) =>
        (await workbenchHostInferencePreferencesResolver(tenantId))[0]?.model,
    }),
  );
  // Myra's own agent-creation surface (`@corbits/agent-directory-tools`'
  // `create_agent`/`list_agents`): the workflow-run-authenticated
  // counterpart to the tenant-session mount just above, self-TENANT
  // scoped (Myra may create an agent anywhere in her own tenant). See
  // `@corbits/agent-directory`'s `workflow-create-routes.ts` for the
  // authorization reasoning.
  app.route(
    "/api/workflow-agent-directory",
    createWorkflowAgentCreateRoutes({
      db,
      assetService,
      deployer: workflowDeployer,
      skillIndex: skills.skillIndex,
      skillsStore: definitionSkillsStore,
      capabilityInventory,
      authenticator: createWorkflowRunAuthenticator({ db }),
      tenantDefaultModel: async (tenantId) =>
        (await workbenchHostInferencePreferencesResolver(tenantId))[0]?.model,
    }),
  );
  // The workflow-run-authenticated variant of the capabilities route
  // just above (CL-6086): a workflow child has no browser session, only
  // its sidecar bearer token and its own run address, so it reaches
  // `POST /:definitionId/capabilities` through this surface instead,
  // mirroring `/api/workflow-skills`/`/api/workflow-memory`. See
  // `@corbits/agent-directory`'s `workflow-capability-routes.ts` for the
  // deliberate, documented authorization decision this route enforces
  // in place of a `requireGrant` check (CL-6085 tracks the durable fix).
  app.route(
    "/api/workflow-capabilities",
    createWorkflowCapabilityRoutes({
      db,
      assetService,
      deployer: workflowDeployer,
      skillIndex: skills.skillIndex,
      skillsStore: definitionSkillsStore,
      capabilityInventory,
      authenticator: createWorkflowRunAuthenticator({ db }),
    }),
  );
  // Myra's own skill-pin surface (`@corbits/skills-tools`' `pin_skill`):
  // self-TENANT scoped (unlike `/api/workflow-capabilities` above, which
  // is self-definition scoped) — Myra may pin a skill onto any
  // definition in her own tenant. See `@corbits/agent-directory`'s
  // `workflow-skill-pin-routes.ts` for the authorization reasoning.
  app.route(
    "/api/workflow-skill-pins",
    createWorkflowSkillPinRoutes({
      db,
      assetService,
      deployer: workflowDeployer,
      skillIndex: skills.skillIndex,
      skillsStore: definitionSkillsStore,
      authenticator: createWorkflowRunAuthenticator({ db }),
    }),
  );
  app.route(
    `${TENANT_PREFIX}/chat`,
    createCommandRoutes({
      registry: commandRegistry,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      workbenchBelongsToTenant: async (tenantId, workbenchId) =>
        (await chatStore.getWorkbenchSettings(tenantId, workbenchId)) !==
          undefined ||
        (await chatStore.hasLaunchedInstance(tenantId, workbenchId)),
    }),
  );

  // Webhook triggers: tenant-scoped management (create/list/rotate/
  // enable/disable/delete) mounts under the tenant prefix like chat,
  // so it inherits session + tenant-membership resolution and grant
  // checks for free. The ingress endpoint that actually receives an
  // external delivery (`POST /api/webhooks/:triggerId`) is mounted
  // separately below, OUTSIDE the tenant prefix — a webhook sender
  // carries no session cookie and is never a tenant member, so it
  // must never pass through `resolveTenant`. Its own tenant scoping
  // comes from the trigger row the id resolves to, and the only trust
  // it is granted comes from the HMAC signature check in
  // `createWebhookIngressRoutes` itself.
  const webhookTriggerStore = createDrizzleWebhookTriggerStore(
    db,
    credentialCipher,
  );
  // CL-7242: the sole concurrency backstop for the GitHub connect
  // card's start-reviewing step -- see
  // packages/webhook-triggers/src/repo-review-lease.ts for why this
  // lives in our own schema rather than as any change to Interchange's
  // `grant` table.
  const repoReviewLeaseStore = createDrizzleRepoReviewLeaseStore(db);
  app.route(
    `${TENANT_PREFIX}/webhook-triggers`,
    createWebhookTriggerRoutes({
      store: webhookTriggerStore,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      workflowDefinitionInTenant: async (tenantId, definitionId) => {
        const row = await db.query.workflowDefinition.findFirst({
          where: and(
            eq(workflowDefinition.id, definitionId),
            eq(workflowDefinition.tenantId, tenantId),
          ),
          columns: { id: true },
        });
        return row !== undefined;
      },
    }),
  );
  app.route(
    "/api/webhooks",
    createWebhookIngressRoutes({
      store: webhookTriggerStore,
      launch: (trigger, payload) =>
        launchWebhookTrigger(
          {
            db,
            sessionService,
            assetService,
            sidecarRouter,
            eventCollectors,
            credentialCipher,
            toolGrantsForPins,
            mcpCredentialBindingsFor,
            pinnedPackageCredentialBindingsFor,
            cryptoProviderCache: cryptoProviders,
            launchMode: AGENT_SECTION_MODE,
            persistLaunch: workbenchLaunchPersistExtra,
            recordLaunchSources: ({ instanceId, sourcesDigest }) =>
              recordSourcesDigest(db, instanceId, sourcesDigest),
          },
          trigger,
          payload,
        ),
    }),
  );
  // A connection completing through ANY door below — OAuth callback,
  // pasted key, MCP OAuth, keyless MCP preset — settles every room
  // waiting on that connector: the room's `connections/pending` entry
  // clears (flipping the in-room connect card via `chat.settings`).
  // Rooms with `connections/pending` still wake the host agent via
  // `dispatchTurn` without a forged signed-in-user timeline row;
  // code-review template rooms are not woken on PAT settle.
  //
  // An inference provider's credential landing also re-checks every
  // live participant's deployed inference chain (CL-6687): a rotated
  // key only ever reaches an agent at deploy time, so the relaunch has
  // to be kicked here, not left for the next message. A tool-package
  // connector (`feedsTools`, e.g. Manus) is the same shape for a
  // different payload: `pinnedPackageCredentialBindingsFor` only folds
  // at deploy, so a live Myra launched at signup before the key was
  // pasted stays on a snapshot that cannot `resolve("manus")` until
  // this pass relaunches it. Not awaited — a relaunch is a sidecar
  // deploy round-trip, and the connect response must not wait on it.
  const settleServiceConnection: ServiceConnectedHook = async (info) => {
    await settleConnectedService(
      {
        store: chatStore,
        platform: chatPlatform,
        roomMessages,
        publish: workbenchSubscribers.publish,
        agentTurns,
      },
      {
        tenantId: info.tenantId,
        principalId: info.principalId,
        connectorId: info.connectorId,
        displayName: info.displayName,
      },
    );
    if (isInferenceProvider(info.connectorId)) {
      void chatPlatform
        .reconcileInferenceSources(info.tenantId)
        .then(({ scanned, relaunched }) => {
          log.info`inference credential ${info.connectorId} changed on tenant ${info.tenantId}: re-checked ${String(scanned)} live agents, relaunched ${String(relaunched)}`;
        })
        .catch((cause: unknown) => {
          reportError(cause, {
            operation: "connections.reconcile-inference-sources",
            tenantId: info.tenantId,
          });
        });
    }
    void reconcilePinnedToolPackagesAfterConnect(chatPlatform, info)
      .then((result) => {
        if (result === undefined) return;
        log.info`tool-package connector ${info.connectorId} changed on tenant ${info.tenantId}: re-checked ${String(result.scanned)} live agents, relaunched ${String(result.relaunched)}`;
      })
      .catch((cause: unknown) => {
        reportError(cause, {
          operation: "connections.reconcile-pinned-tool-packages",
          tenantId: info.tenantId,
        });
      });
  };
  // Connections: the settings surface's tenant-scoped credential
  // test-and-store, mounted under the same tenant prefix and reusing
  // the same grant store/condition registry every other credential-
  // adjacent extension route does.
  app.route(
    `${TENANT_PREFIX}/connections`,
    createConnectionRoutes({
      hubUrl: config.baseUrl,
      registry: CONNECTOR_REGISTRY,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      log: (line) => log.info`${line}`,
      // Same env bag the OAuth connect flow itself reads below, so
      // `GET .../oauth-configured` reports exactly what a Connect click
      // would decide.
      oauthEnv: {
        huggingfaceClientId: config.huggingfaceOAuthClientId,
        githubAppClientId: config.githubAppClientId,
        githubAppClientSecret: config.githubAppClientSecret,
        gmailClientId: config.gmailClientId,
        gmailClientSecret: config.gmailClientSecret,
      },
      providerHealth: providerHealthStore,
      listConnectedProviders: (tenantId) =>
        listConnectedProviders(db, tenantId),
      // CL-6403: an operator-set GITHUB_API_BASE_URL lets a fake server
      // stand in for api.github.com for the `github` connector's PAT
      // probe and stored provider origin; unset in every real deployment,
      // so `probeBaseUrls` is empty and every connector probes its own
      // fixed production origin.
      probeBaseUrls:
        config.githubApiBaseUrl !== undefined
          ? { github: config.githubApiBaseUrl }
          : {},
      onConnected: settleServiceConnection,
      // CL-6568's other half: a tenant whose only provider is one it
      // connected itself through Settings — never an operator-configured
      // hub key — must converge on Myra and the default workflow set the
      // same way an onboarding-connected one does. `pendingSeedStore` and
      // `benchProvisioner` are declared further down this function, but
      // this closure only runs on a future request, well after both are
      // constructed below — the same forward-reference this file already
      // relies on for `onboardingDeps`.
      onInferenceCredentialUsable: async (info) => {
        const provider = supportedCredentialProviders().find(
          (candidate) => candidate.id === info.provider,
        )?.id;
        if (provider === undefined) {
          log.error`onInferenceCredentialUsable fired for an unsupported provider ${info.provider} on tenant ${info.tenantId}; skipping the pending-seed row`;
          return;
        }
        await pendingSeedStore.put({
          userId: info.userId,
          tenantId: info.tenantId,
          principalId: info.principalId,
          tenantDomain: info.tenantDomain,
          provider,
          apiKey: info.apiKey,
          ...(info.baseURLOverride !== undefined
            ? { baseURLOverride: info.baseURLOverride }
            : {}),
        });
        benchProvisioner.wake();
      },
    }),
  );
  // Connections' own OAuth connect flow (CL-6389): `createOAuthConnectRoutes`
  // (`@corbits/connections`) was exported but never mounted here — every
  // provider whose descriptor sets `oauth` (OpenRouter, Hugging Face, and
  // the GitHub App path) needs this to complete a one-click connect from
  // the settings surface above. Follows #115's `mcp-servers/oauth` mount
  // just below: state-param CSRF (real `state()` + exact-match callback
  // validation) lives entirely inside the factory; this mount only wires
  // the tenant already resolved by the platform's tenant middleware
  // through to `createTenantConnectCredential`.
  app.route(
    `${TENANT_PREFIX}/connections/oauth`,
    createOAuthConnectRoutes<TenantEnv>({
      hubUrl: config.baseUrl,
      log: (line) => log.info`${line}`,
      credentialCipher,
      registry: CONNECTOR_REGISTRY,
      // Same env bag `GET .../connections/oauth-configured` reads above.
      oauthEnv: {
        huggingfaceClientId: config.huggingfaceOAuthClientId,
        githubAppClientId: config.githubAppClientId,
        githubAppClientSecret: config.githubAppClientSecret,
        gmailClientId: config.gmailClientId,
        gmailClientSecret: config.gmailClientSecret,
      },
      connectCredential: createTenantConnectCredential({
        hubUrl: config.baseUrl,
        log: (line) => log.info`${line}`,
        registry: CONNECTOR_REGISTRY,
        providerHealth: providerHealthStore,
      }),
      onConnected: settleServiceConnection,
      defaultReturnPath: "/settings/connections",
      // `/w/` is the workbench room prefix: the in-room connect card
      // (CL-6393) starts OAuth from a room and must land back in it.
      returnPathAllowlist: [
        ...DEFAULT_RETURN_PATH_ALLOWLIST,
        "/plugins",
        "/w/",
      ],
    }),
  );
  // GitHub connect card (CL-6344): the code-review template's inline
  // room card reads its live state and starts reviews through here.
  // Connecting the PAT itself stays on `connections` above (`github` is
  // already registered in `CONNECTOR_REGISTRY`) — this route only owns
  // what needs the decrypted secret, the live repo list, and a real
  // grant/webhook-trigger/settings write.
  //
  // CL-6463: the credential row this card reads must be named by the
  // exact same `displayName` `persistConnectorCredential` (`@workbench
  // /connections`) stores it under for the `github` connector — a second,
  // hardcoded "GitHub" literal here silently drifts the moment either side
  // changes, which is exactly what left this card stuck disconnected after
  // a successful PAT submit. Reading the descriptor's own field instead of
  // repeating the literal makes that impossible.
  const githubConnectorDescriptor = CONNECTOR_REGISTRY["github"];
  if (githubConnectorDescriptor === undefined) {
    throw new Error(
      'CONNECTOR_REGISTRY has no "github" entry — the room GitHub connect card has nothing to read a credential name from',
    );
  }
  app.route(
    `${TENANT_PREFIX}/workbenches`,
    createConnectGithubRoutes({
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      log: (line) => log.info`${line}`,
      resolveGithubConfig: async (tenantId) => {
        const row = await resolveCredentialByName(
          db,
          tenantId,
          githubConnectorDescriptor.displayName,
        );
        if (row === null) return undefined;
        const apiKey = await credentialCipher.decrypt(
          row.secret,
          credentialAad(row.id, "secret"),
        );
        return config.githubApiBaseUrl !== undefined
          ? { apiKey, baseUrl: config.githubApiBaseUrl }
          : { apiKey };
      },
      resolveCodeReviewDefinitionId: async (tenantId) => {
        const row = await db.query.workflowDefinition.findFirst({
          where: and(
            eq(workflowDefinition.tenantId, tenantId),
            eq(workflowDefinition.name, "code-review"),
            eq(workflowDefinition.status, "deployed"),
          ),
          columns: { id: true },
        });
        return row?.id;
      },
      acquireRepoReviewLease: (tenantId, repo) =>
        repoReviewLeaseStore.acquire(tenantId, repo.name),
      releaseRepoReviewLease: (tenantId, repo) =>
        repoReviewLeaseStore.release(tenantId, repo.name),
      // hasRepoGrant/mintRepoGrant go through Interchange's native
      // grants HTTP surface (never a direct `grant` table write --
      // see native-repo-grants.ts). That table carries no unique
      // constraint over tenant/resource/action, so a bare read-then-
      // POST here would itself be a duplicate-grant race; safe only
      // because the caller in connect-github-routes.ts reaches this
      // once `acquireRepoReviewLease` has already made this call-site
      // single-flight per (tenant, repo) -- see
      // packages/webhook-triggers/src/repo-review-lease.ts (CL-7242).
      hasRepoGrant: (tenantId, repo, cookies) =>
        hasRepoGrantViaHttp(selfApi, tenantId, repo, cookies),
      mintRepoGrant: (tenantId, repo, cookies) =>
        mintRepoGrantViaHttp(selfApi, tenantId, repo, cookies),
      createWebhookTrigger: async (
        tenantId,
        principalId,
        codeReviewDefinitionId,
        repo,
      ) => {
        // `ensure`, not `create`: a concurrent "start reviewing" call
        // for the same repo can race this one past `hasWebhookTrigger`
        // above, and `webhook_trigger_tenant_definition_name_unique`
        // (packages/webhook-triggers migration 0003, CL-7242) is what
        // actually resolves that — the loser gets the winner's real
        // row back instead of minting a second live trigger with a
        // different secret.
        const row = await webhookTriggerStore.ensure({
          id: generateId("workflowRun"),
          tenantId,
          name: webhookTriggerName(repo),
          workflowDefinitionId: codeReviewDefinitionId,
          inputTemplate: `Review the pull request at {{pull_request.html_url}}`,
          secret: generateWebhookSecret(),
          createdBy: principalId,
        });
        return { id: row.id };
      },
      hasWebhookTrigger: async (tenantId, codeReviewDefinitionId, repo) => {
        const triggers = await webhookTriggerStore.list(tenantId);
        const triggerName = webhookTriggerName(repo);
        return triggers.some(
          (trigger) =>
            trigger.workflowDefinitionId === codeReviewDefinitionId &&
            trigger.name === triggerName,
        );
      },
      getTemplateSettings: async (tenantId, workbenchId) => {
        const row = await chatStore.getWorkbenchSettings(tenantId, workbenchId);
        const settings = row?.settings ?? {};
        const pendingConnections = settings["template/pendingConnections"];
        const selectedRepos = settings["template/selectedRepos"];
        return {
          pendingConnections: Array.isArray(pendingConnections)
            ? (pendingConnections as string[])
            : [],
          selectedRepos: Array.isArray(selectedRepos)
            ? (selectedRepos as string[])
            : [],
        };
      },
      persistSelectedRepos: async (
        tenantId,
        workbenchId,
        principalId,
        patch,
      ) => {
        const existing = await chatStore.getWorkbenchSettings(
          tenantId,
          workbenchId,
        );
        const row = await chatStore.updateWorkbenchSettings({
          tenantId,
          workbenchId,
          settings: { ...(existing?.settings ?? {}), ...patch },
          updatedBy: principalId,
        });
        workbenchSubscribers.publish(workbenchId, {
          type: "chat.settings",
          data: { updatedBy: principalId, settings: row.settings },
        });
      },
      onReviewingStarted: async (
        tenantId,
        workbenchId,
        _principalId,
        introductions,
      ) => {
        const row = await chatStore.getWorkbenchSettings(tenantId, workbenchId);
        const participants = parseParticipants(
          row?.settings["chat/participants"],
        );
        for (const introduction of introductions) {
          const participant = participants.find(
            (candidate) => candidate.handle === introduction.handle,
          );
          if (participant === undefined) continue;
          await postRoomMessage(
            { roomMessages, publish: workbenchSubscribers.publish },
            {
              tenantId,
              workbenchId,
              sender: { name: null, address: participant.address },
              runId: localPartOf(participant.address),
              parts: [{ kind: "text", text: introduction.text }],
            },
          );
        }
      },
    }),
  );
  // Template block workflows (CL-6405, cut over to native deploy in
  // CL-7364): the instantiate path's `deployBlockWorkflow` port lands
  // here — the same source-form materialization pattern (asset +
  // `@corbits/workflows`'s `./source` tree) applied to a template's referenced
  // block definition (`code-review` today), now deployed through the
  // same `workflowDeployer` the agent-authored deploy path above uses
  // rather than a hub-local inert freeze.
  app.route(
    `${TENANT_PREFIX}/template-blocks`,
    createTemplateBlockRoutes({
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      log: (line) => log.info`${line}`,
      inferencePreferences: (tenantId) =>
        workbenchHostInferencePreferencesResolver(tenantId),
      deployWorkflowSource: async ({
        tenantId,
        principalId,
        assetName,
        displayName,
        workflowJson,
      }) => {
        const existing = await db.query.workflowDefinition.findFirst({
          where: and(
            eq(workflowDefinition.tenantId, tenantId),
            eq(workflowDefinition.name, assetName),
            eq(workflowDefinition.status, "deployed"),
          ),
          columns: { id: true },
        });
        if (existing !== undefined) {
          return { id: existing.id, created: false };
        }

        // A prior attempt may have created the asset but died before the
        // definition projected — reuse the shell instead of 409ing the
        // retry, the same recovery `createAgentDefinitionCore` documents.
        let assetId: string;
        try {
          const created = await assetService.createAsset({
            tenantId,
            kind: "workflow",
            name: assetName,
            displayName,
            creatorPrincipalId: principalId,
          });
          assetId = created.id;
        } catch (cause) {
          const shell = await db.query.asset.findFirst({
            where: and(
              eq(assetTable.tenantId, tenantId),
              eq(assetTable.kind, "workflow"),
              eq(assetTable.name, assetName),
            ),
            columns: { id: true },
          });
          if (shell === undefined) throw cause;
          assetId = shell.id;
        }

        const { commitSha } = await assetService.populateAsset({
          assetId,
          ref: DEFAULT_ASSET_REF,
          principal: { kind: "hub" },
          tree: {
            files: renderWorkflowSourceTree({
              packageName: `@workbench-template/${assetName}`,
              workflowJson,
            }),
            message: `Deploy template block ${assetName}`,
          },
        });

        // Native deploy, not a hub-local inert freeze (CL-7364): the same
        // `workflowDeployer` the agent-authored deploy path above drives,
        // so a template block's definition goes through the real
        // bundle → sidecar probe → capability walk → gate → freeze
        // pipeline instead of a hub-side shortcut.
        const result = await workflowDeployer.deploy({
          tenantId,
          principalId,
          assetId,
          assetName,
          commitSha,
          entry: WORKFLOW_SOURCE_ENTRY,
        });
        return { id: result.definitionAssetId, created: true };
      },
    }),
  );
  // MCP servers: the tenant-scoped connect/list/disconnect surface
  // Plugins drives (CL-6142), mirroring `connections` above but for
  // tenant-minted `mcp:<slug>` connectors rather than
  // `CONNECTOR_REGISTRY`'s fixed set.
  app.route(
    `${TENANT_PREFIX}/mcp-servers`,
    createMcpServerRoutes({
      hubUrl: config.baseUrl,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      log: (line) => log.info`${line}`,
      presets: MCP_PRESETS,
      onConnected: settleServiceConnection,
    }),
  );
  // MCP servers' OAuth connect flow (CL-6152): discovers and drives a
  // preset's (or an ad hoc `?url=&name=`) authorization server per the
  // MCP spec, landing back on the same `mcp:<slug>` credential storage
  // `createMcpServerRoutes` above uses for a pasted token.
  app.route(
    `${TENANT_PREFIX}/mcp-servers/oauth`,
    createMcpOAuthRoutes({
      hubUrl: config.baseUrl,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      log: (line) => log.info`${line}`,
      credentialCipher,
      presets: MCP_PRESETS,
      onConnected: settleServiceConnection,
      // `/w/` for the same reason as the connections/oauth mount above.
      returnPathAllowlist: [
        ...DEFAULT_RETURN_PATH_ALLOWLIST,
        "/plugins",
        "/w/",
      ],
    }),
  );
  // Myra's own connections-visibility surface
  // (`@corbits/connections-tools`' `list_connections`/
  // `request_connection`): the workflow-run-authenticated counterpart
  // to the tenant-session mount just above.
  app.route(
    "/api/workflow-connections",
    createWorkflowConnectionRoutes({
      authenticator: createWorkflowRunAuthenticator({ db }),
      registry: CONNECTOR_REGISTRY,
      // Same `isConnectorConnected` the pinned-package factory is wired
      // with above (CL-6492).
      isConnectorConnected,
      listMcpServers: (tenantId) => listMcpServerConnections(db, tenantId),
    }),
  );
  // How a running agent asks what this bench can reach for a kind of work
  // (`@corbits/catalog-tools`' `list_model_concepts` / `pick_models` /
  // `estimate_run_cost`): the workflow-run-authenticated counterpart to
  // the tenant-session bench-model-policy mount above. Read-only, and it
  // takes ports rather than a db handle, so the package never learns the
  // catalog schema.
  app.route(
    "/api/workflow-inference-catalog",
    createWorkflowCatalogRoutes({
      authenticator: createWorkflowRunAuthenticator({ db }),
      listOfferings: (tenantId) => listVisibleOfferings(db, tenantId),
      listPricing: async (_tenantId, offeringIds) =>
        offeringIds.length === 0
          ? []
          : await db.query.modelPricing.findMany({
              where: inArray(modelPricing.offeringId, [...offeringIds]),
            }),
      getPolicy: (tenantId) => benchModelPolicy.store.getPolicy(tenantId),
    }),
  );
  // Notify-to-reconnect for an OAuth-connected credential whose token
  // expired (Hugging Face today — see docs/onboarding-huggingface-connect.md):
  // a light periodic sweep over `@corbits/notify`'s pure
  // `findDueCredentialExpiries`, mailing through the same delivery
  // adapter above. `createInMemoryNotifyDispatchStore`/`createSinkRegistry()`
  // mean external sink fan-out (Slack, email) is a no-op until a sink is
  // registered — the mailbox row itself is what a person sees in their
  // inbox. Requires `@corbits/mailbox`'s and `@corbits/notify`'s own
  // migrations applied against `DATABASE_URL`, same as any other
  // consumer of this delivery adapter.
  const notifyHost = new URL(config.baseUrl).host;
  const credentialExpirySweep = createCredentialExpirySweep({
    store: createDrizzleCredentialExpirySweepStore(
      db,
      credentialCipher,
      sidecarRouter,
    ),
    hubUrl: config.baseUrl,
    notify: {
      mail: mailboxDelivery,
      addressing: {
        inbox: (recipient) => `${recipient.principalId}@inbox.${notifyHost}`,
        from: (kind) => `${kind}@notify.${notifyHost}`,
      },
      dispatch: createInMemoryNotifyDispatchStore(),
      sinks: createSinkRegistry(),
    },
  });

  // Reopen a snoozed inbox item once its `until` has passed (CL-7208) — a
  // light periodic sweep over `@corbits/inbox`'s own snooze table, on the
  // same mailboxDb/mailboxBus every other mailbox consumer here shares.
  const inboxUnsnoozeSweep = createInboxUnsnoozeSweep({
    store: createDrizzleInboxUnsnoozeSweepStore(mailboxDb),
    bus: mailboxBus,
  });

  // Shared `FoldedRunsDeps` for every one-shot Myra prompt below
  // (agent-definition drafting): a real one-shot inference call
  // that launches a folded run, awaits its single reply, and tears the run
  // down immediately — never a resident that outlives the request, so no
  // idle-sleep lifecycle is needed for it.
  const oneShotFoldedRunsDeps = {
    db,
    sessionService,
    assetService,
    sidecarRouter,
    eventCollectors,
    credentialCipher,
    hubPublicKey,
    toolGrantsForPins,
    mcpCredentialBindingsFor,
    pinnedPackageCredentialBindingsFor,
  };

  // Every genuine top-level deployment run, folded runs (workbench hosts,
  // invited agents) excluded — the scoped listing CL-6061 adds
  // so the Agent Directory and the shell's "Running" bands stop
  // deriving that exclusion client-side from a tenant's workbenches alone
  // (see `@corbits/folded-runs`'s `scope-routes.ts`, which a folded run
  // with no workbench involved silently slipped past).
  app.route(
    `${TENANT_PREFIX}/top-level-runs`,
    createTopLevelRunRoutes({
      db,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
    }),
  );

  // Recurring auto-fire: `workflow-scheduler.ts` ticks authored, deployed
  // definitions whose frozen projection carries a native ScheduleTrigger.
  // This hub has no general job-runner today, so the loop is scoped to
  // exactly that job rather than standing up a bespoke cron daemon as a
  // hidden dependency. Every hub replica can safely run it: each native
  // fire is claimed on `workflow_definition.schedule_claimed_minute`.
  const workflowScheduler = createWorkflowScheduler({
    listScheduledDefinitions: listScheduledDefinitionsFromDb(db),
    claimScheduleMinute: claimScheduleMinuteFromDb(db),
    launch: launchScheduledDefinitionFromDb({
      db,
      sidecarRouter,
      ...scheduledDeliveryJoinDeps,
    }),
    ...(config.routineSchedulerPollIntervalMs !== undefined
      ? { pollIntervalMs: config.routineSchedulerPollIntervalMs }
      : {}),
  });

  // The inventory Myra is offered when drafting a new agent definition
  // (`plannerInventorySources` below, `@corbits/agent-directory`'s own
  // `InventorySources` seam). Every inventory lister below generalizes a
  // pattern that already lives elsewhere in this composition root
  // (`isConversationalAgentDefinition`, `workbenchHostInferencePreferencesResolver`'s
  // per-tenant connected-provider derivation) — this package owns the
  // inventory's shape, never the listing logic.
  const memoryToolPackageName = "@corbits/memory-tools";
  // `@corbits/capability-tools` (CL-6084/CL-6086)'s `request_capability`
  // tool needs no per-tenant credential either, like memory-tools: the
  // sidecar now threads its own `definitionId` into a step's tool env
  // (`apps/sidecar/src/workflow-substrate-factory/step-env.ts`), and
  // `/api/workflow-capabilities` (mounted below) gives it a
  // workflow-run-authenticated path to the capabilities route the same
  // way `/api/workflow-skills` and `/api/workflow-memory` do. Both gaps
  // that used to keep it out of this lister are closed.
  const capabilityToolPackageName = "@corbits/capability-tools";

  async function listMyraConversationalAgents(
    tenantId: string,
  ): Promise<readonly InventoryAgent[]> {
    const rows = await db.query.workflowDefinition.findMany({
      where: and(
        eq(workflowDefinition.tenantId, tenantId),
        eq(workflowDefinition.status, "deployed"),
      ),
    });
    return rows
      .filter((row) => isPickerListableDefinition(row))
      .map((row) => {
        const agent = {
          id: row.id,
          name: row.name,
          displayName: workflowDisplayName(row.name, row.description),
        };
        if (row.description !== null) {
          return { ...agent, description: row.description };
        }
        return agent;
      });
  }

  async function listMyraUsableToolPackages(
    tenantId: string,
  ): Promise<readonly InventoryToolPackage[]> {
    const connectedConnectorIds = await listConnectedProviders(db, tenantId);
    const entries: InventoryToolPackage[] = [];
    for (const connectorId of connectedConnectorIds) {
      const descriptor = CONNECTOR_REGISTRY[connectorId];
      if (descriptor === undefined) continue;
      for (const toolPackageName of descriptor.feedsTools) {
        // This listing is already scoped to connections registry ∩
        // tenant credentials that exist (`listConnectedProviders`), so
        // every entry it returns necessarily has a live credential —
        // the binding mirrors `workflows/granola-call`'s
        // `GRANOLA_CALL_CREDENTIAL_BINDINGS` exactly: `handle`/`provider`
        // both equal the connector id.
        entries.push({
          name: toolPackageName,
          connectorId: descriptor.id,
          credentialBinding: {
            package: toolPackageName,
            handle: descriptor.id,
            provider: descriptor.id,
            locator: "tenant",
          },
        });
      }
    }
    if (memoryHandle !== undefined) {
      entries.push({
        name: memoryToolPackageName,
        connectorId: "memory",
        credentialBinding: null,
      });
    }
    entries.push({
      name: capabilityToolPackageName,
      connectorId: "capability",
      credentialBinding: null,
    });
    // MCP tools are fed by MCP server connections, not by the classic
    // connector registry above — without this the inventory rejects
    // `@corbits/mcp-tools` on a bench with live MCP servers, so created
    // specialists cannot search (CL-6206's live 400). Credential
    // bindings for this package come from `mcpCredentialBindingsFor`
    // at launch, never from an inventory row.
    const mcpServers = await listMcpServerConnections(db, tenantId);
    if (mcpServers.length > 0) {
      entries.push({
        name: "@corbits/mcp-tools",
        connectorId: "mcp",
        credentialBinding: null,
      });
    }
    // The ask_user interaction card needs no credential at all — it is
    // always offerable, exactly like capability-tools.
    entries.push({
      name: "@corbits/interaction-tools",
      connectorId: "interaction",
      credentialBinding: null,
    });
    // Workflow-source authoring needs no credential either: every write is
    // authorized against the run's own asset grants by
    // `/api/workflow-workflow-authoring` (mounted above).
    entries.push({
      name: "@corbits/workflow-authoring-tools",
      connectorId: "workflow-authoring",
      credentialBinding: null,
    });
    return entries;
  }

  async function listMyraModels(
    tenantId: string,
  ): Promise<readonly InventoryModel[]> {
    const rows = await db.query.model.findMany({
      where: and(eq(model.tenantId, tenantId), eq(model.disabled, false)),
    });
    return rows.map((row) => {
      const entry = { canonicalName: row.canonicalName };
      if (row.displayName !== null) {
        return { ...entry, displayName: row.displayName };
      }
      return entry;
    });
  }

  const plannerInventorySources: InventorySources = {
    listConversationalAgents: listMyraConversationalAgents,
    listUsableToolPackages: listMyraUsableToolPackages,
    listSkills: (caller) => skills.registry.list(caller),
    memoryAvailable: memoryHandle !== undefined,
    listModels: listMyraModels,
  };

  // The create-agent panel's "Describe" step (CL-6074): a real one-shot
  // Myra call that proposes a starting system prompt/tool pins/skills
  // from a name + plain-language purpose, offering her the same
  // inventory `capabilityInventory` above reads through. Never deploys
  // on its own — the panel submits the validated draft through the
  // ordinary create-agent-definition path once the person confirms.
  // Failure copy is the package route's `makeErrorEnvelope` +
  // `reportError` (CL-6749), not a local `{ code, message }` body.
  const plannerRoutes = createAgentDefinitionDraftRoutes({
    requireGrant: createRequireGrant({
      grantStore: chatGrantStore,
      conditionRegistry: chatConditionRegistry,
    }),
    draftAgentDefinition: (input) =>
      createMyraAgentDefinitionDrafting({
        resolveMyraDefinitionId: (tenantId) =>
          resolveMyraDefinitionIdFromDb(db, tenantId),
        runner: {
          run: (runnerInput) =>
            runOneShotFoldedPrompt(
              {
                foldedRuns: oneShotFoldedRunsDeps,
                events: sidecarRouter.events,
                cryptoProviders,
                undeploy: (address, reason) =>
                  sidecarRouter.sendAgentUndeploy(address, reason),
              },
              runnerInput,
            ),
        },
        inventorySources: plannerInventorySources,
      }).propose(input),
  });
  app.route(`${TENANT_PREFIX}/planner`, plannerRoutes);

  // The sanctioned path for a workflow run to reach the memory plane
  // (CL-5852), mirroring `/api/workflow-artifacts` immediately above:
  // mounted OUTSIDE `TENANT_PREFIX` since a workflow-process child has
  // no browser session, every request authenticates via the same
  // `WorkflowRunAuthenticator` (sidecar bearer token + run address)
  // against this hub's own control-plane `db`. Serves through
  // `memoryHandle.memory` — the SAME in-process plane instance
  // `mountMemory` mounted above, never a second connection.
  if (memoryHandle !== undefined) {
    app.route(
      "/api/workflow-memory",
      createWorkflowMemoryRoutes({
        authenticator: createWorkflowRunAuthenticator({ db }),
        store: createWorkflowMemoryStore(memoryHandle.memory),
      }),
    );
  } else {
    app.route("/api/workflow-memory", createUnavailableWorkflowMemoryRoutes());
  }

  // Closed-by-default access policy: a per-tenant policy row layered
  // over native tenancy/RBAC (see `@workbench/access-policy`). Migrated
  // at hub start like insights/preferences/bench-settings; mounted
  // tenant-scoped for the settings panel, and threaded into the
  // onboarding hook below so first-login provisioning honors it without
  // patching any vendor route.
  await applyAccessPolicyMigrations(config.databaseUrl);
  const accessPolicyStore = createDrizzleAccessPolicyStore(db);
  app.route(
    `${TENANT_PREFIX}/access-policy`,
    createAccessPolicyRoutes({
      store: accessPolicyStore,
      requireGrant: createRequireGrant({
        grantStore: chatGrantStore,
        conditionRegistry: chatConditionRegistry,
      }),
      api: selfApi,
    }),
  );

  // The first-login hook mounts outside the tenant prefix, since the
  // session it serves belongs to no tenant yet. The route is
  // `@workbench/onboarding`'s; what it decides is documented in that
  // package's provision.ts.
  // Connecting a provider deploys nothing (CL-6457): the onboarding
  // routes persist the credential and hand the workflow deploys to this
  // drain, which converges every bench with a pending row — including
  // one a previous process died halfway through, since the row itself is
  // the durable work item.
  const pendingSeedStore = createDrizzlePendingSeedStore(db, credentialCipher);
  const benchProvisioner = createBenchProvisioner({
    api: selfApi,
    hubUrl: config.baseUrl,
    store: pendingSeedStore,
    pushWorkflow: createGitWorkflowPusher(),
    sessionFor,
    log: (line) => log.info`${line}`,
    logError: (line) => log.error`${line}`,
    publishToolRegistryFn: publishCorbitsToolsRegistry,
  });
  benchProvisioner.start();

  const onboardingDeps: Parameters<typeof createOnboardingRoutes>[0] = {
    hubUrl: config.baseUrl,
    pushWorkflow: createGitWorkflowPusher(),
    log: (line) => log.info`${line}`,
    logError: (line) => log.error`${line}`,
    credentialCipher,
    pendingSeedStore,
    benchProvisioner,
    accessPolicy: {
      store: accessPolicyStore,
      envSignupMode: config.signupMode,
      envAllowedDomains: config.allowedEmailDomains,
      allowUnverifiedEmails: config.allowUnverifiedEmails,
    },
    // Same provider-health store `@corbits/connections`' own routes
    // report to and clear (CL-6092) — a successful `/complete` here must
    // clear the same record the shell banner's zero-provider "Fix it"
    // routed someone to onboarding to fix.
    providerHealth: providerHealthStore,
  };
  onboardingDeps.operatorTenantId = operatorTenantId;
  if (config.seedModel !== undefined)
    onboardingDeps.seedModel = config.seedModel;
  if (config.huggingfaceOAuthClientId !== undefined)
    onboardingDeps.huggingfaceClientId = config.huggingfaceOAuthClientId;

  app.route("/api/onboarding", createOnboardingRoutes(onboardingDeps));

  // Artifacts engine: mounts `@corbits/artifacts` against the same
  // Postgres cluster as this hub's control plane (its
  // `artifact`/`artifact_version` tables FK into `public.tenant` /
  // `public.principal`). Uses DATABASE_URL — the same URL as everything
  // else — so local `bun run dev` mounts Library with no extra env var.
  // When it's unset (or mount fails), degrades to 503 routes. When
  // mounted, tenant-scoped list + get + upload routes serve Library
  // under `/artifacts`.
  //
  // The mount runs migrations against the configured DB; if the URL is
  // present but points at an unreachable/invalid cluster the migration
  // would otherwise throw and take the whole hub down at boot. We catch
  // that here so the hub comes up in a degraded (no-artifacts) mode and
  // surfaces the failure as a warning rather than a crash.
  let artifactsHandle: Awaited<ReturnType<typeof mountArtifacts>>;
  try {
    artifactsHandle = await mountArtifacts();
  } catch (error) {
    log.warn(
      `Artifacts mount failed — continuing without artifacts persistence: ${error}`,
    );
    artifactsHandle = undefined;
  }
  if (artifactsHandle !== undefined) {
    app.route(
      `${TENANT_PREFIX}/artifacts`,
      createArtifactRoutes({
        store: createArtifactDbStore(
          artifactsHandle.db,
          artifactsHandle.contentStore,
        ),
        requireGrant: createRequireGrant({
          grantStore: chatGrantStore,
          conditionRegistry: chatConditionRegistry,
        }),
      }),
    );

    // The bench library's template shelf (CL-6344): what the
    // new-workbench picker instantiates from — seeded rows, never a
    // hardcoded import. Reading the shelf is what seeds it (CL-6458), so
    // a bench created at any point after boot carries the shipped
    // manifests the first time its picker opens.
    app.route(
      `${TENANT_PREFIX}/library/templates`,
      createTemplateLibraryRoutes({
        store: createTemplateLibraryDbStore(artifactsHandle.db),
        seeder: createTemplateLibrarySeeder({
          db: artifactsHandle.db,
          entries: workbenchTemplateLibraryEntries(),
          log: (line) => log.info`${line}`,
        }),
        requireGrant: createRequireGrant({
          grantStore: chatGrantStore,
          conditionRegistry: chatConditionRegistry,
        }),
        log: (line) => log.error`${line}`,
      }),
    );

    // Co-editing persistence (CL-5958 phase 2): debounced snapshots of a
    // presence room's Y.Text into a real artifact version, layered on top
    // of the presence registry mounted above without changing its own
    // "ephemeral, no storage" default. `writeArtifactVersion`/`getArtifact`
    // are the engine's own versioned-row seam — the same one a workflow's
    // artifact revision goes through — so a co-edited text artifact's
    // history reads identically to any other revision. `anonymousIdentity`
    // is not used here: `writeArtifactVersion` only needs a `{tenantId,
    // principalId}` scope, not a resolved `Identity`.
    const artifactDb = artifactsHandle.db;
    const artifactPersistence = createArtifactDocPersistence({
      registry: presenceRoomRegistry,
      loadArtifactContent: async (tenantId, artifactId) => {
        const row = await getArtifact(artifactDb, artifactId);
        if (row === null || row.tenantId !== tenantId) return null;
        return row.content;
      },
      writeArtifactSnapshot: async (
        tenantId,
        artifactId,
        authorPrincipalId,
        content,
      ) => {
        const written = await writeArtifactVersion(artifactDb, {
          scope: { tenantId, principalId: authorPrincipalId },
          artifactId,
          content,
        });
        return { version: written.version };
      },
      onSnapshotError: (key, error) => {
        log.warn(
          `Co-editing snapshot failed for ${key.tenantId}/${key.surface}: ${error}`,
        );
      },
    });
    artifactSeedOnJoin = artifactPersistence.seedOnJoin;
  } else {
    log.info("Artifacts handle unavailable (degraded mode)");
    app.route(
      `${TENANT_PREFIX}/artifacts`,
      createUnavailableArtifactRoutes(
        createRequireGrant({
          grantStore: chatGrantStore,
          conditionRegistry: chatConditionRegistry,
        }),
      ),
    );
    app.route(
      `${TENANT_PREFIX}/library/templates`,
      createUnavailableTemplateLibraryRoutes(
        createRequireGrant({
          grantStore: chatGrantStore,
          conditionRegistry: chatConditionRegistry,
        }),
      ),
    );
  }

  // The sanctioned path for a workflow run to persist and read Library
  // artifacts (CL-6000): mounted OUTSIDE `TENANT_PREFIX` since a
  // workflow-process child has no browser session — every request here
  // authenticates via `createWorkflowRunAuthenticator` (the sidecar's own
  // bearer token plus the run's own address) against this hub's own
  // control-plane `db`, never the artifacts engine's db.
  if (artifactsHandle !== undefined) {
    app.route(
      "/api/workflow-artifacts",
      createWorkflowArtifactRoutes({
        authenticator: createWorkflowRunAuthenticator({ db }),
        store: createWorkflowArtifactDbStore(
          artifactsHandle.db,
          artifactsHandle.contentStore,
        ),
      }),
    );
  } else {
    app.route(
      "/api/workflow-artifacts",
      createUnavailableWorkflowArtifactRoutes(),
    );
  }

  // Tells the signed-out screen which OAuth buttons to draw, without
  // exposing the credentials themselves — just which providers a full
  // pair was configured for. No session or tenant is required to ask,
  // since this decides what the sign-in screen even offers.
  const enabledSocialProviders = Object.keys(config.socialProviders);
  app.get("/api/auth-config", (c) =>
    c.json({
      socialProviders: enabledSocialProviders,
      signupMode: config.signupMode,
      allowedEmailDomains: config.allowedEmailDomains,
    }),
  );

  app.get("/*", createStaticHandler(path.resolve(config.hubStaticDir)));

  // [Intx gap] CL-6041: the native POST /api/tenants route is ungated —
  // wrap the fully-built app in a guard that enforces
  // @workbench/access-policy in front of it. See
  // ./tenant-create-guard.ts's module comment for why this has to be an
  // outer wrap rather than an `app.use()` added here: the native route
  // is already registered by the time `createApp()` returns above, and
  // Hono composes handlers in registration order.
  const guardDeps: Parameters<typeof guardedHubApp>[1] = {
    store: accessPolicyStore,
    resolveCallerRoleNames: (tenantId, userId) =>
      resolveCallerRoleNames(db, tenantId, userId),
    envSignupMode: config.signupMode,
    envAllowedDomains: config.allowedEmailDomains,
    allowUnverifiedEmails: config.allowUnverifiedEmails,
    getSessionUser: async (headers) => {
      const result = await auth.api.getSession({ headers });
      return result
        ? {
            id: result.user.id,
            email: result.user.email,
            emailVerified: result.user.emailVerified,
          }
        : undefined;
    },
  };
  guardDeps.operatorTenantId = operatorTenantId;
  const guardedApp = guardedHubApp(app, guardDeps);
  const inFlight = createInFlightRequestTracker();
  const servingApp = withInFlightRequestTracking(guardedApp, inFlight);

  // Env-key auto-plant (CL-6101): runs in-process against the app this
  // function is about to return, so it needs nothing more than that
  // app's own `fetch` — see ./env-credential-plant.ts. A no-op when no
  // curated provider key is set in this process's environment.
  const envCredentialPlant = scheduleEnvProviderCredentialPlant({
    baseUrl: config.baseUrl,
    envProviderKeys: config.envProviderKeys,
    envProviderBaseUrls: config.envProviderBaseUrls,
    admin: config.envCredentialPlantAdmin,
    fetch: (request) => Promise.resolve(servingApp.fetch(request)),
  });

  return {
    app: servingApp,
    whenRequestsIdle: () => inFlight.whenIdle(),
    db,
    close: async () => {
      sidecarAllocationReconciliationStopped = true;
      if (sidecarAllocationReconciliationTimer !== undefined) {
        clearTimeout(sidecarAllocationReconciliationTimer);
      }
      // Retire the relaunch sweep's series so any in-flight pass's
      // `.finally` reschedule is a no-op, and cancel whatever pass is
      // currently pending. Without this the sweep outlives `close()`
      // entirely (it's only ever re-armed, never torn down) and keeps
      // querying `chat.workbench_launch` on a timer this function is
      // about to end — including, once `close()` below tears down the
      // db pool, querying a pool that's already shut down. In a test
      // suite that boots many hubs back to back (e.g.
      // slack-tag-mount.test.ts, CL-7453) those leaked timers pile up
      // across the whole `bun test` process and contend with later
      // tests' own boots for Postgres connections, which is what
      // surfaced as `chat·relaunch-sweep: relaunch sweep pass failed:
      // Failed query: select ... from chat.workbench_launch` and an
      // intermittent test timeout.
      relaunchSweepSeries += 1;
      clearTimeout(relaunchSweepTimer);
      envCredentialPlant.stop();
      chatOrchestrator.dispose();
      workflowScheduler.stop();
      credentialExpirySweep.stop();
      inboxUnsnoozeSweep.stop();
      benchProvisioner.stop();
      await insightsUsage.close();
      await insightsLatency.close();
      await preferences.close();
      await benchSettings.close();
      await evalRuns.close();
      await closeMailbox();
      await close();
    },
  };
}

if (import.meta.main) {
  await setup();
  const config = readHubConfig(process.env);
  mkdirSync(config.hubDataDir, { recursive: true });
  const hub = await createHub(config);
  const url = new URL(config.baseUrl);
  const port =
    config.listenPort ??
    (url.port === ""
      ? url.protocol === "https:"
        ? 443
        : 80
      : Number(url.port));
  const server = Bun.serve({
    fetch: hub.app.fetch,
    websocket,
    port,
    idleTimeout: 0,
  });
  const log = getLogger(["hub"]);
  log.info`Hub serving on port ${port}`;
  // CL-7382: replaces `workbench seed`. Runs against the hub's own real
  // origin now that it is actually listening — `runSystemSeed`'s
  // workflow push needs a reachable origin for `git push`, not just an
  // in-process fetch entry point. Never awaited: a slow or still-
  // sidecar-less seed must not delay "Hub serving" or hold up shutdown
  // wiring below it.
  void runSystemSeed({
    baseUrl: config.baseUrl,
    orgSlug: config.defaultTenantSlug,
    admin: config.envCredentialPlantAdmin,
    ...(config.seedModel !== undefined ? { seedModel: config.seedModel } : {}),
  });
  const SHUTDOWN_DRAIN_MS = 10_000;
  // In-flight Hono handlers (a request mid-Postgres-transaction, a git
  // write, anything that has not returned a Response yet) must finish
  // before connections are torn down. `server.stop()` with no argument
  // also waits for SSE bridges and idle sidecar websockets, which never
  // close on their own — so once handlers are idle, force-close what's
  // left. A live stream must not turn this drain into a timeout fault.
  const shutdown = () =>
    shutdownHub({
      drain: () =>
        drainHubServer({
          whenRequestsIdle: hub.whenRequestsIdle,
          stop: (force) => server.stop(force),
          close: hub.close,
        }),
      timeoutMs: SHUTDOWN_DRAIN_MS,
      exit: (code) => process.exit(code),
    });
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
