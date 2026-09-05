// Seeds one already-known tenant with the default workflow set: plants
// the seed grants, then for each default workflow ensures its asset
// exists, pushes its current definition, deploys it, and confirms the
// deployment answers. Validation is part of seeding — a deployment that
// cannot be confirmed is a seed failure, and a run with nothing to seed
// is a failure too. Safe to re-run; every skipped step says so.
//
// Workflow package metadata (automatable, displayName) lives in each
// workflows/*/package.json under `corbits.workflow` and is mirrored in
// `@workbench/templates`. Seed stamps displayName onto the asset so
// the scheduled-workflow picker can show a friendly label without reading package.json.

import {
  AssetResponse,
  AssetWithOriginResponse,
  CredentialResponse,
  GrantResponse,
  ModelOfferingResponse,
  ModelProviderResponse,
  ModelResponse,
  ProviderResponse,
  WorkflowRunHealth,
  WorkflowDefinitionResponse,
  paginatedSchema,
  Capability,
} from "@intx/types";
import { type } from "arktype";
import type { InferencePreference } from "@intx/agent";
import {
  buildAssistantWorkflow,
  serializeAssistantWorkflow,
} from "@corbits/assistant-workflow";
import {
  buildCodeReviewWorkflow,
  serializeCodeReviewWorkflow,
} from "@corbits/code-review-workflow";
import {
  buildWorkbenchDigestWorkflow,
  serializeWorkbenchDigestWorkflow,
} from "@corbits/workbench-digest-workflow";
import {
  buildEchoWorkflow,
  serializeEchoWorkflow,
} from "@corbits/echo-workflow";
import {
  buildHeartbeatWorkflow,
  serializeHeartbeatWorkflow,
} from "@corbits/heartbeat-workflow";
import {
  buildLast30DaysResearchWorkflow,
  serializeLast30DaysResearchWorkflow,
} from "@corbits/last-30-days-research-workflow";
import {
  buildGranolaCallWorkflow,
  serializeGranolaCallWorkflow,
} from "@corbits/granola-call-workflow";
import {
  buildMorningBriefWorkflow,
  serializeMorningBriefWorkflow,
} from "@corbits/morning-brief-workflow";
import {
  buildExaTopicWatchWorkflow,
  serializeExaTopicWatchWorkflow,
} from "@corbits/exa-topic-watch-workflow";
import {
  buildProcessGranolaCallWorkflow,
  serializeProcessGranolaCallWorkflow,
} from "@corbits/process-granola-call-workflow";
import {
  buildAttioTaskAgentWorkflow,
  serializeAttioTaskAgentWorkflow,
} from "@corbits/attio-task-agent-workflow";
import {
  buildPainPointCollateralWorkflow,
  serializePainPointCollateralWorkflow,
} from "@corbits/pain-point-collateral-workflow";
import {
  buildRedditOpportunityScannerWorkflow,
  serializeRedditOpportunityScannerWorkflow,
} from "@corbits/reddit-opportunity-scanner-workflow";
import {
  buildCollateralGenerationWorkflow,
  serializeCollateralGenerationWorkflow,
} from "@corbits/collateral-generation-workflow";
import {
  buildDiligenceBriefWorkflow,
  serializeDiligenceBriefWorkflow,
} from "@corbits/diligence-brief-workflow";
import { WORKFLOW_CATALOG } from "@workbench/templates";
import { capabilitiesForDeployment } from "@corbits/inference-catalog/offering-capabilities";
import { quirksForDeployment } from "@corbits/inference-catalog/ollama-context-defaults";
import { type PublishCorbitsToolsRegistryArgs } from "@corbits/tool-registry-publish";
import { WORKFLOW_SOURCE_ENTRY } from "@corbits/workflows";
import {
  HubApiError,
  SidecarUnavailableError,
  parseAs,
  type ApiCall,
} from "@corbits/hub-api-client";
import { DEFAULT_SKILLS } from "./default-skills";
import { CATALOG_SEEDS, type CatalogModelSpec } from "./catalog-seed-data";
import {
  fetchOllamaModelCatalog,
  ollamaOpenAICompatBaseURL,
  type SupportedCredentialProvider,
} from "@corbits/connections/credential-test";
import { hasCompletionCapableModel } from "@corbits/connections/model-capability";

const GIT_TOKEN_TTL_MS = 10 * 60 * 1000;
const ECHO_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const ASSISTANT_TURN_TIMEOUT_MS = 2 * 60 * 1000;
// Short: these two run on a tight, continuous schedule to exercise
// scheduling itself, so a wedged noop-inference call should surface
// fast rather than tie up a run slot for the full two minutes the
// conversational workflows above allow.
const HEARTBEAT_TURN_TIMEOUT_MS = 30 * 1000;
const WORKBENCH_DIGEST_TURN_TIMEOUT_MS = 30 * 1000;
// A research turn fans out across multiple source tools and writes a
// long-form report, so it gets the same generous allowance as the
// other conversational workflows above, not the short catalog-test
// budget.
const LAST_30_DAYS_RESEARCH_TURN_TIMEOUT_MS = 2 * 60 * 1000;
// Matches the conversational default every folded builder in this
// codebase uses: a review turn reads a diff and posts one review, the
// same order of work as a research or assistant turn.
const CODE_REVIEW_TURN_TIMEOUT_MS = 2 * 60 * 1000;
// Same conversational default as the entries above: one mail-triggered
// reasoning turn per run, no multi-step DAG.
const GRANOLA_CALL_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const MORNING_BRIEF_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const EXA_TOPIC_WATCH_TURN_TIMEOUT_MS = 2 * 60 * 1000;
// A transcript-plus-extraction-plus-verification pass over a long call
// can run well past the shortest steps in the catalog (see the
// workflow's own README), so this gets extra headroom.
const PROCESS_GRANOLA_CALL_TURN_TIMEOUT_MS = 5 * 60 * 1000;
const ATTIO_TASK_AGENT_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const PAIN_POINT_COLLATERAL_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const REDDIT_OPPORTUNITY_SCANNER_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const COLLATERAL_GENERATION_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const DILIGENCE_BRIEF_TURN_TIMEOUT_MS = 2 * 60 * 1000;
const RUN_START_TIMEOUT_MS = 30_000;
const RUN_POLL_INTERVAL_MS = 1000;

// The deploy source the per-step agents launch against. The id is the
// routing key `defaultSource` must name; with exactly one source there
// is exactly one honest value for it.
const SEED_SOURCE_ID = "default";

// The provider/model pair `noop-inference` (packages/chat/src/noop-inference.ts)
// answers for any request, regardless of what is actually sent — the
// route ignores its body and `x-api-key` entirely. Naming a distinct
// pair here (rather than reusing the tenant's real model id) keeps a
// noop-pinned deployment visually distinct from a real one in the hub's
// UI and logs.
const NOOP_PROVIDER = "anthropic";
const NOOP_MODEL = "noop";

/**
 * A `ModelSource` pointed at the hub's own `noop-inference` endpoint
 * instead of a real provider — the same substitution
 * `packages/chat/src/platform-adapter.ts`'s `noopSourcesOverride` makes
 * for workbench-host launches, reused here so a workflow deployed with
 * this source resolves every turn instantly against a constant,
 * locally served reply and never reaches a real model. `hubUrl` is the
 * same base URL `seedTenant` already receives, so no new configuration
 * is required to use it.
 */
export function NOOP_MODEL_SOURCE(hubUrl: string): ModelSource {
  return {
    provider: NOOP_PROVIDER,
    model: NOOP_MODEL,
    baseURL: `${hubUrl}/api/chat/noop-inference`,
    apiKey: "noop",
  };
}

const GitTokenMintResponse = type({ id: "string", secret: "string" });
const WorkflowDeploymentResponse = type({
  id: "string",
  tenantId: "string",
  definitionAssetId: "string",
  status: "string",
  createdAt: "string",
});
const WorkflowRunListResponse = type({ runIds: "string[]" });
// Post-deployment-dissolution wire shape: the trigger answers with the
// (self-anchored) run id, not a deployment id.
const WorkflowRunTriggerResponse = type({
  runId: "string",
  address: "string",
  messageId: "string",
});

export type ModelSource = {
  readonly provider: string;
  readonly model: string;
  readonly baseURL: string;
  readonly apiKey: string;
};

/**
 * Whether a deployments-API row counts as live. The wire vocabulary is
 * "deployed" / "pending" / failure states (vendor hub-api
 * formatAllocationStatus) — there is no "active". This is the ONE
 * definition of "already deployed"; every seeded/skip check imports it.
 */
export function isLiveDeploymentStatus(status: string): boolean {
  return status === "deployed" || status === "pending";
}

export type PushOutcome = "pushed" | "unchanged";

/**
 * What the push left on the asset's `main`: whether it wrote a commit,
 * and the sha that commit (or the already-current one) sits at. The sha
 * IS the deploy pin — a code-sourced deploy sources
 * `package: { format: "source", commitSha }`.
 */
export type PushResult = { outcome: PushOutcome; commitSha: string };

export type WorkflowPusher = (args: {
  remoteUrl: string;
  tokenSecret: string;
  workflowJson: string;
  /** Name the rendered source package declares; never leaves the asset. */
  packageName: string;
}) => Promise<PushResult>;

export type DefaultWorkflow = {
  /** Asset name; lowercase-kebab so the smart-HTTP repo path is clean. */
  assetName: string;
  /** Friendly label stamped on the asset at create time. */
  displayName: string;
  /**
   * True when this workflow is a legitimate Routines-picker candidate
   * (schedulable automation). Conversational agents stay false.
   */
  automatable: boolean;
  /**
   * Renders the definition's JSON given the tenant's mail domain and the
   * ordered provider/model preferences to deploy against. Takes the bare
   * preference list — never a full `ModelSource` — so this same
   * function serves both `seedTenant`'s HTTP-deploy path (which also
   * needs a `ModelSource`'s `baseURL`/`apiKey` for the deployment's
   * `sources`, resolved separately) and a native in-process deploy path
   * (`apps/hub/src/templates/block-workflows.ts`) that only ever has the
   * tenant's real, possibly multi-entry inference preferences on hand.
   */
  buildJson: (
    tenantDomain: string,
    inferencePreferences: readonly InferencePreference[],
  ) => string;
  /**
   * Overrides the deploy's inference source for this workflow only,
   * given the hub's own base URL. Present on the catalog-test workflow
   * `heartbeat`, which must stay free to run continuously: it names
   * `NOOP_MODEL_SOURCE` instead of the tenant's real catalog model.
   * Absent on every conversational workflow and on the seeded
   * workbench-digest automation, which deploy against the tenant's real
   * model.
   */
  modelSource?: (hubUrl: string) => ModelSource;
  /**
   * When true, PUT the authored definition to `stopped` after deploy so
   * a native ScheduleTrigger does not fire every tenant at the next
   * matching minute. Absent means leave the schema default (`deployed`).
   */
  startStopped?: true;
};

function catalogDisplayName(assetName: string): string {
  return (
    WORKFLOW_CATALOG.find((entry) => entry.assetName === assetName)
      ?.displayName ?? assetName
  );
}

function catalogAutomatable(assetName: string): boolean {
  return (
    WORKFLOW_CATALOG.find((entry) => entry.assetName === assetName)
      ?.automatable ?? false
  );
}

/**
 * The asset name of the agent a person actually talks to on a brand-new
 * bench — Myra, the setup agent. Named here because deploy ORDER depends
 * on it (see `DEFAULT_WORKFLOWS`) and because every surface that asks
 * "can this person start yet?" answers by looking for this one asset,
 * never by counting the whole set.
 */
export const SETUP_AGENT_ASSET_NAME = "assistant";

/**
 * The workflow set every real tenant starts with: the general-purpose
 * assistant, and nothing else (CL-7074). This is what
 * `provisionPersonalTenantIfNeeded` (`@workbench/onboarding`) deploys
 * on first login for every real user — growing it is adding an entry
 * here, nothing more, but an entry here reaches every signup, so it is
 * never the place for a workflow that is not something every person
 * needs the moment they land. `echo`, `workbench-digest`, and
 * `last-30-days-research` used to live here; a signup paid a git push
 * and a sidecar probe for each of them even though nobody asked for
 * them. They now live in `CATALOG_WORKFLOWS`, deployable through the
 * catalog instantiate route (CL-7073) rather than seeded onto every
 * bench. See `CATALOG_TEST_WORKFLOWS`
 * for the platform-exercise set, which never reaches a real signup at
 * all.
 *
 * Order is a product decision, not a formality (CL-6462): `seedTenant`
 * deploys this array in sequence at roughly 20s each, and the setup
 * agent is the only entry a person needs before they can start talking.
 * It goes first so a fresh signup lands in a working conversation in
 * seconds while the rest converge behind them; a signup that waited on
 * the whole set stared at a progress screen for minutes.
 */
export const DEFAULT_WORKFLOWS: readonly DefaultWorkflow[] = [
  {
    assetName: SETUP_AGENT_ASSET_NAME,
    displayName: catalogDisplayName(SETUP_AGENT_ASSET_NAME),
    automatable: catalogAutomatable(SETUP_AGENT_ASSET_NAME),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeAssistantWorkflow(
        buildAssistantWorkflow({
          triggerAddress: `${SETUP_AGENT_ASSET_NAME}@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: ASSISTANT_TURN_TIMEOUT_MS,
        }),
      ),
  },
];

/**
 * Workflows every real tenant CAN have, but none is deployed by default
 * (CL-7074) — a caller deploys one on demand the same way `seedTenant`
 * deploys any `DefaultWorkflow`: `ensureWorkflowAsset` →
 * `pushWorkflow` → `ensureDeployment`. `CL-7073` is the caller that
 * offers these from a catalog/instantiate surface; nothing here reaches
 * a bench until something asks for it by name. An asset already
 * deployed on an existing bench (a prior seed run, before these moved
 * out of `DEFAULT_WORKFLOWS`) is untouched — there is no orphan-retire
 * for these entries, on purpose (see `docs/seed-reconciliation.md`).
 */
export const CATALOG_WORKFLOWS: readonly DefaultWorkflow[] = [
  {
    assetName: "echo",
    displayName: catalogDisplayName("echo"),
    automatable: catalogAutomatable("echo"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeEchoWorkflow(
        buildEchoWorkflow({
          triggerAddress: `echo@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: ECHO_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "workbench-digest",
    displayName: catalogDisplayName("workbench-digest"),
    automatable: catalogAutomatable("workbench-digest"),
    buildJson: (_tenantDomain, inferencePreferences) =>
      serializeWorkbenchDigestWorkflow(
        buildWorkbenchDigestWorkflow({
          inferencePreferences,
          turnTimeoutMs: WORKBENCH_DIGEST_TURN_TIMEOUT_MS,
        }),
      ),
    startStopped: true,
  },
  {
    assetName: "last-30-days-research",
    displayName: catalogDisplayName("last-30-days-research"),
    automatable: catalogAutomatable("last-30-days-research"),
    // Deployed automation, on demand. Seed never POSTs a wrapper row;
    // last-30-days-research stays a deployed workflow without a native
    // ScheduleTrigger.
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeLast30DaysResearchWorkflow(
        buildLast30DaysResearchWorkflow({
          triggerAddress: `last-30-days-research@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: LAST_30_DAYS_RESEARCH_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "code-review",
    displayName: catalogDisplayName("code-review"),
    automatable: catalogAutomatable("code-review"),
    // Deployed automation, on demand, same as every other entry here
    // (CL-7073): the instantiate route used to build this one definition
    // through its own hardcoded copy in
    // `apps/hub/src/templates/block-workflows.ts`; that copy is gone and
    // this entry is now the one source of truth for it, same as every
    // other catalog workflow.
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeCodeReviewWorkflow(
        buildCodeReviewWorkflow({
          triggerAddress: `code-review@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: CODE_REVIEW_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "granola-call",
    displayName: catalogDisplayName("granola-call"),
    automatable: catalogAutomatable("granola-call"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeGranolaCallWorkflow(
        buildGranolaCallWorkflow({
          triggerAddress: `granola-call@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: GRANOLA_CALL_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "morning-brief",
    displayName: catalogDisplayName("morning-brief"),
    automatable: catalogAutomatable("morning-brief"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeMorningBriefWorkflow(
        buildMorningBriefWorkflow({
          triggerAddress: `morning-brief@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: MORNING_BRIEF_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "exa-topic-watch",
    displayName: catalogDisplayName("exa-topic-watch"),
    automatable: catalogAutomatable("exa-topic-watch"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeExaTopicWatchWorkflow(
        buildExaTopicWatchWorkflow({
          triggerAddress: `exa-topic-watch@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: EXA_TOPIC_WATCH_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "process-granola-call",
    displayName: catalogDisplayName("process-granola-call"),
    automatable: catalogAutomatable("process-granola-call"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeProcessGranolaCallWorkflow(
        buildProcessGranolaCallWorkflow({
          triggerAddress: `process-granola-call@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: PROCESS_GRANOLA_CALL_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "attio-task-agent",
    displayName: catalogDisplayName("attio-task-agent"),
    automatable: catalogAutomatable("attio-task-agent"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeAttioTaskAgentWorkflow(
        buildAttioTaskAgentWorkflow({
          triggerAddress: `attio-task-agent@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: ATTIO_TASK_AGENT_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "pain-point-collateral",
    displayName: catalogDisplayName("pain-point-collateral"),
    automatable: catalogAutomatable("pain-point-collateral"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializePainPointCollateralWorkflow(
        buildPainPointCollateralWorkflow({
          triggerAddress: `pain-point-collateral@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: PAIN_POINT_COLLATERAL_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "reddit-opportunity-scanner",
    displayName: catalogDisplayName("reddit-opportunity-scanner"),
    automatable: catalogAutomatable("reddit-opportunity-scanner"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeRedditOpportunityScannerWorkflow(
        buildRedditOpportunityScannerWorkflow({
          triggerAddress: `reddit-opportunity-scanner@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: REDDIT_OPPORTUNITY_SCANNER_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "collateral-generation",
    displayName: catalogDisplayName("collateral-generation"),
    automatable: catalogAutomatable("collateral-generation"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeCollateralGenerationWorkflow(
        buildCollateralGenerationWorkflow({
          triggerAddress: `collateral-generation@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: COLLATERAL_GENERATION_TURN_TIMEOUT_MS,
        }),
      ),
  },
  {
    assetName: "diligence-brief",
    displayName: catalogDisplayName("diligence-brief"),
    automatable: catalogAutomatable("diligence-brief"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeDiligenceBriefWorkflow(
        buildDiligenceBriefWorkflow({
          triggerAddress: `diligence-brief@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: DILIGENCE_BRIEF_TURN_TIMEOUT_MS,
        }),
      ),
  },
];

/**
 * Zero-cost workflows that exist to exercise the platform continuously
 * — `heartbeat` proves the scheduling and mail-trigger paths — never to
 * give a real user something to use. Pinned at `NOOP_MODEL_SOURCE` so
 * running them on a tight schedule costs nothing. Deliberately absent
 * from `DEFAULT_WORKFLOWS`: a real signup goes through
 * `provisionPersonalTenantIfNeeded`, which never seeds this set. Only an
 * explicit, dev/CI-specific caller (`workbench seed` with
 * `WORKBENCH_SEED_CATALOG_TEST_WORKFLOWS` set) opts in.
 *
 * workbench-digest used to live here as a platform exercise, then moved
 * to `DEFAULT_WORKFLOWS`; it now lives in `CATALOG_WORKFLOWS` (CL-7074),
 * deployable through the catalog instantiate route (CL-7073) rather than
 * seeded onto every bench.
 */
export const CATALOG_TEST_WORKFLOWS: readonly DefaultWorkflow[] = [
  {
    assetName: "heartbeat",
    displayName: catalogDisplayName("heartbeat"),
    automatable: catalogAutomatable("heartbeat"),
    buildJson: (tenantDomain, inferencePreferences) =>
      serializeHeartbeatWorkflow(
        buildHeartbeatWorkflow({
          triggerAddress: `heartbeat@${tenantDomain}`,
          inferencePreferences,
          turnTimeoutMs: HEARTBEAT_TURN_TIMEOUT_MS,
        }),
      ),
    modelSource: NOOP_MODEL_SOURCE,
  },
];

/**
 * Every `workflows/<name>` source directory that deliberately carries no
 * `DefaultWorkflow` entry anywhere (`DEFAULT_WORKFLOWS`,
 * `CATALOG_WORKFLOWS`, `CATALOG_TEST_WORKFLOWS`), with a one-line reason
 * each. Kept empty on purpose right now — every current source directory
 * is registered somewhere — so a future package that's genuinely not a
 * deployable workflow (a shared library living under `workflows/` by
 * convention, say) has a place to say so instead of failing
 * `seed.test.ts`'s registration-invariant test silently by omission.
 */
export const EXCLUDED_WORKFLOW_SOURCES: readonly {
  readonly name: string;
  readonly reason: string;
}[] = [];

/**
 * The deployable-through-the-catalog-instantiate-route entry for one
 * asset name (CL-7073), or `undefined` if none exists. `CATALOG_WORKFLOWS`
 * is the one source of truth for "has a source package under
 * `workflows/<name>` and can be deployed on demand" — `DEFAULT_WORKFLOWS`
 * (seeded already, never re-deployed through this path) and
 * `CATALOG_TEST_WORKFLOWS` (test-only, never deployed onto a real bench)
 * both answer `undefined` here on purpose.
 */
export function deployableCatalogWorkflow(
  assetName: string,
): DefaultWorkflow | undefined {
  return CATALOG_WORKFLOWS.find((workflow) => workflow.assetName === assetName);
}

/**
 * Whether a catalog entry's own definition carries `credentialBindings` —
 * the same field `deployCodeSourcedWorkflow` (`vendor/intx/hub-sessions`)
 * refuses to resolve without a `credentialCipher`, a seam the current
 * Interchange pin's `POST /template-blocks/:assetName/deploy` front does
 * not supply (see `docs/seed-reconciliation.md`; closes at the re-pin,
 * CL-7107 / PR #632, pin 692c3106). Derived by rendering the entry's own
 * `buildJson` with placeholder deploy args and reading the serialized
 * definition's `credentialBindings` back — never a hand-kept list, so this
 * can never drift from the workflows that actually declare bindings.
 */
export function catalogWorkflowRequiresCredentialCipher(
  entry: DefaultWorkflow,
): boolean {
  const rendered = entry.buildJson("example.workbench.invalid", []);
  const parsed = JSON.parse(rendered) as {
    credentialBindings?: readonly unknown[];
  };
  return (parsed.credentialBindings?.length ?? 0) > 0;
}

/**
 * Whether a catalog asset name can deploy through the current
 * `POST /template-blocks/:assetName/deploy` front on this Interchange pin.
 * `false` for a name with no `CATALOG_WORKFLOWS` entry at all (nothing
 * deployable) or one whose entry requires a `credentialCipher` this pin
 * cannot supply — the route and the available-catalog listing both call
 * this instead of keeping their own copy of which six entries qualify.
 */
export function catalogWorkflowDeployableOnThisPin(assetName: string): boolean {
  const entry = deployableCatalogWorkflow(assetName);
  if (entry === undefined) return false;
  return !catalogWorkflowRequiresCredentialCipher(entry);
}

// The grants the deploy, trigger, and run-listing routes gate on,
// planted at the wildcard scope the authz glob matcher resolves
// against any concrete deployment (the deployment id is minted at
// deploy time, so a concrete resource cannot be planted up front).
export const SEED_GRANTS: readonly { resource: string; action: string }[] = [
  { resource: "workflow:*", action: "create" },
  { resource: "workflow:*", action: "read" },
  { resource: "workflow-run:*", action: "manage" },
  { resource: "workflow-run:*", action: "read" },
  // Workflow-definition read/update (stop a startStopped deploy, list
  // definitions) and extra workflow-run verbs none of the grants above
  // cover. Those routes gate on their own resource/action pairs.
  { resource: "workflow-definition:*", action: "read" },
  { resource: "workflow-definition:*", action: "update" },
  { resource: "workflow-run:*", action: "create" },
  { resource: "workflow-run:*", action: "write" },
  // CL-6346 moved the room routes (post a message, read-state, typing,
  // reactions, pins, the live stream) off `workflow-run:<id>` and onto
  // `room:<id>`. The two grants above used to be what carried a
  // non-owner principal through those routes; without the room pair
  // beside them the rename leaves every seeded principal that is not a
  // wildcard owner unable to read or write its own workbenches.
  { resource: "room:*", action: "read" },
  { resource: "room:*", action: "write" },
  // CL-6465: the eval-run read routes (`GET .../eval-runs/runs`,
  // `GET .../eval-runs/runs/:runId`) gate on this resource.
  { resource: "eval-run:*", action: "read" },
  // Agent-authored workflows (`@corbits/workflows`'s `./authoring`
  // `author`/`republish` routes): a seeded principal was never granted
  // "create"/"write" on "asset:*" before, because no workflow-run write
  // surface checked it — every prior workflow-run write route (skills,
  // capabilities, agent-directory) either wrote as the "hub" RepoStore
  // principal with no grant-store check, or was scoped narrowly enough
  // to skip one (see those packages' own CL-6085-referencing doc
  // comments). Authoring a workflow asset is deploying executable code,
  // not a markdown skill, so this is the one write surface that adds a
  // real per-write grant check rather than following that precedent.
  // These are the SAME resource/verb the human-session asset routes
  // already gate on (`requireGrant("asset:*", "create")` and the
  // tarball routes' `requireGrant(idResource("asset", "assetId"),
  // "write")`) — extended to workflow-run principals, not a new grant
  // vocabulary.
  { resource: "asset:*", action: "create" },
  { resource: "asset:*", action: "write" },
];

// The grants table has no unique constraint and the create route is a
// plain insert, so a re-run would accumulate duplicate rows; check for
// an equivalent grant first and report the skip.
async function plantGrant(
  api: ApiCall,
  cookies: string[],
  args: {
    tenantId: string;
    principalId: string;
    resource: string;
    action: string;
  },
  log: (line: string) => void,
): Promise<void> {
  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/grants?principalId=${encodeURIComponent(args.principalId)}&resource=${encodeURIComponent(args.resource)}&limit=200`,
    undefined,
    cookies,
  );
  const grants = parseAs(
    paginatedSchema(GrantResponse),
    listed.data,
    "grants response",
  ).data;
  const existing = grants.find(
    (g) =>
      g.resource === args.resource &&
      g.action === args.action &&
      g.effect === "allow" &&
      g.principalId === args.principalId,
  );
  if (existing) {
    log(`grant ${args.resource}/${args.action} already exists (skipped)`);
    return;
  }
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/grants`,
    {
      principalId: args.principalId,
      resource: args.resource,
      action: args.action,
      effect: "allow",
      origin: "creator",
    },
    cookies,
  );
  if (created.status !== 201) {
    throw new HubApiError(
      `the hub rejected the ${args.resource}/${args.action} grant with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  log(`granted ${args.resource}/${args.action}`);
}

/**
 * Reconciles one tenant's grants to exactly `SEED_GRANTS`: every declared
 * grant present, nothing beyond it. This is the one path that plants
 * `SEED_GRANTS` — `seedTenant`'s full seed and `provisionPersonalTenantIfNeeded`'s
 * already-seeded short-circuit both call this instead of each owning
 * their own pass, so a grant added to `SEED_GRANTS` after a tenant was
 * first seeded reaches that tenant the next time either path runs, not
 * only on a brand-new signup. `plantGrant` is itself idempotent (it
 * checks for an equivalent grant before creating one), so reconciling
 * twice never duplicates a row.
 */
export async function reconcileSeedGrants(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  principalId: string,
  log: (line: string) => void,
): Promise<void> {
  for (const grant of SEED_GRANTS) {
    await plantGrant(
      api,
      cookies,
      { tenantId, principalId, resource: grant.resource, action: grant.action },
      log,
    );
  }
}

async function plantDefaultSkills(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  log: (line: string) => void,
): Promise<void> {
  for (const skill of DEFAULT_SKILLS) {
    const existing = await api(
      "GET",
      `/api/tenants/${tenantId}/skills/${encodeURIComponent(skill.name)}`,
      undefined,
      cookies,
    );
    if (existing.status === 200) {
      log(`skill ${skill.name} already exists (skipped)`);
      continue;
    }
    const created = await api(
      "POST",
      `/api/tenants/${tenantId}/skills`,
      {
        name: skill.name,
        description: skill.description,
        body: skill.body,
        scope: "tenant",
      },
      cookies,
    );
    if (created.status === 409) {
      // The by-name GET above missed a row that the create route still
      // considers a conflict (an inherited/other-scope row, or a race
      // with a concurrent seed pass) — "already exists" is a skip, not
      // a fatal error, exactly like every other seed step's 409.
      log(`skill ${skill.name} already exists (skipped)`);
      continue;
    }
    if (created.status !== 201) {
      throw new HubApiError(
        `the hub rejected the default skill "${skill.name}" with status ${created.status}: ${JSON.stringify(created.data)}`,
        "check the hub logs for the underlying failure, then re-run: workbench seed",
      );
    }
    log(`seeded skill ${skill.name}`);
  }
}

async function ensureWorkflowAsset(
  api: ApiCall,
  cookies: string[],
  args: { tenantId: string; assetName: string; displayName: string },
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/assets`,
    {
      kind: "workflow",
      name: args.assetName,
      displayName: args.displayName,
    },
    cookies,
  );
  if (created.status === 201) {
    const asset = parseAs(AssetResponse, created.data, "asset response");
    log(`created workflow asset ${args.assetName} (${args.displayName})`);
    return asset.id;
  }
  if (created.status !== 409) {
    throw new HubApiError(
      `the hub rejected creation of workflow asset ${args.assetName} with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }

  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/assets?kind=workflow&inherited=false`,
    undefined,
    cookies,
  );
  const assets = parseAs(
    AssetWithOriginResponse.array(),
    listed.data,
    "assets response",
  );
  const existing = assets.find((a) => a.name === args.assetName);
  if (!existing) {
    throw new HubApiError(
      `workflow asset ${args.assetName} reported a name conflict but is not listable on the bench`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  log(`workflow asset ${args.assetName} already exists (skipped)`);
  return existing.id;
}

async function mintGitToken(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<string> {
  const minted = await api(
    "POST",
    `/api/tenants/${tenantId}/git-tokens`,
    {
      // Unique per run: a token's secret is only returned at mint, so a
      // re-run can never reuse the previous token — and an active token
      // with the same (user, name) makes the mint violate the hub's
      // uniqueness index. The short TTL reaps the leftovers.
      name: `workbench-seed-push-${crypto.randomUUID().slice(0, 8)}`,
      resource: "asset:*",
      refPattern: "**",
      actions: ["can_read", "can_push"],
      expiresAt: new Date(Date.now() + GIT_TOKEN_TTL_MS).toISOString(),
    },
    cookies,
  );
  if (minted.status !== 201) {
    throw new HubApiError(
      `the hub refused to mint a git token for the workflow push (status ${minted.status}): ${JSON.stringify(minted.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  return parseAs(GitTokenMintResponse, minted.data, "git token response")
    .secret;
}

async function listRunIds(
  api: ApiCall,
  cookies: string[],
  args: { tenantId: string; deploymentId: string },
): Promise<string[]> {
  const runs = await api(
    "GET",
    `/api/tenants/${args.tenantId}/workflows/${args.deploymentId}/runs`,
    undefined,
    cookies,
  );
  return parseAs(WorkflowRunListResponse, runs.data, "runs response").runIds;
}

/**
 * Whether a "deployed" deployment's run is actually routable right now.
 * `GET .../runs/:runId/health` reads `sidecarRouter.getRoutableAddresses()`
 * — the hub's in-memory table binding an agent address to the specific
 * connected sidecar socket that owns it — so this is a live check, not a
 * read of the persisted `workflow_run.status` column the caller already
 * has. That column survives a hub/sidecar restart; the routing table
 * does not, so a "deployed" row can answer `false` here forever until
 * something redeploys it. 404 (run never existed) and 410 (run stopped)
 * both count as not routable: either way, nothing this deployment id
 * names can be reused.
 */
async function isDeploymentRoutable(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
  deploymentId: string,
): Promise<boolean> {
  const health = await api(
    "GET",
    `/api/tenants/${tenantId}/workflows/runs/${deploymentId}/health`,
    undefined,
    cookies,
  );
  if (health.status === 404 || health.status === 410) return false;
  if (health.status !== 200) {
    throw new HubApiError(
      `the hub answered deployment ${deploymentId}'s health check with status ${health.status}: ${JSON.stringify(health.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  return (
    parseAs(WorkflowRunHealth, health.data, "run health response").liveness ===
    "ok"
  );
}

async function ensureDeployment(
  api: ApiCall,
  cookies: string[],
  args: {
    tenantId: string;
    assetId: string;
    assetName: string;
    commitSha: string;
    model: ModelSource;
  },
  log: (line: string) => void,
): Promise<string> {
  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/workflows/deployments`,
    undefined,
    cookies,
  );
  const deployments = parseAs(
    WorkflowDeploymentResponse.array(),
    listed.data,
    "deployments response",
  );
  const active = deployments.find(
    (d) =>
      d.definitionAssetId === args.assetId && isLiveDeploymentStatus(d.status),
  );
  if (active) {
    if (await isDeploymentRoutable(api, cookies, args.tenantId, active.id)) {
      log(
        `workflow ${args.assetName} already deployed as ${active.id} (skipped)`,
      );
      return active.id;
    }
    // The DB row survives a stack restart; the in-memory sidecar
    // routing table that binds an address to a live process does not.
    // Restart the hub and sidecar and every previously "deployed"
    // workflow_run still reads "deployed" while nothing routes its
    // address. Skipping here would just move the same 409
    // `confirmDeploymentAnswers` hits below one step earlier — redeploy
    // fresh instead of trusting a status column that outlived the
    // process it described.
    log(
      `workflow ${args.assetName}'s deployment ${active.id} is stale (its sidecar is gone); redeploying`,
    );
  }

  const deployed = await api(
    "POST",
    `/api/tenants/${args.tenantId}/workflows/deployments`,
    {
      source: {
        kind: "asset",
        assetId: args.assetId,
        package: { format: "source", commitSha: args.commitSha },
      },
      entry: WORKFLOW_SOURCE_ENTRY,
      sources: [
        {
          id: SEED_SOURCE_ID,
          provider: args.model.provider,
          baseURL: args.model.baseURL,
          apiKey: args.model.apiKey,
          model: args.model.model,
        },
      ],
      defaultSource: SEED_SOURCE_ID,
    },
    cookies,
  );
  if (deployed.status === 502) {
    throw new SidecarUnavailableError(
      `the hub could not deploy workflow ${args.assetName}: the sidecar is unavailable (${JSON.stringify(deployed.data)})`,
      "start the stack (`bun run dev` runs the hub and sidecar together), wait for the sidecar to connect, then re-run: workbench seed",
    );
  }
  if (deployed.status !== 201) {
    throw new HubApiError(
      `the hub rejected deployment of workflow ${args.assetName} with status ${deployed.status}: ${JSON.stringify(deployed.data)}`,
      "re-run: workbench seed (it re-pushes the workflow definition); if this persists, check the hub logs for the hydration failure",
    );
  }
  const deployment = parseAs(
    WorkflowDeploymentResponse,
    deployed.data,
    "deployment response",
  );
  log(`deployed workflow ${args.assetName} as ${deployment.id}`);
  return deployment.id;
}

/**
 * After deploy, PUT a pristine authored definition to `stopped` so a native
 * ScheduleTrigger does not fire every tenant. A member-restored row
 * (`updatedAt !== createdAt`) or an already-stopped row is left alone —
 * re-seed must never re-archive an enablement the member already chose.
 * Uses the existing agent-directory status route (grant:
 * `workflow-definition:<id>` `update`).
 */
async function stopPristineScheduledDefinition(
  api: ApiCall,
  cookies: string[],
  args: { tenantId: string; assetName: string },
  log: (line: string) => void,
): Promise<void> {
  const definitions = await listAllWorkflowDefinitions(
    api,
    cookies,
    args.tenantId,
  );
  const row = definitions.find(
    (definition) => definition.name === args.assetName,
  );
  if (row === undefined) {
    throw new HubApiError(
      `seeded workflow ${args.assetName} has no authored definition to stop`,
      "re-run: workbench seed after the deploy has projected a definition row",
    );
  }
  if (row.status === "stopped") {
    log(`definition ${args.assetName} already stopped (skipped)`);
    return;
  }
  if (row.createdAt !== row.updatedAt) {
    log(
      `definition ${args.assetName} was touched; leaving status ${row.status}`,
    );
    return;
  }
  const updated = await api(
    "PUT",
    `/api/tenants/${args.tenantId}/agent-definitions/${row.id}/status`,
    { status: "stopped" },
    cookies,
  );
  if (updated.status !== 200) {
    throw new HubApiError(
      `the hub rejected stopping definition ${args.assetName} with status ${updated.status}: ${JSON.stringify(updated.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  log(
    `stopped definition ${args.assetName} so its native schedule does not fire until restored`,
  );
}

async function listAllWorkflowDefinitions(
  api: ApiCall,
  cookies: string[],
  tenantId: string,
): Promise<(typeof WorkflowDefinitionResponse.infer)[]> {
  const items: (typeof WorkflowDefinitionResponse.infer)[] = [];
  let cursor: string | undefined;
  for (;;) {
    const query =
      cursor === undefined
        ? "limit=200"
        : `limit=200&cursor=${encodeURIComponent(cursor)}`;
    const listed = await api(
      "GET",
      `/api/tenants/${tenantId}/workflows/definitions?${query}`,
      undefined,
      cookies,
    );
    const page = parseAs(
      paginatedSchema(WorkflowDefinitionResponse),
      listed.data,
      "definitions response",
    );
    items.push(...page.data);
    if (page.nextCursor === null) return items;
    if (items.length > 10_000) {
      throw new HubApiError(
        `definitions list for tenant ${tenantId} did not terminate while paging`,
        "check the hub logs for the underlying failure, then re-run: workbench seed",
      );
    }
    cursor = page.nextCursor;
  }
}

async function confirmDeploymentAnswers(
  api: ApiCall,
  cookies: string[],
  args: {
    tenantId: string;
    deploymentId: string;
    assetName: string;
    sleep: (ms: number) => Promise<void>;
    timeoutMs: number;
    intervalMs: number;
  },
  log: (line: string) => void,
): Promise<void> {
  const before = new Set(
    await listRunIds(api, cookies, {
      tenantId: args.tenantId,
      deploymentId: args.deploymentId,
    }),
  );

  const triggered = await api(
    "POST",
    `/api/tenants/${args.tenantId}/workflows/${args.deploymentId}/mail`,
    { content: "workbench seed validation: confirm this deployment answers" },
    cookies,
  );
  if (triggered.status === 409) {
    throw new HubApiError(
      `deployment ${args.deploymentId} of workflow ${args.assetName} is deployed but its address is not routable — the sidecar that hosts it is not connected`,
      "start the stack (`bun run dev` runs the hub and sidecar together), wait for the sidecar to connect, then re-run: workbench seed",
    );
  }
  if (triggered.status !== 202) {
    throw new HubApiError(
      `the validation trigger for workflow ${args.assetName} was rejected with status ${triggered.status}: ${JSON.stringify(triggered.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  parseAs(WorkflowRunTriggerResponse, triggered.data, "trigger response");

  const attempts = Math.max(1, Math.ceil(args.timeoutMs / args.intervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const runIds = await listRunIds(api, cookies, {
      tenantId: args.tenantId,
      deploymentId: args.deploymentId,
    });
    const started = runIds.find((id) => !before.has(id));
    if (started !== undefined) {
      log(`confirmed workflow ${args.assetName}: run ${started} started`);
      return;
    }
    await args.sleep(args.intervalMs);
  }

  throw new HubApiError(
    `deployment ${args.deploymentId} of workflow ${args.assetName} accepted the validation trigger but no run started within ${Math.round(args.timeoutMs / 1000)}s`,
    "check the sidecar logs for the run failure, fix it, then re-run: workbench seed",
  );
}

/** The tenant identity `seedTenant` needs; resolved by the CLI's `runSeed`
 * from the bench slug, or already known to a caller (such as the
 * first-login provisioning hook) that just minted the tenant. */
export type SeedTenant = {
  tenantId: string;
  principalId: string;
  domain: string;
};

/**
 * Publishes a tenant's `corbits-tools` package-registry asset. Defaults
 * to the real `publishCorbitsToolsRegistry`; a test double can replace
 * it so a unit test never bundles a real tarball or dials the hub's
 * tarball REST routes, the same way `pushWorkflow` replaces the real
 * git push. Used by `workbench setup` (the root tenant), not by
 * `seedTenant`.
 */
export type ToolRegistryPublisher = (
  args: Omit<PublishCorbitsToolsRegistryArgs, "fetchImpl">,
) => Promise<unknown>;

export type SeedTenantArgs = {
  api: ApiCall;
  cookies: string[];
  hubUrl: string;
  tenant: SeedTenant;
  model: ModelSource;
  pushWorkflow: WorkflowPusher;
  log: (line: string) => void;
  workflows?: readonly DefaultWorkflow[];
  sleep?: (ms: number) => Promise<void>;
  runStartTimeoutMs?: number;
  runPollIntervalMs?: number;
  /**
   * Whether each deployment is confirmed by triggering a real mail
   * message and waiting for a run to start. Defaults to `true` — the
   * behavior `workbench seed` and the operator-key first-login hook
   * rely on, where a deployment nothing ever confirmed is treated as a
   * seed failure. A self-served connect flow (`@workbench/onboarding`'s
   * `completeCredentialSetup`) passes `false`: the key was already
   * proven with a free, auth-only probe before seeding started, so
   * spending the connecting user's own (possibly credit-less) balance
   * on a real inference call here would only re-litigate a question
   * already answered, at the user's expense.
   */
  confirmDeployments?: boolean;
};

/**
 * Plants the seed grants and deploys — and, unless told not to,
 * confirms — every default workflow for one already-known tenant. A
 * caller that already holds an authenticated session and a freshly
 * created tenant (the first-login provisioning hook, in particular)
 * seeds it without re-authenticating or re-resolving the tenant by
 * slug.
 *
 * Grants + workflows, then prune of leftover preset routine wrappers.
 * Assumes the tenant hierarchy already exposes `corbits-tools`
 * (published at `workbench setup` onto the root); seed does not pack
 * tarballs or run freshness.
 */
export async function seedTenant(args: SeedTenantArgs): Promise<void> {
  const {
    api,
    cookies,
    hubUrl,
    tenant,
    model,
    log,
    workflows = DEFAULT_WORKFLOWS,
    confirmDeployments = true,
  } = args;
  const sleep =
    args.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = args.runStartTimeoutMs ?? RUN_START_TIMEOUT_MS;
  const intervalMs = args.runPollIntervalMs ?? RUN_POLL_INTERVAL_MS;

  if (workflows.length === 0) {
    throw new HubApiError(
      "the default workflow set is empty; seeding zero workflows is a failure, not a success",
      "restore the default workflow set in @corbits/seeding before running: workbench seed",
    );
  }

  await reconcileSeedGrants(
    api,
    cookies,
    tenant.tenantId,
    tenant.principalId,
    log,
  );

  await plantDefaultSkills(api, cookies, tenant.tenantId, log);

  let confirmed = 0;
  for (const workflow of workflows) {
    const workflowModel = workflow.modelSource?.(hubUrl) ?? model;
    const assetId = await ensureWorkflowAsset(
      api,
      cookies,
      {
        tenantId: tenant.tenantId,
        assetName: workflow.assetName,
        displayName: workflow.displayName,
      },
      log,
    );

    const tokenSecret = await mintGitToken(api, cookies, tenant.tenantId);
    const pushed = await args.pushWorkflow({
      remoteUrl: `${hubUrl}/api/tenants/${tenant.tenantId}/assets/workflow/${workflow.assetName}.git`,
      tokenSecret,
      workflowJson: workflow.buildJson(tenant.domain, [
        { provider: workflowModel.provider, model: workflowModel.model },
      ]),
      packageName: `@workbench-seed/${workflow.assetName}`,
    });
    log(
      pushed.outcome === "pushed"
        ? `pushed the workflow source package for ${workflow.assetName}`
        : `workflow source for ${workflow.assetName} already current (skipped)`,
    );

    const deploymentId = await ensureDeployment(
      api,
      cookies,
      {
        tenantId: tenant.tenantId,
        assetId,
        assetName: workflow.assetName,
        commitSha: pushed.commitSha,
        model: workflowModel,
      },
      log,
    );

    if (workflow.startStopped === true) {
      await stopPristineScheduledDefinition(
        api,
        cookies,
        { tenantId: tenant.tenantId, assetName: workflow.assetName },
        log,
      );
    }
    if (confirmDeployments) {
      await confirmDeploymentAnswers(
        api,
        cookies,
        {
          tenantId: tenant.tenantId,
          deploymentId,
          assetName: workflow.assetName,
          sleep,
          timeoutMs,
          intervalMs,
        },
        log,
      );
    }
    confirmed += 1;
  }

  if (confirmed !== workflows.length) {
    throw new HubApiError(
      `only ${confirmed} of ${workflows.length} default workflows were confirmed`,
      "check the failures reported above, fix them, then re-run: workbench seed",
    );
  }

  log(
    confirmDeployments
      ? `seed complete: ${confirmed} workflow(s) deployed and confirmed`
      : `seed complete: ${confirmed} workflow(s) deployed`,
  );
}

// The credential name a seeded inference source stores its secret
// under; distinct from the provider name so re-runs and manual
// inspection are never ambiguous about which is which. Exported so a
// caller that needs to find that same row later (e.g. checking whether
// a just-connected provider's credential already exists) names it the
// same way `seedCatalog` did, rather than re-deriving the convention.
export function inferenceCredentialName(providerName: string): string {
  return `${providerName}-default`;
}

export type EnsureProviderArgs = {
  tenantId: string;
  name: string;
  plugin: string;
  /** The API origin an `http`-plugin credential from this provider pins
   * its requests to (`CreateProvider`'s own field, `@intx/types`).
   * Every fixed connector today (GitHub, Exa, ...) lets the hub-side
   * plugin default this; a dynamic-origin connector — a tenant-supplied
   * MCP server URL — must set it explicitly, or credential resolution
   * fails closed with `no_origin`. */
  apiBaseUrl?: string;
};

export async function ensureProvider(
  api: ApiCall,
  cookies: string[],
  args: EnsureProviderArgs,
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/providers`,
    { name: args.name, plugin: args.plugin, apiBaseUrl: args.apiBaseUrl },
    cookies,
  );
  if (created.status === 201) {
    const provider = parseAs(
      ProviderResponse,
      created.data,
      "provider response",
    );
    log(`created provider ${args.name}`);
    return provider.id;
  }
  if (created.status !== 409) {
    throw new HubApiError(
      `the hub rejected creation of provider ${args.name} with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }

  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/providers?inherited=false`,
    undefined,
    cookies,
  );
  const providers = parseAs(
    paginatedSchema(ProviderResponse),
    listed.data,
    "providers response",
  ).data;
  const existing = providers.find((p) => p.name === args.name);
  if (!existing) {
    throw new HubApiError(
      `provider ${args.name} reported a name conflict but is not listable on the bench`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  log(`provider ${args.name} already exists (skipped)`);
  return existing.id;
}

export type EnsureCredentialArgs = {
  tenantId: string;
  providerId: string;
  name: string;
  secret: string;
  type: "api_key" | "oauth_token";
  /** An `oauth_token` credential from a provider whose grant issues a
   * refresh token — absent for a provider that never does (Hugging
   * Face's PKCE flow), never a coerced empty string. */
  refreshSecret?: string;
  /** ISO instant the access token expires, when the provider reports one. */
  expiresAt?: string;
  metadata?: Record<string, unknown>;
  /**
   * Set by a caller that received `secret` as an explicit user
   * submission through a connect UI (a pasted key, a completed OAuth
   * exchange) before reaching `ensureCredential` — never inferred here,
   * and never conditioned on a probe (CL-6123 dropped the onboarding
   * probe that used to gate this). Gates whether an `api_key` name
   * conflict rotates the stored secret (see the 409 branch below); an
   * `oauth_token` conflict decides rotation from the stored row's
   * `status` instead and ignores this flag. Left unset by a plain
   * `workbench seed` or the hub-owned env auto-plant (CL-6101's
   * `plantEnvProviderCredentials`, which keeps its own boot-time probe
   * but never sets this — its rule is never-overwrite, not rotate), so
   * a routine re-seed with an unchanged key still just skips.
   */
  verified?: boolean;
};

export async function ensureCredential(
  api: ApiCall,
  cookies: string[],
  args: EnsureCredentialArgs,
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/credentials`,
    {
      providerId: args.providerId,
      name: args.name,
      type: args.type,
      secret: args.secret,
      refreshSecret: args.refreshSecret,
      expiresAt: args.expiresAt,
      metadata: args.metadata,
    },
    cookies,
  );
  if (created.status === 201) {
    const credential = parseAs(
      CredentialResponse,
      created.data,
      "credential response",
    );
    log(`created credential ${args.name}`);
    return credential.id;
  }
  if (created.status !== 409) {
    throw new HubApiError(
      `the hub rejected creation of credential ${args.name} with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }

  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/credentials`,
    undefined,
    cookies,
  );
  const credentials = parseAs(
    paginatedSchema(CredentialResponse),
    listed.data,
    "credentials response",
  ).data;
  const existing = credentials.find((c) => c.name === args.name);
  if (!existing) {
    throw new HubApiError(
      `credential ${args.name} reported a name conflict but is not listable on the bench`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }

  // An `oauth_token` credential (Hugging Face, or an MCP server connected
  // through OAuth) rotates on a name conflict in two distinct cases:
  //
  // 1. The stored row has gone stale (`status !== "active"`) — a plain
  //    re-seed or a reconnect after the expiry sweep already flipped it.
  //    Reusing the stale row instead of rotating it would silently strand
  //    the reconnect on the old, already-expired secret, and since the
  //    row's `status` is already non-`active`, the expiry sweep would
  //    never see it again to re-notify.
  // 2. The caller sets `args.verified` — an interactive OAuth reconnect
  //    (`connections`' `mcp-oauth-routes.ts`) completed a fresh exchange
  //    and is handing `ensureCredential` a genuinely new token, even
  //    though the existing row hasn't technically expired yet (the user
  //    re-authorized proactively, or the provider-side scopes changed).
  //    Gating on `status` alone silently dropped this token (CL-7236):
  //    zero PATCH call, and the stale row's id returned as if the
  //    reconnect had worked.
  //
  // A plain `workbench seed` never sets `verified` on an `oauth_token`
  // credential — its token comes straight from env with no OAuth exchange
  // of its own — so an idempotent re-seed of a still-active row still
  // just skips, exactly as before.
  //
  // An `api_key` credential (OpenRouter, an onboarding-picked provider)
  // has no staleness signal at all — its row stays `active` whether or
  // not the person reconnecting regenerated the key or is retrying after
  // a bad paste — so it rotates on a name conflict only when
  // `args.verified` is set, which a caller sets only for an explicit user
  // submission through a connect UI: `testAndPersistCredential`
  // (`@workbench/onboarding`'s `complete-credential.ts`) sets it
  // unconditionally for a pasted key or a completed OAuth exchange
  // (CL-6123 dropped the probe that used to gate this), and
  // `connections`' `POST /:connectorId/complete` (`routes.ts`) still
  // sets it only after `descriptor.probe` passes, since that surface
  // (Settings > Connections) is allowed to block on a real check.
  const shouldRotate =
    args.type === "oauth_token"
      ? existing.status !== "active" || args.verified === true
      : args.verified === true;
  if (shouldRotate) {
    const rotated = await api(
      "PATCH",
      `/api/tenants/${args.tenantId}/credentials/${existing.id}`,
      {
        secret: args.secret,
        refreshSecret: args.refreshSecret,
        expiresAt: args.expiresAt,
        status: "active",
        metadata: args.metadata,
      },
      cookies,
    );
    if (rotated.status !== 200) {
      throw new HubApiError(
        `the hub rejected rotating credential ${args.name} with status ${rotated.status}: ${JSON.stringify(rotated.data)}`,
        "check the hub logs for the underlying failure, then re-run: workbench seed",
      );
    }
    const credential = parseAs(
      CredentialResponse,
      rotated.data,
      "credential response",
    );
    log(
      `rotated credential ${args.name} (reconnect refreshed the stored secret)`,
    );
    return credential.id;
  }

  log(
    `credential ${args.name} already exists (skipped; its secret is not updated by seeding)`,
  );
  return existing.id;
}

async function ensureCatalogModel(
  api: ApiCall,
  cookies: string[],
  args: { tenantId: string; canonicalName: string },
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/catalog/models`,
    { canonicalName: args.canonicalName },
    cookies,
  );
  if (created.status === 201) {
    const model = parseAs(
      ModelResponse,
      created.data,
      "catalog model response",
    );
    log(`created catalog model ${args.canonicalName}`);
    return model.id;
  }
  if (created.status !== 409) {
    throw new HubApiError(
      `the hub rejected creation of catalog model ${args.canonicalName} with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }

  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/catalog/models`,
    undefined,
    cookies,
  );
  const models = parseAs(
    paginatedSchema(ModelResponse),
    listed.data,
    "catalog models response",
  ).data;
  const existing = models.find((m) => m.canonicalName === args.canonicalName);
  if (!existing) {
    throw new HubApiError(
      `catalog model ${args.canonicalName} reported a name conflict but is not listable on the bench`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  log(`catalog model ${args.canonicalName} already exists (skipped)`);
  return existing.id;
}

async function ensureCatalogProvider(
  api: ApiCall,
  cookies: string[],
  args: {
    tenantId: string;
    name: string;
    plugin: string;
    baseURL: string;
    credentialId: string;
  },
  log: (line: string) => void,
): Promise<string> {
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/catalog/providers`,
    {
      name: args.name,
      plugin: args.plugin,
      baseURL: args.baseURL,
      credentialId: args.credentialId,
    },
    cookies,
  );
  if (created.status === 201) {
    const provider = parseAs(
      ModelProviderResponse,
      created.data,
      "catalog provider response",
    );
    log(`created catalog provider ${args.name}`);
    return provider.id;
  }
  if (created.status !== 409) {
    throw new HubApiError(
      `the hub rejected creation of catalog provider ${args.name} with status ${created.status}: ${JSON.stringify(created.data)}`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }

  const listed = await api(
    "GET",
    `/api/tenants/${args.tenantId}/catalog/providers`,
    undefined,
    cookies,
  );
  const providers = parseAs(
    paginatedSchema(ModelProviderResponse),
    listed.data,
    "catalog providers response",
  ).data;
  const existing = providers.find((p) => p.name === args.name);
  if (!existing) {
    throw new HubApiError(
      `catalog provider ${args.name} reported a name conflict but is not listable on the bench`,
      "check the hub logs for the underlying failure, then re-run: workbench seed",
    );
  }
  log(`catalog provider ${args.name} already exists (skipped)`);
  return existing.id;
}

async function ensureCatalogOffering(
  api: ApiCall,
  cookies: string[],
  args: {
    tenantId: string;
    modelId: string;
    providerId: string;
    priority: number;
    capabilities: readonly Capability[];
    quirks?: Record<string, unknown>;
  },
  log: (line: string) => void,
): Promise<void> {
  const body: Record<string, unknown> = {
    modelId: args.modelId,
    providerId: args.providerId,
    priority: args.priority,
    capabilities: args.capabilities,
  };
  if (args.quirks !== undefined) body["quirks"] = args.quirks;
  const created = await api(
    "POST",
    `/api/tenants/${args.tenantId}/catalog/offerings`,
    body,
    cookies,
  );
  if (created.status === 201) {
    parseAs(ModelOfferingResponse, created.data, "catalog offering response");
    log("created catalog offering");
    return;
  }
  if (created.status === 409) {
    let cursor: string | null = null;
    let existing: typeof ModelOfferingResponse.infer | undefined;
    do {
      const listed = await api(
        "GET",
        `/api/tenants/${args.tenantId}/catalog/offerings${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
        undefined,
        cookies,
      );
      const page = parseAs(
        paginatedSchema(ModelOfferingResponse),
        listed.data,
        "catalog offerings response",
      );
      existing = page.data.find(
        (offering) =>
          offering.modelId === args.modelId &&
          offering.providerId === args.providerId,
      );
      cursor = page.nextCursor;
    } while (existing === undefined && cursor !== null);
    if (!existing) {
      throw new HubApiError(
        "catalog offering reported a conflict but is not listable on the bench",
        "check the hub logs for the underlying failure, then re-run: workbench seed",
      );
    }
    if (existing.priority === args.priority) {
      log("catalog offering already exists (skipped)");
      return;
    }

    const updated = await api(
      "PATCH",
      `/api/tenants/${args.tenantId}/catalog/offerings/${existing.id}`,
      { priority: args.priority },
      cookies,
    );
    if (updated.status !== 200) {
      throw new HubApiError(
        `the hub rejected updating the catalog offering priority with status ${updated.status}: ${JSON.stringify(updated.data)}`,
        "check the hub logs for the underlying failure, then re-run: workbench seed",
      );
    }
    parseAs(ModelOfferingResponse, updated.data, "catalog offering response");
    log("updated catalog offering priority");
    return;
  }
  throw new HubApiError(
    `the hub rejected creation of the catalog offering with status ${created.status}: ${JSON.stringify(created.data)}`,
    "check the hub logs for the underlying failure, then re-run: workbench seed",
  );
}

// Named so it can never be mistaken for a real secret if it leaks into
// a log line, a screenshot, or a bug report.
export const PLACEHOLDER_CATALOG_API_KEY = "placeholder-not-a-real-key";

export type SeedCatalogArgs = {
  api: ApiCall;
  cookies: string[];
  tenantId: string;
  log: (line: string) => void;
  /**
   * Which provider's curated catalog seed (`CATALOG_SEEDS`) to plant.
   * Defaults to `"anthropic"` — the operator-configured provider a plain
   * `workbench seed` plants — so every existing caller that seeds a
   * single hub-owned key keeps working unchanged. Onboarding's
   * self-served credential flow always passes the provider the person
   * actually connected.
   */
  provider?: SupportedCredentialProvider;
  /**
   * A real API key for `provider`. When set, `seedCatalog` plants a
   * credential row alongside the catalog data, making the seeded
   * offerings launchable.
   */
  apiKey?: string;
  /**
   * Explicit opt-in to plant a placeholder credential when `apiKey` is
   * not set, so a keyless dev or CI run can still launch workbench
   * anchors. Plain `workbench seed` never sets this — only callers that
   * need a launchable chain without a real key (the local dev
   * bootstrap, the e2e harness) pass it.
   */
  placeholderCredential?: boolean;
  /**
   * The credential type the seeded row is stored as. Defaults to
   * `"api_key"` for a pasted secret; a connect flow that mints an
   * expiring OAuth access token (Hugging Face) passes `"oauth_token"`
   * so the row is honestly typed.
   */
  credentialType?: "api_key" | "oauth_token";
  /**
   * Overrides the seeded credential row's name — defaults to
   * `inferenceCredentialName(seed.provider.name)`. A caller whose
   * credential must also resolve by name elsewhere (the Plugins
   * gallery's `GET .../credentials/resolve/:name`, which looks up a
   * connector's `descriptor.displayName`) passes that same name here,
   * so the one row satisfies both readers instead of leaving a
   * connect flow's credential invisible to a reader that expects the
   * other naming convention.
   */
  credentialName?: string;
  /**
   * Free-form data attached to the seeded credential's `metadata`
   * field — the extension point a token's expiry timestamp lives in
   * (see `complete-credential.ts`), never interpreted by this function.
   */
  credentialMetadata?: Record<string, unknown>;
  /**
   * Passed straight through to `ensureCredential`'s own `verified` — set
   * only by a caller that already proved `apiKey` against the provider's
   * own probe before calling `seedCatalog` (onboarding's
   * `testAndPersistCredential`). A plain `workbench seed` never sets
   * this, since its key comes straight from env with no probe of its
   * own.
   */
  credentialVerified?: boolean;
  /**
   * A credential row the caller already planted (the shared
   * persist-and-seed sequence, `@corbits/connections`'
   * `persistConnectorCredential`). When set, this function plants only
   * the catalog side — provider/credential ensure is skipped entirely,
   * so the caller's single `ensureCredential` stays the one write (no
   * second rotation PATCH against the same row).
   */
  existingCredentialId?: string;
  /**
   * Overrides `CATALOG_SEEDS[provider].provider.baseURL` for this seed
   * run — the configurable-base-URL seam every other curated provider
   * ignores (a fixed origin) and `ollama` uses (the root a person
   * actually pointed their instance at). Accepted in any shape
   * `ollamaOpenAICompatBaseURL` normalizes (plain root or `/v1` form);
   * normalized here before it reaches `ensureProvider`/`ensureCatalogProvider`.
   * Ignored for every provider except `ollama`.
   */
  baseURLOverride?: string;
};

export type SeedCatalogResult = {
  /**
   * Whether at least one seeded offering is completion-capable per
   * `hasCompletionCapableModel`. `false` only when every seeded model
   * resolves to no capability data and an embedding-shaped name (a fresh
   * Ollama connect whose instance has only an embedding model pulled,
   * most concretely, CL-6351) -- the connect itself still succeeds, but
   * the caller (`connections`' `/complete` route) surfaces this as a
   * guided state rather than letting every chat turn fail with "does not
   * support generate".
   */
  hasCompletionCapableModel: boolean;
};

/**
 * Plants one provider's curated catalog (see `catalog-seed-data.ts`) in a
 * tenant's catalog. The catalog model rows are always planted — data
 * only, viewable before any credential exists. The credential, catalog
 * provider, and offerings are planted only when a real `apiKey` is given
 * or `placeholderCredential` is explicitly set; without either, the
 * models are listable but nothing is launchable, and the caller is told
 * so. Idempotent: an already seeded chain is detected by name and
 * skipped, never duplicated.
 */
export async function seedCatalog(
  args: SeedCatalogArgs,
): Promise<SeedCatalogResult> {
  const { api, cookies, tenantId, log, provider = "anthropic" } = args;
  const seed = CATALOG_SEEDS[provider];

  const providerBaseURL =
    provider === "ollama"
      ? ollamaOpenAICompatBaseURL(args.baseURLOverride ?? seed.provider.baseURL)
      : seed.provider.baseURL;

  // Ollama's whole catalog is whatever the instance actually has loaded
  // right now — the curated static seed (two names, kept in sync by
  // hand) is only the fallback for an unreachable instance. Every other
  // provider's model list is fixed, so this never runs for them.
  const dynamicModels: readonly CatalogModelSpec[] | undefined =
    provider === "ollama"
      ? await fetchOllamaModelCatalog(providerBaseURL)
      : undefined;
  const models = dynamicModels ?? seed.models;

  const seededModels: {
    id: string;
    canonicalName: string;
    liveCapabilities?: readonly string[];
  }[] = [];
  for (const model of models) {
    const modelId = await ensureCatalogModel(
      api,
      cookies,
      { tenantId, canonicalName: model.canonicalName },
      log,
    );
    seededModels.push(
      model.capabilities !== undefined
        ? {
            id: modelId,
            canonicalName: model.canonicalName,
            liveCapabilities: model.capabilities,
          }
        : { id: modelId, canonicalName: model.canonicalName },
    );
  }

  const credentialSecret =
    args.apiKey ??
    (args.placeholderCredential === true
      ? PLACEHOLDER_CATALOG_API_KEY
      : undefined);

  async function plantCredential(secret: string): Promise<string> {
    const providerArgs =
      provider === "ollama"
        ? {
            tenantId,
            name: seed.provider.name,
            plugin: seed.provider.plugin,
            apiBaseUrl: providerBaseURL,
          }
        : { tenantId, name: seed.provider.name, plugin: seed.provider.plugin };
    const providerId = await ensureProvider(api, cookies, providerArgs, log);
    const baseCredentialArgs = {
      tenantId,
      providerId,
      name: args.credentialName ?? inferenceCredentialName(seed.provider.name),
      secret,
      type: args.credentialType ?? ("api_key" as const),
      verified: args.credentialVerified ?? false,
    };
    return ensureCredential(
      api,
      cookies,
      args.credentialMetadata !== undefined
        ? { ...baseCredentialArgs, metadata: args.credentialMetadata }
        : baseCredentialArgs,
      log,
    );
  }
  let credentialId: string;
  if (args.existingCredentialId !== undefined) {
    credentialId = args.existingCredentialId;
  } else if (credentialSecret !== undefined) {
    credentialId = await plantCredential(credentialSecret);
  } else {
    log(
      `catalog models for ${seed.provider.name} seeded without a credential; ` +
        `no workbench or workflow can launch against them until a ${seed.provider.name} API key is set — set it in the hub's own environment and restart (the env-key auto-plant, CL-6101, then plants it with no other step), or set it here and re-run: workbench seed`,
    );
    return {
      hasCompletionCapableModel: hasCompletionCapableModel(
        models,
        (model) => model.capabilities ?? [],
        (model) => model.canonicalName,
      ),
    };
  }
  const catalogProviderId = await ensureCatalogProvider(
    api,
    cookies,
    {
      tenantId,
      name: seed.provider.name,
      plugin: seed.provider.plugin,
      baseURL: providerBaseURL,
      credentialId,
    },
    log,
  );
  // Flatten the curated provider/model declaration order into one priority
  // sequence. Provider order still controls cross-provider fallback, while
  // model order makes each provider's declared default the first choice.
  let offeringPriorityOffset = 0;
  for (const [seedProvider, providerSeed] of Object.entries(CATALOG_SEEDS)) {
    if (seedProvider === provider) break;
    offeringPriorityOffset += providerSeed.models.length;
  }
  // What each deployment can do, resolved from the pinned catalog's probe
  // results. Until this, every seeded offering stored an empty capability
  // list, so no capability filter — this repo's concept resolution or the
  // platform's own source resolution — could answer anything. A deployment
  // the catalog has never probed still gets an empty list: an honest "not
  // known" beats a guess that routes real work to a model that cannot do it.
  const unprobed: string[] = [];
  const offeredCapabilities: {
    canonicalName: string;
    capabilities: readonly string[];
  }[] = [];
  for (const [modelIndex, model] of seededModels.entries()) {
    // Ollama's dynamic entries already carry their own live-probed
    // capabilities (`fetchOllamaModelCatalog`, CL-6366) — narrowed against
    // the real `Capability` enum here, the trust boundary, rather than
    // trusted as the instance reported them. Every curated seed entry has
    // no live probe of its own, so it still resolves from the pinned
    // catalog exactly as before.
    const capabilities =
      model.liveCapabilities !== undefined
        ? model.liveCapabilities.filter(
            (capability): capability is Capability =>
              !(Capability(capability) instanceof type.errors),
          )
        : capabilitiesForDeployment({
            plugin: seed.provider.plugin,
            baseURL: providerBaseURL,
            canonicalName: model.canonicalName,
          }).capabilities;
    if (capabilities.length === 0) unprobed.push(model.canonicalName);
    offeredCapabilities.push({
      canonicalName: model.canonicalName,
      capabilities,
    });
    // Ollama's own openai-compatible endpoint otherwise falls back to a
    // small built-in context window and `@intx/inference`'s built-in
    // adapter falls back to 4096 output tokens -- both silent, both
    // truncating a real conversation. `quirksForDeployment` resolves this
    // model's real ceiling (or `undefined` for a provider outside this
    // mechanism's scope, or a model this catalog has not vetted a ceiling
    // for), landing on the offering's `quirks` column exactly the way
    // `capabilitiesForDeployment` lands on its `capabilities` column.
    const quirks = quirksForDeployment({
      providerName: seed.provider.name,
      canonicalName: model.canonicalName,
    });
    await ensureCatalogOffering(
      api,
      cookies,
      {
        tenantId,
        modelId: model.id,
        providerId: catalogProviderId,
        priority: offeringPriorityOffset + modelIndex,
        capabilities,
        ...(quirks !== undefined ? { quirks } : {}),
      },
      log,
    );
  }
  if (unprobed.length > 0) {
    log(
      `no capability data for ${unprobed.join(", ")} — these models are listable and launchable, but nothing that picks a model by what it can do will offer them yet`,
    );
  }

  log(
    `catalog ready: ${seed.provider.name}/${models.map((m) => m.canonicalName).join(", ")}`,
  );
  return {
    hasCompletionCapableModel: hasCompletionCapableModel(
      offeredCapabilities,
      (offering) => offering.capabilities,
      (offering) => offering.canonicalName,
    ),
  };
}
