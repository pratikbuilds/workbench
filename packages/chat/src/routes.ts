// The full HTTP surface of `@corbits/chat`: workbench lifecycle, message
// send/list, settings, read-state, typing, and the SSE stream — mounted
// by the hub inside its tenant-scoped middleware, so `TenantEnv`'s
// `tenant`/`principal` are always resolved before a handler here runs.
// Principals never appear in a path; the caller is always read off
// context.
//
// This module owns route registration, request parsing (arktype at
// the boundary), grant checks, and HTTP envelope mapping only — every
// other concern lives in its own module: the platform port in
// `./platform-port`, the settings vocabulary in `./workbench-settings`,
// join/fan-out orchestration in `./workbench-service`, and the SSE
// subscriber registry in `./workbench-events`.
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { type } from "arktype";
import { decodedOrNull } from "@corbits/url-path";
import { makeErrorEnvelope, reportError } from "@corbits/error-sink";

import type { TenantEnv } from "@intx/hub-api";
import type { RequireGrant } from "@intx/hub-api";
import { idResource } from "@intx/hub-api";

import { Part, type Part as PartType } from "./parts";
import {
  aggregatePollResponses,
  type BlockResponsePayload,
  type BlockResponseRow,
  type BlockResponseStore,
} from "./block-responses";
import {
  aggregateReactionsByMessage,
  type ReactionStore,
  type ReactionSummary,
} from "./reactions";
import { isKnownReactionEmoji } from "./reaction-emoji";
import type { PinRow, PinStore } from "./pins";
import type { ClientIdStore } from "./client-ids";
import { presetForKind } from "./kinds";
import { localPartOf } from "./agent-address";
import {
  parseParticipants,
  addParticipant,
  handleFromName,
} from "./participants";
import type { ParticipantRecord } from "./participants";
import {
  WORKBENCH_CONTROL_NAMESPACE,
  applyControlPayload,
  type WorkbenchControlPayload,
  type WorkbenchParticipantState,
} from "./settings-control";
import {
  benchContextWindowOf,
  workbenchView,
  kindOf,
  participantsOf,
  resolveContextWindow,
  SettingsValidationError,
  validateBenchSettingsPatch,
  validateSettingsPatch,
  visibilityOf,
} from "./workbench-settings";
import { isRecentlyActive } from "./workbench-activity";
import { postRoomMessage, type RoomMessageStore } from "./room-messages";
import { WorkbenchOnboardingStep } from "./blocks";
import type { ConnectGithubBlockData } from "./blocks";
import {
  findResidentAgentForDefinition,
  postCannedGreeting,
  joinHumanParticipant,
  KindIsChatError,
  launchAndJoinAgent,
  findExistingAgentChat,
  removeWorkbenchParticipant,
  resolveInvitedDisplayName,
  sendWorkbenchMessage,
  cancelWorkbenchTurn,
} from "./workbench-service";
import {
  bridgeWorkbenchStream,
  createWorkbenchSubscriberRegistry,
  createPlatformWorkbenchFanout,
  type WorkbenchSubscriberRegistry,
} from "./workbench-events";
import {
  createWorkbenchPresenceRegistry,
  type WorkbenchPresenceRegistry,
} from "./workbench-presence";
import { createInMemoryTurnClaimStore } from "./turn-claims";
import {
  createWorkbenchTurnQueue,
  type WorkbenchTurnQueue,
} from "./turn-queue";
import {
  createTurnCancelRegistry,
  type TurnCancelRegistry,
} from "./turn-cancellation";
import type { TurnMailCorrelationStore } from "./turn-mail-correlation";
import type { ChatPlatform } from "./platform-port";
import type { ChatStore } from "./store";
import {
  dispatchAtCommand,
  dispatchSlashCommand,
  resolveAtCommand,
} from "@corbits/commands";
import type { CommandRegistry, CommandResult } from "@corbits/commands";
import {
  InferenceResolutionError,
  DefinitionProjectionMissingError,
} from "@corbits/folded-runs";
import type { WorkbenchTenancyStore } from "./workbench-tenancy";
import { cookiesFromHeader } from "@corbits/hub-api-client";
import type { AgentTurnStore } from "./agent-turns";
import type { ThreadStore } from "./threads";
import { ThreadDepthCapError } from "./threads";
import {
  MailboxFanoutFailedError,
  type MailboxFanoutDeps,
} from "./mailbox-fanout";
import type { WorkbenchShareStore } from "./workbench-share";
import { monogramFromName } from "./workbench-share";
import type { FederationTrustStore } from "./federation-trust";
import type { InvitableDefinition as InvitableDefinitionRecord } from "./platform-port";
import { isAgentAddress } from "./mentions";
import { MODEL_UNAVAILABLE_CONSUMER_MESSAGE } from "./model-unavailable";

export type {
  WorkbenchEvents,
  WorkbenchLauncher,
  WorkbenchMail,
  ChatWorkbenchEvent,
  ChatPlatform,
  InvitableDefinition,
  LaunchedInvite,
  SentMail,
} from "./platform-port";

export type CreateChatRoutesDeps = {
  store: ChatStore;
  platform: ChatPlatform;
  /** The workbench timeline itself: every message a room holds. */
  roomMessages: RoomMessageStore;
  /**
   * Mints and tracks the native child tenant every workbench is anchored
   * as (see `./workbench-tenancy.ts`) — required, never optional: a
   * workbench created without a tenancy would be a silent legacy path
   * reopened, which "no fallbacks" forbids. Every workbench created
   * through this route carries a tenancy link from creation onward;
   * only workbenches that predate this rollout lack one.
   */
  tenancy: WorkbenchTenancyStore;
  requireGrant: RequireGrant;
  /**
   * The host's verdict on whether a deployed definition belongs in the
   * agent pickers (new-chat and invite). The platform already excludes
   * workbench-host anchors; this is where the host prunes its automations
   * (e.g. workbench passes "not automatable in the workflow catalog").
   * Required, never defaulted: an unfiltered picker is what let
   * schedulable workflows masquerade as chat partners.
   */
  isInvitableDefinition: (definition: InvitableDefinitionRecord) => boolean;
  /**
   * The default turn-claim TTL — see
   * `./workbench-service.ts`'s `DEFAULT_TURN_CLAIM_TTL_MS` for the
   * production default and the arithmetic it has to clear
   * (`waitUntilFreeTimeoutMs` + `turnDispatchTimeoutMs`, with margin)
   * to stay an unreachable backstop rather than a bound that fires on
   * a still-legitimate dispatch.
   */
  turnTimeoutMs: number;
  /**
   * CL-6644's turn-level deadline: see `SendWorkbenchMessageDeps`'s field
   * of the same name in `./workbench-service.ts`. Omitted,
   * `dispatchTurnBatch` uses `DEFAULT_TURN_DISPATCH_TIMEOUT_MS`.
   */
  turnDispatchTimeoutMs?: number;
  /**
   * CL-7129's bound on the CL-6670 wait: see `SendWorkbenchMessageDeps`'s
   * field of the same name in `./workbench-service.ts`. Omitted,
   * `dispatchTurnBatch` uses `DEFAULT_WAIT_UNTIL_FREE_TIMEOUT_MS`.
   */
  waitUntilFreeTimeoutMs?: number;
  /**
   * Resolves a principal to the display name a greeting can use. The
   * hub wires this to its user table; omitted, the canned greeting
   * simply carries no name.
   */
  resolvePrincipalName?: (
    tenantId: string,
    principalId: string,
  ) => Promise<string | undefined>;
  /**
   * Runs a fresh chat's post-mint delivery chain (join event → canned
   * greeting → agent pre-warm) after the 201 — the sends that carry
   * the host and agent deploys, off the request path. Production
   * fire-and-forgets (the default); tests capture the work so
   * assertions can await it deterministically.
   */
  runPostMintDelivery?: (work: () => Promise<void>) => void;
  /**
   * Observes a posted message's recipient fan-out (see
   * `sendWorkbenchMessage`'s `fanoutDelivered`). Production ignores it —
   * the whole point is that the sender's own message returns without
   * waiting on any delivery — while tests await it so assertions about
   * delivered copies are deterministic rather than racing.
   */
  onMessageFanout?: (fanoutDelivered: Promise<void>) => void;
  /**
   * Thread identity store (root / reply / delivery). When omitted,
   * thread list routes return empty and delivery-thread creation is
   * unavailable — composition that wants threads (hub) injects a
   * real store. Optional so unit tests that only exercise workbench
   * CRUD stay free of thread tables.
   */
  threads?: ThreadStore;
  /**
   * CL-7450's mailbox fan-out: writes a sent human message into every
   * human participant's `@corbits/mailbox` inbox — see
   * `SendWorkbenchMessageDeps`'s field of the same name in
   * `./workbench-service.ts`. Omitted, a sent message reaches only the
   * room's own timeline, the pre-CL-7450 behavior.
   */
  mailbox?: MailboxFanoutDeps;
  /**
   * Durable dispatch-mail -> source-message correlation (CL-6314) —
   * threaded through to every `sendWorkbenchMessage` call this router
   * makes, so the reply path can land an agent's answer in its source
   * message's thread. Omitted, dispatches still send; their replies
   * just post unthreaded.
   */
  turnMailCorrelation?: TurnMailCorrelationStore;
  /**
   * The turn projection (CL-6329) — one row per agent turn, which is
   * what makes a reply traceable back to the child run that produced
   * it. Omitted, the turns routes 404: the same "no store, no feature"
   * contract `pins` and `blockResponses` already follow.
   */
  agentTurns?: AgentTurnStore;
  /**
   * The visible text a still-running turn has committed to the platform's
   * own `turn_part` rows so far (CL-6380) — what a client reattaching
   * mid-turn replays as its catch-up snapshot before the live stream's tail
   * resumes. Omitted, a running turn's detail simply carries no
   * `textSnapshot` field and the client falls back to showing only the
   * indicator until the next live event arrives — the same "no store, no
   * feature" contract every other optional dep here follows.
   */
  turnTextSnapshot?: (input: {
    readonly tenantId: string;
    readonly runId: string;
  }) => Promise<string | null>;
  /**
   * Poll/form response storage — see `./block-responses.ts`. Omitted
   * entirely, the response routes 404 rather than silently accepting
   * votes/submissions nothing durable backs; every deployment that wants
   * the poll/form round-trip injects a real store the same way it injects
   * `threads`.
   */
  blockResponses?: BlockResponseStore;
  /**
   * Message reaction storage — see `./reactions.ts`. Omitted entirely,
   * the toggle route 404s and every message page's `reactions` field is
   * simply absent, the same "no store, no feature" contract
   * `blockResponses` follows.
   */
  reactions?: ReactionStore;
  /**
   * Pinned-message storage — see `./pins.ts`. Omitted entirely, the
   * pin/unpin/list-pins routes 404 and every message page's `pinned`
   * field is simply absent.
   */
  pins?: PinStore;
  /**
   * Client-send-identity storage — see `./client-ids.ts` (CL-6251).
   * Omitted entirely, `POST .../messages` still accepts and echoes a
   * `clientId` in its own 201 response, but every message page's
   * `clientId` field is simply absent — a host that never wires this
   * loses cross-load reconciliation of its own optimistic sends, not
   * the send itself.
   */
  clientIds?: ClientIdStore;
  /**
   * The `/name args` and `@name args` command registry — see
   * `@corbits/commands`. Omitted entirely, a message is always posted
   * verbatim regardless of a leading "/" or "@"; every deployment that
   * wants the command system wires this by injecting a fully-composed
   * registry (its workflow-command plugin already bound to this same
   * `publish`, via `workbenchSubscribers.publish` below — a
   * command-started workflow's workbench event then reaches the same
   * live SSE stream an ordinary invite does).
   */
  commands?: CommandRegistry;
  /**
   * The SSE subscriber registry this router's `/workbenches/:id/stream`
   * route bridges onto (see `./workbench-events.ts`). Defaults to a
   * fresh, router-scoped registry when omitted — the original
   * behavior, still correct for a caller with no other consumer of
   * live workbench events. A composition root that also drives workbench
   * events from outside this router (the hub's command dispatch path
   * publishing a workflow-started event, for instance) constructs one
   * registry itself and passes it here *and* to that other consumer,
   * so both sides fan out through the same subscriber set.
   */
  workbenchSubscribers?: WorkbenchSubscriberRegistry;
  /**
   * The "who's here" roster `/workbenches/:id/stream` piggybacks
   * presence onto — see `./workbench-presence.ts`. Defaults to a fresh,
   * router-scoped registry when omitted, mirroring
   * `workbenchSubscribers`'s own default; a composition root sharing
   * one process across multiple routers passes its own instance the
   * same way.
   */
  workbenchPresence?: WorkbenchPresenceRegistry;
  /**
   * One-in-flight-turn-per-workbench queue (CL-6331) every message send
   * routes its recipient fan-out through — see `./turn-queue.ts`.
   * Defaults to a fresh, router-scoped queue backed by an in-memory
   * claim store whose TTL is `turnTimeoutMs`, when omitted: the same
   * "construct one instance, inject it everywhere that needs it"
   * pattern `workbenchSubscribers` follows, for a caller with no other
   * consumer of turn-claim state to share it with.
   */
  turnQueue?: WorkbenchTurnQueue;
  /**
   * The live abort seam a running turn is reachable through (CL-7201) —
   * see `./turn-cancellation.ts` and `SendWorkbenchMessageDeps`'s field
   * of the same name in `./workbench-service.ts`. Defaults to a fresh,
   * router-scoped registry when omitted, the same "construct one
   * instance, share it everywhere" pattern `turnQueue` follows — it is
   * process-local, in-memory state with no cost to always have.
   */
  turnCancellation?: TurnCancelRegistry;
  /**
   * Slack-Connect-style workbench projection (CL-5882) — see
   * `./workbench-share.ts`. Omitted entirely, every `/workbenches/:id/shares*`
   * and `/workbenches/:id/share-members*` route 404s, and `resolveWorkbenchAccess`
   * only ever resolves the owning-tenant path: a deployment that doesn't
   * wire this dep behaves exactly as it did before this feature existed.
   */
  shares?: WorkbenchShareStore;
  /**
   * Read-only trust lookups the shares routes use to build a human
   * `sharedLabel`/`tenantName`/`tenantMonogram` — never the full
   * `FederationTrustStore` (this router never establishes or revokes
   * trust itself; that stays the native federation-trust surface's job).
   */
  trust?: Pick<
    FederationTrustStore,
    "resolveSharedViaParent" | "getTenantName"
  >;
  /**
   * Releases an invited agent's launched instance when it is removed
   * from a workbench's participants — see `workbench-service.ts`'s
   * `removeWorkbenchParticipant`, whose own doc explains why this is
   * native platform machinery (`sidecarRouter.sendAgentUndeploy` in the
   * hub's own composition), never reimplemented here. Omitted, an
   * agent's instance keeps running after removal; the gap is logged at
   * error level rather than silently accepted (see
   * `removeWorkbenchParticipant`).
   */
  releaseAgentInstance?:
    ((address: string, reason: string) => Promise<void>) | undefined;
};

const log = getLogger(["chat", "routes"]);

const CreateWorkbenchBody = type({
  kind: "string",
  "name?": "string",
  "participants?": "string[]",
  "definitionId?": "string",
  "principalId?": "string",
  /**
   * Accepted and ignored. `kind: "chat"` + `definitionId` always
   * find-or-reopens via `findExistingAgentChat` (CL-6981); this flag is
   * no longer an opt-in. Callers that still send it (Myra land-hop,
   * `openAgentDm`) are not 400'd.
   */
  "reuseExisting?": "boolean",
});
type CreateWorkbenchBodyT = typeof CreateWorkbenchBody.infer;

/**
 * Narrows a validated create-workbench body to the "chat with a
 * definitionId" shape, letting the type system carry the proof
 * `definitionId` is present rather than a `throw new
 * Error("unreachable")` after the fact — the route already 400s above
 * when `kind === "chat"` and neither `definitionId` nor `principalId`
 * is present, so this guard fails into an ordinary response, never a
 * thrown "impossible" error, if that invariant is ever broken by a
 * future edit.
 */
function isChatWithDefinition(
  body: CreateWorkbenchBodyT,
): body is CreateWorkbenchBodyT & { kind: "chat"; definitionId: string } {
  return body.kind === "chat" && body.definitionId !== undefined;
}

/**
 * Narrows a validated create-workbench body to the "chat with a
 * principalId" shape — a direct chat whose counterpart is a bench
 * member (a person), not an agent. Chosen over a separate `dm: true`
 * wire flag: `assignWorkbenchBucket` in the host app's sidebar already
 * derives "is this a DM" from `kind === "chat"` plus the absence of an
 * agent-shaped participant address (see `mentions.ts`'s
 * `isAgentAddress`), so a `principalId`-created chat lands in the DMs
 * bucket for free, with no second signal to keep in sync.
 */
function isChatWithPrincipal(
  body: CreateWorkbenchBodyT,
): body is CreateWorkbenchBodyT & { kind: "chat"; principalId: string } {
  return body.kind === "chat" && body.principalId !== undefined;
}

const InviteAgentBody = type({
  definitionId: "string",
});

/**
 * A message-send's optional pre-invite: the mention popover's "Bring
 * in…" group (see `mentions.ts`) lets a sender mention a workspace
 * member or invitable agent who isn't a participant yet, and this is
 * how that intent reaches the server. `POST .../messages` invites every
 * entry here — the same core `POST .../invite` and chat creation's
 * person path already use (`launchAndJoinAgent`/`joinHumanParticipant`)
 * — before sending, so the mention fans out normally the moment the
 * message itself is sent. A person entry carries the sender's chosen
 * display name the same way chat creation's `name` field does: a human
 * has no settings-held name a handle can be derived from.
 */
const MessageInviteEntry = type({
  kind: "'agent'",
  definitionId: "string",
}).or(
  type({
    kind: "'person'",
    principalId: "string",
    "name?": "string",
  }),
);

const RefreshAgentBody = type({
  address: "string",
});

const RemoveParticipantParams = type({
  address: "string > 0",
});

/** The message's own text, joined across every text part in send order
 * — the same shape `mentionedParticipants` reads a message's mentions
 * off of. Used only to decide whether a message opens the command
 * path; a command's own args always come from the grammar's parsed
 * remainder, never from this joined text. */
function textOf(parts: readonly PartType[]): string {
  return parts
    .filter(
      (part): part is Extract<PartType, { kind: "text" }> =>
        part.kind === "text",
    )
    .map((part) => part.text)
    .join(" ");
}

/** The system-style text a `CommandResult` posts back into the
 * workbench's timeline, or `undefined` for the `"noop"` result, which
 * posts nothing at all. */
function textForCommandResult(result: CommandResult): string | undefined {
  switch (result.type) {
    case "message":
      return result.text;
    case "workflow-started":
      return `Started @${result.handle}.`;
    case "noop":
      return undefined;
  }
}

const PutReadStateBody = type({
  lastSeenCreatedAt: "string",
  lastSeenId: "string",
});

// A poll response must name at least one choice, with no repeats — beyond
// that, the set of valid choice ids is the agent-authored `PollBlockData`
// this route never sees, so it isn't re-validated here (chat-ui already
// pins the vote to real, currently-declared choices before it ever posts).
const SubmitPollResponseBody = type({
  kind: "'poll'",
  choiceIds: "string[]",
}).narrow((body, ctx) => {
  if (body.choiceIds.length === 0) {
    return ctx.reject("choiceIds must include at least one choice");
  }
  if (new Set(body.choiceIds).size !== body.choiceIds.length) {
    return ctx.reject("choiceIds must not repeat a choice");
  }
  return true;
});

const SubmitFormResponseBody = type({
  kind: "'form'",
  values: "Record<string, string>",
});

// The answer is resolved client-side (the chosen option's label, or the
// free-text value) and posted verbatim: this route never sees
// `QuestionBlockData`'s option list, so it cannot re-derive a label from
// `optionIndex` alone. `answer` is what actually gets relayed into the
// workbench as the responding user's own message.
const SubmitQuestionResponseBody = type({
  kind: "'question'",
  answer: "string > 0",
  "optionIndex?": "number.integer >= 0",
});

const SubmitBlockResponseBody = SubmitPollResponseBody.or(
  SubmitFormResponseBody,
).or(SubmitQuestionResponseBody);

/**
 * The caller's own row on the GET wire. A question also carries
 * `notifiedAt` (ISO timestamp, or null when notify never landed) so
 * the card can keep a retry after remount instead of collapsing as
 * if the agent had already been reached. Poll/form payloads are
 * unchanged — `notifiedAt` is a question-only claim flag.
 */
function ownBlockResponseForClient(row: BlockResponseRow | undefined):
  | BlockResponsePayload
  | {
      readonly kind: "question";
      readonly answer: string;
      readonly optionIndex?: number;
      readonly notifiedAt: string | null;
    }
  | null {
  if (row === undefined) return null;
  if (row.payload.kind !== "question") return row.payload;
  return {
    kind: "question",
    answer: row.payload.answer,
    ...(row.payload.optionIndex !== undefined
      ? { optionIndex: row.payload.optionIndex }
      : {}),
    notifiedAt: row.notifiedAt === null ? null : row.notifiedAt.toISOString(),
  };
}

/**
 * Every `/workbenches/:id/*` handler must resolve the workbench inside the
 * request tenant before acting. A workbench is in-tenant when it has a
 * `workbench_settings` row **or** a `workbench_launch` row (agent host /
 * invite instance ids are mailboxes with no settings). A miss is a 404
 * — never a silent pass that lets a wildcard grant operate on another
 * tenant's workbench.
 */
async function workbenchInTenant(
  store: ChatStore,
  tenantId: string,
  workbenchId: string,
): Promise<boolean> {
  if ((await store.getWorkbenchSettings(tenantId, workbenchId)) !== undefined) {
    return true;
  }
  return store.hasLaunchedInstance(tenantId, workbenchId);
}

/**
 * The single fail-closed gate every
 * message/read-state/typing/stream/blob/block-response route resolves
 * through: the acting tenant either owns the workbench
 * outright (the ordinary case, `workbenchInTenant`), or it's a tenant a
 * share was explicitly created for AND the acting principal was
 * explicitly added as a share member (`WorkbenchShareStore.isShareMember`)
 * — never merely "a share exists for this tenant", since not every
 * member of the projected tenant automatically sees a shared workbench,
 * only the ones each side's own admin added one at a time via `POST
 * .../share-members`. A third tenant with no share row at all, and a
 * projected tenant's principal nobody added, both resolve to `undefined`
 * — indistinguishable from "workbench doesn't exist" to the caller, which
 * is the honest answer for a workbench this caller has no standing to see.
 *
 * `ownerTenantId` is what every downstream `deps.store`/`deps.platform`
 * call takes as `tenantId` — a projected-tenant caller's message reads
 * and writes are always scoped to the OWNING tenant's mailbox
 * (`WorkbenchMail.sendMail` is keyed by an explicit tenantId
 * argument, never an ambient caller tenant — see `./platform-port.ts`),
 * never a copy of the workbench materialized under the projected tenant.
 *
 * Approval boundary unchanged: `requireGrant` (wired per-route, above
 * this function) still evaluates only the ACTING tenant's own grants —
 * a share never widens what a projected-tenant caller may do beyond its
 * own tenant's rules; it only widens which workbench those rules apply to.
 * No grant-widening code exists anywhere in this router, deliberately.
 */
/**
 * Runs a `requireGrant` check outside its ordinary place as route
 * middleware — the message-send pre-invite step needs the exact same
 * authorization `POST .../invite` runs, but only conditionally (when
 * the body actually carries an `invite` entry), which route-level
 * middleware can't express. Returns the deny `Response` `requireGrant`
 * would otherwise have sent, or `undefined` when the grant is allowed.
 */
async function checkGrant(
  requireGrant: RequireGrant,
  resource: string,
  action: string,
  c: Context<TenantEnv>,
): Promise<Response | undefined> {
  return (await requireGrant(resource, action)(c, async () => {})) ?? undefined;
}

/**
 * A bench member may open a workbench its own bench owns when either
 * the workbench is bench-visible (the default — every member of the
 * owning bench opens it, which reaching this check at all already
 * proves the caller is) or, for a members-only workbench, the caller's
 * own auth identity (`refId`) holds an active principal in the
 * workbench's own child tenant — the native "invited" signal (CL-6332):
 * a workbench IS a tenant and mints one for whoever it's shared with,
 * with no separate membership table to fall out of sync with it. A
 * legacy workbench with no tenancy link at all (predates workbench
 * tenancy) has no such tenant to check membership against, so it stays
 * bench-visible regardless of its `chat/visibility` setting.
 */
async function benchCallerCanOpenWorkbench(
  deps: CreateChatRoutesDeps,
  benchTenantId: string,
  workbenchId: string,
  principalRefId: string,
): Promise<boolean> {
  const settings = await deps.store.getWorkbenchSettings(
    benchTenantId,
    workbenchId,
  );
  if (settings === undefined || visibilityOf(settings.settings) === "bench") {
    return true;
  }
  const link = await deps.tenancy.getWorkbenchTenancy(workbenchId);
  if (link === undefined) return true;
  const member = await deps.tenancy.getTenantPrincipalByRefId(
    link.tenantId,
    principalRefId,
  );
  return member !== undefined && member.status === "active";
}

async function resolveWorkbenchAccess(
  deps: CreateChatRoutesDeps,
  actingTenantId: string,
  workbenchId: string,
  principalId: string,
  principalRefId: string,
): Promise<{ ownerTenantId: string } | undefined> {
  if (await workbenchInTenant(deps.store, actingTenantId, workbenchId)) {
    if (
      !(await benchCallerCanOpenWorkbench(
        deps,
        actingTenantId,
        workbenchId,
        principalRefId,
      ))
    ) {
      return undefined;
    }
    return { ownerTenantId: actingTenantId };
  }
  if (deps.shares === undefined) return undefined;
  const share = await deps.shares.getShare(workbenchId, actingTenantId);
  if (share === undefined) return undefined;
  if (
    !(await deps.shares.isShareMember(actingTenantId, workbenchId, principalId))
  ) {
    return undefined;
  }
  return { ownerTenantId: share.owningTenantId };
}

/**
 * A message's sender carries the shared-workbench context
 * (`tenantId`/`tenantName`/`tenantMonogram`) only when the workbench
 * actually has at least one share AND the sender is a share member of
 * one of them — never for an ordinary owning-tenant participant, and
 * never fabricated when `deps.shares`/`deps.trust` aren't wired. Checked
 * per message rather than once per workbench because a workbench can be
 * shared into several tenants; the first share the sender is a member of
 * wins (a principal id is never added as a member under two different
 * projected tenants for the same workbench in the UI flow this ships, but
 * nothing stops it structurally — first match is a stable, if arbitrary,
 * tie-break).
 */
async function resolveMessageSenderTenant(
  deps: CreateChatRoutesDeps,
  ownerTenantId: string,
  workbenchId: string,
  senderAddress: string,
): Promise<
  { tenantId: string; tenantName?: string; tenantMonogram?: string } | undefined
> {
  if (deps.shares === undefined) return undefined;
  const shares = await deps.shares.listSharesForWorkbench(
    ownerTenantId,
    workbenchId,
  );
  if (shares.length === 0) return undefined;
  const principalId = localPartOf(senderAddress);
  for (const share of shares) {
    if (
      await deps.shares.isShareMember(
        share.projectedTenantId,
        workbenchId,
        principalId,
      )
    ) {
      const name = await deps.trust?.getTenantName(share.projectedTenantId);
      const base = { tenantId: share.projectedTenantId };
      return name !== undefined
        ? { ...base, tenantName: name, tenantMonogram: monogramFromName(name) }
        : base;
    }
  }
  return undefined;
}

/**
 * True when `messageId` names a real message on the workbench's own
 * timeline — the guard both write-side reaction/pin routes need before
 * touching storage. Without it, a `messageId` that was never sent (a
 * typo, a stale client, a probe) still 200s and writes a permanent row
 * keyed to nothing: invisible (no message ever renders it) and
 * unremovable (no UI affordance exists for a message that isn't there).
 */
async function messageExistsInWorkbench(
  roomMessages: RoomMessageStore,
  tenantId: string,
  workbenchId: string,
  messageId: string,
): Promise<boolean> {
  return (
    (await roomMessages.getMessage({ tenantId, workbenchId, messageId })) !==
    undefined
  );
}

/** The address a caller's own message is posted under: their principal
 * id at their tenant's domain, the same `id@domain` shape every
 * participant address carries. */
function senderAddressOf(c: Context<TenantEnv>): string {
  return `${c.get("principal").id}@${c.get("tenant").domain}`;
}

const ToggleReactionBody = type({ emoji: "string" });

type WireMessageItem = {
  readonly id: string;
  readonly createdAt: string;
  readonly sender: unknown;
  readonly parts: unknown;
};

/**
 * Attaches `reactions`, `pinned`, and `clientId` onto a page of message
 * items, each in one batched query over the whole page rather than one
 * round trip per message — "extend, don't fork" the wire type the
 * timeline already consumes. Every field is entirely absent (not
 * `[]`/`false`/omitted-key) when the corresponding store isn't
 * injected, matching how `blockResponses`'s absence 404s rather than
 * silently no-opping: a host that never wired reactions/pins/clientIds
 * gets a wire shape with no trace of that feature, not a feature that
 * always answers empty. `clientId` (CL-6251) is only ever present for
 * a message this same sender's own composer submitted with one — see
 * `./client-ids.ts` — and is what lets that sender's pending bubble
 * reconcile with this confirmed item by identity.
 */
async function enrichWithReactionsAndPins<T extends WireMessageItem>(
  deps: CreateChatRoutesDeps,
  tenantId: string,
  workbenchId: string,
  principalId: string,
  items: readonly T[],
): Promise<
  readonly (T & {
    reactions?: readonly ReactionSummary[];
    pinned?: boolean;
    clientId?: string;
  })[]
> {
  const reactionsByMessage =
    deps.reactions !== undefined
      ? aggregateReactionsByMessage(
          await deps.reactions.listReactionsForMessages(
            tenantId,
            workbenchId,
            items.map((item) => item.id),
          ),
          principalId,
        )
      : undefined;
  const pinnedIds =
    deps.pins !== undefined
      ? new Set(
          (await deps.pins.listPins(tenantId, workbenchId)).map(
            (row) => row.messageId,
          ),
        )
      : undefined;
  const clientIdByMessage =
    deps.clientIds !== undefined
      ? new Map(
          (
            await deps.clientIds.listClientIdsForMessages(
              tenantId,
              workbenchId,
              items.map((item) => item.id),
            )
          ).map((row) => [row.messageId, row.clientId]),
        )
      : undefined;

  if (
    reactionsByMessage === undefined &&
    pinnedIds === undefined &&
    clientIdByMessage === undefined
  ) {
    return items;
  }
  return items.map((item) => {
    const result: T & {
      reactions?: readonly ReactionSummary[];
      pinned?: boolean;
      clientId?: string;
    } = { ...item };
    if (reactionsByMessage !== undefined) {
      result.reactions = reactionsByMessage.get(item.id) ?? [];
    }
    if (clientIdByMessage !== undefined) {
      const clientId = clientIdByMessage.get(item.id);
      if (clientId !== undefined) result.clientId = clientId;
    }
    if (pinnedIds !== undefined) {
      result.pinned = pinnedIds.has(item.id);
    }
    return result;
  });
}

/**
 * What the command intercept decided about an incoming message:
 * `command` carries a dispatched command's result; `routeToParticipant`
 * says the `@name` named a definition already resident in the room, so
 * the message must post normally and its turn must reach that
 * participant's existing run (CL-6451) — never a freshly minted one.
 */
type WorkbenchCommandDecision =
  { readonly command: CommandResult } | { readonly routeToParticipant: string };

/**
 * Decides whether an incoming workbench message opens the command path
 * at all, and if so, dispatches it. `undefined` — the caller's cue to
 * post the message normally — for: no registry injected; text that is
 * neither slash- nor `@`-shaped; or an `@name` that names an existing
 * agent participant's handle rather than a command (mention fan-out
 * keeps owning that case exactly as before this rollout).
 *
 * The handle check alone cannot keep "one room participant = one live
 * run" (CL-6451): a participant's mention handle derives from its
 * definition's display name ("Myra"), while the workflow command is
 * named after the definition's wire name ("assistant") — so an `@name`
 * that resolves to a command is ALSO checked against the definitions
 * the room's agents were launched from, and a resident match routes to
 * that participant instead of dispatching a launch.
 */
async function dispatchWorkbenchCommand(
  deps: CreateChatRoutesDeps,
  input: {
    tenantId: string;
    principalId: string;
    workbenchId: string;
    text: string;
  },
): Promise<WorkbenchCommandDecision | undefined> {
  if (deps.commands === undefined) return undefined;
  const ctx = {
    tenantId: input.tenantId,
    principalId: input.principalId,
    workbenchId: input.workbenchId,
  };

  if (input.text.startsWith("/")) {
    const result = await dispatchSlashCommand(deps.commands, input.text, ctx);
    return result === undefined ? undefined : { command: result };
  }

  if (input.text.startsWith("@")) {
    const resolved = await resolveAtCommand(
      deps.commands,
      input.text,
      input.tenantId,
    );
    if (resolved === undefined) return undefined;

    const existing = await deps.store.getWorkbenchSettings(
      input.tenantId,
      input.workbenchId,
    );
    const participants =
      existing !== undefined ? participantsOf(existing.settings) : [];
    const namesKnownHandle = participants.some(
      (participant) => participant.handle === resolved.name,
    );
    if (namesKnownHandle) return undefined;

    const invitable = await deps.platform.listInvitableDefinitions(
      input.tenantId,
    );
    const commandDefinition = invitable.find(
      (definition) => definition.name === resolved.name,
    );
    if (commandDefinition !== undefined) {
      const resident = await findResidentAgentForDefinition(
        deps.platform,
        participants,
        commandDefinition.id,
      );
      if (resident !== undefined) {
        return { routeToParticipant: resident.address };
      }
    }

    const result = await dispatchAtCommand(deps.commands, input.text, ctx);
    return result === undefined ? undefined : { command: result };
  }

  return undefined;
}

const MoveWorkbenchBody = type({
  newParentTenantId: "string",
});

export { findExistingAgentChat };

/** Annotates a workbench view with its native child-tenancy — the
 * `tenancy` field every workbench created after this rollout carries,
 * never `null` unless a caller reaches a route that skips the
 * annotation (there are none; `GET /workbenches` handles the one place a
 * link can be legitimately missing itself, via its own `legacy`
 * branch). */
function withTenancy(
  view: ReturnType<typeof workbenchView>,
  link: { tenantId: string; parentTenantId: string; slug: string },
): ReturnType<typeof workbenchView> & {
  tenancy: { tenantId: string; parentTenantId: string; slug: string };
  legacy: false;
} {
  return {
    ...view,
    tenancy: {
      tenantId: link.tenantId,
      parentTenantId: link.parentTenantId,
      slug: link.slug,
    },
    legacy: false,
  };
}

export function createChatRoutes(deps: CreateChatRoutesDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const registry =
    deps.workbenchSubscribers ?? createWorkbenchSubscriberRegistry();
  const publish = registry.publish;
  // One upstream platform subscription per workbench, fanned out to every
  // SSE connection on that workbench — see `createPlatformWorkbenchFanout`.
  const platformEvents = createPlatformWorkbenchFanout(deps.platform);
  const presence = deps.workbenchPresence ?? createWorkbenchPresenceRegistry();
  const turnQueue =
    deps.turnQueue ??
    createWorkbenchTurnQueue({
      claims: createInMemoryTurnClaimStore({ ttlMs: deps.turnTimeoutMs }),
      publish,
    });
  const turnCancellation = deps.turnCancellation ?? createTurnCancelRegistry();

  app.post(
    "/workbenches",
    deps.requireGrant("workflow-run:*", "create"),
    async (c) => {
      const body = CreateWorkbenchBody(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid workbench body: ${body.summary}`,
          }),
          400,
        );
      }

      if (
        body.kind === "chat" &&
        body.definitionId === undefined &&
        body.principalId === undefined
      ) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage:
              "creating a chat requires either a definitionId naming the " +
              "one agent it launches with, or a principalId naming the " +
              "one bench member it's a direct conversation with",
          }),
          400,
        );
      }
      if (
        body.kind === "chat" &&
        body.definitionId !== undefined &&
        body.principalId !== undefined
      ) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage:
              "a chat's counterpart is exactly one agent or one person, " +
              "never both",
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");

      // kind: chat + definitionId always find-or-reopens (CL-6981): a DM
      // is the one 1:1 tenant with that agent. `reuseExisting` is accepted
      // and ignored — omitted and `false` reopen the same as `true`.
      // Checked before anything is minted, and before the (cheaper,
      // in-memory) principal-self-chat validation below, since a found
      // match short-circuits the whole handler.
      if (isChatWithDefinition(body)) {
        const existing = await findExistingAgentChat(
          deps,
          tenant.id,
          body.definitionId,
        );
        if (existing !== undefined) {
          const link = await deps.tenancy.getWorkbenchTenancy(
            existing.workbenchId,
          );
          return c.json(
            link !== undefined
              ? withTenancy(workbenchView(existing), link)
              : { ...workbenchView(existing), tenancy: null, legacy: true },
            200,
          );
        }
      }

      // A person-DM's counterpart is validated before anything is
      // minted: a caller cannot start a direct chat with themselves
      // (structurally never a DM — there is no second party), and
      // `principalId` must name a real, active member of this bench.
      // Both fail closed with an ordinary client error rather than
      // seeding a workbench with a participant record nothing backs.
      if (isChatWithPrincipal(body)) {
        if (body.principalId === principal.id) {
          return c.json(
            makeErrorEnvelope({
              code: "conflict",
              userMessage: "you cannot start a direct chat with yourself",
            }),
            409,
          );
        }
        const target = await deps.tenancy.getTenantPrincipal(
          tenant.id,
          body.principalId,
        );
        if (
          target === undefined ||
          target.kind !== "user" ||
          target.status !== "active"
        ) {
          return c.json(
            makeErrorEnvelope({
              code: "bad_request",
              userMessage:
                "principalId does not name an active member of this bench",
            }),
            400,
          );
        }
      }

      const workbenchId = generateId("workflowRun");
      // An unnamed agent chat is titled by its agent's display name
      // ("Myra"), resolved before the workbench tenant is minted so the
      // tenant row carries the same readable name instead of the raw
      // workbench id. An unknown definition leaves this undefined; the
      // post-join handle fallback below still names the chat then.
      const invitable = isChatWithDefinition(body)
        ? await deps.platform.listInvitableDefinitions(tenant.id)
        : [];
      const isAgentDm = isChatWithDefinition(body);
      const chatTitle =
        body.name ??
        (isAgentDm
          ? invitable.find((definition) => definition.id === body.definitionId)
              ?.description
          : undefined);

      // A workbench is a child tenant of the bench it is created in from
      // the moment it exists. Native tenant/role/grant rows are minted
      // through POST /api/tenants as this caller; the workbench_tenancy
      // link is written after. A later launch failure compensates the
      // link only — the native tenant stays, same as a later launch
      // failure already lives with. The creator becomes the child
      // tenant's native owner exactly as POST /api/tenants seeds its
      // own creator.
      const workbenchTenant = await deps.tenancy.createWorkbenchTenant({
        parentTenantId: tenant.id,
        workbenchId,
        name: chatTitle ?? workbenchId,
        creatorUserId: principal.refId,
        cookies: cookiesFromHeader(c.req.header("cookie")),
      });

      // Compensation can itself fail (a dropped connection, the same
      // outage that failed the launch). That must never swallow the
      // launch failure that triggered it — compensation failure is its
      // own loud log line, tagged with the orphaned tenant id for an
      // operator to clean up by hand, and the ORIGINAL launch error
      // always propagates to the caller (sync paths) or the log
      // (the async mint path below).
      async function compensateMint(err: unknown, phase: string) {
        log.error(
          "Workbench {phase} failed for {workbenchId} after minting " +
            "{tenantId}; compensating the orphaned tenant and settings: " +
            "{cause}",
          {
            phase,
            workbenchId,
            tenantId: workbenchTenant.tenantId,
            cause: err instanceof Error ? err.message : String(err),
            err,
          },
        );
        try {
          await deps.store.deleteWorkbenchSettings(tenant.id, workbenchId);
          await deps.tenancy.compensateWorkbenchTenant(
            workbenchTenant.tenantId,
          );
        } catch (compensationErr) {
          log.error(
            "Compensation failed for orphaned tenant {tenantId} after " +
              "workbench {workbenchId}'s {phase} failure; this tenant is now " +
              "a privileged orphan and requires manual cleanup",
            {
              phase,
              workbenchId,
              tenantId: workbenchTenant.tenantId,
              compensationErr,
            },
          );
        }
      }

      const preset = presetForKind(body.kind);
      // Initial participants arrive as bare addresses; each gets a
      // handle derived from its own local part, de-duplicated the same
      // way an invited agent's handle is (see `POST .../invite` below)
      // — settings always hold records, never bare strings.
      const initialParticipants = (body.participants ?? []).reduce<
        ParticipantRecord[]
      >(
        (acc, address) => addParticipant(acc, address, localPartOf(address)),
        [],
      );
      const baseSettings = {
        "chat/kind": body.kind,
        "chat/pinned": preset.pinned,
        "chat/participants": initialParticipants,
      };
      // Recorded so a later `POST /workbenches` for the same agent can find
      // this chat by it directly (see `findExistingAgentChat`) instead of
      // reverse-resolving a participant address every time.
      const withDefinitionId: Record<string, unknown> = isChatWithDefinition(
        body,
      )
        ? { ...baseSettings, "chat/definitionId": body.definitionId }
        : baseSettings;
      const settings: Record<string, unknown> =
        chatTitle !== undefined
          ? { ...withDefinitionId, "chat/name": chatTitle }
          : withDefinitionId;

      const row = await deps.store.createWorkbenchSettings({
        tenantId: tenant.id,
        workbenchId,
        settings,
        updatedBy: principal.id,
      });

      // Everything on the request path below is database work — an
      // agent launch is a mint (see `WorkbenchLauncher`'s own docs), so
      // the 201 returns in database time with the agent already a
      // participant. The deploy rides the post-mint delivery chain: the
      // greeting posts as data, and an explicit pre-warm deploys the
      // agent ahead of the member's first message.
      if (!isChatWithPrincipal(body) && isChatWithDefinition(body)) {
        const definitionId = body.definitionId;
        const runPostMintDelivery =
          deps.runPostMintDelivery ??
          ((work: () => Promise<void>) => void work());

        let joined: Awaited<ReturnType<typeof launchAndJoinAgent>>;
        try {
          joined = await launchAndJoinAgent(
            {
              store: deps.store,
              platform: deps.platform,
              roomMessages: deps.roomMessages,
              publish,
            },
            {
              tenantId: tenant.id,
              principalId: principal.id,
              workbenchId,
              definitionId,
              existingSettings: row.settings,
              invitable,
            },
          );
        } catch (err) {
          await compensateMint(err, "agent mint");
          // CL-6357: a definition whose every asset candidate has gone
          // unresolvable (DB/blob drift) is a named, consumer-facing
          // 4xx — never an unhandled 500 — with the same compensation
          // every other agent-mint failure already ran above.
          if (err instanceof DefinitionProjectionMissingError) {
            return c.json(
              makeErrorEnvelope({
                code: "not_launchable",
                userMessage: err.guidance,
              }),
              409,
            );
          }
          if (err instanceof InferenceResolutionError) {
            return c.json(
              makeErrorEnvelope({
                code: "not_launchable",
                userMessage: MODEL_UNAVAILABLE_CONSUMER_MESSAGE,
              }),
              409,
            );
          }
          throw err;
        }

        const finalSettings =
          chatTitle === undefined
            ? (
                await deps.store.updateWorkbenchSettings({
                  tenantId: tenant.id,
                  workbenchId,
                  settings: { ...joined.settings, "chat/name": joined.handle },
                  updatedBy: principal.id,
                })
              ).settings
            : joined.settings;

        const agentAddress = joined.address;
        const joinEventDelivered = joined.joinEventDelivered;
        const agentDisplayName = joined.displayName;
        runPostMintDelivery(async () => {
          const senderName =
            deps.resolvePrincipalName !== undefined
              ? await deps
                  .resolvePrincipalName(tenant.id, principal.id)
                  .catch(() => undefined)
              : undefined;
          // Greeting after the join event, so the timeline reads
          // joined-then-hello; neither ever rejects.
          await joinEventDelivered;
          await postCannedGreeting(
            { roomMessages: deps.roomMessages, publish },
            {
              tenantId: tenant.id,
              workbenchId,
              agentAddress,
              agentName: agentDisplayName,
              ...(senderName !== undefined ? { senderName } : {}),
            },
          );
          await deps.platform
            .ensureAwake(agentAddress)
            .catch((err: unknown) => {
              log.error(
                "Pre-warm deploy failed for workbench {workbenchId}'s agent " +
                  "{agentAddress}; the next message to it retries the wake: {err}",
                { workbenchId, agentAddress, err },
              );
            });
        });

        return c.json(
          withTenancy(
            workbenchView({ workbenchId, settings: finalSettings }),
            workbenchTenant,
          ),
          201,
        );
      }

      if (isChatWithPrincipal(body)) {
        // A person-DM's counterpart is added directly, with no
        // instance to launch (see `joinHumanParticipant`'s own doc
        // comment). Its handle has no settings-held name to derive
        // from the way an invited agent's does, so it comes from the
        // slug of whatever title the caller gave the chat — chat-ui
        // always sends the chosen member's display name as `name`
        // when the person didn't type a custom title, so this
        // resolves to something readable in the overwhelming case;
        // the local-part-of-the-principal-id fallback below only
        // fires for a bare API call that omits `name` entirely.
        const memberHandle = handleFromName(body.name ?? "", body.principalId);
        const memberPrincipal = await deps.tenancy.getTenantPrincipal(
          tenant.id,
          body.principalId,
        );
        if (memberPrincipal === undefined) {
          return c.json(
            makeErrorEnvelope({
              code: "bad_request",
              userMessage:
                "principalId does not name an active member of this bench",
            }),
            400,
          );
        }
        try {
          const joined = await joinHumanParticipant(
            {
              store: deps.store,
              roomMessages: deps.roomMessages,
              publish,
              tenancy: deps.tenancy,
            },
            {
              tenantId: tenant.id,
              principalId: principal.id,
              workbenchId,
              memberPrincipalId: body.principalId,
              memberRefId: memberPrincipal.refId,
              memberHandle,
            },
          );

          // The chat's default title, when the caller passes no name,
          // is the same handle its one participant record carries —
          // mirroring the agent-chat fallback below exactly.
          const finalSettings =
            body.name === undefined
              ? (
                  await deps.store.updateWorkbenchSettings({
                    tenantId: tenant.id,
                    workbenchId,
                    settings: {
                      ...joined.settings,
                      "chat/name": joined.handle,
                    },
                    updatedBy: principal.id,
                  })
                ).settings
              : joined.settings;

          return c.json(
            withTenancy(
              workbenchView({ workbenchId, settings: finalSettings }),
              workbenchTenant,
            ),
            201,
          );
        } catch (err) {
          log.error(
            "Adding the person-DM participant failed for workbench " +
              "{workbenchId} after the host was minted and settings were " +
              "written; compensating the workbench tenant and deleting " +
              "its settings",
            { workbenchId, tenantId: workbenchTenant.tenantId, err },
          );
          try {
            await deps.tenancy.compensateWorkbenchTenant(
              workbenchTenant.tenantId,
            );
            await deps.store.deleteWorkbenchSettings(tenant.id, workbenchId);
          } catch (compensationErr) {
            log.error(
              "Compensation failed after person-DM join failure for " +
                "workbench {workbenchId}; the orphaned tenant {tenantId} " +
                "and/or its settings require manual cleanup",
              {
                workbenchId,
                tenantId: workbenchTenant.tenantId,
                compensationErr,
              },
            );
          }
          throw err;
        }
      }

      return c.json(withTenancy(workbenchView(row), workbenchTenant), 201);
    },
  );

  app.get(
    "/workbenches",
    deps.requireGrant("workflow-run:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const kind = c.req.query("kind");
      const rows = await deps.store.listWorkbenchSettings(tenant.id, kind);
      // Every workbench_settings row here is scoped to this bench
      // already — the tenancy link is annotated on top, never used to
      // widen or narrow this query. A moved workbench keeps its
      // workbench_settings row in the bench it was created in forever,
      // so its link must be read by its own workbench id, never by
      // "children of this bench" — that filter goes stale the moment
      // a workbench moves elsewhere and would wrongly report it as
      // legacy. A row with no link at all is a genuine LEGACY workbench:
      // it predates this rollout (created before workbench tenancy
      // existed) and carries no native tenant of its own. Legacy rows
      // are surfaced here, never silently dropped — "no fallbacks"
      // means the gap stays visible until every legacy workbench is
      // backfilled a tenancy, at which point this branch and the
      // `legacy` field below should both be deleted.
      const links = await Promise.all(
        rows.map((row) => deps.tenancy.getWorkbenchTenancy(row.workbenchId)),
      );

      // Row signals (unread badge, live dot, relative time) in two bulk
      // calls covering every row — never one per workbench. The caller's
      // own read cursors come from `workbench_read_state`, the activity
      // from the timeline itself.
      const principal = c.get("principal");
      const readStates = await deps.store.listReadStates(
        tenant.id,
        rows.map((row) => row.workbenchId),
        principal.id,
      );
      const cursorByWorkbenchId = new Map(
        readStates.map((state) => [
          state.workbenchId,
          state.lastSeenCreatedAt.toISOString(),
        ]),
      );
      const activityByWorkbenchId = await deps.roomMessages.listActivity({
        tenantId: tenant.id,
        workbenches: rows.map((row) => {
          const sinceCreatedAt = cursorByWorkbenchId.get(row.workbenchId);
          return sinceCreatedAt === undefined
            ? { workbenchId: row.workbenchId }
            : { workbenchId: row.workbenchId, sinceCreatedAt };
        }),
      });

      const ownItems = rows.map((row, index) => {
        const link = links[index];
        const view =
          link !== undefined
            ? withTenancy(workbenchView(row), link)
            : { ...workbenchView(row), tenancy: null, legacy: true };
        const activity = activityByWorkbenchId[row.workbenchId];
        if (activity === undefined) return view;
        const withUnread = { ...view, unreadCount: activity.unreadCount };
        if (activity.lastActivityAt === undefined) return withUnread;
        const withActivity = {
          ...withUnread,
          lastActivityAt: activity.lastActivityAt,
          live: isRecentlyActive(activity.lastActivityAt),
        };
        return activity.preview === undefined
          ? withActivity
          : { ...withActivity, preview: activity.preview };
      });

      // Workbenches a sibling tenant projected into this one (CL-5882) —
      // a UNION with this tenant's own rows above, never a replacement.
      // Only a share this caller's principal was explicitly added to
      // (`isShareMember`) contributes a row: a share that exists but has
      // no member row for this principal, or a tenant with no share at
      // all, adds nothing here, matching `resolveWorkbenchAccess`'s same
      // fail-closed rule for the message/read-state/stream routes.
      const shares = deps.shares;
      const sharedItems =
        shares === undefined
          ? []
          : await (async () => {
              const projectedShares = await shares.listSharesProjectedInto(
                tenant.id,
              );
              const items: Record<string, unknown>[] = [];
              for (const share of projectedShares) {
                if (
                  !(await shares.isShareMember(
                    tenant.id,
                    share.workbenchId,
                    principal.id,
                  ))
                ) {
                  continue;
                }
                const ownerRow = await deps.store.getWorkbenchSettings(
                  share.owningTenantId,
                  share.workbenchId,
                );
                if (ownerRow === undefined) continue;
                const view = workbenchView(ownerRow);
                if (kind !== undefined && view.kind !== kind) continue;
                const viaParent = await deps.trust?.resolveSharedViaParent(
                  share.owningTenantId,
                  tenant.id,
                );
                const owningTenantName = await deps.trust?.getTenantName(
                  share.owningTenantId,
                );
                const sharedLabel =
                  viaParent !== undefined
                    ? `shared via parent · ${viaParent.parentName}`
                    : `shared · ${owningTenantName ?? "another tenant"}`;
                items.push({
                  ...view,
                  tenancy: null,
                  legacy: false,
                  sharedLabel,
                });
              }
              return items;
            })();

      return c.json({ items: [...ownItems, ...sharedItems] });
    },
  );

  // A message's thread is the one it was assigned to, or the root thread
  // when it was never assigned at all — `workbench_thread_messages` states
  // that default ("root feed by default"), and `POST /messages` is the only
  // caller that records membership, so every agent-originated message
  // arrives with none. Both thread-aware read routes resolve it the same
  // way, from one assignments read rather than a request per thread.
  async function resolveThreadMembership(
    tenantId: string,
    workbenchId: string,
  ): Promise<
    | {
        readonly rootThreadId: string;
        readonly threadIdOf: (id: string) => string;
      }
    | undefined
  > {
    if (deps.threads === undefined) return undefined;
    const root = await deps.threads.ensureRootThread(tenantId, workbenchId);
    const assignments = await deps.threads.listThreadAssignments(
      tenantId,
      workbenchId,
    );
    return {
      rootThreadId: root.id,
      threadIdOf: (id) => assignments.get(id) ?? root.id,
    };
  }

  app.get(
    "/workbenches/:id/threads",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const workbenchId = c.req.param("id");
      if (!(await workbenchInTenant(deps.store, tenant.id, workbenchId))) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      if (deps.threads === undefined) {
        return c.json({ rootThreadId: "", items: [] as const });
      }
      const membership = await resolveThreadMembership(tenant.id, workbenchId);
      if (membership === undefined) {
        return c.json({ rootThreadId: "", items: [] as const });
      }
      const items = await deps.threads.listThreads(tenant.id, workbenchId);

      // Reply activity for every thread from the one mailbox read the
      // per-thread feed would otherwise repeat once per thread (CL-6313):
      // the client renders "N replies" and a last-activity stamp on each
      // affordance, and fanning out to `GET /threads/:id/messages` to
      // count them turned every timeline refresh into N full mailbox reads.
      const listed = await deps.roomMessages.listMessages({
        tenantId: tenant.id,
        workbenchId,
      });
      const activityByThreadId = new Map<
        string,
        { count: number; lastActivityAt: string }
      >();
      for (const item of listed.items) {
        const threadId = membership.threadIdOf(item.id);
        const current = activityByThreadId.get(threadId);
        activityByThreadId.set(threadId, {
          count: (current?.count ?? 0) + 1,
          lastActivityAt:
            current === undefined || item.createdAt > current.lastActivityAt
              ? item.createdAt
              : current.lastActivityAt,
        });
      }

      return c.json({
        rootThreadId: membership.rootThreadId,
        items: items.map((t) => {
          const activity = activityByThreadId.get(t.id);
          return {
            id: t.id,
            kind: t.kind,
            parentMessageId: t.parentMessageId,
            parentThreadId: t.parentThreadId,
            runRef: t.runRef,
            title: t.title,
            createdAt: t.createdAt.toISOString(),
            replyCount: activity?.count ?? 0,
            // Null, never the thread's own creation time: a thread with
            // no messages has had no activity, and dating it by its
            // creation would sort an empty thread among live ones.
            lastActivityAt: activity?.lastActivityAt ?? null,
          };
        }),
      });
    },
  );

  app.post(
    "/workbenches/:id/threads/fork",
    deps.requireGrant(idResource("workflow-run", "id"), "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const workbenchId = c.req.param("id");
      if (!(await workbenchInTenant(deps.store, tenant.id, workbenchId))) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      if (deps.threads === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "threads not available",
          }),
          404,
        );
      }
      const body = type({
        parentMessageId: "string",
        "title?": "string",
      })(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid body: ${body.summary}`,
          }),
          400,
        );
      }
      const forkParams = {
        tenantId: tenant.id,
        workbenchId,
        parentMessageId: body.parentMessageId,
      };
      const thread = await deps.threads.forkThread(
        body.title !== undefined
          ? { ...forkParams, title: body.title }
          : forkParams,
      );
      return c.json(
        {
          id: thread.id,
          kind: thread.kind,
          parentMessageId: thread.parentMessageId,
          parentThreadId: thread.parentThreadId,
          runRef: thread.runRef,
          title: thread.title,
          createdAt: thread.createdAt.toISOString(),
        },
        201,
      );
    },
  );

  app.get(
    "/workbenches/:id/threads/:threadId/messages",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");
      const threadId = c.req.param("threadId");
      if (!(await workbenchInTenant(deps.store, tenant.id, workbenchId))) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      if (deps.threads === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "threads not available",
          }),
          404,
        );
      }
      const thread = await deps.threads.getThread(tenant.id, threadId);
      if (thread === undefined || thread.workbenchId !== workbenchId) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "thread not found",
          }),
          404,
        );
      }
      // A message's thread is the one it was assigned to, or the root
      // thread when it was never assigned at all — `workbench_thread_messages`
      // states that default ("root feed by default"), and this is the
      // one place that resolves it. `POST /messages` is the only caller
      // that records membership, so every agent-originated message
      // (`chat-orchestrator`'s reply/approve-block/artifact posters,
      // `workbench-service`'s join and leave notices) arrives with none:
      // listing a feed by membership rows alone would silently hide all
      // of them, a fresh chat's very first agent reply included.
      const membership = await resolveThreadMembership(tenant.id, workbenchId);
      if (membership === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "threads not available",
          }),
          404,
        );
      }
      const listed = await deps.roomMessages.listMessages({
        tenantId: tenant.id,
        workbenchId,
      });
      const items = listed.items
        .filter((message) => membership.threadIdOf(message.id) === threadId)
        .map((message) => ({
          id: message.id,
          createdAt: message.createdAt,
          sender: message.sender,
          parts: message.parts,
        }));
      return c.json({
        thread: {
          id: thread.id,
          kind: thread.kind,
          parentMessageId: thread.parentMessageId,
          parentThreadId: thread.parentThreadId,
          runRef: thread.runRef,
          title: thread.title,
          createdAt: thread.createdAt.toISOString(),
        },
        items: await enrichWithReactionsAndPins(
          deps,
          tenant.id,
          workbenchId,
          principal.id,
          items,
        ),
      });
    },
  );

  app.post(
    "/workbenches/:id/delivery-threads",
    deps.requireGrant(idResource("workflow-run", "id"), "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const workbenchId = c.req.param("id");
      if (!(await workbenchInTenant(deps.store, tenant.id, workbenchId))) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      if (deps.threads === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "threads not available",
          }),
          404,
        );
      }
      const body = type({
        runRef: "string",
        "title?": "string",
      })(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid body: ${body.summary}`,
          }),
          400,
        );
      }
      const deliveryParams = {
        tenantId: tenant.id,
        workbenchId,
        runRef: body.runRef,
      };
      const thread = await deps.threads.createDeliveryThread(
        body.title !== undefined
          ? { ...deliveryParams, title: body.title }
          : deliveryParams,
      );
      return c.json(
        {
          id: thread.id,
          kind: thread.kind,
          runRef: thread.runRef,
          title: thread.title,
          createdAt: thread.createdAt.toISOString(),
        },
        201,
      );
    },
  );

  app.get(
    "/workbenches/:id/messages",
    deps.requireGrant(idResource("room", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");
      const cursor = c.req.query("cursor");

      const access = await resolveWorkbenchAccess(
        deps,
        tenant.id,
        workbenchId,
        principal.id,
        principal.refId,
      );
      if (access === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }

      const listParams = { tenantId: access.ownerTenantId, workbenchId };
      const listed = await deps.roomMessages.listMessages(
        cursor !== undefined ? { ...listParams, cursor } : listParams,
      );

      // Stamping each message with its thread is what lets one client
      // query serve the root feed, every open thread, and reply counts
      // (CL-6313) — this route already reads the whole mailbox, so the
      // membership resolve costs one extra read, not one per thread.
      // Absent (not a fabricated id) on a host that mounts no thread
      // store, matching `GET /threads`' own `rootThreadId: ""` there.
      const membership = await resolveThreadMembership(
        access.ownerTenantId,
        workbenchId,
      );

      const items = await Promise.all(
        listed.items.map(async (message) => {
          const senderTenant = await resolveMessageSenderTenant(
            deps,
            access.ownerTenantId,
            workbenchId,
            message.sender.address,
          );
          const base = {
            id: message.id,
            createdAt: message.createdAt,
            sender:
              senderTenant !== undefined
                ? { ...message.sender, ...senderTenant }
                : message.sender,
            parts: message.parts,
          };
          return membership === undefined
            ? base
            : { ...base, threadId: membership.threadIdOf(message.id) };
        }),
      );

      const responseItems = await enrichWithReactionsAndPins(
        deps,
        access.ownerTenantId,
        workbenchId,
        principal.id,
        items,
      );
      return c.json(
        listed.nextCursor !== undefined
          ? { items: responseItems, nextCursor: listed.nextCursor }
          : { items: responseItems },
      );
    },
  );

  // A `FilePart`'s `blobId` (see `./parts.ts`) has no stored link to a
  // Library artifact — chat attachments and Library artifacts are two
  // separate stores today (`CL-5938`). This is the client's only read path
  // to a persisted attachment's bytes: base64 so binary attachments round-
  // trip through JSON exactly like text ones, leaving MIME interpretation
  // to the caller, which already has it from the message `Part`.
  app.get(
    "/workbenches/:id/blobs/:blobId",
    deps.requireGrant(idResource("room", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");
      const blobId = c.req.param("blobId");
      if (
        (await resolveWorkbenchAccess(
          deps,
          tenant.id,
          workbenchId,
          principal.id,
          principal.refId,
        )) === undefined
      ) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      let blob: string | Uint8Array;
      try {
        blob = await deps.platform.fetchBlob(workbenchId, blobId);
      } catch (err) {
        const refId = reportError(err, {
          operation: "chat.blob.fetch",
          tenantId: tenant.id,
          roomId: workbenchId,
        });
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "blob not found",
            refId,
          }),
          404,
        );
      }
      const contentBase64 =
        typeof blob === "string"
          ? Buffer.from(blob, "utf-8").toString("base64")
          : Buffer.from(blob).toString("base64");
      return c.json({ contentBase64 });
    },
  );

  app.post(
    "/workbenches/:id/messages",
    deps.requireGrant(idResource("room", "id"), "write"),
    async (c) => {
      const raw = await c.req.json().catch(() => undefined);
      // Clean cutover: body is always { parts, threadId?, inReplyToMessageId? }.
      // Messages land on the root feed unless a thread or parent reply is set.
      const PostMessageBody = type({
        parts: Part.array(),
        "threadId?": "string",
        "inReplyToMessageId?": "string",
        "invite?": MessageInviteEntry.array(),
        // The sender's own client-generated send identity (CL-6251):
        // echoed back in this response and, when `clientIds` is
        // wired, recorded against the resulting message id so a later
        // `GET .../messages` page carries it too — whichever arrives
        // at the sender first, the confirmed message reconciles the
        // pending bubble it was optimistically rendered as.
        "clientId?": "string",
      });
      const parsed = PostMessageBody(raw);
      if (parsed instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid message body: ${parsed.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");
      const messageParts = parsed.parts as PartType[];

      const access = await resolveWorkbenchAccess(
        deps,
        tenant.id,
        workbenchId,
        principal.id,
        principal.refId,
      );
      if (access === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      const ownerTenantId = access.ownerTenantId;

      // The mention popover's "Bring in…" group lets a sender mention a
      // not-yet-participant; `invite` carries that intent here. Every
      // entry is invited BEFORE the message itself sends, through the
      // exact same core `POST .../invite` and chat creation's person
      // path already use, so the mention fans out normally the instant
      // the send below runs — never a second round trip. Permission
      // honesty: this requires the same grant `POST .../invite` itself
      // requires, checked once for the whole batch (a batch mixing an
      // allowed and a disallowed invite is not a case chat-ui's
      // popover — which only ever offers grant-eligible invites in the
      // one popover session — produces), and a denial leaves the
      // workbench and the draft untouched.
      if (parsed.invite !== undefined && parsed.invite.length > 0) {
        const denied = await checkGrant(
          deps.requireGrant,
          idResource(
            "workflow-run",
            "id",
          )({ param: (name) => c.req.param(name) }),
          "create",
          c,
        );
        if (denied !== undefined) {
          return c.json(
            makeErrorEnvelope({
              code: "forbidden",
              userMessage: "You can't add people to this workbench",
            }),
            403,
          );
        }

        const existing = await deps.store.getWorkbenchSettings(
          ownerTenantId,
          workbenchId,
        );
        if (existing === undefined) {
          return c.json(
            makeErrorEnvelope({
              code: "not_found",
              userMessage: "workbench not found",
            }),
            404,
          );
        }

        let currentSettings = existing.settings;
        const invitable =
          await deps.platform.listInvitableDefinitions(ownerTenantId);
        for (const entry of parsed.invite) {
          const participants = participantsOf(currentSettings);
          if (
            entry.kind === "person" &&
            participants.some(
              (participant) => participant.address === entry.principalId,
            )
          ) {
            continue;
          }

          if (entry.kind === "agent") {
            try {
              const joined = await launchAndJoinAgent(
                {
                  store: deps.store,
                  platform: deps.platform,
                  roomMessages: deps.roomMessages,
                  publish,
                },
                {
                  tenantId: ownerTenantId,
                  principalId: principal.id,
                  workbenchId,
                  definitionId: entry.definitionId,
                  existingSettings: currentSettings,
                  invitable,
                },
              );
              currentSettings = joined.settings;
            } catch (err) {
              if (err instanceof InferenceResolutionError) {
                return c.json(
                  makeErrorEnvelope({
                    code: "not_launchable",
                    userMessage: MODEL_UNAVAILABLE_CONSUMER_MESSAGE,
                  }),
                  409,
                );
              }
              if (err instanceof DefinitionProjectionMissingError) {
                return c.json(
                  makeErrorEnvelope({
                    code: "not_launchable",
                    userMessage: err.guidance,
                  }),
                  409,
                );
              }
              if (err instanceof KindIsChatError) {
                return c.json(
                  makeErrorEnvelope({
                    code: err.code,
                    userMessage: err.message,
                  }),
                  409,
                );
              }
              throw err;
            }
            continue;
          }

          const target = await deps.tenancy.getTenantPrincipal(
            ownerTenantId,
            entry.principalId,
          );
          if (
            target === undefined ||
            target.kind !== "user" ||
            target.status !== "active"
          ) {
            return c.json(
              makeErrorEnvelope({
                code: "bad_request",
                userMessage:
                  "principalId does not name an active member of this bench",
              }),
              400,
            );
          }
          const joined = await joinHumanParticipant(
            {
              store: deps.store,
              roomMessages: deps.roomMessages,
              publish,
              tenancy: deps.tenancy,
            },
            {
              tenantId: ownerTenantId,
              principalId: principal.id,
              workbenchId,
              memberPrincipalId: entry.principalId,
              memberRefId: target.refId,
              memberHandle: handleFromName(entry.name ?? "", entry.principalId),
            },
          );
          currentSettings = joined.settings;
        }
      }

      // Slash messages, and `@name` messages whose name resolves to a
      // command rather than an already-invited agent participant, are
      // intercepted here and never posted as mail themselves — only
      // the command's result is, as a system-style message. An
      // `@mention` of an existing agent participant is untouched:
      // resolving it against the registry only runs once it is
      // confirmed not to name a known handle, so that mention keeps
      // its ordinary fan-out behavior exactly as before.
      const commandDecision = await (async () => {
        try {
          return await dispatchWorkbenchCommand(deps, {
            tenantId: ownerTenantId,
            principalId: principal.id,
            workbenchId,
            text: textOf(messageParts),
          });
        } catch (err) {
          if (err instanceof KindIsChatError) {
            return c.json(
              makeErrorEnvelope({ code: err.code, userMessage: err.message }),
              409,
            );
          }
          throw err;
        }
      })();
      if (commandDecision instanceof Response) {
        return commandDecision;
      }
      if (commandDecision !== undefined && "command" in commandDecision) {
        const commandResult = commandDecision.command;
        const resultText = textForCommandResult(commandResult);
        if (resultText !== undefined) {
          await postRoomMessage(
            { roomMessages: deps.roomMessages, publish },
            {
              tenantId: ownerTenantId,
              workbenchId,
              sender: { name: null, address: senderAddressOf(c) },
              senderPrincipalId: principal.id,
              parts: [{ kind: "text", text: resultText }],
            },
          );
        }
        return c.json({ command: commandResult }, 201);
      }

      // Resolve the target thread *before* publish so the `chat.message`
      // SSE payload carries `threadId` (CL-6660). Assignment still runs
      // after the insert — membership needs the new message id — but
      // subscribers must not see a root-feed echo of a reply send.
      let targetThreadId: string | undefined;
      if (deps.threads !== undefined) {
        const root = await deps.threads.ensureRootThread(
          ownerTenantId,
          workbenchId,
        );
        targetThreadId = root.id;
        if (parsed.threadId !== undefined) {
          const existing = await deps.threads.getThread(
            ownerTenantId,
            parsed.threadId,
          );
          if (existing === undefined || existing.workbenchId !== workbenchId) {
            return c.json(
              makeErrorEnvelope({
                code: "not_found",
                userMessage: "thread not found",
              }),
              404,
            );
          }
          targetThreadId = existing.id;
        } else if (parsed.inReplyToMessageId !== undefined) {
          let reply;
          try {
            reply = await deps.threads.openReplyThread({
              tenantId: ownerTenantId,
              workbenchId,
              parentMessageId: parsed.inReplyToMessageId,
            });
          } catch (cause) {
            if (cause instanceof ThreadDepthCapError) {
              return c.json(
                makeErrorEnvelope({
                  code: "conflict",
                  userMessage: cause.message,
                }),
                409,
              );
            }
            throw cause;
          }
          targetThreadId = reply.id;
        }
      }

      // No unreachable-agent branch: the message is a room write, and
      // reaching an agent happens off this path — an agent that cannot
      // be reached answers with a notice on the timeline in its own
      // voice (see `sendWorkbenchMessage`), never a failed send.
      //
      // `MailboxFanoutFailedError` is caught here rather than falling
      // through to the hub's global `app.onError`: `writeChatMailboxFanout`
      // already reported it once, under the `refId` the error carries, so
      // this quotes that ref rather than reporting the same failure again
      // under a second one.
      let sent;
      try {
        sent = await sendWorkbenchMessage(
          {
            store: deps.store,
            platform: deps.platform,
            roomMessages: deps.roomMessages,
            publish,
            turnQueue,
            turnCancellation,
            ...(deps.agentTurns !== undefined
              ? { agentTurns: deps.agentTurns }
              : {}),
            ...(deps.threads !== undefined ? { threads: deps.threads } : {}),
            ...(deps.turnMailCorrelation !== undefined
              ? { turnMailCorrelation: deps.turnMailCorrelation }
              : {}),
            ...(deps.turnDispatchTimeoutMs !== undefined
              ? { turnDispatchTimeoutMs: deps.turnDispatchTimeoutMs }
              : {}),
            ...(deps.waitUntilFreeTimeoutMs !== undefined
              ? { waitUntilFreeTimeoutMs: deps.waitUntilFreeTimeoutMs }
              : {}),
            ...(deps.mailbox !== undefined ? { mailbox: deps.mailbox } : {}),
          },
          {
            tenantId: ownerTenantId,
            principalId: principal.id,
            senderAddress: senderAddressOf(c),
            workbenchId,
            messageParts,
            ...(parsed.inReplyToMessageId !== undefined
              ? { inReplyToMessageId: parsed.inReplyToMessageId }
              : {}),
            ...(targetThreadId !== undefined
              ? { threadId: targetThreadId }
              : {}),
            ...(commandDecision !== undefined &&
            "routeToParticipant" in commandDecision
              ? { forcedRecipientAddress: commandDecision.routeToParticipant }
              : {}),
          },
        );
      } catch (err) {
        if (err instanceof MailboxFanoutFailedError) {
          return c.json(
            makeErrorEnvelope({
              code: "mailbox_fanout_failed",
              userMessage:
                "Your message could not be saved to everyone's inbox; " +
                "nothing was sent. Try again.",
              refId: err.refId,
            }),
            502,
          );
        }
        throw err;
      }
      deps.onMessageFanout?.(sent.fanoutDelivered);

      if (parsed.clientId !== undefined && deps.clientIds !== undefined) {
        await deps.clientIds.recordClientId({
          tenantId: ownerTenantId,
          workbenchId,
          messageId: sent.id,
          clientId: parsed.clientId,
        });
      }

      if (deps.threads !== undefined && targetThreadId !== undefined) {
        await deps.threads.assignMessage({
          tenantId: ownerTenantId,
          workbenchId,
          threadId: targetThreadId,
          messageId: sent.id,
        });
        return c.json(
          {
            id: sent.id,
            createdAt: sent.createdAt,
            threadId: targetThreadId,
            ...(parsed.clientId !== undefined
              ? { clientId: parsed.clientId }
              : {}),
          },
          201,
        );
      }

      return c.json(
        {
          id: sent.id,
          createdAt: sent.createdAt,
          ...(parsed.clientId !== undefined
            ? { clientId: parsed.clientId }
            : {}),
        },
        201,
      );
    },
  );

  app.post(
    "/workbenches/:id/messages/:messageId/blocks/:blockId/responses",
    deps.requireGrant(idResource("room", "id"), "write"),
    async (c) => {
      if (deps.blockResponses === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "block responses not available",
          }),
          404,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");
      const messageId = c.req.param("messageId");
      const blockId = c.req.param("blockId");

      const access = await resolveWorkbenchAccess(
        deps,
        tenant.id,
        workbenchId,
        principal.id,
        principal.refId,
      );
      if (access === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      const ownerTenantId = access.ownerTenantId;

      const body = SubmitBlockResponseBody(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid response body: ${body.summary}`,
          }),
          400,
        );
      }

      const payload: BlockResponsePayload =
        body.kind === "poll"
          ? { kind: "poll", choiceIds: body.choiceIds }
          : body.kind === "form"
            ? { kind: "form", values: body.values }
            : {
                kind: "question",
                answer: body.answer,
                ...(body.optionIndex !== undefined
                  ? { optionIndex: body.optionIndex }
                  : {}),
              };

      const responseKey = {
        tenantId: ownerTenantId,
        workbenchId,
        messageId,
        blockId,
        principalId: principal.id,
      };

      const row = await deps.blockResponses.upsertBlockResponse({
        ...responseKey,
        payload,
      });

      // A machine-readable event into the same workbench timeline the
      // responder is already a member of, so the outcome reaches the
      // emitting agent in-context on its next turn — the same "the message
      // is the state" pattern Block Kit's `block_actions` uses, rather than
      // a side channel only the agent can reach. Every workbench member sees
      // the same event any other message in this workbench would show them;
      // that is the workbench's own membership boundary, not a new one — the
      // GET route below is the boundary that must never let a member read
      // *another* member's raw response on demand. Posted before the
      // question branch below ever gets a chance to dispatch a turn, so an
      // agent reading the timeline for its turn always finds this event
      // already there (CL-7192).
      await postRoomMessage(
        { roomMessages: deps.roomMessages, publish },
        {
          tenantId: ownerTenantId,
          workbenchId,
          sender: { name: null, address: senderAddressOf(c) },
          senderPrincipalId: principal.id,
          parts: [
            {
              kind: "event",
              event: "block.response",
              data: { messageId, blockId, ...row.payload },
            },
          ],
        },
      );

      // A question's answer is the interview reply itself, not just a
      // structured event: post it into the workbench as the responding
      // user's own message so the asking agent receives it exactly as it
      // would any other reply from that user — visible in-thread, routed
      // by the workbench's normal host routing, no side channel only the
      // agent can read.
      //
      // `claimBlockResponseNotification` guards this so only the
      // submission that first answers a question ever sends the message
      // and dispatches a turn: a changed answer, or a double-click that
      // beats the UI's disable, still lands its own row above, but never
      // gets a second turn (CL-7192). A failed send releases the claim so
      // a retried submission can still notify the agent, rather than
      // leaving the answer permanently unable to reach it.
      if (payload.kind === "question") {
        const claimToken =
          await deps.blockResponses.claimBlockResponseNotification(responseKey);
        if (claimToken !== false) {
          try {
            const answer = await sendWorkbenchMessage(
              {
                store: deps.store,
                platform: deps.platform,
                roomMessages: deps.roomMessages,
                publish,
                turnQueue,
                turnCancellation,
                ...(deps.agentTurns !== undefined
                  ? { agentTurns: deps.agentTurns }
                  : {}),
                ...(deps.threads !== undefined
                  ? { threads: deps.threads }
                  : {}),
                ...(deps.turnMailCorrelation !== undefined
                  ? { turnMailCorrelation: deps.turnMailCorrelation }
                  : {}),
                ...(deps.turnDispatchTimeoutMs !== undefined
                  ? { turnDispatchTimeoutMs: deps.turnDispatchTimeoutMs }
                  : {}),
                ...(deps.waitUntilFreeTimeoutMs !== undefined
                  ? { waitUntilFreeTimeoutMs: deps.waitUntilFreeTimeoutMs }
                  : {}),
                ...(deps.mailbox !== undefined
                  ? { mailbox: deps.mailbox }
                  : {}),
              },
              {
                tenantId: ownerTenantId,
                principalId: principal.id,
                senderAddress: senderAddressOf(c),
                workbenchId,
                messageParts: [{ kind: "text", text: payload.answer }],
              },
            );
            deps.onMessageFanout?.(answer.fanoutDelivered);
          } catch (err) {
            // `MailboxFanoutFailedError` already reported itself under its
            // own `refId` — quoting that instead of calling `reportError`
            // again is what keeps one failure to one ref (CL-7450).
            const refId =
              err instanceof MailboxFanoutFailedError
                ? err.refId
                : reportError(err, {
                    operation: "chat.blockResponse.notifyQuestionAnswer",
                    tenantId: ownerTenantId,
                    roomId: workbenchId,
                  });
            await deps.blockResponses.releaseBlockResponseNotification(
              responseKey,
              claimToken,
            );
            return c.json(
              makeErrorEnvelope({
                code: "notify_failed",
                userMessage: `your answer was saved, but the agent couldn't be notified — try again (ref ${refId})`,
                refId,
              }),
              500,
            );
          }
        }
      }

      return c.json({ blockId, updatedAt: row.updatedAt.toISOString() }, 200);
    },
  );

  app.get(
    "/workbenches/:id/messages/:messageId/blocks/:blockId/responses",
    deps.requireGrant(idResource("room", "id"), "read"),
    async (c) => {
      if (deps.blockResponses === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "block responses not available",
          }),
          404,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");
      const messageId = c.req.param("messageId");
      const blockId = c.req.param("blockId");

      const access = await resolveWorkbenchAccess(
        deps,
        tenant.id,
        workbenchId,
        principal.id,
        principal.refId,
      );
      if (access === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }

      // Every response on file for this block, read once and filtered down
      // before any of it reaches the wire: a poll's tally is a count over
      // every row regardless of whose it is, but `own` is this caller's row
      // and this caller's alone — no other principal's raw poll choice or
      // form values is ever assembled into the response body. A question's
      // `own` also carries `notifiedAt` so the card can tell a completed
      // notify from an answer that never reached the agent.
      const rows = await deps.blockResponses.listBlockResponses(
        access.ownerTenantId,
        workbenchId,
        messageId,
        blockId,
      );
      const { tally, total } = aggregatePollResponses(rows);
      const own = ownBlockResponseForClient(
        rows.find((row) => row.principalId === principal.id),
      );

      return c.json({ tally, total, own });
    },
  );

  app.post(
    "/workbenches/:id/messages/:messageId/reactions/toggle",
    deps.requireGrant(idResource("room", "id"), "write"),
    async (c) => {
      if (deps.reactions === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "reactions not available",
          }),
          404,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");
      const messageId = c.req.param("messageId");

      const access = await resolveWorkbenchAccess(
        deps,
        tenant.id,
        workbenchId,
        principal.id,
        principal.refId,
      );
      if (access === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      const ownerTenantId = access.ownerTenantId;
      if (
        !(await messageExistsInWorkbench(
          deps.roomMessages,
          ownerTenantId,
          workbenchId,
          messageId,
        ))
      ) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "message not found",
          }),
          404,
        );
      }

      const body = ToggleReactionBody(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid reaction body: ${body.summary}`,
          }),
          400,
        );
      }
      if (!isKnownReactionEmoji(body.emoji)) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `${JSON.stringify(body.emoji)} is not a supported reaction`,
          }),
          400,
        );
      }

      const { added } = await deps.reactions.toggleReaction({
        tenantId: ownerTenantId,
        workbenchId,
        messageId,
        emoji: body.emoji,
        principalId: principal.id,
      });

      const rows = await deps.reactions.listReactionsForMessages(
        ownerTenantId,
        workbenchId,
        [messageId],
      );
      const count = rows.filter((row) => row.emoji === body.emoji).length;

      publish(workbenchId, {
        type: "chat.reaction",
        data: {
          messageId,
          emoji: body.emoji,
          principalId: principal.id,
          added,
        },
      });

      return c.json({ emoji: body.emoji, count, reactedByMe: added });
    },
  );

  app.post(
    "/workbenches/:id/messages/:messageId/pin",
    deps.requireGrant(idResource("room", "id"), "write"),
    async (c) => {
      if (deps.pins === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "pins not available",
          }),
          404,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");
      const messageId = c.req.param("messageId");

      const access = await resolveWorkbenchAccess(
        deps,
        tenant.id,
        workbenchId,
        principal.id,
        principal.refId,
      );
      if (access === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      const ownerTenantId = access.ownerTenantId;
      if (
        !(await messageExistsInWorkbench(
          deps.roomMessages,
          ownerTenantId,
          workbenchId,
          messageId,
        ))
      ) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "message not found",
          }),
          404,
        );
      }

      const row = await deps.pins.pinMessage({
        tenantId: ownerTenantId,
        workbenchId,
        messageId,
        pinnedBy: principal.id,
      });

      publish(workbenchId, {
        type: "chat.pin",
        data: {
          messageId,
          pinned: true,
          pinnedBy: row.pinnedBy,
          pinnedAt: row.pinnedAt.toISOString(),
        },
      });

      return c.json({
        messageId,
        pinnedBy: row.pinnedBy,
        pinnedAt: row.pinnedAt.toISOString(),
      });
    },
  );

  app.delete(
    "/workbenches/:id/messages/:messageId/pin",
    deps.requireGrant(idResource("room", "id"), "write"),
    async (c) => {
      if (deps.pins === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "pins not available",
          }),
          404,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");
      const messageId = c.req.param("messageId");

      const access = await resolveWorkbenchAccess(
        deps,
        tenant.id,
        workbenchId,
        principal.id,
        principal.refId,
      );
      if (access === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }

      await deps.pins.unpinMessage(
        access.ownerTenantId,
        workbenchId,
        messageId,
      );

      publish(workbenchId, {
        type: "chat.pin",
        data: { messageId, pinned: false },
      });

      return c.body(null, 204);
    },
  );

  app.get(
    "/workbenches/:id/pins",
    deps.requireGrant(idResource("room", "id"), "read"),
    async (c) => {
      if (deps.pins === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "pins not available",
          }),
          404,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");

      const access = await resolveWorkbenchAccess(
        deps,
        tenant.id,
        workbenchId,
        principal.id,
        principal.refId,
      );
      if (access === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      const ownerTenantId = access.ownerTenantId;

      const pins = await deps.pins.listPins(ownerTenantId, workbenchId);
      if (pins.length === 0) return c.json({ items: [] });

      const listed = await deps.roomMessages.listMessages({
        tenantId: ownerTenantId,
        workbenchId,
      });
      const byId = new Map(
        listed.items.map((message) => [message.id, message]),
      );

      const items = pins.flatMap((pin: PinRow) => {
        const message = byId.get(pin.messageId);
        if (message === undefined) return [];
        return [
          {
            id: message.id,
            createdAt: message.createdAt,
            sender: message.sender,
            parts: message.parts,
            pinnedBy: pin.pinnedBy,
            pinnedAt: pin.pinnedAt.toISOString(),
          },
        ];
      });

      return c.json({ items });
    },
  );

  // The tenant-wide listing the new-chat dialog reads before any workbench
  // exists; the per-workbench `/workbenches/:id/invitable` below serves the
  // in-workbench invite flow and insists its workbench is real.
  app.get(
    "/invitable-definitions",
    deps.requireGrant("workflow-run:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const items = await deps.platform.listInvitableDefinitions(tenant.id);
      return c.json({ items: items.filter(deps.isInvitableDefinition) });
    },
  );

  app.get(
    "/workbenches/:id/invitable",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const workbenchId = c.req.param("id");
      const existing = await deps.store.getWorkbenchSettings(
        tenant.id,
        workbenchId,
      );
      if (
        existing === undefined &&
        !(await workbenchInTenant(deps.store, tenant.id, workbenchId))
      ) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }

      // A definition already in the room isn't invitable — resolve each
      // current agent participant's address back to its definitionId so
      // the listing never re-offers someone already present (CL-6649).
      const presentDefinitionIds = new Set(
        (
          await Promise.all(
            (existing !== undefined ? participantsOf(existing.settings) : [])
              .filter((participant) => isAgentAddress(participant.address))
              .map((participant) =>
                deps.platform.resolveDefinitionIdByAddress(participant.address),
              ),
          )
        ).filter((id): id is string => id !== undefined),
      );

      const items = await deps.platform.listInvitableDefinitions(tenant.id);
      return c.json({
        items: items
          .filter(deps.isInvitableDefinition)
          .filter((item) => !presentDefinitionIds.has(item.id)),
      });
    },
  );

  // Every one of the workbench's own agent participants, each resolved
  // back to its definition id and person-facing display name — the
  // timeline, mention picker, and presence stack render this name, never
  // the raw handle slug (CL-6424). The settings surface's Assistant
  // section reads the definition id before it looks up each definition's
  // name/instructions through `@corbits/agent-directory`. A workbench
  // with several invited agents lists every one of them, not just the
  // first; a participant whose address no longer resolves to a live,
  // nameable definition is simply omitted rather than failing the whole
  // list.
  app.get(
    "/workbenches/:id/agents",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const workbenchId = c.req.param("id");
      const existing = await deps.store.getWorkbenchSettings(
        tenant.id,
        workbenchId,
      );
      if (existing === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }

      const agentParticipants = participantsOf(existing.settings).filter(
        (participant) => isAgentAddress(participant.address),
      );
      const invitable = await deps.platform.listInvitableDefinitions(tenant.id);
      const items = (
        await Promise.all(
          agentParticipants.map(async (participant) => {
            const definitionId =
              await deps.platform.resolveDefinitionIdByAddress(
                participant.address,
              );
            if (definitionId === undefined) return null;
            const definitionAssetId =
              await deps.platform.resolveDefinitionAssetId(definitionId);
            if (definitionAssetId === undefined) return null;
            let displayName: string;
            try {
              displayName = await resolveInvitedDisplayName(
                deps.platform,
                invitable,
                definitionId,
              );
            } catch (err) {
              reportError(err, {
                operation: "chat.workbenchAgents.displayName",
                tenantId: tenant.id,
                roomId: workbenchId,
              });
              return null;
            }
            return {
              address: participant.address,
              handle: participant.handle,
              definitionId,
              definitionAssetId,
              displayName,
            };
          }),
        )
      ).filter((item) => item !== null);

      return c.json({ items });
    },
  );

  // Recomputes the given agent's `workbench_launch` folded body from its
  // definition's CURRENT `workflow.json` — the lever that makes an
  // edited system prompt reach an already-invited, already-running
  // instance, since a wake replays whatever `workbench_launch` holds
  // verbatim and never re-reads the asset itself (see
  // `ChatPlatform.refreshAgentInstanceFromDefinition`). The settings
  // surface calls this right after saving through
  // `@corbits/agent-directory`, so the change is live for this
  // workbench's agent from its next reply. A no-op (never errors) for an
  // address this platform has no running instance for.
  app.post(
    "/workbenches/:id/agents/refresh",
    deps.requireGrant(idResource("workflow-run", "id"), "update"),
    async (c) => {
      const body = RefreshAgentBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid refresh body: ${body.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const workbenchId = c.req.param("id");
      await deps.platform.refreshAgentInstanceFromDefinition(
        tenant.id,
        workbenchId,
        body.address,
      );
      return c.json({ ok: true });
    },
  );

  app.post(
    "/workbenches/:id/invite",
    deps.requireGrant(idResource("workflow-run", "id"), "create"),
    async (c) => {
      const body = InviteAgentBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid invite body: ${body.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");

      const existing = await deps.store.getWorkbenchSettings(
        tenant.id,
        workbenchId,
      );
      if (existing === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }

      try {
        const joined = await launchAndJoinAgent(
          {
            store: deps.store,
            platform: deps.platform,
            roomMessages: deps.roomMessages,
            publish,
          },
          {
            tenantId: tenant.id,
            principalId: principal.id,
            workbenchId,
            definitionId: body.definitionId,
            existingSettings: existing.settings,
            invitable: await deps.platform.listInvitableDefinitions(tenant.id),
          },
        );

        return c.json(
          { address: joined.address, definitionId: joined.definitionId },
          201,
        );
      } catch (err) {
        if (err instanceof InferenceResolutionError) {
          return c.json(
            makeErrorEnvelope({
              code: "not_launchable",
              userMessage: MODEL_UNAVAILABLE_CONSUMER_MESSAGE,
            }),
            409,
          );
        }
        if (err instanceof DefinitionProjectionMissingError) {
          return c.json(
            makeErrorEnvelope({
              code: "not_launchable",
              userMessage: err.guidance,
            }),
            409,
          );
        }
        if (err instanceof KindIsChatError) {
          return c.json(
            makeErrorEnvelope({ code: err.code, userMessage: err.message }),
            409,
          );
        }
        throw err;
      }
    },
  );

  // A room's onboarding walkthrough, posted explicitly by whoever knows
  // what the room is for — never as a side effect of hosting an agent.
  // The step lands as a system row (no run, no launch, no wake), so an
  // empty channel can run its walkthrough with no agent in the room at
  // all. Only the declared step shapes are accepted: this is not a
  // general "post any block" hole in the route surface.
  app.post(
    "/workbenches/:id/onboarding",
    deps.requireGrant(idResource("workflow-run", "id"), "create"),
    async (c) => {
      const step = WorkbenchOnboardingStep(
        await c.req.json().catch(() => undefined),
      );
      if (step instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid onboarding step: ${step.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const workbenchId = c.req.param("id");
      const existing = await deps.store.getWorkbenchSettings(
        tenant.id,
        workbenchId,
      );
      if (existing === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }

      const data: ConnectGithubBlockData = {
        requiredForTemplate: step.requiredForTemplate,
        promise: step.promise,
        steps: step.steps,
        state: "disconnected",
      };
      const posted = await postRoomMessage(
        { roomMessages: deps.roomMessages, publish },
        {
          tenantId: tenant.id,
          workbenchId,
          sender: { name: null, address: `system@${workbenchId}` },
          parts: [{ kind: "block", block: { type: "connect-github", data } }],
        },
      );

      return c.json({ id: posted.id }, 201);
    },
  );

  // The removal counterpart to `POST .../invite` (and to the inline
  // join a chat's own creation runs): drops a participant record and,
  // for an invited agent, releases its launched instance — see
  // `workbench-service.ts`'s `removeWorkbenchParticipant`. A chat is
  // 1:1: `launchAndJoinAgent` reuses the same definition and refuses
  // a different agent, so removal from a `kind: "chat"` workbench is
  // refused the same way.
  app.delete(
    "/workbenches/:id/participants/:address",
    deps.requireGrant(idResource("workflow-run", "id"), "manage"),
    async (c) => {
      const address = decodedOrNull(c.req.param("address"));
      if (address === null) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: "invalid participant: malformed address",
          }),
          400,
        );
      }
      const params = RemoveParticipantParams({ address });
      if (params instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid participant: ${params.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");

      const existing = await deps.store.getWorkbenchSettings(
        tenant.id,
        workbenchId,
      );
      if (existing === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }

      if (kindOf(existing.settings) === "chat") {
        return c.json(
          makeErrorEnvelope({
            code: "conflict",
            userMessage:
              "a chat's participants are fixed at creation; removal is " +
              "only for workbenches",
          }),
          409,
        );
      }

      const participant = participantsOf(existing.settings).find(
        (candidate) => candidate.address === params.address,
      );
      if (participant === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "participant not found",
          }),
          404,
        );
      }

      await removeWorkbenchParticipant(
        {
          store: deps.store,
          roomMessages: deps.roomMessages,
          publish,
          releaseAgentInstance: deps.releaseAgentInstance,
        },
        {
          tenantId: tenant.id,
          principalId: principal.id,
          workbenchId,
          participant,
        },
      );

      return c.json({ address: participant.address }, 200);
    },
  );

  app.post(
    "/workbenches/:id/move",
    deps.requireGrant(idResource("workflow-run", "id"), "manage"),
    async (c) => {
      const body = MoveWorkbenchBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid move body: ${body.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const workbenchId = c.req.param("id");

      // The move is only ever initiated from the bench that currently
      // owns the workbench — `getWorkbenchSettings` scopes by `tenant.id`,
      // so a caller cannot move a workbench it does not already see.
      const existing = await deps.store.getWorkbenchSettings(
        tenant.id,
        workbenchId,
      );
      if (existing === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }

      const principal = c.get("principal");

      // The destination is verified and the move is written inside a
      // single call: `newParentTenantId` must name a real tenant, and
      // the caller must hold an active, manage-granted principal there
      // — the same grant machinery `requireGrant` uses, evaluated
      // against the destination tenant rather than the caller's own —
      // but re-checked from inside the very transaction that performs
      // the write, under row locks, rather than as a separate round
      // trip beforehand (see `WorkbenchTenancyStore.moveWorkbenchTenancy`).
      // A caller with standing only in the workbench's current bench can
      // never move it into a tenant it has no authority over, and
      // nothing can revoke that authority in the gap between checking
      // it and acting on it, because there is no gap.
      const outcome = await deps.tenancy.moveWorkbenchTenancy({
        workbenchId,
        newParentTenantId: body.newParentTenantId,
        callerRefId: principal.refId,
      });

      switch (outcome.kind) {
        case "no_tenancy":
          return c.json(
            makeErrorEnvelope({
              code: "conflict",
              userMessage:
                "this workbench predates the child-tenancy rollout and carries " +
                "no native tenant of its own; it cannot be moved until it " +
                "is backfilled a tenancy",
            }),
            409,
          );
        case "destination_not_found":
          return c.json(
            makeErrorEnvelope({
              code: "not_found",
              userMessage: "destination tenant not found",
            }),
            404,
          );
        case "cycle":
          return c.json(
            makeErrorEnvelope({
              code: "conflict",
              userMessage:
                "the destination is this workbench's own tenant, or a " +
                "descendant of it; moving it there would make the " +
                "workbench its own ancestor",
            }),
            409,
          );
        case "forbidden":
          return c.json(
            makeErrorEnvelope({
              code: "forbidden",
              userMessage:
                "you do not have a manage grant in the destination tenant",
            }),
            403,
          );
        case "moved":
          return c.json(
            {
              workbenchId,
              tenancy: {
                tenantId: outcome.row.tenantId,
                parentTenantId: outcome.row.parentTenantId,
                slug: outcome.row.slug,
              },
            },
            200,
          );
      }
    },
  );

  const CreateShareBody = type({ projectedTenantId: "string" });

  app.post(
    "/workbenches/:id/shares",
    deps.requireGrant(idResource("workflow-run", "id"), "manage"),
    async (c) => {
      const body = CreateShareBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid share body: ${body.summary}`,
          }),
          400,
        );
      }
      if (deps.shares === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "shares not available",
          }),
          404,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");

      // A share can only ever be created by the tenant that already
      // owns the workbench — the same ownership check `/move` runs.
      const existing = await deps.store.getWorkbenchSettings(
        tenant.id,
        workbenchId,
      );
      if (existing === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }

      const outcome = await deps.shares.createShare({
        owningTenantId: tenant.id,
        workbenchId,
        projectedTenantId: body.projectedTenantId,
        createdBy: principal.id,
      });

      switch (outcome.kind) {
        case "trust_missing":
          return c.json(
            makeErrorEnvelope({
              code: "forbidden",
              userMessage:
                "no bilateral trust with the target tenant — establish " +
                "trust before sharing",
            }),
            403,
          );
        case "already_shared":
          return c.json(
            makeErrorEnvelope({
              code: "conflict",
              userMessage:
                "this workbench is already shared with " + "that tenant",
            }),
            409,
          );
        case "created": {
          const viaParent = await deps.trust?.resolveSharedViaParent(
            tenant.id,
            body.projectedTenantId,
          );
          const targetName = await deps.trust?.getTenantName(
            body.projectedTenantId,
          );
          let sharedContext: Record<string, unknown> = {};
          if (deps.trust !== undefined) {
            const inner: Record<string, unknown> = {};
            if (viaParent !== undefined) inner.viaParent = viaParent;
            if (targetName !== undefined) inner.targetTenantName = targetName;
            sharedContext = { sharedContext: inner };
          }
          return c.json(
            {
              owningTenantId: outcome.row.owningTenantId,
              workbenchId: outcome.row.workbenchId,
              projectedTenantId: outcome.row.projectedTenantId,
              createdBy: outcome.row.createdBy,
              createdAt: outcome.row.createdAt.toISOString(),
              ...sharedContext,
            },
            201,
          );
        }
      }
    },
  );

  app.get(
    "/workbenches/:id/shares",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      if (deps.shares === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "shares not available",
          }),
          404,
        );
      }

      const tenant = c.get("tenant");
      const workbenchId = c.req.param("id");

      const existing = await deps.store.getWorkbenchSettings(
        tenant.id,
        workbenchId,
      );
      if (existing === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }

      const rows = await deps.shares.listSharesForWorkbench(
        tenant.id,
        workbenchId,
      );
      return c.json({
        items: rows.map((row) => ({
          owningTenantId: row.owningTenantId,
          workbenchId: row.workbenchId,
          projectedTenantId: row.projectedTenantId,
          createdBy: row.createdBy,
          createdAt: row.createdAt.toISOString(),
        })),
      });
    },
  );

  app.delete(
    "/workbenches/:id/shares/:projectedTenantId",
    deps.requireGrant(idResource("workflow-run", "id"), "manage"),
    async (c) => {
      if (deps.shares === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "shares not available",
          }),
          404,
        );
      }

      const tenant = c.get("tenant");
      const workbenchId = c.req.param("id");
      const projectedTenantId = c.req.param("projectedTenantId");

      const existing = await deps.store.getWorkbenchSettings(
        tenant.id,
        workbenchId,
      );
      if (existing === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }

      const revoked = await deps.shares.revokeShare(
        tenant.id,
        workbenchId,
        projectedTenantId,
      );
      if (!revoked) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "share not found",
          }),
          404,
        );
      }
      return c.body(null, 204);
    },
  );

  const AddShareMemberBody = type({ principalId: "string" });

  app.post(
    "/workbenches/:id/share-members",
    deps.requireGrant(idResource("workflow-run", "id"), "manage"),
    async (c) => {
      const body = AddShareMemberBody(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid share-member body: ${body.summary}`,
          }),
          400,
        );
      }
      if (deps.shares === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "shares not available",
          }),
          404,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");

      // Evaluated against the ACTING tenant, never the owning tenant —
      // this is the projected tenant's own admin managing their own
      // side. A share never widens grants: this route only ever inserts
      // into `workbench_share_member` for `projectedTenantId = tenant.id`,
      // never touches the owning tenant's own participant list. Also
      // doubles as "is this workbench even shared with me" — a tenant
      // with no share on this workbench gets the same 404 a nonexistent
      // workbench would.
      const share = await deps.shares.getShare(workbenchId, tenant.id);
      if (share === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }

      const outcome = await deps.shares.addShareMember({
        projectedTenantId: tenant.id,
        workbenchId,
        principalId: body.principalId,
        addedBy: principal.id,
      });
      if (outcome === "no_share") {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      return c.json({ principalId: body.principalId }, 200);
    },
  );

  app.delete(
    "/workbenches/:id/share-members/:principalId",
    deps.requireGrant(idResource("workflow-run", "id"), "manage"),
    async (c) => {
      if (deps.shares === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "shares not available",
          }),
          404,
        );
      }

      const tenant = c.get("tenant");
      const workbenchId = c.req.param("id");
      const principalId = c.req.param("principalId");

      const removed = await deps.shares.removeShareMember(
        tenant.id,
        workbenchId,
        principalId,
      );
      if (!removed) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "member not found",
          }),
          404,
        );
      }
      return c.body(null, 204);
    },
  );

  async function withResolvedContextWindow(
    tenantId: string,
    row: { workbenchId: string; settings: Record<string, unknown> },
  ) {
    const bench = await deps.store.getBenchSettings(tenantId);
    const resolved = resolveContextWindow(
      row.settings,
      benchContextWindowOf(bench?.settings ?? {}),
    );
    return {
      ...workbenchView(row),
      settings: row.settings,
      contextWindow: resolved,
    };
  }

  app.get(
    "/bench/settings",
    deps.requireGrant("workflow-run:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const row = await deps.store.getBenchSettings(tenant.id);
      const settings = row?.settings ?? {};
      return c.json({
        settings,
        contextWindow: benchContextWindowOf(settings),
      });
    },
  );

  app.patch(
    "/bench/settings",
    deps.requireGrant("workflow-run:*", "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");

      let patch: Record<string, unknown>;
      try {
        patch = validateBenchSettingsPatch(
          await c.req.json().catch(() => undefined),
        );
      } catch (err) {
        if (err instanceof SettingsValidationError) {
          return c.json(
            makeErrorEnvelope({
              code: "bad_request",
              userMessage: err.message,
            }),
            400,
          );
        }
        throw err;
      }

      const existing = await deps.store.getBenchSettings(tenant.id);
      const merged = { ...(existing?.settings ?? {}), ...patch };
      const row = await deps.store.upsertBenchSettings({
        tenantId: tenant.id,
        settings: merged,
        updatedBy: principal.id,
      });

      return c.json({
        settings: row.settings,
        contextWindow: benchContextWindowOf(row.settings),
      });
    },
  );

  app.get(
    "/workbenches/:id/settings",
    deps.requireGrant(idResource("workflow-run", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const workbenchId = c.req.param("id");
      const row = await deps.store.getWorkbenchSettings(tenant.id, workbenchId);
      if (row === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      return c.json(await withResolvedContextWindow(tenant.id, row));
    },
  );

  app.patch(
    "/workbenches/:id/settings",
    deps.requireGrant(idResource("workflow-run", "id"), "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");

      const existing = await deps.store.getWorkbenchSettings(
        tenant.id,
        workbenchId,
      );
      if (existing === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }

      let patch: Record<string, unknown>;
      try {
        patch = validateSettingsPatch(
          await c.req.json().catch(() => undefined),
        );
      } catch (err) {
        if (err instanceof SettingsValidationError) {
          return c.json(
            makeErrorEnvelope({
              code: "bad_request",
              userMessage: err.message,
            }),
            400,
          );
        }
        throw err;
      }

      if (
        kindOf(existing.settings) === "chat" &&
        patch["chat/participants"] !== undefined
      ) {
        const refusal = new KindIsChatError();
        return c.json(
          makeErrorEnvelope({
            code: refusal.code,
            userMessage: refusal.message,
          }),
          409,
        );
      }

      // `chat/participants` is normalized to records on write even when
      // a caller PATCHes it with bare addresses (as the settings-control
      // wire path does) — settings always hold records, never strings.
      // Merge happens under a row lock against the live snapshot so a
      // PATCH that omits `chat/participants` cannot revert a concurrent
      // invite.
      const writePatch: Record<string, unknown> = { ...patch };
      if (patch["chat/participants"] !== undefined) {
        writePatch["chat/participants"] = parseParticipants(
          patch["chat/participants"],
        );
      }
      const row = await deps.store.patchWorkbenchSettings({
        tenantId: tenant.id,
        workbenchId,
        patch: writePatch,
        updatedBy: principal.id,
      });

      // The audit trail lives in the anchor's own timeline: fold the
      // patch through the same control/settings logic the old relay
      // workflow used, then post each resulting event part into the
      // anchor's mailbox. A failure here is loud (unhandled), never
      // swallowed, since the timeline is the record of what changed.
      const priorState: WorkbenchParticipantState = {
        participants: participantsOf(existing.settings).map(
          (participant) => participant.address,
        ),
        settings: existing.settings,
      };
      const controlPayloadBase: WorkbenchControlPayload = {
        namespace: WORKBENCH_CONTROL_NAMESPACE,
        settings: patch,
      };
      const controlPayload: WorkbenchControlPayload =
        patch["chat/participants"] !== undefined
          ? {
              ...controlPayloadBase,
              participants: parseParticipants(patch["chat/participants"]).map(
                (participant) => participant.address,
              ),
            }
          : controlPayloadBase;
      const { events } = applyControlPayload(
        priorState,
        controlPayload,
        principal.id,
      );
      for (const event of events) {
        await postRoomMessage(
          { roomMessages: deps.roomMessages, publish },
          {
            tenantId: tenant.id,
            workbenchId,
            sender: { name: null, address: senderAddressOf(c) },
            senderPrincipalId: principal.id,
            parts: [event],
          },
        );
      }

      publish(workbenchId, {
        type: "chat.settings",
        data: { updatedBy: principal.id, settings: row.settings },
      });

      return c.json(await withResolvedContextWindow(tenant.id, row));
    },
  );

  app.get(
    "/workbenches/:id/read-state",
    deps.requireGrant(idResource("room", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");
      const access = await resolveWorkbenchAccess(
        deps,
        tenant.id,
        workbenchId,
        principal.id,
        principal.refId,
      );
      if (access === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      const row = await deps.store.getReadState(
        access.ownerTenantId,
        workbenchId,
        principal.id,
      );
      if (row === undefined) {
        return c.json({ lastSeenCreatedAt: null, lastSeenId: null });
      }
      return c.json({
        lastSeenCreatedAt: row.lastSeenCreatedAt.toISOString(),
        lastSeenId: row.lastSeenId,
      });
    },
  );

  app.put(
    "/workbenches/:id/read-state",
    deps.requireGrant(idResource("room", "id"), "write"),
    async (c) => {
      const body = PutReadStateBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid read-state body: ${body.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");

      const access = await resolveWorkbenchAccess(
        deps,
        tenant.id,
        workbenchId,
        principal.id,
        principal.refId,
      );
      if (access === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }

      const row = await deps.store.putReadState({
        tenantId: access.ownerTenantId,
        workbenchId,
        principalId: principal.id,
        lastSeenCreatedAt: new Date(body.lastSeenCreatedAt),
        lastSeenId: body.lastSeenId,
      });

      return c.json({
        lastSeenCreatedAt: row.lastSeenCreatedAt.toISOString(),
        lastSeenId: row.lastSeenId,
      });
    },
  );

  app.post(
    "/workbenches/:id/typing",
    deps.requireGrant(idResource("room", "id"), "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");
      if (
        (await resolveWorkbenchAccess(
          deps,
          tenant.id,
          workbenchId,
          principal.id,
          principal.refId,
        )) === undefined
      ) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      publish(workbenchId, {
        type: "chat.typing",
        data: { principalId: principal.id },
      });
      return c.body(null, 202);
    },
  );

  // The same idiom `/typing` uses, extended to presence (CL-6328): a
  // client that wants to keep its `lastActiveAt` fresh while its stream
  // sits open (a backgrounded tab, say) pings here rather than polling
  // a heartbeat endpoint. "Here at all" already comes for free from the
  // stream connection itself — see `bridgeWorkbenchStream`'s `presence`
  // option — so this route 404s for a principal with no open
  // connection on this workbench rather than fabricating one.
  app.post(
    "/workbenches/:id/presence",
    deps.requireGrant(idResource("room", "id"), "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");
      if (
        (await resolveWorkbenchAccess(
          deps,
          tenant.id,
          workbenchId,
          principal.id,
          principal.refId,
        )) === undefined
      ) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      const before = presence.snapshot(workbenchId);
      if (!before.some((member) => member.principalId === principal.id)) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "principal has no open stream on this workbench",
          }),
          404,
        );
      }
      presence.ping(workbenchId, principal.id);
      publish(workbenchId, {
        type: "chat.presence",
        data: {
          principalId: principal.id,
          state: "online",
          lastActiveAt: new Date().toISOString(),
        },
      });
      return c.body(null, 202);
    },
  );

  app.get(
    "/workbenches/:id/stream",
    deps.requireGrant(idResource("room", "id"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");
      if (
        (await resolveWorkbenchAccess(
          deps,
          tenant.id,
          workbenchId,
          principal.id,
          principal.refId,
        )) === undefined
      ) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }

      return streamSSE(c, async (stream) => {
        const { teardown, closed } = bridgeWorkbenchStream({
          registry,
          platform: platformEvents,
          workbenchId,
          stream,
          authorize: () =>
            resolveWorkbenchAccess(
              deps,
              tenant.id,
              workbenchId,
              principal.id,
              principal.refId,
            ).then((access) => access !== undefined),
          presence: { registry: presence, principalId: principal.id },
        });
        stream.onAbort(teardown);
        await closed;
      });
    },
  );

  // The turn projection (CL-6329): what makes a reply traceable back to
  // the child run that produced it, served from our own rows rather than
  // the execution plane's.
  app.get(
    "/workbenches/:id/turns",
    deps.requireGrant(idResource("room", "id"), "read"),
    async (c) => {
      if (deps.agentTurns === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "turn history not available",
          }),
          404,
        );
      }
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");
      const access = await resolveWorkbenchAccess(
        deps,
        tenant.id,
        workbenchId,
        principal.id,
        principal.refId,
      );
      if (access === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      const items = await deps.agentTurns.listTurns({
        tenantId: access.ownerTenantId,
        workbenchId,
      });
      return c.json({ items });
    },
  );

  // CL-7201: the escape hatch for a wedged or wrongly-guessed turn — the
  // only bound before this route existed was the dispatch/wait-until-free
  // timeouts, measured in minutes. Write, not read: cancelling changes
  // the workbench's state, exactly like posting a message does.
  app.post(
    "/workbenches/:id/turns/cancel",
    deps.requireGrant(idResource("room", "id"), "write"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");
      const access = await resolveWorkbenchAccess(
        deps,
        tenant.id,
        workbenchId,
        principal.id,
        principal.refId,
      );
      if (access === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      const result = await cancelWorkbenchTurn(
        {
          turnCancellation,
          roomMessages: deps.roomMessages,
          publish,
          ...(deps.agentTurns !== undefined
            ? { agentTurns: deps.agentTurns }
            : {}),
        },
        { tenantId: access.ownerTenantId, workbenchId },
      );
      return c.json(result);
    },
  );

  app.get(
    "/workbenches/:id/turns/:turnId",
    deps.requireGrant(idResource("room", "id"), "read"),
    async (c) => {
      if (deps.agentTurns === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "turn history not available",
          }),
          404,
        );
      }
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const workbenchId = c.req.param("id");
      const access = await resolveWorkbenchAccess(
        deps,
        tenant.id,
        workbenchId,
        principal.id,
        principal.refId,
      );
      if (access === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "workbench not found",
          }),
          404,
        );
      }
      const turn = await deps.agentTurns.getTurn({
        tenantId: access.ownerTenantId,
        turnId: c.req.param("turnId"),
      });
      if (turn === undefined || turn.workbenchId !== workbenchId) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: "turn not found",
          }),
          404,
        );
      }
      // Only a still-running turn gets a catch-up snapshot attached — a
      // settled turn's reply already lives in the timeline as an ordinary
      // message, and re-deriving its text here would just duplicate it.
      const textSnapshot =
        turn.status === "running" && deps.turnTextSnapshot !== undefined
          ? await deps.turnTextSnapshot({
              tenantId: access.ownerTenantId,
              runId: turn.childRunId,
            })
          : null;
      return c.json({ ...turn, textSnapshot });
    },
  );

  return app;
}
