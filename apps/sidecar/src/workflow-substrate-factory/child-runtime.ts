// In-process child runtime for the workflow-process child: the
// terminal-only `runChild` adapter, the park-aware suspendable-child
// adapter an onTrigger section drives across approval parks, the shared
// per-childRunId env construction, and the body's on-disk
// inference-source read. Sub-namespace scoping keeps every child's
// events under `runs/<childRunId>/...` of the parent's workflow-run
// repo; the child reuses the parent's wrapped substrate and principal.

import fs from "node:fs";
import path from "node:path";

import { createDefaultDirectorRegistry } from "@intx/agent";
import type { DirectorRegistry } from "@intx/agent";
import type {
  Principal,
  RepoId,
  RepoStore,
} from "@intx/hub-sessions/substrate";
import { signalName } from "@intx/types";
import type { InferenceEvent } from "@intx/types/runtime";
import {
  createNoopDrainController,
  emptyState,
  rewriteInlineChildWorkflowBodies,
  runtimeRun,
  type Scheduler,
  type StepInvokeRequest,
  type StepInvokeResult,
  type StepInvoker,
  type SuspendableChildPark,
  type WorkflowAuthorizeFn,
  type WorkflowDefinition,
  type WorkflowRuntimeEnv,
} from "@intx/workflow";
import {
  createWorkflowHostSignalChannel,
  createWorkflowRunBlobSubstrate,
  createWorkflowRunRepoStore,
  createInMemorySpawnChild,
  type CredentialWiring,
  type RunChildWorkflow,
  type RunSuspendableChild,
  type SourcesSnapshotRef,
} from "@intx/workflow-host";
import type { MailPartReader } from "@intx/types/runtime";
import { reportError } from "@corbits/error-sink";

import {
  parseStepInferenceSources,
  type StepInferenceSourceTable,
} from "./config";

function fireAndForget(
  work: Promise<unknown>,
  operation: string,
  childRunId: string,
  report: typeof reportError,
): void {
  void work.catch((error: unknown) => {
    report(error, {
      operation,
      extra: { childRunId },
    });
  });
}

/**
 * Real per-step invoker for an onTrigger BODY child, distinct from the
 * `StepInvoker` stub the shared `SidecarRunChildDeps.invokeStep` carries for
 * childWorkflow spawns (which stay `ChildStepNotImplementedError` until
 * childWorkflow agent execution is built). The body invoker runs a real
 * agent through `createWorkflowStepInvoker`, so it widens the stub with the
 * body's own per-step inference `sourcesRef` -- built fresh per body spawn
 * from the body's on-disk `sources.json`, disjoint from the top-level's
 * mutable source table so a top-level source rotation never leaks into a
 * body. It also carries an `onEvent` funnel that attributes the body child's
 * live inference events to the body run id on the hub timeline, the
 * workflow-typed `authorize` the spawn seam threaded from the parent child
 * (CL-6448: the credentials-backed authorize, so a body agent's tool calls
 * gate through the same per-step grant snapshot a top-level step's do),
 * the parent's live `CredentialWiring` for tool bundles that declare a
 * `credentials` capability, and the parent's `MailPartReader` so a body's
 * attachments-only inbound mail resolves its parts instead of throwing.
 */
export type SidecarBodyStepInvoker = (
  req: StepInvokeRequest,
  authorize: WorkflowAuthorizeFn,
  sourcesRef: SourcesSnapshotRef,
  onEvent: (event: InferenceEvent) => void,
  credentialWiring?: CredentialWiring,
  mailPartReader?: MailPartReader,
) => Promise<StepInvokeResult>;

/**
 * Inputs required to construct the sidecar's in-process child runtime.
 * Lifted out of `createSidecarSubstrateFactory` so the implementation
 * is exercisable in isolation (the co-located test wires a hand-built
 * substrate/principal/scheduler/invokeStep against this surface).
 *
 * Sub-namespace scoping: the child runtime is invoked with
 * `runId: childRunId`. The runtime body threads that id through every
 * `repoStore.read/append/subscribe` call, every `blobs.recordOutput`
 * call, and every `signalChannel.deliver/awaitNext` call. The host-
 * adapter implementations (`createWorkflowRunRepoStore`,
 * `createWorkflowRunBlobSubstrate`, `createWorkflowHostSignalChannel`)
 * each compute their on-disk path as `runs/<runId>/...` against the
 * supplied workflow-run repo. The net effect is that the child's
 * events land under `runs/<childRunId>/events/<seq>.json` of the
 * parent's workflow-run repo, sibling to the parent's own
 * `runs/<parentRunId>/...` subtree.
 *
 * Substrate identity: the child reuses the parent's wrapped `RepoStore`
 * (the workflow-run pack-pushing wrap installed by the factory) so a
 * successful child write fires the same hub pack push the parent's
 * writes do. The substrate's signing principal (a workflow-process
 * principal scoped to the parent's deploymentId) is reused verbatim
 * because the child runs under the same supervisor authority.
 */
export interface SidecarRunChildDeps {
  /** Wrapped workflow-run substrate (the factory's `substrate`). */
  substrate: RepoStore;
  /** Workflow-run repo identifying the parent's deployment. */
  workflowRunRepoId: RepoId;
  /** Workflow-run ref the child reads/writes against. */
  workflowRunRef: string;
  /** Principal the child presents on every substrate operation. */
  principal: Principal;
  /** Host-process scheduler singleton; shared with the parent. */
  scheduler: Scheduler;
  /**
   * Step invoker the child runtime delegates per-step invocations to.
   *
   * The in-process child runs a WorkflowDefinition whose stepIds are
   * disjoint from the parent's. The parent's
   * `STEP_INFERENCE_SOURCES`-pinned `buildStepEnv` knows only the
   * parent's stepIds and throws on any other id; routing the child's
   * step invocations through that closure surfaces a misleading
   * "no InferenceSource pinned" error for every child step. Callers
   * therefore supply a SEPARATE invokeStep for the child that does
   * not consult the parent's pinned source table. The substrate
   * factory's default wires a stub that mirrors the parent's stub
   * step output (`{ output: { reply: req.agent.id, turn: null } }`)
   * without resolving any per-step InferenceSource -- threading the
   * child's WorkflowDefinition-derived sources into a real inference
   * call is not yet built, for the same reason the parent's stub
   * exists.
   */
  invokeStep: StepInvoker;
  /**
   * Real per-step invoker used ONLY for an onTrigger body child's own steps.
   * `createSidecarSpawnSuspendableChild` wires it onto the body env; the
   * shared `invokeStep` stub above stays the seam for childWorkflow spawns
   * and for the body's own childWorkflow grandchildren. Absent leaves the
   * body on the stub (the behavior an isolation test may exercise).
   */
  bodyInvokeStep?: SidecarBodyStepInvoker;
  /**
   * Sidecar data dir, used ONLY on the body path to read a body's on-disk
   * `assets/workflow/<bodyRef>/sources.json` and build the body's per-step
   * inference `sourcesRef`. Required whenever `bodyInvokeStep` is wired.
   */
  dataDir?: string;
  /** Director registry the child runtime uses; defaults to the canonical built-ins. */
  directors?: DirectorRegistry;
  /** Clock for timestamp generation; defaults to `() => new Date()`. */
  clock?: () => Date;
  /**
   * Random id generator for run ids, signal ids, timer ids; defaults to
   * a monotonic counter combined with a random suffix.
   */
  newId?: (prefix: string) => string;
  /**
   * Test seam only — no production caller ever sets this. Defaults to
   * `@intx/workflow`'s `runtimeRun`. Exists because bun's `mock.module`
   * replaces a module process-wide and cannot be undone for later files
   * in the same `bun test` process.
   */
  runtimeRun?: typeof runtimeRun;
  /**
   * Test seam only — no production caller ever sets this. Defaults to
   * `@corbits/error-sink`'s `reportError`. Paired with `runtimeRun` so a
   * cancel-rejection test can observe reports without a process-wide
   * module swap.
   */
  reportError?: typeof reportError;
  /**
   * Test seam only — no production caller ever sets this. Defaults to
   * `@intx/workflow-host`'s `createWorkflowHostSignalChannel`. Paired with
   * `reportError` so a stop-rejection test can observe reports without a
   * process-wide module swap.
   */
  createSignalChannel?: typeof createWorkflowHostSignalChannel;
}

/**
 * Construct the `RunChildWorkflow` callback the spawn-child adapter
 * delegates to. The returned callback, when invoked with the parent
 * runtime's attribution + the parent-allocated `childRunId` + the
 * resolved `WorkflowDefinition`, builds a fresh `WorkflowRuntimeEnv`
 * scoped to `childRunId`, invokes `runtimeRun`, and returns the
 * child's terminal status.
 *
 * Abort propagation: the parent-supplied `signal` is observed at every
 * runtime observation point. If the signal aborts mid-flight the
 * runtime body's cancel cascade fires and the returned promise
 * resolves with `terminalStatus: "cancelled"`. A pre-aborted signal is
 * handled by the spawn-child adapter's entry-time short-circuit; the
 * runChild callback itself does not see the pre-abort case.
 *
 * Resource lifecycle: the child's per-run signal channel handle is
 * `stop()`ped in a finally block so any background `subscribeKind`
 * loop tied to the child's runId tears down before the callback
 * returns. The blob substrate, repo store, and scheduler entries are
 * either per-call (no handle to dispose) or shared with the parent
 * (the scheduler).
 */
export function createSidecarRunChild(
  deps: SidecarRunChildDeps,
): RunChildWorkflow {
  const directors = deps.directors ?? createDefaultDirectorRegistry();
  const clock = deps.clock ?? defaultClock;
  const newId = deps.newId ?? defaultNewId;
  const startRun = deps.runtimeRun ?? runtimeRun;
  const report = deps.reportError ?? reportError;
  // The in-process child runs under real supervisor authority; its
  // control-plane cancel (`CancelRequested`) must be signed by a supervisor
  // principal, which the kind handler requires and the substrate authorizes
  // for this deployment. Run-body events keep their workflow-process
  // attribution.
  const supervisorPrincipal = {
    kind: "supervisor" as const,
    deploymentId: deps.workflowRunRepoId.id,
  };
  // Created once and shared across every child this factory spawns (the
  // runtime scopes reads/subscribes by runId), so sibling and grandchild
  // spawns route through one repo-store handle rather than a fresh one each.
  const repoStore = createWorkflowRunRepoStore({
    substrate: deps.substrate,
    repoId: deps.workflowRunRepoId,
    principal: deps.principal,
    controlPlanePrincipal: supervisorPrincipal,
    ref: deps.workflowRunRef,
  });
  // Self-referential `RunChildWorkflow` so a child env's recursive
  // `spawnChild` (wired inside `buildChildRunEnv`) can route grandchild
  // spawns back through the same adapter. Each invocation builds a
  // per-runId env that itself wires an in-memory `spawnChild` resolver whose
  // `runChild` is this same `runChild` constant -- the recursion bottoms out
  // when a rung's `WorkflowDefinition` has no `childWorkflow` primitive.
  // Sub-namespace scoping continues to hold at every depth because
  // `childRunId` flows verbatim into the per-rung
  // `blobs`/`signalChannel`/`runtimeRun` calls, keeping every rung's
  // events under `runs/<runId>/...` of the parent's workflow-run repo.
  const runChild: RunChildWorkflow = async ({
    definition,
    childRunId,
    input,
    signal,
  }) => {
    const {
      env,
      signalChannel,
      definition: rewrittenDefinition,
    } = buildChildRunEnv({
      deps,
      directors,
      clock,
      newId,
      repoStore,
      runChild,
      definition,
      childRunId,
    });
    try {
      const handle = startRun(rewrittenDefinition, env, {
        runId: childRunId,
        triggerPayload: input,
      });
      // The resulting `CancelRequested` is written under the supervisor
      // principal wired into this run's repo store (see
      // `controlPlanePrincipal` above): the kind handler requires a
      // supervisor signer for any cancel origin, so a
      // workflow-process-signed cancel would be refused and a parent abort
      // would surface as a failed rather than cancelled child.
      const cancelOnAbort = (): void => {
        fireAndForget(
          handle.cancel("supervisor-operator", "parent cancelled"),
          "sidecar.child-runtime.cancel",
          childRunId,
          report,
        );
      };
      if (signal.aborted) {
        cancelOnAbort();
      } else {
        signal.addEventListener("abort", cancelOnAbort, { once: true });
      }
      try {
        const result = await handle.complete;
        return { terminalStatus: result.terminalStatus };
      } finally {
        signal.removeEventListener("abort", cancelOnAbort);
      }
    } finally {
      await signalChannel.stop();
    }
  };
  return runChild;
}

/**
 * Construct the `RunSuspendableChild` callback the suspendable-spawn
 * adapter delegates to. The park-aware analog of
 * {@link createSidecarRunChild}: instead of awaiting the child's terminal,
 * it returns a live `SuspendableChildHandle` the caller (`runOnTrigger`)
 * drives across the body's approval parks.
 *
 * Park surfacing: the built env's `onPark` sink translates the child body's
 * control-plane parks into the handle's `next()` stream. An `"approval"`
 * park is queued for the caller to proxy up on the same correlation; the
 * caller's granted decision returns through `resume`, which delivers it on
 * the child's own signal channel so the parked step unblocks. A body that
 * parks on a control-plane `"input"` channel is a nested onTrigger re-arm
 * the suspendable seam does not service -- the caller proxies approvals
 * only, so nothing would ever deliver that input and the child would park
 * forever. Rather than drop the park and hang, `onPark` surfaces it as a
 * hard error on `next()` and cancels the child so the section run ends
 * loudly.
 *
 * Signal-channel lifecycle: unlike `createSidecarRunChild`, which stops the
 * channel in a `finally` around a single awaited terminal, this keeps the
 * channel alive across every park (so `resume` can deliver) and ties its
 * teardown to the run's terminal -- the one lifecycle moment every path
 * funnels through (normal completion, cancel-on-abort, an
 * illegal-input-park cancel, or a runtime failure). Tearing down
 * per-`next()` would leak the channel when a parent abort makes
 * `runOnTrigger` stop calling `next()` mid-park.
 *
 * Abort propagation: the parent-supplied `signal` is threaded via
 * `handle.cancel` exactly as `createSidecarRunChild` does; the child
 * runtime takes no abort signal of its own.
 */
export function createSidecarSpawnSuspendableChild(
  deps: SidecarRunChildDeps,
): RunSuspendableChild {
  const directors = deps.directors ?? createDefaultDirectorRegistry();
  const clock = deps.clock ?? defaultClock;
  const newId = deps.newId ?? defaultNewId;
  const startRun = deps.runtimeRun ?? runtimeRun;
  const report = deps.reportError ?? reportError;
  // The in-process body child runs under real supervisor authority; its
  // control-plane cancel (`CancelRequested`) must be signed by a supervisor
  // principal, which the kind handler requires and the substrate authorizes
  // for this deployment. Run-body events keep their workflow-process
  // attribution.
  const supervisorPrincipal = {
    kind: "supervisor" as const,
    deploymentId: deps.workflowRunRepoId.id,
  };
  const repoStore = createWorkflowRunRepoStore({
    substrate: deps.substrate,
    repoId: deps.workflowRunRepoId,
    principal: deps.principal,
    controlPlanePrincipal: supervisorPrincipal,
    ref: deps.workflowRunRef,
  });
  // A body's own `childWorkflow` grandchildren spawn terminal-only: the
  // suspendable seam is exercised only by onTrigger sections, and
  // `buildChildRunEnv` wires the body env's `spawnChild` (not
  // `spawnSuspendableChild`), so a nested onTrigger inside a body fails
  // loud rather than silently spawning.
  const runChild = createSidecarRunChild(deps);

  return async (
    {
      definition,
      childRunId,
      input,
      resumeFromEvents,
      signal,
      authorize: threadedAuthorize,
      credentialWiring,
      mailPartReader,
    },
    onEvent,
  ) => {
    const {
      env: baseEnv,
      signalChannel,
      definition: rewrittenDefinition,
    } = buildChildRunEnv({
      deps,
      directors,
      clock,
      newId,
      repoStore,
      runChild,
      definition,
      childRunId,
    });

    // The BODY env runs real agent steps when the factory wired a body
    // invoker; the body's own childWorkflow grandchildren, built via the
    // internal `createSidecarRunChild(deps)` above, do NOT get it and stay
    // on the stub. The live event sink is paired with the body invoker: it
    // feeds the body's inference to the parent run's event channel.
    // The body's per-step sources are read fresh per spawn from the body's
    // on-disk `sources.json` when the body invoker is wired; the read is
    // awaited here (not inside `buildChildRunEnv`) so the env construction
    // stays synchronous for both paths.
    let invokeStep = baseEnv.invokeStep;
    if (deps.bodyInvokeStep !== undefined) {
      if (deps.dataDir === undefined) {
        throw new Error(
          "sidecar body child: bodyInvokeStep is wired but deps.dataDir is missing; the body's sources.json cannot be resolved",
        );
      }
      const bodySourcesRef: SourcesSnapshotRef = {
        current: await readBodyStepInferenceSources(
          deps.dataDir,
          rewrittenDefinition.id,
        ),
      };
      const bodyInvokeStep = deps.bodyInvokeStep;
      // CL-6448: prefer the parent child's credentials-backed authorize
      // the spawn seam threaded in; a spawn that carried none keeps the
      // fail-loud stub, so an unthreaded tool gate still surfaces
      // precisely rather than silently authorizing.
      const authorize = threadedAuthorize ?? baseEnv.authorize;
      invokeStep = (req) =>
        bodyInvokeStep(
          req,
          authorize,
          bodySourcesRef,
          onEvent,
          credentialWiring,
          mailPartReader,
        );
    }

    // FIFO the caller drains via `next()`: each entry is either an approval
    // park to proxy up, a signal park to relay, or a fatal illegal-park
    // error. A single waiter slot suffices because `next()` has exactly one
    // consumer (`runOnTrigger`) driving it sequentially, mirroring the
    // signal channel's single-consumer shape.
    type BodyEvent =
      | { kind: "park"; park: SuspendableChildPark }
      | { kind: "signal-park"; name: string }
      | { kind: "error"; error: Error };
    const events: BodyEvent[] = [];
    let wake: (() => void) | null = null;
    const notify = (): void => {
      if (wake !== null) {
        const resolve = wake;
        wake = null;
        resolve();
      }
    };

    const env: WorkflowRuntimeEnv = {
      ...baseEnv,
      invokeStep,
      onPark: (park) => {
        if (park.parkKind === "approval") {
          events.push({
            kind: "park",
            park:
              park.approvalSnapshot !== undefined
                ? {
                    correlationId: park.correlationId,
                    approvalSnapshot: park.approvalSnapshot,
                  }
                : { correlationId: park.correlationId },
          });
        } else {
          events.push({
            kind: "error",
            error: new Error(
              `onTrigger body ${childRunId} parked on a control-plane input ` +
                `channel (${park.correlationId}); a suspendable body may not ` +
                `re-arm an input park -- the section proxies approvals only, ` +
                `so this park has no resolver`,
            ),
          });
        }
        notify();
      },
      // A body `awaitSignal` gate on an author name: surface it so the
      // section proxies it up as a signal-relay await and relays the
      // resolved signal back via `deliverSignal`. Without this the body
      // would park on the signal channel with nothing upstream to route a
      // delivery to it.
      onSignalPark: (park) => {
        events.push({ kind: "signal-park", name: park.name });
        notify();
      },
    };

    // On resume, drive the run from its durable log; the body step re-parks
    // silently (a re-park does not re-fire onPark), and the caller relays
    // the grant via resume on the correlation it recovered from its own
    // log. On a fresh spawn, seed the run with the event's trigger payload.
    const handle = startRun(
      rewrittenDefinition,
      env,
      resumeFromEvents !== undefined
        ? { runId: childRunId, resumeFromEvents }
        : { runId: childRunId, triggerPayload: input },
    );

    // The resulting `CancelRequested` is written under the supervisor
    // principal wired into this run's repo store (see
    // `controlPlanePrincipal` above): the kind handler requires a
    // supervisor signer for any cancel origin, so a workflow-process-signed
    // cancel would be refused and a parent abort would surface as a failed
    // rather than cancelled child.
    const cancelOnAbort = (): void => {
      fireAndForget(
        handle.cancel("supervisor-operator", "parent cancelled"),
        "sidecar.child-runtime.cancel",
        childRunId,
        report,
      );
    };
    if (signal.aborted) {
      cancelOnAbort();
    } else {
      signal.addEventListener("abort", cancelOnAbort, { once: true });
    }

    let settled: {
      terminalStatus: "completed" | "failed" | "cancelled";
    } | null = null;
    let failure: Error | null = null;
    void handle.complete
      .then((result) => {
        settled = { terminalStatus: result.terminalStatus };
      })
      .catch((cause: unknown) => {
        failure = cause instanceof Error ? cause : new Error(String(cause));
      })
      .finally(() => {
        signal.removeEventListener("abort", cancelOnAbort);
        fireAndForget(
          signalChannel.stop(),
          "sidecar.child-runtime.signal-channel-stop",
          childRunId,
          report,
        );
        notify();
      });

    return {
      next: async () => {
        for (;;) {
          const event = events.shift();
          if (event !== undefined) {
            if (event.kind === "error") {
              // The body re-armed an input park nothing will resolve.
              // Cancel the child so its terminal (and the channel teardown
              // tied to it) fires, then surface the error: the throw lands
              // the section run's terminal via `runOnTrigger`.
              fireAndForget(
                handle.cancel(
                  "supervisor-operator",
                  "onTrigger body re-armed an unsupported input park",
                ),
                "sidecar.child-runtime.cancel",
                childRunId,
                report,
              );
              throw event.error;
            }
            if (event.kind === "signal-park") {
              return { kind: "signal-park", name: event.name };
            }
            return { kind: "park", park: event.park };
          }
          if (failure !== null) throw failure;
          if (settled !== null) {
            return {
              kind: "terminal",
              terminalStatus: settled.terminalStatus,
            };
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
      resume: async (correlationId, decision) => {
        await signalChannel.deliver(signalName(correlationId), decision);
      },
      deliverSignal: async (name, payload, signalId) => {
        await signalChannel.deliver(name, payload, signalId);
      },
    };
  };
}

/**
 * Build the per-childRunId `WorkflowRuntimeEnv` a spawned child runs
 * against: wire the per-run blob substrate / signal channel plus a
 * recursive `spawnChild`, with the child's `env.authorize` kept as the
 * throwing stub (the sub-namespace child does not inherit a per-step
 * credentials snapshot from the parent). Returned alongside the child's
 * signal channel so the caller owns its `stop()` lifecycle. Shared by the
 * terminal-only and suspendable child paths so the env construction lives
 * in one place.
 */
function buildChildRunEnv(args: {
  deps: SidecarRunChildDeps;
  directors: DirectorRegistry;
  clock: () => Date;
  newId: (prefix: string) => string;
  repoStore: ReturnType<typeof createWorkflowRunRepoStore>;
  runChild: RunChildWorkflow;
  definition: WorkflowDefinition;
  childRunId: string;
}): {
  env: WorkflowRuntimeEnv;
  signalChannel: ReturnType<typeof createWorkflowHostSignalChannel>;
  definition: WorkflowDefinition;
} {
  const { deps, directors, clock, newId, repoStore, runChild, definition } =
    args;
  const childRunId = args.childRunId;
  // A rung may itself embed a grandchild as an inline `childWorkflow`. Lift
  // each to an internal `{ ref }` and run the rewritten definition whose
  // children are refs -- the shape the runtime dispatches -- keeping the
  // lifted definitions in an in-memory map this rung's own resolver serves
  // from, so a grandchild spawns with no on-disk read at any depth.
  const { workflow: rewrittenDefinition, bodies: grandchildBodies } =
    rewriteInlineChildWorkflowBodies(definition);
  const grandchildMap = new Map(
    grandchildBodies.map((body) => [body.ref, body.definition]),
  );
  const blobs = createWorkflowRunBlobSubstrate({
    substrate: deps.substrate,
    repoId: deps.workflowRunRepoId,
    principal: deps.principal,
    runId: childRunId,
    ref: deps.workflowRunRef,
  });
  const startChannel =
    deps.createSignalChannel ?? createWorkflowHostSignalChannel;
  const signalChannel = startChannel({
    repoStore: deps.substrate,
    principal: deps.principal,
    repoId: deps.workflowRunRepoId,
    ref: deps.workflowRunRef,
    runId: childRunId,
    readState: () => emptyState(childRunId),
    newId: () => newId("sig"),
    clock,
  });
  // The child's `env.authorize` slot is the workflow-typed authorize
  // the runtime body stores; the runtime body never reads it
  // directly. Step invocations route through `invokeStep`, which
  // wires its own `BaseEnv.authorize` against the workflow-typed
  // callback. Throwing here surfaces a precise "no credentialsRef
  // installed" error if a future wiring forgets to inject one.
  const authorize: WorkflowAuthorizeFn = () => {
    // The slot is intentionally throwing: a step that actually calls
    // `env.authorize` is asking for a per-step credentials snapshot
    // that the sub-namespace child does not yet inherit from the
    // parent's `runWorkflowChild` credentialsRef. The slot is
    // observable to tests that wire an `invokeStep` bypassing
    // authorize.
    throw new Error(
      "sidecar runChild authorize: per-step credentials snapshot is not threaded through the spawn-child seam; the child runtime cannot resolve a workflow-typed authorize call",
    );
  };
  const drain = createNoopDrainController(rewrittenDefinition);
  // Recursive `spawnChild`: a grandchild embedded inline in this rung is
  // resolved from the in-memory map lifted above and flows back into this
  // same `runChild` callback. The runtime body's `runChildWorkflow` contract
  // is depth-agnostic; the in-memory resolver makes the sidecar's adapter
  // depth-agnostic too, with no on-disk read at any rung.
  const spawnChild = createInMemorySpawnChild({
    bodies: grandchildMap,
    runChild,
  });
  const env: WorkflowRuntimeEnv = {
    repoStore,
    scheduler: deps.scheduler,
    signalChannel,
    blobs,
    directors,
    authorize,
    invokeStep: deps.invokeStep,
    spawnChild,
    clock,
    newId,
    drain,
  };
  return { env, signalChannel, definition: rewrittenDefinition };
}

/**
 * Read an onTrigger body's per-step inference-source pins from
 * `${dataDir}/assets/workflow/<bodyRef>/sources.json`, staged beside the
 * body definition at deploy time. Parsed and validated through the same
 * `parseStepInferenceSources` boundary the top-level
 * `STEP_INFERENCE_SOURCES` env entry uses. A body's sources file is
 * guaranteed present (the deploy router materializes it for every
 * referenced body), so a missing or malformed file is a defect and
 * surfaces loudly rather than degrading to empty pins.
 */
async function readBodyStepInferenceSources(
  dataDir: string,
  bodyRef: string,
): Promise<StepInferenceSourceTable> {
  const sourcesPath = path.join(
    dataDir,
    "assets",
    "workflow",
    bodyRef,
    "sources.json",
  );
  let raw: string;
  try {
    raw = await fs.promises.readFile(sourcesPath, "utf8");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `sidecar body child: failed to read body inference sources at ${sourcesPath}: ${reason}`,
      { cause },
    );
  }
  return parseStepInferenceSources(raw);
}

function defaultClock(): Date {
  return new Date();
}

let runChildIdCounter = 0;
function defaultNewId(prefix: string): string {
  runChildIdCounter += 1;
  return `${prefix}-${String(runChildIdCounter)}-${Math.random().toString(36).slice(2, 8)}`;
}
