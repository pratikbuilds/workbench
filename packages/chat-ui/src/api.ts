// The chat surface's one seam to `@corbits/chat`'s HTTP routes (see
// packages/chat/src/routes.ts). Every fetch the chat/* components make goes
// through a function here, and every response is parsed with an arktype
// schema at the boundary — a route shape change is a one-file fix.
//
// The wire-level `Part` and participant schemas are imported from
// `@corbits/chat` rather than redefined here: this UI validates the wire
// contract at its own boundary, but against the one real schema rather than
// a second, hand-copied one.

import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { Part } from "@corbits/chat/parts";
import { parseParticipants } from "@corbits/chat/participants";
import type { ParticipantRecord } from "@corbits/chat/participants";
import type { WorkbenchOnboardingStep } from "@corbits/chat/blocks";
import { UnauthenticatedError } from "@corbits/api-query";
import { InferenceSettingsApiError } from "@corbits/inference-settings";
import { jimmyAgentRequest } from "@workbench/templates";
import { CHAT_STRINGS } from "./strings";

export {
  TextPart,
  ReasoningPart,
  ToolTracePart,
  BlockPart,
  FilePart,
  EventPart,
  Part,
} from "@corbits/chat/parts";
export type { ParticipantRecord } from "@corbits/chat/participants";
export type {
  OnboardingStepLabel,
  WorkbenchOnboardingStep,
} from "@corbits/chat/blocks";
export { REACTION_EMOJI } from "@corbits/chat/reaction-emoji";
export type { ReactionEmoji } from "@corbits/chat/reaction-emoji";

export const WorkbenchKind = type("'workbench' | 'chat'");
export type WorkbenchKind = typeof WorkbenchKind.infer;

/** Every workbench kind this UI has bespoke handling for. Any other value on
 * the wire is a workbench kind the server knows about that this UI doesn't —
 * it renders through the neutral, kind-agnostic path rather than being
 * rejected at parse time. */
export function isKnownWorkbenchKind(kind: string): kind is WorkbenchKind {
  return kind === "workbench" || kind === "chat";
}

const WorkbenchWire = type({
  id: "string",
  title: "string",
  kind: "string",
  pinned: "boolean",
  "definitionId?": "string | null",
  participants: "unknown[]",
  "legacy?": "boolean",
  // Row signals `GET /workbenches` annotates when it can resolve a
  // workbench's mailbox (see `packages/chat/src/routes.ts`): absent,
  // never a fabricated zero, for a workbench whose session isn't
  // resolvable yet. `unreadCount` is the one exception — 0 is itself
  // the honest "nothing unread" answer once a mailbox is resolved.
  "unreadCount?": "number",
  "lastActivityAt?": "string",
  "live?": "boolean",
  // A bounded, text-only snippet of the newest message (see
  // `packages/chat/src/codec.ts`'s `extractTextPreview`) — absent, never
  // an empty string, when there is no message yet or it carries no text
  // part.
  "preview?": "string",
  // `GET /workbenches` sets this server-side (see
  // `packages/chat/src/routes.ts`) only for a workbench projected into
  // this tenant via CL-5882's shared-workbench machinery: "shared via
  // parent · <parent name>" for true siblings, "shared · <owning tenant
  // name>" otherwise. Absent for every ordinary, non-projected workbench.
  "sharedLabel?": "string",
  // The workbench's own workbench tenant (every workbench minted through
  // POST /workbenches carries a tenancy link; null only on true legacy
  // rows) — what per-workbench surfaces like Insights scope on, since
  // the WORKBENCH id is a run id, never a tenant id.
  "tenancy?": type({ tenantId: "string" }).or("null"),
});

const Workbench = WorkbenchWire.pipe((wire) => ({
  ...wire,
  participants: parseParticipants(wire.participants),
}));
export type Workbench = Omit<typeof WorkbenchWire.infer, "participants"> & {
  readonly participants: readonly ParticipantRecord[];
};

const WorkbenchesResponse = type({ items: WorkbenchWire.array() }).pipe(
  (response) => ({
    items: response.items.map((wire) => ({
      ...wire,
      participants: parseParticipants(wire.participants),
    })),
  }),
);

// `tenantId`/`tenantName`/`tenantMonogram` are set server-side only for a
// message sent by a shared workbench's "other side" participant — a share
// member of a tenant this workbench was projected into (see
// `resolveMessageSenderTenant` in `packages/chat/src/routes.ts`). Absent
// for every ordinary same-tenant sender.
export const MessageSender = type({
  name: "string | null",
  address: "string",
  "tenantId?": "string",
  "tenantName?": "string",
  "tenantMonogram?": "string",
});
export type MessageSender = typeof MessageSender.infer;

// `POST .../reactions/toggle`'s response shape, and the per-emoji entry
// `GET /messages` batches onto every item's `reactions` array — see
// `packages/chat/src/reactions.ts`'s `ReactionSummary`. `reactedByMe` is
// this signed-in principal's own membership in the emoji's reactor set,
// never another principal's.
const ReactionSummaryWire = type({
  emoji: "string",
  count: "number",
  reactedByMe: "boolean",
});
export type ReactionSummary = typeof ReactionSummaryWire.infer;

const MessageItem = type({
  id: "string",
  createdAt: "string",
  parts: Part.array(),
  sender: MessageSender,
  // Both fields are simply absent from the wire when the host never
  // injected the corresponding store (see `CreateChatRoutesDeps` in
  // `packages/chat/src/routes.ts`) — never a fabricated empty array or
  // `false`, mirroring how `unreadCount` on `Workbench` works.
  "reactions?": ReactionSummaryWire.array(),
  "pinned?": "boolean",
  // The client-generated send identity (CL-6251) this message's own
  // sender's composer submitted it with, echoed back once the server
  // records it — see `sendMessage`'s `clientId` option and
  // `packages/chat/src/client-ids.ts`. Absent for every message not
  // sent with one (anything from before this feature, or from a peer
  // whose own client never set it) — never a fabricated id.
  "clientId?": "string",
  // The thread this message belongs to (CL-6313), resolved server-side
  // against the same "root feed by default" contract the per-thread
  // feed filters on. Carrying it here is what lets one query serve the
  // root feed and every open thread — see `./thread-feed.ts`. Absent
  // on a host that mounts no thread store, matching `rootThreadId: ""`.
  "threadId?": "string",
});
export type MessageItem = typeof MessageItem.infer;

const MessagesResponse = type({
  items: MessageItem.array(),
  "nextCursor?": "string",
});
export type MessagesResponse = typeof MessagesResponse.infer;

const SentMessage = type({
  id: "string",
  createdAt: "string",
  "threadId?": "string",
  "clientId?": "string",
});

const ReadState = type({
  "lastSeenCreatedAt?": "string | null",
  "lastSeenId?": "string | null",
});

// The shape `GET /api/tenants/:t/workflows/deployments` returns: a run, one row
// per definition executing in the bench. It carries no display name — only
// the id and the asset id its definition was hydrated from — so the mention
// popover derives a readable label from `definitionAssetId` (see
// `runDisplayName` below).
const Run = type({
  id: "string",
  tenantId: "string",
  definitionAssetId: "string",
  status: "string",
  createdAt: "string",
});
export type Run = typeof Run.infer;

const RunsResponse = Run.array();

// `GET /workbenches/:id/invitable` (see packages/chat/src/routes.ts): the
// tenant's deployed, launchable workflow definitions this workbench can
// invite an agent from — never including the workbench's own host.
const InvitableDefinition = type({
  id: "string",
  name: "string",
  "description?": "string",
});
export type InvitableDefinition = typeof InvitableDefinition.infer;

const InvitableDefinitionsResponse = type({
  items: InvitableDefinition.array(),
});

const InvitedAgent = type({ address: "string", definitionId: "string" });
export type InvitedAgent = typeof InvitedAgent.infer;

const RemovedParticipant = type({ address: "string" });

export class ChatApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Plain-language copy for a failed chat request — never `error.message`
 * or `String(error)` verbatim, which for a `ChatApiError` embeds the raw
 * request path (see `request()` below). `InferenceSettingsApiError`
 * carries the envelope `userMessage` (safe to show) rather than a path,
 * so a 500 from `getResolvedCatalog` surfaces that sentence instead of
 * the generic fallback. Every chat-ui/chat-adjacent catch block that
 * surfaces an error to the user should call this rather than format one
 * of its own, so the class of leak (a raw `/api/...` URL or bare status
 * code in user-facing copy) has exactly one place to fix.
 */
export function describeChatError(cause: unknown, fallback: string): string {
  const statused =
    cause instanceof ChatApiError || cause instanceof InferenceSettingsApiError
      ? cause
      : null;
  if (statused === null) return fallback;
  switch (statused.status) {
    case 401:
      return "You're signed out. Sign in again to continue.";
    case 403:
      return "You don't have access to this.";
    case undefined:
      return "Couldn't reach the server. Check your connection and try again.";
    default: {
      if (
        cause instanceof InferenceSettingsApiError &&
        statused.message.trim() !== ""
      ) {
        return statused.message;
      }
      return statused.status >= 500
        ? "Something went wrong on our end. Try again in a moment."
        : fallback;
    }
  }
}

type Validator<T> = (data: unknown) => T | ArkErrors;

async function request<T>(
  path: string,
  schema: Validator<T>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new ChatApiError(
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    throw new ChatApiError(
      `The server answered ${response.status} for ${path}.`,
      response.status,
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new ChatApiError(
      `Unexpected response shape from ${path}: ${parsed.summary}`,
    );
  }
  return parsed;
}

function workbenchesPath(tenantId: string, kind: WorkbenchKind): string {
  return `/api/tenants/${tenantId}/chat/workbenches?kind=${kind}`;
}

/**
 * The shared TanStack Query key for `listWorkbenches(tenantId, kind)` —
 * defined here (not in the app's own key module) because this package owns
 * both the endpoint and `WorkbenchKind`. Every surface that lists workbenches of
 * a given kind (the shell's bench-activity, the command palette, the
 * Routines picker, this package's own `ChatWorkspace` sidebar) keys its
 * query with this function so they all subscribe to the one cached fetch
 * per (tenantId, kind) instead of each firing its own.
 */
export function workbenchesQueryKey(
  tenantId: string,
  kind: WorkbenchKind,
): readonly [string, string, string, WorkbenchKind] {
  return ["tenant", tenantId, "workbenches", kind] as const;
}

/** Prefix covering every `workbenchesQueryKey` kind for a tenant — invalidate
 * this after a mutation (create, rename, pin) to refetch both kinds. */
export function workbenchesQueryKeyPrefix(
  tenantId: string,
): readonly [string, string, string] {
  return ["tenant", tenantId, "workbenches"] as const;
}

export function listWorkbenches(
  tenantId: string,
  kind: WorkbenchKind,
): Promise<readonly Workbench[]> {
  return request(workbenchesPath(tenantId, kind), WorkbenchesResponse).then(
    (page) => page.items,
  );
}

/**
 * Every workbench a tenant holds, of any kind — `kind` is optional
 * server-side (`packages/chat/src/routes.ts`'s `GET /workbenches`), and
 * workbench kinds are open-ended (`packages/chat/src/kinds.ts`), so this
 * omits the query param entirely rather than hardcoding the two kinds
 * this UI has bespoke handling for. Used where the caller needs the
 * complete workbench-host/participant surface regardless of kind — e.g.
 * the shell's second column splitting the result into its workbenches and
 * chats sections (see `apps/web/src/shell/bench-activity.ts`).
 */
export function listAllWorkbenches(
  tenantId: string,
): Promise<readonly Workbench[]> {
  return request(
    `/api/tenants/${tenantId}/chat/workbenches`,
    WorkbenchesResponse,
  ).then((page) => page.items);
}

// A chat is a direct thread with exactly one counterpart, picked at
// creation and fixed for its lifetime: either an agent (`definitionId`)
// or a bench member (`principalId`) — never both. The name is optional
// either way (the server titles it by the counterpart's handle when
// omitted). A workbench is the pinned, multiplayer kind: name-only, no
// counterpart attached at creation. See `packages/chat/src/routes.ts`
// `POST /workbenches` for the server side of this union.
//
// `kind: "chat"` + `definitionId` always find-or-reopens the one DM
// for that agent (CL-6981). `reuseExisting` is still accepted on the
// wire and ignored. `kind: "workbench"` mints an empty channel; a room's
// onboarding walkthrough is posted separately through
// `postWorkbenchOnboardingStep`, never as a side effect of create.
export type CreateWorkbenchInput =
  | {
      readonly kind: "workbench";
      readonly name: string;
    }
  | {
      readonly kind: "chat";
      readonly definitionId: string;
      readonly name?: string;
      readonly reuseExisting?: boolean;
    }
  | {
      readonly kind: "chat";
      readonly principalId: string;
      readonly name?: string;
    };

/** Fired on `window` after every successful `createWorkbench`, carrying
 * `{tenantId}` in `detail`. The host shell's sidebar list caches its
 * workbench listings outside this package (see
 * `apps/web/src/shell/bench-activity.ts`), and creation happens at many
 * call sites (the picker dialog, agent launch, the land-hop) — one
 * signal here reaches them all, so a freshly minted workbench appears
 * in the sidebar without waiting for an unrelated refetch. */
export const WORKBENCHES_MUTATED_EVENT = "workbench:chat:workbenches-mutated";

/** SSE `event.type` the chat service publishes onto a workbench stream when
 * the tenant's workbench list changed (a specialist minted in the
 * background, a create from another tab). The host sidebar already
 * invalidates on `WORKBENCHES_MUTATED_EVENT`; `applyStreamWorkbenchesMutated`
 * is the bridge from this stream payload onto that same CustomEvent. */
export const WORKBENCHES_MUTATED_STREAM_TYPE = "chat.workbenches-mutated";

const WorkbenchesMutatedStreamData = type({
  tenantId: "string",
  "+": "ignore",
});

/** Parses a `chat.workbenches-mutated` SSE payload and, on success, fires
 * `WORKBENCHES_MUTATED_EVENT` with `{tenantId}` so the shell sidebar
 * refetches. Parse failure is a no-op — a malformed stream event must
 * never throw into the EventSource handler. Extra keys are ignored so
 * the server can grow the payload without breaking older clients. */
export function applyStreamWorkbenchesMutated(data: unknown): void {
  const parsed = WorkbenchesMutatedStreamData(data);
  if (parsed instanceof type.errors) return;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(WORKBENCHES_MUTATED_EVENT, {
      detail: { tenantId: parsed.tenantId },
    }),
  );
}

export function createWorkbench(
  tenantId: string,
  input: CreateWorkbenchInput,
): Promise<Workbench> {
  return request(`/api/tenants/${tenantId}/chat/workbenches`, Workbench, {
    method: "POST",
    body: JSON.stringify(input),
  }).then((workbench) => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(WORKBENCHES_MUTATED_EVENT, { detail: { tenantId } }),
      );
    }
    return workbench;
  });
}

export function listMessages(
  tenantId: string,
  workbenchId: string,
  cursor?: string,
): Promise<MessagesResponse> {
  const query = cursor !== undefined ? `?cursor=${cursor}` : "";
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/messages${query}`,
    MessagesResponse,
  );
}

const BlobResponse = type({ contentBase64: "string" });

/**
 * A `FilePart`'s bytes, base64-encoded (`GET /workbenches/:id/blobs/:blobId`).
 * There is no stored link from a chat blob to a Library artifact today —
 * this is the fallback read path a host uses to open a chat attachment
 * without one (see `chat-artifact-open.ts` in the web app).
 */
export function fetchWorkbenchBlob(
  tenantId: string,
  workbenchId: string,
  blobId: string,
): Promise<string> {
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/blobs/${encodeURIComponent(blobId)}`,
    BlobResponse,
  ).then((body) => body.contentBase64);
}

/** A message-send's pre-invite entry — the wire shape of a picked
 * "Bring in…" candidate's `MentionInviteIntent` (see `mentions.ts`),
 * mirroring `packages/chat/src/routes.ts`'s `MessageInviteEntry`. */
export type MessageInviteInput =
  | { readonly kind: "agent"; readonly definitionId: string }
  | {
      readonly kind: "person";
      readonly principalId: string;
      readonly name?: string;
    };

export type SendMessageOptions = {
  readonly threadId?: string;
  readonly inReplyToMessageId?: string;
  /** Every not-yet-participant a mention in this message names, invited
   * server-side before the send so the mention fans out normally. */
  readonly invite?: readonly MessageInviteInput[];
  /** This composer submit's own client-generated send identity
   * (CL-6251) — the pending bubble's `nonce`, carried on the wire so
   * the server can echo it back (in this call's own response, and on
   * every later `GET .../messages` page) and the pending bubble can
   * reconcile with the confirmed message by identity rather than by
   * guessing from content or timing. */
  readonly clientId?: string;
};

export function sendMessage(
  tenantId: string,
  workbenchId: string,
  parts: readonly Part[],
  options?: SendMessageOptions,
): Promise<{
  readonly id: string;
  readonly createdAt: string;
  readonly threadId?: string;
  readonly clientId?: string;
}> {
  const body: Record<string, unknown> = { parts };
  if (options?.threadId !== undefined) body["threadId"] = options.threadId;
  if (options?.inReplyToMessageId !== undefined) {
    body["inReplyToMessageId"] = options.inReplyToMessageId;
  }
  if (options?.invite !== undefined && options.invite.length > 0) {
    body["invite"] = options.invite;
  }
  if (options?.clientId !== undefined) body["clientId"] = options.clientId;
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/messages`,
    SentMessage,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/**
 * Toggles this signed-in principal's reaction with `emoji` on a
 * message — `POST .../reactions/toggle` (see
 * `packages/chat/src/routes.ts`). Returns the emoji's fresh summary
 * (count and whether this principal is now among the reactors); the
 * caller re-renders from this rather than assuming its own optimistic
 * guess, the same anti-drift rule `submitPoll`'s live tally follows.
 */
export function toggleReaction(
  tenantId: string,
  workbenchId: string,
  messageId: string,
  emoji: string,
): Promise<ReactionSummary> {
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/messages/${messageId}/reactions/toggle`,
    ReactionSummaryWire,
    { method: "POST", body: JSON.stringify({ emoji }) },
  );
}

const PinnedWire = type({
  messageId: "string",
  pinnedBy: "string",
  pinnedAt: "string",
});
export type Pinned = typeof PinnedWire.infer;

function pinPath(tenantId: string, workbenchId: string, messageId: string) {
  return `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/messages/${messageId}/pin`;
}

export function pinMessage(
  tenantId: string,
  workbenchId: string,
  messageId: string,
): Promise<Pinned> {
  return request(pinPath(tenantId, workbenchId, messageId), PinnedWire, {
    method: "POST",
  });
}

export async function unpinMessage(
  tenantId: string,
  workbenchId: string,
  messageId: string,
): Promise<void> {
  const response = await fetch(pinPath(tenantId, workbenchId, messageId), {
    method: "DELETE",
  });
  if (response.status === 401) {
    throw new UnauthenticatedError();
  }
  if (!response.ok) {
    throw new ChatApiError(
      `The server answered ${response.status} for ${pinPath(tenantId, workbenchId, messageId)}.`,
      response.status,
    );
  }
}

// A pinned message's own content, for the pinned strip's preview — the
// same `MessageItem` shape plus who pinned it and when. See `GET
// /workbenches/:id/pins` in `packages/chat/src/routes.ts`.
const PinnedMessageWire = MessageItem.and({
  pinnedBy: "string",
  pinnedAt: "string",
});
export type PinnedMessage = typeof PinnedMessageWire.infer;

const PinnedMessagesResponse = type({ items: PinnedMessageWire.array() });

export function listPinnedMessages(
  tenantId: string,
  workbenchId: string,
): Promise<readonly PinnedMessage[]> {
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/pins`,
    PinnedMessagesResponse,
  ).then((page) => page.items);
}

// `parentThreadId` is the thread this one hangs directly off: null for the
// root thread, the root thread's id for a depth-1 thread, a depth-1
// thread's id for a depth-2 sub-thread. Two levels, stop — see
// `resolveThreadAnchor` in `packages/chat/src/threads.ts`.
export const WorkbenchThread = type({
  id: "string",
  kind: "'root' | 'reply' | 'delivery'",
  parentMessageId: "string | null",
  parentThreadId: "string | null",
  runRef: "string | null",
  title: "string | null",
  createdAt: "string",
});
export type WorkbenchThread = typeof WorkbenchThread.infer;

// A listed thread carries its own reply activity (CL-6313) — the
// affordance on a parent message shows "N replies" and a last-activity
// stamp, and computing those client-side meant a `GET
// /threads/:id/messages` per thread on every timeline refresh. Only the
// list response has these; `forkThread` and an open thread's own
// `thread` field return the bare thread.
export const WorkbenchThreadRow = WorkbenchThread.and({
  replyCount: "number",
  /** Null, never the thread's creation time, for a thread with no
   * messages yet — an empty thread has had no activity. */
  lastActivityAt: "string | null",
});
export type WorkbenchThreadRow = typeof WorkbenchThreadRow.infer;

const ThreadsResponse = type({
  rootThreadId: "string",
  items: WorkbenchThreadRow.array(),
});

export function listThreads(
  tenantId: string,
  workbenchId: string,
): Promise<{
  readonly rootThreadId: string;
  readonly items: readonly WorkbenchThreadRow[];
}> {
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/threads`,
    ThreadsResponse,
  );
}

const ThreadMessagesResponse = type({
  thread: WorkbenchThread,
  items: MessageItem.array(),
});
export type ThreadMessagesResponse = typeof ThreadMessagesResponse.infer;

export function listThreadMessages(
  tenantId: string,
  workbenchId: string,
  threadId: string,
): Promise<ThreadMessagesResponse> {
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/threads/${threadId}/messages`,
    ThreadMessagesResponse,
  );
}

/**
 * A first-class fork: spawn a sub-thread rooted at any message inside a
 * thread — something Slack doesn't have (CL-5948). Idempotent per origin
 * message, and honors the two-level cap server-side: forking a message
 * already inside a sub-thread creates a sibling sub-thread under that
 * sub-thread's parent, never a third level (see `resolveThreadAnchor` in
 * `packages/chat/src/threads.ts`).
 */
export function forkThread(
  tenantId: string,
  workbenchId: string,
  parentMessageId: string,
  title?: string,
): Promise<WorkbenchThread> {
  const body: Record<string, unknown> = { parentMessageId };
  if (title !== undefined) body["title"] = title;
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/threads/fork`,
    WorkbenchThread,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export function putReadState(
  tenantId: string,
  workbenchId: string,
  input: { readonly lastSeenCreatedAt: string; readonly lastSeenId: string },
): Promise<void> {
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/read-state`,
    ReadState,
    { method: "PUT", body: JSON.stringify(input) },
  ).then(() => undefined);
}

export function listRuns(tenantId: string): Promise<readonly Run[]> {
  return request(
    `/api/tenants/${tenantId}/workflows/deployments`,
    RunsResponse,
  );
}

export function listInvitableDefinitions(
  tenantId: string,
  workbenchId: string,
): Promise<readonly InvitableDefinition[]> {
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/invitable`,
    InvitableDefinitionsResponse,
  ).then((page) => page.items);
}

/**
 * The tenant-wide invitable listing (`GET /invitable-definitions`) the
 * new-chat dialog reads before any workbench exists — the per-workbench
 * variant above 404s on a workbench id that isn't real.
 */
export function listTenantInvitableDefinitions(
  tenantId: string,
): Promise<readonly InvitableDefinition[]> {
  return request(
    `/api/tenants/${tenantId}/chat/invitable-definitions`,
    InvitableDefinitionsResponse,
  ).then((page) => page.items);
}

export function inviteAgent(
  tenantId: string,
  workbenchId: string,
  definitionId: string,
): Promise<InvitedAgent> {
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/invite`,
    InvitedAgent,
    { method: "POST", body: JSON.stringify({ definitionId }) },
  );
}

const PostedOnboardingStep = type({ id: "string" });

/**
 * Posts one onboarding step into a room
 * (`POST /workbenches/:id/onboarding`): the walkthrough card lands as a
 * system row, with no agent launched or woken, so an empty channel can
 * run its onboarding with nobody in the room yet.
 */
export function postWorkbenchOnboardingStep(
  tenantId: string,
  workbenchId: string,
  step: WorkbenchOnboardingStep,
): Promise<{ readonly id: string }> {
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/onboarding`,
    PostedOnboardingStep,
    { method: "POST", body: JSON.stringify(step) },
  );
}

// Jimmy's own request shape, the same `@workbench/templates` object a
// workbench template's participant create used to resolve — CL-6499 removed
// Jimmy's template (he is not a "kind of workbench"), so this dialog's own
// "Add Jimmy" quick-create row (see `invite-agent-dialog.tsx`) is his only
// create path left. `jimmyAgentRequest()` is pure data (no tool bodies, no
// server-only imports), safe to call from browser code.
export const JIMMY_QUICK_CREATE = jimmyAgentRequest();

const CreatedAgentDefinition = type({ id: "string" });

/**
 * Creates Jimmy's agent-directory definition in one call — the same
 * one-shot `POST /agent-definitions` a template-driven participant create
 * goes through. Idempotency is the caller's job: only offer this when
 * `JIMMY_QUICK_CREATE.handle` is absent from the tenant's invitable list.
 */
export function quickCreateJimmy(
  tenantId: string,
): Promise<{ readonly id: string }> {
  return request(
    `/api/tenants/${tenantId}/agent-definitions`,
    CreatedAgentDefinition,
    { method: "POST", body: JSON.stringify(JIMMY_QUICK_CREATE) },
  );
}

// `DELETE /workbenches/:id/participants/:address` (see
// `packages/chat/src/routes.ts`): the removal counterpart to
// `inviteAgent`/workbench creation's own join — drops the participant and,
// for an invited agent, releases its launched instance server-side. The
// Members section calls this per row and refetches `getWorkbenchSettings`
// on success rather than trusting an optimistic local edit.
export function removeWorkbenchParticipant(
  tenantId: string,
  workbenchId: string,
  address: string,
): Promise<void> {
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/participants/${encodeURIComponent(address)}`,
    RemovedParticipant,
    { method: "DELETE" },
  ).then(() => undefined);
}

// `GET /workbenches/:id/agents` (see `packages/chat/src/routes.ts`): every
// one of the workbench's agent participants, each resolved to the
// definition id its name/instructions are read from and saved to via
// `@corbits/agent-directory`'s own routes (see `getAgentInstructions`/
// `updateAgentInstructions` below). A workbench with several invited
// agents lists all of them, not just the first.
const WorkbenchAgentWire = type({
  address: "string",
  handle: "string",
  definitionId: "string",
  definitionAssetId: "string",
  displayName: "string",
});
export type WorkbenchAgent = typeof WorkbenchAgentWire.infer;

const WorkbenchAgentsResponse = type({ items: WorkbenchAgentWire.array() });

export function listWorkbenchAgents(
  tenantId: string,
  workbenchId: string,
): Promise<readonly WorkbenchAgent[]> {
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/agents`,
    WorkbenchAgentsResponse,
  ).then((page) => page.items);
}

// `POST /workbenches/:id/agents/refresh` (see
// `packages/chat/src/routes.ts`): recomputes the given agent's running
// instance from its definition's CURRENT instructions — a wake replays
// whatever the workbench's launch record holds verbatim, so a definition
// edit reaches a running instance only after this call. The Assistant
// section calls it right after `updateAgentInstructions` succeeds, so
// the change is live for this workbench's agent from its next reply.
export function refreshWorkbenchAgent(
  tenantId: string,
  workbenchId: string,
  address: string,
): Promise<void> {
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/agents/refresh`,
    type({ ok: "boolean" }),
    { method: "POST", body: JSON.stringify({ address }) },
  ).then(() => undefined);
}

// `GET`/`PUT /api/tenants/:t/agent-definitions/:id` (see
// `packages/agent-directory/src/routes.ts`): an agent's editable
// persona — its display name and system prompt (surfaced to a person as
// "instructions"). `name` here is the display name, matching the create
// form's own "name" field (see `CreateAgentDefinitionInput`), never the
// definition's immutable handle.
const AgentCapabilitiesWire = type({
  toolPackagePins: type({ name: "string", version: "string" }).array(),
  skills: "string[]",
  "model?": "string",
});
export type AgentCapabilities = typeof AgentCapabilitiesWire.infer;

const AgentInstructionsWire = type({
  name: "string",
  systemPrompt: "string",
});
export type AgentInstructions = typeof AgentInstructionsWire.infer;

/** `GET`/`POST .../restore`'s fuller shape: the editable persona plus its
 * current capability snapshot, in one read — the settings surface's
 * "Capabilities" list never needs a second round trip to show what an
 * agent already carries. */
const AgentDetailWire = type({
  name: "string",
  systemPrompt: "string",
  toolPackagePins: type({ name: "string", version: "string" }).array(),
  skills: "string[]",
  "model?": "string",
});
export type AgentDetail = typeof AgentDetailWire.infer;

function agentInstructionsPath(tenantId: string, definitionId: string) {
  return `/api/tenants/${tenantId}/agent-definitions/${encodeURIComponent(definitionId)}`;
}

// `GET /agent-definitions/visible` (see
// `packages/agent-directory/src/visible-definitions.ts`): every agent
// definition this tenant can open a direct chat with — its own, plus
// every ancestor tenant's, a child's same-name definition shadowing an
// ancestor's. `tenantId` here is the definition's OWNING tenant, which
// is where its DM workbench actually lives — never necessarily the
// caller's own tenant.
const VisibleAgentDefinitionWire = type({
  id: "string",
  name: "string",
  tenantId: "string",
  tenantName: "string",
  createdAt: "string",
});
export type VisibleAgentDefinition = typeof VisibleAgentDefinitionWire.infer;

const VisibleAgentDefinitionsResponse = type({
  definitions: VisibleAgentDefinitionWire.array(),
});

export function listVisibleAgentDefinitions(
  tenantId: string,
): Promise<readonly VisibleAgentDefinition[]> {
  return request(
    `/api/tenants/${tenantId}/agent-definitions/visible`,
    VisibleAgentDefinitionsResponse,
  ).then((page) => page.definitions);
}

/**
 * Opens a direct chat with an agent, minting it on first open and
 * reusing the same workbench on every later open — `packages/chat/src/
 * routes.ts`'s `POST /workbenches` with `reuseExisting: true` already
 * finds-or-creates by `chat/definitionId` (`findExistingAgentChat`), the
 * same seam the home-workbench land-hop uses. `tenantId` must be the
 * definition's OWNING tenant (see `VisibleAgentDefinition.tenantId`),
 * never the caller's own tenant when the agent was reached through
 * ancestor inheritance — the DM workbench lives where the agent lives.
 */
export function openAgentDm(
  tenantId: string,
  definitionId: string,
): Promise<Workbench> {
  return createWorkbench(tenantId, {
    kind: "chat",
    definitionId,
    reuseExisting: true,
  });
}

export function getAgentInstructions(
  tenantId: string,
  definitionId: string,
): Promise<AgentDetail> {
  return request(
    agentInstructionsPath(tenantId, definitionId),
    AgentDetailWire,
  );
}

export function updateAgentInstructions(
  tenantId: string,
  definitionId: string,
  input: AgentInstructions,
): Promise<AgentInstructions> {
  return request(
    agentInstructionsPath(tenantId, definitionId),
    AgentInstructionsWire,
    { method: "PUT", body: JSON.stringify(input) },
  );
}

// `GET /:definitionId/versions` / `POST /:definitionId/restore` (see
// `packages/agent-directory/src/routes.ts`): the agent's own instructions/
// capabilities history, mirroring `@corbits/skills`' version-history shape
// exactly (`commitSha`/`message`/`author`/`committedAtIso`/`current`) — the
// sha only ever appears in a tooltip, never in the label a person reads.
const AgentVersionWire = type({
  commitSha: "string",
  message: "string",
  author: "string",
  committedAtIso: "string",
  current: "boolean",
});
export type AgentVersion = typeof AgentVersionWire.infer;

export function listAgentVersions(
  tenantId: string,
  definitionId: string,
): Promise<readonly AgentVersion[]> {
  return request(
    `${agentInstructionsPath(tenantId, definitionId)}/versions`,
    type({ versions: AgentVersionWire.array() }),
  ).then((page) => page.versions);
}

export function restoreAgentVersion(
  tenantId: string,
  definitionId: string,
  commitSha: string,
): Promise<AgentDetail> {
  return request(
    `${agentInstructionsPath(tenantId, definitionId)}/restore`,
    AgentDetailWire,
    { method: "POST", body: JSON.stringify({ commitSha }) },
  );
}

// `GET /agent-definitions/capabilities/inventory` /
// `POST /:definitionId/capabilities` (see `packages/agent-directory/src/
// routes.ts`): the guided capability-add surface. The inventory call feeds
// the add picker with only what this tenant actually has — a tool package,
// skill, or model this call doesn't list can never be added, since the
// server re-checks the same inventory fail-closed on the add itself.
const CapabilityInventoryWire = type({
  toolPackages: type({ name: "string" }).array(),
  skills: type({ name: "string" }).array(),
  models: type({ canonicalName: "string" }).array(),
});
export type CapabilityInventory = typeof CapabilityInventoryWire.infer;

export function listCapabilityInventory(
  tenantId: string,
): Promise<CapabilityInventory> {
  return request(
    `/api/tenants/${tenantId}/agent-definitions/capabilities/inventory`,
    CapabilityInventoryWire,
  );
}

export type CapabilityAddition =
  | { readonly kind: "toolPackage"; readonly name: string }
  | { readonly kind: "skill"; readonly name: string }
  | { readonly kind: "model"; readonly canonicalName: string };

export function addAgentCapability(
  tenantId: string,
  definitionId: string,
  addition: CapabilityAddition,
): Promise<AgentCapabilities> {
  return request(
    `${agentInstructionsPath(tenantId, definitionId)}/capabilities`,
    AgentCapabilitiesWire,
    { method: "POST", body: JSON.stringify(addition) },
  );
}

export function workbenchStreamUrl(
  tenantId: string,
  workbenchId: string,
): string {
  return `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/stream`;
}

/**
 * `POST .../presence` (CL-6328, see `packages/chat/src/routes.ts`): keeps
 * this principal's `lastActiveAt` fresh on the who's-here roster while its
 * stream connection sits open — "here at all" already comes for free from
 * the open connection itself, so this is called on real activity, never
 * on a polling interval. Best-effort: a dropped ping just means the next
 * one (or the eventual `"offline"` on disconnect) catches up.
 */
export function pingWorkbenchPresence(
  tenantId: string,
  workbenchId: string,
): Promise<void> {
  return fetch(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/presence`,
    { method: "POST" },
  )
    .then(() => undefined)
    .catch(() => undefined);
}

// `POST`/`GET .../blocks/:blockId/responses` (see
// `packages/chat/src/routes.ts`): the poll/form round-trip. `own` is only
// ever this signed-in principal's own response — a poll's `tally` is the
// one place another principal's participation shows up at all, and only as
// an anonymous count, never whose it was.
const BlockResponsePayloadWire = type({
  kind: "'poll'",
  choiceIds: "string[]",
})
  .or(type({ kind: "'form'", values: "Record<string, string>" }))
  .or(
    type({
      kind: "'question'",
      answer: "string",
      "optionIndex?": "number",
      notifiedAt: "string | null",
    }),
  );
export type BlockResponsePayload = typeof BlockResponsePayloadWire.infer;

const BlockResponsesWire = type({
  tally: "Record<string, number>",
  total: "number",
  own: BlockResponsePayloadWire.or("null"),
});
export type BlockResponses = typeof BlockResponsesWire.infer;

const SubmittedBlockResponse = type({
  blockId: "string",
  updatedAt: "string",
});

function blockResponsesPath(
  tenantId: string,
  workbenchId: string,
  messageId: string,
  blockId: string,
): string {
  return (
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/messages/` +
    `${messageId}/blocks/${blockId}/responses`
  );
}

export function getBlockResponses(
  tenantId: string,
  workbenchId: string,
  messageId: string,
  blockId: string,
): Promise<BlockResponses> {
  return request(
    blockResponsesPath(tenantId, workbenchId, messageId, blockId),
    BlockResponsesWire,
  );
}

export function submitPollResponse(
  tenantId: string,
  workbenchId: string,
  messageId: string,
  blockId: string,
  choiceIds: readonly string[],
): Promise<void> {
  return request(
    blockResponsesPath(tenantId, workbenchId, messageId, blockId),
    SubmittedBlockResponse,
    {
      method: "POST",
      body: JSON.stringify({ kind: "poll", choiceIds }),
    },
  ).then(() => undefined);
}

export function submitFormResponse(
  tenantId: string,
  workbenchId: string,
  messageId: string,
  blockId: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  return request(
    blockResponsesPath(tenantId, workbenchId, messageId, blockId),
    SubmittedBlockResponse,
    {
      method: "POST",
      body: JSON.stringify({ kind: "form", values }),
    },
  ).then(() => undefined);
}

export function submitQuestionResponse(
  tenantId: string,
  workbenchId: string,
  messageId: string,
  blockId: string,
  answer: string,
  optionIndex?: number,
): Promise<void> {
  return request(
    blockResponsesPath(tenantId, workbenchId, messageId, blockId),
    SubmittedBlockResponse,
    {
      method: "POST",
      body: JSON.stringify(
        optionIndex !== undefined
          ? { kind: "question", answer, optionIndex }
          : { kind: "question", answer },
      ),
    },
  ).then(() => undefined);
}

// `chat/contextWindow`'s two-way "inherit vs override" resolution — see
// `resolveContextWindow` in `packages/chat/src/workbench-settings.ts`, whose
// server-side output this wire shape mirrors. `source` is what the settings
// panel's "Use bench default (N)" vs override control reads to decide which
// state it renders.
export const ResolvedContextWindow = type({
  value: "number",
  source: "'inherit' | 'override'",
});
export type ResolvedContextWindow = typeof ResolvedContextWindow.infer;

const WorkbenchSettingsResponse = WorkbenchWire.and({
  settings: type("Record<string, unknown>"),
  contextWindow: ResolvedContextWindow,
}).pipe((wire) => ({
  ...wire,
  participants: parseParticipants(wire.participants),
}));
export type WorkbenchSettings = Omit<
  typeof WorkbenchSettingsResponse.infer,
  "participants"
> & {
  readonly participants: readonly ParticipantRecord[];
};

export function getWorkbenchSettings(
  tenantId: string,
  workbenchId: string,
): Promise<WorkbenchSettings> {
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/settings`,
    WorkbenchSettingsResponse,
  );
}

/**
 * A `chat/*`-namespaced settings patch: name, purpose, pinned, and
 * context-window edits all go through this one function, matching the
 * single `PATCH /workbenches/:id/settings` route in
 * `packages/chat/src/routes.ts` that accepts any subset of them in one
 * body. `chat/contextWindow: null` clears
 * a workbench's override back to inheriting the bench default.
 */
export type WorkbenchSettingsPatch = {
  readonly "chat/kind"?: string;
  readonly "chat/name"?: string;
  readonly "chat/purpose"?: string;
  readonly "chat/pinned"?: boolean;
  readonly "chat/contextWindow"?: number | null;
  /**
   * `template/*` keys: the room's own record of which template minted
   * it and what it still needs connected, per `@workbench/templates`'s
   * own schema for this namespace. `chat`'s settings route validates
   * only its own `chat/*` keys and passes any other namespace through
   * opaquely (see `packages/chat/src/workbench-settings.ts`) — a
   * `template/*` patch is validated by the caller
   * (`apps/web/src/instant-agent-create.ts`) against that schema before
   * it ever reaches this function.
   */
  readonly "template/id"?: string;
  readonly "template/pendingConnections"?: readonly string[];
};

export function patchWorkbenchSettings(
  tenantId: string,
  workbenchId: string,
  patch: WorkbenchSettingsPatch,
): Promise<WorkbenchSettings> {
  return request(
    `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/settings`,
    WorkbenchSettingsResponse,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

// The room's GitHub connect card (CL-6344): the live read and the
// start-reviewing write, backed by `@workbench/templates`'s
// `createConnectGithubRoutes` (mounted at
// `/api/tenants/:tenantId/workbenches/:workbenchId/github/*`). Connecting
// the PAT itself is a separate, already-generic surface —
// `@corbits/connections`' `POST /:connectorId/complete` — never
// duplicated here.
const ConnectGithubRepoResponse = type({
  id: "string",
  name: "string",
  "lastPushedAt?": "string",
});

const ConnectGithubStateResponse = type({ kind: "'disconnected'" })
  .or({
    kind: "'connected'",
    orgName: "string",
    repos: ConnectGithubRepoResponse.array(),
    selectedRepoIds: "string[]",
  })
  .or({ kind: "'error'", message: "string" });
export type ConnectGithubStateResponse =
  typeof ConnectGithubStateResponse.infer;

export function getConnectGithubState(
  tenantId: string,
  workbenchId: string,
): Promise<ConnectGithubStateResponse> {
  return request(
    `/api/tenants/${tenantId}/workbenches/${workbenchId}/github/state`,
    ConnectGithubStateResponse,
  );
}

const StartReviewingResponse = type({ startedTriggerCount: "number" });

export function startReviewingGithubRepos(
  tenantId: string,
  workbenchId: string,
  repoIds: readonly string[],
): Promise<{ readonly startedTriggerCount: number }> {
  return request(
    `/api/tenants/${tenantId}/workbenches/${workbenchId}/github/start-reviewing`,
    StartReviewingResponse,
    { method: "POST", body: JSON.stringify({ repoIds }) },
  );
}

// `GET`/`PATCH /bench/settings` (see `packages/chat/src/routes.ts`): the
// bench-wide chat defaults every workbench inherits unless it sets its own
// override. Currently just the default context window.
const BenchChatSettingsResponse = type({
  settings: "Record<string, unknown>",
  contextWindow: "number",
});
export type BenchChatSettings = typeof BenchChatSettingsResponse.infer;

export function getBenchChatSettings(
  tenantId: string,
): Promise<BenchChatSettings> {
  return request(
    `/api/tenants/${tenantId}/chat/bench/settings`,
    BenchChatSettingsResponse,
  );
}

export type BenchChatSettingsPatch = {
  readonly "chat/contextWindow": number;
};

export function patchBenchChatSettings(
  tenantId: string,
  patch: BenchChatSettingsPatch,
): Promise<BenchChatSettings> {
  return request(
    `/api/tenants/${tenantId}/chat/bench/settings`,
    BenchChatSettingsResponse,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

// The turn projection's read surface (CL-6329/CL-6380): what a client
// reattaching to a workbench (page navigation, tab refocus, a dropped SSE
// connection) uses to find whether a turn is still running and, if so,
// replay whatever text it has already committed before the live stream's
// tail resumes — see `GET /workbenches/:id/turns[/:turnId]` in
// `packages/chat/src/routes.ts`.
const AgentTurnWire = type({
  id: "string",
  workbenchId: "string",
  agentAddress: "string",
  childRunId: "string",
  status: "'running' | 'completed' | 'failed' | 'cancelled'",
  "replyMessageId?": "string | null",
});
export type AgentTurnSummary = typeof AgentTurnWire.infer;

const AgentTurnsListWire = type({ items: AgentTurnWire.array() });

function turnsPath(tenantId: string, workbenchId: string): string {
  return `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/turns`;
}

export function listWorkbenchTurns(
  tenantId: string,
  workbenchId: string,
): Promise<readonly AgentTurnSummary[]> {
  return request(turnsPath(tenantId, workbenchId), AgentTurnsListWire).then(
    (body) => body.items,
  );
}

const AgentTurnDetailWire = AgentTurnWire.and({
  "textSnapshot?": "string | null",
});
export type AgentTurnDetail = typeof AgentTurnDetailWire.infer;

export function getWorkbenchTurn(
  tenantId: string,
  workbenchId: string,
  turnId: string,
): Promise<AgentTurnDetail> {
  return request(
    `${turnsPath(tenantId, workbenchId)}/${turnId}`,
    AgentTurnDetailWire,
  );
}

const CancelWorkbenchTurnWire = type({ cancelledCount: "number" });
export type CancelWorkbenchTurnResult = typeof CancelWorkbenchTurnWire.infer;

/**
 * Stops a workbench's in-flight turn(s) (CL-7201) — `POST
 * .../turns/cancel` in `packages/chat/src/routes.ts`. `cancelledCount`
 * is the honest count of turns actually settled `cancelled`, not a
 * promise that the underlying agent process stopped (see CL-7230): the
 * composer's own Stop affordance treats any non-throwing response as
 * "asked," and relies on the timeline's cancelled-turn notice — not this
 * response — to clear the typing indicator.
 */
export function cancelWorkbenchTurn(
  tenantId: string,
  workbenchId: string,
): Promise<CancelWorkbenchTurnResult> {
  return request(
    `${turnsPath(tenantId, workbenchId)}/cancel`,
    CancelWorkbenchTurnWire,
    {
      method: "POST",
    },
  );
}

/**
 * The newest still-`running` turn for `agentAddress`, or `null` if none —
 * what a remounting workbench asks on mount to know whether to hydrate its
 * streaming indicator immediately rather than wait for the next live event.
 * A 404 (no turn store injected on this deployment) reads the same as "no
 * running turn": the feature is simply unavailable, never an error the
 * caller needs to handle.
 */
export async function fetchRunningTurn(
  tenantId: string,
  workbenchId: string,
  agentAddress: string,
): Promise<AgentTurnDetail | null> {
  let turns: readonly AgentTurnSummary[];
  try {
    turns = await listWorkbenchTurns(tenantId, workbenchId);
  } catch (cause) {
    if (cause instanceof ChatApiError && cause.status === 404) return null;
    throw cause;
  }
  const running = turns.find(
    (turn) => turn.status === "running" && turn.agentAddress === agentAddress,
  );
  if (running === undefined) return null;
  const detail = await getWorkbenchTurn(tenantId, workbenchId, running.id);
  return { ...detail, textSnapshot: detail.textSnapshot ?? null };
}

/**
 * A readable name for a run, since the runs listing carries no name field:
 * the asset id's final path segment with any extension stripped, e.g.
 * `researcher/workflow.json` → "workflow". An asset id with no path shape
 * at all carries no readable segment to extract, so it renders friendly
 * placeholder copy — never the raw asset id.
 */
export function runDisplayName(run: Run): string {
  const slash = run.definitionAssetId.lastIndexOf("/");
  if (slash < 0) return CHAT_STRINGS.unnamedRun;
  const segment = run.definitionAssetId.slice(slash + 1);
  if (segment.length === 0) return CHAT_STRINGS.unnamedRun;
  const dot = segment.lastIndexOf(".");
  return dot > 0 ? segment.slice(0, dot) : segment;
}
