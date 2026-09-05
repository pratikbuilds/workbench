export { ChatWorkspace } from "./chat-workspace";
export type {
  TenantResolution,
  PresenceMember,
  ChatHeaderChrome,
  ChatHeaderCrumb,
} from "./chat-workspace";

export { WorkbenchTimeline, messageDomId, findRetryText } from "./timeline";
export { NoUsableModelBanner } from "./no-usable-model-banner";
export type {
  CurrentUser,
  ReactionActions,
  PinActions,
  PendingActions,
  PendingMessageStatus,
  TimelineMessageItem,
} from "./timeline";

export { WorkbenchLoadingState } from "./loading-state";

export {
  CorbitAvatar,
  CORBIT_DEFAULT_COLOR,
  CORBIT_VISOR_COLOR,
  CORBIT_GLINT_COLOR,
  AVATAR_COLORS,
  avatarColorClass,
  avatarColorForPrincipal,
  avatarClassForPrincipal,
  resolveAvatarFill,
} from "./avatar";
export type {
  AvatarFill,
  AvatarColor,
  CorbitAvatarProps,
  CorbitAvatarSize,
} from "./avatar";

export { PinnedStrip } from "./pinned-strip";
export type { PinsStatus } from "./use-workbench-feed";
export {
  Composer,
  draftAfterSend,
  attachmentsAfterSend,
  partsForSend,
  canSendComposer,
  canSendComposerAction,
  canAttachComposer,
  COMPOSER_ATTACHMENT_LIMITS,
  validateAttachmentPick,
  attachmentValidationMessage,
  attachmentBytesOnComposer,
  base64DecodedByteLength,
  insertTextAtCaret,
  composerSendVisualState,
} from "./composer";
export type {
  ComposerAttachment,
  ComposerSendPayload,
  ComposerAttachmentLimits,
  AttachmentPickCandidate,
  AttachmentValidationError,
  ComposerHandle,
  ComposerSendVisualState,
} from "./composer";
export { renamePayload, rowMenuLabels } from "./sidebar";

export { InviteAgentDialog } from "./invite-agent-dialog";

export { useWorkbenchStream } from "./use-workbench-stream";
export type { WorkbenchStreamState } from "./use-workbench-stream";

export {
  activeMentionQuery,
  bringInOptionsFromMembersAndAgents,
  filterMentionCandidates,
  filterMentionOptions,
  insertMention,
  mentionCandidatesFromParticipants,
  mentionOptionsFromWorkbench,
  resolveBringInLists,
} from "./mentions";
export {
  agentDisplayNamesFromAgents,
  displayNameForAddress,
} from "./agent-display-names";
export type { AgentDisplayNames } from "./agent-display-names";
export type {
  BringInAgentDefinition,
  BringInListFailure,
  BringInMember,
  MentionCandidate,
  MentionInviteIntent,
  MentionOption,
  MentionQuery,
  MentionSection,
} from "./mentions";

export {
  SLASH_COMMANDS,
  activeSlashQuery,
  filterSlashCommands,
} from "./slash-commands";
export type {
  SlashCommandId,
  SlashCommandSpec,
  SlashQuery,
} from "./slash-commands";

export { CHAT_STRINGS } from "./strings";
export { displayWorkbenchTitle } from "./workbench-display-title";

export { BlockPartView } from "./blocks/registry";
export { BlockCard } from "./blocks/block-card";
export { ConnectGithubBlockView } from "./blocks/connect-github-block";

export type {
  ConnectGithubCardBody,
  ConnectGithubCardProps,
  ConnectGithubRepo,
  OnboardingScene,
  OnboardingSceneStep,
} from "./blocks/connect-github-block";
export type {
  ApprovalActions,
  ApprovalLiveStatus,
  ApprovalStatusQuery,
  ApprovalDecisionResult,
  PlatformApprovalDetail,
} from "./blocks/approval-actions";
export type {
  BlockResponseActions,
  BlockResponseQuery,
  BlockResponseSubmitResult,
  BlockResponsePayload,
  PollResponsePayload,
  FormResponsePayload,
  QuestionResponsePayload,
} from "./blocks/block-responses";
export type {
  ConnectGithubActions,
  ConnectGithubQuery,
} from "./blocks/connect-github-actions";
export type {
  ConnectServiceActions,
  ConnectServiceQuery,
  ConnectServiceResult,
  ConnectAffordance,
} from "./blocks/connect-service-actions";

export {
  TextPart,
  ReasoningPart,
  ToolTracePart,
  BlockPart,
  FilePart,
  EventPart,
  Part,
  WorkbenchKind,
  isKnownWorkbenchKind,
  MessageSender,
  ChatApiError,
  describeChatError,
  listWorkbenches,
  listAllWorkbenches,
  workbenchesQueryKey,
  workbenchesQueryKeyPrefix,
  WORKBENCHES_MUTATED_EVENT,
  WORKBENCHES_MUTATED_STREAM_TYPE,
  applyStreamWorkbenchesMutated,
  createWorkbench,
  listMessages,
  sendMessage,
  fetchWorkbenchBlob,
  listThreads,
  listThreadMessages,
  putReadState,
  listRuns,
  listInvitableDefinitions,
  listTenantInvitableDefinitions,
  listVisibleAgentDefinitions,
  openAgentDm,
  inviteAgent,
  workbenchStreamUrl,
  runDisplayName,
  getWorkbenchSettings,
  patchWorkbenchSettings,
  getConnectGithubState,
  postWorkbenchOnboardingStep,
  startReviewingGithubRepos,
  type ConnectGithubStateResponse,
  getBenchChatSettings,
  patchBenchChatSettings,
  getBlockResponses,
  submitPollResponse,
  submitFormResponse,
  submitQuestionResponse,
  REACTION_EMOJI,
  toggleReaction,
  pinMessage,
  unpinMessage,
  listPinnedMessages,
  listWorkbenchAgents,
} from "./api";
export type {
  Workbench,
  CreateWorkbenchInput,
  OnboardingStepLabel,
  WorkbenchOnboardingStep,
  ParticipantRecord,
  MessageItem,
  MessagesResponse,
  WorkbenchThread,
  ThreadMessagesResponse,
  Run,
  InvitableDefinition,
  InvitedAgent,
  VisibleAgentDefinition,
  WorkbenchSettings,
  WorkbenchSettingsPatch,
  ResolvedContextWindow,
  BenchChatSettings,
  BenchChatSettingsPatch,
  BlockResponses,
  BlockResponsePayload as BlockResponsePayloadWire,
  ReactionEmoji,
  ReactionSummary,
  Pinned,
  PinnedMessage,
  WorkbenchAgent,
} from "./api";
export { WorkbenchSettingsSurface } from "./workbench-settings";
export {
  workbenchSettingsSections,
  contextWindowControlState,
  contextWindowPatchValue,
  isWorkbenchSettingsSectionId,
  WORKBENCH_SETTINGS_SECTION_IDS,
} from "./workbench-settings";
export type {
  WorkbenchSettingsSection,
  WorkbenchSettingsSectionGroup,
  WorkbenchSettingsSectionId,
  ContextWindowMode,
} from "./workbench-settings";
export { profileSubjectFromParticipant } from "./profile-subject";
export type { ProfileSubject } from "./profile-subject";

export { sharedWorkbenchesWith } from "./shared-workbenches";
export type { SharedWorkbenchSummary } from "./shared-workbenches";
export { findDirectWorkbenchWith } from "./direct-workbench";

export {
  createDefaultAgentWorkbench,
  findWorkbenchByTitle,
  findDefinitionByAssetName,
  isWorkbenchTitleMatch,
} from "./default-agent-workbench";
export type {
  DefaultAgentWorkbench,
  DefaultAgentWorkbenchConfig,
  EnsureDefaultAgentWorkbenchResult,
} from "./default-agent-workbench";

export { ArtifactChip } from "./artifact-chip";

export {
  PrThreadView,
  PrQueuedStrip,
  PrFailedTurnStrip,
} from "./pr-thread-view";
export type {
  PrThreadRole,
  PrThreadStatus,
  PrThreadFixLineKind,
  PrThreadFixLine,
  PrThreadSuggestedFix,
  PrThreadTrace,
  PrThreadReply,
  PrThreadFailedTurn,
  PrThreadNextReviewer,
  PrThreadFooter,
  PrThreadViewProps,
} from "./pr-thread-view";

export {
  TypingIndicator,
  parseTypingEvent,
  nextTypingState,
  isTypingStateExpired,
  typingLabel,
} from "./typing-indicator";
export type { TypingEvent, TypingState } from "./typing-indicator";
