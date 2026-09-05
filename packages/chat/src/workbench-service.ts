// Workbench-level orchestration that sits above the platform port:
// joining an agent into a workbench (shared by chat creation and
// `POST .../invite`), sending a message with its full mention fan-out
// — recipient resolution, prior-context loading, and the per-recipient
// delivery loop — and provisioning a bare new space workbench for a
// caller (like a routine) that names no existing destination. Each
// depends only on the platform/store seams it actually calls, not the
// full `ChatPlatform`/`ChatStore`.
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { reportError } from "@corbits/error-sink";
import { encodeParts } from "./codec";
import type { Part as PartType } from "./parts";
import {
  consumerTurnError,
  isModelUnavailableCause,
  MODEL_UNAVAILABLE_CONSUMER_MESSAGE,
} from "./model-unavailable";
import { localPartOf } from "./agent-address";
import { deriveDisplayName } from "./display-name";
import { assertNoLeakedInternalId } from "./id-leak-guard";
import { isAgentAddress, mentionedParticipants } from "./mentions";
import { mergeContextIntoParts } from "./workbench-context";
import {
  assembleTurnContext,
  type TurnContextThreadScope,
} from "./turn-context";
import type { AgentTurnStore } from "./agent-turns";
import type { ThreadStore } from "./threads";
import {
  TurnCancelledError,
  type TurnCancelRegistry,
} from "./turn-cancellation";
import {
  addParticipant,
  handleFromName,
  removeParticipant,
  type ParticipantRecord,
} from "./participants";
import {
  benchContextWindowOf,
  kindOf,
  participantsOf,
  resolveContextWindow,
} from "./workbench-settings";
import { presetForKind } from "./kinds";
import type {
  WorkbenchLauncher,
  WorkbenchMail,
  ChatWorkbenchEvent,
  InvitableDefinition,
} from "./platform-port";
import {
  postRoomMessage,
  insertRoomMessageRow,
  publishRoomMessageEvent,
  type RoomMessageStore,
} from "./room-messages";
import { mailMessageIdFor, mailThreadHeaders } from "./mail-headers";
import { mailAncestryOf } from "./threads";
import {
  writeChatMailboxFanout,
  mailboxBodyOf,
  mailboxSubjectOf,
  type MailboxFanoutDeps,
} from "./mailbox-fanout";
import type { TurnMailCorrelationStore } from "./turn-mail-correlation";
import type { WorkbenchSubscriberRegistry } from "./workbench-events";
import type { QueuedTurn, WorkbenchTurnQueue } from "./turn-queue";
import { CHAT_TURN_TIMEOUT_MS } from "./turn-claims";
import type { WorkbenchTenancyStore } from "./workbench-tenancy";
import type { ChatStore, WorkbenchSettingsRow } from "./store";
import { withTimeout } from "./with-timeout";

const provisionLog = getLogger(["chat", "provision-space"]);
const removeLog = getLogger(["chat", "remove-participant"]);
const greetingLog = getLogger(["chat", "canned-greeting"]);
const fanoutLog = getLogger(["chat", "message-fanout"]);

export type ProvisionSpaceWorkbenchDeps = {
  readonly tenancy: Pick<
    WorkbenchTenancyStore,
    "createWorkbenchTenant" | "compensateWorkbenchTenant"
  >;
  readonly store: Pick<ChatStore, "createWorkbenchSettings">;
};

export type ProvisionSpaceWorkbenchInput = {
  readonly tenantId: string;
  readonly tenantDomain: string;
  readonly creatorPrincipalId: string;
  readonly creatorUserId: string;
  readonly name: string;
  /** Request cookies forwarded into native `POST /api/tenants`. */
  readonly cookies: string[];
};

export type ProvisionSpaceWorkbenchResult = {
  readonly workbenchId: string;
  readonly compensate: () => Promise<void>;
};

/**
 * Provisions a brand-new `kind: "workbench"` space (mint the child
 * tenant, write its base settings), the same steps `POST /workbenches`
 * runs for a named space — used by a caller (a routine's create route,
 * chiefly) that needs to hand a fresh destination to something else in
 * the same request rather than collecting one from a picker first. A
 * workbench is data: nothing launches or deploys here.
 *
 * Returns a `compensate` callback rather than compensating on every
 * failure itself: the caller may still fail its own next step (e.g.
 * writing the row this space is *for*) after this returns
 * successfully, and only the caller knows when that's happened.
 */
export async function provisionSpaceWorkbench(
  deps: ProvisionSpaceWorkbenchDeps,
  input: ProvisionSpaceWorkbenchInput,
): Promise<ProvisionSpaceWorkbenchResult> {
  const workbenchId = generateId("workflowRun");

  const workbenchTenant = await deps.tenancy.createWorkbenchTenant({
    parentTenantId: input.tenantId,
    workbenchId,
    name: input.name,
    creatorUserId: input.creatorUserId,
    cookies: input.cookies,
  });

  const preset = presetForKind("workbench");
  try {
    await deps.store.createWorkbenchSettings({
      tenantId: input.tenantId,
      workbenchId,
      settings: {
        "chat/kind": "workbench",
        "chat/pinned": preset.pinned,
        "chat/participants": [],
        "chat/name": input.name,
      },
      updatedBy: input.creatorPrincipalId,
    });
  } catch (err) {
    provisionLog.error(
      "Workbench settings write failed for {workbenchId} after minting " +
        "{tenantId}; compensating the orphaned tenant",
      { workbenchId, tenantId: workbenchTenant.tenantId, err },
    );
    try {
      await deps.tenancy.compensateWorkbenchTenant(workbenchTenant.tenantId);
    } catch (compensationErr) {
      provisionLog.error(
        "Compensation failed for orphaned tenant {tenantId} after " +
          "workbench {workbenchId}'s settings failure; this tenant is now " +
          "a privileged orphan with no workbench pointing at it and " +
          "requires manual cleanup",
        { workbenchId, tenantId: workbenchTenant.tenantId, compensationErr },
      );
    }
    throw err;
  }

  return {
    workbenchId,
    compensate: async () => {
      await deps.tenancy.compensateWorkbenchTenant(workbenchTenant.tenantId);
    },
  };
}

const mintAgentDmLog = getLogger(["chat", "mint-agent-dm"]);

export type MintAgentDmDeps = {
  readonly tenancy: Pick<
    WorkbenchTenancyStore,
    | "createWorkbenchTenant"
    | "compensateWorkbenchTenant"
    | "getWorkbenchTenancy"
  >;
  readonly store: Pick<
    ChatStore,
    | "createWorkbenchSettings"
    | "deleteWorkbenchSettings"
    | "updateWorkbenchSettings"
    | "listWorkbenchSettings"
    | "mutateWorkbenchParticipants"
  >;
  readonly platform: LaunchAndJoinAgentDeps["platform"];
  readonly roomMessages: LaunchAndJoinAgentDeps["roomMessages"];
  readonly publish: LaunchAndJoinAgentDeps["publish"];
};

export type MintAgentDmInput = {
  /** Parent bench tenant id (`scope.tenantId`) — settings and launches
   * are scoped here, matching `POST /workbenches` agent-DM mint. */
  readonly tenantId: string;
  /** Myra's (caller's) workbench id — receives `chat.workbenches-mutated`
   * so the sidebar refreshes without joining the new agent into this DM. */
  readonly callerWorkbenchId: string;
  /** Caller's principal id — settings `updatedBy` / launch creator. */
  readonly callerPrincipalId: string;
  /** Human auth user `refId` — required by `createWorkbenchTenant`. */
  readonly creatorUserId: string;
  /** Request cookies forwarded into native `POST /api/tenants`. */
  readonly cookies: string[];
  readonly definitionId: string;
  /** Optional title; else invitable description / definition name. */
  readonly name?: string;
};

export type MintAgentDmResult = {
  readonly workbenchId: string;
  readonly address: string;
  readonly definitionId: string;
  readonly handle: string;
  readonly displayName: string;
};

export type FindExistingAgentChatDeps = {
  readonly store: Pick<ChatStore, "listWorkbenchSettings">;
  readonly platform: Pick<
    WorkbenchLauncher,
    "resolveDefinitionAssetId" | "resolveDefinitionIdByAddress"
  >;
  readonly tenancy: Pick<WorkbenchTenancyStore, "getWorkbenchTenancy">;
};

/**
 * Finds an existing chat with the given agent. `POST /workbenches` with
 * `kind: "chat"` + `definitionId` always find-or-reopens this way
 * (CL-6981), and `mintAgentDm` does the same: a DM is the one 1:1
 * tenant with that agent. Uniqueness is per (bench, definitionId).
 * Product reopens; it does not clone.
 *
 * Matches forward, by the `chat/definitionId` every agent chat has
 * carried in its settings since this landed, and falls back to
 * `matchesLegacyAgentChat` for a chat minted before that key existed.
 * The comparison is on the definition's ASSET, not the row id: a
 * code-sourced deploy projects a new `workflow_definition` row per
 * frozen wire projection, so the id a chat recorded at creation and the
 * id the picker offers later are routinely different rows over the one
 * asset that IS the agent.
 * More than one match (duplicates this same gap already let through)
 * resolves to the oldest by its workbench-tenancy `createdAt` — the
 * original conversation, not whichever the caller happens to hit first —
 * with a workbench that predates workbench tenancy entirely sorting oldest
 * of all.
 */
export async function findExistingAgentChat(
  deps: FindExistingAgentChatDeps,
  tenantId: string,
  definitionId: string,
): Promise<WorkbenchSettingsRow | undefined> {
  const chats = await deps.store.listWorkbenchSettings(tenantId, "chat");
  const assetId = await deps.platform.resolveDefinitionAssetId(definitionId);
  const matches: { row: WorkbenchSettingsRow; createdAt: Date }[] = [];
  for (const row of chats) {
    const storedDefinitionId = row.settings["chat/definitionId"];
    const isMatch =
      storedDefinitionId !== undefined
        ? typeof storedDefinitionId === "string" &&
          (await sameAgent(deps, storedDefinitionId, definitionId, assetId))
        : await matchesLegacyAgentChat(deps, row, definitionId);
    if (!isMatch) continue;
    const link = await deps.tenancy.getWorkbenchTenancy(row.workbenchId);
    matches.push({ row, createdAt: link?.createdAt ?? new Date(0) });
  }
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return matches[0]?.row;
}

/**
 * Whether two definition ids name the same agent: the same row, or two
 * rows projected over the same workflow asset. An unresolvable asset (a
 * definition row that no longer exists) never matches by asset, so a
 * stale recorded id falls back to plain id equality alone.
 */
async function sameAgent(
  deps: Pick<FindExistingAgentChatDeps, "platform">,
  storedDefinitionId: string,
  definitionId: string,
  assetId: string | undefined,
): Promise<boolean> {
  if (storedDefinitionId === definitionId) return true;
  if (assetId === undefined) return false;
  const storedAssetId =
    await deps.platform.resolveDefinitionAssetId(storedDefinitionId);
  return storedAssetId === assetId;
}

/**
 * A chat minted before `chat/definitionId` was recorded at creation
 * carries no forward marker naming its agent — the only way back to its
 * definition is the platform's reverse address lookup, run once per
 * agent participant the chat has (ordinarily exactly one).
 */
async function matchesLegacyAgentChat(
  deps: Pick<FindExistingAgentChatDeps, "platform">,
  row: WorkbenchSettingsRow,
  definitionId: string,
): Promise<boolean> {
  const agentAddresses = participantsOf(row.settings)
    .map((participant) => participant.address)
    .filter(isAgentAddress);
  for (const address of agentAddresses) {
    const resolved = await deps.platform.resolveDefinitionIdByAddress(address);
    if (resolved === definitionId) return true;
  }
  return false;
}

/**
 * Mints a `kind: "chat"` 1:1 for `definitionId` under the caller's bench,
 * or reopens the existing one for that (bench, definition) — never clones
 * a second DM. Launches the agent into THAT workbench (never into
 * `callerWorkbenchId`), and on a fresh mint publishes
 * `chat.workbenches-mutated` on the caller's workbench so the sidebar
 * picks up the new chat. The workflow-run counterpart of `POST
 * /workbenches` agent-DM mint — `create_agent`'s default path uses this
 * instead of inviting into Myra's own DM (which is itself `kind: chat`
 * and rejects additional agents via `KindIsChatError`).
 */
export async function mintAgentDm(
  deps: MintAgentDmDeps,
  input: MintAgentDmInput,
): Promise<MintAgentDmResult> {
  const existing = await findExistingAgentChat(
    deps,
    input.tenantId,
    input.definitionId,
  );
  if (existing !== undefined) {
    return reopenAgentDm(deps, input, existing);
  }

  const invitable = await deps.platform.listInvitableDefinitions(
    input.tenantId,
  );
  const matched = invitable.find(
    (definition) => definition.id === input.definitionId,
  );
  const chatTitle =
    input.name ?? matched?.description ?? matched?.name ?? undefined;

  const workbenchId = generateId("workflowRun");
  const workbenchTenant = await deps.tenancy.createWorkbenchTenant({
    parentTenantId: input.tenantId,
    workbenchId,
    name: chatTitle ?? workbenchId,
    creatorUserId: input.creatorUserId,
    cookies: input.cookies,
  });

  async function compensateMint(err: unknown, phase: string): Promise<void> {
    mintAgentDmLog.error(
      "Agent DM {phase} failed for {workbenchId} after minting " +
        "{tenantId}; compensating the orphaned tenant and settings: {cause}",
      {
        phase,
        workbenchId,
        tenantId: workbenchTenant.tenantId,
        cause: err instanceof Error ? err.message : String(err),
        err,
      },
    );
    try {
      await deps.store.deleteWorkbenchSettings(input.tenantId, workbenchId);
      await deps.tenancy.compensateWorkbenchTenant(workbenchTenant.tenantId);
    } catch (compensationErr) {
      mintAgentDmLog.error(
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

  const preset = presetForKind("chat");
  const baseSettings: Record<string, unknown> = {
    "chat/kind": "chat",
    "chat/pinned": preset.pinned,
    "chat/participants": [],
    "chat/definitionId": input.definitionId,
  };
  const settings: Record<string, unknown> =
    chatTitle !== undefined
      ? { ...baseSettings, "chat/name": chatTitle }
      : baseSettings;

  let row;
  try {
    row = await deps.store.createWorkbenchSettings({
      tenantId: input.tenantId,
      workbenchId,
      settings,
      updatedBy: input.callerPrincipalId,
    });
  } catch (err) {
    await compensateMint(err, "settings write");
    throw err;
  }

  let joined: LaunchAndJoinAgentResult;
  try {
    joined = await launchAndJoinAgent(
      {
        store: deps.store,
        platform: deps.platform,
        roomMessages: deps.roomMessages,
        publish: deps.publish,
      },
      {
        tenantId: input.tenantId,
        principalId: input.callerPrincipalId,
        workbenchId,
        definitionId: input.definitionId,
        existingSettings: row.settings,
        invitable,
      },
    );
  } catch (err) {
    await compensateMint(err, "agent mint");
    throw err;
  }

  if (chatTitle === undefined) {
    await deps.store.updateWorkbenchSettings({
      tenantId: input.tenantId,
      workbenchId,
      settings: { ...joined.settings, "chat/name": joined.handle },
      updatedBy: input.callerPrincipalId,
    });
  }

  deps.publish(input.callerWorkbenchId, {
    type: "chat.workbenches-mutated",
    data: { tenantId: input.tenantId },
  });

  // Fire-and-forget pre-warm — never block mint+join+publish on deploy.
  void deps.platform.ensureAwake(joined.address).catch((err: unknown) => {
    mintAgentDmLog.error(
      "Pre-warm deploy failed for minted agent DM {workbenchId}'s agent " +
        "{address}; the next message to it retries the wake: {err}",
      { workbenchId, address: joined.address, err },
    );
  });

  return {
    workbenchId,
    address: joined.address,
    definitionId: joined.definitionId,
    handle: joined.handle,
    displayName: joined.displayName,
  };
}

async function reopenAgentDm(
  deps: MintAgentDmDeps,
  input: MintAgentDmInput,
  existing: WorkbenchSettingsRow,
): Promise<MintAgentDmResult> {
  const agent = participantsOf(existing.settings).find((participant) =>
    isAgentAddress(participant.address),
  );
  if (agent !== undefined) {
    return {
      workbenchId: existing.workbenchId,
      address: agent.address,
      definitionId: input.definitionId,
      handle: agent.handle,
      displayName: agent.handle,
    };
  }

  const invitable = await deps.platform.listInvitableDefinitions(
    input.tenantId,
  );
  const joined = await launchAndJoinAgent(
    {
      store: deps.store,
      platform: deps.platform,
      roomMessages: deps.roomMessages,
      publish: deps.publish,
    },
    {
      tenantId: input.tenantId,
      principalId: input.callerPrincipalId,
      workbenchId: existing.workbenchId,
      definitionId: input.definitionId,
      existingSettings: existing.settings,
      invitable,
    },
  );
  return {
    workbenchId: existing.workbenchId,
    address: joined.address,
    definitionId: joined.definitionId,
    handle: joined.handle,
    displayName: joined.displayName,
  };
}

export type LaunchAndJoinAgentDeps = {
  readonly store: Pick<ChatStore, "mutateWorkbenchParticipants">;
  readonly platform: WorkbenchLauncher;
  readonly roomMessages: RoomMessageStore;
  readonly publish: (workbenchId: string, event: ChatWorkbenchEvent) => void;
};

export type LaunchAndJoinAgentInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workbenchId: string;
  readonly definitionId: string;
  readonly existingSettings: Record<string, unknown>;
  /**
   * The tenant's invitable listing, fetched once by the caller — every
   * call site already holds (or needs) it for its own resolution, so
   * this function never re-fetches the same listing behind the
   * caller's back.
   */
  readonly invitable: readonly InvitableDefinition[];
};

export type LaunchAndJoinAgentResult = {
  readonly address: string;
  readonly definitionId: string;
  readonly handle: string;
  /** The agent's real, person-facing name — see `resolveInvitedDisplayName`.
   * Never the mention handle: a caller that needs "Architecture reviewer"
   * rather than "architecture-reviewer" (the canned greeting, chiefly)
   * reads this instead of re-deriving it from a possibly-stale
   * `invitable` snapshot (CL-6471). */
  readonly displayName: string;
  readonly settings: Record<string, unknown>;
  /**
   * Settles when the timeline's `workbench.agent-joined` event has been
   * delivered (or its failure logged — it never rejects). The send may
   * be the workbench host's first traffic, which deploys the host, so
   * it must never block the join itself; a caller that posts follow-up
   * mail (the canned greeting) chains on this to keep timeline order.
   */
  readonly joinEventDelivered: Promise<void>;
};

/**
 * The agent participant this room already holds for `definitionId`, or
 * undefined when none of the room's agents was launched from it. One
 * room participant = one live run (CL-6451): every path that could
 * start a definition in a room checks residency here first, so a
 * mention, a workflow command, or a repeated invite reaches the run the
 * room already has instead of minting a sibling. Identity is the
 * definition's ASSET when both sides resolve one (a code-sourced deploy
 * projects a fresh definition row per wire projection over the same
 * asset — see `resolveDefinitionAssetId`), falling back to row-id
 * equality when either side's asset is unresolvable.
 */
export async function findResidentAgentForDefinition(
  platform: Pick<
    WorkbenchLauncher,
    "resolveDefinitionIdByAddress" | "resolveDefinitionAssetId"
  >,
  participants: readonly ParticipantRecord[],
  definitionId: string,
): Promise<ParticipantRecord | undefined> {
  const assetId = await platform.resolveDefinitionAssetId(definitionId);
  for (const participant of participants) {
    if (!isAgentAddress(participant.address)) continue;
    const launchedFrom = await platform.resolveDefinitionIdByAddress(
      participant.address,
    );
    if (launchedFrom === undefined) continue;
    if (launchedFrom === definitionId) return participant;
    if (assetId === undefined) continue;
    const launchedFromAssetId =
      await platform.resolveDefinitionAssetId(launchedFrom);
    if (launchedFromAssetId === assetId) return participant;
  }
  return undefined;
}

/**
 * Resolves the display name an invited definition should carry, the one
 * source both the participant's mention handle and the canned greeting's
 * "I'm ${agent}" read (CL-6471): the pre-fetched `invitable` snapshot
 * when it has the definition, falling back to a live, authoritative
 * lookup (`resolveDefinitionNameSource`) when it doesn't — a just-created
 * or just-redeployed definition the snapshot predates. Never falls
 * further than that: a definition this tenant genuinely has no row for
 * is a loud error, never a raw address or run id standing in for a name.
 */
export async function resolveInvitedDisplayName(
  platform: Pick<WorkbenchLauncher, "resolveDefinitionNameSource">,
  invitable: readonly InvitableDefinition[],
  definitionId: string,
): Promise<string> {
  const invitedDefinition = invitable.find(
    (definition) => definition.id === definitionId,
  );
  const nameSource =
    invitedDefinition ??
    (await platform.resolveDefinitionNameSource(definitionId));
  if (nameSource === undefined) {
    throw new Error(
      `cannot resolve a display name for definition "${definitionId}": ` +
        "this tenant carries no such definition",
    );
  }
  const displayName = deriveDisplayName(nameSource);
  assertNoLeakedInternalId(
    displayName,
    `definition "${definitionId}"'s display name`,
  );
  return displayName;
}

/**
 * A `kind: chat` is 1:1. Same-definition invite reuses the resident
 * (CL-6978) and never reaches this error; a different or additional
 * agent belongs on a workbench, not a DM.
 */
export class KindIsChatError extends Error {
  readonly code = "kind_is_chat" as const;
  constructor() {
    super("a chat is 1:1; adding another agent is only for workbenches");
    this.name = "KindIsChatError";
  }
}

/**
 * The invite core: launches the definition's own instance (or reuses
 * the tenant's standing run for that agent), derives its friendly
 * mention handle, appends the participant record, posts the join
 * event onto the workbench's timeline, and arms the reply bridge.
 * Shared by `POST .../invite` and chat creation (a chat's single
 * agent is invited exactly this way, at creation) so the two paths
 * can never drift.
 *
 * Room-local first (CL-6978): if this room already holds a participant
 * launched from the definition, return that handle/address without
 * launching and without appending a second row — `addParticipant`
 * de-dupes the same address by identity. Tenant-wide, `launchInvite`
 * reuses the
 * standing `workbench_launch` so the same principal can sit in its DM
 * and many channels without a sibling instance.
 *
 * A `kind: chat` cannot gain a different agent after that first join.
 */
export async function launchAndJoinAgent(
  deps: LaunchAndJoinAgentDeps,
  input: LaunchAndJoinAgentInput,
): Promise<LaunchAndJoinAgentResult> {
  const participants = participantsOf(input.existingSettings);
  const resident = await findResidentAgentForDefinition(
    deps.platform,
    participants,
    input.definitionId,
  );
  if (resident !== undefined) {
    const displayName = await resolveInvitedDisplayName(
      deps.platform,
      input.invitable,
      input.definitionId,
    );
    return {
      address: resident.address,
      definitionId: input.definitionId,
      handle: resident.handle,
      displayName,
      settings: input.existingSettings,
      joinEventDelivered: Promise.resolve(),
    };
  }

  if (kindOf(input.existingSettings) === "chat") {
    const boundDefinitionId = input.existingSettings["chat/definitionId"];
    const alreadyHasAgent = participants.some((participant) =>
      isAgentAddress(participant.address),
    );
    const isThisChatMint =
      typeof boundDefinitionId === "string" &&
      boundDefinitionId === input.definitionId &&
      !alreadyHasAgent;
    if (!isThisChatMint) {
      throw new KindIsChatError();
    }
  }

  const launched = await deps.platform.launchInvite({
    tenantId: input.tenantId,
    creatorPrincipalId: input.principalId,
    definitionId: input.definitionId,
  });

  // The invited definition's real display name becomes the friendly
  // mention handle (see `resolveInvitedDisplayName`) — de-duplicated
  // against every handle already in the workbench ("echo", "echo-2",
  // ...). Never the asset name's raw slug, and never the run's own
  // address/instance-id local part: a definition this snapshot missed
  // is resolved live rather than degraded to an internal id (CL-6471).
  const displayName = await resolveInvitedDisplayName(
    deps.platform,
    input.invitable,
    input.definitionId,
  );
  const desiredHandle = handleFromName(displayName, launched.address);

  // The record is updated before the join event is posted, matching
  // the settings PATCH route's record-then-mail ordering: the
  // participant list is the durable source of truth, so a failure
  // below never leaves it unwritten.
  const row = await deps.store.mutateWorkbenchParticipants({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    updatedBy: input.principalId,
    mutate: (currentParticipants) =>
      addParticipant(currentParticipants, launched.address, desiredHandle),
  });

  const joinEvent: PartType = {
    kind: "event",
    event: "workbench.agent-joined",
    data: {
      address: launched.address,
      definitionId: input.definitionId,
      invitedBy: input.principalId,
    },
  };
  // Not awaited: the participant record above is the durable source of
  // truth, and this send may be the host's first traffic — the wake it
  // triggers deploys the host, which must never put deploy time back
  // on the caller's path. A delivery failure is logged, never thrown.
  const joinEventDelivered = postRoomMessage(deps, {
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    sender: { name: null, address: launched.address },
    runId: localPartOf(launched.address),
    parts: [joinEvent],
  })
    .then(() => undefined)
    .catch((err: unknown) => {
      greetingLog.error(
        "Join event post failed for workbench {workbenchId}'s agent " +
          "{address}; the participant record is durable, only the " +
          "timeline's joined line is missing: {err}",
        { workbenchId: input.workbenchId, address: launched.address, err },
      );
    });

  deps.publish(input.workbenchId, {
    type: "chat.settings",
    data: { updatedBy: input.principalId, settings: row.settings },
  });

  return {
    address: launched.address,
    definitionId: input.definitionId,
    handle: desiredHandle,
    displayName,
    settings: row.settings,
    joinEventDelivered,
  };
}

export type PostCannedGreetingDeps = {
  readonly roomMessages: RoomMessageStore;
  readonly publish: WorkbenchSubscriberRegistry["publish"];
};

export type CannedGreetingInput = {
  /** The chat's own workbench id — the seed that picks which greeting
   * variation this chat gets, so the same chat always renders the same
   * opener. */
  readonly workbenchId: string;
  /** The agent's display name ("Myra"), never its mention handle. */
  readonly agentName: string;
  /** The opener's display name, when the host can resolve one. */
  readonly senderName?: string;
};

export type PostCannedGreetingInput = CannedGreetingInput & {
  readonly tenantId: string;
  readonly agentAddress: string;
};

/**
 * Next steps a blank room's opener may name: more agents, routines, or
 * a shared channel. Catalog templates stay out of the first bubble —
 * first-run speech is a coworker intro, not a picker recap.
 */
function nextStepsOfferClause(): string {
  return " We can create more agents, set up routines, or open a shared channel.";
}

/**
 * The opener variations. Canned rather than model-written so the
 * greeting is on the timeline the moment the agent joins — a fresh
 * chat used to stay silent through a whole kickoff inference turn, and
 * a person who typed into that silence wrong-footed the conversation.
 * Each takes the leading address (" Alice" or ""), the agent's display
 * name, and the next-steps offer (see `nextStepsOfferClause`),
 * inserted just before the closing question; none may mention the
 * workbench's title (a label the opener picked, never a request).
 */
const GREETING_VARIATIONS: readonly ((
  who: string,
  agent: string,
  nextStepsOffer: string,
) => string)[] = [
  (who, agent, nextStepsOffer) =>
    `Hey${who} — good to have a space to work in together. I'm ${agent}, ` +
    "your teammate here; I can write, plan, and pull pieces together." +
    `${nextStepsOffer} What are you working on?`,
  (who, agent, nextStepsOffer) =>
    `Hi${who}, I'm ${agent} — your teammate here. Drafting, planning, ` +
    `research: all fair game.${nextStepsOffer} What should we dig into ` +
    "first?",
  (who, agent, nextStepsOffer) =>
    `Welcome in${who === "" ? "" : `,${who}`}. I'm ${agent}; think of me ` +
    "as the teammate who writes, plans, and pulls in the right people." +
    `${nextStepsOffer} What's on your plate?`,
  (who, agent, nextStepsOffer) =>
    `Hey${who} — ${agent} here. This space is ours to work in: I can ` +
    `draft, plan, and wire things up as we go.${nextStepsOffer} What are ` +
    "you working on?",
];

function greetingVariationIndex(workbenchId: string): number {
  let sum = 0;
  for (const character of workbenchId) {
    sum = (sum + (character.codePointAt(0) ?? 0)) % GREETING_VARIATIONS.length;
  }
  return sum;
}

export function cannedGreeting(input: CannedGreetingInput): string {
  // The agent states its own name here, verbatim — the exact spot
  // CL-6471's "I'm run_737a058d…" leaked from. Guarded at the source
  // rather than trusted, since every caller ultimately reaches this
  // through `agentName` alone.
  assertNoLeakedInternalId(input.agentName, "a greeting's agent name");
  const who =
    input.senderName !== undefined && input.senderName !== ""
      ? ` ${input.senderName}`
      : "";
  const variation =
    GREETING_VARIATIONS[greetingVariationIndex(input.workbenchId)];
  if (variation === undefined) throw new Error("no greeting variations");
  return variation(who, input.agentName, nextStepsOfferClause());
}

/**
 * Posts a newly-minted chat's opening greeting onto its timeline under
 * the joining agent's own name, so a fresh room is never silent until
 * a human speaks first. The text is canned (see `GREETING_VARIATIONS`)
 * and sent to the chat's own workbench id with the agent's run as
 * `fromWorkbenchId` — exactly how the orchestrator's `postReply`
 * attributes an agent's real replies — so no inference turn runs and
 * the greeting lands the moment the agent joins. The agent's own
 * system prompt tells it a canned opener was already posted under its
 * name, so its first real turn answers the person instead of greeting
 * again.
 *
 * Errors are logged, never thrown: the caller fires this after the
 * chat has already been minted successfully, and a greeting that
 * fails to post must never fail — or roll back — the mint itself.
 */
export async function postCannedGreeting(
  deps: PostCannedGreetingDeps,
  input: PostCannedGreetingInput,
): Promise<void> {
  try {
    await postRoomMessage(deps, {
      tenantId: input.tenantId,
      workbenchId: input.workbenchId,
      sender: { name: null, address: input.agentAddress },
      runId: localPartOf(input.agentAddress),
      parts: [{ kind: "text", text: cannedGreeting(input) }],
    });
  } catch (err) {
    greetingLog.error(
      "Canned greeting post failed for workbench {workbenchId}'s agent " +
        "{agentAddress}; the chat was minted successfully but stays " +
        "silent until a human sends the first message: {err}",
      { workbenchId: input.workbenchId, agentAddress: input.agentAddress, err },
    );
  }
}

export type JoinHumanParticipantDeps = {
  readonly store: Pick<ChatStore, "mutateWorkbenchParticipants">;
  readonly roomMessages: RoomMessageStore;
  readonly publish: (workbenchId: string, event: ChatWorkbenchEvent) => void;
  readonly tenancy: Pick<WorkbenchTenancyStore, "addWorkbenchMember">;
};

export type JoinHumanParticipantInput = {
  readonly tenantId: string;
  /** The creator/inviter — whoever's action is causing the join, and
   * who `mutateWorkbenchParticipants` records as `updatedBy`. */
  readonly principalId: string;
  readonly workbenchId: string;
  /** The bench member being added as the chat's second participant —
   * already validated by the caller (see `routes.ts`'s create handler)
   * to name a real, active, non-self principal in this tenant. */
  readonly memberPrincipalId: string;
  /** The invited member's own auth identity (`principal.refId`) —
   * what `addWorkbenchMember` mints a member-role principal for in the
   * workbench's own child tenant (CL-6332), by construction carrying
   * that role's `room:*` read/write pair. Never `memberPrincipalId`
   * itself: that id is scoped to the acting/bench tenant, not the
   * workbench's own tenant a fresh principal is minted into. */
  readonly memberRefId: string;
  /** The participant record's `handle` — a human has no settings-held
   * name to derive one from the way an invited agent's definition
   * does, so the caller (the create route, which already has the
   * chosen member's display name from the request body) supplies it
   * directly. */
  readonly memberHandle: string;
};

export type JoinHumanParticipantResult = {
  readonly address: string;
  readonly handle: string;
  readonly settings: Record<string, unknown>;
  /** See `LaunchAndJoinAgentResult`'s field of the same name. */
  readonly joinEventDelivered: Promise<void>;
};

/**
 * The human-counterpart analog of `launchAndJoinAgent`: adds a bench
 * member directly as a chat's second participant, with no instance to
 * launch — a human participant reads the workbench's own timeline
 * directly (see `mentions.ts`'s `isAgentAddress` note), so there is no
 * mailbox to stand up, only the participant record and an audit event
 * on the workbench's own timeline. The participant's `address` is the
 * bare principal id (no "@"), which is exactly what marks it as
 * non-agent everywhere else in the package (`isAgentAddress`,
 * `mentionedParticipants`, the DM sidebar bucket in the host app).
 */
export async function joinHumanParticipant(
  deps: JoinHumanParticipantDeps,
  input: JoinHumanParticipantInput,
): Promise<JoinHumanParticipantResult> {
  // Mints (or, for a repeat invite, confirms) the member-role principal
  // this workbench's own child tenant gates members-only access by —
  // see `workbench-tenancy.ts`'s `addWorkbenchMember`. Ahead of the
  // participant record: `chat/participants` is a mention handle only
  // (CL-6332), never itself the membership signal, so a failure here
  // must fail the whole invite rather than leave a participant record
  // with no membership behind it.
  await deps.tenancy.addWorkbenchMember({
    workbenchId: input.workbenchId,
    refId: input.memberRefId,
  });

  const row = await deps.store.mutateWorkbenchParticipants({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    updatedBy: input.principalId,
    mutate: (participants) =>
      addParticipant(participants, input.memberPrincipalId, input.memberHandle),
  });

  const joinEvent: PartType = {
    kind: "event",
    event: "workbench.member-joined",
    data: {
      principalId: input.memberPrincipalId,
      invitedBy: input.principalId,
    },
  };
  // Not awaited, for the same reason `launchAndJoinAgent`'s own join
  // event isn't: the participant record above is the durable source of
  // truth, and this send can carry the host's deploy.
  const joinEventDelivered = postRoomMessage(deps, {
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    sender: { name: null, address: input.principalId },
    senderPrincipalId: input.principalId,
    parts: [joinEvent],
  })
    .then(() => undefined)
    .catch((err: unknown) => {
      greetingLog.error(
        "Member-joined event post failed for workbench {workbenchId}'s " +
          "member {memberPrincipalId}; the participant record is durable, " +
          "only the timeline's joined line is missing",
        {
          workbenchId: input.workbenchId,
          memberPrincipalId: input.memberPrincipalId,
          err,
        },
      );
    });

  deps.publish(input.workbenchId, {
    type: "chat.settings",
    data: { updatedBy: input.principalId, settings: row.settings },
  });

  return {
    address: input.memberPrincipalId,
    handle: input.memberHandle,
    settings: row.settings,
    joinEventDelivered,
  };
}

export type RemoveWorkbenchParticipantDeps = {
  readonly store: Pick<ChatStore, "mutateWorkbenchParticipants">;
  readonly roomMessages: RoomMessageStore;
  readonly publish: (workbenchId: string, event: ChatWorkbenchEvent) => void;
  /**
   * Releases an invited agent's launched instance the way the idle-sleep
   * lifecycle itself tears one down (`sidecarRouter.sendAgentUndeploy`
   * in the hub's own wiring — see `apps/hub/src/index.ts`'s
   * `chatDeps.releaseAgentInstance`) — never re-implemented here, since
   * undeploy is native platform machinery this package only calls.
   * Omitted, an agent participant's instance is left running: the
   * removal still proceeds (the participant record is the source of
   * truth for who a message fans out to, and a workbench with a stale
   * removed-but-still-deployed instance is far better than one stuck
   * mid-removal), but that gap is logged at error level so it is never
   * silent.
   */
  readonly releaseAgentInstance?:
    ((address: string, reason: string) => Promise<void>) | undefined;
};

export type RemoveWorkbenchParticipantInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workbenchId: string;
  /** The participant being removed — already confirmed by the caller
   * (`routes.ts`'s DELETE handler) to actually be a member of this
   * workbench. */
  readonly participant: ParticipantRecord;
};

export type RemoveWorkbenchParticipantResult = {
  readonly settings: Record<string, unknown>;
};

/**
 * The removal counterpart to `launchAndJoinAgent`/`joinHumanParticipant`:
 * undoes exactly what either of those created. Drops the participant
 * record, posts a "left" event onto the workbench's own timeline (the
 * audit-trail mirror of the "joined" event each join path posts), and —
 * only for an agent participant — releases its launched instance
 * through `deps.releaseAgentInstance` so an agent removed from a
 * workbench is never left running with nothing routing messages to it.
 * A human participant has no instance to release (see
 * `joinHumanParticipant`'s own note: a human reads the workbench's own
 * timeline directly, with no mailbox of its own).
 */
export async function removeWorkbenchParticipant(
  deps: RemoveWorkbenchParticipantDeps,
  input: RemoveWorkbenchParticipantInput,
): Promise<RemoveWorkbenchParticipantResult> {
  const row = await deps.store.mutateWorkbenchParticipants({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    updatedBy: input.principalId,
    mutate: (participants) =>
      removeParticipant(participants, input.participant.address),
  });

  const isAgent = isAgentAddress(input.participant.address);
  const leaveEvent: PartType = isAgent
    ? {
        kind: "event",
        event: "workbench.agent-left",
        data: {
          address: input.participant.address,
          removedBy: input.principalId,
        },
      }
    : {
        kind: "event",
        event: "workbench.member-left",
        data: {
          principalId: input.participant.address,
          removedBy: input.principalId,
        },
      };
  await postRoomMessage(deps, {
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    sender: { name: null, address: input.principalId },
    senderPrincipalId: input.principalId,
    parts: [leaveEvent],
  });

  if (isAgent) {
    if (deps.releaseAgentInstance !== undefined) {
      try {
        await deps.releaseAgentInstance(
          input.participant.address,
          "participant-removed",
        );
      } catch (err) {
        removeLog.error(
          "Releasing {address}'s launched instance failed after it was " +
            "removed from workbench {workbenchId}; the participant record " +
            "is gone but the instance may still be running and requires " +
            "manual cleanup",
          {
            address: input.participant.address,
            workbenchId: input.workbenchId,
            err,
          },
        );
      }
    } else {
      removeLog.error(
        "No releaseAgentInstance wired for this deployment; {address} " +
          "was dropped from workbench {workbenchId}'s participants but its " +
          "launched instance was never released and may still be running",
        { address: input.participant.address, workbenchId: input.workbenchId },
      );
    }
  }

  deps.publish(input.workbenchId, {
    type: "chat.settings",
    data: { updatedBy: input.principalId, settings: row.settings },
  });

  return { settings: row.settings };
}

export type StartWorkflowCommandDeps = {
  readonly store: Pick<
    ChatStore,
    "getWorkbenchSettings" | "mutateWorkbenchParticipants"
  >;
  readonly platform: WorkbenchLauncher & Pick<WorkbenchMail, "sendMail">;
  readonly roomMessages: RoomMessageStore;
  readonly publish: (workbenchId: string, event: ChatWorkbenchEvent) => void;
};

export type StartWorkflowCommandInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly workbenchId: string;
  readonly definitionId: string;
  readonly args: string;
};

export type StartWorkflowCommandResult = {
  readonly handle: string;
  readonly address: string;
};

/**
 * The `WorkflowCommandDeps.startWorkflow` implementation `@corbits/chat`
 * gives `@corbits/commands`' workflow-command registrar: invites the
 * named definition into the workbench exactly as `POST .../invite` does
 * (`launchAndJoinAgent`, so the two paths can never drift), then, when
 * the invocation carried args, sends them as the newly-joined agent's
 * opening mail the same way a mention fan-out delivers a copy — from
 * the workbench's own address, so a reply lands back in the workbench's
 * mailbox. An empty invocation ("/echo" with nothing after it) still
 * starts the run, mirroring corbits-code's own workflow dispatch: no
 * args is "Continue.", not "nothing to do".
 *
 * One room participant = one live run (CL-6451 / CL-6978): a command
 * naming a definition already resident in the room delivers into the
 * existing participant's run — the same anti-sibling rule the message
 * pipeline's `@name` intercept and explicit invite both enforce —
 * instead of launching again.
 */
export async function startWorkflowCommand(
  deps: StartWorkflowCommandDeps,
  input: StartWorkflowCommandInput,
): Promise<StartWorkflowCommandResult> {
  const existing = await deps.store.getWorkbenchSettings(
    input.tenantId,
    input.workbenchId,
  );
  if (existing === undefined) {
    throw new Error(
      `No workbench "${input.workbenchId}" to start a workflow in`,
    );
  }

  const resident = await findResidentAgentForDefinition(
    deps.platform,
    participantsOf(existing.settings),
    input.definitionId,
  );
  if (resident !== undefined) {
    const text = input.args.trim() !== "" ? input.args.trim() : "Continue.";
    await deps.platform.sendMail({
      tenantId: input.tenantId,
      workbenchId: localPartOf(resident.address),
      principalId: input.principalId,
      content: encodeParts([{ kind: "text", text }]),
      fromWorkbenchId: input.workbenchId,
    });
    return { handle: resident.handle, address: resident.address };
  }

  const joined = await launchAndJoinAgent(
    {
      store: deps.store,
      platform: deps.platform,
      roomMessages: deps.roomMessages,
      publish: deps.publish,
    },
    {
      tenantId: input.tenantId,
      principalId: input.principalId,
      workbenchId: input.workbenchId,
      definitionId: input.definitionId,
      existingSettings: existing.settings,
      invitable: await deps.platform.listInvitableDefinitions(input.tenantId),
    },
  );

  const openingText =
    input.args.trim() !== "" ? input.args.trim() : "Continue.";
  await deps.platform.sendMail({
    tenantId: input.tenantId,
    workbenchId: localPartOf(joined.address),
    principalId: input.principalId,
    content: encodeParts([{ kind: "text", text: openingText }]),
    fromWorkbenchId: input.workbenchId,
  });

  return { handle: joined.handle, address: joined.address };
}

export type SendWorkbenchMessageDeps = {
  readonly store: Pick<ChatStore, "getWorkbenchSettings" | "getBenchSettings">;
  readonly roomMessages: RoomMessageStore;
  readonly publish: WorkbenchSubscriberRegistry["publish"];
  /** Dispatch only: reaching an agent's own mailbox to ask it for a
   * turn. Nothing on the human write path touches it. */
  readonly platform: Pick<WorkbenchMail, "sendMail">;
  /**
   * One in-flight turn per workbench (CL-6331): every message's
   * recipient fan-out runs through this queue rather than dispatching
   * straight to `dispatchTurn`, so a message arriving mid-turn queues
   * instead of racing the turn already running, and batches with
   * whatever else queued alongside it into one combined next turn once
   * that claim releases. See `./turn-queue.ts`.
   */
  readonly turnQueue: WorkbenchTurnQueue;
  /**
   * The live abort seam a running turn is reachable through while still
   * on our own call stack (CL-7201) — see `./turn-cancellation.ts`.
   * `dispatchTurnBatch` registers one controller per recipient it
   * dispatches and composes it into each `withTimeout` call so a
   * cancellation lands exactly like a timeout does, distinguished only
   * by its `TurnCancelledError` reason. Required, not optional: it is
   * process-local, in-memory state with no cost to always have — every
   * composition gets real cancellation propagation, not just the ones
   * that remember to wire it up.
   */
  readonly turnCancellation: TurnCancelRegistry;
  /**
   * Durable dispatch-mail -> source-message correlation (CL-6314), what
   * `dispatchTurn` records after its send resolves so the reply path can
   * land the agent's answer in its source message's thread. Optional so
   * unit suites that only exercise routing stay free of the table; a
   * composition that wants threaded replies (the hub) injects a real
   * store. Absent, dispatches still send — their replies just post
   * unthreaded.
   */
  readonly turnMailCorrelation?: TurnMailCorrelationStore;
  /**
   * The turn projection (CL-6329). `dispatchTurn` opens a row before it
   * touches the execution plane, so an in-flight turn is visible from
   * its first moment and the child run id its reply will carry is
   * already allocated. Optional so unit suites that only exercise
   * routing stay free of the table; a composition that wants traceable
   * replies (the hub) injects a real store.
   */
  readonly agentTurns?: AgentTurnStore;
  /**
   * Narrows a turn's context to its own thread. Absent, a turn is asked
   * with the whole room. See `./turn-context.ts`.
   */
  readonly threads?: Pick<
    ThreadStore,
    "listThreadAssignments" | "getThread" | "threadIdForMessage"
  >;
  /**
   * The mail domain and fan-out target for CL-7450's mailbox copy:
   * writing a sent human message into every human participant's
   * `@corbits/mailbox` inbox, addressed by this row's own RFC 5322
   * Message-ID (`./mail-headers.ts`). Optional so unit suites that only
   * exercise routing stay free of the mailbox tables; the hub always
   * injects a real one (`platform-adapter.ts`'s composition).
   */
  readonly mailbox?: MailboxFanoutDeps;
  /**
   * The turn-level deadline (CL-6644): `dispatchTurnBatch` wraps every
   * recipient's `dispatchTurn` call in this single wall-clock budget,
   * defaulting to `DEFAULT_TURN_DISPATCH_TIMEOUT_MS`. This is the
   * structural fix three rounds of per-hop timeouts (#312's wake bound,
   * #314's bypassed-wake bound, #316's mail-delivery bound) kept falling
   * short of: each closed one stalling hop and a new one appeared next
   * (see the CL-6644 comment isolating a fourth hang — a direct send to
   * an already-live run — that needed neither #312's nor #316's bound).
   * No agent turn may hang past this budget regardless of which
   * internal hop stalls; the per-hop bounds stay in place as
   * diagnostics that produce a sharper cause when they fire first.
   * Injectable so tests exercise the bound in milliseconds instead of
   * the production default.
   */
  readonly turnDispatchTimeoutMs?: number;
  /**
   * CL-7129's bound on the CL-6670 wait: `dispatchTurnBatch` wraps
   * `agentTurns.waitUntilFree` in this budget before it ever starts the
   * `turnDispatchTimeoutMs` clock below, defaulting to
   * `DEFAULT_WAIT_UNTIL_FREE_TIMEOUT_MS`. Left unbounded, a slow prior
   * turn for the same agent could hold `turn-queue.ts`'s claim past its
   * TTL while this `await` was still open — the exact gap that let a
   * second `run()` win the claim and start a second concurrent drain.
   * Injectable so tests exercise the bound in milliseconds instead of
   * the production default.
   */
  readonly waitUntilFreeTimeoutMs?: number;
};

/** CL-6644's default turn-level deadline: generous enough to cover a
 * cold wake plus a remote inference round-trip, the same reasoning
 * `DEFAULT_WAKE_TIMEOUT_MS` (30s) uses for the wake step alone. */
export const DEFAULT_TURN_DISPATCH_TIMEOUT_MS = 120_000;

/**
 * CL-7129's default bound on `agentTurns.waitUntilFree`: must cover the
 * longest a legitimate prior turn is allowed to run —
 * `CHAT_TURN_TIMEOUT_MS`, the same bound the section body's own
 * per-occurrence timeout enforces — plus a grace margin. A message
 * queued behind a prior turn that is merely slow, not hung, has to be
 * delivered once that turn frees up rather than time out here and land
 * as an undelivered notice (CL-6670's exact case; a bound narrower than
 * `CHAT_TURN_TIMEOUT_MS` reintroduces the bug CL-6670 fixed for any
 * prior turn that runs past it).
 */
export const DEFAULT_WAIT_UNTIL_FREE_TIMEOUT_MS = CHAT_TURN_TIMEOUT_MS + 30_000;

/**
 * CL-7129's default turn-claim TTL: the backstop for a workbench whose
 * dispatch loop crashed or hung without ever calling `release` (see
 * `./turn-claims.ts`'s `createInMemoryTurnClaimStore`). A well-behaved
 * dispatch runs `DEFAULT_WAIT_UNTIL_FREE_TIMEOUT_MS`'s wait and
 * `DEFAULT_TURN_DISPATCH_TIMEOUT_MS`'s dispatch call back-to-back
 * inside one claim's lifetime, so the TTL has to clear the sum of both
 * with margin to spare — otherwise the TTL fires on a claim a legitimate
 * dispatch is still using, letting a second `run()` win it and drain
 * the same workbench's queue concurrently (the CL-7129 bug this whole
 * store change exists to close). Kept strictly greater by a 30s margin
 * so it is unreachable in any well-behaved case.
 */
export const DEFAULT_TURN_CLAIM_TTL_MS =
  DEFAULT_WAIT_UNTIL_FREE_TIMEOUT_MS +
  DEFAULT_TURN_DISPATCH_TIMEOUT_MS +
  30_000;

/** `waitUntilFree`'s own timeout message: names the agent address the
 * wait was blocked on and the budget it exceeded. */
export function waitUntilFreeTimeoutMessage(
  agentAddress: string,
  timeoutMs: number,
): string {
  return `waiting for "${agentAddress}"'s prior turn to close did not settle within ${String(timeoutMs)}ms`;
}

/** The turn-level deadline's own rejection message: names the turn's
 * run address (the recipient every dispatch failure is already reported
 * and notified against) and the budget it exceeded, so a person reading
 * the `reportError` refId's logged cause sees exactly what expired. */
export function turnDispatchTimeoutMessage(
  agentAddress: string,
  timeoutMs: number,
): string {
  return `turn for "${agentAddress}" did not settle within ${String(timeoutMs)}ms`;
}

export type SendWorkbenchMessageInput = {
  readonly tenantId: string;
  readonly principalId: string;
  /** The address the sender's message is posted under — `id@domain`,
   * the same shape every participant address carries. */
  readonly senderAddress: string;
  readonly workbenchId: string;
  readonly messageParts: PartType[];
  /**
   * A plain reply's parent message id. Deterministic routing: a reply
   * to an agent's message reaches that agent even when the reply text
   * mentions nobody — the reply gesture is itself an address.
   */
  readonly inReplyToMessageId?: string;
  /**
   * Thread membership stamped onto the published `chat.message` so
   * stream subscribers see the same scope the POST response returns
   * (CL-6660). Assignment into `workbench_thread_messages` still happens
   * in the route after the insert — this field only fills the row and
   * the SSE payload.
   */
  readonly threadId?: string;
  /**
   * A participant this message must reach regardless of what its text
   * mentions (CL-6451): an `@name` typed as a definition's wire name
   * ("assistant") resolves to a participant whose handle derives from
   * its display name ("myra"), so mention matching alone would miss it.
   * The command intercept resolves that residency and passes the
   * participant's address here, so the message rides the ordinary turn
   * pipeline — queueing behind an in-flight turn like any mention —
   * into the run the room already has.
   */
  readonly forcedRecipientAddress?: string;
};

export type SendWorkbenchMessageResult = {
  readonly id: string;
  readonly createdAt: string;
  /**
   * Settles once this message's routing intent is resolved: either its
   * turn actually dispatched (or its failure surfaced as a notice on
   * the timeline — it never rejects), or — CL-6331 — it queued behind a
   * turn already in flight for this workbench, in which case this
   * settles as soon as it's queued, not once it eventually dispatches
   * as part of a later batch. Dispatch can wake a slept agent, which is
   * a full redeploy, so the sender's own message is persisted,
   * published, and returned without waiting on any of it; a caller that
   * needs a message actually SENT (not merely queued) to be settled —
   * a test proving delivery, or a synchronous relay — has to know a
   * queued message's own delivery lands on whichever later message's
   * `fanoutDelivered` triggers the drain (see `./turn-queue.ts`), not on
   * this one.
   */
  readonly fanoutDelivered: Promise<void>;
};

/**
 * Resolves which agent participant a reply targets: the agent that
 * authored the parent message, when the parent is found and was
 * authored by a known agent participant. Undefined for a reply to a
 * human message, an unknown message id, or no reply at all.
 */
async function replyTargetAgent(
  roomMessages: Pick<RoomMessageStore, "getMessage">,
  input: {
    tenantId: string;
    workbenchId: string;
    inReplyToMessageId: string;
    participants: readonly ParticipantRecord[];
  },
): Promise<string | undefined> {
  const parent = await roomMessages.getMessage({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    messageId: input.inReplyToMessageId,
  });
  if (parent === undefined) return undefined;
  const match = input.participants.find(
    (participant) =>
      isAgentAddress(participant.address) &&
      localPartOf(participant.address) === localPartOf(parent.sender.address),
  );
  return match?.address;
}

/**
 * Posts a message into a workbench and routes it to every agent its
 * mentions, reply target, and host-default resolve to. The message
 * itself is one row plus one publish — no mail, no wake, no sidecar hop
 * — so a workbench with every agent process stopped still takes
 * messages and still renders them.
 *
 * Routing never branches on the workbench's `kind` (a chat and a
 * workbench are routed identically): an `@mention` always reaches its
 * agent; a plain reply to an agent's message reaches that agent too,
 * even unmentioned; and a message naming no agent at all (no mention,
 * no agent reply target) defaults to the workbench's host — its first
 * agent participant — so a single-agent workbench still auto-responds
 * and a multi-agent one routes through its host instead of going
 * silent.
 */
/**
 * Posts a message, then — CL-7450 — writes it into every human
 * participant's mailbox BEFORE the row is published or any agent is
 * dispatched: store row -> stamp Message-ID -> fan-out (one batch) ->
 * publish -> dispatch. A fan-out failure must fail the send before
 * anything is VISIBLE: no phantom bubble on the sender's own timeline
 * (no `chat.message` publish yet), and no duplicate row on a client
 * retry. The just-inserted row is therefore deleted on a fan-out failure
 * and the failure is rethrown to the caller — unlike agent dispatch
 * (`routeMessage`, fire-and-forget so a slept agent's wake never blocks
 * the sender's own bubble), a mailbox write failure is never swallowed
 * into an apparently-successful send.
 *
 * This is not a transactional guarantee: the row and the mailbox batch
 * are two separate writes (`insertRoomMessageRow` commits before
 * `mailboxFanOutForSend` ever runs), so a concurrent `GET` of the
 * timeline between the two CAN read the row before this function decides
 * whether to delete it again. The window is real, not merely believed
 * closed — it is bounded to the time between those two writes, not open
 * indefinitely, and nothing durable is built on top of what that window
 * exposes (no reply has been dispatched, no mailbox row written) before
 * the delete either lands or the row survives for good. A fan-out
 * failure surfaces as `MailboxFanoutFailedError` (`./mailbox-fanout.ts`),
 * which already carries the one `refId` `writeChatMailboxFanout` reported
 * under — the route layer quotes that ref rather than reporting again.
 */
export async function sendWorkbenchMessage(
  deps: SendWorkbenchMessageDeps,
  input: SendWorkbenchMessageInput,
): Promise<SendWorkbenchMessageResult> {
  const posted = await insertRoomMessageRow(deps, {
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    sender: { name: null, address: input.senderAddress },
    senderPrincipalId: input.principalId,
    parts: input.messageParts,
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
  });

  const mailboxDeps = deps.mailbox;
  if (mailboxDeps !== undefined) {
    try {
      await mailboxFanOutForSend(deps, mailboxDeps, input, posted.id);
    } catch (err) {
      await deps.roomMessages.deleteMessage({
        tenantId: input.tenantId,
        workbenchId: input.workbenchId,
        messageId: posted.id,
      });
      throw err;
    }
  }

  publishRoomMessageEvent(deps, posted);

  return {
    id: posted.id,
    createdAt: posted.createdAt,
    fanoutDelivered: routeMessage(deps, input, posted.id),
  };
}

/**
 * CL-7450: the human write path's own copy — every human participant's
 * `@corbits/mailbox` inbox gets this row, addressed by its own RFC 5322
 * Message-ID, before this call returns. Unlike agent dispatch
 * (`routeMessage`, fire-and-forget so a slept agent's wake never blocks
 * the sender's own bubble), a mailbox write failure must reach the
 * caller: `writeChatMailboxFanout` throws on anything but a genuinely
 * unknown participant, and this function does not catch it (its own
 * caller, `sendWorkbenchMessage`, does — to delete the just-inserted row).
 *
 * The Message-ID (and any `In-Reply-To` it carries) is minted with the
 * row's OWNING tenant's domain (`input.tenantId`, always `ownerTenantId`
 * at the route layer — see `routes.ts`'s `resolveWorkbenchAccess`), never
 * the acting caller's own tenant: a shared-workbench (projected-tenant)
 * sender's `input.senderAddress` carries their OWN tenant's domain, which
 * would otherwise stamp a row living in the owner tenant with a
 * Message-ID nobody else's mail agrees is addressed under.
 */
async function mailboxFanOutForSend(
  deps: SendWorkbenchMessageDeps,
  mailboxDeps: MailboxFanoutDeps,
  input: SendWorkbenchMessageInput,
  messageId: string,
): Promise<void> {
  const domain = await mailboxDeps.resolveTenantDomain(input.tenantId);
  const mailMessageId = mailMessageIdFor(messageId, domain);
  await deps.roomMessages.stampMailMessageId({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    messageId,
    mailMessageId,
  });

  const settingsRow = await deps.store.getWorkbenchSettings(
    input.tenantId,
    input.workbenchId,
  );
  const participants =
    settingsRow !== undefined ? participantsOf(settingsRow.settings) : [];

  const ancestors =
    deps.threads !== undefined
      ? await mailAncestryOf(
          deps.threads,
          input.tenantId,
          input.workbenchId,
          input.threadId ?? null,
        )
      : [];
  const inReplyTo =
    ancestors.length > 0
      ? mailMessageIdFor(ancestors[ancestors.length - 1] as string, domain)
      : undefined;
  const references = ancestors.map((ancestor) =>
    mailMessageIdFor(ancestor, domain),
  );

  const body = mailboxBodyOf(input.messageParts);
  await writeChatMailboxFanout(mailboxDeps, {
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    senderAddress: input.senderAddress,
    senderPrincipalId: input.principalId,
    participants,
    messageId: mailMessageId,
    subject: mailboxSubjectOf(body),
    body,
    ...(inReplyTo !== undefined ? { inReplyTo } : {}),
    ...(references.length > 0 ? { references } : {}),
  });
}

/**
 * Everything the sender's own message does NOT have to wait for:
 * resolving which agents this message is for, loading the re-situating
 * context a mentioned agent needs, and asking each of them for a turn.
 * A dispatch wakes an unroutable agent first — a full redeploy of a
 * slept one — so keeping this off the request path is what stops a
 * quiet workbench's first message from paying deploy time before the
 * sender's own bubble confirms.
 *
 * Never rejects. An agent that stays unreachable gets an honest notice
 * on the timeline in its own voice, matching how the orchestrator
 * already reports a turn that produced nothing — a sender must never be
 * left believing an agent received something it never did.
 */
async function routeMessage(
  deps: SendWorkbenchMessageDeps,
  input: SendWorkbenchMessageInput,
  messageId: string,
): Promise<void> {
  try {
    await routeToRecipients(deps, input, messageId);
  } catch (err) {
    fanoutLog.error(
      "Routing failed for workbench {workbenchId}'s message {messageId}; " +
        "the message itself is durable, but the agents it names may never " +
        "have been asked for a turn",
      { workbenchId: input.workbenchId, messageId, err },
    );
  }
}

/**
 * The thread a turn's context is confined to (CL-6329): a message inside
 * a sub-thread is answered with that sub-thread, never the whole room.
 * Returns nothing at all when the workbench has no thread store or the
 * triggering message carries no membership row — the room itself is the
 * scope then, which is exactly `assembleTurnContext`'s no-thread case.
 *
 * Membership is read once, in bulk, so the resolver `assembleTurnContext`
 * calls per message stays synchronous rather than fanning a query out
 * per timeline row.
 */
async function turnThreadScope(
  deps: Pick<SendWorkbenchMessageDeps, "threads">,
  input: Pick<SendWorkbenchMessageInput, "tenantId" | "workbenchId">,
  messageId: string,
): Promise<{ thread?: TurnContextThreadScope }> {
  if (deps.threads === undefined) return {};
  const assignments = await deps.threads.listThreadAssignments(
    input.tenantId,
    input.workbenchId,
  );
  const threadId = assignments.get(messageId);
  if (threadId === undefined) return {};
  return {
    thread: {
      threadId,
      threadIdOf: (id) => assignments.get(id) ?? "",
    },
  };
}

async function routeToRecipients(
  deps: SendWorkbenchMessageDeps,
  input: SendWorkbenchMessageInput,
  messageId: string,
): Promise<void> {
  const settingsRow = await deps.store.getWorkbenchSettings(
    input.tenantId,
    input.workbenchId,
  );
  const participants =
    settingsRow !== undefined ? participantsOf(settingsRow.settings) : [];

  const recipientSet = new Set(
    mentionedParticipants(input.messageParts, participants),
  );
  if (input.forcedRecipientAddress !== undefined) {
    recipientSet.add(input.forcedRecipientAddress);
  }
  if (input.inReplyToMessageId !== undefined) {
    const target = await replyTargetAgent(deps.roomMessages, {
      tenantId: input.tenantId,
      workbenchId: input.workbenchId,
      inReplyToMessageId: input.inReplyToMessageId,
      participants,
    });
    if (target !== undefined) recipientSet.add(target);
  }
  // No mention and no agent reply target: the default-routing case,
  // where the host receives every such message unconditionally. Assemble
  // this-room turn context the same way mention fan-out does, so a host
  // shared across rooms is not asked with another room's rows.
  const isDefaultRouting = recipientSet.size === 0;
  if (isDefaultRouting) {
    const host = participants.find((participant) =>
      isAgentAddress(participant.address),
    );
    if (host !== undefined) recipientSet.add(host.address);
  }
  const recipients = [...recipientSet];
  // CL-6644: unconditional, not gated on failure — the silent gap this
  // investigation found is that nothing at all logs between "message
  // persisted" and either a dispatch failure or a successful reply,
  // so a turn that resolves zero recipients (a workbench with no host
  // participant, a stale settings row) or one that stalls before ever
  // reaching `dispatchTurnBatch`'s own error handling looks identical
  // to total silence in the logs. This line exists so the next person
  // chasing an "agent never replied" report can tell, from logs alone,
  // whether routing ever ran and what it resolved to.
  fanoutLog.info(
    "Routed workbench {workbenchId}'s message {messageId} to {count} " +
      "recipient(s): {recipients}",
    {
      workbenchId: input.workbenchId,
      messageId,
      count: recipients.length,
      recipients,
    },
  );

  const contextText =
    recipients.length > 0
      ? await assembleTurnContext({
          roomMessages: deps.roomMessages,
          tenantId: input.tenantId,
          workbenchId: input.workbenchId,
          excludeMessageId: messageId,
          participants,
          contextWindow: resolveContextWindow(
            settingsRow?.settings ?? {},
            benchContextWindowOf(
              (await deps.store.getBenchSettings(input.tenantId))?.settings ??
                {},
            ),
          ).value,
          ...(await turnThreadScope(deps, input, messageId)),
        })
      : undefined;
  const turnParts =
    contextText !== undefined
      ? (mergeContextIntoParts(contextText, input.messageParts) as PartType[])
      : input.messageParts;

  await deps.turnQueue.run(
    input.workbenchId,
    {
      messageId,
      principalId: input.principalId,
      recipients,
      parts: turnParts,
    },
    (batch) =>
      dispatchTurnBatch(deps, input.tenantId, input.workbenchId, batch),
  );
}

/**
 * Runs one workbench turn — either a single message's own fan-out, or
 * several queued messages batched together (CL-6331) — against every
 * recipient the batch names, unioned in arrival order and de-duplicated
 * so an agent mentioned across more than one queued message is still
 * only asked once. Each queued message's parts are concatenated in the
 * same order, so the combined context an agent sees reads the same
 * left-to-right order the room itself does. Never rejects: a recipient
 * that can't be reached gets an undelivered notice in its own voice,
 * exactly as a single, unqueued message's fan-out always has.
 */
async function dispatchTurnBatch(
  deps: Pick<
    SendWorkbenchMessageDeps,
    | "platform"
    | "roomMessages"
    | "publish"
    | "turnDispatchTimeoutMs"
    | "waitUntilFreeTimeoutMs"
    | "agentTurns"
    | "turnCancellation"
    | "turnMailCorrelation"
    | "mailbox"
    | "threads"
  >,
  tenantId: string,
  workbenchId: string,
  batch: readonly QueuedTurn[],
): Promise<void> {
  const turnDispatchTimeoutMs =
    deps.turnDispatchTimeoutMs ?? DEFAULT_TURN_DISPATCH_TIMEOUT_MS;
  const waitUntilFreeTimeoutMs =
    deps.waitUntilFreeTimeoutMs ?? DEFAULT_WAIT_UNTIL_FREE_TIMEOUT_MS;
  const recipientSet = new Set<string>();
  for (const turn of batch) {
    for (const agentAddress of turn.recipients) recipientSet.add(agentAddress);
  }
  const recipients = [...recipientSet];
  const parts = batch.flatMap((turn) => turn.parts) as PartType[];
  const last = batch[batch.length - 1];
  if (last === undefined) return;
  const messageIds = batch.map((turn) => turn.messageId);

  // CL-6644: unconditional entry marker — see the matching note on the
  // caller's own recipient-resolution log. This is the one line that
  // proves execution reached turn dispatch at all; its absence for a
  // message known to have persisted narrows a future "no reply"
  // report to upstream of here without needing a live repro first.
  fanoutLog.info(
    "Dispatching workbench {workbenchId}'s turn for message(s) " +
      "{messageIds} to {count} recipient(s): {recipients}",
    { workbenchId, messageIds, count: recipients.length, recipients },
  );

  // Concurrent: agents are independent, and a dispatch that has to wake
  // its target pays a full redeploy — serially, one slept agent would
  // delay every agent mentioned after it.
  await Promise.all(
    recipients.map(async (agentAddress) => {
      // CL-7201: one controller for this recipient's whole attempt —
      // spanning both the `waitUntilFree` wait below and the
      // `dispatchTurn` call after it — so a cancel request lands
      // wherever this recipient actually is, not just one of the two
      // phases. Registered before either `withTimeout` call and always
      // unregistered once this recipient's own attempt settles, win or
      // lose, so a cancel arriving after the fact never reaches (or
      // leaks a reference to) a controller nothing is listening on any
      // more.
      const cancelController = deps.turnCancellation.register(workbenchId);
      try {
        // CL-6670: wait under its own deadline, separate from the
        // per-hop deadline below. An agent that already has a turn
        // running must never be handed a second occurrence while the
        // first is still generating — the sidecar's `agent.event`
        // stream carries only the agent's address, so
        // `chat-orchestrator.ts`'s reply path cannot tell two
        // simultaneously-`running` turns for the same agent apart (see
        // `AgentTurnStore.findRunningTurn`'s own doc comment) and one
        // of the two replies would land stamped onto the wrong turn, or
        // as the wrong turn's own drop notice. Waiting here serializes
        // the SAME agent's turns into arrival order, in this
        // recipient's own concurrent branch only — a different agent
        // named in the same batch (`recipients.map` above) is a
        // different key and proceeds immediately, unaffected.
        //
        // CL-7129: this wait is bounded — `waitUntilFreeTimeoutMs`, kept
        // below the turn-claim TTL alongside `turnDispatchTimeoutMs`
        // below — because it runs while `turn-queue.ts` still holds
        // this workbench's claim; left unbounded, a slow prior turn
        // could hold that claim past its TTL and let a second `run()`
        // start a second, concurrent drain of the same queue.
        const agentTurns = deps.agentTurns;
        if (agentTurns !== undefined) {
          await withTimeout(
            (signal) =>
              agentTurns.waitUntilFree(
                { tenantId, workbenchId, agentAddress },
                signal,
              ),
            waitUntilFreeTimeoutMs,
            waitUntilFreeTimeoutMessage(agentAddress, waitUntilFreeTimeoutMs),
            cancelController.signal,
          );
        }
        // CL-6644: one deadline around the whole turn, not another
        // per-hop bound. `dispatchTurn` only ever reaches "the mail was
        // handed to the agent's mailbox" (see `./turn-queue.ts`'s own
        // note) — the agent's actual streaming reply is produced and
        // posted onto the timeline later, off this call stack, through
        // `chat-orchestrator.ts`'s independent sidecar-event
        // subscription. This deadline therefore can never cut off a
        // reply in progress: nothing it awaits is the reply.
        //
        // CL-7193: `dispatchTurn` gets the deadline's own `AbortSignal`
        // so it can close its turn row the instant the deadline fires,
        // instead of leaving it `running` until (or unless) the
        // abandoned `sendMail` below eventually settles.
        await withTimeout(
          (signal) =>
            dispatchTurn(
              deps,
              {
                tenantId,
                workbenchId,
                principalId: last.principalId,
                agentAddress,
                parts,
                requestMessageIds: messageIds,
              },
              signal,
            ),
          turnDispatchTimeoutMs,
          turnDispatchTimeoutMessage(agentAddress, turnDispatchTimeoutMs),
          cancelController.signal,
        );
      } catch (err) {
        // CL-7201: a deliberate cancellation is not a failure — the
        // user asked for exactly this. `dispatchTurn`'s own abort-close
        // handler (if this recipient was still inside its `sendMail`
        // call) or `cancelWorkbenchTurn`'s sweep (if it wasn't) already
        // settled the turn row and posted the one honest notice this
        // gets; reporting it here too would double-post and misfile a
        // user action as an operational error.
        if (err instanceof TurnCancelledError) {
          fanoutLog.info(
            "Turn dispatch for {agentAddress} on workbench {workbenchId} " +
              "was cancelled by the user for message(s) {messageIds}",
            { agentAddress, workbenchId, messageIds },
          );
          return;
        }
        const refId = reportError(err, {
          operation: "chat.dispatchTurn",
          tenantId,
          roomId: workbenchId,
          agentId: agentAddress,
          extra: { messageIds },
        });
        fanoutLog.error(
          "Asking {agentAddress} for a turn failed for workbench " +
            "{workbenchId}'s message(s) {messageIds} (ref {refId}); " +
            "posting an undelivered notice in its voice: {err}",
          {
            agentAddress,
            workbenchId,
            messageIds,
            refId,
            err,
          },
        );
        await postUndeliveredNotice(deps, {
          tenantId,
          workbenchId,
          agentAddress,
          cause: err,
          refId,
        });
      } finally {
        deps.turnCancellation.unregister(workbenchId, cancelController);
      }
    }),
  );
}

export type DispatchTurnInput = {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly principalId: string;
  readonly agentAddress: string;
  readonly parts: PartType[];
  /** The room messages this turn answers, in arrival order. */
  readonly requestMessageIds: readonly string[];
};

/**
 * Asks one agent for a turn — the seam between the room (rows on a
 * timeline) and the execution plane.
 *
 * A room agent deploys as an `onTrigger` section (CL-6329, see
 * `./standalone-launch.ts`'s `AGENT_SECTION_MODE`), so this fires that
 * section's trigger: one occurrence, running as its own child run
 * (`turn__<n>`) with its own event log, against the one warm run the
 * (agent, workbench) pair already holds. The trigger is a mail trigger —
 * that is the primitive the section subscribes on — so `sendMail`
 * remains the transport, but what it starts is now an occurrence rather
 * than another turn folded into one endless step.
 *
 * The projection row opens BEFORE the trigger fires, so an in-flight
 * turn is visible from its first moment and the child run id its reply
 * will carry is already allocated. A trigger that never lands closes the
 * row `failed` and rethrows, leaving the caller to post the undelivered
 * notice it always has.
 *
 * CL-7193: `sendMail` itself has no cancellable primitive — a caller's
 * `signal` firing can't stop the send in flight, only close the
 * bookkeeping around it. The moment it aborts, this closes the turn row
 * `failed` immediately rather than waiting for `sendMail` to eventually
 * settle, so a real reply that later lands (behind the undelivered
 * notice the caller already posted for this timeout) finds no `running`
 * row to attach to — `finishTurn`'s compare-and-set means whichever of
 * the abort close and the late reply's own close reaches the row first
 * is the only one that applies.
 *
 * CL-7201: the same abort can also be a deliberate cancellation rather
 * than a timeout (`signal.reason instanceof TurnCancelledError`) — this
 * closes the row `cancelled` instead of `failed` in that case, and, only
 * if this close actually wins `finishTurn`'s compare-and-set (this
 * recipient's controller was still reachable when the user cancelled),
 * posts the one cancelled notice the timeline gets for it. Losing that
 * race means `cancelWorkbenchTurn`'s own sweep already settled the row
 * and posted the notice instead — exactly one of the two ever does. A
 * signal already aborted BEFORE this is ever called returns immediately
 * after closing the row, never calling `sendMail` at all — that is not
 * CL-7230's ceiling (a send already in flight, which cannot be
 * stopped), just a send that hasn't started yet and has no reason to.
 */
export async function dispatchTurn(
  deps: Pick<
    SendWorkbenchMessageDeps,
    | "platform"
    | "agentTurns"
    | "roomMessages"
    | "publish"
    | "turnMailCorrelation"
    | "mailbox"
    | "threads"
  >,
  input: DispatchTurnInput,
  signal?: AbortSignal,
): Promise<void> {
  const turn = await deps.agentTurns?.startTurn({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    agentAddress: input.agentAddress,
    requestMessageIds: input.requestMessageIds,
  });

  const closeAsTimedOut = () => {
    if (turn === undefined) return;
    const cancelled = signal?.reason instanceof TurnCancelledError;
    deps.agentTurns
      ?.finishTurn({
        tenantId: input.tenantId,
        turnId: turn.id,
        status: cancelled ? "cancelled" : "failed",
        error:
          signal?.reason instanceof Error
            ? signal.reason.message
            : "turn dispatch timed out",
      })
      .then((finished) => {
        if (finished === undefined || !cancelled) return;
        return postCancelledNotice(deps, {
          tenantId: input.tenantId,
          workbenchId: input.workbenchId,
          agentAddress: input.agentAddress,
        });
      })
      .catch((err: unknown) => {
        reportError(err, {
          operation: "chat.dispatchTurn.closeAsTimedOut",
          tenantId: input.tenantId,
          roomId: input.workbenchId,
          agentId: input.agentAddress,
        });
      });
  };
  if (signal?.aborted) {
    // CL-7201 (Critique finding): already aborted before `sendMail` was
    // ever asked to run at all — not CL-7230's "aborts while sendMail
    // is already in flight" ceiling, which genuinely cannot be
    // stopped. Firing a brand-new mail send for a turn already known
    // (and closed) as cancelled would orphan a reply nothing could ever
    // attach to a running row again, so this returns instead of falling
    // through to it.
    closeAsTimedOut();
    return;
  }
  signal?.addEventListener("abort", closeAsTimedOut, { once: true });

  try {
    // RFC 5322 threading (CL-7450): the dispatched frame carries the same
    // identity the row it answers already carries on the timeline — its
    // Message-ID is derived, never minted separately (`mailMessageIdFor`),
    // so it always equals what `mailboxFanOutForSend` already stamped for
    // that row — and names the row's own parent chain in
    // `In-Reply-To`/`References`. Degrades to unthreaded (as before) when
    // this composition has no mailbox domain to derive it from.
    const sourceMessageId =
      input.requestMessageIds[input.requestMessageIds.length - 1];
    const mailboxDeps = deps.mailbox;
    const threadHeaders =
      mailboxDeps !== undefined && sourceMessageId !== undefined
        ? await (async () => {
            const domain = await mailboxDeps.resolveTenantDomain(
              input.tenantId,
            );
            const threadId =
              deps.threads !== undefined
                ? ((await deps.threads.threadIdForMessage(
                    input.tenantId,
                    input.workbenchId,
                    sourceMessageId,
                  )) ?? null)
                : null;
            const ancestors =
              deps.threads !== undefined
                ? await mailAncestryOf(
                    deps.threads,
                    input.tenantId,
                    input.workbenchId,
                    threadId,
                  )
                : [];
            return mailThreadHeaders({
              rowId: sourceMessageId,
              domain,
              ancestors,
            });
          })()
        : undefined;

    const sent = await deps.platform.sendMail({
      tenantId: input.tenantId,
      workbenchId: localPartOf(input.agentAddress),
      principalId: input.principalId,
      content: encodeParts(input.parts, {
        replyTo: input.workbenchId,
        ...threadHeaders,
      }),
      fromWorkbenchId: input.workbenchId,
    });
    // The reply path threads under the turn that produced it (CL-6314),
    // and this mail is what opens that turn's bracket — so record which
    // message it answers while both halves are in hand. The latest
    // message, matching how a batch already attributes its principal:
    // the conversation is where its newest message is. A record that
    // fails is reported, never thrown: the turn was dispatched, and
    // threading degrades to unthreaded rather than failing it.
    if (
      sourceMessageId !== undefined &&
      deps.turnMailCorrelation !== undefined
    ) {
      try {
        await deps.turnMailCorrelation.recordTurnMail({
          tenantId: input.tenantId,
          mailId: sent.id,
          workbenchId: input.workbenchId,
          sourceMessageId,
        });
      } catch (err) {
        reportError(err, {
          operation: "chat.dispatchTurn.recordTurnMail",
          tenantId: input.tenantId,
          roomId: input.workbenchId,
          agentId: input.agentAddress,
          extra: { mailId: sent.id, sourceMessageId },
        });
      }
    }
  } catch (err) {
    if (turn !== undefined) {
      await deps.agentTurns?.finishTurn({
        tenantId: input.tenantId,
        turnId: turn.id,
        status: "failed",
        error: consumerTurnError(err),
      });
    }
    throw err;
  } finally {
    signal?.removeEventListener("abort", closeAsTimedOut);
  }
}

const CREDENTIAL_UNDELIVERED_NOTICE =
  "I can't reach a model right now — add or check your model key in " +
  "Settings, then I'll pick this up.";
const RETRYABLE_UNDELIVERED_NOTICE =
  "I didn't get that one — send it again and I'll pick it up.";
const MODEL_UNAVAILABLE_UNDELIVERED_NOTICE = MODEL_UNAVAILABLE_CONSUMER_MESSAGE;

/**
 * Whether a dispatch failure is a credential/inference-resolution
 * problem resending can never fix — as opposed to a genuinely transient
 * failure (sidecar hiccup, momentary network blip) where "send it again"
 * is honest advice. `InferenceResolutionError` / `ModelUnavailableError`
 * is the launch/wake case: the agent's definition has no resolvable
 * inference source at all — that gets its own model-unavailable notice,
 * not the credential-key copy. A dispatch failure whose own status/code
 * marks it a 401 `credential_failure` is the runtime case: a source
 * resolved, but the credential itself was rejected. Every other cause —
 * unclassified, or missing that shape entirely — is treated as
 * genuinely retryable, per the "conservative classification" rule
 * `chat-orchestrator.ts`'s own provider-health reporting already follows:
 * silence (here, the generic notice) over a wrong attribution.
 */
function isCredentialDispatchFailure(cause: unknown): boolean {
  if (isModelUnavailableCause(cause)) return false;
  if (cause !== null && typeof cause === "object") {
    const status = (cause as { status?: unknown; statusCode?: unknown }).status;
    const statusCode = (cause as { statusCode?: unknown }).statusCode;
    const code = (cause as { code?: unknown; category?: unknown }).code;
    const category = (cause as { category?: unknown }).category;
    if (status === 401 || statusCode === 401) return true;
    if (code === "credential_failure" || category === "credential_failure")
      return true;
  }
  return false;
}

/**
 * Reports one agent that could not be reached on the timeline, in that
 * agent's own voice and from its own address — the same attribution its
 * real replies carry — so an unreachable teammate reads as a teammate
 * who missed the message rather than as silence. The notice itself is
 * cause-aware (CL-6360, owner hit it live): a credential or
 * inference-resolution failure gets copy that actually helps ("add or
 * check your model key"), never the generic "send it again" that lies
 * about resending ever being able to help. Swallows its own failure: if
 * the timeline itself is unreachable there is nowhere left to say so,
 * and the error is already logged by the caller.
 */
async function postUndeliveredNotice(
  deps: Pick<SendWorkbenchMessageDeps, "roomMessages" | "publish">,
  input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    readonly agentAddress: string;
    readonly cause: unknown;
    /** The `reportError` refId for the cause the caller already logged —
     * a person can quote this to support instead of the notice reading
     * as unexplainable silence. */
    readonly refId: string;
  },
): Promise<void> {
  try {
    const modelUnavailable = isModelUnavailableCause(input.cause);
    const notice = modelUnavailable
      ? MODEL_UNAVAILABLE_UNDELIVERED_NOTICE
      : isCredentialDispatchFailure(input.cause)
        ? CREDENTIAL_UNDELIVERED_NOTICE
        : RETRYABLE_UNDELIVERED_NOTICE;
    await postRoomMessage(deps, {
      tenantId: input.tenantId,
      workbenchId: input.workbenchId,
      sender: { name: null, address: input.agentAddress },
      runId: localPartOf(input.agentAddress),
      parts: [
        {
          kind: "text",
          text: `${notice} (ref ${input.refId})`,
          turnFailed: true,
          ...(modelUnavailable
            ? { turnFailedReason: "model_unavailable" as const }
            : {}),
        },
      ],
    });
  } catch (err) {
    fanoutLog.error(
      "Could not post the undelivered notice for {agentAddress} onto " +
        "workbench {workbenchId}'s timeline: {err}",
      { agentAddress: input.agentAddress, workbenchId: input.workbenchId, err },
    );
  }
}

const CANCELLED_NOTICE = "This turn was cancelled.";

/**
 * The timeline's own record of a cancellation (CL-7201) — deliberately
 * distinct from `postUndeliveredNotice`: a user stopping a turn is not a
 * failure, and reusing `turnFailed`'s "didn't reply" framing (with its
 * Retry action) would misrepresent something the user asked for as
 * something that went wrong on its own. Posted in the cancelled agent's
 * own voice for the same reason `postUndeliveredNotice` is: the person
 * reading the room sees who stopped replying and why, without a system
 * message breaking the conversation's voice. Swallows its own failure
 * exactly like `postUndeliveredNotice` — if the timeline is unreachable
 * there is nowhere left to say so.
 */
async function postCancelledNotice(
  deps: Pick<SendWorkbenchMessageDeps, "roomMessages" | "publish">,
  input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    readonly agentAddress: string;
  },
): Promise<void> {
  try {
    await postRoomMessage(deps, {
      tenantId: input.tenantId,
      workbenchId: input.workbenchId,
      sender: { name: null, address: input.agentAddress },
      runId: localPartOf(input.agentAddress),
      parts: [
        {
          kind: "text",
          text: CANCELLED_NOTICE,
          turnCancelled: true,
        },
      ],
    });
  } catch (err) {
    // report-error-ignore: mirrors postUndeliveredNotice just above —
    // the timeline being unreachable here is the same pre-existing,
    // already-tracked class of failure with nowhere left to report to.
    fanoutLog.error(
      "Could not post the cancelled-turn notice for {agentAddress} onto " +
        "workbench {workbenchId}'s timeline: {err}",
      { agentAddress: input.agentAddress, workbenchId: input.workbenchId, err },
    );
  }
}

export type CancelWorkbenchTurnResult = {
  /** How many turns were running for this workbench the moment cancel
   * was asked for, and are now settled `cancelled` — the honest answer
   * to "what did cancelling stop," per CL-7230's ceiling. Counted by
   * outcome, not by which of the two mechanisms below actually
   * performed the write: a turn `dispatchTurn`'s own abort-close
   * settled a moment before this call's sweep reached it still counts
   * here as cancelled. A workbench with nothing running returns 0. */
  readonly cancelledCount: number;
};

/**
 * Stops a workbench's in-flight turn(s) (CL-7201) — the cancel route's
 * own logic, kept here rather than in `routes.ts` so it is testable
 * without an HTTP round trip.
 *
 * Two independent mechanisms, run together, because a turn can be in
 * either of two places when the user asks to stop it:
 *
 * 1. Still reachable on our own call stack — `dispatchTurnBatch`'s
 *    per-recipient controller (`./turn-cancellation.ts`) is aborted,
 *    which cuts the `waitUntilFree` wait or the `dispatchTurn` call
 *    short exactly like a timeout does, synchronously, the moment
 *    `cancel` below fires. That recipient's own abort-close handler
 *    settles its row and posts the notice — frequently winning the
 *    race against this function's own sweep, below, for any turn that
 *    was still reachable this way.
 * 2. Already off our call stack entirely — `sendMail` already resolved,
 *    the agent is generating (or parked on an approval gate somewhere in
 *    the execution plane this package cannot see into).
 *    Nothing is registered to abort any more, so the row is found via
 *    `findRunningTurns` (snapshotted BEFORE `cancel` below, so a row
 *    path 1 already claimed is still counted) and settled directly.
 *
 * Both paths call the same `finishTurn` compare-and-set, so whichever
 * reaches a given row first is the only one that ever settles or
 * notifies for it — never both, never neither; the loser's own
 * `finishTurn` call harmlessly returns `undefined`. CL-7230's known
 * ceiling applies to path 2 specifically: settling the row is not the
 * same as stopping the underlying agent process, which this cannot
 * reach.
 */
export async function cancelWorkbenchTurn(
  deps: Pick<
    SendWorkbenchMessageDeps,
    "agentTurns" | "turnCancellation" | "roomMessages" | "publish"
  >,
  input: { readonly tenantId: string; readonly workbenchId: string },
): Promise<CancelWorkbenchTurnResult> {
  if (deps.agentTurns === undefined) {
    deps.turnCancellation.cancel(input.workbenchId);
    return { cancelledCount: 0 };
  }
  const agentTurns = deps.agentTurns;

  // Snapshotted before `cancel` fires: path 1's abort-close can (and
  // often does) win a row's compare-and-set synchronously inside
  // `cancel` itself, before this sweep's own `finishTurn` call ever
  // runs — this list is what lets the sweep still count, and settle,
  // whatever it didn't personally win.
  const running = await agentTurns.findRunningTurns({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
  });

  deps.turnCancellation.cancel(input.workbenchId);

  await Promise.all(
    running.map(async (turn) => {
      const finished = await agentTurns.finishTurn({
        tenantId: input.tenantId,
        turnId: turn.id,
        status: "cancelled",
        error: "Cancelled by user",
      });
      // `undefined` means path 1's abort-close already won this row —
      // it already posted its own notice, so posting a second one here
      // would double it up.
      if (finished === undefined) return;
      await postCancelledNotice(deps, {
        tenantId: input.tenantId,
        workbenchId: input.workbenchId,
        agentAddress: finished.agentAddress,
      });
    }),
  );

  const settled = await Promise.all(
    running.map((turn) =>
      agentTurns.getTurn({ tenantId: input.tenantId, turnId: turn.id }),
    ),
  );
  return {
    cancelledCount: settled.filter((turn) => turn?.status === "cancelled")
      .length,
  };
}
