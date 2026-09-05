// Renders a workbench's `MessageItem[]` oldest→newest: text parts as chat
// bubbles, event parts as inline system lines, block parts through the
// generative-UI block registry, everything else as a labeled fallback
// block. `sender` is an optional field on `MessageItem` (see
// api.ts) — a bubble never shows a raw address or instance/principal id: the
// signed-in user's own messages render as "You" (or their name, from
// `currentUser`), a sender matching a participant record renders by that
// record's mention handle (with a visible agent badge when the address is
// an agent address), and anything else falls back to a deterministic
// "Member" label with an initials avatar — never the address.

import { isAgentAddress } from "@corbits/chat/mentions";
import {
  ContextMenuView,
  contextMenuItem,
  isContextMenuEmpty,
  useContextMenuState,
} from "@corbits/context-menu";
import type { ContextMenu, ContextMenuEntry } from "@corbits/context-menu";
import {
  Avatar,
  Button,
  EmptyState,
  PartsRenderer,
  toast,
} from "@corbits/react-ui";
import { toReactUiReasoning } from "./agent-part-adapter";
import {
  displayNameForAddress,
  type AgentDisplayNames,
} from "./agent-display-names";
import { CorbitAvatar, avatarClassForPrincipal } from "./avatar";
import { groupTimelineParts } from "./tool-activity";
import { ToolActivityGroup } from "./tool-activity-view";
import {
  ArrowBendUpLeft,
  ArrowDown,
  ChatCircle,
  Clock,
  Copy,
  DotsThree,
  PencilSimple,
  PushPin,
  PushPinSlash,
  Smiley,
} from "@corbits/icons";
import { memo } from "react";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

import type {
  MessageItem,
  MessageSender,
  ParticipantRecord,
  Part,
  ReactionSummary,
} from "./api";
import { REACTION_EMOJI } from "./api";
import { ArtifactChip } from "./artifact-chip";
import type { ApprovalActions } from "./blocks/approval-actions";
import type { BlockResponseActions } from "./blocks/block-responses";
import type { ConnectGithubActions } from "./blocks/connect-github-actions";
import type { ConnectServiceActions } from "./blocks/connect-service-actions";
import { BlockPartView } from "./blocks/registry";
import {
  CONSUMER_INFERENCE_FAILURE_NOTICE,
  consumerFacingInferenceText,
  isClassifiedInferenceFailureText,
} from "./inference-failure";
import { WorkbenchLoadingState } from "./loading-state";
import { Markdown } from "./markdown";
import type { ProfileSubject } from "./profile-subject";
import { profileSubjectFromParticipant } from "./profile-subject";
import { formatRelativeActivity } from "./relative-time";
import { CHAT_STRINGS } from "./strings";
import type { FailedTurnModelChoice } from "./failed-turn-models";

/**
 * Which affordance a message's thread row offers:
 * - `"reply"` (root feed) — open/create the depth-1 thread for this message
 * - `"fork"` (inside an open thread) — spawn a sub-thread rooted at this
 *   message, the first-class fork affordance from CL-5948 ("something
 *   Slack doesn't have"). The two-level cap is enforced server-side; this
 *   UI never needs to reason about depth itself.
 *
 * No `@corbits/context-menu` message target exists yet (see
 * `apps/web/src/shell/context-menu/targets.ts`) — this row is the
 * fallback surface for both actions until that seam is wired for
 * messages.
 */
export type ThreadAffordanceMode = "reply" | "fork";

/**
 * The reaction chip row's live round-trip — the host's toggle against
 * `@corbits/chat`'s reaction routes, mirroring how `blockResponses`
 * threads the poll/form round-trip down to its card. Undefined renders
 * no reaction affordance at all (no chips, no "add reaction" trigger),
 * the same "no port, no feature" contract every other optional action
 * on this timeline follows.
 */
export type ReactionActions = {
  readonly onToggle: (messageId: string, emoji: string) => void;
};

/** The pin/unpin round-trip a message's hover row offers — undefined
 * renders no pin affordance at all. */
export type PinActions = {
  readonly onPin: (messageId: string) => void;
  readonly onUnpin: (messageId: string) => void;
};

/** The DOM id a message's group renders under — the pinned strip's
 * jump-to-message target (`document.getElementById`). Exported so the
 * host never has to hand-guess the id format. */
export function messageDomId(messageId: string): string {
  return `chat-message-${messageId}`;
}

/**
 * `"sending"` while the host's real request is in flight, `"failed"` once
 * it has rejected. There is no `"sent"` state here — a successful send
 * simply stops being a pending item once the host's next message load
 * folds the real, server-issued message into `items` in its place.
 */
export type PendingMessageStatus = "sending" | "failed";

/**
 * A message this host has optimistically added to the timeline before
 * (or instead of, on failure) the server confirms it — see
 * `WorkbenchTimeline`'s `items` doc. `nonce` is the host's own client-side
 * key, round-tripped back through `PendingActions` so a retry/discard
 * always targets the exact pending entry the reader acted on, never a
 * position in an array that may have reflowed underneath it.
 */
export type TimelineMessageItem = MessageItem & {
  readonly pendingStatus?: PendingMessageStatus;
  readonly pendingNonce?: string;
  /** Set on the one synthetic item `mergeStreamingReply`
   * (`chat-workspace.tsx`) folds onto the end of the timeline while an
   * agent turn is mid-flight — its text grows as `inference.text.delta`
   * events arrive and the item disappears the moment the turn ends, see
   * `useStreamingReply` (`streaming-reply.ts`). Distinct from
   * `pendingStatus`, which is this reader's own optimistic send: a
   * streaming item is the *other* side's in-progress reply, rendered
   * without a hover toolbar, reactions, or pin toggle — none of which make
   * sense against a message with no server-issued id yet. */
  readonly streaming?: boolean;
};

/** The retry/discard round-trip a failed pending bubble's inline actions
 * offer — the host owns both: retry re-sends the same content, discard
 * drops the pending entry and hands its text back to the composer. */
export type PendingActions = {
  readonly onRetry: (nonce: string) => void;
  readonly onDiscard: (nonce: string) => void;
};

export type CurrentUser = {
  /**
   * The signed-in principal's id. A sender address's local part IS the
   * sending principal's id (the platform builds From as
   * `<principalId>@<tenant domain>`), so matching on the local part lets
   * hosts identify "you" without knowing the tenant's mail domain.
   */
  readonly principalId: string;
  readonly name?: string;
  /**
   * A handle/email fallback for the own-message avatar's initial when no
   * `name` is set — never shown as the "You" label itself, only used to
   * derive a single honest initial (see `ownAvatarInitials`) instead of
   * running `initialsOf` over the literal word "You".
   */
  readonly handle?: string;
};

/** Fallback glyph for an own-message avatar with no name and no handle to
 * derive an initial from — never a guess, never "YO" from the "You" label
 * itself. */
const UNKNOWN_INITIAL = "•";

/**
 * The signed-in reader's own avatar initials: `currentUser.name`'s real
 * initials when set, else the first letter of `currentUser.handle`
 * (a mention handle or email — whichever the host had on hand), else
 * `UNKNOWN_INITIAL`. Deliberately never derived from the "You" label
 * itself — `initialsOf("You")` reads as "YO", a fabricated pair of
 * letters with no relationship to the actual signed-in person.
 */
function ownAvatarInitials(currentUser: CurrentUser): string {
  if (currentUser.name !== undefined && currentUser.name.trim().length > 0) {
    return initialsOf(currentUser.name);
  }
  const handle = currentUser.handle?.trim();
  if (handle !== undefined && handle.length > 0) {
    return handle.charAt(0).toUpperCase();
  }
  return UNKNOWN_INITIAL;
}

export function localPartOf(address: string): string {
  const at = address.indexOf("@");
  return at === -1 ? address : address.slice(0, at);
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * "Today" / "Yesterday" for the two nearby cases, otherwise a medium-length
 * date ("Jan 3, 2026") — never a raw ISO string.
 */
function formatDayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const now = new Date();
  if (isSameCalendarDay(date, now)) return CHAT_STRINGS.dayDividerToday;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameCalendarDay(date, yesterday))
    return CHAT_STRINGS.dayDividerYesterday;

  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Two-letter initials for an avatar, derived only from a friendly string
 * already safe to show (a name, a handle, or one of the fallback labels)
 * — never from a raw address or id.
 */
function initialsOf(source: string): string {
  const words = source
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return "?";
  const first = words[0]?.charAt(0) ?? "";
  const second =
    words.length > 1
      ? (words[1]?.charAt(0) ?? "")
      : (words[0]?.charAt(1) ?? "");
  const initials = `${first}${second}`.toUpperCase();
  return initials.length > 0 ? initials : "?";
}

/**
 * A friendly display name from a mention handle — "myra" -> "Myra",
 * "echo-bot" -> "Echo Bot" — for the rare spots (like the join event
 * line) that only have a participant's slugified handle to work with,
 * never a `sender.name`. Never applied to a handle already shown as a
 * literal `@mention` elsewhere.
 */
export function displayNameFromHandle(handle: string): string {
  return handle
    .split(/[-_]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

type SenderDisplay = {
  readonly label: string;
  /** The participant's mention handle, when it differs from `label` — a
   * matched participant's `sender.name` (e.g. "Myra") is what the header
   * shows now, with the handle (e.g. "myra") surfaced only as a tooltip
   * rather than lost outright. */
  readonly handle?: string;
  readonly isAgent: boolean;
  readonly initials: string;
  /** The wire address behind this sender — never shown, only used to pick
   * a stable per-person fallback color for a human's avatar. */
  readonly id: string;
};

function senderDisplay(
  sender: MessageSender | undefined,
  participants: readonly ParticipantRecord[],
  currentUser: CurrentUser | undefined,
  displayNames?: AgentDisplayNames,
): SenderDisplay | undefined {
  if (sender === undefined) return undefined;

  if (
    currentUser !== undefined &&
    localPartOf(sender.address) === currentUser.principalId
  ) {
    const label = currentUser.name ?? CHAT_STRINGS.senderYou;
    return {
      label,
      isAgent: false,
      initials: ownAvatarInitials(currentUser),
      id: currentUser.principalId,
    };
  }

  const matched = participants.find(
    (participant) => participant.address === sender.address,
  );
  if (matched !== undefined) {
    const isAgent = isAgentAddress(matched.address);
    const senderName = sender.name;
    const wireName =
      senderName !== null && senderName.trim().length > 0
        ? senderName
        : undefined;
    // An agent renders its resolved display name (CL-6424) — the wire
    // name when the server sent one, else the `/agents` snapshot's — and
    // only then falls back to a human reading of its handle ("myra" ->
    // "Myra"). The raw @handle is a wire identifier, kept to the tooltip
    // only.
    const resolvedName =
      isAgent === true
        ? (displayNameForAddress(matched.address, displayNames) ?? wireName)
        : wireName;
    const label =
      resolvedName ??
      (isAgent ? displayNameFromHandle(matched.handle) : matched.handle);
    return {
      label,
      handle: matched.handle,
      isAgent,
      initials: initialsOf(resolvedName ?? matched.handle),
      id: matched.address,
    };
  }

  if (sender.name !== null && sender.name.trim().length > 0) {
    return {
      label: sender.name,
      isAgent: false,
      initials: initialsOf(sender.name),
      id: sender.address,
    };
  }

  return {
    label: CHAT_STRINGS.senderFallbackMember,
    isAgent: false,
    initials: "?",
    id: sender.address,
  };
}

function SenderAvatar({
  id,
  initials,
  label,
  isAgent,
  tenantMonogram,
  tenantName,
}: {
  id: string;
  initials: string;
  label: string;
  isAgent: boolean;
  tenantMonogram?: string;
  tenantName?: string;
}) {
  return (
    <span className="sender-avatar-wrap" title={label}>
      {isAgent ? (
        <CorbitAvatar ariaLabel={label} size="md" className="sender-avatar" />
      ) : (
        <Avatar
          initials={initials}
          label={label}
          tone="neutral"
          size="md"
          className={`sender-avatar ${avatarClassForPrincipal(id)}`}
        />
      )}
      {tenantMonogram !== undefined ? (
        <span
          className="chat-sender-tenant-badge"
          title={tenantName}
          aria-hidden="true"
        >
          {tenantMonogram}
        </span>
      ) : null}
    </span>
  );
}

export function AgentBadge() {
  return (
    <span className="chat-agent-badge">{CHAT_STRINGS.agentBadgeLabel}</span>
  );
}

/** The one visible cue a message this reader just sent is still in
 * flight — reuses the muted-foreground token every other quiet status
 * glyph in this file already sits on, never a bespoke color. */
function PendingGlyph() {
  return (
    <span
      className="chat-pending-glyph"
      aria-label={CHAT_STRINGS.pendingSendLabel}
      title={CHAT_STRINGS.pendingSendLabel}
    >
      <Clock aria-hidden="true" />
    </span>
  );
}

function TextBubble({
  text,
  createdAt,
  sender,
  participants,
  currentUser,
  onOpenProfile,
  onFixConnection,
  showHeader = true,
  pendingStatus,
  pendingNonce,
  pendingActions,
  agentDisplayNames,
}: {
  text: string;
  createdAt: string;
  sender: MessageSender | undefined;
  participants: readonly ParticipantRecord[];
  currentUser: CurrentUser | undefined;
  /** Resolved agent display names (CL-6424) — the message header shows
   * these, never the raw handle slug. */
  readonly agentDisplayNames?: AgentDisplayNames;
  onOpenProfile?: (subject: ProfileSubject) => void;
  onFixConnection?: () => void;
  /** `false` when this bubble continues an unbroken run of messages from
   * the same author (see `isGroupedWithPrevious`) — the avatar and
   * name/timestamp header collapse to a hover-revealed timestamp in the
   * avatar gutter instead, matching the compact grouped-message pattern
   * modern chat UIs use rather than repeating the header on every line. */
  showHeader?: boolean;
  /** Set while this reader's own send is still in flight or has failed
   * (CL-6251/CL-5879) — the bubble renders exactly like any confirmed
   * message; `"sending"` only adds `PendingGlyph` next to the timestamp,
   * `"failed"` appends `PendingFailedRow` inside this same bubble, never
   * a different layout. */
  pendingStatus?: PendingMessageStatus;
  /** The failed bubble's own retry/discard target — see `PendingActions`.
   * Only read when `pendingStatus === "failed"`. */
  pendingNonce?: string;
  pendingActions?: PendingActions;
}) {
  const consumerText = consumerFacingInferenceText(text);
  const display = senderDisplay(
    sender,
    participants,
    currentUser,
    agentDisplayNames,
  );
  const isOwn =
    currentUser !== undefined &&
    sender !== undefined &&
    localPartOf(sender.address) === currentUser.principalId;
  const matched =
    sender === undefined
      ? undefined
      : participants.find(
          (participant) => participant.address === sender.address,
        );
  const profileSubject =
    matched !== undefined ? profileSubjectFromParticipant(matched) : null;

  function handleOpenProfile() {
    if (profileSubject !== null && onOpenProfile !== undefined) {
      onOpenProfile(profileSubject);
    }
  }

  return (
    <div
      className="chat-bubble-row"
      data-own={isOwn}
      data-grouped={!showHeader}
    >
      {showHeader && display !== undefined && (
        <button
          type="button"
          className="sender-avatar-button"
          aria-label={`${CHAT_STRINGS.profileOpenAction}: ${display.label}`}
          disabled={profileSubject === null || onOpenProfile === undefined}
          onClick={handleOpenProfile}
        >
          <SenderAvatar
            id={display.id}
            initials={display.initials}
            label={display.label}
            isAgent={display.isAgent}
            {...(sender?.tenantMonogram !== undefined
              ? { tenantMonogram: sender.tenantMonogram }
              : {})}
            {...(sender?.tenantName !== undefined
              ? { tenantName: sender.tenantName }
              : {})}
          />
        </button>
      )}
      <div className="chat-bubble" data-pending={pendingStatus}>
        {showHeader ? (
          <div className="chat-bubble-head">
            {display !== undefined && (
              <button
                type="button"
                className="chat-bubble-sender-button"
                disabled={
                  profileSubject === null || onOpenProfile === undefined
                }
                onClick={handleOpenProfile}
              >
                <span
                  className="chat-bubble-sender"
                  {...(display.handle !== undefined &&
                  display.handle !== display.label
                    ? { title: `@${display.handle}` }
                    : {})}
                >
                  {display.label}
                  {display.isAgent && <AgentBadge />}
                </span>
              </button>
            )}
            <span className="chat-bubble-time">
              {formatTimestamp(createdAt)}
            </span>
            {pendingStatus === "sending" ? <PendingGlyph /> : null}
          </div>
        ) : (
          <>
            <span className="chat-bubble-time-grouped">
              {formatTimestamp(createdAt)}
            </span>
            {pendingStatus === "sending" ? <PendingGlyph /> : null}
          </>
        )}
        <div className="chat-bubble-text">
          <Markdown text={consumerText} />
        </div>
        {onFixConnection !== undefined &&
          (isClassifiedInferenceFailureText(text) ||
            consumerText === CONSUMER_INFERENCE_FAILURE_NOTICE) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="chat-bubble-fix-connection"
              onClick={onFixConnection}
            >
              {CHAT_STRINGS.fixConnectionAction}
            </Button>
          )}
        {pendingStatus === "failed" && pendingActions !== undefined ? (
          <PendingFailedRow
            nonce={pendingNonce ?? ""}
            pendingActions={pendingActions}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * A friendly system line for an event part — never the raw event string on
 * its own and never any address or id out of `part.data`. Known event kinds
 * get a specific line (looking up the matching participant's handle for
 * "workbench.agent-joined" rather than showing the joined agent's address);
 * anything else falls back to the event name with its separators turned
 * into spaces.
 */
/**
 * The display name a "workbench.agent-joined" event carries, resolved the
 * friendly way: the roster's own handle for that address when the roster
 * knows it, else the address's own local part — never the raw address, and
 * never the generic "An agent joined", which hides a name the event
 * already carries. Undefined only when the event names nobody.
 */
function joinedAgentName(
  part: Part & { kind: "event" },
  participants: readonly ParticipantRecord[],
  displayNames?: AgentDisplayNames,
): string | undefined {
  const data =
    typeof part.data === "object" && part.data !== null
      ? (part.data as Record<string, unknown>)
      : undefined;
  const address =
    data !== undefined && typeof data.address === "string"
      ? data.address
      : undefined;
  if (address === undefined) return undefined;
  const resolved = displayNameForAddress(address, displayNames);
  if (resolved !== undefined) return resolved;
  const handle =
    participants.find((participant) => participant.address === address)
      ?.handle ?? localPartOf(address);
  return displayNameFromHandle(handle);
}

export function friendlyEventText(
  part: Part & { kind: "event" },
  participants: readonly ParticipantRecord[],
  displayNames?: AgentDisplayNames,
): string {
  const data =
    typeof part.data === "object" && part.data !== null
      ? (part.data as Record<string, unknown>)
      : undefined;
  switch (part.event) {
    case "workbench.agent-joined": {
      const name = joinedAgentName(part, participants, displayNames);
      return name !== undefined
        ? CHAT_STRINGS.eventAgentJoined(name)
        : CHAT_STRINGS.eventAgentJoinedUnknown;
    }
    case "workbench.membership-changed":
      return CHAT_STRINGS.eventMembershipChanged;
    case "workbench.settings-changed": {
      const changed =
        data !== undefined &&
        typeof data.changed === "object" &&
        data.changed !== null
          ? (data.changed as Record<string, unknown>)
          : undefined;
      const previous =
        data !== undefined &&
        typeof data.previous === "object" &&
        data.previous !== null
          ? (data.previous as Record<string, unknown>)
          : undefined;
      const to = changed?.["chat/name"];
      if (
        changed !== undefined &&
        Object.keys(changed).length === 1 &&
        typeof to === "string"
      ) {
        const from = previous?.["chat/name"];
        return typeof from === "string" && from !== to
          ? CHAT_STRINGS.eventWorkbenchRenamed(from, to)
          : CHAT_STRINGS.eventWorkbenchRenamedTo(to);
      }
      return CHAT_STRINGS.eventSettingsChanged;
    }
    case "block.response": {
      const kind = data !== undefined ? data.kind : undefined;
      return kind === "poll"
        ? CHAT_STRINGS.eventBlockResponsePoll
        : CHAT_STRINGS.eventBlockResponseForm;
    }
    case "connection.connected": {
      const displayName =
        data !== undefined && typeof data.displayName === "string"
          ? data.displayName
          : undefined;
      return displayName !== undefined
        ? CHAT_STRINGS.eventConnectionConnected(displayName)
        : CHAT_STRINGS.eventGeneric(part.event);
    }
    default:
      return CHAT_STRINGS.eventGeneric(part.event);
  }
}

function EventLine({
  part,
  createdAt,
  participants,
  collapsedText,
  agentDisplayNames,
}: {
  part: Part & { kind: "event" };
  createdAt: string;
  participants: readonly ParticipantRecord[];
  /** The one line that stands in for a whole run of consecutive joins —
   * see `collapseAgentJoinRuns`. Undefined on every other event row. */
  collapsedText?: string;
  readonly agentDisplayNames?: AgentDisplayNames;
}) {
  const data =
    typeof part.data === "object" && part.data !== null
      ? (part.data as Record<string, unknown>)
      : undefined;
  const connectedDisplayName =
    part.event === "connection.connected" &&
    data !== undefined &&
    typeof data.displayName === "string"
      ? data.displayName
      : undefined;

  return (
    <div className="chat-event-line">
      <span>
        {collapsedText !== undefined ? (
          collapsedText
        ) : connectedDisplayName !== undefined ? (
          <>
            {CHAT_STRINGS.eventConnectionConnectedBeforePlugins(
              connectedDisplayName,
            )}
            <a href="/plugins">
              {CHAT_STRINGS.eventConnectionConnectedPlugins}
            </a>
          </>
        ) : (
          friendlyEventText(part, participants, agentDisplayNames)
        )}
      </span>
      <span className="chat-event-time">{formatTimestamp(createdAt)}</span>
    </div>
  );
}

/**
 * Host-supplied recovery for a model-unavailable failed turn: tenant
 * chat models for the inline picker, the workbench's agent definition
 * ids, apply (write the capability + refresh) and a real Settings hop.
 */
export type FailedTurnRecovery = {
  readonly models: readonly FailedTurnModelChoice[];
  /** Tool-capable subset for a tools-unsupported recovery. Empty means
   * the strip still hops to Settings, with no inline picker. */
  readonly toolCapableModels?: readonly FailedTurnModelChoice[];
  readonly definitionIdByAddress: Readonly<Record<string, string>>;
  readonly onApplyModel: (input: {
    readonly definitionId: string;
    readonly address: string;
    readonly canonicalName: string;
  }) => void | Promise<void>;
  readonly onOpenAgentSettings: (definitionId: string) => void;
};

/**
 * The general chat timeline's failed-turn treatment (CL-6332, redesigned
 * CL-6376 to match the timeline's own idiom rather than borrow
 * `PrFailedTurnStrip`'s bordered banner — that component stays as-is for
 * the PR-review surface it was built for, but reusing it here read as a
 * floating alert dropped mid-conversation). A text part
 * `postUndeliveredNotice` posted in its unreachable agent's own voice
 * (`part.turnFailed`) now renders as a quiet inline system row, aligned
 * under the same left gutter every message bubble sits under: muted
 * danger-tinted copy, a small ghost Retry button, and "What happened" as
 * a subtle inline disclosure rather than a second button competing for
 * attention. A named-recovery notice (`turnFailedReason`) replaces
 * Retry with an inline model picker and a real Settings hop.
 * `onRetry`/`onWhatHappened` are the host's own actions; a
 * host that wires neither still gets the row, just with inert controls —
 * matching the fixed-disabled framing every other undefined-action port
 * in this file already falls back to.
 */
function FailedTurnStrip({
  item,
  detailText,
  retryText,
  namedRecovery,
  participants,
  currentUser,
  failedTurnRecovery,
  onRetryFailedTurn,
  onWhatHappenedFailedTurn,
  agentDisplayNames,
}: {
  readonly item: TimelineMessageItem;
  /** Resolved agent display names (CL-6424) — the strip names the agent
   * whose turn failed, never its raw handle slug. */
  readonly agentDisplayNames?: AgentDisplayNames;
  /** The undelivered-turn notice's own text (`postUndeliveredNotice`,
   * `@corbits/chat`) — already cause-aware server-side (a missing model
   * credential reads "add or check your model key," a generic dispatch
   * failure reads "send it again"). Shown as this strip's own detail
   * rather than the fixed `turnFailedSub` string, so the person reads
   * the real diagnosis instead of a guess. Falls back to `turnFailedSub`
   * only when the notice carries no text at all. */
  readonly detailText: string;
  /** The original message this turn never answered, recovered by
   * `findRetryText` — handed to `onRetryFailedTurn` so Retry has
   * something to resend rather than nothing. */
  readonly retryText?: string;
  readonly namedRecovery?: "model_unavailable" | "tools_unsupported";
  readonly participants: readonly ParticipantRecord[];
  readonly currentUser: CurrentUser | undefined;
  readonly failedTurnRecovery?: FailedTurnRecovery;
  readonly onRetryFailedTurn?: (
    item: TimelineMessageItem,
    retryText?: string,
  ) => void | Promise<void>;
  readonly onWhatHappenedFailedTurn?: (item: TimelineMessageItem) => void;
}) {
  const display = senderDisplay(
    item.sender,
    participants,
    currentUser,
    agentDisplayNames,
  );
  const sender = display?.label ?? CHAT_STRINGS.senderFallbackMember;
  const consumerDetail = consumerFacingInferenceText(detailText);
  const [expanded, setExpanded] = useState(false);
  // Guards the resend itself against a double-click firing two sends —
  // not composer state, since Retry never touches the composer any more.
  const [retrying, setRetrying] = useState(false);
  const definitionId =
    failedTurnRecovery?.definitionIdByAddress[item.sender.address];

  if (namedRecovery !== undefined) {
    const recoveryTitle =
      namedRecovery === "tools_unsupported"
        ? CHAT_STRINGS.turnFailedToolsUnsupported(sender)
        : CHAT_STRINGS.turnFailedModelUnavailable(sender);
    const pickerModels =
      namedRecovery === "tools_unsupported"
        ? (failedTurnRecovery?.toolCapableModels ?? [])
        : (failedTurnRecovery?.models ?? []);
    return (
      <div className="chat-turn-failed" role="status">
        <span className="chat-turn-failed-text">{recoveryTitle}</span>
        {failedTurnRecovery !== undefined &&
        definitionId !== undefined &&
        pickerModels.length > 0 ? (
          <select
            className="chat-turn-failed-models"
            aria-label={CHAT_STRINGS.turnFailedPickModel}
            disabled={retrying}
            defaultValue=""
            onChange={async (event) => {
              const canonicalName = event.target.value;
              if (canonicalName === "" || retrying) return;
              setRetrying(true);
              try {
                await failedTurnRecovery.onApplyModel({
                  definitionId,
                  address: item.sender.address,
                  canonicalName,
                });
                await onRetryFailedTurn?.(item, retryText);
              } finally {
                setRetrying(false);
              }
            }}
          >
            <option value="" disabled>
              {CHAT_STRINGS.turnFailedPickModel}
            </option>
            {pickerModels.map((model) => (
              <option key={model.canonicalName} value={model.canonicalName}>
                {model.label}
              </option>
            ))}
          </select>
        ) : null}
        {failedTurnRecovery !== undefined && definitionId !== undefined ? (
          <button
            type="button"
            className="chat-turn-failed-settings"
            onClick={() => failedTurnRecovery.onOpenAgentSettings(definitionId)}
          >
            {CHAT_STRINGS.turnFailedMoreInSettings}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="chat-turn-failed" role="status">
      <span className="chat-turn-failed-text">
        {CHAT_STRINGS.turnFailedTitle(sender)}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="chat-turn-failed-retry"
        disabled={retrying}
        onClick={() => {
          if (retrying) return;
          setRetrying(true);
          void Promise.resolve(onRetryFailedTurn?.(item, retryText)).finally(
            () => setRetrying(false),
          );
        }}
      >
        {CHAT_STRINGS.prThreadRetryAction}
      </Button>
      <button
        type="button"
        className="chat-turn-failed-disclosure"
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((open) => !open);
          onWhatHappenedFailedTurn?.(item);
        }}
      >
        {CHAT_STRINGS.prThreadWhatHappenedAction}
      </button>
      {expanded ? (
        <span className="chat-turn-failed-detail">
          {consumerDetail.length > 0
            ? consumerDetail
            : CHAT_STRINGS.turnFailedSub}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The cancelled-turn counterpart to `FailedTurnStrip` (CL-7201) — same
 * quiet inline placement, deliberately simpler: no Retry (the user
 * chose to stop this; resending is just typing again, not recovering
 * from an error) and no disclosure, since `postCancelledNotice`'s own
 * text ("This turn was cancelled.") is the whole story — there is no
 * hidden diagnosis to expand into, unlike a failure's cause.
 */
function CancelledTurnStrip({
  item,
  participants,
  currentUser,
  agentDisplayNames,
}: {
  readonly item: TimelineMessageItem;
  readonly participants: readonly ParticipantRecord[];
  readonly currentUser: CurrentUser | undefined;
  readonly agentDisplayNames?: AgentDisplayNames;
}) {
  const display = senderDisplay(
    item.sender,
    participants,
    currentUser,
    agentDisplayNames,
  );
  const sender = display?.label ?? CHAT_STRINGS.senderFallbackMember;
  return (
    <div className="chat-turn-cancelled" role="status">
      <span>{CHAT_STRINGS.turnCancelledTitle(sender)}</span>
    </div>
  );
}

/**
 * The nearest message before a failed-turn notice sent by someone other
 * than the unreachable agent itself — the request that notice answered.
 * `postUndeliveredNotice` posts the notice from that agent's own address
 * right after the dispatch it was answering, so walking backward from
 * the notice to the first message from a different sender finds that
 * request without the wire needing to carry an explicit back-reference.
 * Undefined when nothing precedes it (a notice at the very top of what's
 * loaded) — Retry then has nothing to hand back, same as before this
 * existed.
 */
export function findRetryText(
  items: readonly TimelineMessageItem[],
  failedItem: TimelineMessageItem,
): string | undefined {
  const index = items.findIndex((candidate) => candidate.id === failedItem.id);
  if (index === -1) return undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = items[i];
    if (candidate === undefined) continue;
    if (candidate.sender.address === failedItem.sender.address) continue;
    const text = candidate.parts
      .filter((part): part is Part & { kind: "text" } => part.kind === "text")
      .map((part) => part.text)
      .join("");
    return text.length > 0 ? text : undefined;
  }
  return undefined;
}

function FallbackPart({ part }: { part: Part }) {
  return (
    <div className="chat-fallback-block">
      <span className="chat-fallback-label">
        {CHAT_STRINGS.fallbackPartLabel(part.kind)}
      </span>
      <span className="chat-fallback-body">
        {CHAT_STRINGS.fallbackPartUnsupported}
      </span>
    </div>
  );
}

/**
 * A file part shows only its name and media type — never the base64 payload
 * or blob id, which are transport details rather than something a reader
 * should see in the timeline. Rendered as the mock's artifact chip; see
 * `artifact-chip.tsx` for when it opens versus stays inert.
 */
function FilePartView({
  part,
  onOpenArtifact,
  onOpenArtifactInLibrary,
}: {
  part: Part & { kind: "file" };
  onOpenArtifact?: (part: Part & { kind: "file" }) => void;
  onOpenArtifactInLibrary?: (part: Part & { kind: "file" }) => void;
}) {
  return (
    <ArtifactChip
      part={part}
      {...(onOpenArtifact !== undefined ? { onOpen: onOpenArtifact } : {})}
      {...(onOpenArtifactInLibrary !== undefined
        ? { onOpenInLibrary: onOpenArtifactInLibrary }
        : {})}
    />
  );
}

function DayDivider({ createdAt }: { createdAt: string }) {
  return (
    <div className="chat-day-divider">
      <span>{formatDayLabel(createdAt)}</span>
    </div>
  );
}

/**
 * The reaction chip row: every emoji with at least one reactor renders as a
 * chip (count + reacted-state). Renders nothing when there are no reactions
 * — the "add a reaction" affordance itself lives in `MessageHoverToolbar`
 * now, not here, so a message with zero reactions shows no chip row at all
 * until hovered.
 */
function ReactionChips({
  messageId,
  reactions,
  reactionActions,
}: {
  readonly messageId: string;
  readonly reactions: readonly ReactionSummary[];
  readonly reactionActions: ReactionActions;
}) {
  if (reactions.length === 0) return null;
  return (
    <div className="chat-reaction-row">
      {reactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          className="chat-reaction-chip"
          data-reacted={reaction.reactedByMe}
          aria-pressed={reaction.reactedByMe}
          aria-label={CHAT_STRINGS.reactionChipLabel(
            reaction.emoji,
            reaction.count,
          )}
          onClick={() => reactionActions.onToggle(messageId, reaction.emoji)}
        >
          <span aria-hidden="true">{reaction.emoji}</span>
          <span className="chat-reaction-chip-count">{reaction.count}</span>
        </button>
      ))}
    </div>
  );
}

async function copyMessageText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(CHAT_STRINGS.copyTextCopiedToast);
  } catch {
    toast(CHAT_STRINGS.copyTextError);
  }
}

export function messageText(item: MessageItem): string {
  return item.parts
    .filter((part): part is Part & { kind: "text" } => part.kind === "text")
    .map((part) => part.text)
    .join("\n");
}

/**
 * Whether a timeline row should expose message social chrome (CL-6739) —
 * add-reaction, reply-in-thread, overflow/ellipsis, reaction chips, and the
 * thread-summary affordance. System event lines, failed-turn strips,
 * connect cards, and classified inference-failure bubbles are not
 * conversational messages; reacting to "Scout joined" or pinning a
 * connect-github card is noise. Fix-this-connection recovery on a
 * classified failure lives on the bubble itself (`TextBubble`) and is
 * independent of this gate.
 */
export function offersMessageSocialChrome(item: MessageItem): boolean {
  if (item.parts.length === 0) return false;
  return !item.parts.every((part) => {
    if (part.kind === "event") return true;
    if (part.kind === "text" && part.turnFailed === true) return true;
    if (part.kind === "text" && part.turnCancelled === true) return true;
    if (
      part.kind === "text" &&
      (isClassifiedInferenceFailureText(part.text) ||
        part.text === CONSUMER_INFERENCE_FAILURE_NOTICE)
    ) {
      return true;
    }
    if (part.kind === "block") {
      return (
        part.block.type === "connect-github" ||
        part.block.type === "connect-service"
      );
    }
    return false;
  });
}

/**
 * System notices (event-only rows) are never "own" for any viewer —
 * DESIGN.md Message Alignment and CL-6772. Join / rename / membership
 * lines often carry the acting principal as `sender`, but they still
 * align left; treating them as own put them on the signed-in user's
 * right edge.
 */
export function isSystemNoticeItem(item: MessageItem): boolean {
  return (
    item.parts.length > 0 && item.parts.every((part) => part.kind === "event")
  );
}

/**
 * A message posted in the room's own voice rather than by any member —
 * the `system@` sender the room's onboarding card arrives under. Such a
 * row is never "own" for any viewer and never carries author chrome: it
 * is the room talking, not a person.
 */
export function isSystemSenderItem(item: MessageItem): boolean {
  return (
    item.sender !== undefined && localPartOf(item.sender.address) === "system"
  );
}

/** The display name a lone agent-joined row names, or undefined when the
 * item is anything else. */
function agentJoinName(
  item: TimelineMessageItem,
  participants: readonly ParticipantRecord[],
  displayNames?: AgentDisplayNames,
): string | undefined {
  if (item.parts.length !== 1) return undefined;
  const part = item.parts[0];
  if (
    part === undefined ||
    part.kind !== "event" ||
    part.event !== "workbench.agent-joined"
  ) {
    return undefined;
  }
  return joinedAgentName(part, participants, displayNames);
}

/**
 * A room whose whole team arrives at once used to open on a stack of
 * "X joined / Y joined / Z joined" — the first thing a person read was a
 * membership log. Consecutive joins with nothing between them collapse
 * into a single line naming everyone; joins separated by a real message
 * stay their own rows, because there the sequence is the point.
 *
 * Returns the line to render on each run's first item, and the ids of the
 * items that line already accounts for.
 */
export function collapseAgentJoinRuns(
  items: readonly TimelineMessageItem[],
  participants: readonly ParticipantRecord[],
  displayNames?: AgentDisplayNames,
): {
  readonly textByLeadId: ReadonlyMap<string, string>;
  readonly absorbedIds: ReadonlySet<string>;
} {
  const textByLeadId = new Map<string, string>();
  const absorbedIds = new Set<string>();
  let index = 0;
  while (index < items.length) {
    const names: string[] = [];
    let end = index;
    while (end < items.length) {
      const item = items[end];
      if (item === undefined) break;
      const name = agentJoinName(item, participants, displayNames);
      if (name === undefined) break;
      names.push(name);
      end += 1;
    }
    if (names.length > 1) {
      const lead = items[index];
      if (lead !== undefined) {
        textByLeadId.set(lead.id, CHAT_STRINGS.eventAgentsJoined(names));
        for (const absorbed of items.slice(index + 1, end)) {
          absorbedIds.add(absorbed.id);
        }
      }
    }
    index = end > index ? end : index + 1;
  }
  return { textByLeadId, absorbedIds };
}

/**
 * A failed send's inline recovery row (CL-6251/CL-5879): appended below
 * the bubble text of the exact same message group a confirmed message
 * would render as — never a status line elsewhere on the page,
 * disconnected from the message it describes.
 */
function PendingFailedRow({
  nonce,
  pendingActions,
}: {
  readonly nonce: string;
  readonly pendingActions: PendingActions;
}) {
  return (
    <div className="chat-pending-failed-row" role="alert">
      <span className="chat-pending-failed-label">
        {CHAT_STRINGS.pendingSendFailedLabel}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="chat-pending-retry"
        onClick={() => pendingActions.onRetry(nonce)}
      >
        {CHAT_STRINGS.pendingSendRetryAction}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="chat-pending-discard"
        onClick={() => pendingActions.onDiscard(nonce)}
      >
        {CHAT_STRINGS.pendingSendDiscardAction}
      </Button>
    </div>
  );
}

/**
 * The in-progress agent reply's bubble: same header (avatar, name, agent
 * badge) a finished agent message would show — `item.sender` is the agent
 * participant `mergeStreamingReply` resolved it against, exactly as
 * `senderDisplay` matches any other message's sender — but no hover
 * toolbar, reactions, pin toggle, or thread affordance, since none of
 * those round-trips make sense against a message the server hasn't
 * persisted (or issued an id for) yet. The blinking `chat-block-cursor`
 * after the text is the one visible cue this bubble is still growing.
 */
function StreamingMessageGroup({
  item,
  participants,
  currentUser,
  showDayDivider,
  agentDisplayNames,
}: {
  readonly item: TimelineMessageItem;
  readonly participants: readonly ParticipantRecord[];
  readonly currentUser: CurrentUser | undefined;
  readonly showDayDivider: boolean;
  readonly agentDisplayNames?: AgentDisplayNames;
}) {
  const text = messageText(item);
  const display = senderDisplay(
    item.sender,
    participants,
    currentUser,
    agentDisplayNames,
  );

  return (
    <div className="chat-message-group" id={messageDomId(item.id)}>
      {showDayDivider && <DayDivider createdAt={item.createdAt} />}
      <div className="chat-bubble-row" data-own="false">
        {display !== undefined && (
          <SenderAvatar
            id={display.id}
            initials={display.initials}
            label={display.label}
            isAgent={display.isAgent}
          />
        )}
        <div className="chat-bubble">
          {display !== undefined && (
            <div className="chat-bubble-head">
              <span className="chat-bubble-sender">
                {display.label}
                {display.isAgent && <AgentBadge />}
              </span>
            </div>
          )}
          <p className="chat-bubble-text">
            {text}
            <span className="chat-block-cursor" aria-hidden="true" />
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The ellipsis/right-click menu for a message: reply-in-thread, copy, pin,
 * and Edit (own prompts) in one place so the hover ellipsis and a
 * right-click always offer the same actions.
 */
function buildMessageMenu({
  item,
  threadAffordanceMode,
  onOpenThread,
  onEditMessage,
  pinActions,
}: {
  readonly item: MessageItem;
  readonly threadAffordanceMode: ThreadAffordanceMode;
  readonly onOpenThread: ((messageId: string) => void) | undefined;
  readonly onEditMessage: ((messageId: string) => void) | undefined;
  readonly pinActions: PinActions | undefined;
}): ContextMenu {
  const entries: ContextMenuEntry[] = [];

  if (onOpenThread !== undefined) {
    entries.push(
      contextMenuItem({
        id: "reply-in-thread",
        label:
          threadAffordanceMode === "fork"
            ? CHAT_STRINGS.forkThreadAction
            : CHAT_STRINGS.replyInThreadAction,
        icon: <ArrowBendUpLeft aria-hidden="true" />,
        onSelect: () => onOpenThread(item.id),
      }),
    );
  }

  if (onEditMessage !== undefined) {
    entries.push(
      contextMenuItem({
        id: "edit-message",
        label: CHAT_STRINGS.editMessageAction,
        icon: <PencilSimple aria-hidden="true" />,
        onSelect: () => onEditMessage(item.id),
      }),
    );
  }

  const text = messageText(item);
  if (text.length > 0) {
    entries.push(
      contextMenuItem({
        id: "copy-text",
        label: CHAT_STRINGS.copyTextAction,
        icon: <Copy aria-hidden="true" />,
        onSelect: () => {
          void copyMessageText(text);
        },
      }),
    );
  }

  if (pinActions !== undefined) {
    const pinned = item.pinned ?? false;
    entries.push(
      contextMenuItem({
        id: "toggle-pin",
        label: pinned
          ? CHAT_STRINGS.unpinMessageAction
          : CHAT_STRINGS.pinMessageAction,
        icon: pinned ? (
          <PushPinSlash aria-hidden="true" />
        ) : (
          <PushPin aria-hidden="true" />
        ),
        onSelect: () =>
          pinned ? pinActions.onUnpin(item.id) : pinActions.onPin(item.id),
      }),
    );
  }

  return { entries };
}

/**
 * The compact trailing-edge action cluster a message reveals on hover or
 * keyboard focus-within — add-reaction, reply-in-thread, edit-own-prompt,
 * and the ellipsis menu (see `buildMessageMenu`). Nothing here renders
 * permanently; a quiet conversation shows plain text until a reader hovers
 * a line, matching the reference pattern this replaces (a persistent inline
 * "Reply in thread" link under every message).
 */
function MessageHoverToolbar({
  messageId,
  menu,
  menuOpen,
  onOpenMenu,
  threadAffordanceMode,
  onOpenThread,
  onEditMessage,
  reactionActions,
}: {
  readonly messageId: string;
  readonly menu: ContextMenu;
  readonly menuOpen: boolean;
  readonly onOpenMenu: (x: number, y: number, origin: Element) => void;
  readonly threadAffordanceMode: ThreadAffordanceMode;
  readonly onOpenThread?: (messageId: string) => void;
  readonly onEditMessage?: (messageId: string) => void;
  readonly reactionActions?: ReactionActions;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerAnchorRef = useRef<HTMLSpanElement>(null);

  // A click/tap anywhere outside the picker closes it, same as Escape —
  // without this, the picker is the one popover on this surface that only
  // ever closes on a second click of its own trigger or a selection.
  useEffect(() => {
    if (!pickerOpen) return;
    function handlePointerDown(event: PointerEvent) {
      const anchor = pickerAnchorRef.current;
      if (anchor === null) return;
      if (event.target instanceof Node && anchor.contains(event.target)) {
        return;
      }
      setPickerOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [pickerOpen]);

  function toggleReaction(emoji: string) {
    reactionActions?.onToggle(messageId, emoji);
    setPickerOpen(false);
  }

  const menuHasEntries = !isContextMenuEmpty(menu);
  if (
    reactionActions === undefined &&
    onOpenThread === undefined &&
    onEditMessage === undefined &&
    !menuHasEntries
  ) {
    return null;
  }

  return (
    <div
      className="chat-hover-toolbar"
      data-thread-affordance-mode={threadAffordanceMode}
      data-open={pickerOpen || menuOpen}
    >
      {reactionActions !== undefined ? (
        <span className="chat-reaction-picker-anchor" ref={pickerAnchorRef}>
          <button
            type="button"
            className="chat-reaction-add"
            aria-label={CHAT_STRINGS.reactionAddAction}
            aria-expanded={pickerOpen}
            onClick={() => setPickerOpen((open) => !open)}
          >
            <Smiley aria-hidden="true" />
          </button>
          {pickerOpen ? (
            <span
              className="chat-reaction-picker"
              role="menu"
              aria-label={CHAT_STRINGS.reactionPickerLabel}
              onKeyDown={(event) => {
                if (event.key === "Escape") setPickerOpen(false);
              }}
            >
              {REACTION_EMOJI.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  role="menuitem"
                  className="chat-reaction-picker-option"
                  aria-label={CHAT_STRINGS.reactionPickerOptionLabel(emoji)}
                  onClick={() => toggleReaction(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
      {onOpenThread !== undefined ? (
        <button
          type="button"
          className="chat-hover-reply"
          aria-label={
            threadAffordanceMode === "fork"
              ? CHAT_STRINGS.forkThreadAction
              : CHAT_STRINGS.replyInThreadAction
          }
          onClick={() => onOpenThread(messageId)}
        >
          <ArrowBendUpLeft aria-hidden="true" />
        </button>
      ) : null}
      {onEditMessage !== undefined ? (
        <button
          type="button"
          className="chat-hover-edit"
          aria-label={CHAT_STRINGS.editMessageAction}
          onClick={() => onEditMessage(messageId)}
        >
          <PencilSimple aria-hidden="true" />
        </button>
      ) : null}
      {menuHasEntries ? (
        <button
          type="button"
          className="chat-hover-ellipsis"
          aria-label={CHAT_STRINGS.messageActionsMenuLabel}
          aria-expanded={menuOpen}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            onOpenMenu(rect.left, rect.bottom, event.currentTarget);
          }}
        >
          <DotsThree aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** The pin/unpin toggle a message's hover row offers — renders nothing
 * when `pinActions` is undefined. */
function PinToggleButton({
  messageId,
  pinned,
  pinActions,
}: {
  readonly messageId: string;
  readonly pinned: boolean;
  readonly pinActions: PinActions;
}) {
  return (
    <button
      type="button"
      className="chat-pin-toggle"
      data-pinned={pinned}
      aria-pressed={pinned}
      aria-label={
        pinned ? CHAT_STRINGS.unpinMessageAction : CHAT_STRINGS.pinMessageAction
      }
      onClick={() =>
        pinned ? pinActions.onUnpin(messageId) : pinActions.onPin(messageId)
      }
    >
      {pinned ? (
        <PushPinSlash aria-hidden="true" />
      ) : (
        <PushPin aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * `MessageParts`'s own memo guard (CL-6625): a streamed token, a typing
 * ping, or a presence update re-renders `WorkbenchTimeline`'s parent with a
 * freshly-built `items` array (`mergeStreamingReply`/`mergePendingSends` in
 * `chat-workspace.tsx`), but every *unchanged* message keeps its own
 * object identity across that rebuild — only the growing streaming bubble
 * and the array wrapper are new. Without this guard, every row re-runs its
 * full render (markdown, menu building, avatar lookups) on every token of
 * someone else's reply, which is the dominant cause of "jerky" scrolling
 * during a live turn. Handler props (`onOpenThread` and friends) are
 * excluded on purpose: the host recreates them each render regardless, and
 * they carry no data this component displays, only what it calls back
 * into — so treating them as always-equal costs nothing and is what makes
 * this guard effective at all. `items` (the full timeline, used only to
 * recover retry text for a failed turn — see its own doc below) is
 * excluded the same way; its reference changes every render independent of
 * this row's own content, and a one-render-stale read of it is invisible to
 * the reader.
 */
function messagePartsPropsEqual(
  prev: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>>,
): boolean {
  const ignoredKeys = new Set(["items"]);
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    if (ignoredKeys.has(key)) continue;
    const prevValue = prev[key];
    const nextValue = next[key];
    if (typeof prevValue === "function" && typeof nextValue === "function") {
      continue;
    }
    if (prevValue !== nextValue) return false;
  }
  return true;
}

function MessagePartsInner({
  item,
  items,
  participants,
  currentUser,
  showDayDivider,
  showHeader,
  collapsedJoinText,
  threadMeta,
  threadAffordanceMode = "reply",
  onOpenThread,
  onEditMessage,
  onOpenProfile,
  onOpenArtifact,
  onOpenArtifactInLibrary,
  onFixConnection,
  approvalActions,
  blockResponses,
  connectGithubActions,
  connectServiceActions,
  reactionActions,
  pinActions,
  pendingActions,
  failedTurnRecovery,
  onRetryFailedTurn,
  onWhatHappenedFailedTurn,
  agentDisplayNames,
}: {
  readonly item: TimelineMessageItem;
  /** The full timeline, oldest→newest — only read to recover the request
   * text a failed-turn notice answered (`findRetryText`), never for
   * anything else this component renders. */
  readonly items: readonly TimelineMessageItem[];
  readonly participants: readonly ParticipantRecord[];
  readonly currentUser: CurrentUser | undefined;
  readonly showDayDivider: boolean;
  /** `false` when this message continues an unbroken run from the same
   * author as the item directly above it — see `isGroupedWithPrevious`. */
  readonly showHeader: boolean;
  /** Set only on the first item of a collapsed run of consecutive agent
   * joins — see `collapseAgentJoinRuns`. */
  readonly collapsedJoinText?: string;
  readonly threadMeta?: ThreadAffordanceMeta | undefined;
  readonly threadAffordanceMode?: ThreadAffordanceMode;
  readonly onOpenThread?: (messageId: string) => void;
  readonly onEditMessage?: (messageId: string) => void;
  readonly onOpenProfile?: (subject: ProfileSubject) => void;
  readonly onOpenArtifact?: (part: Part & { kind: "file" }) => void;
  readonly onOpenArtifactInLibrary?: (part: Part & { kind: "file" }) => void;
  /** The classified-inference-failure text bubble's quiet "Fix this
   * connection" action (CL-6092) — undefined renders no affordance at
   * all, the same "no port, no feature" contract every other optional
   * action here follows. No chat-ui component owns routing: the host
   * decides where "fix" goes (Plugins' connect panel today). */
  readonly onFixConnection?: () => void;
  readonly approvalActions?: ApprovalActions;
  readonly blockResponses?: BlockResponseActions;
  /** The connect-github block's live round-trip — see
   * `ConnectGithubActions`. Undefined renders the card in its
   * pre-round-trip disconnected framing. */
  readonly connectGithubActions?: ConnectGithubActions;
  /** Host round-trip for the generic "connect-service" card. Undefined
   * renders every connect-service card in its disconnected framing. */
  readonly connectServiceActions?: ConnectServiceActions;
  readonly reactionActions?: ReactionActions;
  readonly pinActions?: PinActions;
  /** This reader's own failed send's inline Retry/Discard — see
   * `PendingActions`. Undefined on every ordinary message; on a failed
   * pending item (`item.pendingStatus === "failed"`) with no actions
   * wired, the failed row simply doesn't render. */
  readonly pendingActions?: PendingActions;
  /** The failed-turn strip's Retry/what-happened actions (CL-6332) —
   * see `WorkbenchTimeline`'s own doc of the same two props. Undefined
   * renders the strip with inert buttons, never hiding the strip
   * itself: a failed turn stays visible even on a host that wires no
   * recovery action for it. */
  readonly onRetryFailedTurn?: (
    item: TimelineMessageItem,
    retryText?: string,
  ) => void | Promise<void>;
  readonly onWhatHappenedFailedTurn?: (item: TimelineMessageItem) => void;
  readonly failedTurnRecovery?: FailedTurnRecovery;
  /** Resolved agent display names (CL-6424) — headers, strips, and event
   * lines show these, never raw handle slugs. */
  readonly agentDisplayNames?: AgentDisplayNames;
}) {
  // A message this reader's own composer submitted and the server hasn't
  // issued an id for yet (see `TimelineMessageItem.pendingStatus`) offers
  // none of the round-trips below — reactions, pin, thread, context menu —
  // since every one of them targets a server-issued message id that
  // doesn't exist yet for this item. System / error / connect rows
  // (CL-6739) likewise offer none of the social chrome — see
  // `offersMessageSocialChrome`.
  const isPending = item.pendingStatus !== undefined;
  const offersSocialChrome = !isPending && offersMessageSocialChrome(item);
  // System notices (join / rename / membership) never read as own even when
  // this viewer triggered them — see `isSystemNoticeItem` (CL-6772).
  const isOwn =
    currentUser !== undefined &&
    item.sender !== undefined &&
    !isSystemNoticeItem(item) &&
    !isSystemSenderItem(item) &&
    localPartOf(item.sender.address) === currentUser.principalId;
  const ownEdit =
    isOwn && onEditMessage !== undefined && messageText(item).length > 0
      ? onEditMessage
      : undefined;
  const contextMenu = useContextMenuState();
  const menu = offersSocialChrome
    ? buildMessageMenu({
        item,
        threadAffordanceMode,
        onOpenThread,
        onEditMessage: ownEdit,
        pinActions,
      })
    : { entries: [] };
  const replyCount = threadMeta?.replyCount ?? 0;
  const pendingNonce = item.pendingNonce ?? item.id;
  // Same identity `WorkbenchTimeline`'s render loop keys this whole group
  // under (`clientId` when the wire echoed one, else `id`) — reused here
  // for each part's own key so a pending send's `TextBubble` (and its
  // avatar) is the very DOM node its later confirmed copy updates in
  // place, never a remount keyed off the pending nonce vs. the eventual
  // server-issued id.
  const groupKey = item.clientId ?? item.id;

  function handleContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    if (!offersSocialChrome || isContextMenuEmpty(menu)) return;
    event.preventDefault();
    contextMenu.show(event.clientX, event.clientY, menu, event.currentTarget);
  }

  return (
    <div
      className="chat-message-group"
      id={messageDomId(item.id)}
      data-grouped={!showHeader}
      data-own={isOwn}
      data-pending={item.pendingStatus}
      onContextMenu={handleContextMenu}
    >
      {showDayDivider && <DayDivider createdAt={item.createdAt} />}
      <div className="chat-message-row">
        <div className="chat-message-body">
          {groupTimelineParts(item.parts, groupKey).map((group) => {
            const key = group.key;
            if (group.kind === "tool-activity") {
              return <ToolActivityGroup key={key} rows={group.rows} />;
            }
            const part = group.part;
            if (part.kind === "text" && part.turnFailed === true) {
              const retryText = findRetryText(items, item);
              return (
                <FailedTurnStrip
                  key={key}
                  item={item}
                  detailText={part.text}
                  participants={participants}
                  currentUser={currentUser}
                  {...(part.turnFailedReason === "model_unavailable" ||
                  part.turnFailedReason === "tools_unsupported"
                    ? { namedRecovery: part.turnFailedReason }
                    : {})}
                  {...(agentDisplayNames !== undefined
                    ? { agentDisplayNames }
                    : {})}
                  {...(retryText !== undefined ? { retryText } : {})}
                  {...(failedTurnRecovery !== undefined
                    ? { failedTurnRecovery }
                    : {})}
                  {...(onRetryFailedTurn !== undefined
                    ? { onRetryFailedTurn }
                    : {})}
                  {...(onWhatHappenedFailedTurn !== undefined
                    ? { onWhatHappenedFailedTurn }
                    : {})}
                />
              );
            }
            if (part.kind === "text" && part.turnCancelled === true) {
              return (
                <CancelledTurnStrip
                  key={key}
                  item={item}
                  participants={participants}
                  currentUser={currentUser}
                  {...(agentDisplayNames !== undefined
                    ? { agentDisplayNames }
                    : {})}
                />
              );
            }
            if (part.kind === "text") {
              return (
                <TextBubble
                  key={key}
                  text={part.text}
                  createdAt={item.createdAt}
                  sender={item.sender}
                  participants={participants}
                  currentUser={currentUser}
                  showHeader={showHeader}
                  {...(agentDisplayNames !== undefined
                    ? { agentDisplayNames }
                    : {})}
                  {...(item.pendingStatus !== undefined
                    ? { pendingStatus: item.pendingStatus, pendingNonce }
                    : {})}
                  {...(pendingActions !== undefined ? { pendingActions } : {})}
                  {...(onOpenProfile !== undefined ? { onOpenProfile } : {})}
                  {...(onFixConnection !== undefined
                    ? { onFixConnection }
                    : {})}
                />
              );
            }
            if (part.kind === "event") {
              return (
                <EventLine
                  key={key}
                  part={part}
                  createdAt={item.createdAt}
                  participants={participants}
                  {...(collapsedJoinText !== undefined
                    ? { collapsedText: collapsedJoinText }
                    : {})}
                  {...(agentDisplayNames !== undefined
                    ? { agentDisplayNames }
                    : {})}
                />
              );
            }
            if (part.kind === "file") {
              return (
                <FilePartView
                  key={key}
                  part={part}
                  {...(onOpenArtifact !== undefined ? { onOpenArtifact } : {})}
                  {...(onOpenArtifactInLibrary !== undefined
                    ? { onOpenArtifactInLibrary }
                    : {})}
                />
              );
            }
            // The agent's own thinking still renders through react-ui, which
            // owns the reasoning disclosure. Tool calls no longer do: they
            // arrive here already folded into rounds by `groupTimelineParts`
            // above, and react-ui's `ToolBlock` renders one call at a time
            // with its arguments and result as `JSON.stringify` output.
            if (part.kind === "reasoning") {
              return (
                <PartsRenderer key={key} parts={[toReactUiReasoning(part)]} />
              );
            }
            if (part.kind === "block") {
              return (
                <BlockPartView
                  key={key}
                  block={part.block}
                  messageId={item.id}
                  {...(approvalActions !== undefined
                    ? { approvalActions }
                    : {})}
                  {...(blockResponses !== undefined ? { blockResponses } : {})}
                  {...(connectGithubActions !== undefined
                    ? { connectGithubActions }
                    : {})}
                  {...(connectServiceActions !== undefined
                    ? { connectServiceActions }
                    : {})}
                />
              );
            }
            return <FallbackPart key={key} part={part} />;
          })}
          {(() => {
            const hasReactions =
              offersSocialChrome &&
              reactionActions !== undefined &&
              (item.reactions?.length ?? 0) > 0;
            // Unpinned messages offer no persistent glyph here — pinning
            // itself stays reachable through the ellipsis menu's own
            // "Pin"/"Unpin" entry (`buildMessageMenu`); this row only shows
            // once there's something to show (a reaction, or a message
            // already pinned, which needs a visible way to unpin). Before
            // this, a pin toggle mounted for every message the moment a host
            // wired `pinActions` at all, CSS-hidden until hover but present
            // in the DOM under every line, greeting included. System / error
            // / connect rows (CL-6739) never show this cluster either.
            const isPinned =
              offersSocialChrome &&
              pinActions !== undefined &&
              item.pinned === true;
            if (!hasReactions && !isPinned) return null;
            return (
              <div className="chat-message-actions">
                {hasReactions && reactionActions !== undefined ? (
                  <ReactionChips
                    messageId={item.id}
                    reactions={item.reactions ?? []}
                    reactionActions={reactionActions}
                  />
                ) : null}
                {isPinned && pinActions !== undefined ? (
                  <PinToggleButton
                    messageId={item.id}
                    pinned={true}
                    pinActions={pinActions}
                  />
                ) : null}
              </div>
            );
          })()}
        </div>
        {offersSocialChrome && onOpenThread !== undefined && replyCount > 0 ? (
          <ThreadAffordance
            messageId={item.id}
            meta={threadMeta}
            mode={threadAffordanceMode}
            participants={participants}
            onOpen={() => onOpenThread(item.id)}
            {...(agentDisplayNames !== undefined ? { agentDisplayNames } : {})}
          />
        ) : null}
        {offersSocialChrome ? (
          <MessageHoverToolbar
            messageId={item.id}
            menu={menu}
            menuOpen={contextMenu.open}
            onOpenMenu={(x, y, origin) => contextMenu.show(x, y, menu, origin)}
            threadAffordanceMode={threadAffordanceMode}
            {...(onOpenThread !== undefined ? { onOpenThread } : {})}
            {...(ownEdit !== undefined ? { onEditMessage: ownEdit } : {})}
            {...(reactionActions !== undefined ? { reactionActions } : {})}
          />
        ) : null}
      </div>
      <ContextMenuView
        x={contextMenu.x}
        y={contextMenu.y}
        menu={contextMenu.menu}
        open={contextMenu.open}
        restoreFocusTo={contextMenu.triggerElement}
        onOpenChange={(next) => {
          if (!next) contextMenu.hide();
        }}
      />
    </div>
  );
}

const MessageParts = memo(MessagePartsInner, messagePartsPropsEqual);

/**
 * Whether `item`'s header (avatar + name + timestamp) collapses because it
 * continues an unbroken run of text messages from the same author as
 * `previous` — the compact grouped-message pattern modern chat UIs use so a
 * quick back-to-back exchange doesn't repeat the same name and avatar on
 * every line. Never groups across a day divider or a message that isn't
 * itself a plain text bubble (an event line or a fallback block always
 * gets its own header on the next real bubble). A pending (optimistic)
 * send groups exactly like any confirmed message from the same author —
 * CL-5879 renders it through this same path, not a separate tier.
 */
function isGroupedWithPrevious(
  item: TimelineMessageItem,
  previous: TimelineMessageItem | undefined,
  showDayDivider: boolean,
): boolean {
  if (showDayDivider || previous === undefined) return false;
  const isTextOnly = (target: TimelineMessageItem) =>
    target.parts.every((part) => part.kind === "text") &&
    target.parts.some((part) => part.kind === "text");
  if (!isTextOnly(item) || !isTextOnly(previous)) return false;
  const address = item.sender?.address;
  return address !== undefined && address === previous.sender?.address;
}

export type ThreadAffordanceMeta = {
  readonly replyCount: number;
  readonly lastActivityAt: string | null;
  readonly participantAddresses: readonly string[];
};

function ThreadAffordance({
  messageId,
  meta,
  mode,
  participants,
  onOpen,
  agentDisplayNames,
}: {
  readonly messageId: string;
  readonly meta: ThreadAffordanceMeta | undefined;
  readonly mode: ThreadAffordanceMode;
  readonly participants: readonly ParticipantRecord[];
  readonly onOpen: () => void;
  readonly agentDisplayNames?: AgentDisplayNames;
}) {
  const replyCount = meta?.replyCount ?? 0;
  const addresses = meta?.participantAddresses ?? [];
  const chips = addresses.slice(0, 3).map((address) => {
    const isAgent = isAgentAddress(address);
    const handle =
      displayNameForAddress(address, agentDisplayNames) ??
      participants.find((p) => p.address === address)?.handle ??
      address.slice(0, 1);
    return {
      address,
      isAgent,
      label: handle,
      initials: initialsOf(handle),
    };
  });
  const activity = formatRelativeActivity(meta?.lastActivityAt ?? null);
  const label =
    replyCount === 0
      ? mode === "fork"
        ? CHAT_STRINGS.forkThreadAction
        : "Reply in thread"
      : replyCount === 1
        ? "1 reply"
        : `${replyCount} replies`;

  return (
    <div
      className="chat-thread-affordance"
      data-message-id={messageId}
      data-thread-affordance-mode={mode}
    >
      {chips.length > 0 ? (
        <span className="chat-thread-avatar-stack" aria-hidden="true">
          {chips.map((chip, index) =>
            chip.isAgent ? (
              <CorbitAvatar
                key={`${chip.address}-${index}`}
                ariaLabel={chip.label}
                size={20}
                className="thread-avatar-chip !overflow-hidden !rounded-full !bg-transparent !p-0"
              />
            ) : (
              <span
                key={`${chip.address}-${index}`}
                className={`thread-avatar-chip ${avatarClassForPrincipal(chip.address)}`}
              >
                {chip.initials}
              </span>
            ),
          )}
        </span>
      ) : null}
      <span className="chat-thread-affordance-meta">
        <span className="chat-thread-reply-count">{label}</span>
        {activity !== "" ? (
          <span className="chat-thread-last-activity">{activity}</span>
        ) : null}
      </span>
      <button type="button" className="chat-thread-open" onClick={onOpen}>
        {mode === "fork" ? CHAT_STRINGS.forkThreadAction : "Open"}
      </button>
    </div>
  );
}

/** A workbench's scroll position, captured/restored across a
 * `WorkbenchTimeline` unmount-remount (e.g. opening/closing Settings) — see
 * `WorkbenchTimeline`'s `scrollRestore`/`onScrollSnapshot`. */
export type ScrollSnapshot = {
  readonly scrollTop: number;
  readonly pinned: boolean;
};

export function WorkbenchTimeline({
  items,
  participants = [],
  settingUpAgent,
  currentUser,
  threadMetaByMessageId,
  threadAffordanceMode = "reply",
  onOpenThread,
  onEditMessage,
  onOpenProfile,
  onOpenArtifact,
  onOpenArtifactInLibrary,
  onFixConnection,
  approvalActions,
  blockResponses,
  connectGithubActions,
  connectServiceActions,
  reactionActions,
  pinActions,
  pendingActions,
  failedTurnRecovery,
  onRetryFailedTurn,
  onWhatHappenedFailedTurn,
  scrollRestore,
  onScrollSnapshot,
  footer,
  agentDisplayNames,
}: {
  /** Server-issued messages, oldest→newest, plus any optimistic entries
   * the host is still resolving — see `TimelineMessageItem`'s
   * `pendingStatus`. An ordinary item simply omits it. */
  readonly items: readonly TimelineMessageItem[];
  readonly participants?: readonly ParticipantRecord[];
  /** True for an agent chat still finishing its background launch —
   * renders the setting-up state instead of "No messages yet". */
  readonly settingUpAgent?: boolean;
  readonly currentUser?: CurrentUser;
  /** ArrowBendUpLeft-thread summary keyed by parent message id. */
  readonly threadMetaByMessageId?: ReadonlyMap<string, ThreadAffordanceMeta>;
  /** `"reply"` on the workbench root feed, `"fork"` inside an open thread —
   * see `ThreadAffordanceMode`. */
  readonly threadAffordanceMode?: ThreadAffordanceMode;
  readonly onOpenThread?: (messageId: string) => void;
  readonly onEditMessage?: (messageId: string) => void;
  readonly onOpenProfile?: (subject: ProfileSubject) => void;
  /** Open a message's artifact chip — the host resolves where that goes
   * (Library today; canvas is a follow-up). No chat-ui component owns
   * routing, mirroring `onOpenThread` and `onOpenProfile`. */
  readonly onOpenArtifact?: (part: Part & { kind: "file" }) => void;
  /** The chip's "Open in Library" affordance — a second, host-supplied hop
   * alongside `onOpenArtifact`, only ever offered when the part carries an
   * `artifactId` (see `ArtifactChip`). */
  readonly onOpenArtifactInLibrary?: (part: Part & { kind: "file" }) => void;
  /** The classified-inference-failure text bubble's quiet "Fix this
   * connection" action (CL-6092) — see `MessageParts`' own doc. */
  readonly onFixConnection?: () => void;
  /** The approve block's live round-trip — the host's read/approve/reject
   * on the platform approval a card references. Undefined renders every
   * approve card in its pre-round-trip fixed-disabled framing. */
  readonly approvalActions?: ApprovalActions;
  /** The poll/form blocks' live round-trip — the host's read/vote/submit
   * against `@corbits/chat`'s response routes. Undefined renders every
   * poll/form card in its pre-round-trip fixed-disabled framing. */
  readonly blockResponses?: BlockResponseActions;
  /** The connect-github block's live round-trip — see
   * `ConnectGithubActions`. Undefined renders every connect-github card
   * in its pre-round-trip disconnected framing. */
  readonly connectGithubActions?: ConnectGithubActions;
  /** Host round-trip for the generic "connect-service" card. Undefined
   * renders every connect-service card in its disconnected framing. */
  readonly connectServiceActions?: ConnectServiceActions;
  /** The reaction chip row's live round-trip — see `ReactionActions`.
   * Undefined renders no chips and no "add reaction" trigger at all,
   * the same "no port, no feature" contract `blockResponses` follows. */
  readonly reactionActions?: ReactionActions;
  /** The hover pin/unpin toggle — see `PinActions`. Undefined renders
   * no pin affordance on any message. */
  readonly pinActions?: PinActions;
  /** The failed pending bubble's inline Retry/Discard — see
   * `PendingActions`. Undefined renders a failed pending item with no
   * recovery affordance at all (still shown as failed). */
  readonly pendingActions?: PendingActions;
  /** Retry action offered on a failed-turn strip (CL-6332) — the
   * server's undelivered-turn notice (`agent_turns` closed `failed`,
   * see `postUndeliveredNotice`), rendered via `FailedTurnStrip` above.
   * Undefined still renders the strip, just with a Retry button that
   * does nothing when pressed — the strip's job is to make the failure
   * visible, which it does either way. */
  readonly onRetryFailedTurn?: (
    item: TimelineMessageItem,
    retryText?: string,
  ) => void | Promise<void>;
  /** The failed-turn strip's "what happened" action — same undefined
   * contract as `onRetryFailedTurn`. */
  readonly onWhatHappenedFailedTurn?: (item: TimelineMessageItem) => void;
  /** Inline model picker + Settings hop for a model-unavailable notice. */
  readonly failedTurnRecovery?: FailedTurnRecovery;
  /** The scroll position to restore on mount — the host's own memory of
   * where this workbench's reader last was, captured via `onScrollSnapshot`
   * the last time this component unmounted (e.g. opening Settings, which
   * swaps this whole component out for the settings surface). Undefined
   * mounts pinned to the bottom, same as a workbench's first-ever render. */
  readonly scrollRestore?: ScrollSnapshot;
  /** Called once, from this component's unmount cleanup, with its final
   * scroll position — the host's only chance to remember it, since this
   * component owns no state itself once it's gone. */
  readonly onScrollSnapshot?: (snapshot: ScrollSnapshot) => void;
  /** Incoming-slot pulse (typing / pending-reply) rendered after the last
   * message so it sits where the next agent reply will land. */
  readonly footer?: ReactNode;
  /** Resolved agent display names (CL-6424) — headers, join lines, and
   * empty states show these, never raw handle slugs. Undefined keeps the
   * slug-derived fallback, so a host that never resolves names renders
   * exactly what it always did. */
  readonly agentDisplayNames?: AgentDisplayNames;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Starts pinned (true) unless a restored snapshot says otherwise — a
  // workbench's first-ever render always lands at the bottom, but remounting
  // after Settings closes restores exactly how the reader left it.
  const [pinnedToLatest, setPinnedToLatest] = useState(
    scrollRestore?.pinned ?? true,
  );
  const pinnedRef = useRef(pinnedToLatest);

  // Kept current every render (never a dependency) so the unmount cleanup
  // below always calls the host's latest callback, not a stale one closed
  // over at mount time.
  const onScrollSnapshotRef = useRef(onScrollSnapshot);
  onScrollSnapshotRef.current = onScrollSnapshot;

  const BOTTOM_PIN_THRESHOLD_PX = 40;

  const handleScroll = () => {
    const container = containerRef.current;
    if (container === null) return;
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const nextPinned = distanceFromBottom <= BOTTOM_PIN_THRESHOLD_PX;
    pinnedRef.current = nextPinned;
    setPinnedToLatest((current) =>
      current === nextPinned ? current : nextPinned,
    );
  };

  const jumpToLatest = () => {
    const container = containerRef.current;
    if (container === null) return;
    pinnedRef.current = true;
    setPinnedToLatest(true);
    container.scrollTop = container.scrollHeight;
  };

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    if (pinnedRef.current) {
      container.scrollTop = container.scrollHeight;
    }
  }, [items.length, footer != null]);

  // Restores an unpinned reader's exact offset once, on mount — the
  // items.length effect above already handles the pinned case (it fires on
  // this same mount). Deliberately empty deps: this only ever runs once, a
  // restore is a one-time act on remount, not something to repeat every
  // time `scrollRestore` happens to be a new object.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    if (scrollRestore !== undefined && !scrollRestore.pinned) {
      container.scrollTop = scrollRestore.scrollTop;
    }
    return () => {
      onScrollSnapshotRef.current?.({
        scrollTop: container.scrollTop,
        pinned: pinnedRef.current,
      });
    };
  }, []);

  // A sibling mounting or growing below the timeline (the turn-activity
  // strip) changes the scroll container's client height without changing
  // `items.length` — the effect above never fires for it, so a pinned
  // reader would otherwise watch their own view get visually shoved by
  // chrome they never asked to track. `ResizeObserver` is absent in some
  // test environments (jsdom has no implementation), so this is a no-op
  // there rather than a crash.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!pinnedRef.current) return;
      container.scrollTop = container.scrollHeight;
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const joinRuns = collapseAgentJoinRuns(
    items,
    participants,
    agentDisplayNames,
  );

  if (items.length === 0) {
    // A freshly created agent chat answers before it finishes setting up
    // in the background: the agent participant streams in seconds later.
    // An empty agent chat is therefore SETTING UP, never "say something" —
    // that copy invites racing the greeting. Which internal stage that is
    // never reaches the reader — one honest headline for every wait, with
    // a rotating tip so the pause feels useful rather than dead.
    if (settingUpAgent === true) {
      return (
        <div className="chat-timeline-empty">
          <WorkbenchLoadingState delayMs={0} />
        </div>
      );
    }
    // Once an agent DM's agent has actually joined (see `settingUpAgent`'s
    // caller), an empty timeline isn't a stage to wait out — it's a ready
    // conversation with nobody in it yet. Leads with the agent's own name
    // so the affordance is "message them", not the generic feed copy.
    const readyAgent = participants.find((participant) =>
      isAgentAddress(participant.address),
    );
    if (readyAgent !== undefined) {
      const readyAgentName =
        displayNameForAddress(readyAgent.address, agentDisplayNames) ??
        displayNameFromHandle(readyAgent.handle);
      return (
        <div className="chat-timeline-empty">
          <EmptyState
            icon={<ChatCircle />}
            title={`Say hello to ${readyAgentName}`}
            description={CHAT_STRINGS.emptyAgentTimelineDescription}
          />
        </div>
      );
    }
    return (
      <div className="chat-timeline-empty">
        <EmptyState
          icon={<ChatCircle />}
          title={CHAT_STRINGS.emptyTimelineTitle}
          description={CHAT_STRINGS.emptyTimelineDescription}
        />
      </div>
    );
  }

  return (
    <div className="chat-timeline-shell">
      <div className="chat-timeline" ref={containerRef} onScroll={handleScroll}>
        {items.map((item, index) => {
          if (joinRuns.absorbedIds.has(item.id)) return null;
          const previous = index > 0 ? items[index - 1] : undefined;
          const showDayDivider =
            previous === undefined ||
            !isSameCalendarDay(
              new Date(previous.createdAt),
              new Date(item.createdAt),
            );
          // Keyed by `clientId` (falling back to `id`) when present: a
          // pending send and the confirmed message that later reconciles
          // it (CL-6251's wire `clientId`) share this key, so React
          // updates the same DOM node in place — avatar, header and all —
          // rather than unmounting a "sending" bubble and mounting an
          // unrelated "confirmed" one, which is what used to read as an
          // unsent→sent swap (CL-6251, reopened).
          const key = item.clientId ?? item.id;
          if (item.streaming === true) {
            return (
              <StreamingMessageGroup
                key={key}
                item={item}
                participants={participants}
                currentUser={currentUser}
                showDayDivider={showDayDivider}
                {...(agentDisplayNames !== undefined
                  ? { agentDisplayNames }
                  : {})}
              />
            );
          }
          const showHeader = !isGroupedWithPrevious(
            item,
            previous,
            showDayDivider,
          );
          const collapsedJoinText = joinRuns.textByLeadId.get(item.id);
          return (
            <MessageParts
              key={key}
              item={item}
              items={items}
              participants={participants}
              currentUser={currentUser}
              showDayDivider={showDayDivider}
              showHeader={showHeader}
              {...(agentDisplayNames !== undefined
                ? { agentDisplayNames }
                : {})}
              {...(collapsedJoinText !== undefined
                ? { collapsedJoinText }
                : {})}
              threadMeta={threadMetaByMessageId?.get(item.id)}
              threadAffordanceMode={threadAffordanceMode}
              {...(onOpenThread !== undefined ? { onOpenThread } : {})}
              {...(onEditMessage !== undefined ? { onEditMessage } : {})}
              {...(onOpenProfile !== undefined ? { onOpenProfile } : {})}
              {...(onOpenArtifact !== undefined ? { onOpenArtifact } : {})}
              {...(onFixConnection !== undefined ? { onFixConnection } : {})}
              {...(onOpenArtifactInLibrary !== undefined
                ? { onOpenArtifactInLibrary }
                : {})}
              {...(approvalActions !== undefined ? { approvalActions } : {})}
              {...(blockResponses !== undefined ? { blockResponses } : {})}
              {...(connectGithubActions !== undefined
                ? { connectGithubActions }
                : {})}
              {...(connectServiceActions !== undefined
                ? { connectServiceActions }
                : {})}
              {...(reactionActions !== undefined ? { reactionActions } : {})}
              {...(pinActions !== undefined ? { pinActions } : {})}
              {...(pendingActions !== undefined ? { pendingActions } : {})}
              {...(onRetryFailedTurn !== undefined
                ? { onRetryFailedTurn }
                : {})}
              {...(onWhatHappenedFailedTurn !== undefined
                ? { onWhatHappenedFailedTurn }
                : {})}
              {...(failedTurnRecovery !== undefined
                ? { failedTurnRecovery }
                : {})}
            />
          );
        })}
        {footer}
      </div>
      {pinnedToLatest ? null : (
        <button
          type="button"
          className="chat-jump-to-latest"
          onClick={jumpToLatest}
        >
          <ArrowDown aria-hidden="true" />
          {CHAT_STRINGS.jumpToLatestAction}
        </button>
      )}
    </div>
  );
}
