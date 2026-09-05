// Thin wiring module that constructs `createWorkflowSupervisor` with
// this sidecar's host-specific bindings: the existing mail-bus
// instance, the sidecar's Ed25519 signing keypair, the substrate
// RepoStore handle, and `Bun.spawn` as the subprocess spawner. Any
// logic that would benefit a future alternative-sidecar
// implementation lives inside `@intx/workflow-host`, not here.

import { rm } from "node:fs/promises";
import { join as pathJoin } from "node:path";

import { type } from "arktype";

import { derivePublicKeyBytes } from "@intx/crypto";
import { getLogger } from "@intx/log";
import type { HubTransport } from "@intx/mail-memory";
import { parseAgentId, type RepoStore } from "@intx/hub-sessions";
import type {
  AgentKeyStore,
  DeployRouter,
  DeployRouterResult,
  SessionManager,
} from "@intx/hub-agent";
import { reportError } from "@corbits/error-sink";
import {
  type DeriveStepAddress,
  type DispatchTimingMark,
  type SpawnOpts,
  type SubprocessSpawner,
  type SuspensionRegistration,
} from "@intx/workflow-host";
import { hexEncode, isRunAddress } from "@intx/types";
import { IDLE_HIBERNATE_UNDEPLOY_REASON } from "@corbits/agent-lifecycle";
import {
  parseInferenceEvent,
  type CryptoProvider,
  type InferenceEvent,
  type InferenceSource,
  type KeyPair,
} from "@intx/types/runtime";
import {
  WorkflowProjectionDefinition,
  type AgentDeployFrame,
} from "@intx/types/sidecar";
import { projectLiveToInert } from "@intx/workflow";

import type {
  MultistepCredentialsRouter,
  MultistepDrainRouter,
  MultistepGrantsRouter,
  MultistepMailRouter,
  MultistepSignalRouter,
  MultistepSourcesRouter,
} from "../workflow-run-pack-client";
import {
  WorkflowRestoreFailure,
  clearWorkflowDeploymentRestoreFailure,
  deleteWorkflowDeploymentRecord,
  isWorkflowDeploymentRestoreQuarantined,
  markWorkflowDeploymentRecordParked,
  partitionScannedDeployments,
  readWorkflowDeploymentRecord,
  recordWorkflowDeploymentRestoreFailure,
  scanWorkflowDeploymentRecords,
  writeWorkflowDeploymentRecord,
  type WorkflowDeploymentRecord,
} from "../workflow-deployment-record";
import { runWithConcurrency } from "../concurrency";
import {
  reapExpiredHibernationSnapshots as reapVaultSnapshots,
  restoreAgentIdentity,
  snapshotAgentIdentity,
} from "../hibernated-agent-identity-vault";
import { isErrnoNotFound } from "../conversation-state";
import {
  computeWireDefinitionHash,
  validateWorkflowProjection,
} from "./wire-validation";
import { defaultSubprocessSpawner } from "./transport";

export { defaultSubprocessSpawner };
import {
  createSidecarWorkflowSupervisor,
  type SidecarWorkflowSupervisor,
} from "./supervisor";

export {
  deriveSidecarMailAuditRef,
  type CreateSidecarWorkflowSupervisorOpts,
} from "./supervisor";
export { createSidecarWorkflowSupervisor, type SidecarWorkflowSupervisor };
import {
  createStepStrategy,
  deriveDeploymentId,
  writeStepGrants,
} from "./step-strategy";

export { deriveDeploymentId };
import { materializeWorkflowSources } from "./asset-materialization";
import {
  deploymentSourceAssetRoot,
  deploymentSourceGitRoot,
  materializeDeploymentClosure,
} from "./closure-staging";
import {
  MAX_INLINE_ASSET_PAYLOAD_BYTES,
  materializeWorkflowAssets,
} from "../source-asset-delivery";

export { computeWireDefinitionHash, validateWorkflowProjection };

const logger = getLogger(["sidecar", "workflow-host-wiring"]);

/**
 * Env key the multi-step branch uses to carry each step's ordered
 * inference-source failover chain from `frame.workflow.sources` down to
 * the workflow-process child. The substrate factory's `buildEnv` reads
 * this and resolves a step's chain at step invocation, feeding it to the
 * reactor for forward-only failover; the supervisor itself is opaque to
 * the value (it is plumbed through `bindings.substrateEnv` verbatim).
 *
 * Listed here so the router and the future substrate-factory consumer
 * spell the key the same way without a magic-string trip hazard.
 */
export const STEP_INFERENCE_SOURCES_ENV_KEY = "STEP_INFERENCE_SOURCES";

/**
 * How long a teardown (`teardownDeployment`, and the process-exit drain)
 * waits for a supervisor's own graceful `shutdown()` (child signal + await
 * exit) before also sending SIGKILL to the child directly via
 * `hardKillChild`. Bounds a teardown's worst case to this window rather
 * than however long a wedged child's own shutdown sequencing takes.
 */
export const CHILD_KILL_ESCALATION_MS = 3000;

/**
 * How long `teardownDeployment` waits for the supervisor's own `drain` to
 * let an in-flight step settle -- so its resulting workflow-run event
 * commit (and the pack push that commit triggers) lands -- before the
 * child comes down. Bounded so a wedged or long-running step cannot hang
 * teardown indefinitely; mirrors `CHILD_KILL_ESCALATION_MS`'s bounded-wait
 * shape.
 */
export const TEARDOWN_DRAIN_DEADLINE_MS = 5000;

/**
 * How many workflow deployment records `restoreWorkflowDeployments` restores
 * at once. Bounded, not unbounded, so a host with many live records at boot
 * cannot storm the OS with concurrent `Bun.spawn` calls all at once; 8 is
 * comfortably below typical per-process fd/thread pressure from a handful of
 * child processes while still cutting a boot with dozens of records from
 * minutes of serial restore to a few bounded rounds.
 */
export const RESTORE_CONCURRENCY = 8;

/**
 * Ceiling on a single `restoreDeploymentFromRecord` attempt. A restore
 * candidate can wedge indefinitely -- a stalled closure fetch, a spawn that
 * never reports back -- and with a bounded worker pool one wedged record
 * pins its worker (and, at the extreme, every worker) for the rest of
 * boot. A restore that exceeds this deadline is treated as an ordinary
 * transient failure: counted on the record's `restoreFailure` counter,
 * logged, and skipped, so the boot moves on and the record gets another
 * attempt next boot (or quarantines after `RESTORE_QUARANTINE_THRESHOLD`
 * consecutive permanent failures). Overridable per router
 * (`deps.restoreAttemptTimeoutMs`) so a test can exercise the timeout path
 * in milliseconds instead of waiting out the real ceiling.
 */
export const RESTORE_ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * Bounds a boot-restore attempt to `timeoutMs` -- so `restoreWorkflowDeployments`'s
 * bounded worker pool frees this slot and moves on to the next record rather
 * than waiting on a wedged restore forever -- WITHOUT quietly abandoning the
 * restore itself (CL-7215). `work` receives an `AbortSignal` that fires the
 * instant the deadline wins, so a restore attempt that has not yet started
 * its closure fetch or its spawn can cancel itself for real rather than
 * running either to completion unobserved. Neither the closure fetch
 * (`@intx/tool-packaging`'s `applyAtomic`) nor the workflow-process spawn
 * (`@intx/workflow-host`'s `Supervisor.spawn`) accept a signal of their own,
 * so a restore already past both of `restoreDeploymentFromRecord`'s
 * checkpoints when the deadline fires keeps running -- but it corrects its
 * own durable record once it learns the true outcome instead of leaving a
 * live deployment recorded as a boot failure; see the `signal.aborted`
 * check around `spawnWorkflowDeployment` in `restoreDeploymentFromRecord`.
 */
function withRestoreTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  deploymentId: string,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const message = `restore of ${deploymentId} exceeded ${timeoutMs}ms`;
    const timer = setTimeout(() => {
      controller.abort(new Error(message));
      reject(new Error(message));
    }, timeoutMs);
    work(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Cooperative cancellation checkpoint for `restoreDeploymentFromRecord`
 * (CL-7215): called immediately before starting a phase of work that is
 * still avoidable -- the closure fetch, or the spawn itself -- so a restore
 * whose caller has already timed out stops advancing instead of spending
 * that work on an attempt nobody is waiting on anymore.
 */
function throwIfRestoreAborted(
  signal: AbortSignal,
  deploymentId: string,
): void {
  if (signal.aborted) {
    throw new Error(
      `restore of ${deploymentId} was cancelled after its boot-restore attempt timed out`,
    );
  }
}

/**
 * Await a supervisor's graceful `shutdown()`, escalating to a direct
 * SIGKILL of its child if `shutdown()` hasn't settled within
 * `CHILD_KILL_ESCALATION_MS` -- still awaiting `shutdown()` to completion
 * either way, never abandoning it.
 */
async function shutdownSupervisorWithEscalation(
  wired: SidecarWorkflowSupervisor,
): Promise<void> {
  const timer = setTimeout(() => {
    wired.hardKillChild();
  }, CHILD_KILL_ESCALATION_MS);
  timer.unref?.();
  try {
    await wired.supervisor.shutdown();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Derive the supervisor's principal public key from the sidecar's
 * Ed25519 signing seed. The supervisor signs every workflow-run event
 * with this key; the multi-step branch surfaces it to the link so the
 * hub records the verifying key for the deployment's signed events.
 */
async function derivePrincipalPublicKeyHex(
  signingKeySeed: Uint8Array,
): Promise<string> {
  return hexEncode(await derivePublicKeyBytes(signingKeySeed));
}

/**
 * The sidecar's `DeployRouter` plus the boot-time restore driver. The link
 * routes `agent.deploy`/`agent.undeploy` through the `DeployRouter` surface;
 * the sidecar boot edge additionally calls `restoreWorkflowDeployments` once,
 * before connecting to the hub, to re-establish the deployments a prior
 * process persisted. The extra method is sidecar-app-only, so it rides on the
 * concrete router type rather than the shared `DeployRouter` contract.
 */
export interface SidecarDeployRouter extends DeployRouter {
  /**
   * Re-establish every persisted workflow deployment on this sidecar's local
   * substrate. Runs once at boot, before `hubLink.connect()`, so a single-step
   * head's mailbox/transport registration is live before the hub routes to it.
   * Soft-fails per deployment: a record that cannot be restored (unbuildable
   * provider, corrupt `deployment.json`, spawn failure) is logged and left on
   * disk for a later boot to retry -- it is never deleted here. A failure
   * that is deterministic given only the record's own bytes (a
   * `WorkflowRestoreFailure("permanent", ...)`, e.g. a corrupt/misplaced
   * record or a closure-derived definition that fails validation) is
   * tracked on the record and, after `RESTORE_QUARANTINE_THRESHOLD`
   * consecutive such failures, quarantined: later boots skip it entirely
   * rather than re-attempting and re-warning. A failure that depends on
   * this boot's environment (an unbuildable inference provider, and
   * anything else not explicitly classified permanent) never quarantines
   * and is retried every boot for as long as the record exists.
   */
  restoreWorkflowDeployments(): Promise<void>;
  /**
   * Sweep this sidecar's hibernated-agent-identity vault
   * (`hibernated-agent-identity-vault.ts`) for snapshots older than its
   * stated retention window and delete them, returning how many were
   * reaped for observability. Independent of `restoreWorkflowDeployments`
   * -- an orphaned snapshot (its address hibernated, then permanently
   * torn down without ever redeploying) has no relationship to that scan
   * and this does not touch its concurrency. Intended to run once at
   * boot, in either order relative to the restore scan.
   */
  reapExpiredHibernationSnapshots(): Promise<number>;
  /**
   * The workflow-substrate deployment addresses (`ins_dep_...`) this router
   * currently hosts a live supervisor for -- the set of addresses this
   * sidecar can route mail to. The boot edge announces these to the hub on
   * (re)connect so the hub re-registers them for routing: they are hub-minted
   * and carry no per-address key, so unlike single-agent sessions they are
   * not re-established by the challenge flow, and without this announcement
   * the hub drops their route on a WS reconnect. Reflects `deploy`/`undeploy`
   * and boot-time restore live, so a caller re-reads it per connect.
   */
  activeAddresses(): string[];
  /**
   * Process-exit drain: shut down every live supervisor so each
   * workflow-process child is released before the host exits, while
   * leaving all durable state -- deployment records and the durable
   * conversation root included -- on disk for the next boot's
   * `restoreWorkflowDeployments`. Distinct from `undeploy`, which
   * additionally reclaims the deployment's records and scratch.
   */
  shutdownAll(): Promise<void>;
  /**
   * Shared teardown body. `undeploy` calls this itself, choosing
   * `reclaimDirs` from `frame.reason`: `IDLE_HIBERNATE_UNDEPLOY_REASON`
   * (`@corbits/agent-lifecycle`, tagged by the hub's idle-reap sweep) gets
   * `false` (a state-preserving "hibernate"); every other reason gets the
   * destructive `true`. Also exposed directly on the router surface for a
   * caller that wants to choose the flavor itself. See `reclaimDirs`'s doc
   * comment on the internal `teardownDeployment` for the exact split
   * between the two flavors.
   */
  teardownDeployment(
    agentAddress: string,
    opts: { reclaimDirs: boolean },
  ): Promise<void>;
}

export function createSidecarDeployRouter(deps: {
  sessions: SessionManager;
  keyStore: AgentKeyStore;
  transport: HubTransport;
  repoStore: RepoStore;
  signingKeySeed: Uint8Array;
  /**
   * Per-agent crypto factory. Receives the agent's raw key pair and
   * returns a `CryptoProvider` bound to it (production wires
   * `@intx/crypto`'s `createEd25519Crypto`). The multi-step branch
   * uses this to register the spawned single-step agent's signing key on
   * the host transport before `spawn()`, so the supervisor's outbound
   * mail path (`MailBusBindings.sendOutbound`) signs the agent's replies
   * with the AGENT's identity -- the OUTBOUND half of mailbox ownership
   * (the mailbox-ownership contract). Without this registration the spawned agent's address has no
   * `CryptoProvider` on the transport (nothing else registers one for
   * it), and an outbound send would throw "address is not registered"
   * rather than emit unsigned mail.
   */
  createAgentCrypto: (keyPair: KeyPair) => CryptoProvider;
  /**
   * Source-admission gate: throws if a step's pinned inference source
   * names a provider this sidecar cannot build. The buildable-provider
   * set is sidecar config (the boot edge's adapter registry), so this
   * admission control lives at the sidecar -- the hub is a different
   * process and cannot know a given sidecar's providers. Production wires
   * the default harness builder's `canBuildSource` verbatim, so a rejected
   * provider carries the same `"... is not registered"` message.
   *
   * Distinct from the orchestrator's operator-approval check
   * (`pickStepInferenceSource`): that gates on whether the operator
   * approved a `provider:model`; this gates on whether the provider is
   * buildable at all. A source can be approved yet unbuildable.
   */
  assertSourceBuildable: (source: InferenceSource) => void;
  /**
   * Record a `(deploymentId -> agentAddress)` mapping the boot edge's
   * workflow-run pack push facade consults when it must address an
   * outbound pack frame. Fires once per inbound `agent.deploy` frame
   * before the deployment's supervisor spawns, so the first pack push
   * the child triggers sees the mapping. Tests that do not exercise
   * the pack push path may pass a no-op.
   */
  registerDeployment: (entry: {
    deploymentId: string;
    agentAddress: string;
  }) => void;
  /**
   * Symmetric removal hook for `registerDeployment`. Fires from the
   * link's `agent.undeploy` path so the boot edge's
   * `DeploymentAddressRegistry` drops the mapping when the deployment
   * is torn down. A subsequent stale `writeTreePreservingPrefix`
   * against the dead deployment's workflow-run ref surfaces
   * structurally (`registry.resolve` returns `null`) rather than
   * silently resolving to the prior address. Tests that do not
   * exercise the pack push path may pass a no-op.
   */
  unregisterDeployment: (entry: {
    deploymentId: string;
    agentAddress: string;
  }) => void;
  /**
   * Control-plane suspension sink threaded verbatim to every deployment's
   * supervisor as `onSuspensionRegister`. Production wires this to the
   * sidecar's hub link (`HubLink.sendSignalCorrelationRegister`) so an
   * ask-rail suspension's approval snapshot reaches the hub as a
   * `signal.correlation.register` frame and the hub co-writes the run's
   * routing + approval rows. Optional so a test that does not exercise the
   * approval-park path needs no hub-link stub; omitting it in production
   * means a workflow-child ask-suspend parks with no approval ever
   * registered.
   */
  registerSuspension?: (registration: SuspensionRegistration) => void;
  /**
   * Substrate-config env keys the multi-step branch propagates into
   * the workflow-process child's spawn-time env (see
   * `SIDECAR_SUBSTRATE_CONFIG_KEYS` in `workflow-substrate-factory.ts`).
   * The router merges `STEP_INFERENCE_SOURCES` on top per multi-step
   * frame. Defaults to an empty record so a router built without
   * substrate config (e.g. a test) needs no boot-edge threading.
   */
  multistepSubstrateEnv?: Record<string, string>;
  /**
   * Subprocess spawner the multi-step branch hands to the supervisor.
   * Defaults to the production `Bun.spawn`-backed
   * `defaultSubprocessSpawner`; tests inject a deterministic mock.
   */
  multistepSubprocessSpawner?: SubprocessSpawner;
  /**
   * Optional override for the resolved `bin/workflow-child` path the
   * multi-step branch hands to the supervisor. Production wiring uses
   * the package-local default; tests inject a sentinel value so the
   * mock spawner can assert on it.
   */
  multistepBinaryPath?: string;
  /**
   * Callback the supervisor invokes for every verified InferenceEvent
   * the workflow-process child publishes. The router threads the
   * deployment's agent address plus the deploy's session id through to
   * the callback so a downstream fan-out can route each event to the
   * hub timeline keyed to the right session. The `InferenceEvent` itself
   * is sessionless; the session id rides alongside it, sourced from the
   * deploy frame's `HarnessConfig.sessionId` per deployment. It is
   * optional because a deploy frame need not carry a session id (a
   * headless deployment with no hub-side session); the sink decides what
   * an absent session id means. Defaults to a no-op; production wiring
   * supplies the event publisher.
   */
  publishWorkflowInferenceEvent?: (
    agentAddress: string,
    event: InferenceEvent,
    sessionId: string | undefined,
    childRunId?: string,
  ) => void;
  /**
   * Optional override for the multi-step branch's per-step mail-address
   * derivation. Defaults to `${deploymentId}-${stepId}@<deploymentDomain>`
   * derived from the frame's agent address. Tests inject a deterministic
   * factory.
   */
  multistepDeriveStepAddress?: DeriveStepAddress;
  /**
   * Per-deployment-address mail handler registry the hub-link's
   * `mail.inbound` path consults before falling back to the legacy
   * session-routed delivery. The multi-step branch registers
   * `wired.routeInbound` against the deployment's mail address once
   * `supervisor.spawn` succeeds so inbound mail aimed at the
   * deployment address flows into the supervisor's mail-bus
   * subscription.
   *
   * Optional so tests that exercise the multi-step branch without an
   * end-to-end mail loop can omit the binding; an absent registry
   * simply means multi-step inbound mail cannot route through the
   * hub-link until the wiring is plumbed.
   */
  multistepMailRouter?: MultistepMailRouter;
  /**
   * Per-deployment-address signal handler registry the sidecar
   * hub-link's `signal.deliver` path consults. The multi-step branch
   * registers `wired.supervisor.deliverSignal` against the deployment's
   * mail address once `supervisor.spawn` succeeds so a hub-side
   * `signal.deliver` frame flows into the workflow-process child via
   * the IPC's `signal.deliver` payload. The child commits the
   * resulting `SignalReceived` event through its own substrate,
   * preserving the workflow-run repo's single-writer invariant on the
   * sidecar side.
   *
   * Optional so tests that exercise the multi-step branch without an
   * end-to-end signal loop can omit the binding; an absent registry
   * means hub-side signals cannot route through the hub-link until the
   * wiring is plumbed.
   */
  multistepSignalRouter?: MultistepSignalRouter;
  /**
   * Per-deployment-address drain handler registry the sidecar
   * hub-link's `drain.deliver` path consults. The multi-step branch
   * registers `wired.supervisor.drain` against the deployment's mail
   * address once `supervisor.spawn` succeeds so a hub-side
   * `drain.deliver` frame flows into the workflow-process child via
   * the IPC's `drain` payload and arms the supervisor's per-run
   * `drainTimeout` accumulators. Cancel-mode in-flight steps abort on
   * the child side; wait-mode steps continue. Accumulators commit a
   * signed `CancelRequested{origin: "supervisor-drain"}` against the
   * workflow-run repo when the deadline expires.
   *
   * Optional so tests that exercise the multi-step branch without an
   * end-to-end drain loop can omit the binding; an absent registry
   * means hub-side drain frames cannot route through the hub-link until
   * the wiring is plumbed.
   */
  multistepDrainRouter?: MultistepDrainRouter;
  /**
   * Per-deployment-address grants handler registry the sidecar
   * hub-link's `run.grants` path consults. Both deploy branches
   * register a handler against the deployment's mail address once
   * `supervisor.spawn` succeeds so a hub-side `run.grants` frame writes
   * the run's grants to `runs/<runId>/grants.json` in the deployment's
   * workflow-run repo -- durable next to the run's events, and shipped
   * to the hub with the repo's pack flow.
   *
   * Optional so tests that exercise deploys without a grants loop can
   * omit the binding; an absent registry means inbound `run.grants`
   * frames cannot route through the hub-link until the wiring is
   * plumbed.
   */
  multistepGrantsRouter?: MultistepGrantsRouter;
  /**
   * Per-deployment-address sources-rotation handler registry. Only a
   * single-step warm deployment registers a handler (against the
   * deployment's mail address once `supervisor.spawn` succeeds) so a
   * rotation resolved for its address flows into
   * `wired.supervisor.deliverSources` and on to the child's warm agent. A
   * multi-step deployment registers none -- it has no single warm agent to
   * rotate -- so `tryRoute` reports its address as unrouted.
   *
   * Optional so tests that exercise deploys without a rotation loop can
   * omit the binding; an absent registry means no rotation handler is
   * installed for any deployment.
   */
  multistepSourcesRouter?: MultistepSourcesRouter;
  /**
   * Per-deployment-address credential-delivery handler registry the sidecar
   * hub-link's `credentials.update` path consults. Registered for EVERY
   * deployment (not only warm single-step ones) once `supervisor.spawn`
   * succeeds -- the material cell is per-child and read by every step's
   * tool capabilities -- so a hub-side `credentials.update` frame dispatches
   * through the supervisor's `deliverCredentials`, refreshing the child's
   * material cell without ever persisting the secret to disk.
   *
   * Optional so tests that exercise deploys without a credential-rotation
   * loop can omit the binding; an absent registry means an inbound
   * `credentials.update` frame is unrouted for every deployment.
   */
  multistepCredentialsRouter?: MultistepCredentialsRouter;
  /**
   * Optional per-message dispatch-timing observer the multi-step branch
   * forwards to each supervisor it constructs. Resolved at the sidecar
   * boot edge from a benchmark env gate; absent in ordinary
   * production. The supervisor runs in this sidecar subprocess,
   * so the observer sees both ends of the per-message IPC round-trip in
   * one process and can emit a parseable timing line the benchmark
   * harness reads off the subprocess's output stream.
   */
  onDispatchTiming?: (mark: DispatchTimingMark) => void;
  /**
   * forced-repack A/B toggle the multi-step branch forwards to
   * each supervisor it constructs. Resolved at the sidecar boot edge from
   * the same benchmark env gate; absent in ordinary production.
   */
  repackEveryMessages?: { everyMessages: number };
  /**
   * Consumed-dedup retention horizon (ms) forwarded to every supervisor
   * the router constructs. The sidecar boot edge resolves the operator's
   * `CONSUMED_RETENTION_MS` config; absent, the supervisor applies
   * `DEFAULT_CONSUMED_RETENTION_MS` (24h). See the workflow-run kind
   * handler for the operator-owned horizon invariant.
   */
  consumedRetentionMs?: number;
  /**
   * Spawn ready-handshake timeout (ms) forwarded to every supervisor the
   * router constructs. The sidecar boot edge resolves the operator's
   * `CHILD_READY_TIMEOUT_MS` config; absent, the supervisor applies
   * `DEFAULT_READY_TIMEOUT_MS` (30s). A child that spawns but never
   * signals ready is killed and its spawn rejected rather than hanging
   * the deploy or boot-time restore.
   */
  readyTimeoutMs?: number;
  /**
   * Ceiling (ms) on a single boot-time `restoreDeploymentFromRecord`
   * attempt; see `RESTORE_ATTEMPT_TIMEOUT_MS`'s doc comment for what the
   * bound protects. Defaults to `RESTORE_ATTEMPT_TIMEOUT_MS`; overridable
   * so a test can exercise the timeout-and-late-settle path in
   * milliseconds instead of the real 30s ceiling.
   */
  restoreAttemptTimeoutMs?: number;
  /**
   * Deployment-record writer, injectable so a test can block or fail the
   * persist at a controlled point -- the natural seam for exercising a
   * recycle that interleaves the source-rotation persist window. Defaults
   * to the real `writeWorkflowDeploymentRecord`; production never overrides
   * it.
   */
  writeWorkflowDeploymentRecord?: typeof writeWorkflowDeploymentRecord;
  /**
   * Closure materializer, injectable so a test can stand in for the real
   * fetch + SRI-verify + layout + evaluate pass without publishing a package.
   * Defaults to the real `materializeDeploymentClosure`; production never
   * overrides it.
   */
  materializeDeploymentClosure?: typeof materializeDeploymentClosure;
}): SidecarDeployRouter {
  // Validate the signing seed at construction so a malformed key fails
  // sidecar boot rather than the first multi-step deploy, where the
  // public key is derived from it (`derivePrincipalPublicKeyHex`). The
  // seed also signs every workflow-run event via the supervisor.
  if (deps.signingKeySeed.length !== 32) {
    throw new Error(
      `sidecar deploy router: Ed25519 signing seed must be 32 bytes, got ${deps.signingKeySeed.length}`,
    );
  }
  const publishInferenceEvent =
    deps.publishWorkflowInferenceEvent ??
    ((
      _address: string,
      _event: InferenceEvent,
      _sessionId: string | undefined,
      _childRunId?: string,
    ): void => {
      /* no-op default: tests and production-without-a-publisher
         deployments do not consume events. */
    });
  const multistepSubstrateEnv = deps.multistepSubstrateEnv ?? {};
  // Sidecar data dir the deployment's per-step scratch is rooted under
  // (`<dataDir>/workflow-step-state/<deploymentId>/...`). Resolved once
  // from the boot-edge substrate env so the undeploy hook can reclaim
  // the whole subtree. Absent only when the router is wired without
  // substrate config (a test that never spawns a child), in which case
  // no child ever rooted scratch and the undeploy reclaim is correctly
  // skipped.
  const stepStateDataDir = multistepSubstrateEnv.SIDECAR_DATA_DIR;
  const persistDeploymentRecord =
    deps.writeWorkflowDeploymentRecord ?? writeWorkflowDeploymentRecord;
  const applyClosure =
    deps.materializeDeploymentClosure ?? materializeDeploymentClosure;
  const restoreAttemptTimeoutMs =
    deps.restoreAttemptTimeoutMs ?? RESTORE_ATTEMPT_TIMEOUT_MS;
  const multistepSpawner =
    deps.multistepSubprocessSpawner ?? defaultSubprocessSpawner;
  const multistepDeriveStepAddress: DeriveStepAddress =
    deps.multistepDeriveStepAddress ??
    (({ runId, stepId }) => `${runId}-${stepId}`);

  // Per-deployment supervisor tracking. The multi-step branch
  // constructs one `SidecarWorkflowSupervisor` per `agent.deploy`
  // frame; the supervisor owns the workflow-process child, its IPC
  // pipes, and its event-channel fd. The undeploy hook consults this
  // map to call `supervisor.shutdown()` so the child's lifetime ends
  // with the deployment.
  const activeSupervisors = new Map<string, SidecarWorkflowSupervisor>();

  // CL-7215: per-deployment FIFO serialization for the boot-restore
  // failure record. Three independent writers can touch the same on-disk
  // `deployment.json` around a timed-out restore -- the boot loop's own
  // catch (`recordWorkflowDeploymentRestoreFailure`), if the abandoned
  // restore later finishes anyway `restoreDeploymentFromRecord`'s
  // late-settle correction (`clearWorkflowDeploymentRestoreFailure`), and
  // `teardownDeployment`'s reclaim/park writes if an operator undeploys
  // or hibernates the address while a restore is still dangling -- and
  // without serialization a correction's disk READ can land before the
  // catch's disk WRITE, observe nothing to clear, and no-op, leaving the
  // catch's later write to permanently mismark a live deployment as
  // failed (or, symmetrically, the catch's write can land after a
  // reclaiming teardown deleted the record, resurrecting it with a false
  // failure for a deployment that no longer exists --
  // `recordWorkflowDeploymentRestoreFailure` re-reads from disk and
  // no-ops on a missing record specifically to make that resurrection
  // impossible). Queuing every writer through this lock, keyed by
  // deployment id, makes whichever runs last observe every prior one's
  // completed write; combined with the catch consulting
  // `activeSupervisors` (see below) while holding the lock, the final
  // on-disk state is correct regardless of ordering.
  const deploymentRecordLocks = new Map<string, Promise<unknown>>();
  function withDeploymentRecordLock<T>(
    deploymentId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prior = deploymentRecordLocks.get(deploymentId) ?? Promise.resolve();
    const settled = prior.then(fn, fn);
    deploymentRecordLocks.set(
      deploymentId,
      settled.then(
        () => undefined,
        () => undefined,
      ),
    );
    return settled;
  }

  // Synchronous single-flight guard for the deploy path. The real supervisor
  // does not exist until inside `spawnWorkflowDeployment`, so `deployMultiStep`
  // cannot reserve its `activeSupervisors` slot up front; instead it records
  // the address here synchronously, before its first await, and clears it in a
  // finally once the deploy settles. `activeSupervisors` is populated only
  // after `spawn` succeeds, so the has-check alone leaves a window in which two
  // same-address frames both pass and the loser's unwind deletes the winner's
  // live deployment record. This set closes that window: a second frame that
  // arrives while the first is mid-deploy is rejected before it touches any
  // durable state. Only the live deploy path reserves; the boot restore path
  // is serial and relies on the `activeSupervisors` backstop instead.
  const reservingDeployAddresses = new Set<string>();

  // Slug-collision tracking. `deriveDeploymentId` substitutes
  // disallowed characters with `-`, which is deterministic but lossy:
  // two distinct agent addresses can collapse to the same slug, and
  // a collision would let the second deploy silently overwrite the
  // first deploy's workflow-run repo state (the slug IS the repoId).
  // This map records the first-claimer; a subsequent deploy that
  // produces the same slug from a different address is rejected at
  // the router before any supervisor or repo state is touched.
  const slugClaims = new Map<string, string>();

  function claimSlug(deploymentId: string, agentAddress: string): void {
    const existing = slugClaims.get(deploymentId);
    if (existing !== undefined && existing !== agentAddress) {
      throw new Error(
        `deriveDeploymentId collision: agent addresses ${JSON.stringify(existing)} and ${JSON.stringify(agentAddress)} both project to deploymentId ${JSON.stringify(deploymentId)}`,
      );
    }
    // A same-address re-claim is a defensive no-op: the `activeSupervisors`
    // guard rejects a live re-deploy before claimSlug is re-invoked, and a
    // failed or undeployed deploy releases the slug first, so in practice
    // `existing` is only ever undefined or a different address here.
    slugClaims.set(deploymentId, agentAddress);
  }

  function releaseSlug(deploymentId: string, agentAddress: string): void {
    const existing = slugClaims.get(deploymentId);
    if (existing === agentAddress) slugClaims.delete(deploymentId);
  }

  // Reclaim a deployment address whose supervisor drove ITSELF to a terminal
  // phase (crash-loop latch, channel crash, recycle failure) without an
  // operator undeploy, so a redeploy of the same address succeeds without a
  // manual undeploy first. Runs re-entrantly as the supervisor's own
  // `onSelfTerminate` sink, so it never calls back into `wired.supervisor.*`.
  // It drops only in-memory routing state: the durable deployment record and
  // on-disk step state stay (the hub still believes the address is deployed,
  // and a boot restore re-spawns from the record), and the deployment
  // address registry is RETAINED because the supervisor's own terminal
  // `RunFailed` commit -- written after this sink fires -- resolves its run
  // address through it. Fully synchronous, so it cannot interleave with a
  // concurrent operator undeploy of the same address.
  function reclaimSelfTerminatedSupervisor(args: {
    deploymentId: string;
    agentAddress: string;
  }): void {
    if (!activeSupervisors.has(args.agentAddress)) return;
    deps.multistepMailRouter?.unregister(args.agentAddress);
    deps.multistepSignalRouter?.unregister(args.agentAddress);
    deps.multistepDrainRouter?.unregister(args.agentAddress);
    deps.multistepGrantsRouter?.unregister(args.agentAddress);
    deps.multistepSourcesRouter?.unregister(args.agentAddress);
    deps.multistepCredentialsRouter?.unregister(args.agentAddress);
    activeSupervisors.delete(args.agentAddress);
    deps.transport.unregister(args.agentAddress);
    releaseSlug(args.deploymentId, args.agentAddress);
  }

  /**
   * The per-deployment inputs the shared spawn core needs to stand up a
   * workflow deployment, independent of the live deploy frame. The live
   * deploy path builds this from `frame`/`projection`; a boot-time restore
   * path builds the same shape from the persisted deployment record.
   */
  interface WorkflowDeploySpec {
    agentAddress: string;
    /**
     * The runnable definition, projected to its inert wire shape. Always the
     * closure evaluation (`projectLiveToInert(applied.definition)`), never a
     * frame-carried inline definition -- the deploy frame carries none. Both
     * the deploy path and the boot-time restore derive it the same way, from
     * the materialized closure.
     */
    definition: WorkflowProjectionDefinition;
    sources: NonNullable<AgentDeployFrame["workflow"]>["sources"];
    /** Correlates the child's inference events to the deploy's session. */
    sessionId: string | undefined;
    /**
     * Hub public key recorded at the head for deploy-pack verification and
     * inbound hub-frame verification. Required for a single-step
     * deployment (whose head IS the agent identity); undefined for a
     * genuine multi-step deployment, which derives per-step addresses and
     * records no head key.
     */
    hubPublicKey: string | undefined;
    /**
     * The hub-approved wire hash the deploy frame carried. The child's
     * `DEFINITION_HASH` is sourced from this hub authority, never a sidecar
     * recompute, so a closure that no longer projects to the approved content
     * cannot run.
     */
    approvedWireHash: string;
    /**
     * Sidecar-local directory of the materialized closure. The spawn core
     * threads it into the child's env so the run child evaluates the pinned
     * code to a live definition. Never travels on the deploy frame and is
     * never persisted -- a restore re-materializes it from `sourceRef`.
     */
    closurePackageDir: string;
    /**
     * The source-ref pin the deployment record persists so a boot-time restore
     * can re-materialize the pinned code. Its `source` carries no secret (the
     * registry token resolves from env at apply time); its `closure` is frozen
     * versions + SRIs.
     */
    sourceRef: NonNullable<AgentDeployFrame["workflow"]>["sourceRef"];
    /**
     * Decrypted credential material from the deploy frame's
     * `workflow.credentials`, threaded to the supervisor's
     * `credentialDelivery` binding so the child's materialRef is seeded
     * before the first trigger. Frame-only and never persisted (secrets
     * stay off disk), so the boot-restore path rebuilds the spec without
     * it and the deployment waits for the hub's `credentials.update` push.
     */
    credentials: NonNullable<AgentDeployFrame["workflow"]>["credentials"];
  }

  /**
   * Build the durable deployment record from a spec and a source table. The
   * table is a parameter (not `spec.sources`) so the deploy path writes the
   * deploy-time sources while the rotation handler writes the live-rotated
   * ones -- both through one shape, so a rotation persists the same record a
   * boot-time restore reseeds from.
   */
  function buildDeploymentRecord(
    spec: WorkflowDeploySpec,
    sources: WorkflowDeploymentRecord["sources"],
  ): WorkflowDeploymentRecord {
    // `exactOptionalPropertyTypes` rejects `{ field: undefined }` for these
    // optional record fields, so an absent value must omit the key entirely
    // rather than assign `undefined` to it -- hence one conditional-spread
    // per optional field, folded into this single literal.
    return {
      version: 1 as const,
      agentAddress: spec.agentAddress,
      definitionId: spec.definition.id,
      sources,
      ...(spec.sessionId !== undefined ? { sessionId: spec.sessionId } : {}),
      ...(spec.hubPublicKey !== undefined
        ? { hubPublicKey: spec.hubPublicKey }
        : {}),
      approvedWireHash: spec.approvedWireHash,
      sourceRef: spec.sourceRef,
    };
  }

  /**
   * The single owner of the workflow-deployment spawn sequence: construct
   * the supervisor, register the single-step agent's outbound key + head
   * repo + hub key, spawn the workflow-process child, then register the
   * live deployment (supervisor, mail/signal/drain routers, address
   * mapping). Its `try/finally` unwinds every piece of partial state if any
   * step throws, so a failed spawn leaks nothing. Both the live deploy path
   * and the boot-time restore path route through here so the two can never
   * diverge on how a deployment is stood up. Callers materialize the
   * deploy-only durable state (the source closure, step grants) before
   * calling.
   */
  async function spawnWorkflowDeployment(
    spec: WorkflowDeploySpec,
  ): Promise<DeployRouterResult> {
    // Fail loud if this address already has a live supervisor. Both single-
    // and multi-step now register on the transport, so both carry the
    // `transport.register` duplicate-throw backstop; this `has()` check is the
    // primary early guard that gives a clean error before that lower-level
    // throw and before the `activeSupervisors.set` below could clobber the
    // running deployment's handle. Both the deploy path and the boot restore
    // path route through here, so this is the single transition guard against
    // a double-spawn -- notably a boot restore racing a legacy restore for the
    // same address.
    if (activeSupervisors.has(spec.agentAddress)) {
      throw new Error(
        `sidecar deploy router: a supervisor is already active for ${spec.agentAddress}; refusing to spawn a second`,
      );
    }
    const deploymentId = deriveDeploymentId(spec.agentAddress);

    // Single-step launched-agent deploy vs. derived multi-step deploy. A
    // one-step deployment keeps the deployment's own (legacy) mail address
    // and its grants in the legacy agent-state repo keyed by the legacy
    // instance id. A multi-step deployment derives `<deploymentId>-<stepId>`
    // per step for both the mail address and the agent-state repo id.
    const stepStrategy = createStepStrategy({
      legacyAddress: spec.agentAddress,
      stepOrder: spec.definition.stepOrder,
      multistepDeriveStepAddress,
    });

    // Unwind every piece of spawn state if any step in this block throws,
    // so a failed spawn leaks no freshly-spawned workflow-process child,
    // `activeSupervisors` entry, transport registration, or multistep
    // router registration. (The deployment-address registration happens
    // before spawn and is unwound by its own guard.) The ordering inside
    // the finally is the reverse of the success-path registration order.
    // The caller owns the deployment slug: it must
    // claim the collision guard before any durable write and release it on
    // failure, so the slug is not touched here.
    let succeeded = false;
    let wiredForUnwind: SidecarWorkflowSupervisor | undefined;
    let supervisorRegistered = false;
    let routersRegistered = false;
    let agentTransportRegistered = false;
    let hubKeyRecorded = false;
    let deploymentRegistered = false;
    try {
      // The hub-approved hash the frame carried, not a sidecar recompute: the
      // child re-verifies its evaluated closure against the hub's authority.
      const definitionHash = spec.approvedWireHash;

      // Warm-keep is the single-step launched-agent deploy: the sole step
      // IS the long-lived agent, so the child warm-keeps it across
      // messages. A multi-step deploy keeps instantiate-send-teardown per
      // step. Computed early because both the recycle-policy wiring below
      // and the spawn opts further down key off it.
      const warmKeep = spec.definition.stepOrder.length === 1;

      // Per-deployment substrate-config keys the workflow-substrate-factory
      // validator requires. The boot edge's `multistepSubstrateEnv` carries
      // the boot-edge constants; the definition identity, the workflow-run
      // identity keys and the materialized closure dir are derived per-deploy
      // here. `CLOSURE_PACKAGE_DIR` is what makes the run child EVALUATE the
      // pinned code and re-verify by project-then-hash against
      // `DEFINITION_HASH`.
      const substrateEnv: Record<string, string> = {
        ...multistepSubstrateEnv,
        WORKFLOW_DEFINITION_ID: spec.definition.id,
        WORKFLOW_RUN_REPO_ID: deploymentId,
        WORKFLOW_RUN_REF: "refs/heads/main",
        CLOSURE_PACKAGE_DIR: spec.closurePackageDir,
      };
      // Live-rotatable per-step inference sources. Seeded from the deploy
      // spec, then revised in place by the single-step sources-rotation
      // handler below. `STEP_INFERENCE_SOURCES` is NOT in the frozen
      // `substrateEnv`: it is recomputed on every spawn and recycle respawn
      // via `dynamicSpawnEnv`, so a rotation survives a recycle instead of
      // reverting to the deploy-time list.
      let currentSources = spec.sources;

      const wiredBaseConfig = {
        transport: deps.transport,
        repoStore: deps.repoStore,
        signingKeySeed: deps.signingKeySeed,
        workflowRunRepoId: {
          kind: "workflow-run" as const,
          id: deploymentId,
        },
        workflowRunRef: "refs/heads/main",
        deploymentId,
        stepCount: spec.definition.stepOrder.length,
        stepOrder: spec.definition.stepOrder,
        warmKeep,
        deploymentMailAddress: spec.agentAddress,
        deriveStepAddress: stepStrategy.deriveStepAddress,
        deriveStepRepoId: stepStrategy.deriveStepRepoId,
        substrateEnv,
        // Recomputed on every spawn AND recycle respawn. The rotation
        // handler below revises `currentSources` in place, so a respawn
        // re-serializes the current (possibly rotated) list rather than the
        // frozen deploy-time value.
        dynamicSpawnEnv: () => ({
          [STEP_INFERENCE_SOURCES_ENV_KEY]: JSON.stringify(currentSources),
        }),
        subprocessSpawner: multistepSpawner,
        // `exactOptionalPropertyTypes` rejects `{ field: undefined }` for
        // these optional supervisor-config fields, so an absent value must
        // omit the key entirely -- hence one conditional-spread per optional
        // field, folded into this single literal rather than a chain of
        // named intermediate configs.
        ...(deps.registerSuspension !== undefined
          ? { onSuspensionRegister: deps.registerSuspension }
          : {}),
        onSelfTerminate: () =>
          reclaimSelfTerminatedSupervisor({
            deploymentId,
            agentAddress: spec.agentAddress,
          }),
        ...(spec.credentials !== undefined
          ? { credentialDelivery: spec.credentials }
          : {}),
        ...(deps.multistepBinaryPath !== undefined
          ? { binaryPath: deps.multistepBinaryPath }
          : {}),
        ...(deps.onDispatchTiming !== undefined
          ? { onDispatchTiming: deps.onDispatchTiming }
          : {}),
        ...(deps.repackEveryMessages !== undefined
          ? { repackEveryMessages: deps.repackEveryMessages }
          : {}),
        ...(deps.consumedRetentionMs !== undefined
          ? { consumedRetentionMs: deps.consumedRetentionMs }
          : {}),
        ...(deps.readyTimeoutMs !== undefined
          ? { readyTimeoutMs: deps.readyTimeoutMs }
          : {}),
      };
      const wired = createSidecarWorkflowSupervisor(wiredBaseConfig);

      // Restore a hibernated identity directory, if this address has one
      // vaulted, BEFORE the `loadOrGenerateKey` call below: it is a no-op
      // for an address that was never hibernated (an ordinary fresh
      // deploy), and otherwise puts the preserved keypair back on disk so
      // that call loads it (`isNew: false`) instead of minting a new one.
      const identityRestore = await (stepStateDataDir !== undefined
        ? restoreAgentIdentity(stepStateDataDir, spec.agentAddress)
        : Promise.resolve({ restored: false }));

      // OUTBOUND half of mailbox ownership: register a signing key for
      // the deployment mail address on the host transport so the supervisor
      // signs the deployment's outbound mail. Every step -- single- or
      // multi-step -- signs its outbound sends as `spec.agentAddress` (the
      // one deployment mail address; no per-step sender reaches the host
      // transport), so the transport MUST hold a `CryptoProvider` for it or
      // `getTransportFor(senderAddress).send` throws "not registered".
      // Registration happens before `spawn()` so the address is live the
      // instant the first reply routes outbound.
      const { keyPair, isNew: keyIsNew } =
        await deps.keyStore.loadOrGenerateKey(spec.agentAddress);
      // A restored vault entry that did not yield an existing on-disk key
      // means the restore itself is broken (a corrupt or partial
      // snapshot) -- the exact "wake silently rotates identity" failure
      // this workaround exists to make impossible to ship unnoticed.
      if (identityRestore.restored && keyIsNew) {
        reportError(
          new Error(
            "restored a hibernated agent identity snapshot but " +
              "loadOrGenerateKey still minted a fresh keypair; the " +
              "restored snapshot was missing or corrupt key material",
          ),
          {
            operation: "workflow-host-wiring.restoreAgentIdentity",
            agentId: spec.agentAddress,
          },
        );
      }
      deps.transport.register(
        spec.agentAddress,
        deps.createAgentCrypto(keyPair),
      );
      agentTransportRegistered = true;

      // The public key the deploy ack surfaces to the hub is the deployment
      // address's own Ed25519 key -- the one `loadOrGenerateKey` minted above,
      // which `AgentKeyStore.signChallenge(spec.agentAddress)` also signs
      // reconnect challenges with. EVERY deployment acks it, single- and
      // multi-step alike, so the hub can verify the reconnect ownership
      // challenge for both: a single-step head records it into
      // `agent_instance.publicKey`; a workflow-derived deployment records it on
      // its `workflow_deployment` row. A multi-step deployment previously acked
      // the supervisor principal key -- which the hub discarded and which does
      // NOT match what `signChallenge` signs with -- so its address could be
      // re-claimed on reconnect without proof; carrying the deployment key
      // closes that.
      const deploymentPublicKey = hexEncode(keyPair.publicKey);
      if (spec.definition.stepOrder.length === 1) {
        // A single-step workflow stages its deploy tree at the head (the
        // lone step IS the head). Initialize the head's on-disk deploy-tree
        // repo (idempotent) so the hub's deploy-pack push has a repo to
        // apply into. The narrow `initRepo` (not `provisionAgent`) is
        // deliberate: the supervised child mints its own keypair and
        // persists no hub-agent config.
        await deps.sessions.initRepo(spec.agentAddress);

        // Record the hub's public key at the head so the deploy-pack apply
        // (and any inbound hub-signed frame) verifies against it. The
        // verifier resolves the key from the in-memory key store's
        // `recordHubKey` map, so a single-step deployment cannot stand up
        // without it.
        if (spec.hubPublicKey === undefined) {
          throw new Error(
            "sidecar deploy router: a single-step workflow deployment requires a hubPublicKey to record at the head; none was supplied",
          );
        }
        deps.keyStore.recordHubKey(spec.agentAddress, spec.hubPublicKey);
        hubKeyRecorded = true;
      }

      const stepOrder = [...spec.definition.stepOrder];
      const spawnOpts: SpawnOpts = {
        stepOrder,
        definitionHash,
        warmKeep,
        onInferenceEvent: (event, childRunId) => {
          // The event arrives HMAC-verified over the child's event channel.
          // Re-narrow it to the hub's `InferenceEvent` union; a parse
          // failure means upstream corruption, so drop it loudly rather
          // than forwarding an unvalidated payload onto the hub timeline.
          const validated = parseInferenceEvent(event);
          if (validated instanceof type.errors) {
            logger.warn`dropping workflow inference event for ${spec.agentAddress}: ${validated.summary}`;
            return;
          }
          publishInferenceEvent(
            spec.agentAddress,
            validated,
            spec.sessionId,
            childRunId,
          );
        },
      };

      // Record the deployment-address mapping BEFORE `spawn`, because
      // `spawn` kicks off `replayProcessingToInbox`, whose workflow-run
      // substrate write routes through the boot-edge pack-pushing facade and
      // resolves this mapping to address the outbound pack frame. Recording
      // it after `spawn` (as the other registrations below are) loses the
      // race: the replay's write throws "no agent address registered" (a
      // real defect masked as a swallowed best-effort warning in the
      // supervisor's replay catch). Constraint ownership: the registry owns
      // "address is resolvable"; the spawn path must satisfy that contract
      // before the replay writes. The finally unwinds it on any failure
      // between here and the end of the try.
      deps.registerDeployment({
        deploymentId,
        agentAddress: spec.agentAddress,
      });
      deploymentRegistered = true;

      // Surface spawn-time errors structurally: a subprocess spawner that
      // crashes immediately rejects here, and the caller converts the
      // rejection into a structured failure frame. The supervisor is
      // registered against the deployment address only after spawn succeeds,
      // so a spawn-time rejection leaves the registry untouched.
      await wired.supervisor.spawn(spawnOpts);
      wiredForUnwind = wired;
      activeSupervisors.set(spec.agentAddress, wired);
      supervisorRegistered = true;

      // Bind the deployment's mail address to this supervisor's
      // `routeInbound` so the hub-link dispatches inbound mail into the
      // supervisor's mail-bus subscription. Registration happens after
      // `spawn` succeeds so a spawn-time rejection leaves the registry
      // untouched.
      deps.multistepMailRouter?.register(spec.agentAddress, async (message) => {
        return wired.routeInbound(message);
      });
      // Register the signal-delivery handler so a hub `signal.deliver` frame
      // dispatches through the supervisor's `deliverSignal`.
      deps.multistepSignalRouter?.register(spec.agentAddress, async (args) => {
        await wired.supervisor.deliverSignal({
          runId: args.runId,
          signalName: args.signalName,
          signalId: args.signalId,
          payload: args.payload,
        });
      });
      // Register the drain handler so a hub `drain.deliver` frame dispatches
      // through the supervisor's `drain`.
      deps.multistepDrainRouter?.register(spec.agentAddress, async (args) => {
        await wired.supervisor.drain({ deadlineMs: args.deadlineMs });
      });
      // Register the grants handler so a hub `run.grants` frame writes the
      // run's grants to `runs/<runId>/grants.json` in the deployment's
      // workflow-run repo. The `runId` selects the per-run destination; the
      // step-fan-out fields are inert in that mode but the shared write
      // machinery still takes them. A write failure re-throws so the
      // hub-link logs the durable-write failure loudly.
      deps.multistepGrantsRouter?.register(spec.agentAddress, async (args) => {
        await writeStepGrants({
          repoStore: deps.repoStore,
          deploymentId,
          stepOrder: spec.definition.stepOrder,
          deriveStepRepoId: stepStrategy.deriveStepRepoId,
          grants: args.stepGrants,
          runId: args.runId,
        });
        // The per-run file now carries the (possibly overlaid) floor. Refresh
        // a live child so a standing ("always") approval resolved while the
        // run is running but not parked lowers its floor immediately; the
        // same durable file governs the next barrier/respawn, so a skipped
        // push never leaves the run under a stale floor for good.
        await wired.supervisor.deliverGrants(args.runId);
      });
      // Register the sources-rotation handler ONLY for a single-step warm
      // deployment: it has one long-lived agent whose sources can be
      // swapped in place. A multi-step deployment has no single warm agent,
      // so it registers no handler and `tryRoute` reports its address as
      // unrouted.
      if (warmKeep) {
        // A single-step deployment's source table has exactly one entry,
        // keyed by the head step. Derive that key once here (the layer that
        // owns the single-key invariant); `deliverSources` stays flat and
        // stepId-agnostic.
        const rotationStepId = spec.definition.stepOrder[0];
        if (rotationStepId === undefined) {
          throw new Error(
            "single-step deploy has no step id for sources rotation",
          );
        }
        deps.multistepSourcesRouter?.register(
          spec.agentAddress,
          async (args) => {
            const rotated = { [rotationStepId]: args.sources };
            // Swap `currentSources` synchronously BEFORE the durable persist.
            // `currentSources` is the process-local respawn hint the
            // supervisor reads synchronously through `dynamicSpawnEnv`, so a
            // recycle that interleaves the persist `await` must respawn the
            // child on the SAME sources being persisted, not the stale prior
            // table. The obvious inverse -- persist first, then swap -- is
            // rejected: it leaves the child on the OLD sources during the
            // persist window while the record has already moved to NEW, so a
            // recycle there respawns stale and a restart would "correct" it,
            // i.e. the running child contradicts durable intent. Swapping
            // first makes the only residual disagreement child-ahead-of-
            // durable on a failed persist, which the next recycle heals down
            // to the rolled-back durable truth -- the benign direction. The
            // wire boundary guarantees `args.sources[0]` is the default,
            // which the recycle env form pins as the active source.
            const prevSources = currentSources;
            currentSources = rotated;
            // The durable write still precedes the LIVE swap
            // (`deliverSources`), preserving persist-before-externally-visible
            // for state that outlives the process; only the process-local
            // respawn hint moves ahead. On a failed persist, roll the hint
            // back so `currentSources` and the record stay in agreement in the
            // common (no interleaved recycle) failure case -- the invariant
            // restart consistency depends on. Persistence lets the rotation
            // survive a full sidecar restart, not just a recycle: the boot
            // scan reseeds spec.sources from record.sources. Overwrites the
            // deploy-time record in place. Skipped when no data dir was wired
            // (a test router that never persists), matching the restore guard.
            if (stepStateDataDir !== undefined) {
              try {
                await persistDeploymentRecord(
                  stepStateDataDir,
                  deploymentId,
                  buildDeploymentRecord(spec, rotated),
                );
              } catch (cause) {
                // Restoring unconditionally is safe because rotations for one
                // deployment are serialized by the sidecar's per-connection
                // inbound-frame queue: each hub frame, sources.update
                // included, runs its handler to completion on that queue
                // before the next frame's handler starts, so no second
                // rotation is in flight whose committed table this rollback
                // could clobber. This does NOT rely on the hub pacing its
                // sends -- the hub dispatches sources.update fire-and-forget;
                // the sidecar frame queue is the sole serializer. Parallelizing
                // inbound-frame dispatch would break this rollback.
                currentSources = prevSources;
                throw cause;
              }
            }
            await wired.supervisor.deliverSources({
              sources: args.sources,
              defaultSource: args.defaultSource,
            });
          },
        );
      }

      // Register the credential-delivery handler for EVERY deployment (not
      // only warm single-step ones): the material cell is per-child and read
      // by every step's tool capabilities. The handler hands the delivery to
      // the supervisor's `deliverCredentials`, which sends a
      // `credentials-updated` control frame to the child where the material
      // cell is swapped. No durable persist -- credential material never
      // touches disk.
      deps.multistepCredentialsRouter?.register(
        spec.agentAddress,
        async (args) => {
          await wired.supervisor.deliverCredentials({
            delivery: args.delivery,
          });
        },
      );
      routersRegistered = true;

      succeeded = true;
      return { publicKey: deploymentPublicKey };
    } finally {
      if (!succeeded) {
        // Unwind in reverse registration order so each step undoes state
        // the success path confirmed; ordering matches the `undeploy` hook.
        if (routersRegistered) {
          deps.multistepMailRouter?.unregister(spec.agentAddress);
          deps.multistepSignalRouter?.unregister(spec.agentAddress);
          deps.multistepDrainRouter?.unregister(spec.agentAddress);
          deps.multistepGrantsRouter?.unregister(spec.agentAddress);
          // Unregister unconditionally: the sources handler was registered
          // only for a single-step deploy, but `unregister` is a no-op for
          // an address that never registered one, so a multi-step unwind
          // safely calls it too.
          deps.multistepSourcesRouter?.unregister(spec.agentAddress);
          deps.multistepCredentialsRouter?.unregister(spec.agentAddress);
        }
        if (supervisorRegistered) {
          activeSupervisors.delete(spec.agentAddress);
        }
        if (wiredForUnwind !== undefined) {
          await wiredForUnwind.supervisor.shutdown().catch((cause) => {
            const message =
              cause instanceof Error ? cause.message : String(cause);
            logger.warn`multi-step deploy unwind: supervisor.shutdown failed: ${message}`;
          });
        }
        if (agentTransportRegistered) {
          // Drop the agent's transport registration so a failed deploy does
          // not leave the address live with a dangling `CryptoProvider`.
          deps.transport.unregister(spec.agentAddress);
        }
        if (hubKeyRecorded) {
          // Reverse the single-step head's `recordHubKey` so a failed deploy
          // leaves no in-memory hub key behind. `forgetAgent` also drops the
          // agent keypair cache `loadOrGenerateKey` populated, which is safe:
          // the transport registration is already unwound above, nothing reads
          // that cache after unwind, and a redeploy reloads the keypair from
          // disk. The on-disk deploy-tree repo `initRepo` created is
          // deliberately NOT reversed. It is idempotent and the hub re-pushes
          // the deploy pack on every redeploy, so it is benign residue; and
          // decisively, the durable Ed25519 identity keypair lives inside that
          // same directory (`keys/` nests under the agent repo dir), so
          // removing the repo would destroy an identity a rerouted head must
          // keep across a failed redeploy.
          deps.keyStore.forgetAgent(spec.agentAddress);
        }
        if (deploymentRegistered) {
          // Reverse the pre-spawn `registerDeployment`: drop the address
          // mapping so a failed spawn leaves the boot-edge registry as it
          // found it. Registered first (before spawn), unwound last. A
          // subsequent stale workflow-run write for the dead deployment then
          // surfaces structurally (`registry.resolve` returns null) rather
          // than resolving to the address of a deployment that never came up.
          deps.unregisterDeployment({
            deploymentId,
            agentAddress: spec.agentAddress,
          });
        }
      }
    }
  }

  /**
   * Provision one step of a multi-step deploy WITHOUT spawning. The hub
   * stages each step's deploy tree before firing the deployment-level
   * workflow frame; a full-closure deploy pack still needs an initialized
   * agent-state repo to apply into and the hub key recorded to verify the
   * pack commit signature. This does exactly those two things -- the same
   * harness-free `initRepo` + `recordHubKey` seam the single-step head uses
   * -- and constructs no supervisor or child. The deployment-level workflow
   * frame (fired once after every step is provisioned) spawns the child,
   * which reads each step's staged deploy tree from disk.
   *
   * Returns the sidecar's principal public key so the link's
   * `agent.deploy.ack` carries a key, matching the multi-step ack. A
   * per-step address is workflow-derived and records no `agent_instance`
   * key, so the hub discards this value.
   */
  async function provisionStep(
    frame: AgentDeployFrame,
  ): Promise<DeployRouterResult> {
    await deps.sessions.initRepo(frame.agentAddress);
    deps.keyStore.recordHubKey(frame.agentAddress, frame.hubPublicKey);
    return {
      publicKey: await derivePrincipalPublicKeyHex(deps.signingKeySeed),
    };
  }

  async function deployMultiStep(
    frame: AgentDeployFrame,
    projection: NonNullable<AgentDeployFrame["workflow"]>,
  ): Promise<DeployRouterResult> {
    // A re-deploy of an address with a live supervisor acks idempotently,
    // BEFORE touching any durable state: the resident deployment already
    // owns the address, its persisted key is what reconnect challenges
    // sign with, and nothing below may overwrite its repo state. Acking
    // (rather than rejecting) matters because the hub's deploy-reject
    // handler unroutes the address — a wake racing a hub-restart
    // reconnect would otherwise tear down the just-verified route and
    // every later wake would re-trip this same guard, a permanent
    // wake/reject loop against a run the sidecar never stopped.
    if (activeSupervisors.has(frame.agentAddress)) {
      const { keyPair } = await deps.keyStore.loadOrGenerateKey(
        frame.agentAddress,
      );
      return { publicKey: hexEncode(keyPair.publicKey) };
    }
    // A deploy still in flight for the address stays a hard reject: two
    // concurrent frames racing the same address must have one loser, or
    // the loser's cleanup deletes the winner's live record. The
    // reservation set closes the window `activeSupervisors` alone leaves
    // (it is populated only after `spawn` succeeds). A re-deploy after
    // `undeploy` passes: `undeploy` drops the `activeSupervisors` entry,
    // and a failed or completed deploy has already cleared its
    // reservation.
    if (reservingDeployAddresses.has(frame.agentAddress)) {
      throw new Error(
        `sidecar deploy router: a deploy is already in flight for ${frame.agentAddress}`,
      );
    }

    const deploymentId = deriveDeploymentId(frame.agentAddress);

    // Claim the deployment slug BEFORE any durable write so a colliding
    // deploymentId (two distinct addresses projecting to the same slug) is
    // rejected before the closure, the step grants, or the supervisor touch
    // disk -- the router's "no repo state touched before rejection"
    // guarantee. The claim is released on any failure below; a successful
    // deploy keeps it (the undeploy hook releases it at teardown). The spawn
    // core owns unwinding the supervisor and registrations it stands up; the
    // slug is the caller's.
    //
    // Resolve the sidecar data dir once: the deployment record, the
    // materialized closure, and the per-step scratch all root under it.
    const dataDir = stepStateDataDir;
    if (typeof dataDir !== "string" || dataDir.length === 0) {
      throw new Error(
        "sidecar deploy router: SIDECAR_DATA_DIR must be present in the multi-step substrate env; the deployment record and workflow-process child root under it",
      );
    }

    claimSlug(deploymentId, frame.agentAddress);
    // Hold the single-flight reservation across the async body below and clear
    // it in the finally. Everything above is synchronous and throws before any
    // durable write, so the reservation is only needed from the first await
    // here onward; the top-of-method guard already consults this set for a
    // concurrent frame, and claimSlug/deploymentId derivation above cannot
    // yield control before this point.
    reservingDeployAddresses.add(frame.agentAddress);
    try {
      // Source-ref apply -- the only deploy lineage. Materialize EXACTLY the
      // hub's frozen dependency closure and evaluate the PINNED CODE to the
      // workflow definition; the frame carries no inline definition to trust.
      // The closure is applied byte-for-byte (concrete versions + integrity
      // SRIs) and never re-resolved here.
      //
      // Check the frame's inline source assets out into the durable
      // per-deployment store the closure materializes from, reclaiming it
      // first so a redeploy drops assets no longer referenced. This runs only
      // on the DEPLOY path -- restore re-reads the store this deploy persisted
      // -- so the checkout lives here rather than inside the shared
      // materializer. A registry-sourced pin delivers no assets and only
      // clears the store.
      const assetStore = deploymentSourceAssetRoot(dataDir, deploymentId);
      const gitStore = deploymentSourceGitRoot(dataDir, deploymentId);
      await rm(assetStore, { recursive: true, force: true });
      await rm(gitStore, { recursive: true, force: true });
      if (projection.assets !== undefined && projection.assets.length > 0) {
        await materializeWorkflowAssets({
          assets: projection.assets,
          closure: projection.sourceRef.closure,
          assetRoot: assetStore,
          gitDirRoot: gitStore,
          maxAssetPayloadBytes: MAX_INLINE_ASSET_PAYLOAD_BYTES,
        });
      }
      // Safe to reclaim the instance dir inside the helper: this deploy is
      // single-flight-guarded by the reservation above and the child is not
      // yet spawned, so no live reader holds it.
      const applied = await applyClosure({
        dataDir,
        deploymentId,
        pin: projection.sourceRef,
        substrateEnv: multistepSubstrateEnv,
      });
      const validatedDefinition = WorkflowProjectionDefinition(
        projectLiveToInert(applied.definition),
      );
      if (validatedDefinition instanceof type.errors) {
        throw new Error(
          `sidecar deploy router: workflow definition loaded from the frozen closure failed projection validation: ${validatedDefinition.summary}`,
        );
      }
      const definition: WorkflowProjectionDefinition = validatedDefinition;

      // Structural invariants the wire arktype does not cover (non-empty
      // stepOrder, every stepOrder entry backed by a `steps` entry AND a
      // `sources` entry), checked against the closure-derived definition --
      // the frame carries none to cover. Mirrors the restore path.
      validateWorkflowProjection({ definition, sources: projection.sources });

      // Source-admission gate: reject a deploy where any step pins an
      // inference provider this sidecar cannot build. Every source in a step's
      // failover chain must be buildable -- a chain with an unbuildable tail
      // would fail only after the reactor failed over onto it -- so this
      // iterates the whole list. The throw propagates back through the deploy
      // frame so the hub's `deployWorkflow` rejects synchronously.
      for (const stepId of definition.stepOrder) {
        const chain = projection.sources[stepId];
        if (chain !== undefined) {
          for (const source of chain) deps.assertSourceBuildable(source);
        }
      }

      // Single-step launched-agent deploy vs. derived multi-step deploy. A
      // one-step definition keeps the deployment's own mail address and its
      // grants in the agent-state repo keyed by the instance id; a multi-step
      // definition derives `<deploymentId>-<stepId>` per step for both the
      // mail address and the agent-state repo id, isolating each step's
      // grants in its own repo.
      const stepStrategy = createStepStrategy({
        legacyAddress: frame.agentAddress,
        stepOrder: definition.stepOrder,
        multistepDeriveStepAddress,
      });

      // The child re-verifies its evaluated closure against the hub's approved
      // hash. A frame that carried none has no anchor to verify against, so
      // fail closed rather than substitute a sidecar recompute.
      if (projection.approvedWireHash === undefined) {
        throw new Error(
          `sidecar deploy router: the deploy frame for ${frame.agentAddress} carries no approvedWireHash; the child has no hub-approved anchor to re-verify the evaluated closure against`,
        );
      }

      const spec: WorkflowDeploySpec = {
        agentAddress: frame.agentAddress,
        definition,
        sources: projection.sources,
        sessionId: frame.config.sessionId,
        hubPublicKey:
          definition.stepOrder.length === 1 ? frame.hubPublicKey : undefined,
        approvedWireHash: projection.approvedWireHash,
        closurePackageDir: applied.packageDir,
        sourceRef: projection.sourceRef,
        credentials: projection.credentials,
      };
      const record = buildDeploymentRecord(spec, spec.sources);

      // Persist the deployment record BEFORE the spawn so a crash mid-spawn
      // leaves a record the boot scan re-drives (an idempotent re-spawn; the
      // child's in-flight-run discovery resumes any run). A soft-failed deploy
      // deletes it below, so only a crash-interrupted deploy leaves one.
      await persistDeploymentRecord(dataDir, deploymentId, record);

      // Materialize each extracted onTrigger section body's per-step inference
      // sources. The body DEFINITION is not staged: the run child resolves each
      // body in-memory from the parent's re-verified closure and hard-fails
      // rather than reading a body definition off disk. The sources ride on
      // disk (not through env) because the body child is in-process and loses
      // its env across a restart.
      for (const referenced of projection.referencedDefinitions ?? []) {
        await materializeWorkflowSources(
          dataDir,
          referenced.definition.id,
          referenced.sources,
        );
      }

      // Grants bridge: the spawned child does not see the frame; it reads
      // each step's grants out of `state/grants.json` in the step's
      // agent-state repo while the supervisor assembles the
      // credentialsSnapshot. Write the operator-approved
      // `frame.config.grants` to the same repo the supervisor reads via
      // `deriveStepRepoId`, before the spawn core, so the read sees them.
      await writeStepGrants({
        repoStore: deps.repoStore,
        deploymentId,
        stepOrder: definition.stepOrder,
        deriveStepRepoId: stepStrategy.deriveStepRepoId,
        grants: frame.config.grants,
      });

      // Per-run grants bridge, for the same reason the per-step write
      // above exists: the barrier must find the file before the run can
      // read it. A single-step deploy is self-anchored -- its run id IS
      // the address's instance id -- and `spawn` replays any mail already
      // sitting in the inbox, which births that run immediately. The
      // hub's own `run.grants` frame cannot win that race: it is sent
      // only after the deploy ack returns, so a wake with mail pending
      // reached `onRunStart` with no grants file and failed the run
      // closed. Writing the operator-approved `frame.config.grants` here
      // -- the same set the frame carries for a self-anchored run --
      // closes it; the hub's later frame rewrites identical bytes, and
      // `writeTree` without a `clearPrefix` is purely additive, so it
      // never disturbs the run's events. Guarded on `isRunAddress`: only
      // a run address names a self-anchored run id.
      if (
        definition.stepOrder.length === 1 &&
        isRunAddress(frame.agentAddress)
      ) {
        await writeStepGrants({
          repoStore: deps.repoStore,
          deploymentId,
          stepOrder: definition.stepOrder,
          deriveStepRepoId: stepStrategy.deriveStepRepoId,
          grants: frame.config.grants,
          runId: parseAgentId(frame.agentAddress),
        });
      }

      // Hand off to the shared spawn core.
      return await spawnWorkflowDeployment(spec);
    } catch (cause) {
      // Soft failure (this process survived, the deploy threw): drop the
      // record and release the slug so the failed deploy is neither restored
      // nor leaks its slug. The record delete must not mask the real deploy
      // error or skip releasing the slug: a rejecting delete is logged (the
      // orphaned record is a durable-state leak the next boot scan re-drives)
      // but `cause` is still what propagates and the slug is still released.
      try {
        await deleteWorkflowDeploymentRecord(dataDir, deploymentId);
      } catch (cleanupError) {
        const message =
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError);
        logger.error`deploy cleanup: deleteWorkflowDeploymentRecord failed for ${deploymentId}: ${message}`;
      }
      releaseSlug(deploymentId, frame.agentAddress);
      throw cause;
    } finally {
      // Release the single-flight reservation whether the deploy succeeded or
      // threw. On success the address is now in `activeSupervisors`, which the
      // guard also consults, so a later re-deploy is still rejected.
      reservingDeployAddresses.delete(frame.agentAddress);
    }
  }

  /**
   * Whether a closure-materialization failure is an ENOENT reading the
   * workflow package's `package.json` (or a `package.json`-shaped read
   * inside the staged closure) -- the CL-6640 crash-loop shape:
   * `applyFrozenWorkflowClosure` stages fresh into a new deploy-id
   * directory on every call and immediately reads back from that same
   * directory in the same `await` chain, so a missing file there is never
   * this boot's timing -- it is corrupt/incomplete PERSISTED input (the
   * tarball cache, or a durable source-asset checkout) that reproduces
   * identically on every future retry. `readPackageJSON`
   * (`@intx/workflow-host`) wraps the raw ENOENT in a describing `Error`
   * with `{ cause }`, so both the direct code and the wrapped cause's code
   * are checked.
   */
  function isMissingClosureStagingFailure(cause: unknown): boolean {
    if (!(cause instanceof Error)) return false;
    if (isErrnoNotFound(cause)) return true;
    return (
      "cause" in cause && isErrnoNotFound((cause as { cause?: unknown }).cause)
    );
  }

  /**
   * Re-establish one persisted deployment from its on-disk record -- the
   * shared core of the boot-time restore loop and the CL-5477 idle-reap
   * wake path. Applies exactly the gates the live deploy path applies
   * (address integrity, wire arktype, tool-metadata-equivalent structural
   * projection, source admission). Every failure throws so the caller's
   * failure-accounting (`recordWorkflowDeploymentRestoreFailure`) sees it;
   * the record is never deleted here. A failure that is intrinsic to the
   * record's own persisted bytes -- deterministic, will recur identically
   * on every future boot -- throws a `WorkflowRestoreFailure("permanent",
   * ...)`: address-derivation mismatch, closure-derived-definition
   * validation, and a missing/incomplete closure staging directory
   * (CL-6640 -- see `isMissingClosureStagingFailure`) are the only such
   * gates below. Every other failure (an unbuildable inference provider, a
   * spawn-core throw) is a plain `Error`, which the caller treats as
   * "transient" -- it depends on this boot's environment, not the
   * record's content, and may clear on a later boot with no change to the
   * record at all.
   *
   * Returns `"deferred-to-wake"` instead of restoring for a single-step
   * ("warm-keep") deployment (CL-6648): that shape is exactly what a
   * folded run deploys, and folded runs already have a working lazy-wake
   * port (`@corbits/agent-lifecycle`'s `ensureAwake` ->
   * `@corbits/folded-runs`' `wakeFoldedRun` -> `deployAtHead`) that
   * re-resolves inference sources fresh against the tenant's LIVE catalog
   * on every wake -- `record.sources` is only ever a snapshot of what
   * resolved at the deployment's last deploy or rotation. Restoring one
   * eagerly here would instead replay that frozen snapshot forever,
   * including a chain whose credential died after the freeze, with no
   * later trigger to ever refresh it (a restored deployment reads as
   * "already live" to every future wake check, so the self-healing wake
   * path never fires for it again). Deferring leaves the address
   * unroutable until its next message or routine fire, at which point the
   * ordinary wake path redeploys it against a current resolution -- the
   * same re-derive-at-wake property this ticket asks for, without
   * inventing a new sidecar-to-hub source-resolution channel (the sidecar
   * has no hub DB access and no pre-connect RPC to one; see CL-6648). A
   * true multi-step workflow deployment has no such wake port today (open
   * follow-up), so it keeps restoring eagerly from its frozen `sources`
   * below, unchanged.
   */
  async function restoreDeploymentFromRecord(
    dataDir: string,
    deploymentId: string,
    record: WorkflowDeploymentRecord,
    signal: AbortSignal,
  ): Promise<"restored" | "deferred-to-wake" | "pruned"> {
    // Integrity: the stored address must re-derive to its own directory
    // name. A mismatch means a corrupt or misplaced record -- permanent,
    // since re-deriving the same address on a later boot yields the same
    // mismatch every time.
    const derived = deriveDeploymentId(record.agentAddress);
    if (derived !== deploymentId) {
      throw new WorkflowRestoreFailure(
        "permanent",
        `${record.agentAddress} derives slug ${derived}, not its directory ${deploymentId}`,
      );
    }

    // A record whose address the platform's own parser rejects is
    // permanently unrestorable -- it predates the current run-address
    // scheme (e.g. legacy "ins_" prefixes) and no later boot can ever
    // revive it. A wake never reaches this branch (a wake only fires for
    // an address the boot scan already accepted), but the boot restore
    // loop and this shared core must agree, so the check lives here once.
    if (!isRunAddress(record.agentAddress)) {
      await deleteWorkflowDeploymentRecord(dataDir, deploymentId);
      logger.info`Pruned unrestorable workflow deployment record ${deploymentId} (legacy address ${record.agentAddress})`;
      return "pruned";
    }

    // Single-step ("warm-keep") deployment: defer to the wake path rather
    // than eagerly restoring from a frozen `sources` snapshot. `sources`
    // always carries exactly one entry per `stepOrder` id (the wire
    // boundary's own invariant -- see `validateWorkflowProjection`), so a
    // single entry here means a single step without needing to
    // re-materialize the closure just to find out. See this function's
    // doc comment for why deferring is what makes CL-6648's re-derive
    // property hold without a new sidecar-to-hub RPC.
    if (Object.keys(record.sources).length === 1) {
      return "deferred-to-wake";
    }

    // CL-7215: the closure fetch below is real, avoidable work -- bail
    // before starting it rather than spending it on an attempt the caller
    // has already timed out and recorded as failed.
    throwIfRestoreAborted(signal, deploymentId);

    // Reconstruct this deployment's runnable definition: re-materialize the
    // pinned closure and evaluate the pinned code, then project it to the
    // inert wire shape -- the SAME computation the deploy path applies. The
    // closure IS the source of truth; no on-disk definition is read. The
    // helper reclaims the instance dir first, safe here because the prior
    // process (the only reader) is dead and restore is serial before
    // `hubLink.connect()`. Asset-sourced entries read from the durable source
    // store the original deploy checked out, so no re-delivery is needed; a
    // store miss soft-fails the record (kept for the next boot).
    let applied: Awaited<ReturnType<typeof applyClosure>>;
    try {
      applied = await applyClosure({
        dataDir,
        deploymentId,
        pin: record.sourceRef,
        substrateEnv: multistepSubstrateEnv,
      });
    } catch (cause) {
      if (isMissingClosureStagingFailure(cause)) {
        // The closure re-materializes fresh into a brand-new staging
        // directory on every single restore attempt (a new deploy-id is
        // minted each call; see `applyFrozenWorkflowClosure`), so an ENOENT
        // reading the package it JUST staged is not this boot's
        // environment -- it is a corrupt/incomplete PERSISTED input (the
        // pinned closure's tarball cache entry, or the durable source-asset
        // checkout `resolveDeploymentAssetMounts` already validated) that
        // re-derives byte-for-byte the same broken result on every future
        // boot too. Permanent, so it quarantines instead of warning forever
        // while silently never making progress.
        throw new WorkflowRestoreFailure(
          "permanent",
          cause instanceof Error ? cause.message : String(cause),
        );
      }
      throw cause;
    }
    const validatedDefinition = WorkflowProjectionDefinition(
      projectLiveToInert(applied.definition),
    );
    if (validatedDefinition instanceof type.errors) {
      // Permanent: the closure is an immutable pin, so re-evaluating it on
      // a later boot yields the identical (broken) projection every time.
      throw new WorkflowRestoreFailure(
        "permanent",
        `workflow definition loaded from the frozen closure failed projection validation for ${record.agentAddress}: ${validatedDefinition.summary}`,
      );
    }
    const definition: WorkflowProjectionDefinition = validatedDefinition;

    // Structural invariants the wire arktype does not cover. The closure eval
    // skips the deploy frame's coverage narrow, so this is where the
    // definition-vs-sources coverage is checked. Also permanent, for the
    // same reason as the projection check above: both the definition and
    // `record.sources` are immutable once persisted.
    try {
      validateWorkflowProjection({ definition, sources: record.sources });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new WorkflowRestoreFailure("permanent", reason);
    }

    // Re-run the source-admission gate: refuse to restore a deployment
    // whose pinned provider this sidecar can no longer build. Every
    // source in a step's failover chain must be buildable, so this
    // iterates the whole list. Transient, not permanent: the buildable-
    // provider set is this boot's adapter registry, not anything the
    // record itself carries, so a later boot with the provider restored
    // retries and can succeed with the SAME record unchanged. The record
    // is KEPT (not deleted) either way.
    for (const stepId of definition.stepOrder) {
      const chain = record.sources[stepId];
      if (chain !== undefined) {
        for (const source of chain) {
          try {
            deps.assertSourceBuildable(source);
          } catch (cause) {
            const reason =
              cause instanceof Error ? cause.message : String(cause);
            throw new WorkflowRestoreFailure("transient", reason);
          }
        }
      }
    }

    const spec: WorkflowDeploySpec = {
      agentAddress: record.agentAddress,
      definition,
      sources: record.sources,
      sessionId: record.sessionId,
      hubPublicKey: record.hubPublicKey,
      approvedWireHash: record.approvedWireHash,
      closurePackageDir: applied.packageDir,
      // Re-carried so a post-restore source rotation -- which rebuilds the
      // record from the spec -- re-persists the pin; without this a rotation
      // would silently drop it and wedge the NEXT restart.
      sourceRef: record.sourceRef,
      // Frame-only, never persisted: a restore (boot-time OR a wake) waits for
      // the hub's next `credentials.update` push, exactly like a redeploy of a
      // deployment that predates a credentials push.
      credentials: undefined,
    };

    // The slug is the caller's, matching `deployMultiStep`: claim before
    // the spawn, release on failure. Unlike deploy's soft-fail, restore
    // does NOT delete the record and does NOT re-materialize the step grants
    // or the onTrigger body sources -- both are already on disk from the
    // original deploy. A failed restore's caller (the boot loop, below)
    // tracks the failure on the record and always leaves the record itself
    // in place for the next boot; there is deliberately no GC of the record
    // FILE here (an operator reclaims it by undeploying the address) --
    // only of the ATTENTION a permanently-unrestorable one demands, via
    // the quarantine threshold below.
    //
    // Release only a slug THIS pass newly claimed: if the address is
    // already live (its slug still held by the running deployment), the
    // core's double-spawn guard throws, and freeing the slug then would
    // strand a live deployment's collision guard. `claimSlug` is a
    // no-op for an already-held (deploymentId, address) pair, so the
    // pre-claim check distinguishes the two. A PARKED deployment keeps
    // its slug claimed, so a wake respawn lands in this already-held arm.
    const slugNewlyClaimed =
      slugClaims.get(deploymentId) !== record.agentAddress;
    claimSlug(deploymentId, record.agentAddress);
    try {
      // CL-7215: checked INSIDE this try, after the slug is claimed, so a
      // cancellation here unwinds through the same catch below that
      // releases it -- an abort must never leak a claimed slug.
      // `spawnWorkflowDeployment` itself has no cancellation point (no
      // signal reaches `@intx/workflow-host`'s `Supervisor.spawn`), so this
      // is the last point this restore can still avoid starting it.
      throwIfRestoreAborted(signal, deploymentId);
      await spawnWorkflowDeployment(spec);
      if (signal.aborted) {
        // The caller's own timeout already fired -- and its catch may
        // already have recorded this attempt as a boot failure -- but
        // `spawnWorkflowDeployment` just registered a live supervisor for
        // this address regardless (CL-7215). Reconcile the durable record
        // against whatever the current on-disk truth is, under the same
        // lock the boot loop's catch and `teardownDeployment` use: without
        // it, this read could land BEFORE the catch's write does, observe
        // nothing to correct, and no-op -- leaving the catch's write to
        // permanently mismark a live deployment once it lands afterward.
        // The lock guarantees whichever writer runs last observes every
        // prior one's completed write.
        //
        // Three outcomes are possible for what this read finds:
        // - a `restoreFailure` stamp: the boot loop's catch ran first and
        //   falsely marked this now-live deployment failed -- clear it.
        // - the record itself is GONE: a reclaiming `teardownDeployment`
        //   ran while this spawn was in flight. `activeSupervisors` had no
        //   entry for this address yet at that point (this spawn had not
        //   resolved), so the teardown's own `wired` check missed it and
        //   left the routers this spawn just (re-)registered live, with no
        //   durable record backing them -- an orphaned live deployment,
        //   arguably worse than the original false-failure bug this ticket
        //   started from. Unwind it (below, outside the lock).
        // - neither: nothing raced this restore; leave it as a normal
        //   successful (if late) restore.
        let reclaimedDuringSpawn = false;
        try {
          const corrected = await withDeploymentRecordLock(
            deploymentId,
            async () => {
              const onDisk = await readWorkflowDeploymentRecord(
                dataDir,
                deploymentId,
              );
              if (onDisk === undefined) {
                reclaimedDuringSpawn = true;
                return false;
              }
              if (onDisk.restoreFailure === undefined) return false;
              await clearWorkflowDeploymentRestoreFailure(
                dataDir,
                deploymentId,
                onDisk,
              );
              return true;
            },
          );
          if (corrected) {
            logger.warn`Workflow deployment ${record.agentAddress} finished restoring after its boot-restore attempt had already timed out; corrected its record so it no longer claims the deployment failed to restore`;
          }
        } catch (correctionError) {
          reportError(correctionError, {
            operation:
              "workflow-host-wiring.restoreDeploymentFromRecord.lateRestoreCorrection",
            agentId: record.agentAddress,
          });
        }
        if (reclaimedDuringSpawn) {
          // Called OUTSIDE the lock above: `teardownDeployment` acquires
          // the same per-deployment lock itself, and this restore's own
          // correction closure has already returned by this point, so
          // there is no reentrant deadlock.
          logger.warn`Workflow deployment ${record.agentAddress} finished spawning after being torn down while its boot-restore attempt was still in flight; unwinding the orphaned live supervisor`;
          try {
            await teardownDeployment(record.agentAddress, {
              reclaimDirs: true,
            });
          } catch (unwindError) {
            reportError(unwindError, {
              operation:
                "workflow-host-wiring.restoreDeploymentFromRecord.unwindReclaimedDuringSpawn",
              agentId: record.agentAddress,
            });
          }
        }
      }
      logger.info`Restored workflow deployment for ${record.agentAddress}`;
      return "restored";
    } catch (cause) {
      if (slugNewlyClaimed) {
        releaseSlug(deploymentId, record.agentAddress);
      }
      throw cause;
    }
  }

  /**
   * Shared teardown body for `undeploy` (`reclaimDirs: true` -- forget the
   * deployment entirely) and the state-preserving "hibernate" flavor
   * (`reclaimDirs: false` -- keep the deployment record and on-disk step
   * state so a later `deploy` call for the same address resumes rather than
   * starts fresh). The hub-side reap that calls the hibernate flavor is a
   * separate lane; this function only needs to exist and be correct here.
   *
   * Routers come down BEFORE the supervisor's `shutdown()` so any hub-side
   * frame racing the teardown is dropped at the router boundary rather than
   * dispatched into a supervisor mid child-teardown. Before the child is
   * killed, `wired.supervisor.drain` is given a bounded window to let an
   * in-flight step settle so its workflow-run event commit (and the pack
   * push that commit triggers) has a chance to land -- an unconditional
   * immediate kill would drop that commit on the floor.
   */
  async function teardownDeployment(
    agentAddress: string,
    opts: { reclaimDirs: boolean },
  ): Promise<void> {
    // Snapshot the agent's identity directory (its reconnect-challenge
    // keypair) BEFORE anything else, and before this function returns:
    // the published `@intx/hub-agent` package's own undeploy handling
    // destroys that directory unconditionally, but only AFTER this hook
    // returns -- this is a compensating workaround for CL-6239 (still
    // open: the real fix is a non-destructive upstream undeploy), not a
    // substitute for it. Skipped for a reclaiming (non-hibernate)
    // teardown, which is expected to destroy the identity along with
    // everything else.
    if (!opts.reclaimDirs && stepStateDataDir !== undefined) {
      await snapshotAgentIdentity(stepStateDataDir, agentAddress);
    }
    const deploymentId = deriveDeploymentId(agentAddress);
    deps.multistepMailRouter?.unregister(agentAddress);
    deps.multistepSignalRouter?.unregister(agentAddress);
    deps.multistepDrainRouter?.unregister(agentAddress);
    deps.multistepGrantsRouter?.unregister(agentAddress);
    // Unregister unconditionally: the sources handler was registered only
    // for a single-step deploy, but `unregister` is a no-op for an address
    // that never registered one, so an unconditional call here is safe for
    // a multi-step deployment too.
    deps.multistepSourcesRouter?.unregister(agentAddress);
    deps.multistepCredentialsRouter?.unregister(agentAddress);

    const wired = activeSupervisors.get(agentAddress);
    if (wired !== undefined) {
      activeSupervisors.delete(agentAddress);
      await wired.supervisor
        .drain({ deadlineMs: TEARDOWN_DRAIN_DEADLINE_MS })
        .catch((cause: unknown) => {
          const reason = cause instanceof Error ? cause.message : String(cause);
          logger.warn`teardownDeployment: pre-shutdown drain failed for ${agentAddress}: ${reason}`;
        });
      await shutdownSupervisorWithEscalation(wired);
      // Drop the deployment address's transport registration installed at
      // spawn (OUTBOUND half of mailbox ownership). Both single- and
      // multi-step register the deployment address for outbound signing, so
      // this tears down a real registration for either; `unregister` is a
      // no-op only if the spawn failed before registering, so it is safe to
      // call unconditionally for any spawned deployment. A relaunch
      // re-registers it fresh, whether this teardown reclaims dirs or not.
      deps.transport.unregister(agentAddress);
      // Reclaim the deployment's per-step local-disk scratch now that its
      // supervisor + workflow-process child are torn down. Skipped for a
      // hibernate: the parked run's per-step scratch (and warm workspace)
      // must survive so a later relaunch resumes against it. The durable
      // conversation under `agent-conversation-state/` is a DIFFERENT root
      // and is deliberately NOT touched here either way -- a re-deploy on
      // the same address must restore the prior conversation from it.
      if (opts.reclaimDirs && stepStateDataDir !== undefined) {
        await rm(
          pathJoin(stepStateDataDir, "workflow-step-state", deploymentId),
          { recursive: true, force: true },
        );
      }
    }
    // Drop the deployment record so a boot-time restore does not re-spawn a
    // torn-down deployment. Runs on every reclaiming teardown -- not only
    // when a supervisor was active -- so a record left behind by a
    // crash-interrupted deploy is reclaimed too. Skipped for a hibernate:
    // the record IS the durable state a later relaunch reads to resume.
    if (opts.reclaimDirs && stepStateDataDir !== undefined) {
      // CL-7215: serialized through the same per-deployment lock the
      // boot-restore path uses. Without it, a teardown racing a dangling
      // (timed-out but still-running) restore's correction could delete
      // the record out from under it, or clobber a `restoreFailure` write
      // it lands mid-teardown -- neither of the boot-restore path's own
      // two writers accounts for a third, unlocked writer touching the
      // same file.
      await withDeploymentRecordLock(deploymentId, () =>
        deleteWorkflowDeploymentRecord(stepStateDataDir, deploymentId),
      );
    }
    // Stamp the kept record as parked. This is the ONLY durable signal that
    // distinguishes "the hub parked this deployment on purpose" from "this
    // record is here because the process crashed or exited while the
    // deployment was still live" -- both leave the record on disk with no
    // marker otherwise. The boot scan reads this to REPORT parked-vs-live
    // counts today; it does not yet change what it spawns (that cutover is
    // CL-6282).
    if (!opts.reclaimDirs && stepStateDataDir !== undefined) {
      // CL-7215: same lock as above, for the same reason -- a hibernate's
      // parked-stamp read-modify-write must not interleave with a dangling
      // restore's own record writes for this deploymentId.
      await withDeploymentRecordLock(deploymentId, () =>
        markWorkflowDeploymentRecordParked(stepStateDataDir, deploymentId),
      );
    }
    if (opts.reclaimDirs) {
      releaseSlug(deploymentId, agentAddress);
    }
    deps.unregisterDeployment({ deploymentId, agentAddress });
  }

  return {
    async deploy(frame): Promise<DeployRouterResult> {
      if (frame.provisionStep === true) {
        return await provisionStep(frame);
      }
      if (frame.workflow !== undefined) {
        return await deployMultiStep(frame, frame.workflow);
      }
      // Every deploy stages through the workflow-run substrate: a
      // provision-step frame primes the per-step repo, and a workflow
      // frame spawns the supervised child. A frame carrying neither is
      // an unsupported shape -- there is no in-process fall-through.
      throw new Error(
        `sidecar deploy router: unsupported deploy frame for ${frame.agentAddress}; a deploy must carry provisionStep or a workflow definition`,
      );
    },
    async undeploy(frame): Promise<void> {
      // `frame.reason` rides the wire from `sendAgentUndeploy(address,
      // reason)` verbatim (`AgentUndeployFrame.reason`, `@intx/types`). The
      // hub's idle-reap lifecycle (`@corbits/agent-lifecycle`'s sweep) tags
      // its own reap-driven undeploys with `IDLE_HIBERNATE_UNDEPLOY_REASON`
      // specifically so this router can tell "sleep it, a relaunch will
      // resume it" apart from every other undeploy reason (channel
      // deletion, member removal, ...), which still gets the destructive
      // default.
      const reclaimDirs = frame.reason !== IDLE_HIBERNATE_UNDEPLOY_REASON;
      await teardownDeployment(frame.agentAddress, { reclaimDirs });
    },
    teardownDeployment,
    async restoreWorkflowDeployments(): Promise<void> {
      const dataDir = stepStateDataDir;
      if (dataDir === undefined) {
        // No substrate config was wired (a test router that never spawns a
        // child): nothing was ever persisted under this data dir, so there
        // is nothing to restore.
        return;
      }

      const scanned = await scanWorkflowDeploymentRecords(dataDir);
      // CL-6282: `parkedAt` (written by `markWorkflowDeploymentRecordParked`
      // on a state-preserving hibernate teardown) is the durable, locally
      // decidable answer to "is this deployment genuinely live" -- a
      // deployment the hub deliberately put to sleep does not need to be
      // running to be correct; it resumes the moment a message or routine
      // fire addresses it again (the same wake path `ensureAwake`/`deployAtHead`
      // already use for an idle-slept deployment that never crashed at all).
      // Restoring it anyway at every boot is exactly the "restart dead
      // stuff" cost this cutover removes. A record with no `parkedAt`
      // (never hibernated, or predates the field) restores as before --
      // absent is "assume live", matching `readWorkflowDeploymentRecord`'s
      // own backward-compatible read.
      const { live, parked } = partitionScannedDeployments(scanned);
      const alreadyQuarantinedCount = live.filter(({ record }) =>
        isWorkflowDeploymentRestoreQuarantined(record),
      ).length;
      logger.info`Boot scan found ${scanned.length} deployment record(s): ${parked.length} parked (left asleep; will wake on the next message or routine fire), ${alreadyQuarantinedCount} quarantined, ${live.length - alreadyQuarantinedCount} to attempt (single-step deployments among them defer to their wake path instead of restoring frozen sources -- CL-6648)`;
      // Bounded-parallel, not fully parallel: `RESTORE_CONCURRENCY` caps how
      // many workflow-process children spawn at once so a boot with many
      // live deployments cannot storm the host, while still restoring far
      // faster than one-at-a-time. Restore runs before `hubLink.connect()`,
      // so there are no concurrent hub-driven deploys to contend with. Each
      // worker handles its own quarantine skip/record/clear bookkeeping and
      // logging inline (rather than via `runWithConcurrency`'s returned
      // failure list) so one record's outcome never depends on another's
      // ordering, matching the isolation the old serial loop's per-iteration
      // `try`/`catch` gave.
      let skippedQuarantinedCount = 0;
      let deferredToWakeCount = 0;
      await runWithConcurrency(
        live,
        RESTORE_CONCURRENCY,
        async ({ deploymentId, record }) => {
          // Skip WITHOUT attempting: a permanently unrestorable record that
          // has already crossed RESTORE_QUARANTINE_THRESHOLD gets neither a
          // spawn attempt nor a per-record warning this boot -- both are
          // pointless for a deterministic failure that has already been
          // reported that many times. It still counts toward the one
          // summary line below, and the record itself is untouched (an
          // operator reclaims it by undeploying the address).
          if (isWorkflowDeploymentRestoreQuarantined(record)) {
            skippedQuarantinedCount += 1;
            return;
          }
          try {
            const outcome = await withRestoreTimeout(
              (signal) =>
                restoreDeploymentFromRecord(
                  dataDir,
                  deploymentId,
                  record,
                  signal,
                ),
              deploymentId,
              restoreAttemptTimeoutMs,
            );
            if (outcome === "deferred-to-wake") {
              deferredToWakeCount += 1;
              return;
            }
            if (record.restoreFailure !== undefined) {
              await clearWorkflowDeploymentRestoreFailure(
                dataDir,
                deploymentId,
                record,
              );
            }
          } catch (cause) {
            const reason =
              cause instanceof Error ? cause.message : String(cause);
            const kind =
              cause instanceof WorkflowRestoreFailure
                ? cause.kind
                : "transient";
            // CL-7215: serialized against `restoreDeploymentFromRecord`'s
            // own late-settle correction AND `teardownDeployment`'s record
            // writes via the same lock, and gated on `activeSupervisors` --
            // in-memory, always set synchronously the instant
            // `spawnWorkflowDeployment` actually succeeds, unlike a disk
            // snapshot -- so a restore that timed out here but has ALREADY
            // gone live by the time this runs never gets a boot failure
            // recorded against it in the first place. See the lock's own
            // doc comment for why every writer must go through it.
            await withDeploymentRecordLock(deploymentId, async () => {
              if (activeSupervisors.has(record.agentAddress)) {
                logger.warn`Workflow deployment ${deploymentId} timed out during boot restore but finished spawning before its failure could be recorded; leaving its record as a live, successful restore`;
                return;
              }
              const updated = await recordWorkflowDeploymentRestoreFailure(
                dataDir,
                deploymentId,
                { kind, reason },
              );
              if (updated === undefined) {
                // The record is gone -- a concurrent reclaiming teardown
                // won the lock first and deleted it. Nothing to mark: the
                // deployment was torn down on purpose, not left claiming a
                // false restore failure.
                return;
              }
              if (isWorkflowDeploymentRestoreQuarantined(updated)) {
                const attempts = updated.restoreFailure?.attempts ?? 0;
                logger.warn`Workflow deployment ${deploymentId} failed to restore ${attempts} consecutive times and is now quarantined -- it will not be retried again until the address is undeployed. Last failure: ${reason}`;
              } else {
                logger.warn`Failed to restore workflow deployment ${deploymentId}: ${reason}`;
              }
            });
          }
        },
      );
      if (skippedQuarantinedCount > 0) {
        logger.warn`Skipped ${skippedQuarantinedCount} quarantined workflow deployment record(s) (permanent restore failures, already reported); undeploy an address to clear its record`;
      }
      if (deferredToWakeCount > 0) {
        logger.info`Deferred ${deferredToWakeCount} single-step workflow deployment(s) to their lazy-wake path instead of restoring from a frozen sources snapshot (CL-6648); they redeploy against a current catalog resolution on their next message or routine fire`;
      }
    },
    async reapExpiredHibernationSnapshots(): Promise<number> {
      if (stepStateDataDir === undefined) return 0;
      const { reapedEntries } = await reapVaultSnapshots(stepStateDataDir);
      if (reapedEntries.length > 0) {
        logger.info`Reaped ${reapedEntries.length} expired hibernated-agent-identity snapshot(s)`;
      }
      return reapedEntries.length;
    },
    activeAddresses(): string[] {
      // `activeSupervisors` holds exactly the deployments with a live
      // supervisor -- the set this sidecar can currently route mail to.
      return [...activeSupervisors.keys()];
    },
    async shutdownAll(): Promise<void> {
      // Process-exit drain, NOT an undeploy: every live supervisor is shut
      // down so each workflow-process child, its IPC pipes, and its
      // event-channel fd are released before the host exits, but every
      // deployment record, routing registration source of truth, and the
      // durable conversation root stay on disk untouched -- the next boot's
      // `restoreWorkflowDeployments` re-establishes each deployment from
      // them.
      await Promise.all(
        [...activeSupervisors.entries()].map(async ([address, wired]) => {
          activeSupervisors.delete(address);
          try {
            await shutdownSupervisorWithEscalation(wired);
          } catch (cause) {
            const reason =
              cause instanceof Error ? cause.message : String(cause);
            logger.warn`Drain: supervisor shutdown for ${address} failed: ${reason}`;
          }
        }),
      );
    },
  };
}
