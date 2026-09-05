// Shared test harness for `createChatRoutes`' HTTP surface: a fake
// `ChatPlatform`, a tenant/principal-injecting mount, and the small
// request helpers every split test file (routes, workbench-settings,
// workbench-service) drives the same app through. Not a production
// module — lives in `test/` only.
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";
import type { ChatPlatform, CreateChatRoutesDeps } from "../src/routes";
import { createInMemoryChatStore } from "../src/store";
import {
  createInMemoryRoomMessageStore,
  type RoomMessage,
} from "../src/room-messages";
import { createInMemoryWorkbenchTenancyStore } from "../src/workbench-tenancy";
import type { MailContent } from "../src/codec";

export const TENANT = {
  id: "tnt_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

export function principal(id: string) {
  return {
    id,
    tenantId: TENANT.id,
    kind: "user" as const,
    refId: id,
    status: "active" as const,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

export function fakePlatform(
  opts: {
    invitable?: { id: string; name: string; description?: string }[];
    launchInvite?: (input: {
      tenantId: string;
      creatorPrincipalId: string;
      definitionId: string;
    }) => Promise<{ instanceId: string; address: string }>;
    ensureAwake?: (address: string) => Promise<void>;
    fetchBlob?: (
      workbenchId: string,
      blobId: string,
    ) => Promise<string | Uint8Array>;
    resolveDefinitionAssetId?: (
      definitionId: string,
    ) => Promise<string | undefined>;
    resolveDefinitionIdByAddress?: (
      address: string,
    ) => Promise<string | undefined>;
    resolveDefinitionNameSource?: (
      definitionId: string,
    ) => Promise<
      { readonly name: string; readonly description?: string } | undefined
    >;
    refreshAgentInstanceFromDefinition?: (
      tenantId: string,
      workbenchId: string,
      address: string,
    ) => Promise<void>;
    sendMail?: (input: {
      tenantId: string;
      workbenchId: string;
      principalId?: string;
      content: MailContent;
      fromWorkbenchId?: string;
    }) => Promise<{ id: string; createdAt: string }>;
  } = {},
): ChatPlatform & {
  refreshCalls: { tenantId: string; workbenchId: string; address: string }[];
  sentMail: {
    workbenchId: string;
    principalId?: string;
    content: MailContent;
    fromWorkbenchId?: string;
  }[];
  launchInviteCalls: {
    tenantId: string;
    creatorPrincipalId: string;
    definitionId: string;
  }[];
  ensureAwakeCalls: string[];
} {
  const sentMail: {
    workbenchId: string;
    principalId?: string;
    content: MailContent;
    fromWorkbenchId?: string;
  }[] = [];
  const launchInviteCalls: {
    tenantId: string;
    creatorPrincipalId: string;
    definitionId: string;
  }[] = [];
  const ensureAwakeCalls: string[] = [];
  const mailByWorkbench = new Map<
    string,
    { id: string; createdAt: string; mail: unknown }[]
  >();
  let mailCounter = 0;
  const refreshCalls: {
    tenantId: string;
    workbenchId: string;
    address: string;
  }[] = [];

  return {
    sentMail,
    launchInviteCalls,
    ensureAwakeCalls,
    refreshCalls,
    async launchInvite(input) {
      launchInviteCalls.push(input);
      if (opts.launchInvite !== undefined) return opts.launchInvite(input);
      return {
        instanceId: "ins_invited1",
        address: "ins_invited1@acme.example",
      };
    },
    async ensureAwake(address) {
      ensureAwakeCalls.push(address);
      await opts.ensureAwake?.(address);
    },
    async listInvitableDefinitions() {
      return opts.invitable ?? [];
    },
    async resolveDefinitionAssetId(definitionId: string) {
      if (opts.resolveDefinitionAssetId !== undefined) {
        return opts.resolveDefinitionAssetId(definitionId);
      }
      return undefined;
    },
    async resolveDefinitionIdByAddress(address) {
      if (opts.resolveDefinitionIdByAddress !== undefined) {
        return opts.resolveDefinitionIdByAddress(address);
      }
      return undefined;
    },
    async resolveDefinitionNameSource(definitionId) {
      if (opts.resolveDefinitionNameSource !== undefined) {
        return opts.resolveDefinitionNameSource(definitionId);
      }
      return (opts.invitable ?? []).find((d) => d.id === definitionId);
    },
    async refreshAgentInstanceFromDefinition(tenantId, workbenchId, address) {
      refreshCalls.push({ tenantId, workbenchId, address });
      if (opts.refreshAgentInstanceFromDefinition !== undefined) {
        return opts.refreshAgentInstanceFromDefinition(
          tenantId,
          workbenchId,
          address,
        );
      }
    },
    async sendMail(input) {
      if (opts.sendMail !== undefined) return opts.sendMail(input);
      const sentMailEntryBase = {
        workbenchId: input.workbenchId,
        content: input.content,
      };
      const withPrincipal =
        input.principalId !== undefined
          ? { ...sentMailEntryBase, principalId: input.principalId }
          : sentMailEntryBase;
      const withFromWorkbench =
        input.fromWorkbenchId !== undefined
          ? { ...withPrincipal, fromWorkbenchId: input.fromWorkbenchId }
          : withPrincipal;
      sentMail.push(withFromWorkbench);
      const id = `mail_${++mailCounter}`;
      const createdAt = new Date().toISOString();
      const list = mailByWorkbench.get(input.workbenchId) ?? [];
      const fromLocal = input.principalId ?? input.fromWorkbenchId ?? "unknown";
      list.push({
        id,
        createdAt,
        mail: {
          textBody: [{ partId: "1", type: "text/plain" }],
          bodyValues: { "1": { value: input.content.content } },
          attachments: [],
          from: [{ name: null, email: `${fromLocal}@acme.example` }],
        },
      });
      mailByWorkbench.set(input.workbenchId, list);
      return { id, createdAt };
    },
    async fetchBlob(workbenchId, blobId) {
      if (opts.fetchBlob !== undefined)
        return opts.fetchBlob(workbenchId, blobId);
      return "";
    },
    subscribeToWorkbench() {
      return () => undefined;
    },
  };
}

export function mountAs(
  routes: Hono<TenantEnv>,
  principalId: string,
): Hono<TenantEnv> {
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", principal(principalId));
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}

/** Every message fan-out any `buildDeps` routes have started, awaited
 * by `settleFanout`. A posted message returns before its recipients are
 * delivered (see `sendWorkbenchMessage`), so a test asserting on
 * delivered copies — or on their order — has to settle them first. */
const startedFanouts: Promise<void>[] = [];

export function buildDeps(
  overrides: Partial<CreateChatRoutesDeps> = {},
): CreateChatRoutesDeps {
  const deps: CreateChatRoutesDeps = {
    store: createInMemoryChatStore(),
    roomMessages: createInMemoryRoomMessageStore(),
    platform: fakePlatform(),
    tenancy: createInMemoryWorkbenchTenancyStore(),
    requireGrant: () => async (_c, next) => {
      await next();
    },
    isInvitableDefinition: () => true,
    turnTimeoutMs: 60_000,
    onMessageFanout: (fanoutDelivered) => {
      startedFanouts.push(fanoutDelivered);
    },
    ...overrides,
  };
  return deps;
}

/**
 * Awaits every message fan-out started so far, making assertions about
 * delivered copies (and their ordering) deterministic. `sendText` calls
 * this for you; a test that posts through `app.request` directly calls
 * it itself. Loops because a settled fan-out can itself post — an
 * undelivered notice — starting another.
 */
export async function settleFanout(): Promise<void> {
  while (startedFanouts.length > 0) {
    await Promise.all(startedFanouts.splice(0));
  }
}

/**
 * A workbench's own timeline — the rows CL-6327 made a message into —
 * oldest first, which is how a test reads a conversation. `listMessages`
 * pages newest-first for the client; every assertion here is about what
 * the room ended up holding.
 */
export async function timelineOf(
  deps: CreateChatRoutesDeps,
  workbenchId: string,
  tenantId: string = TENANT.id,
): Promise<RoomMessage[]> {
  const listed = await deps.roomMessages.listMessages({
    tenantId,
    workbenchId,
  });
  return [...listed.items].reverse();
}

/** The event parts on a timeline, by event name — join/leave notices,
 * `block.response`, control settings: the messages a room posts about
 * itself rather than a person's or agent's words. */
export function timelineEvents(
  messages: readonly RoomMessage[],
  event: string,
): { kind: "event"; event: string; data: unknown }[] {
  return messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.kind === "event" && part.event === event ? [part] : [],
    ),
  );
}

/** The text a timeline reads as, one entry per message that carries any
 * text at all. */
export function timelineTexts(messages: readonly RoomMessage[]): string[] {
  return messages.flatMap((message) => {
    const text = message.parts
      .flatMap((part) => (part.kind === "text" ? [part.text] : []))
      .join(" ");
    return text.length === 0 ? [] : [text];
  });
}

export interface WorkbenchView {
  id: string;
  title: string;
  kind: string;
  pinned: boolean;
  participants: { address: string; handle: string }[];
  /** Present on create/reopen responses: the workbench's own tenancy
   * link, or null (with `legacy: true`) for a pre-tenancy workbench. */
  tenancy?: {
    tenantId: string;
    parentTenantId: string;
    slug: string;
  } | null;
}

export async function createWorkbench(
  app: Hono<TenantEnv>,
  body: Record<string, unknown>,
): Promise<{ response: Response; body: WorkbenchView }> {
  const response = await app.request("/workbenches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json()) as WorkbenchView };
}

/**
 * Waits until the clock reads a new millisecond. A timeline orders by
 * `(createdAt, id)`, and messages minted inside one millisecond are
 * simultaneous by that order — so a test that reads a conversation back
 * as "this, then that" has to write each message in its own moment.
 */
export async function nextTimelineMoment(): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() === startedAt) await Bun.sleep(1);
}

export async function sendText(
  app: Hono<TenantEnv>,
  workbenchId: string,
  text: string,
): Promise<Response> {
  await nextTimelineMoment();
  const response = await app.request(`/workbenches/${workbenchId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ kind: "text", text }] }),
  });
  // The route answers before its recipients are delivered; settling
  // here keeps every caller's view of `sentMail` ordered by send.
  await settleFanout();
  return response;
}
