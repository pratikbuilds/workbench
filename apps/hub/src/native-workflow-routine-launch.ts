// Routes a multi-step routine definition onto Interchange's native
// workflow-run trigger primitive instead of `@corbits/folded-runs`'
// single-step fold.
//
// A multi-step `workflow_definition` can only exist in this repo as a
// code-sourced `@intx/workflow` package deployed through
// `POST /workflows/deployments`
// (`vendor/intx/hub-api/src/routes/workflows.ts`, backed by
// `sessionService.deployWorkflowFromSource`) — `@corbits/folded-runs`'
// `readFoldedBody` throws `MultiStepFoldUnsupportedError` for exactly
// this reason (see `packages/folded-runs/src/definition.ts`): its
// deploy target, `@corbits/agent-runtime`'s single-turn
// `AgentRuntimeConfig`, has no notion of step order, so folding a
// multi-step body into it would silently run step one and drop the
// rest. Since a code-sourced deploy is the ONLY way a multi-step
// definition is created, a live deployment (a self-anchored
// `workflow_run` row, `anchorRunId === id`) already exists for it by
// construction — this module finds that anchor and fires it with a
// signed mail message, the same native primitive
// `POST /workflows/:id/mail`
// (`vendor/intx/hub-api/src/workflow-run-trigger.ts`) delivers over.
// That trigger function itself is not exported from `@intx/hub-api`'s
// public surface, so the message is assembled here from the same
// public `@intx/mime`/`@intx/crypto` primitives it uses, and delivered
// through `SidecarRouter.routeMail` — a public method every
// `FoldedRunsDeps` caller (including the routine launcher) already
// holds.
//
// Grant authorization for this mail-triggered run is materialized by
// the vendored session orchestrator's own `mail.outbound` handler
// (`vendor/intx/hub-sessions/src/ws/sidecar-handler.ts`), via
// `materializeMailTriggeredRunGrants` — wired in `apps/hub/src/index.ts`
// from `@intx/hub-api`'s exported `createMailTriggeredRunGrantsMaterializer`.
// Nothing here stages or commits the run's grants directly: delivering
// the mail is enough, because that wiring authorizes every native
// deployment's inbound mail transparently, the same way it already did
// for the dedicated HTTP trigger route.
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { workflowRun, isLiveWorkflowRunStatus } from "@intx/db/schema";
import {
  assembleSignedContent,
  assembleMessage,
  createDetachedSignatureFromProvider,
  type MessageHeaders,
} from "@intx/mime";
import { generateKeyPair, createEd25519Crypto } from "@intx/crypto";
import { base64Encode } from "@intx/types";
import { generateId } from "@intx/hub-common";
import type { SidecarRouter } from "@intx/hub-sessions";

/**
 * Thrown when a multi-step definition has no live, self-anchored
 * deployment to trigger — either it was never deployed via
 * `POST /workflows/deployments`, or its deployment has since gone
 * terminal. Carries consumer language, mirroring
 * `MultiStepFoldUnsupportedError` and `DefinitionProjectionMissingError`,
 * so `apps/hub/src/hub-error-handler.ts` answers with a named 4xx
 * instead of an unhandled 500.
 */
export class NativeWorkflowDeploymentMissingError extends Error {
  readonly definitionId: string;
  readonly guidance: string;
  constructor(definitionId: string) {
    const guidance =
      "This workflow has multiple steps and must be deployed " +
      "(POST /workflows/deployments) before a routine can launch it — " +
      "deploy it once, then run this routine again.";
    super(
      `definition ${definitionId} has no live native deployment (${guidance})`,
    );
    this.name = "NativeWorkflowDeploymentMissingError";
    this.definitionId = definitionId;
    this.guidance = guidance;
  }
}

export type NativeWorkflowRoutineTriggerDeps = {
  db: DB["db"];
  sidecarRouter: SidecarRouter;
};

export type NativeWorkflowRoutineTriggerParams = {
  tenantId: string;
  definitionId: string;
  principalId: string;
  fromDomain: string;
  /** The routine's rendered input, or a placeholder when it stored
   * none — unlike a folded single-turn agent (which can start from its
   * system prompt with no mail at all), a native deployment's run only
   * starts on its first trigger mail, so this can never be skipped. */
  content: string;
};

export type TriggeredNativeWorkflowRun = {
  readonly runId: string;
  readonly address: string;
};

/**
 * Finds the definition's live, self-anchored deployment and fires it
 * with one signed mail message carrying `content`. Returns the
 * deployment's own anchor run id — the same coarse handle
 * `POST /workflows/:id/mail` itself returns synchronously (its true
 * doc comment: "the run id is minted by the supervisor on the sidecar
 * side and is not known synchronously here"). A caller that needs the
 * precise per-fire child run resolves it by polling
 * `GET /workflows/:id/runs` for a run id that did not exist before this
 * call, then that run's own `/events` for its terminal event — see
 * `scripts/e2e/cl-6324-launch-proof.ts`'s `driveSectionOccurrence` for
 * the proven pattern. This function's return value is deliberately the
 * coarser deployment-level handle until a per-fire join is built.
 */
export async function triggerNativeWorkflowRoutineRun(
  deps: NativeWorkflowRoutineTriggerDeps,
  params: NativeWorkflowRoutineTriggerParams,
): Promise<TriggeredNativeWorkflowRun> {
  const [anchor] = await deps.db
    .select({
      id: workflowRun.id,
      address: workflowRun.address,
      status: workflowRun.status,
    })
    .from(workflowRun)
    .where(
      and(
        eq(workflowRun.definitionId, params.definitionId),
        eq(workflowRun.tenantId, params.tenantId),
        eq(workflowRun.anchorRunId, workflowRun.id),
      ),
    )
    .orderBy(desc(workflowRun.createdAt))
    .limit(1);

  if (
    anchor === undefined ||
    anchor.address === null ||
    !isLiveWorkflowRunStatus(anchor.status)
  ) {
    throw new NativeWorkflowDeploymentMissingError(params.definitionId);
  }
  const address = anchor.address;

  const messageId = `<${generateId("sessionMail")}@${params.fromDomain}>`;
  const keyPair = await generateKeyPair();
  const crypto = createEd25519Crypto(keyPair);
  const headers: MessageHeaders = {
    from: `${params.principalId}@${params.fromDomain}`,
    to: [address],
    cc: undefined,
    date: new Date(),
    messageId,
    subject: undefined,
    inReplyTo: undefined,
    references: undefined,
    mimeVersion: "1.0",
    interchangeType: "conversation.message",
    interchangeCorrelationId: undefined,
    interchangeTenantId: params.tenantId,
    interchangeAgentId: undefined,
    interchangeSessionId: undefined,
    interchangeOfferingId: undefined,
    interchangeSchemaVersion: undefined,
    traceparent: undefined,
    tracestate: undefined,
  };
  const signedContent = assembleSignedContent({
    kind: "conversation",
    text: params.content,
  });
  const signature = await createDetachedSignatureFromProvider(
    signedContent,
    crypto,
  );
  const rawMessage = assembleMessage(headers, signedContent, signature);
  const base64 = base64Encode(rawMessage);

  const delivered = deps.sidecarRouter.routeMail(address, base64, messageId);
  if (!delivered) {
    throw new Error(
      `native workflow deployment ${address} is not routable; cannot deliver routine's trigger mail`,
    );
  }

  return { runId: anchor.id, address };
}
