// The in-progress agent reply, streamed token-by-token: `chat.agent` SSE
// events already carry the vendored Interchange `InferenceEvent` union
// verbatim (see `packages/chat/src/platform-adapter.ts`'s
// `subscribeToWorkbench`, which wraps `sidecarRouter.subscribeAgent`'s raw
// callback payload with no filtering) — this module is the trust boundary
// that narrows that `unknown` payload and the pure state machine that turns
// a run of `inference.text.delta` events into one growing string.
//
// `inference.text.delta`'s `data.partial.text` is already cumulative (see
// `PartialMessage` in `@intx/types/src/runtime.ts`) — each delta is
// "all text streamed so far," not just the new token — so this module never
// concatenates fragments itself; it just takes the latest one.

import { useEffect, useRef, useState } from "react";

import { isAgentAddress, mentionedParticipants } from "@corbits/chat/mentions";
import { reportError } from "@corbits/error-sink";
import type { Part, ParticipantRecord } from "./api";
import {
  displayNameForAddress,
  type AgentDisplayNames,
} from "./agent-display-names";
import { displayNameFromHandle } from "./timeline";

/**
 * The current turn's reply state, phase-tagged (CL-6432 reopened):
 *
 * - `"awaiting"` — a turn is in flight and its visible reply hasn't posted
 *   yet: an empty `text` renders the typing pulse, streamed tokens render
 *   the growing bubble.
 * - `"replied"` — this turn's reply has rendered: either its `chat.agent`
 *   stream carried `connector.reply`, or (CL-false-no-reply) its `chat.message`
 *   posted straight from the reply pipeline while awaiting — whichever is
 *   observed first, since a parked folded run's `chat.agent` stream may
 *   never carry the former at all. A live folded run PARKS after the turn
 *   (no `message.run.ended`), and its post-reply tool-only rounds (memory
 *   writes) still emit `inference.start`/`inference.done` — none of which
 *   may re-open the pulse. Renders nothing; only a genuinely new turn
 *   leaves it.
 * - `null` — idle, no turn in flight.
 */
export type StreamingReplyState =
  | { readonly phase: "awaiting"; readonly text: string }
  | { readonly phase: "replied" }
  | null;

const REPLIED: StreamingReplyState = { phase: "replied" };

function awaiting(text: string): StreamingReplyState {
  return { phase: "awaiting", text };
}

/** Whether the state renders the tokenless typing pulse. The `"replied"`
 * phase is deliberately not pending — it renders nothing and must never
 * arm the pending-timeout backstop. */
export function isPendingReply(state: StreamingReplyState): boolean {
  return state !== null && state.phase === "awaiting" && state.text === "";
}

/** Whether a turn is still in flight — Stop stays up for the whole
 * `"awaiting"` phase, including after tokens have started streaming.
 * Distinct from `isPendingReply`, which is only the empty typing pulse. */
export function isAwaitingReply(state: StreamingReplyState): boolean {
  return state !== null && state.phase === "awaiting";
}

type InferenceDeltaEvent = {
  readonly type: "inference.text.delta";
  readonly data: { readonly partial: { readonly text: string } };
};

/** Narrows a `chat.agent` payload down to the one inner event shape this
 * module cares about — every other `InferenceEvent` variant (tool calls,
 * thinking, usage, `inference.start`) is read as its bare `type` string
 * only, never assumed to carry a `partial.text`. */
function parseInferenceDeltaEvent(data: unknown): InferenceDeltaEvent | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record.type !== "inference.text.delta") return null;
  const inner = record.data;
  if (typeof inner !== "object" || inner === null) return null;
  const partial = (inner as Record<string, unknown>).partial;
  if (typeof partial !== "object" || partial === null) return null;
  const text = (partial as Record<string, unknown>).text;
  if (typeof text !== "string") return null;
  return { type: "inference.text.delta", data: { partial: { text } } };
}

/** The bare `type` discriminant of a `chat.agent` payload, for the two
 * variants that end a turn — read without narrowing the rest of the event,
 * since neither carries (or needs) a `partial.text`. */
function innerEventType(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const type = (data as Record<string, unknown>).type;
  return typeof type === "string" ? type : null;
}

/** Whether a `chat.message` payload carries `postUndeliveredNotice`'s
 * `turnFailed` part (see `packages/chat/src/workbench-service.ts`). This
 * notice posts straight to the room with no `chat.agent` events at all —
 * the dispatch failed before `sendMail` ever reached the agent — so
 * without this check a turn that fails this way never emits the
 * `reactor.error`/`inference.error` this module otherwise relies on to
 * clear the typing pulse, leaving it stranded until the 120s backstop. */
function hasTurnFailedPart(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const parts = (data as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) return false;
  return parts.some(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      (part as Record<string, unknown>).turnFailed === true,
  );
}

/** Whether a `chat.message` payload carries `postCancelledNotice`'s
 * `turnCancelled` part (see `packages/chat/src/workbench-service.ts`,
 * CL-7201) — the cancellation counterpart to `hasTurnFailedPart` above,
 * kept as its own flag rather than reusing `turnFailed` because a user
 * stopping a turn is not a failure. Same reasoning applies here: a
 * cancelled turn's dispatch can close with no `chat.agent` events of its
 * own (still waiting on `waitUntilFree`, say), so this notice is the
 * only signal that clears the pulse for that case. */
function hasTurnCancelledPart(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const parts = (data as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) return false;
  return parts.some(
    (part) =>
      typeof part === "object" &&
      part !== null &&
      (part as Record<string, unknown>).turnCancelled === true,
  );
}

/** Either of the two turn-ended notice flags — the one thing
 * `isRenderedAgentReply` and `nextStreamingReplyState` actually care
 * about ("is this a system notice about how the turn ended, or the
 * agent's own reply"), never which specific outcome it was. */
function hasTurnEndedNoticePart(data: unknown): boolean {
  return hasTurnFailedPart(data) || hasTurnCancelledPart(data);
}

/** Whether a `chat.message` payload is the awaiting turn's own reply
 * actually rendering on screen — the one observable fact this module can
 * trust over any `chat.agent` lifecycle event. `postReply`
 * (`chat-orchestrator.ts`) posts this event from its own dispatch
 * pipeline, entirely separate from the raw `connector.reply` event
 * `chat.agent` otherwise carries — so a dropped, delayed, or (parked
 * folded run) never-sent `connector.reply` can no longer leave the
 * backstop armed once the reply the reader is looking at has already
 * posted. Requires an agent sender (never the reader's own echoed
 * message) and at least one part; `postUndeliveredNotice` also posts from
 * the agent's own address with a real text part, so
 * `hasTurnEndedNoticePart` rules that one (and its cancelled
 * counterpart) out explicitly rather than by accident. */
function isRenderedAgentReply(data: unknown): boolean {
  if (hasTurnEndedNoticePart(data)) return false;
  if (typeof data !== "object" || data === null) return false;
  const sender = (data as Record<string, unknown>).sender;
  if (typeof sender !== "object" || sender === null) return false;
  const address = (sender as Record<string, unknown>).address;
  if (typeof address !== "string" || !isAgentAddress(address)) return false;
  const parts = (data as Record<string, unknown>).parts;
  return Array.isArray(parts) && parts.length > 0;
}

/**
 * The streaming reply's whole state machine, pure and turn-phase aware
 * (CL-6432 reopened). `message.run.started` — the harness's per-dequeued-
 * message turn begin, the same event the chat orchestrator keys new turns
 * off (see `chat-orchestrator.ts`'s use of `messageRunStarted`) — opens a
 * fresh awaiting turn. While awaiting, `inference.start`/`reactor.start`
 * open the empty pulse (never wiping streamed tokens), each
 * `inference.text.delta` replaces the text with its cumulative snapshot,
 * and a textless `inference.done` keeps the pulse up across pre-reply tool
 * rounds. Two independent signals move the turn to `"replied"`:
 * `connector.reply` on the `chat.agent` stream (the event the orchestrator
 * posts the persisted reply off), and — CL-false-no-reply, since a parked
 * folded run's `chat.agent` stream may never carry that event at all — an
 * awaiting turn's own `chat.message` actually rendering the agent's reply
 * (see `isRenderedAgentReply`). Whichever arrives first wins; the other is
 * then a no-op against an already-`"replied"` turn. A live folded run
 * PARKS after replying (no `message.run.ended`), and its post-reply
 * tool-only rounds (memory writes) still emit `inference.start`/
 * `inference.done`, so in `"replied"` every inference/reactor event is
 * inert rather than re-opening the pulse. The hard-terminal events —
 * `reactor.done`/`reactor.error`, `message.run.ended`, `inference.error`,
 * and a `chat.message` carrying `postUndeliveredNotice`'s `turnFailed`
 * or `postCancelledNotice`'s `turnCancelled` part (see
 * `hasTurnEndedNoticePart`, the failure/cancellation paths with no
 * `chat.agent` events of their own) — return to idle from any phase.
 * A `turnCancelled` notice is the exception: it settles `"replied"` so a
 * late `inference.start` / `reactor.start` / text delta from the still-
 * running occurrence (CL-7230's ceiling) cannot reopen the pulse.
 * Every other event type (tool calls, thinking, usage) leaves the
 * current state untouched.
 */
export function nextStreamingReplyState(
  current: StreamingReplyState,
  event: { readonly eventType: string; readonly data: unknown },
): StreamingReplyState {
  if (event.eventType === "chat.message") {
    if (hasTurnCancelledPart(event.data)) return REPLIED;
    if (hasTurnFailedPart(event.data)) return null;
    if (
      current !== null &&
      current.phase === "awaiting" &&
      isRenderedAgentReply(event.data)
    ) {
      return REPLIED;
    }
    return current;
  }
  if (event.eventType !== "chat.agent") return current;

  const innerType = innerEventType(event.data);
  if (innerType === "message.run.started") return awaiting("");
  if (
    innerType === "reactor.done" ||
    innerType === "reactor.error" ||
    innerType === "message.run.ended" ||
    innerType === "inference.error"
  ) {
    return null;
  }
  if (innerType === "connector.reply") return REPLIED;
  if (current !== null && current.phase === "replied") return current;

  if (innerType === "inference.start") return current ?? awaiting("");
  // `reactor.start` is the earliest "the agent is on it" signal — it
  // fires before any tokens, often seconds before a slow model's
  // `inference.start` — so it opens the indicator without waiting for
  // the first inference call.
  if (innerType === "reactor.start") return current ?? awaiting("");
  if (innerType === "inference.done") {
    if (current === null || current.text === "") return current;
    return null;
  }

  const delta = parseInferenceDeltaEvent(event.data);
  if (delta === null) return current;
  return awaiting(delta.data.partial.text);
}

/**
 * Owns the streaming reply's state end to end: feed it every stream event
 * (`chat-workspace.tsx` already sees them all, same as
 * `useTypingIndicator`) and it tracks the active turn's growing text,
 * clearing itself the moment the turn ends. `workbenchId` resets it
 * immediately on a workbench switch, same reasoning as
 * `useTypingIndicator` — an in-progress reply from the workbench just left
 * belongs to that workbench's timeline, not the new one.
 */
/**
 * Opens an empty pending reply without an agent event: the caller just
 * sent a message to a workbench with an agent in it, so a reply is owed
 * even though no `reactor.start` has streamed yet. Never resets a reply
 * already streaming.
 */
export function openPendingReply(
  current: StreamingReplyState,
): StreamingReplyState {
  // A `"replied"` previous turn is over — the send that called this opens
  // the next one, so the pulse comes back.
  if (current === null || current.phase === "replied") return awaiting("");
  return current;
}

/**
 * The catch-up snapshot a client reattaching mid-turn (a fresh mount after
 * navigating away and back, CL-6380) hydrates its streaming reply with,
 * before the live SSE tail resumes: a running turn with committed text
 * opens the reply already carrying it; a running turn with none yet (still
 * in its first inference call) opens the same empty pending state
 * `openPendingReply` would; no running turn at all means there's nothing to
 * resume. Never called once a live event has already produced state — see
 * `resumeFromTurn`'s own guard below.
 */
export function hydrateStreamingReplyFromTurn(
  runningTurn: { readonly textSnapshot?: string | null } | null,
): StreamingReplyState {
  if (runningTurn === null) return null;
  return awaiting(runningTurn.textSnapshot ?? "");
}

/** How long a turn may go without a single new token before it's declared
 * dead — the backstop for both a turn whose stream events never arrive at
 * all (agent down, SSE dropped mid-reconnect) and one that starts streaming
 * and then stalls (model OOM, dropped Ollama connection, sidecar crash: all
 * routine with local models, CL-6486). This measures the gap *since the
 * last token*, not total turn duration — a healthy local model can
 * legitimately run 200s+ end to end (round 1 measured ~216s on
 * `qwen3.8:27b`), so a total-elapsed timeout would fire on working replies.
 * 120s of dead air with zero new output, on the other hand, is never a
 * healthy sign even for a slow model — it's long past any single decode
 * step, tool round-trip, or reconnect a client is expected to ride out. */
const PENDING_REPLY_CLEAR_MS = 120_000;

/** Floor on how long the empty typing pulse stays up after it first
 * appears. Fast models can emit `inference.start` + first token in the
 * same tick; without this the bubble flashes and vanishes. */
const TYPING_INDICATOR_MIN_VISIBLE_MS = 700;

export function useStreamingReply(
  workbenchId: string | null,
  clearMs: number = PENDING_REPLY_CLEAR_MS,
  minVisibleMs: number = TYPING_INDICATOR_MIN_VISIBLE_MS,
): {
  readonly streamingReply: StreamingReplyState;
  /** Set once the backstop above has fired for the turn just cleared — a
   * `reportError` refId (CL-6677) the host's honest notice quotes, the
   * same "ref id + Retry" treatment `postUndeliveredNotice`
   * (`@corbits/chat`) gives a dispatch failure that surfaces server-side.
   * This is the same class of failure with no server signal at all (a
   * cold-waking agent that never streams back a token), so it deserves
   * the same backstop rather than the ref-less, action-less notice this
   * used to render. `null` when idle. Reset on the next workbench switch,
   * stream event, or awaited reply, same lifecycle as `streamingReply`
   * itself. */
  readonly replyTimedOutRefId: string | null;
  readonly handleStreamEvent: (eventType: string, data: unknown) => void;
  readonly noteAwaitingReply: () => void;
  /** See `resumeFromTurn`'s own doc comment below. */
  readonly resumeFromTurn: (
    runningTurn: { readonly textSnapshot?: string | null } | null,
  ) => void;
} {
  const [streamingReply, setStreamingReply] =
    useState<StreamingReplyState>(null);
  const [replyTimedOutRefId, setReplyTimedOutRefId] = useState<string | null>(
    null,
  );
  const pendingSinceRef = useRef<number | null>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setStreamingReply(null);
    setReplyTimedOutRefId(null);
    pendingSinceRef.current = null;
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }, [workbenchId]);

  useEffect(() => {
    // Arm for the whole "awaiting" phase, not just its tokenless prefix
    // (CL-6486): a token still growing the reply is not evidence the turn
    // is alive forever, only that it was alive as of that token. Every
    // token produces a new `streamingReply` object (see `awaiting`), so
    // this effect's own dependency below tears down the previous timer and
    // arms a fresh one on each token — the window this constructs is
    // therefore inter-token silence, never total elapsed time.
    if (streamingReply === null || streamingReply.phase !== "awaiting") {
      return;
    }
    const timer = setTimeout(() => {
      // The dependency below re-arms this effect (clearing this exact
      // timer) the instant `streamingReply` changes, so this callback only
      // ever runs while it's still the same pending reply it was armed
      // for — no need to re-check identity here.
      const refId = reportError(
        new Error(
          `Reply timed out: no token received within ${clearMs}ms` +
            (workbenchId !== null ? ` for workbench ${workbenchId}` : ""),
        ),
        {
          operation: "chat.replyTimedOut",
          ...(workbenchId !== null ? { roomId: workbenchId } : {}),
        },
      );
      setStreamingReply(null);
      setReplyTimedOutRefId(refId);
      pendingSinceRef.current = null;
    }, clearMs);
    return () => clearTimeout(timer);
  }, [streamingReply, clearMs, workbenchId]);

  function commitReply(
    next: StreamingReplyState,
    current: StreamingReplyState,
  ): StreamingReplyState {
    const now = Date.now();
    const becamePending = isPendingReply(next) && !isPendingReply(current);
    if (becamePending) pendingSinceRef.current = now;

    const leavingPending = isPendingReply(current) && !isPendingReply(next);
    if (
      leavingPending &&
      pendingSinceRef.current !== null &&
      now - pendingSinceRef.current < minVisibleMs
    ) {
      if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
      const remaining = minVisibleMs - (now - pendingSinceRef.current);
      const held = next;
      holdTimerRef.current = setTimeout(() => {
        holdTimerRef.current = null;
        pendingSinceRef.current = null;
        setStreamingReply(held);
      }, remaining);
      return current;
    }

    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (!isPendingReply(next)) pendingSinceRef.current = null;
    return next;
  }

  function handleStreamEvent(eventType: string, data: unknown) {
    setReplyTimedOutRefId(null);
    setStreamingReply((current) =>
      commitReply(
        nextStreamingReplyState(current, { eventType, data }),
        current,
      ),
    );
  }

  function noteAwaitingReply() {
    setReplyTimedOutRefId(null);
    setStreamingReply((current) =>
      commitReply(openPendingReply(current), current),
    );
  }

  /**
   * Applies a fetched turn-state snapshot (see `api.ts`'s
   * `fetchRunningTurn`) on a fresh mount, before any live event has
   * arrived. Guarded to only ever fill an empty (`null`) state — a stream
   * event that already opened or grew the reply always wins, since it is
   * strictly newer than a snapshot fetched moments earlier over a separate
   * request. A `null` turn (nothing running) is a no-op, not a reset: it
   * must never clear a reply a fast SSE `reactor.start` already opened
   * while the snapshot fetch was in flight.
   */
  function resumeFromTurn(
    runningTurn: { readonly textSnapshot?: string | null } | null,
  ) {
    if (runningTurn === null) return;
    setReplyTimedOutRefId(null);
    setStreamingReply(
      (current) => current ?? hydrateStreamingReplyFromTurn(runningTurn),
    );
  }

  return {
    streamingReply,
    replyTimedOutRefId,
    handleStreamEvent,
    noteAwaitingReply,
    resumeFromTurn,
  };
}

/**
 * The handle(s) to show as "typing" in the incoming-message slot while a reply is
 * owed but no tokens have streamed yet. Names the agent the latest human
 * message addressed (`@handle`); a 1:1 with no mention still names that
 * one agent. Two or more agents and no mention names nobody — guessing
 * the workbench's first participant is how "Myra is typing" lied while
 * Scout was the one asked.
 */
export function typingAgentNames(
  streamingReply: StreamingReplyState,
  participants: readonly ParticipantRecord[],
  parts?: readonly Part[],
  displayNames?: AgentDisplayNames,
): readonly string[] {
  if (!isPendingReply(streamingReply)) return [];
  const agents = participants.filter((participant) =>
    isAgentAddress(participant.address),
  );
  if (agents.length === 0) return [];

  const addressed =
    parts === undefined ? [] : mentionedParticipants(parts, participants);
  const named =
    addressed.length > 0
      ? agents.filter((agent) => addressed.includes(agent.address))
      : agents.length === 1
        ? agents
        : [];
  return named.map(
    (agent) =>
      displayNameForAddress(agent.address, displayNames) ??
      displayNameFromHandle(agent.handle),
  );
}

/** The latest human (non-agent, non-streaming) message's parts — what
 * `typingAgentNames` uses to see who was addressed. */
export function lastHumanMessageParts(
  items: readonly {
    readonly sender: { readonly address: string };
    readonly parts: readonly Part[];
    readonly streaming?: boolean;
  }[],
): readonly Part[] | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item === undefined) continue;
    if (item.streaming === true) continue;
    if (isAgentAddress(item.sender.address)) continue;
    return item.parts;
  }
  return undefined;
}
