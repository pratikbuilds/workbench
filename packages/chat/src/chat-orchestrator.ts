// Turns an invited agent's `connector.reply` events into workbench
// messages, and a run's `reactor.gate.blocked` approval parks into an
// in-chat approve block — built once by the host and subscribed for the
// process's lifetime, mirroring `vendor/intx/hub-sessions/src/hub-session-orchestrator.ts`'s
// shape rather than the restart-race-prone per-agent bridge the reply
// side replaces (armed at invite, re-armed lazily on every workbench read,
// re-armed again before every fan-out delivery — three places that
// could each miss a beat across a host restart).
//
// Subscribes once to `SidecarRouter.events`' `"agent.event"` stream —
// the single surface that carries every agent's events, `connector.reply`
// and `reactor.gate.blocked` included, regardless of which address
// emitted them (see `vendor/intx/hub-sessions/src/ws/sidecar-handler.ts`'s
// `"agent.event"` frame case, which both re-emits onto this stream and
// dispatches to per-address subscribers) — rather than a per-address
// `subscribeAgent` call per invited agent.
//
// The approve block itself carries only a platform-minted `approvalId`
// (see `./blocks.ts`'s `ApproveBlockData`) — this orchestrator never
// mints one, only reads the row the hub's own IPC register co-write
// already wrote (`ApprovalStore.findByCorrelationId`), matching the
// gen-UI design's "agents can never mint these" rule.
import { headlineFor } from "@corbits/approvals";
import {
  connectorReplyContent,
  inferenceDoneBlocks,
  messageRunEnded,
  messageRunStarted,
  toolDoneResult,
  type ReplyContentBlock,
} from "@corbits/agent-events";
import { createExpiringMap, type ExpiringMap } from "@corbits/collections";
import { reportError } from "@corbits/error-sink";
import type { Memory } from "@corbits/memory";
import {
  persistedArtifactsForFinalizedTurn,
  type FinalizedTurnToolCall,
} from "@corbits/turn-artifacts";
import type { ApprovalStore, DB } from "@intx/db";
import type { SidecarEventEmitter } from "@intx/hub-sessions";
import { getLogger } from "@intx/log";
import {
  isClassifiedInferenceFailure,
  type ClassifiedInferenceFailureCategory,
  type ProviderHealthPort,
} from "@corbits/connections/provider-health";
import {
  parseMissingCredentialDetail,
  type ConnectorRegistry,
} from "@corbits/connections/registry";
import { artifactPartsForFinalizedTurn } from "./artifact-delivery";
import type { ApproveBlockData } from "./blocks";
import { encodeParts } from "./codec";
import type { ConnectedProviderLister } from "./inference-preferences";
import { mentionedParticipants } from "./mentions";
import { localPartOf } from "./agent-address";
import { readBindingByAddress, resolveLiveAgent } from "./agent-binding";
import { parseParticipants, type ParticipantRecord } from "./participants";
import type { Part, TextPart } from "./parts";
import type { ChatPlatform } from "./platform-port";
import { postRoomMessage, type RoomMessageStore } from "./room-messages";
import { AGENT_TURN_STALE_MS, type AgentTurnStore } from "./agent-turns";
import type { ChatStore } from "./store";
import type { ThreadStore } from "./threads";
import type { WorkbenchSubscriberRegistry } from "./workbench-events";
import type { WriteClaimStore } from "./write-claims";

const log = getLogger(["chat", "orchestrator"]);

export type ChatOrchestratorDeps = {
  db: DB["db"];
  /** The connector set this build ships (`@corbits/connections` carries
   * none of its own, CL-7384) — used only to resolve a missing
   * credential's `displayName` for the in-turn connect card. Absent
   * falls back to the raw connector id, same as
   * `MissingCredentialError`'s own default. */
  connectorRegistry?: ConnectorRegistry;
  store: Pick<ChatStore, "listWorkbenchSettings">;
  /**
   * The room timeline every poster below writes to (CL-6327): an agent's
   * reply, an approve block, a finalized turn's artifact chips all land
   * as workbench-owned rows, not as platform mail.
   */
  roomMessages: RoomMessageStore;
  /** The same registry `createChatRoutes` bridges onto a workbench's SSE
   * stream — how a posted message reaches an open timeline immediately. */
  publish: WorkbenchSubscriberRegistry["publish"];
  /**
   * Mail is now only ever a dispatch to another agent's own mailbox — the
   * delegation hop that wakes a specialist the replying agent @mentioned.
   * Nothing here posts onto a workbench's timeline through mail.
   */
  platform: Pick<ChatPlatform, "sendMail">;
  events: SidecarEventEmitter;
  /**
   * The turn projection (CL-6329). A room agent runs as an `onTrigger`
   * section, so the reply this orchestrator posts belongs to one
   * occurrence — its own child run — and the projection is what names
   * that child: the sidecar's `agent.event` frames carry the agent's
   * address and nothing finer. Omitted, replies carry no run id at all
   * rather than a guessed one; there is no second way to name a run.
   */
  agentTurns?: Pick<
    AgentTurnStore,
    "findRunningTurn" | "finishTurn" | "listTurns"
  >;
  /**
   * Resolves a gate-blocked event's `correlationId` to the approval row the
   * hub's IPC register co-write already wrote — the same read the "needs
   * you" list and the approve/reject routes key off. Only `findByCorrelationId`
   * is needed: this orchestrator never creates or resolves an approval, only
   * reads one to describe it in a workbench message.
   */
  approvals: Pick<ApprovalStore, "findByCorrelationId">;
  /**
   * Bumps the idle-sleep lifecycle's activity clock for an address.
   * Absent when no lifecycle is configured, matching
   * `createHubChatPlatform`'s own opt-in shape — this orchestrator
   * never builds a lifecycle of its own.
   */
  recordActivity?: (address: string) => void;
  /**
   * The mounted memory plane's in-process handle (`apps/hub/src/memory-mount.ts`'s
   * `MemoryMountHandle.memory`) — undefined when the plane isn't mounted
   * (no `EMBED_BASE_URL`), matching that mount's own optional contract.
   * Two explicit, bounded call sites use it (CL-5852), never a generic
   * event bus: `postFinalizedTurnMemoryEntries` records one entry per
   * persisted artifact, and `postDailyTranscriptDigest` records at most
   * one entry per workbench per UTC day. Both derive `tenantId`/`principalId`
   * from `resolveMemberWorkbenches`' own resolved run scope, never from
   * anything a model supplied.
   */
  memory?: Pick<Memory, "add">;
  /**
   * Durable redelivery-dedup for the three finalized-turn write surfaces
   * below (CL-6039) — see `WriteClaimStore`'s own doc comment in
   * `./write-claims.ts`. Required (unlike `memory`, which is absent when
   * the plane isn't mounted): every one of those surfaces claims before
   * writing regardless of whether `memory` is configured, since
   * `postFinalizedTurnArtifacts` claims too and has no `memory`
   * dependency at all.
   */
  claims: WriteClaimStore;
  /**
   * Reports a classified runtime inference failure (CL-6092) — a
   * credential or quota error, never any other `InferenceError` category
   * — so `apps/hub` can surface it as a provider-health "needs attention"
   * signal. Absent when no health store is mounted, matching `memory`'s
   * own optional shape; every call site below is a no-op when this is
   * undefined. This orchestrator never marks a provider healthy — only a
   * passing credential re-test does that, and that write happens in
   * `@corbits/connections`'s own routes, not here.
   */
  providerHealth?: ProviderHealthPort;
  /**
   * The same `ConnectedProviderLister` `./inference-preferences.ts`'s
   * `createWorkbenchHostInferencePreferencesResolver` takes — reused here
   * (rather than reaching for `deps.db` directly) so a test can inject a
   * plain in-memory list and so this file never grows its own
   * `@intx/db`-querying logic. Required alongside `providerHealth`: a
   * health port with no way to resolve which provider a turn used could
   * never conservatively attribute a failure to one.
   */
  listConnectedProviders?: ConnectedProviderLister;
  /**
   * Where an agent's reply lands in the room's thread tree — the same
   * `openReplyThread`/`assignMessage`/`threadIdForMessage` surface
   * `routes.ts`'s human-send path already uses. Two cases, one write:
   * a specialist's first reply after being @mentioned threads under
   * the delegating message (CL-5879); every other reply lands in the
   * same thread as the request message that opened the turn, so a
   * question asked inside a fork gets its answer in that fork rather
   * than back on the root feed. Absent when no thread store is
   * mounted, matching `memory`'s own optional shape: a deploy that
   * never wires threads keeps every reply on the root feed.
   */
  threads?: Pick<
    ThreadStore,
    "openReplyThread" | "assignMessage" | "threadIdForMessage"
  >;
};

export type ChatOrchestrator = {
  /** Unsubscribes from the event stream. The host's own process
   * lifetime is this orchestrator's natural lifetime, but tests need
   * to tear one down between cases. */
  dispose(): void;
};

/**
 * A `reactor.gate.blocked` event whose gate is an approval ask, carrying the
 * correlation the hub's IPC register co-write keyed the approval row on.
 * Every other gate reason (`payment`, `credential`, `budget`,
 * `child_completion`, `message_response`) is not an in-chat approve card's
 * concern and is filtered out here. A missing `correlationId` means the
 * register co-write never ran (or hasn't landed yet) — nothing to look an
 * approval up by, so this is treated the same as "not an approval gate".
 */
function gateBlockedCorrelationId(event: unknown): string | undefined {
  if (
    typeof event !== "object" ||
    event === null ||
    (event as { type?: unknown }).type !== "reactor.gate.blocked"
  ) {
    return undefined;
  }
  const data = (
    event as { data?: { reason?: unknown; correlationId?: unknown } }
  ).data;
  if (data?.reason !== "approval") return undefined;
  return typeof data.correlationId === "string"
    ? data.correlationId
    : undefined;
}

/**
 * Identifies one turn on the shared `agent.event` stream: an agent
 * address alone is not enough, since `resolveMemberWorkbenches` (above)
 * deliberately returns workbench ids plural — one address can be a member
 * of several benches, each with its own turn running at once. Every
 * `agent.event` frame carries a `sessionId` regardless of which inner
 * event type it wraps (`vendor/intx/hub-sessions/src/ws/sidecar-events.ts`'s
 * `SidecarEventMap["agent.event"]`), scoped to the one sidecar connection
 * that turn's occurrence runs on — the correlator this module's in-flight
 * turn state (below) keys on instead of the address alone.
 */
function turnKeyFor(agentAddress: string, sessionId: string): string {
  return `${agentAddress}:${sessionId}`;
}

/**
 * Turn-scoped reply assembly (CL-6378). A turn's `inference.done` events
 * already carry the model's output pre-split into prose and tool calls
 * (`inferenceDoneBlocks`, reading the same split
 * `vendor/intx/hub-sessions/src/event-collector.ts`'s `handleInferenceDone`
 * makes) — this accumulator turns that stream of blocks into the ordered
 * `Part[]` a reply message posts as, so a tool call the model made
 * becomes a `ToolTracePart` the UI renders as `ToolBlock`, never JSON
 * folded into a `TextPart`'s prose. One accumulator per process, keyed by
 * turn (see `turnKeyFor` below): reset the moment a turn's
 * `connector.reply` or turn-drop notice consumes it.
 */
export function createReplyPartsAccumulator(
  connectorRegistry?: ConnectorRegistry,
): {
  onInferenceDone(turnKey: string, blocks: ReplyContentBlock[]): void;
  onToolDone(
    turnKey: string,
    result: {
      callId: string;
      content: unknown;
      isError: boolean;
      detail?: unknown;
    },
  ): void;
  /** Returns and clears the turn's accumulated parts, or undefined if
   * nothing was ever accumulated for it. */
  take(turnKey: string): Part[] | undefined;
} {
  const partsByTurn = new Map<string, Part[]>();
  const toolTraceIndexByTurn = new Map<string, Map<string, number>>();

  return {
    onInferenceDone(turnKey, blocks) {
      const parts = partsByTurn.get(turnKey) ?? [];
      const toolTraceIndex =
        toolTraceIndexByTurn.get(turnKey) ?? new Map<string, number>();
      for (const block of blocks) {
        if (block.kind === "text") {
          parts.push({ kind: "text", text: block.text });
        } else {
          toolTraceIndex.set(block.callId, parts.length);
          parts.push({
            kind: "tool-trace",
            name: block.name,
            input: block.input,
            status: "running",
          });
        }
      }
      partsByTurn.set(turnKey, parts);
      toolTraceIndexByTurn.set(turnKey, toolTraceIndex);
    },
    onToolDone(turnKey, result) {
      const parts = partsByTurn.get(turnKey);
      const index = toolTraceIndexByTurn.get(turnKey)?.get(result.callId);
      if (parts === undefined || index === undefined) return;
      const existing = parts[index];
      if (existing === undefined || existing.kind !== "tool-trace") return;
      parts[index] = {
        ...existing,
        status: result.isError ? "error" : "success",
        output: result.content,
      };
      // A tool that stopped rather than guessing because a connector's
      // credential isn't connected (CL-6495's mid-turn halt) carries
      // that fact structurally in `detail`, not just as prose in
      // `content`. When it does, append the same `connect-service` card
      // `request_connection` already posts for the agent-initiated path
      // — same block type, same render path, same live actions port —
      // so the person sees a real "Connect X" button in this turn
      // instead of a dead-end error.
      const missingCredential = result.isError
        ? parseMissingCredentialDetail(result.detail)
        : undefined;
      if (missingCredential !== undefined) {
        const displayName =
          connectorRegistry?.[missingCredential.connectorId]?.displayName ??
          missingCredential.connectorId;
        parts.push({
          kind: "block",
          block: {
            type: "connect-service",
            data: {
              connectorId: missingCredential.connectorId,
              displayName,
              reason:
                typeof result.content === "string" && result.content.length > 0
                  ? result.content
                  : `${displayName} isn't connected, so this couldn't run.`,
            },
          },
        });
      }
    },
    take(turnKey) {
      const parts = partsByTurn.get(turnKey);
      partsByTurn.delete(turnKey);
      toolTraceIndexByTurn.delete(turnKey);
      return parts;
    },
  };
}

/** The visible text of a reply's parts — every `TextPart`'s text, joined —
 * for the surfaces that only ever wanted prose (mention scanning, the
 * daily transcript digest): a tool call's `ToolTracePart` never
 * contributes, so neither ever sees its JSON. */
function flattenReplyText(parts: readonly Part[]): string {
  return parts
    .filter((part): part is TextPart => part.kind === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * Resolves an agent address on the event stream to every chat workbench it is
 * a member of, per the durable `workbench_settings` store. An agent can be
 * invited to more than one workbench; callers that post a turn's reply must
 * still pick the originating room rather than spraying every membership.
 */
async function resolveMemberWorkbenches(
  deps: ChatOrchestratorDeps,
  agentAddress: string,
): Promise<
  | {
      tenantId: string;
      /**
       * The run's own principal, when it has one — null for an
       * internal, workflow-spawned run (`workflow_run.principal_id` is
       * nullable by design). Memory-ingest call sites treat a null
       * principal as "nothing to attribute this to" and skip, rather
       * than guessing an owner.
       */
      principalId: string | null;
      /**
       * The address the ROOM knows this agent by — its stable
       * participant address, which is what the participant records, the
       * mention handles, and every already-posted message's
       * `senderAddress` carry. Not necessarily the address the event
       * arrived on: a relaunched run announces itself under a fresh
       * address (the platform derives one from the other), and the
       * room must keep attributing its replies to the same teammate it
       * has been talking to all along. See `./agent-binding.ts`.
       */
      roomAddress: string;
      workbenchIds: string[];
      /**
       * Each member workbench's own participant records, keyed by
       * workbench id — `postReply` needs these to run the same
       * @mention fan-out human sends get, delegating the host's
       * reply to whichever specialists it @mentions.
       */
      participantsByWorkbenchId: Map<string, ParticipantRecord[]>;
    }
  | undefined
> {
  // Resolved through the address→run mapping, not by matching the
  // event's address against `workflow_run.address` directly: after a
  // relaunch the two differ, and only the mapping knows that the run
  // announcing itself under a fresh address is the same room teammate.
  const binding = await readBindingByAddress(deps.db, agentAddress);
  if (binding === undefined) {
    // Not every agent address on the event stream belongs to a chat
    // workbench (an echo instance, say) — an address this package's own
    // launch machinery never produced is silently not this
    // orchestrator's concern.
    return undefined;
  }
  const live = await resolveLiveAgent(deps.db, binding);
  if (live === undefined) return undefined;

  const workbenches = await deps.store.listWorkbenchSettings(binding.tenantId);
  const memberWorkbenches = workbenches.filter((workbench) =>
    parseParticipants(workbench.settings["chat/participants"]).some(
      (participant) => participant.address === binding.roomAddress,
    ),
  );
  if (memberWorkbenches.length === 0) return undefined;

  return {
    tenantId: binding.tenantId,
    principalId: live.run.principalId,
    roomAddress: binding.roomAddress,
    workbenchIds: memberWorkbenches.map((workbench) => workbench.workbenchId),
    participantsByWorkbenchId: new Map(
      memberWorkbenches.map((workbench) => [
        workbench.workbenchId,
        parseParticipants(workbench.settings["chat/participants"]),
      ]),
    ),
  };
}

/**
 * The delegating message a mentioned specialist's *next* reply should
 * thread under (CL-5879) — set the moment `postReply`'s own mention
 * fan-out below wakes that specialist, read (and cleared) the moment
 * that specialist's own `postReply` call posts into the same workbench.
 * Keyed by the specialist's run id (`localPartOf` its agent address, the
 * same id every posted message carries as its `runId`): that id
 * is stable across the fan-out send and the specialist's own later
 * reply, unlike a workbench id, which the specialist's reply shares with
 * the host's (see the module's own postReply doc below) but arrives
 * once per member workbench rather than once per specialist.
 *
 * Only the specialist's first reply after being delegated to is
 * threaded — the entry is deleted on read, matching this package's
 * "thread machinery that already exists" scope for CL-5879 rather than
 * tracking an open-ended delegation session. A specialist mentioned
 * again gets a fresh entry from that later delegating message.
 *
 * Bounded with a TTL (CL-7229) rather than a plain `Map`: a specialist
 * that never replies (crashed, never woke, or was mentioned by mistake)
 * left its entry here forever, one per abandoned delegation for the
 * life of the hub process. The TTL is `AGENT_TURN_STALE_MS` — the same
 * threshold `./agent-turns.ts` already uses to decide a `running` turn
 * row is no longer believable and fails it outright. That threshold is
 * exactly the point past which this entry stops mattering too: once a
 * specialist's occurrence has run longer than any turn is allowed to,
 * the rest of the system has already given up on it ever finishing, so
 * evicting the pending-thread entry at the same age can't drop a reply
 * a running turn still needs. If a reply somehow still lands after
 * that (a very late, already-abandoned occurrence), it just posts
 * unthreaded into the main feed instead of nested under the delegating
 * message — a cosmetic degrade, never a lost message. The common case
 * (event-driven delete) is unchanged: `resolveReplyThreadId` below
 * still deletes the entry the moment the specialist's first reply
 * consumes it, long before the TTL would ever fire.
 */
type PendingDelegationThread = {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly messageId: string;
};

/**
 * Where this reply belongs in the workbench's thread tree.
 *
 * Precedence:
 * 1. A pending CL-5879 delegation for this specialist — open (or
 *    reuse) the reply thread under the delegating message, consume
 *    the pending entry, and return that thread id.
 * 2. The thread the turn's most recent request message already lives
 *    in — so a question asked inside a fork gets its answer in that
 *    same fork.
 * 3. Undefined — the reply stays on the root feed (no membership row),
 *    matching a deploy with no thread store or a request that was
 *    never assigned.
 *
 * Decided once, before the post, so the room-message row, the SSE
 * payload, and the membership assignment all carry the same thread —
 * never assign-then-reassign (drizzle's `assignMessage` is
 * `onConflictDoNothing`, so a second write would silently stick).
 */
async function resolveReplyThreadId(
  deps: ChatOrchestratorDeps,
  pendingDelegationThreads: ExpiringMap<string, PendingDelegationThread>,
  agentAddress: string,
  tenantId: string,
  workbenchId: string,
  requestMessageIds: readonly string[],
): Promise<string | undefined> {
  if (deps.threads === undefined) return undefined;

  const runId = localPartOf(agentAddress);
  const pending = pendingDelegationThreads.get(runId);
  if (pending !== undefined && pending.workbenchId === workbenchId) {
    pendingDelegationThreads.delete(runId);
    const reply = await deps.threads.openReplyThread({
      tenantId: pending.tenantId,
      workbenchId: pending.workbenchId,
      parentMessageId: pending.messageId,
    });
    return reply.id;
  }

  const originMessageId = requestMessageIds[requestMessageIds.length - 1];
  if (originMessageId === undefined) return undefined;
  return deps.threads.threadIdForMessage(
    tenantId,
    workbenchId,
    originMessageId,
  );
}

/**
 * How the occurrence that produced a post ended — recorded on the turn
 * projection as the post lands, so the row's `replyMessageId` names the
 * very message a reader is looking at.
 */
type TurnOutcome =
  | { readonly status: "completed" }
  | { readonly status: "failed"; readonly error: string };

type ReplyMember = {
  readonly workbenchId: string;
  readonly turnId: string | undefined;
  readonly childRunId: string | undefined;
};

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Hints already on the inbound event for the originating room: the
 * dispatch mail's `fromWorkbenchId` / From local-part / `replyTo`, or a
 * turn id. The sidecar `agent.event` stream often carries none of these
 * (address + payload only); callers must still refuse to spray when
 * correlation is missing and more than one running turn exists.
 */
function originatingHintsFromEvent(event: unknown): readonly string[] {
  if (typeof event !== "object" || event === null) return [];
  const record = event as Record<string, unknown>;
  const data =
    typeof record["data"] === "object" && record["data"] !== null
      ? (record["data"] as Record<string, unknown>)
      : undefined;
  const hints: string[] = [];
  const take = (value: unknown) => {
    const field = stringField(value);
    if (field !== undefined) hints.push(field);
  };
  take(data?.["workbenchId"]);
  take(data?.["fromWorkbenchId"]);
  take(data?.["replyTo"]);
  take(data?.["from"]);
  take(data?.["turnId"]);
  take(record["workbenchId"]);
  take(record["fromWorkbenchId"]);
  take(record["replyTo"]);
  take(record["from"]);
  take(record["turnId"]);
  return hints;
}

function correlateOriginatingWorkbench(
  event: unknown,
  members: readonly ReplyMember[],
): string | undefined {
  const memberIds = new Set(members.map((member) => member.workbenchId));
  for (const hint of originatingHintsFromEvent(event)) {
    if (memberIds.has(hint)) return hint;
    const local = localPartOf(hint);
    if (memberIds.has(local)) return local;
    const byTurnId = members.filter((member) => member.turnId === hint);
    if (byTurnId.length === 1) {
      const match = byTurnId[0];
      if (match !== undefined) return match.workbenchId;
    }
    const byChildRunId = members.filter((member) => member.childRunId === hint);
    if (byChildRunId.length === 1) {
      const match = byChildRunId[0];
      if (match !== undefined) return match.workbenchId;
    }
  }
  return undefined;
}

async function latestTurnForAgent(
  agentTurns: Pick<AgentTurnStore, "listTurns"> | undefined,
  tenantId: string,
  workbenchId: string,
  agentAddress: string,
) {
  if (agentTurns === undefined) return undefined;
  const turns = await agentTurns.listTurns({ tenantId, workbenchId });
  return turns.find((turn) => turn.agentAddress === agentAddress);
}

async function postReply(
  deps: ChatOrchestratorDeps,
  pendingDelegationThreads: ExpiringMap<string, PendingDelegationThread>,
  agentAddress: string,
  parts: readonly Part[],
  outcome: TurnOutcome,
  event?: unknown,
): Promise<void> {
  const resolved = await resolveMemberWorkbenches(deps, agentAddress);
  if (resolved === undefined) return;

  const members: ReplyMember[] = [];
  for (const workbenchId of resolved.workbenchIds) {
    const turn = await deps.agentTurns?.findRunningTurn({
      tenantId: resolved.tenantId,
      workbenchId,
      agentAddress: resolved.roomAddress,
    });
    members.push({
      workbenchId,
      turnId: turn?.id,
      childRunId: turn?.childRunId,
    });
  }
  const runningIds = members
    .filter((member) => member.turnId !== undefined)
    .map((member) => member.workbenchId);
  const correlated = correlateOriginatingWorkbench(event, members);
  const resolvedTargets =
    correlated !== undefined
      ? [correlated]
      : runningIds.length === 1
        ? runningIds
        : runningIds.length === 0 && resolved.workbenchIds.length === 1
          ? resolved.workbenchIds
          : [];
  // A cancelled 1:1 turn still has exactly one membership and no running
  // row, so the fallback above would otherwise post the late reply as an
  // unattached message. Drop those; a membership that never opened a
  // turn still uses the fallback.
  const targetIds: string[] = [];
  for (const workbenchId of resolvedTargets) {
    const member = members.find((entry) => entry.workbenchId === workbenchId);
    if (member?.turnId !== undefined) {
      targetIds.push(workbenchId);
      continue;
    }
    const latest = await latestTurnForAgent(
      deps.agentTurns,
      resolved.tenantId,
      workbenchId,
      resolved.roomAddress,
    );
    if (latest?.status === "cancelled") continue;
    targetIds.push(workbenchId);
  }

  if (targetIds.length === 0) {
    reportError(
      new Error(`dropping ${agentAddress}'s reply: no originating workbench`),
      {
        operation: "chat.postReply",
        tenantId: resolved.tenantId,
        agentId: agentAddress,
        extra: {
          workbenchIds: resolved.workbenchIds,
          runningWorkbenchIds: runningIds,
        },
      },
    );
    log.error`chat orchestrator: dropping ${agentAddress}'s reply — no originating workbench among ${String(resolved.workbenchIds.length)} membership(s) (${String(runningIds.length)} running)`;
    return;
  }

  for (const workbenchId of targetIds) {
    const turn = await deps.agentTurns?.findRunningTurn({
      tenantId: resolved.tenantId,
      workbenchId,
      agentAddress: resolved.roomAddress,
    });
    const replyThreadId = await resolveReplyThreadId(
      deps,
      pendingDelegationThreads,
      resolved.roomAddress,
      resolved.tenantId,
      workbenchId,
      turn?.requestMessageIds ?? [],
    );
    const posted = await postRoomMessage(deps, {
      tenantId: resolved.tenantId,
      workbenchId,
      sender: { name: null, address: resolved.roomAddress },
      parts: [...parts],
      ...(turn !== undefined ? { runId: turn.childRunId } : {}),
      ...(replyThreadId !== undefined ? { threadId: replyThreadId } : {}),
    });
    if (replyThreadId !== undefined && deps.threads !== undefined) {
      await deps.threads.assignMessage({
        tenantId: resolved.tenantId,
        workbenchId,
        threadId: replyThreadId,
        messageId: posted.id,
      });
    }
    if (turn !== undefined) {
      await deps.agentTurns?.finishTurn({
        tenantId: resolved.tenantId,
        turnId: turn.id,
        status: outcome.status,
        replyMessageId: posted.id,
        ...(outcome.status === "failed" ? { error: outcome.error } : {}),
      });
    }

    // The delegation hop: when the host's reply @mentions other agent
    // teammates, they must receive it exactly as they would a human's
    // @mention — otherwise a handoff only reaches the human side of
    // the workbench and the mentioned specialist never wakes up.
    const participants =
      resolved.participantsByWorkbenchId.get(workbenchId) ?? [];
    const mentioned = mentionedParticipants(parts, participants).filter(
      (address) => localPartOf(address) !== localPartOf(resolved.roomAddress),
    );
    for (const recipient of mentioned) {
      await deps.platform.sendMail({
        tenantId: resolved.tenantId,
        workbenchId: localPartOf(recipient),
        content: encodeParts([...parts], {
          replyTo: workbenchId,
        }),
        fromWorkbenchId: workbenchId,
      });
      // The delegating host's own replies stay in main (never
      // recorded here for its own address) — only the mentioned
      // specialist's *next* reply threads, under this exact message.
      pendingDelegationThreads.set(localPartOf(recipient), {
        tenantId: resolved.tenantId,
        workbenchId,
        messageId: posted.id,
      });
    }
  }
}

/**
 * How long `postApproveBlock`'s `postedApprovalIds` guard remembers a
 * carded approval (CL-7229). Every gate the reactor blocks on — approval
 * gates included — resolves out of `"pending"` on its own within
 * `DEFAULT_GATE_TIMEOUT_MS` (one hour: `vendor/intx/inference/src/reactor.ts`,
 * not exported — `./chat-orchestrator.ts`'s own copy of the same number
 * `./authz-extension.ts` already keeps for the same reason), either by a
 * human's decision or by timing out to a terminal `"timeout"`/`"expired"`
 * status; the gate never stays blocked, and stays open, past that bound.
 * A guard entry older than that bound is therefore guaranteed to belong
 * to an approval that is no longer pending, so evicting it can never
 * cause a duplicate card: the very next line of `postApproveBlock` below
 * re-reads the approval's live status and bails out on anything but
 * `"pending"` regardless of whether this guard remembers it. Set well
 * past the gate timeout (double it, plus a margin) so an evicted entry's
 * safety never depends on exact timing.
 */
export const POSTED_APPROVAL_GUARD_TTL_MS = 2 * 60 * 60 * 1000 + 5 * 60 * 1000;

/**
 * Posts the platform-minted approve block for a gate-blocked run into every
 * workbench the parked agent is a member of. `postedApprovalIds` is the
 * process-local idempotency guard against a redelivered `agent.event`
 * (sidecar reconnect, wire-layer replay — see the module header): a second
 * delivery for an approval already carded is a no-op, and an approval this
 * process has never carded but that resolved before the event was handled
 * (a race with `POST .../resolve`, or a *very* stale replay) is a no-op
 * too, since a card for an already-resolved approval would render terminal
 * state a human never got to act on — nothing to add to the workbench.
 *
 * Bounded with `POSTED_APPROVAL_GUARD_TTL_MS` (CL-7229) instead of a plain
 * `Set` that grew one entry per approval ever carded for the life of the
 * hub process — see that constant's own doc comment for why an eviction
 * can never reopen the duplicate-card hole this guard exists to close.
 */
async function postApproveBlock(
  deps: ChatOrchestratorDeps,
  agentAddress: string,
  correlationId: string,
  postedApprovalIds: ExpiringMap<string, true>,
): Promise<void> {
  const approval = await deps.approvals.findByCorrelationId(correlationId);
  if (approval === null || approval.status !== "pending") return;
  if (postedApprovalIds.get(approval.id) !== undefined) return;
  // Marked before the awaits below: two redelivered events racing this
  // function must not both pass the guard while the first resolves
  // workbenches.
  postedApprovalIds.set(approval.id, true);

  const resolved = await resolveMemberWorkbenches(deps, agentAddress);
  if (resolved === undefined) return;

  const data: ApproveBlockData = {
    approvalId: approval.id,
    title: headlineFor(approval.toolDefinition, approval.toolArguments),
  };
  for (const workbenchId of resolved.workbenchIds) {
    await postRoomMessage(deps, {
      tenantId: resolved.tenantId,
      workbenchId,
      sender: { name: null, address: resolved.roomAddress },
      parts: [{ kind: "block", block: { type: "approve", data } }],
      runId: localPartOf(resolved.roomAddress),
    });
  }
}

/**
 * Posts a finalized turn's persisted-artifact tool-call results as chat
 * `FilePart`s (CL-6000) — the delivery-side half of the sanctioned
 * workflow-artifact path: a finalize tool persists via the
 * workflow-artifacts HTTP surface and returns the artifact's id/title/kind
 * in its result; this turns that into the file chip the workbench sees.
 * A turn whose tool calls name no persisted artifact sends nothing.
 *
 * Claims `(tenantId, "artifact", "${turnId}:${workbenchId}")` in the durable
 * `finalized_turn_write_claim` table (CL-6039) before each workbench's
 * post, one claim per workbench rather than one for the whole turn: a
 * claim means "won the right to attempt this post", not "this post
 * succeeded", so a post that throws releases its own claim (in the
 * `catch` below) before this function's own log-and-drop catch in
 * `createArtifactDeliveryHandler` runs — a redelivery then retries only
 * the workbench that never got its message, not every workbench again. A
 * turn-wide claim would have made that choice for us: the first workbench
 * to succeed would have no way to keep its claim while a later workbench's
 * failure released the whole turn's, so a redelivery would either skip
 * an already-delivered workbench forever (claim never released) or resend
 * to it (claim released) — this per-workbench key sidesteps that
 * trade-off entirely, at the cost of nothing this loop wasn't already
 * paying (one workbench-scoped post).
 */
async function postFinalizedTurnArtifacts(
  deps: ChatOrchestratorDeps,
  agentAddress: string,
  turnId: string,
  toolCalls: readonly FinalizedTurnToolCall[],
): Promise<void> {
  const parts = artifactPartsForFinalizedTurn(toolCalls);
  if (parts.length === 0) return;

  const resolved = await resolveMemberWorkbenches(deps, agentAddress);
  if (resolved === undefined) return;

  for (const workbenchId of resolved.workbenchIds) {
    const claim = {
      tenantId: resolved.tenantId,
      surface: "artifact" as const,
      claimKey: `${turnId}:${workbenchId}`,
    };
    const claimed = await deps.claims.tryClaim(claim);
    if (!claimed) continue;

    try {
      await postRoomMessage(deps, {
        tenantId: resolved.tenantId,
        workbenchId,
        sender: { name: null, address: resolved.roomAddress },
        parts,
        runId: localPartOf(resolved.roomAddress),
      });
    } catch (error) {
      await deps.claims.release(claim);
      throw error;
    }
  }
}

/**
 * Records one firm-memory entry per persisted artifact a finalized turn's
 * tool calls named (CL-5852 M3a) — the same recognized shape
 * `postFinalizedTurnArtifacts` above turns into file-part chips, reused
 * here rather than re-parsed. Writes through the in-process plane handle
 * (`deps.memory`), never the plane's tenant-session HTTP routes: this
 * runs in the hub process, which already holds the handle `mountMemory`
 * returned. A no-op when `deps.memory` is absent (plane not mounted) or
 * the run has no principal to attribute the entry to — this never
 * guesses an owner. The entry records only the artifact's own
 * (id, title, kind) facts, never anything a model separately claimed.
 *
 * Claims `(tenantId, "memory", "${turnId}:${artifact.id}")` in the
 * durable `finalized_turn_write_claim` table (CL-6039) before each
 * artifact's `memory.add`, one claim per artifact rather than one for
 * the whole turn — same reasoning as `postFinalizedTurnArtifacts`'s
 * per-workbench claim: a claim means "won the right to attempt this add",
 * not "this add succeeded", so an add that throws releases its own
 * claim (in the `catch` below) before this function's own log-and-drop
 * catch in `createArtifactDeliveryHandler` runs. A turn-wide claim would
 * force a choice between losing an already-recorded artifact forever
 * (claim never released after a later artifact's failure) or
 * re-recording it (claim released for the whole turn) on redelivery;
 * per-artifact keys give exactly-once per artifact with neither.
 */
async function postFinalizedTurnMemoryEntries(
  deps: ChatOrchestratorDeps,
  agentAddress: string,
  turnId: string,
  toolCalls: readonly FinalizedTurnToolCall[],
): Promise<void> {
  if (deps.memory === undefined) return;
  const artifacts = persistedArtifactsForFinalizedTurn(toolCalls);
  if (artifacts.length === 0) return;

  const resolved = await resolveMemberWorkbenches(deps, agentAddress);
  if (resolved === undefined || resolved.principalId === null) return;

  for (const artifact of artifacts) {
    const claim = {
      tenantId: resolved.tenantId,
      surface: "memory" as const,
      claimKey: `${turnId}:${artifact.id}`,
    };
    const claimed = await deps.claims.tryClaim(claim);
    if (!claimed) continue;

    try {
      await deps.memory.add({
        tenantId: resolved.tenantId,
        principalId: resolved.principalId,
        kind: "artifact",
        content: {
          title: artifact.title,
          text: `Library artifact "${artifact.title}" (${artifact.kind}) was created.`,
        },
        attributes: { artifactId: artifact.id },
      });
    } catch (error) {
      await deps.claims.release(claim);
      throw error;
    }
  }
}

/**
 * Bounded daily-workbench-digest transcript ingestion (CL-5852 M3b): at
 * most one firm-memory entry per workbench per UTC day, recording that
 * day's first reply as an honest, lightweight digest of workbench
 * activity — never a fabricated summary. Chosen over an "on thread
 * completion" trigger because this repo's single-step conversational
 * workflows (`workflows/assistant`) keep one warm agent address across
 * an entire workbench's lifetime (see that package's header comment): a
 * "thread" never observably completes here, so there is no cheap event
 * to hook without inventing one. A once-per-workbench-per-day bound is
 * the cheapest trigger already implied by an existing, honest concept
 * (`workflows/workbench-digest`) rather than a new event bus. The bound is
 * enforced by claiming `(tenantId, "digest", "${workbenchId}:${date}")` in
 * the same durable `finalized_turn_write_claim` table the two posters
 * above claim into (CL-6039) — folded in from a process-local `Set` that
 * reset on restart (and so could double-ingest a day's first reply after
 * every restart) into the one durable claim table every finalized-turn
 * write surface now shares. Already one claim per workbench-day (there was
 * never a turn-wide version of this bound to narrow), but still needs
 * the same release-on-failure `postFinalizedTurnMemoryEntries` uses: an
 * add that throws releases its own claim before the caller's log-and-drop
 * catch runs, so a workbench whose digest add failed gets a real retry on
 * the next reply rather than staying claimed with no digest ever
 * written.
 */
async function postDailyTranscriptDigest(
  deps: ChatOrchestratorDeps,
  agentAddress: string,
  content: string,
): Promise<void> {
  if (deps.memory === undefined) return;

  const resolved = await resolveMemberWorkbenches(deps, agentAddress);
  if (resolved === undefined || resolved.principalId === null) return;

  const today = new Date().toISOString().slice(0, 10);
  for (const workbenchId of resolved.workbenchIds) {
    const claim = {
      tenantId: resolved.tenantId,
      surface: "digest" as const,
      claimKey: `${workbenchId}:${today}`,
    };
    const claimed = await deps.claims.tryClaim(claim);
    if (!claimed) continue;

    try {
      await deps.memory.add({
        tenantId: resolved.tenantId,
        principalId: resolved.principalId,
        kind: "transcript-digest",
        content: {
          title: `Workbench digest — ${today}`,
          text: content,
        },
        attributes: { workbenchId },
      });
    } catch (error) {
      await deps.claims.release(claim);
      throw error;
    }
  }
}

/**
 * Picks the first classified (`credential_failure`/`quota_exhausted`)
 * error out of a turn's `errors`, narrowed to `ClassifiedInferenceFailureCategory`
 * — a plain `Array.prototype.find` call can't narrow a field nested inside
 * the element it tests, so this loop does the narrowing `isClassifiedInferenceFailure`
 * already proves, once, in one place.
 */
function firstClassifiedError(
  errors: readonly { category: string; message: string }[],
): { category: ClassifiedInferenceFailureCategory } | undefined {
  for (const error of errors) {
    if (isClassifiedInferenceFailure(error.category)) {
      return { category: error.category };
    }
  }
  return undefined;
}

/**
 * Reports a finalized turn's classified inference failure — if it has
 * one — to `deps.providerHealth` (CL-6092). Fires on the *first*
 * `credential_failure`/`quota_exhausted` error a turn accumulated (see
 * `isClassifiedInferenceFailure`); every other category (`retryable`,
 * `context_overflow`, `fatal`, `aborted`, `timeout`,
 * `protocol_mismatch`) is an ordinary error this never reports on — a
 * turn with, say, only a `retryable` error is indistinguishable from one
 * with none at all here. Reports the error's `category` alone, never its
 * `message` — a provider's own error prose is never durable-stored, only
 * read back to a browser-facing route later (see `provider-health.ts`'s
 * own header for why).
 *
 * A turn's `errors` carry a category and message, never which provider
 * served the turn (`vendor/intx/hub-sessions/src/event-collector.ts`'s
 * `TurnFinalized` has no provider field). This resolves the provider the
 * same way a workbench host's own inference preferences are derived
 * (`deps.listConnectedProviders`) and only reports when the tenant has
 * exactly one connected provider — with more than one connected, this
 * never guesses which one the turn actually used, matching the
 * "conservative classification" rule: silence, not a wrong attribution.
 *
 * That "exactly one connected provider" read happens here, at finalize
 * time — not at the moment the turn actually ran. A tenant that
 * disconnects a second provider between the turn running and this read
 * (or connects a new one) can, in that narrow window, have this attribute
 * the failure to a provider that never served the turn. Accepted as the
 * cheapest correct-enough behavior for a UI nudge, not an audit trail;
 * `postProviderHealthSignal` still never guesses across more than one
 * *currently* connected provider, which is the property that actually
 * matters here.
 */
async function postProviderHealthSignal(
  deps: ChatOrchestratorDeps,
  agentAddress: string,
  errors: readonly { category: string; message: string }[],
): Promise<void> {
  if (deps.providerHealth === undefined) return;
  if (deps.listConnectedProviders === undefined) return;
  const classified = firstClassifiedError(errors);
  if (classified === undefined) return;

  const resolved = await resolveMemberWorkbenches(deps, agentAddress);
  if (resolved === undefined) return;

  const connected = await deps.listConnectedProviders(resolved.tenantId);
  if (connected.length !== 1) return;
  const [provider] = connected;
  if (provider === undefined) return;

  deps.providerHealth.reportInferenceFailure({
    tenantId: resolved.tenantId,
    provider,
    category: classified.category,
  });
}

/**
 * Builds the `onTurnFinalized` callback `createEventCollectorRegistry`
 * accepts (`(agentAddress, turn) => void`, see
 * `vendor/intx/hub-sessions/src/event-collector-registry.ts`). Kept as a
 * plain function of `ChatOrchestratorDeps` rather than folded into
 * `createChatOrchestrator` itself: the two subscribe to different event
 * sources (the `SidecarEventEmitter`'s live `agent.event` stream vs. the
 * event-collector registry's once-per-turn finalize callback) and the
 * host wires them separately.
 */
export function createArtifactDeliveryHandler(deps: ChatOrchestratorDeps): (
  agentAddress: string,
  turn: {
    turnId: string;
    toolCalls: FinalizedTurnToolCall[];
    // Non-optional: `TurnFinalized.errors` upstream
    // (`vendor/intx/hub-sessions/src/event-collector.ts`) is always an
    // array, even when empty — never absent — so this type stays
    // non-optional too rather than widening it into a shape the real
    // caller never produces.
    errors: readonly { category: string; message: string }[];
  },
) => void {
  return (agentAddress, turn) => {
    void postFinalizedTurnArtifacts(
      deps,
      agentAddress,
      turn.turnId,
      turn.toolCalls,
    ).catch((cause: unknown) => {
      log.error`chat orchestrator: failed to post ${agentAddress}'s finalized-turn artifacts: ${
        cause instanceof Error ? cause.message : String(cause)
      }`;
    });
    void postFinalizedTurnMemoryEntries(
      deps,
      agentAddress,
      turn.turnId,
      turn.toolCalls,
    ).catch((cause: unknown) => {
      log.error`chat orchestrator: failed to record ${agentAddress}'s finalized-turn memory entries: ${
        cause instanceof Error ? cause.message : String(cause)
      }`;
    });
    void postProviderHealthSignal(deps, agentAddress, turn.errors).catch(
      (cause: unknown) => {
        log.error`chat orchestrator: failed to report ${agentAddress}'s provider health signal: ${
          cause instanceof Error ? cause.message : String(cause)
        }`;
      },
    );
  };
}

export function createChatOrchestrator(
  deps: ChatOrchestratorDeps,
  options?: {
    /** Injectable clock, for tests that age the two TTL-bounded
     * collections below without waiting on a real timer. */
    readonly now?: () => number;
  },
): ChatOrchestrator {
  const now = options?.now ?? Date.now;

  // Bounded idempotency guard for `postApproveBlock` (CL-7229) — see
  // `POSTED_APPROVAL_GUARD_TTL_MS`'s own doc comment for what this does
  // and doesn't cover, and why an eviction is safe.
  const postedApprovalIds = createExpiringMap<string, true>({
    ttlMs: POSTED_APPROVAL_GUARD_TTL_MS,
    now,
  });

  // Every turn with a `connector.reply` pending delivery — added the
  // moment reply content is seen, cleared the moment that same turn's own
  // `message.run.ended` bracket closes (see below). Keyed by `turnKeyFor`
  // (agent address + sidecar session id), never by address alone: one
  // address can be mid-turn in several benches at once
  // (`resolveMemberWorkbenches` returns workbench ids plural by design),
  // and each such turn runs its own sidecar connection with its own
  // `sessionId` — the correlator every `agent.event` frame carries
  // regardless of which inner event type it wraps.
  const repliedTurns = new Set<string>();

  // Process-lifetime idempotency guard for the turn-drop notice below,
  // keyed the same way as `repliedTurns`: set the moment a notice is
  // posted for a turn that ended silently, cleared the moment that same
  // turn's next `connector.reply` arrives OR its `message.run.started`
  // reopens (a session can host more than one turn across its lifetime,
  // and a genuinely new turn on that session must never be suppressed by
  // a stale entry the previous turn on it left behind). Two turns in a
  // row can each end with zero `connector.reply` (an inference turn that
  // produced no text is not rare under load — see the notice's own
  // wording below), and without re-arming on every turn's OPEN, the
  // second silent turn's own notice would be swallowed by the guard
  // still set from the first, leaving the user staring at a thread that
  // looks permanently dead with no trace anywhere it ever tried again.
  const notifiedDropTurns = new Set<string>();

  // See `PendingDelegationThread`'s own doc comment above `postReply`.
  const pendingDelegationThreads = createExpiringMap<
    string,
    PendingDelegationThread
  >({ ttlMs: AGENT_TURN_STALE_MS, now });

  // See `createReplyPartsAccumulator`'s own doc comment above.
  const replyParts = createReplyPartsAccumulator(deps.connectorRegistry);

  const unsubscribe = deps.events.on(
    "agent.event",
    ({ agentAddress, sessionId, event }) => {
      // Any event at all counts as activity, not just `connector.reply`
      // below — an agent mid-inference must never be undeployed out
      // from under itself by the idle sweep just because it hasn't
      // replied yet.
      deps.recordActivity?.(agentAddress);

      const turnKey = turnKeyFor(agentAddress, sessionId);

      if (messageRunStarted(event)) {
        notifiedDropTurns.delete(turnKey);
        return;
      }

      // Structured turn content, ahead of `connector.reply`'s flattened
      // string below: every `inference.done` this turn already split the
      // model's output into prose and tool calls, and every `tool.done`
      // resolves one of those calls' outcome. Neither branch returns —
      // an inference step or a tool settling is not itself a reply.
      const blocks = inferenceDoneBlocks(event);
      if (blocks !== undefined) {
        replyParts.onInferenceDone(turnKey, blocks);
      }
      const toolResult = toolDoneResult(event);
      if (toolResult !== undefined) {
        replyParts.onToolDone(turnKey, toolResult);
      }

      const content = connectorReplyContent(event);
      if (content !== undefined) {
        repliedTurns.add(turnKey);
        notifiedDropTurns.delete(turnKey);
        // Prefer this turn's accumulated [text, tool-trace, text, ...]
        // parts over the flattened `content` string — the string is a
        // fallback for the rare case nothing was ever accumulated (e.g.
        // an error-path reply, which the harness never routes through
        // `inference.done` at all; see `event-collector.ts`'s
        // `connector.reply` case). Never wrap `content` verbatim when
        // structured parts exist, or a leaked JSON-shaped tool call
        // sitting in that string would still show up as prose.
        const accumulated = replyParts.take(turnKey);
        const parts: Part[] =
          accumulated !== undefined && accumulated.length > 0
            ? accumulated
            : [{ kind: "text", text: content }];
        void postReply(
          deps,
          pendingDelegationThreads,
          agentAddress,
          parts,
          {
            status: "completed",
          },
          event,
        ).catch((cause: unknown) => {
          log.error`chat orchestrator: failed to post ${agentAddress}'s reply: ${
            cause instanceof Error ? cause.message : String(cause)
          }`;
        });
        void postDailyTranscriptDigest(
          deps,
          agentAddress,
          flattenReplyText(parts),
        ).catch((cause: unknown) => {
          log.error`chat orchestrator: failed to record ${agentAddress}'s daily transcript digest: ${
            cause instanceof Error ? cause.message : String(cause)
          }`;
        });
        return;
      }

      // A turn that ends with no `connector.reply` this process ever
      // saw is otherwise invisible: nothing posts to any workbench and
      // nothing logs, so an agent that silently produced zero visible
      // text (a first-turn tool call with no accompanying text, an
      // inference failure `default-director` doesn't fold into a
      // reportable reply) reads to a human as "the room stayed empty"
      // with no trace anywhere. Turn dispatch already logs loudly when
      // *dispatching* itself fails (see `postCannedGreeting` in
      // `workbench-service.ts` for the same doctrine), but had no
      // counterpart for "delivered fine, the turn ran, nothing ever
      // came back out." Beyond the error log, an honest notice now goes
      // into the workbench itself — a human staring at a stalled thread
      // during saturated inference (stress round 3) must never see
      // nothing at all — guarded by `notifiedDropTurns` so a redelivered
      // `message.run.ended` (sidecar reconnect, wire-layer replay) posts
      // the notice once, not once per delivery.
      const ended = messageRunEnded(event);
      if (ended !== undefined) {
        // This turn's bracket closed either way — nothing accumulated
        // for it (if any) belongs to a future turn, not this one.
        replyParts.take(turnKey);

        const hadReply = repliedTurns.delete(turnKey);
        if (!hadReply) {
          const errorMessage = ended.errorMessage ?? "no error reported";
          log.error`chat orchestrator: agent ${agentAddress}'s turn ended (${ended.status}) with no reply ever posted to any workbench: ${errorMessage}`;

          if (!notifiedDropTurns.has(turnKey)) {
            notifiedDropTurns.add(turnKey);
            const noticeContent =
              ended.status === "failed"
                ? errorMessage
                : "I didn't manage to answer that one — say it again and I'll pick it up.";
            void postReply(
              deps,
              pendingDelegationThreads,
              agentAddress,
              [{ kind: "text", text: noticeContent }],
              { status: "failed", error: errorMessage },
              event,
            ).catch((cause: unknown) => {
              log.error`chat orchestrator: failed to post ${agentAddress}'s turn-drop notice: ${
                cause instanceof Error ? cause.message : String(cause)
              }`;
            });
          }
        }
        return;
      }

      const correlationId = gateBlockedCorrelationId(event);
      if (correlationId === undefined) return;

      void postApproveBlock(
        deps,
        agentAddress,
        correlationId,
        postedApprovalIds,
      ).catch((cause: unknown) => {
        log.error`chat orchestrator: failed to post ${agentAddress}'s approve block: ${
          cause instanceof Error ? cause.message : String(cause)
        }`;
      });
    },
  );

  return {
    dispose() {
      unsubscribe();
    },
  };
}
