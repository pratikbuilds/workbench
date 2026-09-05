export const CHAT_PACKAGE_NAME = "@corbits/chat";

export {
  TextPart,
  ReasoningPart,
  ToolTracePart,
  BlockPart,
  FilePart,
  EventPart,
  Part,
  parsePart,
} from "./parts";
export {
  ApproveBlockData,
  StepsBlockData,
  MetricsBlockData,
  PollBlockData,
  FormBlockData,
  StreamBlockData,
  QuestionBlockData,
  ConnectServiceBlockData,
  OnboardingStepLabel,
  WorkbenchOnboardingStep,
  parseBlock,
} from "./blocks";
export type { Block, BlockParseResult } from "./blocks";
export {
  CONNECTION_CONNECTED_EVENT,
  CONNECTIONS_PENDING_KEY,
  pendingConnectionsOf,
  connectServiceConnectorIds,
  settleConnectedService,
} from "./connect-pending";

export type {
  SettleConnectedServiceDeps,
  SettleConnectedServiceInput,
} from "./connect-pending";
export { encodeParts, decodeParts, decodeMail, senderOf } from "./codec";
export {
  CONSUMER_INFERENCE_FAILURE_NOTICE,
  consumerFacingInferenceText,
} from "./consumer-inference-text";
export type {
  MailContent,
  MailReadContent,
  FetchBlob,
  MailSender,
} from "./codec";

export {
  workbenchHostAssetName,
  isWorkbenchHostDefinitionName,
} from "./workbench-host-naming";

export {
  WORKBENCH_CONTROL_NAMESPACE,
  WorkbenchControlPayload,
  EMPTY_WORKBENCH_STATE,
  isControlMessage,
  parseControlPayload,
  applyControlPayload,
} from "./settings-control";
export type {
  WorkbenchParticipantState,
  ControlApplyResult,
} from "./settings-control";

export { presetForKind } from "./kinds";
export type { WorkbenchKindPreset } from "./kinds";

export { localPartOf, domainOf } from "./agent-address";
export { isAgentAddress, mentionedParticipants } from "./mentions";
export {
  ParticipantEntry,
  ParticipantsSetting,
  parseParticipants,
  handleFromName,
  dedupeHandle,
  addParticipant,
} from "./participants";
export type { ParticipantRecord } from "./participants";

export { createChatRoutes, findExistingAgentChat } from "./routes";
export type { CreateChatRoutesDeps } from "./routes";

export {
  createWorkbenchSubscriberRegistry,
  bridgeWorkbenchStream,
  createPlatformWorkbenchFanout,
} from "./workbench-events";
export type { WorkbenchSubscriberRegistry } from "./workbench-events";

export { createWorkbenchPresenceRegistry } from "./workbench-presence";
export type {
  WorkbenchPresenceRegistry,
  PresenceMember,
} from "./workbench-presence";

export {
  ChatMessageEventData,
  ChatSettingsEventData,
  ChatReactionEventData,
  ChatPinEventData,
  ChatTypingEventData,
  ChatPresenceEventData,
  ChatPresenceSnapshotEventData,
} from "./stream-events";

export {
  AGENT_TURNS_PAGE_SIZE,
  createDrizzleAgentTurnStore,
  createInMemoryAgentTurnStore,
} from "./agent-turns";
export type {
  AgentTurn,
  AgentTurnStatus,
  AgentTurnStore,
  FinishAgentTurnInput,
  StartAgentTurnInput,
} from "./agent-turns";
export { assembleTurnContext, contextItemFor } from "./turn-context";
export type {
  AssembleTurnContextInput,
  TurnContextThreadScope,
} from "./turn-context";
export {
  CHAT_TURN_TIMEOUT_MS,
  createInMemoryTurnClaimStore,
} from "./turn-claims";
export type { TurnClaim, TurnClaimStore, TurnClaimToken } from "./turn-claims";
export {
  AGENT_SECTION_MODE,
  workbenchLaunchPersistExtra,
} from "./standalone-launch";
export { recordSourcesDigest } from "./agent-binding";
export { createWorkbenchTurnQueue, TurnQueuedEvent } from "./turn-queue";
export type {
  DispatchTurnBatch,
  QueuedTurn,
  WorkbenchTurnQueue,
  WorkbenchTurnQueueDeps,
} from "./turn-queue";
export {
  createTurnCancelRegistry,
  TurnCancelledError,
} from "./turn-cancellation";
export type { TurnCancelRegistry } from "./turn-cancellation";
export type {
  WorkbenchEvents,
  WorkbenchLauncher,
  WorkbenchMail,
  ChatPlatform,
  ChatWorkbenchEvent,
  InvitableDefinition,
  LaunchedInvite,
  SentMail,
} from "./platform-port";

export { createDrizzleChatStore, createInMemoryChatStore } from "./store";
export type { ChatDb, ChatStore, WorkbenchByParticipantAddress } from "./store";

export {
  createInMemoryThreadStore,
  createDrizzleThreadStore,
  createDeliveryThread,
  resolveTargetThread,
} from "./threads";
export type {
  ThreadStore,
  WorkbenchThread,
  ThreadKind,
  CreateDeliveryThreadInput,
  OpenReplyThreadInput,
  AssignMessageInput,
  ThreadDb,
} from "./threads";

export {
  createInMemoryBlockResponseStore,
  createDrizzleBlockResponseStore,
  aggregatePollResponses,
} from "./block-responses";
export type {
  BlockResponsePayload,
  BlockResponseRow,
  BlockResponseStore,
  BlockResponseAggregation,
  BlockResponseDb,
  UpsertBlockResponseInput,
} from "./block-responses";

export { REACTION_EMOJI, isKnownReactionEmoji } from "./reaction-emoji";
export type { ReactionEmoji } from "./reaction-emoji";

export {
  createInMemoryReactionStore,
  createDrizzleReactionStore,
  aggregateReactions,
  aggregateReactionsByMessage,
} from "./reactions";
export type {
  ReactionRow,
  ReactionStore,
  ReactionSummary,
  ReactionDb,
  ToggleReactionInput,
  ToggleReactionResult,
} from "./reactions";

export { createInMemoryPinStore, createDrizzlePinStore } from "./pins";
export type { PinRow, PinStore, PinDb, PinMessageInput } from "./pins";

export {
  createInMemoryClientIdStore,
  createDrizzleClientIdStore,
} from "./client-ids";
export type {
  ClientIdRow,
  ClientIdStore,
  ClientIdDb,
  RecordClientIdInput,
} from "./client-ids";

export { createNoopInferenceRoutes } from "./noop-inference";

export { joinRunParticipant } from "./run-participant";
export type {
  JoinRunParticipantDeps,
  JoinRunParticipantInput,
} from "./run-participant";
export {
  dispatchTurn,
  DEFAULT_TURN_DISPATCH_TIMEOUT_MS,
  turnDispatchTimeoutMessage,
  DEFAULT_WAIT_UNTIL_FREE_TIMEOUT_MS,
  DEFAULT_TURN_CLAIM_TTL_MS,
  waitUntilFreeTimeoutMessage,
  launchAndJoinAgent,
  KindIsChatError,
  mintAgentDm,
  postCannedGreeting,
  cannedGreeting,
  sendWorkbenchMessage,
  startWorkflowCommand,
  provisionSpaceWorkbench,
  cancelWorkbenchTurn,
} from "./workbench-service";
export type {
  LaunchAndJoinAgentDeps,
  LaunchAndJoinAgentInput,
  LaunchAndJoinAgentResult,
  MintAgentDmDeps,
  MintAgentDmInput,
  MintAgentDmResult,
  PostCannedGreetingDeps,
  PostCannedGreetingInput,
  CannedGreetingInput,
  SendWorkbenchMessageDeps,
  SendWorkbenchMessageInput,
  SendWorkbenchMessageResult,
  CancelWorkbenchTurnResult,
  StartWorkflowCommandDeps,
  StartWorkflowCommandInput,
  StartWorkflowCommandResult,
  ProvisionSpaceWorkbenchDeps,
  ProvisionSpaceWorkbenchInput,
  ProvisionSpaceWorkbenchResult,
} from "./workbench-service";

export {
  createDrizzleWorkbenchTenancyStore,
  createInMemoryWorkbenchTenancyStore,
} from "./workbench-tenancy";
export type {
  WorkbenchTenancyDb,
  WorkbenchTenancyRow,
  WorkbenchTenancyStore,
  CreateWorkbenchTenantInput,
  CreateWorkbenchTenantResult,
  MoveWorkbenchTenancyInput,
} from "./workbench-tenancy";

export { createWorkbenchTenancyRoutes } from "./workbench-tenancy-routes";
export type { CreateWorkbenchTenancyRoutesDeps } from "./workbench-tenancy-routes";

export {
  createDrizzleFederationTrustStore,
  createInMemoryFederationTrustStore,
} from "./federation-trust";
export type {
  FederationTrustDb,
  FederationTrustStore,
} from "./federation-trust";

export {
  createDrizzleWorkbenchShareStore,
  createInMemoryWorkbenchShareStore,
  monogramFromName,
} from "./workbench-share";
export type {
  AddShareMemberInput,
  WorkbenchShareDb,
  WorkbenchShareRow,
  WorkbenchShareStore,
  WorkbenchShareStoreDeps,
  CreateShareInput,
  CreateShareOutcome,
} from "./workbench-share";

export { createHubChatPlatform } from "./platform-adapter";
export type {
  CreateHubChatPlatformDeps,
  HubChatPlatform,
} from "./platform-adapter";

export {
  createRelaunchNoticePoster,
  relaunchNoticeText,
} from "./relaunch-notice";
export type { RelaunchNotice, RelaunchNoticePort } from "./relaunch-notice";

export {
  createDrizzleRoomMessageStore,
  createInMemoryRoomMessageStore,
  postRoomMessage,
  previewOf,
} from "./room-messages";
export type {
  RoomMessage,
  RoomMessageStore,
  PostRoomMessageInput,
} from "./room-messages";

export {
  createArtifactDeliveryHandler,
  createChatOrchestrator,
} from "./chat-orchestrator";
export type {
  ChatOrchestrator,
  ChatOrchestratorDeps,
} from "./chat-orchestrator";

export {
  createDrizzleWriteClaimStore,
  createInMemoryWriteClaimStore,
} from "./write-claims";
export type {
  WriteClaim,
  WriteClaimDb,
  WriteClaimStore,
  WriteClaimSurface,
} from "./write-claims";

export {
  createDrizzleTurnMailCorrelationStore,
  createInMemoryTurnMailCorrelationStore,
  mailIdFromBracketMessageId,
} from "./turn-mail-correlation";
export type {
  RecordTurnMailInput,
  TurnMailCorrelationDb,
  TurnMailCorrelationStore,
  TurnMailSource,
} from "./turn-mail-correlation";

export {
  createWorkbenchHostInferencePreferencesResolver,
  listDefaultInferencePreferences,
  listConnectedProviders,
} from "./inference-preferences";
export type {
  ConnectedProviderLister,
  DefaultInferencePreferenceLister,
} from "./inference-preferences";

export {
  artifactPartsForFinalizedTurn,
  artifactPartsForToolCall,
} from "./artifact-delivery";

export { createWorkflowParticipantRoutes } from "./workflow-participant-routes";
export type {
  CreateWorkflowParticipantRoutesDeps,
  WorkflowParticipantEnv,
  WorkflowParticipantRunScope,
  WorkflowRunAuthenticator as WorkflowParticipantRunAuthenticator,
} from "./workflow-participant-routes";
