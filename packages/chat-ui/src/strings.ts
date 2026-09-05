// Every user-facing word the conversation surface prints, in one place.
// The package underneath calls everything a "workbench" — a `kind` string of
// "workbench" or "chat" — but the app decides what a human reads: a
// "workbench" is the product word for a conversation with an agent (each
// one its own tenancy). Nothing in the chat/* components inlines its own
// copy; it imports from here. There is no in-package new-workbench dialog
// any more (CL-6138): the one creation verb mints and navigates directly —
// see `apps/web/src/instant-agent-create.ts`.

function joinWithAnd(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Canonical create-workbench CTA and untitled-mint label (CL-6767). */
const NEW_WORKBENCH_LABEL = "New workbench";

export const CHAT_STRINGS = {
  workbenchesSectionLabel: "Pinned",
  chatsSectionLabel: "Workbenches",
  noWorkbenchesTitle: "No workbenches yet",
  noWorkbenchesDescription: "Create one to get started.",
  noChatSelectedTitle: "Select a conversation",
  noChatSelectedDescription:
    "Choose a workbench from the sidebar, or create a new one.",
  couldNotLoadWorkbenches: "workbenches",
  couldNotLoadMessages: "messages",
  workbenchNotFoundTitle: "This workbench isn't here anymore",
  workbenchNotFoundDescription:
    "It may have been deleted, or the link is out of date.",
  /** @deprecated Prefer Mission Control / New workbench recovery (CL-6796). */
  workbenchNotFoundAction: "Back to workbenches",
  workbenchNotFoundMissionControlAction: "Mission Control",
  workbenchNotFoundNewWorkbenchAction: NEW_WORKBENCH_LABEL,
  /** Create-workbench CTA on every mint surface (CL-6767). */
  newWorkbenchAction: NEW_WORKBENCH_LABEL,
  composerPlaceholder: "Send a message… use @ to mention an agent",
  composerPlaceholderChat: (name: string) => `Message ${name}…`,
  composerSend: "Send",
  composerSending: "Sending…",
  composerStop: "Stop",
  composerKeyboardHint: "Enter to send",
  composerAttach: "Attach files",
  composerAttachmentsLabel: "Selected attachments",
  composerRemoveAttachment: (name: string) => `Remove ${name}`,
  composerPreparing: "Preparing attachments…",
  composerAttachmentCountError: (max: number) =>
    `You can attach at most ${max} files.`,
  composerAttachmentPerFileError: (name: string, maxMiB: number) =>
    `"${name}" is too large (max ${maxMiB} MB per file).`,
  composerAttachmentTotalError: (maxMiB: number) =>
    `Those files total more than ${maxMiB} MB.`,
  composerAttachmentReadError: "Couldn't read one of those files — try again.",
  composerDictate: "Dictate",
  composerDictateStop: "Stop dictating",
  filePartLabel: "Attachment",
  emptyTimelineTitle: "No messages yet",
  // One honest headline for every waiting state \u2014 the reader never needs
  // to know which internal stage this is; that distinction stays in logs,
  // never in front of them.
  workbenchLoadingTitle: "Getting your workbench ready\u2026",
  workbenchLoadingTips: [
    "Tip: @mention an agent to bring them into the conversation",
    "Tip: every message can become a thread",
    "Tip: routines run work for you on a schedule",
    "Tip: press / for commands",
  ],
  emptyTimelineDescription: "Say something to get the conversation going.",
  emptyAgentTimelineDescription:
    "They're ready — send the first message to get started.",
  jumpToLatestAction: "Jump to latest",
  mentionEmpty: "No matches",
  mentionAgentsGroupLabel: "Agents",
  mentionPeopleGroupLabel: "People",
  mentionForbidden: "You can't add people to this workbench",
  mentionBringInLoadError: "Couldn't load people and agents to bring in",
  mentionMembersLoadError: "Couldn't load people to bring in",
  mentionInvitableLoadError: "Couldn't load agents to bring in",
  composerSlashEmpty: "No matching commands",
  composerSummarizeNoAgentError:
    "No agent in this conversation to summarize for — invite one first.",
  composerHelpTitle: "Slash commands",
  composerHelpNote: "Not sent as a message",
  composerHelpClose: "Close",
  runRoutineUnavailable: "Open Routines to create one",
  unnamedWorkbench: "Untitled conversation",
  newWorkbenchTitle: NEW_WORKBENCH_LABEL,
  unnamedRun: "Untitled agent",
  fallbackPartLabel: (kind: string) => `[${kind}]`,
  senderYou: "You",
  senderFallbackMember: "Member",
  agentBadgeLabel: "Agent",
  legacyBadgeLabel: "Legacy",
  eventAgentJoined: (displayName: string) => `${displayName} joined`,
  eventAgentJoinedUnknown: "An agent joined",
  eventAgentsJoined: (displayNames: readonly string[]) =>
    `${joinWithAnd(displayNames)} joined`,
  eventMembershipChanged: "Membership updated",
  eventSettingsChanged: "Settings updated",
  eventWorkbenchRenamed: (from: string, to: string): string =>
    `Renamed "${from}" to "${to}"`,
  eventWorkbenchRenamedTo: (to: string): string => `Renamed to "${to}"`,
  eventBlockResponsePoll: "A vote was recorded",
  eventBlockResponseForm: "A form was submitted",
  /** Plain-text form of the settle notice (CL-6741). EventLine renders
   * the same copy with "Plugins" as a `/plugins` link. */
  eventConnectionConnected: (displayName: string): string =>
    `${displayName} connected successfully. Manage in Plugins`,
  eventConnectionConnectedBeforePlugins: (displayName: string): string =>
    `${displayName} connected successfully. Manage in `,
  eventConnectionConnectedPlugins: "Plugins",
  eventGeneric: (event: string) => event.replace(/[.\-_]+/g, " "),

  inviteAgentAction: "Invite agent",
  workbenchMembersLabel: "Members",
  workbenchPresenceLabel: "Live",
  teamStackOverflow: (count: number) =>
    `${count} more ${count === 1 ? "member" : "members"}`,
  threadsMenuCount: (count: number) =>
    `${count} ${count === 1 ? "thread" : "threads"}`,
  inviteAgentDialogTitle: "Invite an agent",
  inviteAgentDialogDescription:
    "Launch one of your workbench's agents into this conversation.",
  inviteAgentEmptyTitle: "No agents to invite",
  inviteAgentEmptyDescription:
    "Add an agent to this workbench before inviting it here.",
  inviteAgentLoadError: "Couldn't load invitable agents",
  inviteAgentInviting: "Inviting…",
  inviteAgentInviteError: "Couldn't invite that agent — try again.",
  inviteAgentConflictError: "This workbench already has its agent.",
  inviteAgentQuickCreateAction: "Add",
  inviteAgentQuickCreating: "Adding…",
  inviteAgentQuickCreateError: "Couldn't add Jimmy — try again.",
  inviteAgentFirstPartyAttribution: "by Corbits",
  forkThreadAction: "Fork",
  forkThreadError: "Couldn't fork that message into a thread — try again.",
  replyInThreadAction: "Reply in thread",
  editMessageAction: "Edit",
  messageActionsMenuLabel: "Message actions",
  copyTextAction: "Copy text",
  copyTextCopiedToast: "Copied",
  copyTextError: "Couldn't copy — try again.",
  forkThreadOriginBanner: "Forked from a message in",
  workbenchCreatedToast: (title: string) => `Created · ${title}`,
  workbenchRenamedToast: (title: string) => `Renamed to ${title}`,
  workbenchRenameError: "Couldn't rename that workbench — try again.",
  workbenchPinnedToast: (pinned: boolean, title: string) =>
    pinned ? `Pinned ${title}` : `Unpinned ${title}`,
  workbenchPinToggleError: (pinned: boolean) =>
    pinned
      ? "Couldn't pin that workbench — try again."
      : "Couldn't unpin that workbench — try again.",
  agentDmOpenError: (name: string) =>
    `Couldn't open a conversation with ${name} — try again.`,
  reactionChipLabel: (emoji: string, count: number) =>
    `React with ${emoji} (${count})`,
  reactionAddAction: "Add reaction",
  reactionPickerLabel: "Choose a reaction",
  reactionPickerOptionLabel: (emoji: string) => `React with ${emoji}`,
  reactionToggleError: "Couldn't update that reaction — try again.",
  streamMessageDropped: "Couldn't apply that message live — refreshing.",
  pinMessageAction: "Pin message",
  unpinMessageAction: "Unpin message",
  pinMessageError: "Couldn't pin that message — try again.",
  unpinMessageError: "Couldn't unpin that message — try again.",
  turnCancelError: "Couldn't stop that turn — try again.",
  pinnedStripLabel: "Pinned messages",
  pinnedStripEmptyPreview: "Pinned message",
  pinnedStripJumpAction: (preview: string) => `Jump to: ${preview}`,
  pinnedStripLoadError: "Couldn't load pinned messages.",
  pendingSendLabel: "Sending…",
  pendingSendFailedLabel: "Not sent",
  pendingSendRetryAction: "Retry",
  pendingSendDiscardAction: "Discard",
  fallbackPartUnsupported: "Unsupported content",
  blockUnsupportedTitle: "Unsupported block",
  blockUnsupportedBody: (type: string) =>
    `This "${type}" block can't be shown here yet.`,
  blockApproveAction: "Approve",
  blockDenyAction: "Not now",
  blockApproveAllowStanding: (offer: { verb: string; resource: string }) =>
    `Allow ${offer.verb} for ${offer.resource}`,
  blockFormSubmit: "Submit",
  blockApproveStatusLoading: "Checking status…",
  blockApproveStatusApproved: "Approved",
  blockApproveStatusRejected: "Denied",
  blockApproveStatusTimeout: "Timed out",
  blockApproveStatusExpired: "Expired",
  blockApproveStatusNotFound: "This approval could not be found.",
  blockApproveStatusLoadError: "Couldn't load this approval's status.",
  blockApproveSpectatorNote: "This one isn't yours to decide.",
  blockApproveUndeterminedNote:
    "We're still checking whether this is yours to decide.",
  blockApproveApproving: "Approving…",
  blockApproveRejecting: "Denying…",
  blockApproveActionForbidden: "You do not have permission to act on this.",
  blockApproveActionError: "Couldn't reach the approval — try again.",
  blockDenyActionForbidden: "You do not have permission to deny this.",
  blockDenyActionError: "Couldn't deny this request.",
  blockApprovePlatformRequestedBy: (agentName: string) =>
    `${agentName} is asking to`,
  blockApproveAgentNoteLabel: "Agent's note",
  blockApproveConflictNote:
    "Someone else already resolved this while you were deciding.",
  blockPollVoteCount: (count: number) =>
    count === 1 ? "1 vote" : `${count} votes`,
  blockPollYourVote: "Your vote",
  blockPollChangeVote: "Change vote",
  blockPollVoteError: "Couldn't record your vote — try again.",
  blockFormSubmitting: "Submitting…",
  blockFormSubmitted: "Submitted",
  blockFormEdit: "Edit response",
  blockFormSubmitError: "Couldn't submit — try again.",
  blockFormSubmitForbidden:
    "You do not have permission to respond in this conversation.",
  blockFormFieldRequired: "This field is required.",
  blockQuestionFreeTextLabel: "Type your own answer",
  blockQuestionFreeTextPlaceholder: "Type your own answer…",
  blockQuestionSubmit: "Send",
  blockQuestionSubmitting: "Sending…",
  blockQuestionAnswerError: "Couldn't send your answer — try again.",
  blockQuestionNotifyFailed:
    "Your answer was saved, but the agent couldn't be notified — try again.",
  blockQuestionRetry: "Try again",
  blockQuestionAnsweredLabel: "Your answer",
  blockConnectGithubPickHeadline: "Choose what gets reviewed",
  blockConnectGithubStepDone: "Done",
  blockConnectGithubStepCurrent: "You're here",
  blockConnectGithubReviewingHeadline: "Reviewing",
  blockConnectGithubReviewingLine:
    "Every new pull request in these gets a review posted right here.",
  blockConnectGithubChangeRepos: "change repos",
  blockConnectGithubIntro:
    "Connect GitHub with a personal access token. You choose which repositories the token can reach while you're creating it — that's exactly what the reviewers will be able to read.",
  blockConnectGithubAction: "Connect GitHub",
  blockConnectGithubReconnect: "Reconnect",
  blockConnectGithubTokenSteps: [
    "Open GitHub's fine-grained token page and generate a new token.",
    "Under Repository access, select the repositories you want reviewed — nothing outside that list is ever reachable with this token.",
    "Under Repository permissions, set Contents, Issues, and Pull requests to Read and write, so the reviewers can read your diffs and post back on them.",
    "Paste it here. It's stored encrypted, only your agents use it, and you can remove it any time.",
  ] as readonly string[],
  blockConnectGithubTokenSettingsUrl:
    "https://github.com/settings/personal-access-tokens/new",
  blockConnectGithubTokenSettingsLink: "Open GitHub's token page",
  blockConnectGithubTokenHelper:
    "Your token is stored encrypted, only your agents use it, and you can remove it any time.",
  blockConnectGithubConnectedAs: (org: string) =>
    `Connected to GitHub as ${org}`,
  blockConnectGithubChange: "change",
  blockConnectGithubRepoCount: (found: number, picked: number) =>
    `${found} repo${found === 1 ? "" : "s"} your token can reach · ${picked} picked`,
  blockConnectGithubSelectAll: "Select all",
  blockConnectGithubRepoUpdated: (relative: string) => `updated ${relative}`,
  blockConnectGithubRepoNeverPushed: "no commits yet",
  blockConnectGithubPermissionHelper:
    "These are the repositories your token can reach. Pick the ones you want reviewed — you can change the list any time, and narrowing what the token itself can reach is done back on GitHub.",
  blockConnectGithubStartReviewing: (count: number) =>
    `Start reviewing ${count} repo${count === 1 ? "" : "s"}`,
  blockConnectGithubSkip: "skip for now",
  blockConnectGithubStartReviewingError:
    "Couldn't start reviewing — try again.",
  blockConnectGithubStateUnreadable:
    "Couldn't reach GitHub with your token just now — try connecting again.",
  blockConnectGithubTokenFieldLabel: "Personal access token",
  blockConnectGithubTokenFieldPlaceholder: "github_pat_...",
  blockConnectGithubTokenSubmit: "Connect",
  blockConnectGithubTokenSubmitting: "Connecting…",
  blockConnectGithubTokenCancel: "cancel",
  blockConnectGithubTokenError: "Couldn't connect with that token — try again.",
  blockConnectServiceHeadline: (name: string) => `Connect ${name}`,
  blockConnectServiceAction: (name: string) => `Connect ${name}`,
  blockConnectServiceOAuthHelper: (name: string) =>
    `You'll be sent to ${name} to approve access, then land right back here connected — nothing is shared until you approve.`,
  blockConnectServiceKeylessHelper: "One click — no account keys needed.",
  blockConnectServiceKeyHelper: (name: string) =>
    `You'll paste a ${name} API key — it stays in your workbench and you can disconnect any time.`,
  blockConnectServiceKeyFieldLabel: (name: string) => `${name} API key`,
  blockConnectServiceKeyFieldPlaceholder: "Paste your key",
  blockConnectServiceKeyWhere: (name: string) =>
    `Where do I find my ${name} key?`,
  blockConnectServiceKeySubmit: "Connect",
  blockConnectServiceKeySubmitting: "Connecting…",
  blockConnectServiceKeyCancel: "cancel",
  blockConnectServiceConnected: (name: string) =>
    `${name} connected — you're set.`,
  prThreadStatusReviewed: "Reviewed",
  prThreadStatusReading: "Reading now",
  prThreadStatusWaitingOnYou: "Waiting on you",
  prThreadHostBadge: "Host",
  prThreadReviewerBadge: "Reviewer",
  prThreadViewWork: (stepCount: number, seconds: number) =>
    `view the work · ${stepCount} step${stepCount === 1 ? "" : "s"}, ${seconds}s`,
  prThreadSettledFooter: (repo: string, postedAt: string) =>
    `All three posted to ${repo} · ${postedAt}`,
  prThreadViewOnGithub: "View on GitHub",
  prThreadNextReviewers: (names: readonly string[], currentReviewer: string) =>
    `${joinWithAnd(names)} ${names.length === 1 ? "is" : "are"} next, once ${currentReviewer} finishes.`,
  prThreadQueued: (prNumber: number, repo: string) =>
    `#${prNumber} in ${repo} is queued — waiting for the current review to finish.`,
  prThreadSuggestedFixLabel: "Suggested fix",
  prThreadCopyAction: "Copy",
  prThreadOpenOnGithubAction: "Open on GitHub",
  prThreadFailedTitle: (sender: string) => `${sender}'s review didn't finish`,
  prThreadFailedSub: (repo: string) =>
    `We retried once. Nothing was posted to ${repo}.`,
  prThreadRetryAction: "Retry",
  prThreadWhatHappenedAction: "what happened",
  optionLetter: (index: number) => String.fromCharCode(65 + index),
  dayDividerToday: "Today",
  dayDividerYesterday: "Yesterday",
  typingIndicator: (label: string) => `${label} is typing`,
  agentsTyping: (names: readonly string[]) => {
    if (names.length === 0) return "";
    if (names.length === 1) return `${names[0]} is typing…`;
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
    const others = names.length - 2;
    return `${names[0]}, ${names[1]} and ${others} ${others === 1 ? "other" : "others"} are typing…`;
  },
  turnActivityThinking: "Thinking…",
  turnActivityRetry: (attempt: number) => `Retrying (attempt ${attempt})…`,
  toolActivityFailed: "Failed",
  replyTimedOutNotice: "No reply arrived — the agent may be unavailable.",
  resumeFailedNotice: (refId: string) =>
    `Couldn't resume the running reply — try again. (ref ${refId})`,
  resumeFailedRetryAction: "Retry",
  turnFailedTitle: (sender: string) => `${sender} didn't reply`,
  turnFailedModelUnavailable: (sender: string) =>
    `${sender}'s model isn't available here.`,
  turnFailedToolsUnsupported: (sender: string) =>
    `${sender}'s model can't use tools.`,
  turnFailedPickModel: "Pick a model",
  turnFailedMoreInSettings: "More in Settings",
  turnCancelledTitle: (sender: string) => `You stopped ${sender}'s turn`,
  turnFailedSub: "No reply arrived — the agent may be unavailable.",
  noUsableModelBannerText:
    "No model is connected yet, so a reply here won't come through.",
  noUsableModelBannerAction: "Connect a model",
  rowMenuLabel: "Conversation actions",
  rowMenuRename: "Rename",
  rowMenuPin: "Pin",
  rowMenuUnpin: "Unpin",
  rowMenuSettings: "Settings",
  renameCancel: "Escape to cancel",
  workbenchSettingsAction: "Settings",
  workbenchSettingsBreadcrumbLabel: "Settings breadcrumb",
  workbenchSettingsBreadcrumbCurrent: "Workbench Settings",
  workbenchSettingsNavLabel: "Settings sections",
  workbenchSettingsGroupShared: "Shared",
  workbenchSettingsGroupPersonal: "Personal",
  workbenchSettingsSectionGeneral: "General",
  workbenchSettingsSectionMembers: "Members",
  workbenchSettingsSectionAgents: "Agents",
  workbenchSettingsSectionCapacity: "Capacity",
  workbenchSettingsSectionNotifications: "Notifications",
  workbenchSettingsSectionDanger: "Danger zone",
  workbenchSettingsNameLabel: "Name",
  workbenchSettingsPurposeLabel: "Purpose",
  workbenchSettingsPurposePlaceholder: "What is this for?",
  workbenchSettingsPinnedLabel: "Pinned",
  workbenchSettingsPinnedDescription:
    "Pinned conversations stay at the top for the whole workbench.",
  workbenchSettingsContextWindowLabel: "Conversation memory",
  workbenchSettingsContextWindowDescription:
    "How many prior messages a mentioned agent sees as context.",
  workbenchSettingsUseBenchDefault: (benchDefault: number) =>
    `Use workbench default (${benchDefault})`,
  workbenchSettingsUseOverride: "Set a custom value for this conversation",
  workbenchSettingsContextWindowDisabled:
    "Disabled — mentioned agents see no history",
  workbenchSettingsContextWindowCustom: (count: number) =>
    `Last ${count} messages`,
  workbenchSettingsDeliveryTitle: "Delivery thread",
  workbenchSettingsDeliveryBody:
    "Routine and agent delivery always lands in a dedicated delivery thread — never the main timeline — so broadcast stays readable.",
  workbenchSettingsParticipantsLabel: "Participants",
  workbenchSettingsPeopleLabel: "People",
  workbenchSettingsAgentsLabel: "Agents",
  workbenchSettingsNoPeople: "No people here yet.",
  workbenchSettingsNoAgents: "No agents invited yet.",
  workbenchSettingsRemoveAction: "Remove",
  workbenchSettingsRemoveConfirmLabel: "Click again to remove",
  workbenchSettingsRemoveConsequence: "They lose access to this workbench.",
  workbenchSettingsRemoveSelfHint: "You can't remove yourself.",
  workbenchSettingsRemoveError: "Couldn't remove them — try again.",
  workbenchSettingsRemoving: "Removing…",
  workbenchSettingsAutonomyTitle: "Autonomy",
  workbenchSettingsAutonomyBody:
    "Per-conversation autonomy overrides are not stored yet. Agents inherit the workbench default until that control lands.",
  workbenchSettingsAgentsBackAction: "All agents",
  workbenchSettingsAgentsInviteHint:
    "Every agent participant in this workbench — click one to edit its instructions, capabilities, and inference model.",
  workbenchSettingsAgentDetailNameLabel: "Name",
  workbenchSettingsAgentDetailInstructionsLabel: "Instructions",
  workbenchSettingsAgentDetailInstructionsHint:
    "How this agent should act and what it knows to do. Applies from this agent's next reply in this conversation; other conversations with the same agent pick it up the next time their agent wakes.",
  workbenchSettingsAgentDetailLoadError:
    "Couldn't load this agent's instructions",
  workbenchSettingsAgentDetailSaveError:
    "Couldn't save these changes — try again.",
  workbenchSettingsAgentDetailSavedToast: "Instructions saved",
  // Scoped rather than a bare "Save" (CL-6215 EMIL #4) — the top-bar Save
  // right above it in the same view saves the conversation's own General
  // fields, a different scope entirely; this one only ever writes this
  // agent's instructions.
  workbenchSettingsAgentDetailSave: "Save instructions",
  workbenchSettingsAgentDetailSaving: "Saving…",
  workbenchSettingsAgentDetailCancel: "Cancel",
  workbenchSettingsAgentDetailNoAgents:
    "No agents to configure in this conversation.",
  workbenchSettingsAgentDetailCapabilitiesTitle: "Capabilities",
  workbenchSettingsAgentDetailCapabilitiesHint:
    "What this agent can use. Add a tool, skill, or model from what's available in this workbench.",
  workbenchSettingsAgentDetailNoCapabilities:
    "No tools, skills, or model set yet.",
  workbenchSettingsAgentDetailModelLabel: "Model",
  workbenchSettingsAgentDetailModelUnset: "No model set",
  workbenchSettingsAgentDetailAddCapabilityLabel: "Add a capability",
  workbenchSettingsAgentDetailAddCapabilityKindTool: "Tool",
  workbenchSettingsAgentDetailAddCapabilityKindSkill: "Skill",
  workbenchSettingsAgentDetailAddCapabilityKindModel: "Provider + model",
  workbenchSettingsAgentDetailAddCapabilityChoiceLabel: "Which one",
  workbenchSettingsAgentDetailAddCapabilityChoicePlaceholder: (
    kind: "toolPackage" | "skill" | "model",
  ) =>
    kind === "toolPackage"
      ? "Choose a tool…"
      : kind === "skill"
        ? "Choose a skill…"
        : "Choose a model…",
  workbenchSettingsAgentDetailAddCapabilityButton: "Add",
  workbenchSettingsAgentDetailAddCapabilityAdding: "Adding…",
  workbenchSettingsAgentDetailAddCapabilityError:
    "Couldn't add that — it may no longer be available.",
  workbenchSettingsAgentDetailCapabilityInventoryError:
    "Couldn't load what's available to add.",
  workbenchSettingsAgentDetailModelOption: (
    canonicalName: string,
    providerName: string,
  ) => `${canonicalName} · ${providerName}`,
  workbenchSettingsAgentDetailNoConnectedModels:
    "No connected providers yet — connect one in Shared Settings.",
  workbenchSettingsAgentDetailCatalogError: "Couldn't load the models.",
  workbenchSettingsAgentDetailCatalogRetryAction: "Retry",
  workbenchSettingsAgentDetailCatalogSettingsAction: "Shared Settings",
  workbenchSettingsAgentDetailHistoryTitle: "History",
  workbenchSettingsAgentDetailHistoryHint:
    "Every change to this agent's instructions and capabilities, oldest actions first.",
  workbenchSettingsAgentDetailHistoryLoadError:
    "Couldn't load this agent's history",
  workbenchSettingsAgentDetailHistoryEmpty: "No history yet.",
  workbenchSettingsAgentDetailHistoryCurrent: "Current",
  workbenchSettingsAgentDetailHistoryRestore: "Restore",
  workbenchSettingsAgentDetailHistoryRestoring: "Restoring…",
  workbenchSettingsAgentDetailHistoryRestoreError:
    "Couldn't restore that version — try again.",
  workbenchSettingsNotificationsLabel: "Notifications",
  workbenchSettingsNotifyAll: "All messages",
  workbenchSettingsNotifyMentions: "Mentions only",
  workbenchSettingsNotifyMute: "Mute",
  workbenchSettingsNotificationsHint:
    "This choice is yours alone — it doesn't change notifications for anyone else.",
  workbenchSettingsNotificationsSaveError:
    "Couldn't save your notification setting — try again.",
  workbenchSettingsCapacityDescription:
    "Run this workbench's agents on their own machine.",
  workbenchSettingsCapacityLabel: "Run on a dedicated machine",
  workbenchSettingsCapacityHint:
    "This workbench's agents won't share a machine with any other workbench, so heavy work here never slows the others down.",
  workbenchSettingsCapacityUnavailableHint:
    "Not available on this server yet — ask your operator to enable isolated capacity.",
  workbenchSettingsCapacitySaveError: (enabling: boolean) =>
    enabling
      ? "Couldn't turn on dedicated capacity — try again."
      : "Couldn't turn off dedicated capacity — try again.",
  workbenchSettingsArchiveTitle: "Archive workbench",
  workbenchSettingsArchiveBody:
    "Archiving is not available yet. Closing this workbench would hide it from the sidebar without deleting history once the action lands.",
  workbenchSettingsLoadError: "this conversation's settings",
  workbenchSettingsSaveError:
    "Couldn't save this conversation's settings — try again.",
  workbenchSettingsSavedToast: "Settings saved",
  workbenchSettingsSave: "Save",
  workbenchSettingsSaving: "Saving…",
  workbenchSettingsNoParticipants: "No participants yet.",
  profileOpenAction: "Open profile",
  fixConnectionAction: "Fix this connection",
  profileMessageAction: "Message",
  profileViewSettingsAction: "View settings",
  profileSharedWorkbenches: "Shared workbenches",
  profilePinnedSkills: "Pinned skills",
  profileAgentStatus: "Agent",
  profileMemberStatus: "Member",
} as const;
