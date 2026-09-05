// The room's timeline: every message a workbench holds, as workbench
// data (CL-6327). Posting is one insert plus one publish onto the
// workbench's live stream — no mail, no wake, no sidecar hop — so a
// message is durable and on every open timeline before anything is asked
// of an agent. Reading is a query against these rows rather than a decode
// of the platform's mail envelope.
//
// `postRoomMessage` is the one way a message enters a workbench: a human's
// send, an agent's reply, a join notice, a command result. Dispatching an
// agent turn is a separate act (see `dispatchTurn` in
// `./workbench-service.ts`) that this module knows nothing about.
import { and, asc, count, desc, eq, gt, inArray, lt, or } from "drizzle-orm";

import type { Part } from "./parts";
import { workbenchMessages } from "./schema";
import type { ChatDb } from "./store";
import {
  activityPreviewText,
  CONSUMER_INFERENCE_FAILURE_NOTICE,
  consumerFacingInferenceText,
} from "./consumer-inference-text";

import { ChatMessageEventData } from "./stream-events";
import type { WorkbenchSubscriberRegistry } from "./workbench-events";

export interface RoomMessageSender {
  /** The sender's display name, when it has one; null otherwise. */
  readonly name: string | null;
  readonly address: string;
}

export interface RoomMessage {
  readonly id: string;
  readonly workbenchId: string;
  readonly createdAt: string;
  readonly sender: RoomMessageSender;
  /** Set for a human's own message; null for an agent's. */
  readonly senderPrincipalId: string | null;
  /** The agent run this message came out of; null for a human's. */
  readonly runId: string | null;
  readonly threadId: string | null;
  /**
   * The RFC 5322 `Message-ID` this row was dispatched to an agent as
   * (CL-7104); null for a row nobody was ever asked to answer. See
   * `./mail-headers.ts` for how it is derived.
   */
  readonly mailMessageId: string | null;
  readonly parts: readonly Part[];
}

export interface PostRoomMessageInput {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly sender: RoomMessageSender;
  readonly parts: readonly Part[];
  readonly senderPrincipalId?: string;
  readonly runId?: string;
  readonly threadId?: string;
}

export interface ListRoomMessagesInput {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly cursor?: string;
}

export interface ListedRoomMessages {
  readonly items: readonly RoomMessage[];
  readonly nextCursor?: string;
}

/**
 * Per-workbench activity a workbench-list row can honestly show: the
 * newest message's timestamp, how many messages postdate the caller's
 * read cursor, and a bounded text preview. A workbench with no messages
 * reports no `lastActivityAt` and no `preview` — never a zero date, never
 * an invented snippet.
 */
export interface RoomActivitySummary {
  readonly lastActivityAt?: string;
  readonly unreadCount: number;
  readonly preview?: string;
}

export interface ListRoomActivityInput {
  readonly tenantId: string;
  readonly workbenches: readonly {
    readonly workbenchId: string;
    /** The caller's own read cursor; absent means everything is unread. */
    readonly sinceCreatedAt?: string;
  }[];
}

export interface RoomMessageStore {
  insertMessage(
    input: PostRoomMessageInput & { readonly id: string },
  ): Promise<RoomMessage>;
  listMessages(input: ListRoomMessagesInput): Promise<ListedRoomMessages>;
  getMessage(input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    readonly messageId: string;
  }): Promise<RoomMessage | undefined>;
  /**
   * Records the `Message-ID` a row went out as (CL-7104). The header is
   * derived from the row's own id, so writing it twice writes the same
   * value — this is a stamp, not a mint, and needs no claim.
   */
  stampMailMessageId(input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    readonly messageId: string;
    readonly mailMessageId: string;
  }): Promise<void>;
  /**
   * The row a `Message-ID` names — the inbound half of correlation. An
   * `In-Reply-To` no row answers to resolves to undefined, which the
   * caller reports rather than attributing to a guess.
   */
  findByMailMessageId(input: {
    readonly tenantId: string;
    readonly mailMessageId: string;
  }): Promise<RoomMessage | undefined>;
  listActivity(
    input: ListRoomActivityInput,
  ): Promise<Record<string, RoomActivitySummary>>;
  /**
   * Removes a just-inserted row that never reached a client (CL-7450):
   * the mailbox fan-out step runs AFTER the row is stored but BEFORE it
   * is published, and a fan-out failure must not leave a durable row
   * nobody's mailbox agrees exists — nothing has seen it yet, so deleting
   * it is safe, and a client retry of the same send does not then
   * duplicate. Never called on a row that has been published.
   */
  deleteMessage(input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    readonly messageId: string;
  }): Promise<void>;
}

/** One page of timeline, newest first — the same page size the timeline
 * has always read a workbench in. */
const PAGE_SIZE = 50;

/** Cap on how far back listActivity walks for a last-good preview (CL-6735). */
const PREVIEW_LOOKBACK = 20;
const PREVIEW_MAX_LENGTH = 80;

let lastMintedAt = 0;
let mintsThisMillisecond = 0;

/**
 * Time-ordered: the mint time leads and a per-millisecond counter
 * follows, so ids sort the way the timeline reads even for a burst
 * written inside one clock tick — a join notice and the greeting behind
 * it never render in the wrong order. The random tail keeps ids
 * unguessable and separates two hubs minting in the same millisecond.
 */
function newMessageId(): string {
  const now = Date.now();
  if (now === lastMintedAt) {
    mintsThisMillisecond += 1;
  } else {
    lastMintedAt = now;
    mintsThisMillisecond = 0;
  }
  const mintedAt = now.toString(16).padStart(12, "0");
  const sequence = mintsThisMillisecond.toString(16).padStart(4, "0");
  const random = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `msg_${mintedAt}${sequence}${random}`;
}

/**
 * A bounded preview of a message for a workbench-list row: its text
 * parts, whitespace-collapsed and truncated. An attachment-only message
 * previews as nothing rather than a fabricated placeholder. Failed turns
 * and classified inference-failure paragraphs (CL-6735) collapse to the
 * short consumer notice — never HTTP status, raw provider dumps, or the
 * full credential-error sentence.
 */
export function previewOf(parts: readonly Part[]): string {
  if (isFailurePreviewParts(parts)) {
    return CONSUMER_INFERENCE_FAILURE_NOTICE;
  }
  const text = activityPreviewText(
    parts
      .filter((part): part is Extract<Part, { kind: "text" }> => {
        return part.kind === "text";
      })
      .map((part) => part.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return text.length > PREVIEW_MAX_LENGTH
    ? `${text.slice(0, PREVIEW_MAX_LENGTH).trimEnd()}…`
    : text;
}

/** True when these parts must not appear as a bench-list preview. */
function isFailurePreviewParts(parts: readonly Part[]): boolean {
  if (parts.some((part) => part.kind === "text" && part.turnFailed === true)) {
    return true;
  }
  const joined = parts
    .filter((part): part is Extract<Part, { kind: "text" }> => {
      return part.kind === "text";
    })
    .map((part) => part.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (joined.length === 0) return false;
  const facing = consumerFacingInferenceText(joined);
  return facing === CONSUMER_INFERENCE_FAILURE_NOTICE;
}

/**
 * Pick bench-list preview text from newest-first messages: skip failed
 * turns and classified failure paragraphs, keep the last good human/agent
 * text, and fall back to the short consumer notice when nothing else
 * qualifies (CL-6735). Event / attachment-only rows contribute no text and
 * are walked past so a join notice never blanks a prior readable preview
 * (CL-6795). Ordinary user/agent replies are never skipped.
 */
function activityPreviewFromNewestFirst(
  newestFirst: readonly RoomMessage[],
): string {
  for (const message of newestFirst) {
    if (isFailurePreviewParts(message.parts)) continue;
    const preview = previewOf(message.parts);
    if (preview.length > 0) return preview;
  }
  const newest = newestFirst[0];
  if (newest !== undefined && isFailurePreviewParts(newest.parts)) {
    return CONSUMER_INFERENCE_FAILURE_NOTICE;
  }
  return "";
}

/** True when listActivity must walk back past the newest row for a preview
 * (CL-6735 failures; CL-6795 empty event/attachment-only newest). */
function needsPreviewLookback(parts: readonly Part[]): boolean {
  return isFailurePreviewParts(parts) || previewOf(parts).length === 0;
}

function summaryOf(
  newest: RoomMessage,
  unreadCount: number,
  newestFirstForPreview: readonly RoomMessage[] = [newest],
): RoomActivitySummary {
  const preview = activityPreviewFromNewestFirst(newestFirstForPreview);
  const base = { unreadCount, lastActivityAt: newest.createdAt };
  return preview.length === 0 ? base : { ...base, preview };
}

/**
 * Puts a message on a workbench's timeline: one durable row, then one
 * event onto the live stream so every open client sees it without asking
 * for it again. The row is written before the publish — a client that
 * refetches on the event always finds the message it was told about.
 *
 * The published event carries the full rendered row — `sender` and
 * `parts` included, not just enough to key a refetch — so a subscriber
 * can append it straight to its timeline with zero follow-up reads.
 * `ChatMessageEventData` is the wire contract this shape is asserted
 * against before it ever reaches `publish`.
 */
function consumerFacingParts(parts: readonly Part[]): Part[] {
  return parts.map((part) => {
    if (part.kind !== "text") return part;
    const text = consumerFacingInferenceText(part.text);
    if (text === part.text) return part;
    return { ...part, text };
  });
}

/**
 * Just the durable insert half of `postRoomMessage` — no publish. CL-7450's
 * mailbox fan-out needs to run AFTER the row is stored (so its own
 * Message-ID can be stamped and used) but BEFORE anything is published (so
 * a fan-out failure can delete the row with no client ever having seen
 * it). `postRoomMessage` itself is unchanged for every other caller, which
 * has no such between-insert-and-publish step to run.
 */
export async function insertRoomMessageRow(
  deps: { readonly roomMessages: RoomMessageStore },
  input: PostRoomMessageInput,
): Promise<RoomMessage> {
  const parts = consumerFacingParts(input.parts);
  return deps.roomMessages.insertMessage({
    ...input,
    parts,
    id: newMessageId(),
  });
}

/** The publish half of `postRoomMessage`, for a row `insertRoomMessageRow`
 * already stored. */
export function publishRoomMessageEvent(
  deps: { readonly publish: WorkbenchSubscriberRegistry["publish"] },
  message: RoomMessage,
): void {
  const data = ChatMessageEventData.assert({
    id: message.id,
    workbenchId: message.workbenchId,
    createdAt: message.createdAt,
    threadId: message.threadId,
    sender: message.sender,
    parts: message.parts,
  });
  deps.publish(message.workbenchId, { type: "chat.message", data });
}

export async function postRoomMessage(
  deps: {
    readonly roomMessages: RoomMessageStore;
    readonly publish: WorkbenchSubscriberRegistry["publish"];
  },
  input: PostRoomMessageInput,
): Promise<RoomMessage> {
  const message = await insertRoomMessageRow(deps, input);
  publishRoomMessageEvent(deps, message);
  return message;
}

function encodeCursor(message: RoomMessage): string {
  return `${message.createdAt}|${message.id}`;
}

function decodeCursor(
  cursor: string,
): { createdAt: Date; id: string } | undefined {
  const separator = cursor.lastIndexOf("|");
  if (separator === -1) return undefined;
  const createdAt = new Date(cursor.slice(0, separator));
  if (Number.isNaN(createdAt.getTime())) return undefined;
  return { createdAt, id: cursor.slice(separator + 1) };
}

function pageOf(newestFirst: readonly RoomMessage[]): ListedRoomMessages {
  const items = newestFirst.slice(0, PAGE_SIZE);
  const last = items[items.length - 1];
  return newestFirst.length > PAGE_SIZE && last !== undefined
    ? { items, nextCursor: encodeCursor(last) }
    : { items };
}

interface MessageRow {
  id: string;
  workbenchId: string;
  senderAddress: string;
  senderName: string | null;
  senderPrincipalId: string | null;
  runId: string | null;
  threadId: string | null;
  mailMessageId: string | null;
  parts: unknown;
  createdAt: Date;
}

function toRoomMessage(row: MessageRow): RoomMessage {
  return {
    id: row.id,
    workbenchId: row.workbenchId,
    createdAt: row.createdAt.toISOString(),
    sender: { name: row.senderName, address: row.senderAddress },
    senderPrincipalId: row.senderPrincipalId,
    runId: row.runId,
    threadId: row.threadId,
    mailMessageId: row.mailMessageId,
    parts: row.parts as Part[],
  };
}

export function createDrizzleRoomMessageStore(
  db: ChatDb<Record<string, unknown>>,
): RoomMessageStore {
  return {
    async insertMessage(input) {
      const [row] = await db
        .insert(workbenchMessages)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          workbenchId: input.workbenchId,
          senderAddress: input.sender.address,
          senderName: input.sender.name,
          senderPrincipalId: input.senderPrincipalId ?? null,
          runId: input.runId ?? null,
          threadId: input.threadId ?? null,
          parts: input.parts,
        })
        .returning();
      if (row === undefined) {
        throw new Error(
          `failed to post a message into workbench "${input.workbenchId}"`,
        );
      }
      return toRoomMessage(row as MessageRow);
    },

    async listMessages(input) {
      const inWorkbench = and(
        eq(workbenchMessages.tenantId, input.tenantId),
        eq(workbenchMessages.workbenchId, input.workbenchId),
      );
      const cursor =
        input.cursor === undefined ? undefined : decodeCursor(input.cursor);
      // Keyset, never offset: `(created_at, id)` strictly before the
      // cursor, so a message posted mid-page never shifts a later page.
      const where =
        cursor === undefined
          ? inWorkbench
          : and(
              inWorkbench,
              or(
                lt(workbenchMessages.createdAt, cursor.createdAt),
                and(
                  eq(workbenchMessages.createdAt, cursor.createdAt),
                  lt(workbenchMessages.id, cursor.id),
                ),
              ),
            );
      const rows = await db
        .select()
        .from(workbenchMessages)
        .where(where)
        .orderBy(desc(workbenchMessages.createdAt), desc(workbenchMessages.id))
        .limit(PAGE_SIZE + 1);
      return pageOf(rows.map((row) => toRoomMessage(row as MessageRow)));
    },

    async getMessage(input) {
      const [row] = await db
        .select()
        .from(workbenchMessages)
        .where(
          and(
            eq(workbenchMessages.id, input.messageId),
            eq(workbenchMessages.tenantId, input.tenantId),
            eq(workbenchMessages.workbenchId, input.workbenchId),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : toRoomMessage(row as MessageRow);
    },

    async stampMailMessageId(input) {
      await db
        .update(workbenchMessages)
        .set({ mailMessageId: input.mailMessageId })
        .where(
          and(
            eq(workbenchMessages.id, input.messageId),
            eq(workbenchMessages.tenantId, input.tenantId),
            eq(workbenchMessages.workbenchId, input.workbenchId),
          ),
        );
    },

    async deleteMessage(input) {
      await db
        .delete(workbenchMessages)
        .where(
          and(
            eq(workbenchMessages.id, input.messageId),
            eq(workbenchMessages.tenantId, input.tenantId),
            eq(workbenchMessages.workbenchId, input.workbenchId),
          ),
        );
    },

    async findByMailMessageId(input) {
      const [row] = await db
        .select()
        .from(workbenchMessages)
        .where(
          and(
            eq(workbenchMessages.tenantId, input.tenantId),
            eq(workbenchMessages.mailMessageId, input.mailMessageId),
          ),
        )
        .limit(1);
      return row === undefined ? undefined : toRoomMessage(row as MessageRow);
    },

    async listActivity(input) {
      if (input.workbenches.length === 0) return {};
      const workbenchIds = input.workbenches.map(
        (workbench) => workbench.workbenchId,
      );
      const inTenant = eq(workbenchMessages.tenantId, input.tenantId);

      // Two bulk queries, never a read of every message the listed
      // workbenches hold: DISTINCT ON walks the feed index backwards to
      // the newest row per workbench, and one grouped COUNT tallies the
      // unread. A workbench holding a hundred thousand messages costs
      // the list row exactly what a workbench holding three does.
      const newestRows = await db
        .selectDistinctOn([workbenchMessages.workbenchId])
        .from(workbenchMessages)
        .where(
          and(inTenant, inArray(workbenchMessages.workbenchId, workbenchIds)),
        )
        .orderBy(
          asc(workbenchMessages.workbenchId),
          desc(workbenchMessages.createdAt),
          desc(workbenchMessages.id),
        );
      if (newestRows.length === 0) return {};

      // Each workbench counted from its own read cursor, as an OR of
      // per-workbench conditions rather than a query per row of the
      // list. No cursor means everything in that workbench is unread.
      const unreadConditions = input.workbenches.map((workbench) => {
        const cursor =
          workbench.sinceCreatedAt === undefined
            ? new Date(0)
            : new Date(workbench.sinceCreatedAt);
        return and(
          eq(workbenchMessages.workbenchId, workbench.workbenchId),
          gt(workbenchMessages.createdAt, cursor),
        );
      });
      const unread = await db
        .select({
          workbenchId: workbenchMessages.workbenchId,
          unreadCount: count(),
        })
        .from(workbenchMessages)
        .where(and(inTenant, or(...unreadConditions)))
        .groupBy(workbenchMessages.workbenchId);
      const unreadByWorkbenchId = new Map(
        unread.map((row) => [row.workbenchId, row.unreadCount]),
      );

      const result: Record<string, RoomActivitySummary> = {};
      for (const row of newestRows) {
        const newest = toRoomMessage(row as MessageRow);
        const unreadCount = unreadByWorkbenchId.get(newest.workbenchId) ?? 0;
        let newestFirstForPreview: readonly RoomMessage[] = [newest];
        if (needsPreviewLookback(newest.parts)) {
          const recentRows = await db
            .select()
            .from(workbenchMessages)
            .where(
              and(
                inTenant,
                eq(workbenchMessages.workbenchId, newest.workbenchId),
              ),
            )
            .orderBy(
              desc(workbenchMessages.createdAt),
              desc(workbenchMessages.id),
            )
            .limit(PREVIEW_LOOKBACK);
          newestFirstForPreview = recentRows.map((recent) =>
            toRoomMessage(recent as MessageRow),
          );
        }
        result[newest.workbenchId] = summaryOf(
          newest,
          unreadCount,
          newestFirstForPreview,
        );
      }
      return result;
    },
  };
}

/** In-memory `RoomMessageStore` for tests and any host running without a
 * database, matching `createInMemoryChatStore`'s role for the other
 * workbench tables. */
export function createInMemoryRoomMessageStore(): RoomMessageStore {
  const byWorkbench = new Map<string, RoomMessage[]>();
  const keyOf = (tenantId: string, workbenchId: string) =>
    `${tenantId}:${workbenchId}`;

  return {
    async insertMessage(input) {
      const message: RoomMessage = {
        id: input.id,
        workbenchId: input.workbenchId,
        createdAt: new Date().toISOString(),
        sender: input.sender,
        senderPrincipalId: input.senderPrincipalId ?? null,
        runId: input.runId ?? null,
        threadId: input.threadId ?? null,
        mailMessageId: null,
        parts: input.parts,
      };
      const key = keyOf(input.tenantId, input.workbenchId);
      byWorkbench.set(key, [...(byWorkbench.get(key) ?? []), message]);
      return message;
    },

    async stampMailMessageId(input) {
      const key = keyOf(input.tenantId, input.workbenchId);
      const messages = byWorkbench.get(key);
      if (messages === undefined) return;
      byWorkbench.set(
        key,
        messages.map((message) =>
          message.id === input.messageId
            ? { ...message, mailMessageId: input.mailMessageId }
            : message,
        ),
      );
    },

    async findByMailMessageId(input) {
      for (const [key, messages] of byWorkbench) {
        if (!key.startsWith(`${input.tenantId}:`)) continue;
        const match = messages.find(
          (message) => message.mailMessageId === input.mailMessageId,
        );
        if (match !== undefined) return match;
      }
      return undefined;
    },

    async deleteMessage(input) {
      const key = keyOf(input.tenantId, input.workbenchId);
      const messages = byWorkbench.get(key);
      if (messages === undefined) return;
      byWorkbench.set(
        key,
        messages.filter((message) => message.id !== input.messageId),
      );
    },

    async listMessages(input) {
      const messages =
        byWorkbench.get(keyOf(input.tenantId, input.workbenchId)) ?? [];
      // The same `(created_at, id)` total order the drizzle store pages
      // by, so a cursor means the same thing against either.
      const newestFirst = [...messages].sort((left, right) =>
        left.createdAt === right.createdAt
          ? right.id.localeCompare(left.id)
          : right.createdAt.localeCompare(left.createdAt),
      );
      const cursor =
        input.cursor === undefined ? undefined : decodeCursor(input.cursor);
      if (cursor === undefined) return pageOf(newestFirst);
      const cursorCreatedAt = cursor.createdAt.toISOString();
      return pageOf(
        newestFirst.filter(
          (message) =>
            message.createdAt < cursorCreatedAt ||
            (message.createdAt === cursorCreatedAt && message.id < cursor.id),
        ),
      );
    },

    async getMessage(input) {
      const messages =
        byWorkbench.get(keyOf(input.tenantId, input.workbenchId)) ?? [];
      return messages.find((message) => message.id === input.messageId);
    },

    async listActivity(input) {
      const result: Record<string, RoomActivitySummary> = {};
      for (const workbench of input.workbenches) {
        const messages = byWorkbench.get(
          keyOf(input.tenantId, workbench.workbenchId),
        );
        const newest = messages?.[messages.length - 1];
        if (messages === undefined || newest === undefined) continue;
        const unreadCount = messages.filter(
          (message) =>
            workbench.sinceCreatedAt === undefined ||
            message.createdAt > workbench.sinceCreatedAt,
        ).length;
        const newestFirst = [...messages]
          .sort((left, right) =>
            left.createdAt === right.createdAt
              ? right.id.localeCompare(left.id)
              : right.createdAt.localeCompare(left.createdAt),
          )
          .slice(0, PREVIEW_LOOKBACK);
        result[workbench.workbenchId] = summaryOf(
          newest,
          unreadCount,
          newestFirst,
        );
      }
      return result;
    },
  };
}
