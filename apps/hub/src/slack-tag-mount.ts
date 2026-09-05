// Slack tag ingress mount (CL-5288 Phase 1): the thin, env-gated glue
// between `@corbits/slack-tag`'s composition and this hub's already-
// running `@corbits/chat` instances. The overwhelming majority of the
// behavior lives in the package — this module only supplies the
// host-resident functions the package's `MountWorkbenchSlackDeps`
// wants injected (per AGENTS.md: apps stay generic, packages own the
// domain), plus the env-var gate.
//
// Absent `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET` is a valid
// configuration, not an error: the hub runs fine with no Slack app
// installed, and this mount is silently skipped — mirrors every other
// optional integration mount in `./index.ts` (e.g. `mountMemory`,
// `mountArtifacts`).
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { DB } from "@intx/db";
import { principal, tenant } from "@intx/db/schema";
import { getLogger } from "@intx/log";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { AppEnv } from "@intx/hub-api";

import {
  launchAndJoinAgent,
  presetForKind,
  sendWorkbenchMessage,
  type WorkbenchSubscriberRegistry,
  type WorkbenchTenancyStore,
  type WorkbenchTurnQueue,
  type TurnCancelRegistry,
  type TurnMailCorrelationStore,
  type ChatPlatform,
  type ChatStore,
  type RoomMessageStore,
} from "@corbits/chat";
import type { SessionForUser } from "@workbench/onboarding";
import {
  createAutoProvisionPrincipalResolver,
  createDrizzleSlackChannelBindingStore,
  mountWorkbenchSlack,
  resolveThreadState,
  applySlackTagMigrations,
} from "@corbits/slack-tag";
import { mintSlackChannelWorkbench } from "./slack-channel-mint-session";

const log = getLogger(["hub", "slack-tag"]);

/** The one role every auto-provisioned Slack principal is granted.
 * Every bench mints this system role at creation (see
 * `@corbits/chat`'s `workbench-tenancy.ts`), so it always resolves. */
const SLACK_PRINCIPAL_ROLE_NAMES = ["member"] as const;

export type MountWorkbenchSlackTagDeps = {
  readonly app: Hono<AppEnv>;
  readonly db: DB["db"];
  readonly databaseUrl: string;
  readonly chatStore: Pick<
    ChatStore,
    | "getWorkbenchSettings"
    | "getBenchSettings"
    | "createWorkbenchSettings"
    | "updateWorkbenchSettings"
    | "mutateWorkbenchParticipants"
  >;
  readonly chatPlatform: ChatPlatform;
  readonly roomMessages: RoomMessageStore;
  readonly chatTenancy: Pick<
    WorkbenchTenancyStore,
    "createWorkbenchTenant" | "getWorkbenchOwnerUserId" | "addWorkbenchMember"
  >;
  readonly sessionFor: SessionForUser;
  readonly workbenchSubscribers: WorkbenchSubscriberRegistry;
  /** The same one-in-flight-turn-per-workbench queue `createChatRoutes`
   * is given (CL-6331) — shared, never a second instance, so a Slack
   * send and a person's own message for the same channel serialize
   * against each other too. */
  readonly turnQueue: WorkbenchTurnQueue;
  /** The same cancellation registry `createChatRoutes` is given
   * (CL-7201) — shared, never a second instance. */
  readonly turnCancellation: TurnCancelRegistry;
  /** The same dispatch-mail correlation `createChatRoutes` is given
   * (CL-6314) — shared, never a second instance. */
  readonly turnMailCorrelation?: TurnMailCorrelationStore;
};

export type MountedWorkbenchSlackTag = { readonly mounted: boolean };

/**
 * Reads `SLACK_WORKBENCH_TENANT_SLUG` and `SLACK_DEFAULT_AGENT_DEFINITION_ID`
 * alongside the credential pair: which bench a Slack workspace's messages
 * land in, and which deployed agent definition a freshly bound channel
 * launches with, are both irreducible to this mount — there is no honest
 * default. Set together with the credential pair, or the mount fails
 * loudly rather than silently answering nobody.
 */
export async function mountWorkbenchSlackTag(
  deps: MountWorkbenchSlackTagDeps,
): Promise<MountedWorkbenchSlackTag> {
  const botToken = process.env["SLACK_BOT_TOKEN"];
  const signingSecret = process.env["SLACK_SIGNING_SECRET"];
  if (!botToken || !signingSecret) {
    log.info(
      "Slack tag ingress not mounted — SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET unset",
    );
    return { mounted: false };
  }

  const tenantSlug = process.env["SLACK_WORKBENCH_TENANT_SLUG"];
  const definitionId = process.env["SLACK_DEFAULT_AGENT_DEFINITION_ID"];
  if (!tenantSlug || !definitionId) {
    throw new Error(
      "SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET are set, but SLACK_WORKBENCH_TENANT_SLUG " +
        "and/or SLACK_DEFAULT_AGENT_DEFINITION_ID are not — both name the bench and " +
        "agent a Slack message resolves to, and there is no honest default for either.",
    );
  }

  const tenantRow = await deps.db.query.tenant.findFirst({
    where: eq(tenant.slug, tenantSlug),
  });
  if (tenantRow === undefined) {
    throw new Error(
      `SLACK_WORKBENCH_TENANT_SLUG "${tenantSlug}" does not name a real tenant`,
    );
  }

  await applySlackTagMigrations(deps.databaseUrl);

  const resolvePrincipal = createAutoProvisionPrincipalResolver(
    deps.db,
    tenantSlug,
    SLACK_PRINCIPAL_ROLE_NAMES,
  );
  const bindings = createDrizzleSlackChannelBindingStore(deps.db);
  const state = await resolveThreadState(createMemoryState());

  // `mountWorkbenchSlack` (like `corbits-tag/slack`'s own `mountSlackTag`)
  // deliberately types its `app` param against the default Hono env: the
  // route lives outside the hub's session auth and reads nothing from
  // `AppEnv`'s context. The cast reflects that, not a real env mismatch.
  const { path } = mountWorkbenchSlack(deps.app as unknown as Hono, {
    tenantId: tenantRow.id,
    slack: { botToken, signingSecret },
    state,
    bindings,
    resolvePrincipal,
    subscribeToChannel: deps.chatPlatform.subscribeToWorkbench,
    provisionChannel: async (input) => {
      const creatorPrincipal = await deps.db.query.principal.findFirst({
        where: eq(principal.id, input.creatorPrincipalId),
      });
      if (creatorPrincipal === undefined) {
        throw new Error(
          `Slack-provisioned principal "${input.creatorPrincipalId}" vanished before its channel could be provisioned`,
        );
      }

      const minted = await mintSlackChannelWorkbench(
        {
          tenantId: tenantRow.id,
          getWorkbenchOwnerUserId: (id) =>
            deps.chatTenancy.getWorkbenchOwnerUserId(id),
          sessionFor: deps.sessionFor,
          chatTenancy: deps.chatTenancy,
        },
        {
          name: input.name,
          creatorRefId: creatorPrincipal.refId,
        },
      );
      const channelId = minted.channelId;

      const preset = presetForKind("chat");
      const settingsRow = await deps.chatStore.createWorkbenchSettings({
        tenantId: tenantRow.id,
        workbenchId: channelId,
        settings: {
          "chat/kind": "chat",
          "chat/pinned": preset.pinned,
          "chat/participants": [],
          "chat/name": input.name,
        },
        updatedBy: input.creatorPrincipalId,
      });

      await launchAndJoinAgent(
        {
          store: deps.chatStore,
          platform: deps.chatPlatform,
          roomMessages: deps.roomMessages,
          publish: deps.workbenchSubscribers.publish,
        },
        {
          tenantId: tenantRow.id,
          principalId: input.creatorPrincipalId,
          workbenchId: channelId,
          definitionId,
          existingSettings: settingsRow.settings,
          invitable: await deps.chatPlatform.listInvitableDefinitions(
            tenantRow.id,
          ),
        },
      );

      log.info(
        "Provisioned channel {channelId} for tenant {tenantId} ({channelTenant})",
        {
          channelId,
          tenantId: tenantRow.id,
          channelTenant: minted.workbenchTenantId,
        },
      );
      return { channelId };
    },
    sendMessage: async (input) => {
      const sent = await sendWorkbenchMessage(
        {
          store: deps.chatStore,
          platform: deps.chatPlatform,
          roomMessages: deps.roomMessages,
          publish: deps.workbenchSubscribers.publish,
          turnQueue: deps.turnQueue,
          turnCancellation: deps.turnCancellation,
          ...(deps.turnMailCorrelation !== undefined
            ? { turnMailCorrelation: deps.turnMailCorrelation }
            : {}),
        },
        {
          tenantId: input.tenantId,
          principalId: input.principalId,
          senderAddress: `${input.principalId}@${tenantRow.domain}`,
          workbenchId: input.channelId,
          messageParts: [{ kind: "text", text: input.text }],
        },
      );
      return { id: sent.id };
    },
  });

  log.info("Slack tag ingress mounted at {path} for tenant {tenantSlug}", {
    path,
    tenantSlug,
  });
  return { mounted: true };
}
