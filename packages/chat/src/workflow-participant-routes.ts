// Workflow-run-authenticated surfaces for a child process that is itself
// messaging in a workbench:
//
// - `POST /participants/mint-dm` — `create_agent`'s default path: mint or
//   reopen the specialist's `kind: chat` 1:1 for a definition and launch
//   the agent into THAT workbench (never into Myra's own DM).
// - `POST /participants/invite` — invite an already-created definition
//   into a non-chat workbench the caller already participates in.
// - `POST /participants/messages` — post a message (e.g. ask_user block)
//   into the caller's own workbench.
//
// Invite reuses `./workbench-service.ts`'s `launchAndJoinAgent`; mint-dm
// reuses `mintAgentDm`. Mirrors `@corbits/agent-directory`'s
// `workflow-capability-routes.ts`/`workflow-create-routes.ts`: a
// workflow child has no browser session, only its sidecar bearer token
// and its own run address, so it authenticates through a
// `WorkflowRunAuthenticator` rather than the tenant-session pipeline
// `./routes.ts` uses.
//
// Mounted OUTSIDE the tenant prefix for that reason. Identity NEVER
// rides in a request body or path: the tenant, principal, and target
// workbench every write is scoped to come from the authenticated run
// alone.
//
// Scope: self-WORKBENCH. "The caller's own workbench" is resolved from the
// authenticated run's own mail address via `ChatStore.findWorkbenchByParticipantAddress`
// (see that method's own doc comment in `./store.ts` for the O(workbenches-
// in-tenant) scan it runs and the [Intx/repo gap] it names: no direct
// run-address -> workbench index exists yet). A run whose address is not
// a participant of any workbench in its tenant — a run this route was
// never meant to serve, or called before the run has actually joined
// anything — gets a 404, never a guess at which workbench it meant.
//
// Authorization decision (same shape as `@corbits/agent-directory`'s
// workflow-run routes, see those files' own comments for the full
// reasoning this mirrors): this route carries no `requireGrant` check.
// The calling tool (`@corbits/agent-directory-tools`' `create_agent`)
// declares `approval: "ask"` (`@intx/agent`'s native per-invocation
// gate), so a human already had to approve the specific agent being
// created (and, by extension, minted/invited) before this route ever runs.
// This route still enforces, unconditionally: (1) the caller's run
// must resolve to a live tenant/principal/run via the sidecar-token +
// run-address check below, and (2) the resolved workbench must actually
// carry the caller's own address as a participant — a run can never
// invite into a workbench it is not itself in.
import { Hono } from "hono";
import { type } from "arktype";
import {
  DefinitionProjectionMissingError,
  InferenceResolutionError,
} from "@corbits/folded-runs";

import {
  KindIsChatError,
  launchAndJoinAgent,
  mintAgentDm,
  sendWorkbenchMessage,
  type LaunchAndJoinAgentDeps,
  type SendWorkbenchMessageDeps,
} from "./workbench-service";
import type { ChatStore } from "./store";
import { Part, type Part as PartType } from "./parts";
import { QuestionBlockData } from "./blocks";
import type { RoomMessage, RoomMessageStore } from "./room-messages";
import {
  CONNECTIONS_PENDING_KEY,
  connectServiceConnectorIds,
  pendingConnectionsOf,
} from "./connect-pending";
import type { WorkbenchTenancyStore } from "./workbench-tenancy";
import { MODEL_UNAVAILABLE_CONSUMER_MESSAGE } from "./model-unavailable";
import { reportError } from "@corbits/error-sink";
import { makeErrorEnvelope } from "@corbits/error-sink";

/**
 * The tenant + principal + run a presented sidecar token and run
 * address resolve to. Declared structurally (mirroring
 * `@corbits/agent-directory`'s `WorkflowCapabilityRunScope`) rather
 * than importing a concrete type from `@corbits/artifacts-hub`, so this
 * package carries no dependency on the artifacts plane; `apps/hub`
 * supplies `@corbits/artifacts-hub`'s `createWorkflowRunAuthenticator`,
 * which satisfies this shape exactly (it resolves a superset: `runId`
 * too).
 */
export type WorkflowParticipantRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly runId: string;
};

export type WorkflowRunAuthenticator = {
  resolve(
    token: string,
    runAddress: string,
  ): Promise<WorkflowParticipantRunScope | null>;
};

/** The resolved scope PLUS the run's own address — the address is
 * already known once auth succeeds (it is the very header the
 * authenticator checked), and this route needs it again to resolve
 * "the caller's own workbench" below. */
type ResolvedScope = WorkflowParticipantRunScope & { readonly address: string };

export type WorkflowParticipantEnv = {
  Variables: { workflowParticipantScope: ResolvedScope };
};

const InviteParticipantInput = type({ definitionId: "string > 0" });
const MintDmInput = type({ definitionId: "string > 0" });

const PostMessageInput = type({ parts: Part.array() });

function questionIdFromParts(parts: readonly PartType[]): string | undefined {
  for (const part of parts) {
    if (part.kind !== "block" || part.block.type !== "question") continue;
    const parsed = QuestionBlockData(part.block.data);
    if (parsed instanceof type.errors) continue;
    return parsed.questionId;
  }
  return undefined;
}

async function existingQuestionMessage(
  roomMessages: Pick<RoomMessageStore, "listMessages">,
  tenantId: string,
  workbenchId: string,
  questionId: string,
): Promise<RoomMessage | undefined> {
  let cursor: string | undefined;
  for (;;) {
    const page = await roomMessages.listMessages({
      tenantId,
      workbenchId,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    for (const item of page.items) {
      if (questionIdFromParts(item.parts) === questionId) return item;
    }
    if (page.nextCursor === undefined) return undefined;
    cursor = page.nextCursor;
  }
}

export type CreateWorkflowParticipantRoutesDeps = {
  readonly store: Pick<
    ChatStore,
    | "findWorkbenchByParticipantAddress"
    | "updateWorkbenchSettings"
    | "createWorkbenchSettings"
    | "deleteWorkbenchSettings"
    | "listWorkbenchSettings"
    | "mutateWorkbenchParticipants"
  > &
    SendWorkbenchMessageDeps["store"];
  readonly platform: LaunchAndJoinAgentDeps["platform"] &
    SendWorkbenchMessageDeps["platform"];
  readonly roomMessages: SendWorkbenchMessageDeps["roomMessages"];
  readonly publish: LaunchAndJoinAgentDeps["publish"];
  /** The same one-in-flight-turn-per-workbench queue `createChatRoutes`
   * is given (CL-6331) — shared, never a second instance, so a
   * workflow-child message and a person's own message for the same
   * workbench serialize against each other too. */
  readonly turnQueue: SendWorkbenchMessageDeps["turnQueue"];
  /** The same cancellation registry `createChatRoutes` is given
   * (CL-7201) — shared, never a second instance, so a cancel request
   * reaches a controller registered from either entry point. */
  readonly turnCancellation: SendWorkbenchMessageDeps["turnCancellation"];
  /** The same dispatch-mail correlation `createChatRoutes` is given
   * (CL-6314) — shared, never a second instance, so a workflow-child
   * message's dispatch records the same way a person's own send does. */
  readonly turnMailCorrelation?: SendWorkbenchMessageDeps["turnMailCorrelation"];
  readonly authenticator: WorkflowRunAuthenticator;
  readonly tenancy: Pick<
    WorkbenchTenancyStore,
    | "createWorkbenchTenant"
    | "compensateWorkbenchTenant"
    | "getWorkbenchTenancy"
    | "getWorkbenchOwnerUserId"
  >;
  /**
   * Mints a session for the bench owner when a workflow child has no
   * browser cookies. Production binds `createBenchSessionMinter`.
   */
  readonly sessionFor: (args: {
    userId: string;
    tenantId: string;
  }) => Promise<string[] | undefined>;
};

export function createWorkflowParticipantRoutes(
  deps: CreateWorkflowParticipantRoutesDeps,
): Hono<WorkflowParticipantEnv> {
  const app = new Hono<WorkflowParticipantEnv>();

  app.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = await deps.authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage:
            "Missing or unrecognized sidecar bearer token / run address",
        }),
        401,
      );
    }
    c.set("workflowParticipantScope", { ...scope, address });
    await next();
  });

  app.post("/participants/invite", async (c) => {
    const scope = c.get("workflowParticipantScope");
    const body = InviteParticipantInput(
      await c.req.json().catch(() => undefined),
    );
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid invite body: ${body.summary}`,
        }),
        400,
      );
    }

    const workbench = await deps.store.findWorkbenchByParticipantAddress(
      scope.tenantId,
      scope.address,
    );
    if (workbench === undefined) {
      return c.json(
        makeErrorEnvelope({
          code: "not_found",
          userMessage: `The calling run "${scope.address}" is not a participant of any workbench in this workbench`,
        }),
        404,
      );
    }

    let joined: Awaited<ReturnType<typeof launchAndJoinAgent>>;
    try {
      joined = await launchAndJoinAgent(
        {
          store: deps.store,
          platform: deps.platform,
          roomMessages: deps.roomMessages,
          publish: deps.publish,
        },
        {
          tenantId: scope.tenantId,
          principalId: scope.principalId,
          workbenchId: workbench.workbenchId,
          definitionId: body.definitionId,
          existingSettings: workbench.settings,
          invitable: await deps.platform.listInvitableDefinitions(
            scope.tenantId,
          ),
        },
      );
    } catch (err) {
      // CL-6357: named, consumer-facing 4xx — never an unhandled 500 —
      // when every asset candidate for the definition has gone
      // unresolvable (DB/blob drift).
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
      if (err instanceof KindIsChatError) {
        return c.json(
          makeErrorEnvelope({ code: err.code, userMessage: err.message }),
          409,
        );
      }
      throw err;
    }

    return c.json(
      {
        address: joined.address,
        definitionId: joined.definitionId,
        handle: joined.handle,
      },
      201,
    );
  });

  // create_agent's default path: mint or reopen the specialist's own
  // kind:chat 1:1 under the caller's bench. Never invites into the
  // caller's DM.
  app.post("/participants/mint-dm", async (c) => {
    const scope = c.get("workflowParticipantScope");
    const body = MintDmInput(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid mint-dm body: ${body.summary}`,
        }),
        400,
      );
    }

    const workbench = await deps.store.findWorkbenchByParticipantAddress(
      scope.tenantId,
      scope.address,
    );
    if (workbench === undefined) {
      return c.json(
        makeErrorEnvelope({
          code: "not_found",
          userMessage: `The calling run "${scope.address}" is not a participant of any workbench in this workbench`,
        }),
        404,
      );
    }

    // Prefer the human owner of the parent bench: Myra's DM is itself a
    // child workbench whose parentTenantId is the bench.
    const link = await deps.tenancy.getWorkbenchTenancy(workbench.workbenchId);
    const ownerTenantId = link?.parentTenantId ?? scope.tenantId;
    const creatorUserId =
      await deps.tenancy.getWorkbenchOwnerUserId(ownerTenantId);
    if (creatorUserId === undefined) {
      const userMessage = `No owner user id for tenant "${ownerTenantId}" — cannot mint an agent DM`;
      const refId = reportError(new Error(userMessage), {
        operation: "chat.mintDm.ownerUnresolved",
        tenantId: ownerTenantId,
      });
      return c.json(
        makeErrorEnvelope({
          code: "owner_unresolved",
          userMessage,
          refId,
        }),
        500,
      );
    }

    const cookies = await deps.sessionFor({
      userId: creatorUserId,
      tenantId: ownerTenantId,
    });
    if (cookies === undefined) {
      const userMessage = `Could not mint a session for owner "${creatorUserId}" to create an agent DM`;
      const refId = reportError(new Error(userMessage), {
        operation: "chat.mintDm.sessionUnmintable",
        tenantId: ownerTenantId,
      });
      return c.json(
        makeErrorEnvelope({
          code: "session_unmintable",
          userMessage,
          refId,
        }),
        500,
      );
    }

    let minted: Awaited<ReturnType<typeof mintAgentDm>>;
    try {
      minted = await mintAgentDm(
        {
          tenancy: deps.tenancy,
          store: deps.store,
          platform: deps.platform,
          roomMessages: deps.roomMessages,
          publish: deps.publish,
        },
        {
          tenantId: scope.tenantId,
          callerWorkbenchId: workbench.workbenchId,
          callerPrincipalId: scope.principalId,
          creatorUserId,
          cookies,
          definitionId: body.definitionId,
        },
      );
    } catch (err) {
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
      if (err instanceof KindIsChatError) {
        return c.json(
          makeErrorEnvelope({ code: err.code, userMessage: err.message }),
          409,
        );
      }
      throw err;
    }

    return c.json(
      {
        workbenchId: minted.workbenchId,
        address: minted.address,
        definitionId: minted.definitionId,
        handle: minted.handle,
      },
      201,
    );
  });

  // The posting half of an in-workbench gen-UI block: a workflow child
  // (`@corbits/interaction-tools`'s `ask_user`) posts a message carrying a
  // `block` part into its own workbench — resolved the same way
  // `/participants/invite` resolves "own workbench", via the caller's mail
  // address. No block-type allowlist here: this route is a generic
  // workbench-message post, same shape `sendWorkbenchMessage` gives any
  // tenant-authenticated caller through `./routes.ts`; the block's own
  // schema (`@corbits/chat`'s `blocks.ts`) is what a renderer trusts, not
  // this route.
  app.post("/participants/messages", async (c) => {
    const scope = c.get("workflowParticipantScope");
    const body = PostMessageInput(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid message body: ${body.summary}`,
        }),
        400,
      );
    }

    const workbench = await deps.store.findWorkbenchByParticipantAddress(
      scope.tenantId,
      scope.address,
    );
    if (workbench === undefined) {
      return c.json(
        makeErrorEnvelope({
          code: "not_found",
          userMessage: `The calling run "${scope.address}" is not a participant of any workbench in this workbench`,
        }),
        404,
      );
    }

    // Re-posting a question card with the same questionId is a no-op that
    // returns the existing message (CL-7248). `ask_user` derives that id
    // from the tool-call id, so a crash between the first post and
    // `suspendOnGate` retries the same id instead of orphaning a second
    // card. Looked up before any other write so the retry also skips
    // connect-service pending-set mutation.
    const questionId = questionIdFromParts(body.parts);
    if (questionId !== undefined) {
      const existing = await existingQuestionMessage(
        deps.roomMessages,
        scope.tenantId,
        workbench.workbenchId,
        questionId,
      );
      if (existing !== undefined) {
        return c.json({ id: existing.id, createdAt: existing.createdAt }, 200);
      }
    }

    // A connect-service card registers its connector on the room's own
    // settings before the message lands, so a later connection completing
    // in the browser can find this room and settle the card
    // (`./connect-pending.ts`'s `settleConnectedService`).
    const requestedConnectorIds = connectServiceConnectorIds(
      body.parts as PartType[],
    );
    if (requestedConnectorIds.length > 0) {
      const pending = pendingConnectionsOf(workbench.settings);
      const merged = [
        ...pending,
        ...requestedConnectorIds.filter((id) => !pending.includes(id)),
      ];
      if (merged.length !== pending.length) {
        const updated = await deps.store.updateWorkbenchSettings({
          tenantId: scope.tenantId,
          workbenchId: workbench.workbenchId,
          settings: {
            ...workbench.settings,
            [CONNECTIONS_PENDING_KEY]: merged,
          },
          updatedBy: scope.principalId,
        });
        deps.publish(workbench.workbenchId, {
          type: "chat.settings",
          data: { updatedBy: scope.principalId, settings: updated.settings },
        });
      }
    }

    const sent = await sendWorkbenchMessage(
      {
        store: deps.store,
        platform: deps.platform,
        roomMessages: deps.roomMessages,
        publish: deps.publish,
        turnQueue: deps.turnQueue,
        turnCancellation: deps.turnCancellation,
        ...(deps.turnMailCorrelation !== undefined
          ? { turnMailCorrelation: deps.turnMailCorrelation }
          : {}),
      },
      {
        tenantId: scope.tenantId,
        principalId: scope.principalId,
        senderAddress: scope.address,
        workbenchId: workbench.workbenchId,
        messageParts: body.parts as PartType[],
      },
    );

    return c.json({ id: sent.id, createdAt: sent.createdAt }, 201);
  });

  return app;
}
