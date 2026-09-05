// Per-step env builder for the workflow-process child: stands up each
// step invocation's storage/workspace/audit/directors, resolves the
// step's ordered inference-source failover chain, materializes the
// step's pinned tool-package closure, and wires the supervisor-backed
// outbound mail transport.

import fs from "node:fs";
import path from "node:path";

import type { RepoId } from "@intx/hub-sessions/substrate";
import { createDependencies, type AdapterRegistry } from "@intx/inference";
import {
  createIsogitStorage,
  createNodeIsogitRuntime,
} from "@intx/storage-isogit/node";
import type { RegistryConfig } from "@intx/tool-packaging";
import type {
  AuditStore,
  ContextStore,
  MessageTransport,
} from "@intx/types/runtime";
import type { StepInvokeRequest } from "@intx/workflow";
import {
  createSupervisorBackedTransport,
  type ChildOutboundMailBridge,
  type CredentialWiring,
  type SourcesSnapshotRef,
  type StepEnvBase,
  type SupervisorBackedTransportInbound,
} from "@intx/workflow-host";

import type { DurableConversationRegistry } from "../conversation-state";
import {
  attachStepCredentials,
  attachStepTools,
  materializeStepTools,
  type StepToolCacheConfig,
  type StepToolMaterialization,
} from "../step-agent-tools";
import {
  SUMMARIZE_BUDGETED_TURNS_NAME,
  SUMMARIZE_OLDER_TURNS_NAME,
  createBudgetedContextCompactor,
  createSummarizeOlderTurnsCompactor,
} from "./compactors";
import { createStepInferenceSourceResolver } from "./config";
import {
  resolveContextBudgetChars,
  resolveHardContextLimitChars,
} from "./context-budget";
import { stepStorageRoot, warmStepStorageRoot } from "./storage-paths";
import { createWorkbenchDirectorRegistry } from "./workbench-director";

// Registered once and reused across every step env this builder produces:
// the compactor is a pure, stateless `Compactor` (see `./compactors`), so
// one instance can serve every step's `env.compactors` map. Registering it
// here (CL-6204) makes the name resolvable to any director that names it
// via `caps.compact("summarize-older-turns", reason)`.
const stepCompactors = {
  [SUMMARIZE_OLDER_TURNS_NAME]: createSummarizeOlderTurnsCompactor(),
};

const isogitStorage = createIsogitStorage(createNodeIsogitRuntime());

export interface SidecarStepBuildEnvDeps {
  dataDir: string;
  workflowRunRepoId: RepoId;
  signer: (payload: string) => Promise<string>;
  /**
   * Tool-package registries per-step materialization resolves against,
   * parsed from the boot-edge-threaded `SIDECAR_TOOL_REGISTRIES`
   * substrate-config entry.
   */
  registries: ReadonlyMap<string, RegistryConfig>;
  /**
   * Deployment mailbox address the supervisor threaded into the child
   * (`MAILBOX_ADDRESS`). Used to locate each step's on-disk deploy tree
   * for tool materialization (see `stepDeployTreeDir`) AND as the step
   * agent's outbound mail `address`: the supervisor signs the agent's
   * outbound mail as this address through the host transport (OUTBOUND
   * half of mailbox ownership). For the single-step launched-agent
   * deploy this is the legacy `ins_<hex>` identity the host registered
   * the agent's `CryptoProvider` against.
   */
  mailboxAddress: string;
  /**
   * Step count of the deployed `WorkflowDefinition` (`stepOrder.length`),
   * threaded from the host through the spawn-time env. Selects the
   * head/step collapse when locating a step's deploy tree
   * (`stepDeployTreeDir` -> `resolveStepAddress`): a single-step
   * deployment reads at the head, a multi-step deployment at the per-step
   * address, matching the host's producer push.
   */
  stepCount: number;
  /**
   * Child-side outbound-mail bridge over the upstream control channel
   * (OUTBOUND half of mailbox ownership). The per-step env builder
   * wraps it in a supervisor-backed `MessageTransport` it supplies as
   * the step agent's `env.transport`; the agent's mail tools call
   * `transport.send`, which routes through the bridge to the supervisor
   * for the actual signed send. The step agent never holds the signing
   * key.
   */
  outboundMailBridge: ChildOutboundMailBridge;
  /**
   * Inbound local IMAP surface for the step agent's supervisor-backed
   * transport (INBOUND half of mailbox ownership): the child mailbox reader
   * (a fresh committed snapshot of the deployment's substrate `INBOX` per
   * read), the shared watch registry the child's control loop fires
   * `mailbox.notify` into, and the mutation bridge flag/expunge writes ride
   * to the supervisor on. Present, `mail_read` / `mail_search` / `mail_wait`
   * resolve against the committed mailbox; absent, the inbound methods stay
   * inert.
   */
  inbound?: SupervisorBackedTransportInbound;
  /** Per-step tool-loader caps (cache + registry tarball size). */
  cache: StepToolCacheConfig;
  /**
   * The hub's plain HTTP origin (derived from `HUB_WS_URL` via
   * `deriveHubHttpUrl`) and the same `SIDECAR_TOKEN` bearer the child
   * already carries for pack-push. Carried on `env` beyond `BaseEnv` so
   * a workflow-artifacts tool bundle (`@corbits/artifact-tools`,
   * `requires: ["hubArtifactsUrl", "sidecarToken", "address"]`) can call
   * the sanctioned workflow-artifacts HTTP surface
   * (`@corbits/artifacts-hub`'s `createWorkflowArtifactRoutes`, CL-6000)
   * without ever holding a database handle. `address` is already on
   * `env` via `mailboxAddress` below; these two widen the same surface.
   * The same origin is re-exposed on the step env as `hubMemoryUrl` for
   * `@corbits/memory-tools` (`requires: ["hubMemoryUrl", "sidecarToken",
   * "address"]`), which calls the sibling workflow-memory HTTP surface
   * (`@corbits/memory-hub`'s `createWorkflowMemoryRoutes`, CL-5852), and
   * again as `hubSkillsUrl` for `@corbits/tools-skills`, which calls
   * `@corbits/skills`' `createWorkflowSkillRoutes`.
   */
  hubArtifactsUrl: string;
  sidecarToken: string;
  /**
   * The deploying `WorkflowDefinition`'s own id, threaded from the
   * substrate factory's `WORKFLOW_DEFINITION_REPO_ID` substrate-config
   * entry (`spec.definition.id` at deploy time, see
   * `apps/sidecar/src/workflow-host-wiring/index.ts`'s
   * `buildDeploymentRecord`). Carried on the step env beyond `BaseEnv`
   * exactly like `hubArtifactsUrl`/`sidecarToken`/`address` above so
   * `@corbits/capability-tools` (`requires: ["hubCapabilitiesUrl",
   * "sidecarToken", "address", "definitionId"]`) can name its OWN
   * definition when calling the workflow-run-authenticated capabilities
   * route — the run's definitionId has no other sanctioned way to reach
   * a tool execution (see the [Intx gap] note in
   * `@corbits/capability-tools`'s `tool.ts`, now closed on the workbench
   * side by this field).
   */
  definitionId: string;
  /**
   * Adapter registry the step agent resolves inference adapters through.
   * The child builds this eagerly at boot from the validated
   * `SIDECAR_ADAPTER_MANIFEST` (built-ins merged with operator custom
   * adapters) and the env builder sets it on `env.deps`, so a step whose
   * source names a custom provider resolves in the child exactly as it
   * does on the sidecar main path. Without it the step agent would fall
   * back to `createAgent`'s built-ins-only default and a custom-provider
   * source would fail to resolve at run time.
   */
  adapters: AdapterRegistry;
  /**
   * Durable-conversation registry for the warm single-step agent.
   * When present, the env builder swaps the per-run isogit
   * `ContextStore` for a per-agent durable store whose conversation is
   * mirrored to the workflow-run substrate, and restores the prior
   * conversation from the substrate before returning the env (so the
   * agent's reactor `load()` and the warm cache's lazy build see the
   * restored turns -- including the respawn-rebuild path). Absent for a
   * multi-step deploy, whose per-step agents are not warm/long-lived and
   * need no cross-run conversation durability.
   */
  durableConversation?: DurableConversationRegistry;
}

/**
 * Build the step-invoker `buildEnv` callback the workflow-host's
 * adapter consumes. Pulled out of `createSidecarSubstrateFactory` so
 * the per-step env construction is observable without standing up the
 * full substrate.
 *
 * The closure reads the per-step source table from the mutable
 * reference passed per build, derives the `stepId` / `runId` / `attempt`
 * from the runtime's `AuthorizeContext`, resolves the per-step
 * `InferenceSource` from that table, and stands up
 * a per-step isogit `ContextStore` (also serving as the audit store)
 * plus a per-step workspace directory rooted under the run. A
 * construction failure (mkdir, isogit init) surfaces here rather than
 * being papered over with a stub: the single-step path now always runs
 * a real agent against real storage.
 */
export function createSidecarStepBuildEnv(
  deps: SidecarStepBuildEnvDeps,
): (
  req: StepInvokeRequest,
  sourcesRef: SourcesSnapshotRef,
  credentialWiring?: CredentialWiring,
) => Promise<StepEnvBase> {
  return async (
    req: StepInvokeRequest,
    sourcesRef: SourcesSnapshotRef,
    credentialWiring?: CredentialWiring,
  ): Promise<StepEnvBase> => {
    // Resolve against the live table each build so a source rotation that
    // wrote `sourcesRef.current` before this build is reflected in the
    // agent this build constructs. A warm agent that is already built does
    // not pass through here again, so a rotation does not reach it through
    // this path -- this ref covers only a build that has not happened yet.
    const resolveStepInferenceSource = createStepInferenceSourceResolver(
      sourcesRef.current,
    );
    const { stepId, runId, attempt } = req.authzContext;
    if (stepId === undefined) {
      throw new Error(
        "sidecar workflow-child step invoker buildEnv: AuthorizeContext.stepId is required for per-step InferenceSource resolution; the workflow runtime must populate stepId on every step-originated invocation",
      );
    }
    if (runId === undefined) {
      throw new Error(
        "sidecar workflow-child step invoker buildEnv: AuthorizeContext.runId is required to root per-step storage under the run; the workflow runtime must populate runId on every step-originated invocation",
      );
    }
    if (attempt === undefined) {
      throw new Error(
        "sidecar workflow-child step invoker buildEnv: AuthorizeContext.attempt is required to root per-step storage per attempt; the workflow runtime must populate attempt on every step-originated invocation",
      );
    }
    const sources = resolveStepInferenceSource(stepId);
    // The resolver's arktype guarantees a non-empty chain; assert it here so
    // the reactor's initial-source pin (element 0) is a checked fact rather
    // than an unchecked index.
    const activeSource = sources[0];
    if (activeSource === undefined) {
      throw new Error(
        `sidecar workflow-child step invoker buildEnv: empty InferenceSource chain pinned for stepId ${JSON.stringify(stepId)}`,
      );
    }

    // Context-window budget for this step's active source (CL-6204):
    // sized from `activeSource.quirks`/`activeSource.model` so a 128K
    // model and a 32K model compact at different points rather than
    // sharing one constant. Built per invocation (not module scope)
    // because the budget depends on the step's own resolved source.
    const contextBudgetChars = resolveContextBudgetChars(
      activeSource.quirks,
      activeSource.model,
    );
    const contextHardLimitChars = resolveHardContextLimitChars(
      activeSource.quirks,
      activeSource.model,
    );
    const stepDirectors = createWorkbenchDirectorRegistry({
      budgetChars: contextBudgetChars,
      hardLimitChars: contextHardLimitChars,
      compactorName: SUMMARIZE_BUDGETED_TURNS_NAME,
    });
    const compactors = {
      ...stepCompactors,
      [SUMMARIZE_BUDGETED_TURNS_NAME]:
        createBudgetedContextCompactor(contextBudgetChars),
    };

    // Root the per-step scratch (workspace + tool tarball-cache +
    // apply-state). The cold (multi-step) path keys it per
    // run/step/attempt: each run rebuilds the agent and its scratch, and
    // the run's whole `runs/<runId>/` subtree is reclaimed on run
    // completion. The warm single-step path (`durableConversation`
    // present) keys it STABLY per agent so the cached agent reuses one
    // workspace across every message -- bounding the warm case to one
    // dir per agent and letting that workspace survive child respawn --
    // and the subtree is reclaimed on undeploy. The two keyings live
    // under disjoint `runs/` and `warm/` sub-roots so neither sweep
    // touches the other's tree, and the durable conversation under
    // `agent-conversation-state/` is a different root that neither
    // sweep touches.
    const storeDir =
      deps.durableConversation !== undefined
        ? warmStepStorageRoot({
            dataDir: deps.dataDir,
            workflowRunRepoId: deps.workflowRunRepoId,
            stepId,
          })
        : stepStorageRoot({
            dataDir: deps.dataDir,
            workflowRunRepoId: deps.workflowRunRepoId,
            runId,
            stepId,
            attempt,
          });
    // Conversation storage. For the warm single-step agent the
    // conversation must survive child respawn, so it is backed by a
    // per-agent durable store (keyed by stepId) whose content is mirrored
    // to the workflow-run substrate under
    // `agent-state/<stepId>/<workbenchId>/`. Bind to the originating
    // workbench happens before this builder runs so restore is already
    // applied. A multi-step deploy (no durable registry) keeps the
    // per-run isogit store.
    const storage: ContextStore & AuditStore =
      deps.durableConversation !== undefined
        ? (await deps.durableConversation.acquire(stepId)).storage
        : await isogitStorage.createIsogitStore(storeDir, deps.signer);
    const workdir = path.join(storeDir, "workspace");
    await fs.promises.mkdir(workdir, { recursive: true });

    // Materialize the step's pinned tool-package closure (posix, LSP,
    // mail, ...) from its on-disk deploy tree, rooted per step under
    // `storeDir` so concurrent steps in one child never collide on the
    // tarball cache or the apply-state tree. A deploy with no manifest
    // yields empty tools (the legitimate `rawManifestBytes === undefined`
    // case); a present-but-broken manifest surfaces loudly through
    // `materializeStepTools` rather than degrading to empty tools.
    //
    // An onTrigger body step (CL-6448) materializes through the same call:
    // for the single-step section deployment the head/step collapse in
    // `stepDeployTreeDir` reads the deployment's own staged manifest --
    // exactly the body agent's pins the folded launch staged -- and a
    // deployment that staged no tree for the body's stepId reads ENOENT
    // into the legitimate empty-tools case.
    const materialization: StepToolMaterialization = await materializeStepTools(
      {
        dataDir: deps.dataDir,
        mailboxAddress: deps.mailboxAddress,
        stepId,
        stepCount: deps.stepCount,
        storeDir,
        cache: deps.cache,
        registries: deps.registries,
      },
    );

    // Supervisor-backed transport for the step agent's mail tools (both
    // halves of mailbox ownership). Outbound (`send`) routes over the
    // control IPC to the supervisor, which performs the actual signed send
    // through the host transport as `address`: the deployment mailbox
    // address, the same identity the host registered the agent's
    // `CryptoProvider` against, so the outbound mail carries the agent's
    // signature with parity to the in-process path. Inbound
    // (`deps.inbound`) makes `mail_read` / `mail_search` / `mail_wait`
    // resolve locally against a fresh committed snapshot of the
    // deployment's substrate `INBOX`. Both `transport` and `address` are
    // the env keys `@intx/tools-mail`'s sidecar bundle declares in its
    // `requires`.
    const transport = createSupervisorBackedTransport(
      deps.outboundMailBridge,
      deps.mailboxAddress,
      deps.inbound,
    );

    // The step env carries `transport` + `address` beyond `BaseEnv` so
    // the mail-tool bundle (`@intx/tools-mail`, `requires: ["transport",
    // "address"]`) resolves its handles. The two keys are extra env
    // surface the tool factory reads at handler-init; they widen the
    // returned `StepEnvBase` structurally, which the buildEnv return
    // type (`StepEnvBase`) accepts (a wider object is assignable to the
    // narrower type).
    const env: StepEnvBase & {
      transport: MessageTransport;
      address: string;
      hubArtifactsUrl: string;
      hubMemoryUrl: string;
      hubSkillsUrl: string;
      hubCapabilitiesUrl: string;
      hubRoutinesUrl: string;
      hubConnectionsUrl: string;
      hubCatalogUrl: string;
      hubAgentDirectoryUrl: string;
      hubChatUrl: string;
      hubWorkflowAuthoringUrl: string;
      sidecarToken: string;
      definitionId: string;
    } = {
      // Feed the reactor the step's full ordered failover chain and pin
      // its initial source to element 0. The reactor resolves the initial
      // source by id and fails over forward through `sources`, so this
      // restores cross-source failover inside the workflow-child.
      sources,
      defaultSource: activeSource.id,
      storage,
      workdir,
      audit: storage,
      directors: stepDirectors,
      compactors,
      // Resolve inference adapters through the child's boot-built
      // registry (built-ins + operator custom adapters), so a
      // custom-provider step source resolves in the child the same way
      // it does on the sidecar main path rather than hitting
      // `createAgent`'s built-ins-only default.
      deps: createDependencies(deps.adapters),
      transport,
      address: deps.mailboxAddress,
      hubArtifactsUrl: deps.hubArtifactsUrl,
      // Same hub HTTP origin as `hubArtifactsUrl` above, under the key
      // `@corbits/memory-tools` declares (`requires: ["hubMemoryUrl",
      // "sidecarToken", "address"]`) — one hub origin, two accurately
      // named env keys per tool-bundle surface, matching the artifact
      // bundle's own precedent rather than overloading its name for an
      // unrelated surface.
      hubMemoryUrl: deps.hubArtifactsUrl,
      // And once more under the key `@corbits/tools-skills` declares
      // (`requires: ["hubSkillsUrl", "sidecarToken", "address"]`) for the
      // skill registry's own run-authenticated surface.
      hubSkillsUrl: deps.hubArtifactsUrl,
      // Same hub HTTP origin again, under the key
      // `@corbits/capability-tools` declares (`requires:
      // ["hubCapabilitiesUrl", "sidecarToken", "address",
      // "definitionId"]`) for its workflow-run-authenticated capabilities
      // surface.
      hubCapabilitiesUrl: deps.hubArtifactsUrl,
      // Same hub HTTP origin again, under the keys the Myra manager-tools
      // bundles declare (CL-5879 follow-up: connections-tools,
      // agent-directory-tools) for their own
      // workflow-run-authenticated surfaces — one hub origin, one env key
      // per tool-bundle surface, matching every precedent above rather
      // than overloading an existing name for an unrelated surface.
      hubRoutinesUrl: deps.hubArtifactsUrl,
      hubConnectionsUrl: deps.hubArtifactsUrl,
      // And once more under the key `@corbits/catalog-tools` declares
      // (`requires: ["hubCatalogUrl", "sidecarToken", "address"]`) for the
      // inference catalog's own run-authenticated surface.
      hubCatalogUrl: deps.hubArtifactsUrl,
      hubAgentDirectoryUrl: deps.hubArtifactsUrl,
      hubChatUrl: deps.hubArtifactsUrl,
      // And under the key `@corbits/workflow-authoring-tools` declares
      // (`requires: ["hubWorkflowAuthoringUrl", "sidecarToken", "address"]`)
      // for `@corbits/workflows`'s `./authoring`'s run-authenticated routes.
      hubWorkflowAuthoringUrl: deps.hubArtifactsUrl,
      sidecarToken: deps.sidecarToken,
      definitionId: deps.definitionId,
    };
    // Carry the materialized tool runtime to the tool-bearing
    // `agentFactory` via the env's symbol-keyed slot. The step-invoker
    // adapter spreads this env (`{ ...envBase, authorize }`) before
    // handing it to `agentFactory`; object spread preserves own
    // symbol-keyed properties, so the slot survives the spread.
    attachStepTools(env, materialization);
    // Carry this step's live credential wiring the same way, so the
    // tool-bearing `agentFactory` can shape a consumer-scoped
    // `credentials` capability for any tool package that declares one.
    if (credentialWiring !== undefined) {
      attachStepCredentials(env, { wiring: credentialWiring, stepId });
    }
    return env;
  };
}
