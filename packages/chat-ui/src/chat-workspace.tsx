// Chat workspace: the host resolves which bench the signed-in
// account chats in, loads its workbenches and deployed agents, and wires the
// timeline and composer together for whichever workbench is
// selected. Workbench list lives in the shell contextual panel — this
// surface is the active conversation only.
//
// Resolving *which* bench that is is host-specific (it rides on
// whatever session/query plumbing the embedding app already has — in
// `@workbench/web` that is the same `/api/me/principals` call the Home
// and Settings pages use), so `ChatWorkspace` takes a small
// `TenantResolution` value rather than importing app code: the same
// narrow-port shape `@corbits/chat`'s `routes.ts` uses for `ChatPlatform`.

import { isAgentAddress } from "@corbits/chat/mentions";
import { Button, EmptyState, toast } from "@corbits/react-ui";
import { reportError } from "@corbits/error-sink";
import { getResolvedCatalog } from "@corbits/inference-settings";
import {
  CaretDown,
  ChatCircle,
  SlidersHorizontal,
  UserPlus,
  WarningCircle,
} from "@corbits/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  workbenchesQueryKey,
  workbenchesQueryKeyPrefix,
  cancelWorkbenchTurn,
  describeChatError,
  fetchRunningTurn,
  inviteAgent,
  listWorkbenches,
  listInvitableDefinitions,
  listWorkbenchAgents,
  addAgentCapability,
  refreshWorkbenchAgent,
  pingWorkbenchPresence,
  pinMessage,
  toggleReaction,
  unpinMessage,
  workbenchStreamUrl,
  isKnownWorkbenchKind,
  WORKBENCHES_MUTATED_STREAM_TYPE,
  applyStreamWorkbenchesMutated,
} from "./api";
import type { Workbench, ParticipantRecord, Part } from "./api";
import { WorkbenchSettingsSurface } from "./workbench-settings";
import type { WorkbenchSettingsSectionId } from "./workbench-settings";
import { Composer } from "./composer";
import type { ComposerHandle } from "./composer";
import { InviteAgentDialog } from "./invite-agent-dialog";
import { WorkbenchLoadingState } from "./loading-state";
import {
  mentionCandidatesFromParticipants,
  resolveBringInLists,
} from "./mentions";
import type { BringInListFailure, BringInMember } from "./mentions";
import { PinnedStrip } from "./pinned-strip";
import { SLASH_COMMANDS } from "./slash-commands";
import {
  failedTurnModelChoices,
  failedTurnToolCapableModelChoices,
} from "./failed-turn-models";
import { CHAT_STRINGS } from "./strings";
import { displayWorkbenchTitle } from "./workbench-display-title";
import {
  useStreamingReply,
  isAwaitingReply,
  lastHumanMessageParts,
  typingAgentNames,
} from "./streaming-reply";
import { useTurnActivity, TurnActivityStrip } from "./turn-activity";
import type { StreamingReplyState } from "./streaming-reply";
import {
  AgentBadge,
  WorkbenchTimeline,
  displayNameFromHandle,
  localPartOf,
  messageDomId,
  messageText,
} from "./timeline";
import type { FailedTurnRecovery } from "./timeline";
import {
  agentDisplayNamesFromAgents,
  displayNameForAddress,
  type AgentDisplayNames,
} from "./agent-display-names";
import { NoUsableModelBanner } from "./no-usable-model-banner";
import { ResumeFailedBanner } from "./resume-failed-banner";
import type {
  CurrentUser,
  PinActions,
  ReactionActions,
  ScrollSnapshot,
  TimelineMessageItem,
} from "./timeline";
import type { ApprovalActions } from "./blocks/approval-actions";
import type { BlockResponseActions } from "./blocks/block-responses";
import type { ConnectGithubActions } from "./blocks/connect-github-actions";
import type { ConnectServiceActions } from "./blocks/connect-service-actions";
import {
  typingLabel,
  TypingIndicator,
  AgentTypingIndicator,
  useTypingIndicator,
} from "./typing-indicator";
import type { ProfileSubject } from "./profile-subject";
import { useWorkbenchStream } from "./use-workbench-stream";
import {
  applyStreamMessage,
  applyStreamPin,
  applyStreamReaction,
  useWorkbenchFeed,
} from "./use-workbench-feed";
import { CorbitAvatar, avatarClassForPrincipal } from "./avatar";
import { useWorkbenchPresenceRoster } from "./workbench-presence";
import { type } from "arktype";
import {
  ChatMessageEventData,
  ChatPinEventData,
  ChatReactionEventData,
  ChatSettingsEventData,
} from "@corbits/chat/stream-events";
import { useThreadNavigation } from "./use-thread-navigation";
import { mergePendingSends, useOptimisticSends } from "./use-optimistic-sends";
export {
  mergePendingSends,
  pendingSenderAddress,
} from "./use-optimistic-sends";
export type { PendingSend } from "./use-optimistic-sends";
import { useWorkbenchTimelineView } from "./workbench-timeline-view";
export {
  chatFeedQueryKeyPrefix,
  chatThreadsQueryKey,
  chatPinsQueryKey,
} from "./use-workbench-feed";
export type { MessagesState } from "./workbench-timeline-view";

/**
 * The host's answer to "which bench does this account chat in": mirrors
 * the loading/unauthenticated/error/ready shape every hub-backed query
 * in the embedding app already uses, plus `"empty"` for an
 * authenticated account with no bench membership at all.
 */
export type TenantResolution =
  | { readonly kind: "loading" }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly tenantId: string };

/**
 * One live presence entry for the workbench's who's-here stack (CL-6328) —
 * derived from this workbench's own `/stream` connection
 * (`useWorkbenchPresenceRoster`), never a second connection or an HTTP
 * heartbeat poll. The roster carries only ids, so display names and avatar
 * classes resolve client-side against the workbench's participants.
 */
export interface PresenceMember {
  readonly principalId: string;
  readonly displayName: string;
  readonly avatarClassName: string;
}

/** One entry in the header's static member stack — an agent or a roster
 * human, normalized to the one shape the square stack renders. Live
 * presence uses `PresenceMember` in a separate round stack. */
export interface TeamAvatarEntry {
  readonly key: string;
  readonly initials: string;
  readonly label: string;
  readonly tone: "agent" | "neutral";
  readonly avatarClassName?: string;
}

/** How many avatars the header shows before collapsing the rest into a
 * "+N" chip. Shared by the static member stack and the live presence
 * stack so neither overflows the 3rem bar. */
export const TEAM_AVATAR_STACK_LIMIT = 6;

/** A crumb the host's `StageTopBar` can render — label plus an optional
 * parent href. The last crumb is the current page. */
export type ChatHeaderCrumb = {
  readonly label: string;
  readonly href?: string;
};

/** Chrome the host lifts into `StageTopBar` (`crumbs` / `subtitle` /
 * `actions`) so `/w` does not keep a second identity row. */
export type ChatHeaderChrome = {
  readonly crumbs: readonly ChatHeaderCrumb[];
  readonly subtitle?: ReactNode;
  readonly actions?: ReactNode;
};

const WORKBENCHES_LIST_CHROME: ChatHeaderChrome = {
  crumbs: [{ label: CHAT_STRINGS.chatsSectionLabel }],
};

/**
 * The workbench's static member stack: every agent participant plus every
 * human on the roster. Agents first (they have no presence concept of
 * their own); humans follow. Roster humans are included even when live
 * presence is empty (CL-6779) — onboarding/template rooms often list the
 * signed-in human as a participant before any `chat.presence.snapshot`
 * arrives. Live who's-here is a separate round stack, not mixed in here.
 *
 * Each person gets a stable generated color keyed by address. Human labels
 * prefer `currentUser.name` when the roster entry
 * is the signed-in reader — never a raw handle when a display name exists.
 */
export function buildMemberAvatarStack(
  participants: readonly ParticipantRecord[],
  displayNames?: AgentDisplayNames,
  currentUser?: CurrentUser,
): readonly TeamAvatarEntry[] {
  const agents = participants
    .filter((participant) => isAgentAddress(participant.address))
    .map((participant) => {
      const label =
        displayNameForAddress(participant.address, displayNames) ??
        displayNameFromHandle(participant.handle);
      return {
        key: participant.address,
        initials: "",
        label,
        tone: "agent" as const,
      };
    });

  const humans = participants
    .filter((participant) => !isAgentAddress(participant.address))
    .map((participant) => {
      const label = typingLabel(
        localPartOf(participant.address),
        participants,
        currentUser,
      );
      return {
        key: participant.address,
        initials: label.slice(0, 1).toUpperCase(),
        label,
        tone: "neutral" as const,
        avatarClassName: avatarClassForPrincipal(participant.address),
      };
    });

  return [...agents, ...humans];
}

type WorkbenchesState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly workbenches: readonly Workbench[];
      readonly chats: readonly Workbench[];
    };

/**
 * A chat's agent is fixed at creation — the server 409s an invite into one
 * — so the "invite agent" affordance only ever makes sense on a workbench or
 * on a kind this UI doesn't otherwise recognize. Undefined (no workbench
 * resolved yet, or a routed id that isn't a workbench) stays closed: showing
 * Invite over a missing room is exactly the chrome flash CL-6796 closes.
 */
export function canInviteAgent(kind: string | undefined): boolean {
  if (kind === undefined) return false;
  return !isKnownWorkbenchKind(kind) || kind !== "chat";
}

/**
 * User-facing copy when the mention popover's bring-in queries fail
 * (CL-6839) — never collapse those failures into an honest empty list.
 */
export function bringInLoadErrorMessage(
  failures: readonly BringInListFailure[],
  firstError: unknown | null,
): string | null {
  if (failures.length === 0) return null;
  const fallback =
    failures.length === 2
      ? CHAT_STRINGS.mentionBringInLoadError
      : failures[0] === "members"
        ? CHAT_STRINGS.mentionMembersLoadError
        : CHAT_STRINGS.mentionInvitableLoadError;
  return describeChatError(firstError, fallback);
}

/**
 * CL-6781: the header Invite control must not open an empty "who to invite"
 * dead end. Hide while the invitable listing is still in flight (or errored),
 * and hide once a successful listing proves nobody — agent or person — is
 * left to bring in. Kind gating stays with `canInviteAgent`.
 */
export function shouldOfferInviteControl(args: {
  readonly kind: string | undefined;
  /** Successful invitable-definitions listing; `undefined` while loading/errored. */
  readonly invitableAgents: readonly unknown[] | undefined;
  /** Successful bring-in people listing when the host wired `listMembers`. */
  readonly bringInMembers?: readonly unknown[];
}): boolean {
  if (!canInviteAgent(args.kind)) return false;
  if (args.invitableAgents === undefined) return false;
  if (args.invitableAgents.length > 0) return true;
  return (args.bringInMembers?.length ?? 0) > 0;
}

/**
 * Recovery controls for a gone / non-workbench id (CL-6796). Prefer the
 * Mission Control + New workbench pair; fall back to the legacy single
 * "Back to workbenches" action when a host has not wired the new props.
 */
export function workbenchNotFoundRecoveryAction(args: {
  readonly onGoToMissionControl?: () => void;
  readonly onNewWorkbench?: () => void;
  readonly onBackToWorkbenchList?: () => void;
}): ReactNode | undefined {
  const { onGoToMissionControl, onNewWorkbench, onBackToWorkbenchList } = args;
  const hasModernRecovery =
    onGoToMissionControl !== undefined || onNewWorkbench !== undefined;
  if (hasModernRecovery) {
    return (
      <>
        {onGoToMissionControl !== undefined ? (
          <Button variant="outline" onClick={onGoToMissionControl}>
            {CHAT_STRINGS.workbenchNotFoundMissionControlAction}
          </Button>
        ) : null}
        {onNewWorkbench !== undefined ? (
          <Button variant="outline" onClick={onNewWorkbench}>
            {CHAT_STRINGS.workbenchNotFoundNewWorkbenchAction}
          </Button>
        ) : null}
      </>
    );
  }
  if (onBackToWorkbenchList !== undefined) {
    return (
      <Button variant="outline" onClick={onBackToWorkbenchList}>
        {CHAT_STRINGS.workbenchNotFoundAction}
      </Button>
    );
  }
  return undefined;
}

/**
 * The composer's placeholder reads as a direct message once the active
 * surface is a chat, naming its one counterpart — a chat's title always
 * defaults to that counterpart's name at creation (see `routes.ts`'s
 * `POST /workbenches`), so it's always the right word here even when the
 * counterpart is a person, not an agent. A workbench (or a surface that
 * hasn't resolved yet) keeps the generic, mention-driven copy.
 *
 * CL-6740: only advertise "/ for commands" when the slash catalog actually
 * has commands — an empty/disabled catalog must not promise a dead hop.
 */
export function composerPlaceholderFor(
  workbench:
    | {
        readonly kind: string;
        readonly title: string;
      }
    | undefined,
  options?: { readonly slashCommandCount?: number },
): string {
  const slashAvailable =
    (options?.slashCommandCount ?? SLASH_COMMANDS.length) > 0;
  if (workbench === undefined || workbench.kind !== "chat") {
    return slashAvailable
      ? `${CHAT_STRINGS.composerPlaceholder}, / for commands`
      : CHAT_STRINGS.composerPlaceholder;
  }
  const counterpart =
    workbench.title.trim().length > 0
      ? workbench.title
      : CHAT_STRINGS.unnamedWorkbench;
  const base = CHAT_STRINGS.composerPlaceholderChat(counterpart);
  return slashAvailable ? `${base} / for commands` : base;
}

/**
 * A composer submit this workspace has optimistically added to the
 * timeline before the server confirms it — see `TimelineMessageItem`'s
 * `pendingStatus`. `nonce` is this workspace's own client-side key,
 * independent of any server-issued message id (which does not exist yet
 * while `status` is `"sending"`, and never will if it ends up discarded).
 */

/** The one client-side id `mergeStreamingReply` gives its synthetic
 * timeline item — stable across renders (React's reconciliation key) and
 * never mistaken for a server-issued message id (those come back from
 * `POST`/`GET` routes with a different shape). */
const STREAMING_REPLY_ITEM_ID = "streaming_reply";

/** The workbench's first agent participant — the best available
 * attribution for a synthetic timeline item that has no real sender of
 * its own (`chat.agent` events carry none, and a client-side timeout
 * notice never had a server-issued sender to begin with). Workbenches
 * with more than one invited agent are a known approximation here, not a
 * regression — today's non-streaming refetch has the same "which agent
 * replied" gap until the persisted message's real sender lands. */
function firstAgentParticipant(
  participants: readonly ParticipantRecord[],
): ParticipantRecord | undefined {
  return participants.find((participant) =>
    isAgentAddress(participant.address),
  );
}

/**
 * Folds the active turn's in-progress reply onto the end of the timeline,
 * exactly the way `mergePendingSends` folds this reader's own optimistic
 * sends — except this synthetic item is the *other* side's message, so it
 * needs a sender to attribute it to (see `firstAgentParticipant`).
 */
export function mergeStreamingReply(
  items: readonly TimelineMessageItem[],
  streamingReply: StreamingReplyState,
  participants: readonly ParticipantRecord[],
): readonly TimelineMessageItem[] {
  // A pending reply with no tokens yet stays off the timeline — an
  // empty bubble with no timestamp reads as broken; the typing pulse
  // in the incoming-message slot owns that phase until the first delta
  // lands. A `"replied"` turn renders nothing: its reply is already a
  // persisted message.
  if (
    streamingReply === null ||
    streamingReply.phase === "replied" ||
    streamingReply.text === ""
  ) {
    return items;
  }
  const agent = firstAgentParticipant(participants);
  if (agent === undefined) return items;
  return [
    ...items,
    {
      id: STREAMING_REPLY_ITEM_ID,
      createdAt: new Date().toISOString(),
      parts: [{ kind: "text", text: streamingReply.text }],
      sender: { name: null, address: agent.address },
      streaming: true,
    },
  ];
}

/** The client-side id the reply-timeout notice renders under — same
 * "never a server-issued id" contract as `STREAMING_REPLY_ITEM_ID`. */
const REPLY_TIMED_OUT_ITEM_ID = "reply_timed_out_notice";

/**
 * Appends an honest inline notice once `useStreamingReply`'s own backstop
 * (`PENDING_REPLY_CLEAR_MS`) has fired — a turn that opened but never got a
 * single token and never closed out either, so the reader was left staring
 * at a typing indicator that just vanished with no explanation. This is
 * the same class of failure `postUndeliveredNotice` (`@corbits/chat`)
 * already gives an honest, actionable backstop to when the dispatch fails
 * loud enough for the server to see it — a cold-waking agent that never
 * streams a token back fails silently instead, so before CL-6677 this
 * synthetic notice rendered as a bare quiet event line with no ref id and
 * no Retry. It now carries a `turnFailed` text part exactly like the
 * server's own notice (`replyTimedOutRefId` is minted by `reportError` at
 * the moment `useStreamingReply`'s timer fires), so it renders through
 * `FailedTurnStrip` — same ref-quotable copy, same Retry action — instead
 * of a second, weaker backstop living beside the real one.
 */
export function appendReplyTimedOutNotice(
  items: readonly TimelineMessageItem[],
  replyTimedOutRefId: string | null,
  participants: readonly ParticipantRecord[],
): readonly TimelineMessageItem[] {
  if (replyTimedOutRefId === null) return items;
  const agent = firstAgentParticipant(participants);
  return [
    ...items,
    {
      id: REPLY_TIMED_OUT_ITEM_ID,
      createdAt: new Date().toISOString(),
      parts: [
        {
          kind: "text",
          text: `${CHAT_STRINGS.replyTimedOutNotice} (ref ${replyTimedOutRefId})`,
          turnFailed: true,
        },
      ],
      sender: { name: null, address: agent?.address ?? "" },
    },
  ];
}

/**
 * Records one workbench's scroll snapshot into the map, pure — a fresh `Map`
 * copy rather than a mutation, so `scrollSnapshotsRef.current` always holds
 * exactly the value this function returned, never a same-reference object
 * mutated out from under a caller still holding the old one.
 */
export function withScrollSnapshot(
  snapshots: ReadonlyMap<string, ScrollSnapshot>,
  workbenchId: string,
  snapshot: ScrollSnapshot,
): ReadonlyMap<string, ScrollSnapshot> {
  const next = new Map(snapshots);
  next.set(workbenchId, snapshot);
  return next;
}

/**
 * Workbenches and chats via TanStack Query, keyed with `workbenchesQueryKey` —
 * the same key `apps/web`'s shell bands and command palette use, so this
 * sidebar shares one in-flight fetch per (tenantId, kind) with the rest of
 * the shell rather than firing its own independent request on every mount.
 */
function useWorkbenchLists(tenantId: string) {
  const workbenches = useQuery({
    queryKey: workbenchesQueryKey(tenantId, "workbench"),
    queryFn: () => listWorkbenches(tenantId, "workbench"),
  });
  const chats = useQuery({
    queryKey: workbenchesQueryKey(tenantId, "chat"),
    queryFn: () => listWorkbenches(tenantId, "chat"),
  });

  const reload = useCallback(async () => {
    await Promise.all([workbenches.refetch(), chats.refetch()]);
  }, [workbenches.refetch, chats.refetch]);

  // Referentially stable across renders that don't actually change the
  // underlying data — a fresh object literal here every render would make
  // `workbenchesState` look "changed" to every effect that depends on it
  // (the auto-select-first-workbench effect below included), firing them on
  // every unrelated re-render rather than only when workbenches/chats data
  // itself moves.
  const state: WorkbenchesState = useMemo(() => {
    if (workbenches.isError) {
      return {
        kind: "error",
        message: describeChatError(
          workbenches.error,
          "Couldn't load workbenches.",
        ),
      };
    }
    if (chats.isError) {
      return {
        kind: "error",
        message: describeChatError(chats.error, "Couldn't load workbenches."),
      };
    }
    if (workbenches.data === undefined || chats.data === undefined) {
      return { kind: "loading" };
    }
    return { kind: "ready", workbenches: workbenches.data, chats: chats.data };
  }, [
    workbenches.isError,
    workbenches.error,
    workbenches.data,
    chats.isError,
    chats.error,
    chats.data,
  ]);

  return { state, reload };
}

function ChatWorkspaceInner({
  tenantId,
  workbenchId: controlledWorkbenchId,
  onWorkbenchChange,
  currentUser,
  onOpenProfile,
  settingsOpen = false,
  onSettingsOpenChange,
  settingsSection = "general",
  onSettingsSectionChange,
  settingsEntityId = null,
  onSettingsEntityIdChange,
  onOpenArtifact,
  onOpenArtifactInLibrary,
  onFixConnection,
  approvalActions,
  blockResponses,
  connectGithubActions,
  connectServiceActions,
  headerLeading,
  headerSlot,
  registerComposerInsert,
  listMembers,
  onCreateRoutineInSpace,
  onWorkbenchNotFound,
  onBackToWorkbenchList,
  onGoToMissionControl,
  onNewWorkbench,
  onSignIn,
  hasUsableModel,
  onConnectModel,
}: {
  readonly tenantId: string;
  readonly workbenchId?: string | null;
  readonly onWorkbenchChange?: (workbenchId: string) => void;
  readonly currentUser?: CurrentUser;
  readonly onOpenProfile?: (subject: ProfileSubject) => void;
  /** Whether the routed workbench's settings surface should replace the
   * conversation stage (mock § Workbench settings — a full surface, never a
   * dialog). Host-controlled the same way `workbenchId` is: driven from the
   * URL (`/w/:id/settings`). */
  readonly settingsOpen?: boolean;
  /** Fired when the settings surface should open or close. `section` is
   * only passed on open — the section the opener meant to land on (the
   * gear button's General, or the composer's `/agents` shortcut) — so the
   * host can navigate straight to that URL without a second, separate
   * navigation for the section. */
  readonly onSettingsOpenChange?: (
    open: boolean,
    section?: WorkbenchSettingsSectionId,
    entityId?: string,
  ) => void;
  /** Which workbench settings tab is active while the surface is open —
   * host-controlled the same way `settingsOpen` is, driven from the URL
   * (`/w/:id/settings/:section`). */
  readonly settingsSection?: WorkbenchSettingsSectionId;
  /** Fired when the user switches tabs while the settings surface is
   * already open, so the host can reflect it in the URL. */
  readonly onSettingsSectionChange?: (
    section: WorkbenchSettingsSectionId,
  ) => void;
  /** Section sub-selection while settings are open — host-controlled from
   * the URL (`/w/:id/settings/:section/:entityId`). `null` means the
   * section's own list (or a section with no list). */
  readonly settingsEntityId?: string | null;
  /** Fired when a settings section opens or closes its own detail, so the
   * host can deepen or clear the entity segment in the URL. */
  readonly onSettingsEntityIdChange?: (entityId: string | null) => void;
  /** Open a message's artifact chip — see `WorkbenchTimeline`'s `onOpenArtifact`. */
  readonly onOpenArtifact?: (part: Part & { kind: "file" }) => void;
  /** The chip's "Open in Library" affordance — see `WorkbenchTimeline`'s
   * `onOpenArtifactInLibrary`. */
  readonly onOpenArtifactInLibrary?: (part: Part & { kind: "file" }) => void;
  /** The classified-inference-failure text bubble's "Fix this connection"
   * action — see `WorkbenchTimeline`'s `onFixConnection` (CL-6092). */
  readonly onFixConnection?: () => void;
  /** The approve block's live round-trip — see `WorkbenchTimeline`'s
   * `approvalActions`. */
  readonly approvalActions?: ApprovalActions;
  /** The poll/form blocks' live round-trip — see `WorkbenchTimeline`'s
   * `blockResponses`. */
  readonly blockResponses?: BlockResponseActions;
  /** The connect-github block's live round-trip — see `WorkbenchTimeline`'s
   * `connectGithubActions`. */
  readonly connectGithubActions?: ConnectGithubActions;
  /** Host round-trip for the generic "connect-service" card. Undefined
   * renders every connect-service card in its disconnected framing. */
  readonly connectServiceActions?: ConnectServiceActions;
  /** Host-supplied control rendered first in the workbench header — the
   * shell's single col2 toggle, so chat carries the same top-bar chrome as
   * every other stage surface. Unused when `headerSlot` owns the bar. */
  readonly headerLeading?: ReactNode;
  /** Host-owned stage bar. When set, identity and primary actions render
   * through this slot (`StageTopBar`'s crumbs / subtitle / actions) instead
   * of `.chat-workbench-header`. */
  readonly headerSlot?: (chrome: ChatHeaderChrome) => ReactNode;
  /**
   * Lets the host (command palette, canvas "insert into composer", …) push
   * text into the live composer. Called with the insert fn when a composer
   * mounts, and with `null` when it unmounts so the host never holds a
   * stale handle. Optional: hosts that don't need the insert path omit it.
   */
  readonly registerComposerInsert?: (
    insert: ((text: string) => void) | null,
  ) => void;
  /**
   * Tenant members the mention popover's "Bring in…" group can offer —
   * the same reduced listing the shell already fetches for its
   * people/agents surfaces. Optional: omitting it hides the People group
   * (a workbench that can't grow its human roster still works).
   */
  readonly listMembers?: (
    tenantId: string,
  ) => Promise<readonly BringInMember[]>;
  /**
   * The composer's `/routine` command: opens the New Routine panel with
   * the active workbench pre-bound as its destination. Host-supplied so
   * the panel's own route (and its prefill store) stays owned by the
   * host; the active workbench id is closed over here rather than passed
   * as an argument, since only this component knows it. Omitted, the
   * command is hidden — the "no dead promise" contract every optional
   * header/composer action here follows. Routines and Insights (CL-6362,
   * CL-6099) are global-only pages now — reached from the shell rail, not
   * a per-workbench header button or composer command.
   */
  readonly onCreateRoutineInSpace?: (
    workbenchId: string,
    preselectedAssetId?: string,
  ) => void;
  /** Fired when the routed workbench 404s — a deleted workbench, or a stale
   * Recents entry that outlived it. The host owns Recents (this package
   * never touches localStorage), so it's told rather than reaching out. */
  readonly onWorkbenchNotFound?: (workbenchId: string) => void;
  /** Legacy single recovery for a gone workbench — prefer
   * `onGoToMissionControl` / `onNewWorkbench` (CL-6796). */
  readonly onBackToWorkbenchList?: () => void;
  /** Not-found empty state's Mission Control recovery (CL-6796). */
  readonly onGoToMissionControl?: () => void;
  /** Not-found empty state's New workbench recovery (CL-6796). */
  readonly onNewWorkbench?: () => void;
  /** The 401 messages-error state's way out — sign back in instead of a
   * retry that can only ever hit the same 401. Omitted, that state falls
   * back to no action at all (never "Try again" for a session that's gone). */
  readonly onSignIn?: () => void;
  /** Whether this tenant can actually run inference right now — the
   * host's read of `hasUsableModel` (`@corbits/inference-settings`)
   * against its resolved catalog, never mere `model_provider` row
   * presence (CL-6568). `undefined` while that read is still in flight:
   * the banner stays hidden rather than flashing "no model" before the
   * real answer lands. */
  readonly hasUsableModel?: boolean;
  /** The pre-send banner's "Connect a model" action — the host's own
   * navigation into Settings → AI providers. Undefined still renders the
   * banner, just with an inert button, matching every other optional
   * action this file wires. */
  readonly onConnectModel?: () => void;
}) {
  const queryClient = useQueryClient();
  const refreshWorkbenchLists = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: workbenchesQueryKeyPrefix(tenantId),
    });
  }, [queryClient, tenantId]);
  const { state: workbenchesState, reload: reloadWorkbenches } =
    useWorkbenchLists(tenantId);
  const [selectedWorkbenchId, setSelectedWorkbenchId] = useState<string | null>(
    null,
  );
  const activeWorkbenchId = controlledWorkbenchId ?? selectedWorkbenchId;
  const setActiveWorkbenchId = (id: string) => {
    setSelectedWorkbenchId(id);
    onWorkbenchChange?.(id);
  };
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  // CL-6833: catch-up `fetchRunningTurn` failure must surface a banner with
  // Retry — never look idle. `resumeAttempt` re-arms the effect on Retry.
  const [resumeFailedRefId, setResumeFailedRefId] = useState<string | null>(
    null,
  );
  const [resumeAttempt, setResumeAttempt] = useState(0);
  // null = workbench root feed. A concrete id opens that thread in the same
  // geometry (timeline + composer). pendingParentMessageId is set when the
  // user opens a reply on a message that has no thread yet.
  // Thread navigation is resolved after the feed below, which it reads.
  // This composer's own optimistic sends — see `mergePendingSends`. A
  // workbench switch drops whatever was pending in the previous workbench:
  // its composer submit targeted that workbench, not wherever the reader
  // navigated to next.

  const composerRef = useRef<ComposerHandle>(null);

  const feed = useWorkbenchFeed({
    tenantId,
    activeWorkbenchId,
    ...(onWorkbenchNotFound !== undefined ? { onWorkbenchNotFound } : {}),
  });
  const { threads, rootThreadId, pinsStatus, refreshFeed } = feed;

  const navigation = useThreadNavigation({
    tenantId,
    activeWorkbenchId,
    threads,
    rootThreadId,
    threadsLoaded: feed.threadsLoaded,
    refetchThreads: feed.refetchThreads,
  });
  const {
    openThreadId,
    pendingParentMessageId,
    inThreadView,
    openThreadParent,
    threadTitle,
    depth1Threads,
    subThreadsByParentId,
    openThreadForMessage,
    forkMessage,
    openThreadById,
    closeThread,
  } = navigation;

  const { messagesState, threadMetaByMessageId } = useWorkbenchTimelineView({
    tenantId,
    activeWorkbenchId,
    feed,
    navigation,
  });

  // Picking a default workbench is this component's own fallback for "no
  // workbench named in the URL yet".
  useEffect(() => {
    if (workbenchesState.kind !== "ready") return;
    if (activeWorkbenchId !== null) return;
    const first = workbenchesState.workbenches[0] ?? workbenchesState.chats[0];
    if (first !== undefined) setActiveWorkbenchId(first.id);
  }, [workbenchesState, activeWorkbenchId]);

  // Reaction/pin toggles never refetch on completion: the same
  // `chat.reaction`/`chat.pin` event the actor's own toggle provokes comes
  // back over this workbench's own stream (including to the actor's own
  // connection) and is folded into the messages/pins cache by
  // `applyStreamReaction`/`applyStreamPin` below — a second, response-driven
  // refresh here would be exactly the redundant refetch CL-6328 removes.
  const handleToggleReaction = useCallback(
    (messageId: string, emoji: string) => {
      if (activeWorkbenchId === null) return;
      toggleReaction(tenantId, activeWorkbenchId, messageId, emoji).catch(() =>
        toast(CHAT_STRINGS.reactionToggleError),
      );
    },
    [tenantId, activeWorkbenchId],
  );

  // CL-7201: unlike the reaction/pin handlers above, this rethrows after
  // toasting — the composer's own `onStop` awaits the returned promise
  // and re-enables its Stop button on rejection, so a genuinely failed
  // request (network, a denied grant) never leaves the button stuck
  // disabled for the rest of the turn. The timeline's cancelled-turn
  // notice, not this response, is what actually clears the typing
  // indicator once (or if) the turn settles.
  const handleStopTurn = useCallback(() => {
    if (activeWorkbenchId === null) return Promise.resolve();
    return cancelWorkbenchTurn(tenantId, activeWorkbenchId).catch((err) => {
      toast(CHAT_STRINGS.turnCancelError);
      throw err;
    });
  }, [tenantId, activeWorkbenchId]);

  const handlePinMessage = useCallback(
    (messageId: string) => {
      if (activeWorkbenchId === null) return;
      pinMessage(tenantId, activeWorkbenchId, messageId).catch(() =>
        toast(CHAT_STRINGS.pinMessageError),
      );
    },
    [tenantId, activeWorkbenchId],
  );

  const handleUnpinMessage = useCallback(
    (messageId: string) => {
      if (activeWorkbenchId === null) return;
      unpinMessage(tenantId, activeWorkbenchId, messageId).catch(() =>
        toast(CHAT_STRINGS.unpinMessageError),
      );
    },
    [tenantId, activeWorkbenchId],
  );

  const reactionActions: ReactionActions = useMemo(
    () => ({ onToggle: handleToggleReaction }),
    [handleToggleReaction],
  );
  const pinActions: PinActions = useMemo(
    () => ({ onPin: handlePinMessage, onUnpin: handleUnpinMessage }),
    [handlePinMessage, handleUnpinMessage],
  );

  function jumpToMessage(messageId: string) {
    document
      .getElementById(messageDomId(messageId))
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  const composerMounted =
    !settingsOpen &&
    activeWorkbenchId !== null &&
    messagesState.kind === "ready";

  useEffect(() => {
    if (registerComposerInsert === undefined) return;
    if (!composerMounted) {
      registerComposerInsert(null);
      return;
    }
    registerComposerInsert((text) => composerRef.current?.insertText(text));
    return () => registerComposerInsert(null);
  }, [registerComposerInsert, composerMounted]);

  const { typingState, handleStreamEvent: handleTypingEvent } =
    useTypingIndicator(currentUser?.principalId, activeWorkbenchId);
  const {
    streamingReply,
    replyTimedOutRefId,
    handleStreamEvent: handleStreamingReplyEvent,
    noteAwaitingReply,
    resumeFromTurn,
  } = useStreamingReply(activeWorkbenchId);
  const { activity: turnActivity, handleStreamEvent: handleTurnActivityEvent } =
    useTurnActivity(activeWorkbenchId);
  const { roster: presenceRoster, handleStreamEvent: handlePresenceEvent } =
    useWorkbenchPresenceRoster(activeWorkbenchId);

  // "Here at all" comes for free from the open `/stream` connection itself
  // (see `packages/chat/src/workbench-presence.ts`) — this ping only
  // refreshes `lastActiveAt` for a tab that's been backgrounded a while,
  // fired on the reader actually coming back rather than on an interval.
  useEffect(() => {
    if (activeWorkbenchId === null) return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      void pingWorkbenchPresence(tenantId, activeWorkbenchId);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [tenantId, activeWorkbenchId]);

  // Opening Settings swaps `WorkbenchTimeline` out for `WorkbenchSettingsSurface`
  // entirely (see the early `settingsOpen` return below) — closing it
  // remounts a fresh `WorkbenchTimeline` with no memory of where the reader
  // was. A ref (not state) holds each workbench's last snapshot: recording it
  // never needs to trigger a re-render, only be there the next time this
  // workbench's `WorkbenchTimeline` mounts.
  const scrollSnapshotsRef = useRef<ReadonlyMap<string, ScrollSnapshot>>(
    new Map(),
  );
  const restoredScrollSnapshot =
    activeWorkbenchId !== null
      ? scrollSnapshotsRef.current.get(activeWorkbenchId)
      : undefined;
  const handleScrollSnapshot = useCallback(
    (snapshot: ScrollSnapshot) => {
      if (activeWorkbenchId === null) return;
      scrollSnapshotsRef.current = withScrollSnapshot(
        scrollSnapshotsRef.current,
        activeWorkbenchId,
        snapshot,
      );
    },
    [activeWorkbenchId],
  );

  // Every event applies straight into the query cache it describes rather
  // than triggering a refetch (CL-6328, §6/1.2): each payload already
  // carries what a subscriber needs, so there is no "invalidate, then
  // fetch" fallback left beside this. `chat.agent` needs no cache
  // application of its own — it's fully owned by
  // `handleStreamingReplyEvent`/`handleTurnActivityEvent`, and the real
  // message it eventually produces arrives as its own `chat.message`.
  useWorkbenchStream(
    activeWorkbenchId !== null
      ? workbenchStreamUrl(tenantId, activeWorkbenchId)
      : "",
    (eventType, data) => {
      handleTypingEvent(eventType, data);
      handleStreamingReplyEvent(eventType, data);
      handleTurnActivityEvent(eventType, data);
      handlePresenceEvent(eventType, data);
      if (activeWorkbenchId === null) return;
      switch (eventType) {
        case "chat.message": {
          const parsed = ChatMessageEventData(data);
          if (parsed instanceof type.errors) {
            toast(CHAT_STRINGS.streamMessageDropped);
            refreshFeed();
            break;
          }
          applyStreamMessage(queryClient, tenantId, activeWorkbenchId, {
            id: parsed.id,
            createdAt: parsed.createdAt,
            parts: parsed.parts,
            sender: parsed.sender,
            ...(parsed.threadId !== null ? { threadId: parsed.threadId } : {}),
          });
          break;
        }
        case "chat.reaction": {
          const parsed = ChatReactionEventData(data);
          if (!(parsed instanceof type.errors)) {
            applyStreamReaction(
              queryClient,
              tenantId,
              activeWorkbenchId,
              parsed,
              currentUser?.principalId,
            );
          }
          break;
        }
        case "chat.pin": {
          const parsed = ChatPinEventData(data);
          if (!(parsed instanceof type.errors)) {
            applyStreamPin(queryClient, tenantId, activeWorkbenchId, parsed);
          }
          break;
        }
        case "chat.settings": {
          const parsed = ChatSettingsEventData(data);
          if (!(parsed instanceof type.errors)) {
            connectGithubActions?.notifySettingsChanged().catch((cause) => {
              reportError(cause, {
                operation: "chat.notifyGithubSettingsChanged",
                tenantId,
                roomId: activeWorkbenchId,
              });
            });
            connectServiceActions?.notifySettingsChanged().catch((cause) => {
              reportError(cause, {
                operation: "chat.notifyServiceSettingsChanged",
                tenantId,
                roomId: activeWorkbenchId,
              });
            });
          }
          break;
        }
        case WORKBENCHES_MUTATED_STREAM_TYPE: {
          applyStreamWorkbenchesMutated(data);
          break;
        }
      }
    },
    refreshFeed,
    {},
    (eventType) => {
      if (eventType !== "chat.message") return;
      toast(CHAT_STRINGS.streamMessageDropped);
      refreshFeed();
    },
  );

  /** The one door into the workbench settings surface — the gear button and
   * the composer's `/agents` command both go through this so the section
   * that lands is always the one the caller meant to open. */
  function openWorkbenchSettings(
    section: WorkbenchSettingsSectionId = "general",
    entityId?: string,
  ) {
    onSettingsOpenChange?.(true, section, entityId);
  }

  async function handleInvite(definitionId: string) {
    if (activeWorkbenchId === null) return;
    await inviteAgent(tenantId, activeWorkbenchId, definitionId);
    // The invited agent's address lands on the workbench's participants
    // (the mention popover picks it up via the reload below); its join
    // notice lands on the timeline via its own `chat.message` stream event
    // (applied straight into the messages cache), not a refetch here.
    refreshWorkbenchLists();
  }

  /**
   * The optimistic core both a fresh composer submit and a bubble's own
   * Retry button drive: adds (or resets) a pending entry before the
   * request goes out, so the sender sees their message land in the
   * timeline immediately rather than waiting on the round-trip. Once the
   * POST resolves, the confirmed item (built straight from its response —
   * no extra round-trip) replaces the pending entry in the very same
   * state update: there is never a render where the message has vanished
   * from both `pendingSends` and `messagesState.items` while a fresh
   * `GET` is still in flight to reintroduce it, and never a render where
   * both the pending and confirmed copies show at once. The follow-up
   * background `loadMessages` still runs to pick up server-only detail
   * (real sender record, reactions, thread meta) — it settles into that
   * data under the same `clientId` key, so it never re-triggers the
   * mount/unmount swap this replaces. A rejected send flips the pending
   * entry to `"failed"` in place instead — never a status line
   * disconnected from the message it describes.
   */
  const activeWorkbench =
    workbenchesState.kind === "ready"
      ? [...workbenchesState.workbenches, ...workbenchesState.chats].find(
          (workbench) => workbench.id === activeWorkbenchId,
        )
      : undefined;
  const activeWorkbenchDisplayTitle =
    activeWorkbench !== undefined
      ? displayWorkbenchTitle(activeWorkbench.title, activeWorkbench.id)
      : undefined;
  const isActiveChat =
    activeWorkbench !== undefined &&
    isKnownWorkbenchKind(activeWorkbench.kind) &&
    activeWorkbench.kind === "chat";
  const activeChatAgent = isActiveChat
    ? activeWorkbench?.participants.find((participant) =>
        isAgentAddress(participant.address),
      )
    : undefined;

  const hasAgentParticipant = (activeWorkbench?.participants ?? []).some(
    (participant) => isAgentAddress(participant.address),
  );

  const resumeAgentAddress = (activeWorkbench?.participants ?? []).find(
    (participant) => isAgentAddress(participant.address),
  )?.address;

  // CL-6380: a turn runs entirely server-side — this component mounting or
  // unmounting never starts or stops it (see `useWorkbenchStream`'s own
  // header: unmount only closes the `EventSource`, nothing server-side).
  // So a fresh mount (first visit, or a return after navigating away while
  // a reply was still streaming) asks once whether the agent has a turn
  // still running and, if so, replays its committed text immediately
  // rather than showing nothing until the next live token arrives. Any
  // live event that beats this fetch back always wins — see
  // `resumeFromTurn`'s own guard.
  // CL-6833: a failed catch-up must not swallow into idle — report a ref
  // and keep `ResumeFailedBanner` visible until Retry succeeds (or the
  // workbench changes).
  useEffect(() => {
    if (activeWorkbenchId === null || resumeAgentAddress === undefined) {
      setResumeFailedRefId(null);
      return;
    }
    let cancelled = false;
    fetchRunningTurn(tenantId, activeWorkbenchId, resumeAgentAddress)
      .then((runningTurn) => {
        if (cancelled) return;
        setResumeFailedRefId(null);
        resumeFromTurn(runningTurn);
      })
      .catch((cause) => {
        if (cancelled) return;
        const refId = reportError(cause, {
          operation: "chat.resumeRunningTurn",
          tenantId,
          roomId: activeWorkbenchId,
          agentId: resumeAgentAddress,
        });
        setResumeFailedRefId(refId);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, activeWorkbenchId, resumeAgentAddress, resumeAttempt]);

  const handleRetryResume = useCallback(() => {
    setResumeAttempt((attempt) => attempt + 1);
  }, []);

  const { pendingSends, handleSend, retryPendingSend, discardPendingSend } =
    useOptimisticSends({
      tenantId,
      activeWorkbenchId,
      currentUserPrincipalId: currentUser?.principalId,
      openThreadId,
      pendingParentMessageId,
      openThreadById,
      noteAwaitingReply,
      hasAgentParticipant,
      restoreDraft: (text) => composerRef.current?.insertText(text),
    });

  /** Retry on a failed-turn strip: sends the recovered text
   * (`findRetryText`) straight back through the normal send path — same
   * as the person typing it and hitting Enter — rather than parking it
   * in the composer for them to resend by hand. */
  const handleRetryFailedTurn = useCallback(
    async (_item: TimelineMessageItem, retryText?: string) => {
      if (retryText === undefined) return;
      await handleSend({ text: retryText, attachments: [] });
    },
    [handleSend],
  );

  const catalogQuery = useQuery({
    queryKey: ["tenant", tenantId, "resolved-catalog"],
    queryFn: () => getResolvedCatalog(tenantId),
  });
  const workbenchAgentsQuery = useQuery({
    queryKey: [
      "tenant",
      tenantId,
      "chat",
      "workbench-agents",
      activeWorkbenchId,
    ],
    queryFn: () =>
      activeWorkbenchId !== null
        ? listWorkbenchAgents(tenantId, activeWorkbenchId)
        : Promise.resolve([]),
    enabled: activeWorkbenchId !== null,
  });
  // `/routine`'s and "New routine in this space"'s optional preselection
  // (CL-7356): exactly one agent participant hands its definition asset id
  // straight to the routine panel's picker, visibly and replaceably — zero
  // or several participants leave the picker with nothing chosen, same as
  // opening it from `/routines` (CL-7357). Not a guarantee: this reads
  // `workbenchAgentsQuery`'s current data, which can still be loading (or
  // mid-refetch after a participant just joined/left) the moment `/routine`
  // fires — a person who types it before the query resolves gets no
  // preselection even with exactly one agent, silently. In the common case
  // the query is already warm (`failedTurnRecovery` below reads the same
  // data), so this is rarely hit in practice; it's a soft nicety, not
  // something a caller should rely on always firing.
  const singleWorkbenchAgentDefinitionAssetId: string | undefined =
    workbenchAgentsQuery.data?.length === 1
      ? workbenchAgentsQuery.data[0]?.definitionAssetId
      : undefined;
  // Person-facing display names for this workbench's agents (CL-6424),
  // keyed by participant address. Memoized so `MessageParts`'s memo guard
  // (CL-6625) keeps working: a fresh Map every render would read as new
  // props on every row and re-render the whole timeline per token.
  const agentDisplayNames: AgentDisplayNames = useMemo(
    () => agentDisplayNamesFromAgents(workbenchAgentsQuery.data ?? []),
    [workbenchAgentsQuery.data],
  );
  const failedTurnRecovery = useMemo((): FailedTurnRecovery => {
    const definitionIdByAddress: Record<string, string> = {};
    for (const agent of workbenchAgentsQuery.data ?? []) {
      definitionIdByAddress[agent.address] = agent.definitionId;
    }
    return {
      models: failedTurnModelChoices(catalogQuery.data ?? []),
      toolCapableModels: failedTurnToolCapableModelChoices(
        catalogQuery.data ?? [],
      ),
      definitionIdByAddress,
      onApplyModel: async ({ definitionId, address, canonicalName }) => {
        if (activeWorkbenchId === null) return;
        await addAgentCapability(tenantId, definitionId, {
          kind: "model",
          canonicalName,
        });
        await refreshWorkbenchAgent(tenantId, activeWorkbenchId, address);
      },
      onOpenAgentSettings: (definitionId) => {
        openWorkbenchSettings("agents", definitionId);
      },
    };
  }, [
    catalogQuery.data,
    workbenchAgentsQuery.data,
    tenantId,
    activeWorkbenchId,
  ]);

  const addressedMessageParts = useMemo(
    () =>
      lastHumanMessageParts(
        mergePendingSends(
          messagesState.kind === "ready" ? messagesState.items : [],
          pendingSends,
          currentUser?.principalId,
        ),
      ),
    [messagesState, pendingSends, currentUser?.principalId],
  );

  // The mention popover's "Bring in…" group: only a `workbench` grows its
  // participants after creation (a chat's counterpart is fixed at
  // creation — see `workbench-service.ts`'s `joinHumanParticipant`/
  // `launchAndJoinAgent` doc comments), so these only fetch for that
  // kind, and never before a workbench is actually selected.
  const bringInEnabled =
    activeWorkbenchId !== null &&
    activeWorkbench !== undefined &&
    isKnownWorkbenchKind(activeWorkbench.kind) &&
    activeWorkbench.kind === "workbench";
  const invitableAgentsQuery = useQuery({
    queryKey: ["tenant", tenantId, "chat", "invitable", activeWorkbenchId],
    queryFn: () =>
      activeWorkbenchId !== null
        ? listInvitableDefinitions(tenantId, activeWorkbenchId)
        : Promise.resolve([]),
    enabled: bringInEnabled,
  });
  const bringInMembersQuery = useQuery({
    queryKey: ["tenant", tenantId, "chat", "bring-in-members"],
    queryFn: () =>
      listMembers !== undefined ? listMembers(tenantId) : Promise.resolve([]),
    enabled: bringInEnabled && listMembers !== undefined,
  });
  const bringInLists = resolveBringInLists({
    members: bringInMembersQuery,
    invitableAgents: invitableAgentsQuery,
  });
  const bringInLoadError = bringInLoadErrorMessage(
    bringInLists.failures,
    bringInLists.firstError,
  );

  const offerInviteControl = shouldOfferInviteControl({
    kind: activeWorkbench?.kind,
    invitableAgents: invitableAgentsQuery.isSuccess
      ? (invitableAgentsQuery.data ?? [])
      : undefined,
    ...(bringInMembersQuery.isSuccess
      ? { bringInMembers: bringInMembersQuery.data ?? [] }
      : {}),
  });

  // A settings URL for a workbench id that resolved workbenches don't contain
  // (deleted, mistyped, cross-tenant) would otherwise leave the surface
  // silently showing the ordinary chat view under a lying /settings URL —
  // correct the route instead of no-opping.
  useEffect(() => {
    if (!settingsOpen) return;
    if (workbenchesState.kind !== "ready") return;
    if (activeWorkbenchId === null) return;
    if (activeWorkbench !== undefined) return;
    onSettingsOpenChange?.(false);
  }, [
    settingsOpen,
    workbenchesState.kind,
    activeWorkbenchId,
    activeWorkbench,
    onSettingsOpenChange,
  ]);

  // CL-6796: a routed id missing from the ready workbench list is NOT proof
  // the room is gone — create→navigate races the React Query list cache, so
  // a freshly created id is absent until refetch. Only an authoritative
  // messages/workbench fetch 404 marks the room gone. While the list miss
  // coincides with messages still loading, hold the loading treatment so we
  // neither flash not-found nor paint Invite / composer / Untitled chrome.
  const workbenchMissingFromList =
    workbenchesState.kind === "ready" &&
    activeWorkbenchId !== null &&
    activeWorkbench === undefined;
  const workbenchGone =
    messagesState.kind === "error" && messagesState.workbenchNotFound;
  const awaitingWorkbenchEvidence =
    workbenchMissingFromList &&
    !workbenchGone &&
    messagesState.kind !== "ready";

  // Who's live in this workbench right now, beyond the static participants
  // list — derived from this workbench's own `chat.presence`/
  // `chat.presence.snapshot` stream events (CL-6328), never a second
  // connection or an HTTP heartbeat poll. Display name and color are
  // resolved client-side (the roster itself carries only ids) the same way
  // `typingLabel` resolves a typing ping's principal.
  const presenceMembers: readonly PresenceMember[] = useMemo(
    () =>
      presenceRoster.map((member) => {
        return {
          principalId: member.principalId,
          displayName: typingLabel(
            member.principalId,
            activeWorkbench?.participants ?? [],
            currentUser,
          ),
          avatarClassName: avatarClassForPrincipal(member.principalId),
        };
      }),
    [presenceRoster, activeWorkbench?.participants, currentUser],
  );

  // Static member stack (square) vs live presence (round) — never one
  // combined circular team stack.
  const memberStack = buildMemberAvatarStack(
    activeWorkbench?.participants ?? [],
    agentDisplayNames,
    currentUser,
  );
  const visibleMemberStack = memberStack.slice(0, TEAM_AVATAR_STACK_LIMIT);
  const memberStackOverflow = memberStack.length - visibleMemberStack.length;
  const visiblePresenceStack = presenceMembers.slice(
    0,
    TEAM_AVATAR_STACK_LIMIT,
  );
  const presenceStackOverflow =
    presenceMembers.length - visiblePresenceStack.length;

  const showRoomChrome =
    workbenchesState.kind === "ready" &&
    activeWorkbenchId !== null &&
    !workbenchGone &&
    !awaitingWorkbenchEvidence;

  const roomTitle =
    activeWorkbenchDisplayTitle || CHAT_STRINGS.unnamedWorkbench;

  const headerActions = (
    <>
      {depth1Threads.length > 0 ? (
        <details className="chat-threads-menu">
          <summary className="chat-threads-menu-trigger">
            {CHAT_STRINGS.threadsMenuCount(depth1Threads.length)}
            <CaretDown className="size-3.5 opacity-70" />
          </summary>
          <div className="chat-threads-menu-panel" role="menu">
            {depth1Threads.map((thread) => (
              <div key={thread.id} className="chat-threads-menu-group">
                <button
                  type="button"
                  role="menuitem"
                  className="chat-threads-menu-item"
                  onClick={() => {
                    openThreadById(thread.id);
                  }}
                >
                  {thread.title ??
                    (thread.parentMessageId !== null
                      ? `Reply · ${thread.parentMessageId.slice(0, 8)}`
                      : "Thread")}
                </button>
                {(subThreadsByParentId.get(thread.id) ?? []).map(
                  (subThread) => (
                    <button
                      key={subThread.id}
                      type="button"
                      role="menuitem"
                      className="chat-threads-menu-item chat-threads-menu-item-nested"
                      onClick={() => {
                        openThreadById(subThread.id);
                      }}
                    >
                      {subThread.title ??
                        (subThread.parentMessageId !== null
                          ? `Fork · ${subThread.parentMessageId.slice(0, 8)}`
                          : "Sub-thread")}
                    </button>
                  ),
                )}
              </div>
            ))}
          </div>
        </details>
      ) : null}
      {visibleMemberStack.length > 0 ? (
        <div
          className="chat-member-stack"
          aria-label={CHAT_STRINGS.workbenchMembersLabel}
        >
          {visibleMemberStack.map((entry) =>
            entry.tone === "agent" ? (
              <span
                key={entry.key}
                className="member-avatar !overflow-hidden !bg-transparent !p-0"
                data-agent="true"
                title={entry.label}
              >
                <CorbitAvatar
                  size="sm"
                  ariaLabel={entry.label}
                  className="!size-full"
                />
              </span>
            ) : (
              <span
                key={entry.key}
                className={`member-avatar ${entry.avatarClassName ?? ""}`}
                title={entry.label}
              >
                {entry.initials}
              </span>
            ),
          )}
          {memberStackOverflow > 0 ? (
            <span
              className="chat-member-stack-overflow"
              title={CHAT_STRINGS.teamStackOverflow(memberStackOverflow)}
            >
              +{memberStackOverflow}
            </span>
          ) : null}
        </div>
      ) : null}
      {presenceMembers.length > 0 ? (
        <div
          className="chat-presence-stack"
          aria-label={CHAT_STRINGS.workbenchPresenceLabel}
        >
          {visiblePresenceStack.map((member) => (
            <span
              key={member.principalId}
              className={`chat-presence-avatar ${member.avatarClassName}`}
              title={member.displayName}
            >
              {member.displayName.slice(0, 1).toUpperCase()}
            </span>
          ))}
          {presenceStackOverflow > 0 ? (
            <span
              className="chat-presence-stack-overflow"
              title={CHAT_STRINGS.teamStackOverflow(presenceStackOverflow)}
            >
              +{presenceStackOverflow}
            </span>
          ) : null}
        </div>
      ) : null}
      {offerInviteControl ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setInviteDialogOpen(true)}
        >
          <UserPlus />
          {CHAT_STRINGS.inviteAgentAction}
        </Button>
      ) : null}
      <div className="chat-workbench-settings-slot">
        <Button
          variant="ghost"
          size="icon"
          aria-label={CHAT_STRINGS.workbenchSettingsAction}
          title={CHAT_STRINGS.workbenchSettingsAction}
          onClick={() => openWorkbenchSettings()}
        >
          <SlidersHorizontal />
        </Button>
      </div>
    </>
  );

  const threadBreadcrumb = inThreadView ? (
    <nav className="chat-thread-breadcrumb" aria-label="Thread">
      <button
        type="button"
        className="chat-thread-breadcrumb-link"
        onClick={closeThread}
      >
        {roomTitle}
      </button>
      <span className="chat-thread-breadcrumb-sep" aria-hidden="true">
        /
      </span>
      {openThreadParent !== undefined ? (
        <>
          <button
            type="button"
            className="chat-thread-breadcrumb-link"
            onClick={() => {
              openThreadById(openThreadParent.id);
            }}
          >
            {openThreadParent.title ?? "Thread"}
          </button>
          <span className="chat-thread-breadcrumb-sep" aria-hidden="true">
            /
          </span>
        </>
      ) : null}
      <span
        className="chat-thread-breadcrumb-current"
        {...(headerSlot === undefined
          ? { "aria-current": "page" as const }
          : {})}
      >
        {threadTitle}
      </span>
    </nav>
  ) : null;

  const roomChrome: ChatHeaderChrome = {
    crumbs: [{ label: roomTitle }],
    ...(inThreadView && threadBreadcrumb !== null
      ? { subtitle: threadBreadcrumb }
      : activeChatAgent !== undefined
        ? { subtitle: <AgentBadge /> }
        : {}),
    actions: headerActions,
  };

  // The workbench header only exists once a workbench is active; the loading,
  // error, and no-workbench states still carry the host's leading control (the
  // shell's col2 toggle) so the sidebar stays reachable. When `headerSlot`
  // owns the bar, that chrome lifts out of `.chat-workbench-header`.
  const bareLeadingHeader =
    headerSlot === undefined &&
    headerLeading !== undefined &&
    !showRoomChrome ? (
      <div className="chat-workbench-header">{headerLeading}</div>
    ) : null;

  const stageHeader =
    headerSlot !== undefined
      ? headerSlot(showRoomChrome ? roomChrome : WORKBENCHES_LIST_CHROME)
      : bareLeadingHeader;

  if (
    settingsOpen &&
    activeWorkbenchId !== null &&
    activeWorkbench !== undefined
  ) {
    return (
      <>
        <div className="chat-workspace">
          <WorkbenchSettingsSurface
            key={activeWorkbenchId}
            tenantId={tenantId}
            workbenchId={activeWorkbenchId}
            workbenchTitle={
              displayWorkbenchTitle(
                activeWorkbench.title,
                activeWorkbench.id,
              ) || CHAT_STRINGS.unnamedWorkbench
            }
            section={settingsSection}
            onSectionChange={(next) => onSettingsSectionChange?.(next)}
            entityId={settingsEntityId}
            {...(onSettingsEntityIdChange !== undefined
              ? { onEntityIdChange: onSettingsEntityIdChange }
              : {})}
            onBack={() => onSettingsOpenChange?.(false)}
            onInviteParticipant={() => {
              onSettingsOpenChange?.(false);
              setInviteDialogOpen(true);
            }}
            onSaved={refreshWorkbenchLists}
            {...(currentUser !== undefined
              ? { currentUserPrincipalId: currentUser.principalId }
              : {})}
          />
        </div>
        <InviteAgentDialog
          open={inviteDialogOpen}
          onOpenChange={setInviteDialogOpen}
          tenantId={tenantId}
          workbenchId={activeWorkbenchId}
          onInvite={handleInvite}
        />
      </>
    );
  }

  return (
    <>
      <div className="chat-workspace">
        <div className="chat-main">
          {stageHeader}
          {workbenchesState.kind === "loading" ? (
            <WorkbenchLoadingState />
          ) : workbenchesState.kind === "error" ? (
            <EmptyState
              icon={<WarningCircle />}
              title={`Couldn't load ${CHAT_STRINGS.couldNotLoadWorkbenches}`}
              description={workbenchesState.message}
              action={
                <Button
                  variant="outline"
                  onClick={() => void reloadWorkbenches()}
                >
                  Try again
                </Button>
              }
            />
          ) : activeWorkbenchId === null ? (
            <EmptyState
              icon={<ChatCircle />}
              title={CHAT_STRINGS.noChatSelectedTitle}
              description={CHAT_STRINGS.noChatSelectedDescription}
            />
          ) : workbenchGone ? (
            // CL-6796: fail closed — never mount Invite / composer / room
            // header over a missing or 404'd workbench. Recovery is the
            // whole stage. Authoritative evidence only (messages 404), never
            // a stale ready-list miss alone.
            <EmptyState
              icon={<WarningCircle />}
              title={CHAT_STRINGS.workbenchNotFoundTitle}
              description={CHAT_STRINGS.workbenchNotFoundDescription}
              action={workbenchNotFoundRecoveryAction({
                ...(onGoToMissionControl !== undefined
                  ? { onGoToMissionControl }
                  : {}),
                ...(onNewWorkbench !== undefined ? { onNewWorkbench } : {}),
                ...(onBackToWorkbenchList !== undefined
                  ? { onBackToWorkbenchList }
                  : {}),
              })}
            />
          ) : awaitingWorkbenchEvidence ? (
            // List cache is ready but lacks this id — wait for messages to
            // prove the room exists (create→navigate) or 404 (true miss)
            // before painting room chrome or the not-found empty state.
            <WorkbenchLoadingState />
          ) : (
            <>
              {headerSlot === undefined ? (
                <div className="chat-workbench-header">
                  {headerLeading}
                  {inThreadView ? (
                    threadBreadcrumb
                  ) : (
                    <div className="chat-workbench-identity">
                      <h2 className="chat-workbench-title">{roomTitle}</h2>
                      {activeChatAgent !== undefined ? <AgentBadge /> : null}
                    </div>
                  )}
                  <div className="chat-workbench-actions">{headerActions}</div>
                </div>
              ) : null}
              {messagesState.kind === "loading" ? (
                <WorkbenchLoadingState />
              ) : messagesState.kind === "error" ? (
                <EmptyState
                  icon={<WarningCircle />}
                  title={`Couldn't load ${CHAT_STRINGS.couldNotLoadMessages}`}
                  description={messagesState.message}
                  action={
                    messagesState.isUnauthorized ? (
                      onSignIn !== undefined ? (
                        <Button variant="outline" onClick={onSignIn}>
                          Sign in
                        </Button>
                      ) : undefined
                    ) : (
                      <Button
                        variant="outline"
                        onClick={() => feed.refetchMessages()}
                      >
                        Try again
                      </Button>
                    )
                  }
                />
              ) : (
                <>
                  {!inThreadView ? (
                    <PinnedStrip status={pinsStatus} onJump={jumpToMessage} />
                  ) : null}
                  {openThreadParent !== undefined ? (
                    <div className="chat-thread-origin-banner">
                      {CHAT_STRINGS.forkThreadOriginBanner}{" "}
                      <button
                        type="button"
                        className="chat-thread-origin-banner-link"
                        onClick={() => {
                          openThreadById(openThreadParent.id);
                        }}
                      >
                        {openThreadParent.title ?? "Thread"}
                      </button>
                    </div>
                  ) : null}
                  <WorkbenchTimeline
                    settingUpAgent={
                      activeWorkbench?.kind === "chat" &&
                      typeof activeWorkbench.definitionId === "string" &&
                      !(activeWorkbench.participants ?? []).some(
                        (participant) => isAgentAddress(participant.address),
                      )
                    }
                    items={appendReplyTimedOutNotice(
                      mergeStreamingReply(
                        mergePendingSends(
                          messagesState.items,
                          pendingSends,
                          currentUser?.principalId,
                        ),
                        streamingReply,
                        activeWorkbench?.participants ?? [],
                      ),
                      replyTimedOutRefId,
                      activeWorkbench?.participants ?? [],
                    )}
                    participants={activeWorkbench?.participants ?? []}
                    {...(currentUser !== undefined ? { currentUser } : {})}
                    agentDisplayNames={agentDisplayNames}
                    threadMetaByMessageId={threadMetaByMessageId}
                    threadAffordanceMode={inThreadView ? "fork" : "reply"}
                    onOpenThread={
                      inThreadView ? forkMessage : openThreadForMessage
                    }
                    onEditMessage={(messageId) => {
                      if (messagesState.kind !== "ready") return;
                      const item = messagesState.items.find(
                        (message) => message.id === messageId,
                      );
                      if (item === undefined) return;
                      composerRef.current?.setText(messageText(item));
                    }}
                    {...(onOpenProfile !== undefined ? { onOpenProfile } : {})}
                    {...(onOpenArtifact !== undefined
                      ? { onOpenArtifact }
                      : {})}
                    {...(onOpenArtifactInLibrary !== undefined
                      ? { onOpenArtifactInLibrary }
                      : {})}
                    {...(onFixConnection !== undefined
                      ? { onFixConnection }
                      : {})}
                    {...(approvalActions !== undefined
                      ? { approvalActions }
                      : {})}
                    {...(blockResponses !== undefined
                      ? { blockResponses }
                      : {})}
                    {...(connectGithubActions !== undefined
                      ? { connectGithubActions }
                      : {})}
                    {...(connectServiceActions !== undefined
                      ? { connectServiceActions }
                      : {})}
                    reactionActions={reactionActions}
                    pinActions={pinActions}
                    onRetryFailedTurn={handleRetryFailedTurn}
                    failedTurnRecovery={failedTurnRecovery}
                    pendingActions={{
                      onRetry: retryPendingSend,
                      onDiscard: discardPendingSend,
                    }}
                    {...(restoredScrollSnapshot !== undefined
                      ? { scrollRestore: restoredScrollSnapshot }
                      : {})}
                    onScrollSnapshot={handleScrollSnapshot}
                    footer={
                      typingState !== null ? (
                        <TypingIndicator
                          label={typingLabel(
                            typingState.principalId,
                            activeWorkbench?.participants ?? [],
                            currentUser,
                          )}
                        />
                      ) : (
                        <AgentTypingIndicator
                          names={typingAgentNames(
                            streamingReply,
                            activeWorkbench?.participants ?? [],
                            addressedMessageParts,
                            agentDisplayNames,
                          )}
                        />
                      )
                    }
                  />
                  <TurnActivityStrip activity={turnActivity} />
                  <div className="chat-composer-stack">
                    {resumeFailedRefId !== null ? (
                      <ResumeFailedBanner
                        refId={resumeFailedRefId}
                        onRetry={handleRetryResume}
                      />
                    ) : null}
                    {hasUsableModel === false && hasAgentParticipant ? (
                      <NoUsableModelBanner
                        onConnectModel={() => onConnectModel?.()}
                      />
                    ) : null}
                    <Composer
                      ref={composerRef}
                      agents={mentionCandidatesFromParticipants(
                        activeWorkbench?.participants ?? [],
                        agentDisplayNames,
                      )}
                      participants={activeWorkbench?.participants ?? []}
                      agentDisplayNames={agentDisplayNames}
                      members={bringInLists.members}
                      invitableAgents={bringInLists.invitableAgents}
                      bringInLoadError={bringInLoadError}
                      placeholder={composerPlaceholderFor(activeWorkbench)}
                      onSend={handleSend}
                      running={isAwaitingReply(streamingReply)}
                      onStop={handleStopTurn}
                      onInviteAgent={() => setInviteDialogOpen(true)}
                      onOpenAgentsSettings={() =>
                        openWorkbenchSettings("agents")
                      }
                      onCreateRoutineInSpace={() => {
                        if (
                          onCreateRoutineInSpace !== undefined &&
                          activeWorkbenchId !== null
                        ) {
                          onCreateRoutineInSpace(
                            activeWorkbenchId,
                            singleWorkbenchAgentDefinitionAssetId,
                          );
                          return;
                        }
                        toast(CHAT_STRINGS.runRoutineUnavailable);
                      }}
                    />
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {activeWorkbenchId !== null &&
      !workbenchGone &&
      !awaitingWorkbenchEvidence ? (
        <InviteAgentDialog
          open={inviteDialogOpen}
          onOpenChange={setInviteDialogOpen}
          tenantId={tenantId}
          workbenchId={activeWorkbenchId}
          onInvite={handleInvite}
        />
      ) : null}
    </>
  );
}

function ChatWorkspaceFrame({ children }: { readonly children: ReactNode }) {
  return <div className="chat-workspace-frame">{children}</div>;
}

function withListHeader(
  headerSlot: ((chrome: ChatHeaderChrome) => ReactNode) | undefined,
  children: ReactNode,
): ReactNode {
  if (headerSlot === undefined) {
    return <ChatWorkspaceFrame>{children}</ChatWorkspaceFrame>;
  }
  return (
    <>
      {headerSlot(WORKBENCHES_LIST_CHROME)}
      <ChatWorkspaceFrame>{children}</ChatWorkspaceFrame>
    </>
  );
}

export function ChatWorkspace({
  tenant,
  workbenchId = null,
  onWorkbenchChange,
  currentUser,
  onOpenProfile,
  settingsOpen,
  onSettingsOpenChange,
  settingsSection,
  onSettingsSectionChange,
  settingsEntityId,
  onSettingsEntityIdChange,
  onOpenArtifact,
  onOpenArtifactInLibrary,
  onFixConnection,
  approvalActions,
  blockResponses,
  connectGithubActions,
  connectServiceActions,
  headerLeading,
  headerSlot,
  registerComposerInsert,
  listMembers,
  onCreateRoutineInSpace,
  onWorkbenchNotFound,
  onBackToWorkbenchList,
  onGoToMissionControl,
  onNewWorkbench,
  onSignIn,
  hasUsableModel,
  onConnectModel,
}: {
  readonly tenant: TenantResolution;
  /** Controlled active workbench (e.g. from the app's URL); null = pick the first. */
  readonly workbenchId?: string | null;
  /** Fired when the user selects a workbench, so the app can reflect it in the URL. */
  readonly onWorkbenchChange?: (workbenchId: string) => void;
  /**
   * The signed-in account, so its own messages render as "You" (or its
   * name) instead of matching no participant and falling back to
   * "Member". Host-supplied, the same way `tenant` is — this package
   * never resolves a session itself.
   */
  readonly currentUser?: CurrentUser;
  /** Open a member/agent ProfileCard in the host canvas (shell mock § Profile). */
  readonly onOpenProfile?: (subject: ProfileSubject) => void;
  /** Whether the routed workbench's settings surface should replace the
   * conversation stage — host-controlled from the URL (`/w/:id/settings`). */
  readonly settingsOpen?: boolean;
  /** Fired when the settings surface should open or close, so the host can
   * reflect it in the URL — see `ChatWorkspaceInner`'s prop of the same
   * name for the `section` argument's contract. */
  readonly onSettingsOpenChange?: (
    open: boolean,
    section?: WorkbenchSettingsSectionId,
    entityId?: string,
  ) => void;
  /** Which workbench settings tab is active — host-controlled from the URL
   * (`/w/:id/settings/:section`). */
  readonly settingsSection?: WorkbenchSettingsSectionId;
  /** Fired when the user switches tabs while the settings surface is
   * already open, so the host can reflect it in the URL. */
  readonly onSettingsSectionChange?: (
    section: WorkbenchSettingsSectionId,
  ) => void;
  /** Section sub-selection — host-controlled from the URL
   * (`/w/:id/settings/:section/:entityId`). */
  readonly settingsEntityId?: string | null;
  /** Fired when a settings section opens or closes its own detail, so the
   * host can deepen or clear the entity segment in the URL. */
  readonly onSettingsEntityIdChange?: (entityId: string | null) => void;
  /** Open a message's artifact chip — see `WorkbenchTimeline`'s `onOpenArtifact`. */
  readonly onOpenArtifact?: (part: Part & { kind: "file" }) => void;
  /** The chip's "Open in Library" affordance — see `WorkbenchTimeline`'s
   * `onOpenArtifactInLibrary`. */
  readonly onOpenArtifactInLibrary?: (part: Part & { kind: "file" }) => void;
  /** The classified-inference-failure text bubble's "Fix this connection"
   * action — see `WorkbenchTimeline`'s `onFixConnection` (CL-6092). */
  readonly onFixConnection?: () => void;
  /** The approve block's live round-trip — see `WorkbenchTimeline`'s
   * `approvalActions`. */
  readonly approvalActions?: ApprovalActions;
  /** The poll/form blocks' live round-trip — see `WorkbenchTimeline`'s
   * `blockResponses`. */
  readonly blockResponses?: BlockResponseActions;
  /** The connect-github block's live round-trip — see `WorkbenchTimeline`'s
   * `connectGithubActions`. */
  readonly connectGithubActions?: ConnectGithubActions;
  /** Host round-trip for the generic "connect-service" card. Undefined
   * renders every connect-service card in its disconnected framing. */
  readonly connectServiceActions?: ConnectServiceActions;
  /** Host-supplied control rendered first in the workbench header — the
   * shell's single col2 toggle, so chat carries the same top-bar chrome as
   * every other stage surface. Unused when `headerSlot` owns the bar. */
  readonly headerLeading?: ReactNode;
  /** Host-owned stage bar. When set, identity and primary actions render
   * through this slot (`StageTopBar`'s crumbs / subtitle / actions) instead
   * of `.chat-workbench-header`. */
  readonly headerSlot?: (chrome: ChatHeaderChrome) => ReactNode;
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly registerComposerInsert?: (
    insert: ((text: string) => void) | null,
  ) => void;
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly listMembers?: (
    tenantId: string,
  ) => Promise<readonly BringInMember[]>;
  /** "New routine in this space" — see `ChatWorkspaceInner`'s prop note. */
  readonly onCreateRoutineInSpace?: (
    workbenchId: string,
    preselectedAssetId?: string,
  ) => void;
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly onWorkbenchNotFound?: (workbenchId: string) => void;
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly onBackToWorkbenchList?: () => void;
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly onGoToMissionControl?: () => void;
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly onNewWorkbench?: () => void;
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly onSignIn?: () => void;
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly hasUsableModel?: boolean;
  /** See `ChatWorkspaceInner`'s prop of the same name. */
  readonly onConnectModel?: () => void;
}) {
  switch (tenant.kind) {
    case "ready":
      // Remount on tenant switch so prior-tenant state cannot leak.
      return (
        <ChatWorkspaceInner
          key={tenant.tenantId}
          tenantId={tenant.tenantId}
          workbenchId={workbenchId}
          {...(onWorkbenchChange !== undefined ? { onWorkbenchChange } : {})}
          {...(currentUser !== undefined ? { currentUser } : {})}
          {...(onOpenProfile !== undefined ? { onOpenProfile } : {})}
          {...(settingsOpen !== undefined ? { settingsOpen } : {})}
          {...(onSettingsOpenChange !== undefined
            ? { onSettingsOpenChange }
            : {})}
          {...(settingsSection !== undefined ? { settingsSection } : {})}
          {...(onSettingsSectionChange !== undefined
            ? { onSettingsSectionChange }
            : {})}
          {...(settingsEntityId !== undefined ? { settingsEntityId } : {})}
          {...(onSettingsEntityIdChange !== undefined
            ? { onSettingsEntityIdChange }
            : {})}
          {...(approvalActions !== undefined ? { approvalActions } : {})}
          {...(blockResponses !== undefined ? { blockResponses } : {})}
          {...(connectGithubActions !== undefined
            ? { connectGithubActions }
            : {})}
          {...(connectServiceActions !== undefined
            ? { connectServiceActions }
            : {})}
          {...(onOpenArtifact !== undefined ? { onOpenArtifact } : {})}
          {...(onOpenArtifactInLibrary !== undefined
            ? { onOpenArtifactInLibrary }
            : {})}
          {...(onFixConnection !== undefined ? { onFixConnection } : {})}
          {...(headerLeading !== undefined ? { headerLeading } : {})}
          {...(headerSlot !== undefined ? { headerSlot } : {})}
          {...(registerComposerInsert !== undefined
            ? { registerComposerInsert }
            : {})}
          {...(listMembers !== undefined ? { listMembers } : {})}
          {...(onCreateRoutineInSpace !== undefined
            ? { onCreateRoutineInSpace }
            : {})}
          {...(onWorkbenchNotFound !== undefined
            ? { onWorkbenchNotFound }
            : {})}
          {...(onBackToWorkbenchList !== undefined
            ? { onBackToWorkbenchList }
            : {})}
          {...(onGoToMissionControl !== undefined
            ? { onGoToMissionControl }
            : {})}
          {...(onNewWorkbench !== undefined ? { onNewWorkbench } : {})}
          {...(onSignIn !== undefined ? { onSignIn } : {})}
          {...(hasUsableModel !== undefined ? { hasUsableModel } : {})}
          {...(onConnectModel !== undefined ? { onConnectModel } : {})}
        />
      );
    case "empty":
      return withListHeader(
        headerSlot,
        <EmptyState
          icon={<ChatCircle />}
          title="No workbench yet"
          description="Create or join a workbench before chatting."
        />,
      );
    case "unauthenticated":
      return withListHeader(
        headerSlot,
        <EmptyState
          icon={<ChatCircle />}
          title="Sign in to continue"
          description="Your conversations live on a workbench — sign in to open them."
        />,
      );
    case "error":
      return withListHeader(
        headerSlot,
        <EmptyState
          icon={<WarningCircle />}
          title="Couldn't open this workbench"
          description={tenant.message}
        />,
      );
    case "loading":
      return withListHeader(headerSlot, <WorkbenchLoadingState />);
  }
}
