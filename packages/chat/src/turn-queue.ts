// One in-flight turn per workbench (CL-6331): a burst of messages
// arriving for the same workbench while a turn is already running must
// queue rather than dispatch concurrently, and — Buzz's rule — every
// message that queued behind one in-flight turn dispatches together as
// ONE next turn, in arrival order, rather than each replaying its own
// separate dispatch once the claim frees up.
//
// "Turn" here means what `dispatchTurn` (`./workbench-service.ts`) can
// actually observe: the fan-out for one incoming message, to however
// many recipients it resolves to. `dispatchTurn` itself only reaches
// "the mail was handed to the agent's mailbox" — the agent's real
// processing happens later, off this call stack, and lands back on the
// timeline through the orchestrator (CL-6329, not yet built). So
// "release on completion" below means "release once this seam's own
// dispatch call settles", not "once the agent finished replying" —
// exactly the gap `./turn-claims.ts`'s TTL exists to backstop.
import { reportError } from "@corbits/error-sink";
import { getLogger } from "@intx/log";
import { type } from "arktype";

import type { Part as PartType } from "./parts";
import type { TurnClaimStore, TurnClaimToken } from "./turn-claims";
import type { WorkbenchSubscriberRegistry } from "./workbench-events";

const log = getLogger(["chat", "turn-queue"]);

/**
 * The non-persisted stream event a room's client renders as the queued
 * strip. Never written to the timeline — a queued message's own
 * message row already carries it there; this is only the live signal
 * that its turn is waiting, not what it says.
 */
export const TurnQueuedEvent = type({
  type: "'chat.turn-queued'",
  data: {
    workbenchId: "string",
    messageId: "string",
    queueLength: "number",
  },
});
export type TurnQueuedEvent = typeof TurnQueuedEvent.infer;

export type QueuedTurn = {
  readonly messageId: string;
  readonly principalId: string;
  readonly recipients: readonly string[];
  readonly parts: readonly PartType[];
};

export type WorkbenchTurnQueueDeps = {
  readonly claims: TurnClaimStore;
  readonly publish: WorkbenchSubscriberRegistry["publish"];
};

/**
 * Dispatches one turn's worth of (possibly batched) recipients. Must
 * never reject — exactly like `routeMessage`'s own contract in
 * `workbench-service.ts`, which this wraps: a recipient that fails is
 * `dispatch`'s own job to report (an undelivered notice on the
 * timeline), never something this queue has to catch. `run` below
 * still guards this contract itself (a rejection is reported via
 * `reportError` and treated as a settled, empty turn) so a `dispatch`
 * that breaks it degrades to a logged defect rather than stranding
 * whatever queued behind it.
 */
export type DispatchTurnBatch = (batch: readonly QueuedTurn[]) => Promise<void>;

export type WorkbenchTurnQueue = {
  /**
   * Runs `turn` as this workbench's in-flight turn if none is
   * currently claimed, via `dispatch`. Otherwise queues `turn` behind
   * whichever turn is running and publishes `chat.turn-queued` so the
   * room can render the queued strip; the queued turn dispatches later,
   * batched with whatever else queued alongside it, once the in-flight
   * turn's claim releases. Never rejects: queueing always succeeds, and
   * `dispatch`'s own failure is `dispatch`'s to report (see
   * `dispatchTurn`'s per-recipient handling in `workbench-service.ts`).
   */
  run(
    workbenchId: string,
    turn: QueuedTurn,
    dispatch: DispatchTurnBatch,
  ): Promise<void>;
};

export function createWorkbenchTurnQueue(
  deps: WorkbenchTurnQueueDeps,
): WorkbenchTurnQueue {
  // Process-local, paired one-to-one with `deps.claims`: a multi-replica
  // hub would need every workbench's turns routed to the same replica,
  // or replica B enqueues here into a `Map` replica A never reads and a
  // turn queued on B is never dispatched at all. This queue is
  // single-replica-only until the pending list moves into whatever
  // store backs `deps.claims`.
  const pendingByWorkbench = new Map<string, QueuedTurn[]>();

  // Runs `firstBatch` (already claimed under `token`) to completion,
  // draining whatever else queues behind it under the same claim, then
  // releases. Holds the claim across every batch rather than releasing
  // and re-claiming between them: releasing early would open a window
  // (each `await` is a yield point) where a fresh, unrelated call could
  // win the claim ahead of a batch that was already queued and waiting
  // — breaking the ordering this queue exists to guarantee.
  //
  // `dispatch` is the one `await` in this loop the TTL backstop
  // (CL-7129) can fire during: a dispatch that outlives `ttlMs` lets a
  // second, unrelated `run()` call win a fresh claim and start its own
  // drain of this same `pendingByWorkbench` entry. The `holds` check
  // right after each `dispatch` is how this loop notices that happened
  // and stops — leaving whatever is still queued for the new holder to
  // pick up — instead of popping and dispatching a batch the new holder
  // is already about to dispatch itself.
  async function drain(
    workbenchId: string,
    firstToken: TurnClaimToken,
    firstBatch: readonly QueuedTurn[],
    dispatch: DispatchTurnBatch,
  ): Promise<void> {
    let token = firstToken;
    let batch = firstBatch;
    // The claim store's own contract (`./turn-claims.ts`) requires a won
    // claim to be "never left un-called on a path that can still
    // complete" — the outer try/catch is what makes that hold even when
    // `holds`/`release`/`tryClaim` themselves reject (a durable store
    // doing I/O can, unlike the in-memory one), not just when they
    // resolve normally. `dispatch` gets its own inner try/catch because
    // a rejecting dispatch is an expected, contract-violating case this
    // loop must keep draining through, not stop for.
    try {
      for (;;) {
        try {
          await dispatch(batch);
        } catch (err) {
          const messageIds = batch.map((t) => t.messageId);
          const refId = reportError(err, {
            operation: "chat.turnQueue.dispatch",
            roomId: workbenchId,
            extra: { messageIds },
          });
          // `dispatch` documents "must never reject" (see `DispatchTurnBatch`);
          // reaching here means some caller broke that contract.
          log.error(
            'turn queue: dispatch rejected for workbench {workbenchId}, message(s) {messageIds} (ref {refId}), violating its "never reject" contract: {err}',
            { workbenchId, messageIds, refId, err },
          );
        }

        if (!(await deps.claims.holds({ workbenchId }, token))) {
          // The TTL backstop already reassigned this claim to a fresh
          // `run()` call; that call's own loop now owns draining
          // whatever is pending here.
          return;
        }

        const queued = pendingByWorkbench.get(workbenchId);
        if (queued !== undefined && queued.length > 0) {
          pendingByWorkbench.delete(workbenchId);
          batch = queued;
          continue;
        }

        const released = await deps.claims.release({ workbenchId }, token);
        if (!released) return;

        // `release` can itself await (any durable store reopens exactly
        // this window — see `./turn-claims.ts`'s own doc comment): a
        // concurrent `run()` whose `tryClaim` read us as still holding,
        // before this `release` took effect, pushed onto
        // `pendingByWorkbench` with nobody left holding the claim to
        // drain it. Recheck and reclaim rather than stranding it — `run`'s
        // enqueue path below runs the symmetric dance from its own side,
        // so between the two, whichever notices the claim is free first
        // picks up what's pending.
        const late = pendingByWorkbench.get(workbenchId);
        if (late === undefined || late.length === 0) return;

        const reclaimed = await deps.claims.tryClaim({ workbenchId });
        if (reclaimed === false) return; // the new holder's own loop will see it

        const afterReclaim = pendingByWorkbench.get(workbenchId);
        if (afterReclaim === undefined || afterReclaim.length === 0) {
          // Drained by whoever we raced against for the reclaim itself.
          await deps.claims.release({ workbenchId }, reclaimed);
          return;
        }
        pendingByWorkbench.delete(workbenchId);
        token = reclaimed;
        batch = afterReclaim;
      }
    } catch (err) {
      const refId = reportError(err, {
        operation: "chat.turnQueue.drain",
        roomId: workbenchId,
      });
      log.error(
        "turn queue: claim store call failed for workbench {workbenchId} (ref {refId}): {err}",
        { workbenchId, refId, err },
      );
      // Best-effort: `token` may already be released (this call then
      // no-ops per the store's contract) or may be the one this loop
      // never got to release because the failure happened first either
      // way, attempting it is strictly better than leaking it until the
      // TTL backstop expires.
      await deps.claims.release({ workbenchId }, token).catch(() => undefined);
    }
  }

  return {
    async run(workbenchId, turn, dispatch) {
      const token = await deps.claims.tryClaim({ workbenchId });
      if (token !== false) {
        await drain(workbenchId, token, [turn], dispatch);
        return;
      }

      const queue = pendingByWorkbench.get(workbenchId) ?? [];
      queue.push(turn);
      pendingByWorkbench.set(workbenchId, queue);
      deps.publish(workbenchId, {
        type: "chat.turn-queued",
        data: {
          workbenchId,
          messageId: turn.messageId,
          queueLength: queue.length,
        },
      });

      // Symmetric to `drain`'s own reclaim above: the holder we lost
      // `tryClaim` to may already have released — its own emptiness
      // check ran before this push landed — leaving nobody holding the
      // claim to drain what was just enqueued. Reclaim in that case
      // rather than returning with the turn stranded. `run` documents
      // "never rejects", so a claim store that throws here (rather than
      // resolving `false`) is caught and reported, same as `drain`'s own
      // guard, instead of propagating out.
      try {
        const reclaimed = await deps.claims.tryClaim({ workbenchId });
        if (reclaimed === false) return;

        const batch = pendingByWorkbench.get(workbenchId);
        pendingByWorkbench.delete(workbenchId);
        if (batch === undefined || batch.length === 0) {
          await deps.claims.release({ workbenchId }, reclaimed);
          return;
        }
        await drain(workbenchId, reclaimed, batch, dispatch);
      } catch (err) {
        const refId = reportError(err, {
          operation: "chat.turnQueue.enqueueReclaim",
          roomId: workbenchId,
        });
        log.error(
          "turn queue: claim store call failed for workbench {workbenchId} (ref {refId}): {err}",
          { workbenchId, refId, err },
        );
      }
    },
  };
}
