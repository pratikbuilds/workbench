// Thread identity for workbenches. Messages remain platform mail; this
// module owns which thread a message belongs to, auto-opens reply
// threads on first reply, and creates delivery threads for routine
// run deliveries.
//
// A thread is also what a dispatched message's RFC 5322 threading headers
// are derived from (CL-7104): `mailAncestryOf` below walks a message's
// parent chain, and `./mail-headers.ts` turns that chain into the
// `References` / `In-Reply-To` a reply correlates back through.

import { and, eq, asc, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { workbenchThreadMessages, workbenchThreads } from "./schema";

export type ThreadKind = "root" | "reply" | "delivery";

/**
 * Two levels, stop: workbench → thread → sub-thread, no unbounded
 * nesting (owner ruling, CL-5908). `parentThreadId` is the thread this
 * one hangs directly off — null for the root thread, the root
 * thread's id for a depth-1 thread, and a depth-1 thread's id for a
 * depth-2 sub-thread. A depth-2 thread's id never appears as another
 * thread's `parentThreadId` — see `resolveThreadAnchor`.
 */
export type WorkbenchThread = {
  readonly id: string;
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly kind: ThreadKind;
  readonly parentMessageId: string | null;
  readonly parentThreadId: string | null;
  readonly runRef: string | null;
  readonly title: string | null;
  readonly createdAt: Date;
};

/** A reply/fork would nest a thread past the two-level cap. */
export class ThreadDepthCapError extends Error {
  constructor() {
    super("thread nesting is capped at two levels (thread → sub-thread)");
    this.name = "ThreadDepthCapError";
  }
}

export type ThreadAnchor = {
  /** Which thread the new reply/fork thread should hang off. */
  readonly parentThreadId: string;
  /**
   * True when `container` is already a depth-2 sub-thread, so hanging
   * a new thread directly off it would be a third level. A capped
   * reply-open must refuse (see `openReplyThread`); an explicit fork
   * instead redirects to `parentThreadId` — a sibling sub-thread under
   * the same depth-1 parent, never a third level (CL-5948).
   */
  readonly blocked: boolean;
};

/**
 * Where a new thread anchored on a message inside `container` belongs.
 * `container` is the thread the origin message currently lives in (the
 * root thread if the message isn't assigned to any thread yet).
 */
export function resolveThreadAnchor(
  root: WorkbenchThread,
  container: WorkbenchThread,
): ThreadAnchor {
  if (container.id === root.id) {
    return { parentThreadId: root.id, blocked: false };
  }
  if (
    container.parentThreadId === null ||
    container.parentThreadId === root.id
  ) {
    return { parentThreadId: container.id, blocked: false };
  }
  return { parentThreadId: container.parentThreadId, blocked: true };
}

export type CreateDeliveryThreadInput = {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly runRef: string;
  readonly title?: string;
};

export type OpenReplyThreadInput = {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly parentMessageId: string;
  readonly title?: string;
};

/** Same shape as opening a reply thread — a fork is anchored the same
 * way, just explicitly user-initiated and depth-cap-redirecting rather
 * than depth-cap-refusing. See `resolveThreadAnchor`. */
export type ForkThreadInput = OpenReplyThreadInput;

export type AssignMessageInput = {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly threadId: string;
  readonly messageId: string;
};

export interface ThreadStore {
  ensureRootThread(
    tenantId: string,
    workbenchId: string,
  ): Promise<WorkbenchThread>;
  createDeliveryThread(
    input: CreateDeliveryThreadInput,
  ): Promise<WorkbenchThread>;
  /** Opens (or reuses) the depth-1 reply thread for a message. Throws
   * `ThreadDepthCapError` if the message already lives in a depth-2
   * sub-thread — a caller wanting the depth-cap-redirect behavior wants
   * `forkThread`, not this. */
  openReplyThread(input: OpenReplyThreadInput): Promise<WorkbenchThread>;
  /** Opens (or reuses) a sub-thread rooted at a message, honoring the
   * two-level cap: forking from a message already inside a sub-thread
   * creates a sibling sub-thread under that sub-thread's parent rather
   * than a third level (CL-5948). Never throws for depth. */
  forkThread(input: ForkThreadInput): Promise<WorkbenchThread>;
  getThread(
    tenantId: string,
    threadId: string,
  ): Promise<WorkbenchThread | undefined>;
  listThreads(
    tenantId: string,
    workbenchId: string,
  ): Promise<readonly WorkbenchThread[]>;
  assignMessage(input: AssignMessageInput): Promise<void>;
  listMessageIds(
    tenantId: string,
    threadId: string,
  ): Promise<readonly string[]>;
  /**
   * Every membership row this workbench has, as `messageId -> threadId`.
   * A message with no row is absent rather than defaulted to the root
   * thread: the "root feed by default" contract belongs to whoever
   * reads a thread's messages (see the threads route in `./routes.ts`),
   * so this stays a faithful report of what was actually written.
   */
  listThreadAssignments(
    tenantId: string,
    workbenchId: string,
  ): Promise<ReadonlyMap<string, string>>;
  threadIdForMessage(
    tenantId: string,
    workbenchId: string,
    messageId: string,
  ): Promise<string | undefined>;
}

function newThreadId(): string {
  return `thr_${crypto.randomUUID().replace(/-/g, "")}`;
}

function asKind(raw: string): ThreadKind {
  if (raw === "root" || raw === "reply" || raw === "delivery") return raw;
  throw new Error(`unknown thread kind: ${raw}`);
}

/**
 * Pure helper: which thread should a newly posted message land in?
 * - explicit threadId wins
 * - inReplyToMessageId opens/uses a reply thread (caller still calls
 *   openReplyThread + assignMessage)
 * - otherwise the root feed
 */
export function resolveTargetThread(args: {
  readonly explicitThreadId?: string;
  readonly inReplyToMessageId?: string;
  readonly rootThreadId: string;
  readonly replyThreadId?: string;
}): { readonly threadId: string; readonly needsReplyOpen: boolean } {
  if (args.explicitThreadId !== undefined) {
    return { threadId: args.explicitThreadId, needsReplyOpen: false };
  }
  if (args.inReplyToMessageId !== undefined) {
    if (args.replyThreadId !== undefined) {
      return { threadId: args.replyThreadId, needsReplyOpen: false };
    }
    return { threadId: args.rootThreadId, needsReplyOpen: true };
  }
  return { threadId: args.rootThreadId, needsReplyOpen: false };
}

/**
 * The parent chain of a message living in `threadId`, root first: that
 * thread's anchor message, then the anchor's own anchor. Empty for the
 * root feed (or a delivery thread), which answers nothing. Bounded by
 * the two-level cap — a chain is never longer than two entries — so this
 * walks the parentage rather than recursing without a bound.
 *
 * Takes the thread rather than the message on purpose: a message is
 * posted with its thread on the row before the membership row is
 * written, and a dispatch that fires in between must still see the
 * parentage it was posted into.
 *
 * This is what a dispatched message's `References` header is built from
 * (`mailThreadHeaders` in `./mail-headers.ts`): the chain in RFC 5322's
 * own order, oldest ancestor first.
 */
export async function mailAncestryOf(
  store: Pick<ThreadStore, "getThread" | "threadIdForMessage">,
  tenantId: string,
  workbenchId: string,
  threadId: string | null,
): Promise<readonly string[]> {
  const ancestors: string[] = [];
  let current = threadId;
  // The cap is two levels (thread → sub-thread), so a chain has at most
  // two ancestors; the bound is the cap, never a guess about cycles.
  for (let depth = 0; depth < 2; depth++) {
    if (current === null) break;
    const thread = await store.getThread(tenantId, current);
    if (thread === undefined || thread.parentMessageId === null) break;
    ancestors.unshift(thread.parentMessageId);
    current =
      (await store.threadIdForMessage(
        tenantId,
        workbenchId,
        thread.parentMessageId,
      )) ?? null;
  }
  return ancestors;
}

export function createInMemoryThreadStore(): ThreadStore {
  const threads = new Map<string, WorkbenchThread>();
  const byWorkbench = new Map<string, string[]>();
  const messageToThread = new Map<string, string>();
  const threadMessages = new Map<string, string[]>();

  const workbenchKey = (tenantId: string, workbenchId: string) =>
    `${tenantId}::${workbenchId}`;
  const messageKey = (
    tenantId: string,
    workbenchId: string,
    messageId: string,
  ) => `${tenantId}::${workbenchId}::${messageId}`;

  async function ensureRootThread(
    tenantId: string,
    workbenchId: string,
  ): Promise<WorkbenchThread> {
    const key = workbenchKey(tenantId, workbenchId);
    const ids = byWorkbench.get(key) ?? [];
    for (const id of ids) {
      const t = threads.get(id);
      if (t?.kind === "root") return t;
    }
    const row: WorkbenchThread = {
      id: newThreadId(),
      tenantId,
      workbenchId,
      kind: "root",
      parentMessageId: null,
      parentThreadId: null,
      runRef: null,
      title: null,
      createdAt: new Date(),
    };
    threads.set(row.id, row);
    byWorkbench.set(key, [...ids, row.id]);
    return row;
  }

  /** The thread a message currently lives in, or `root` if unassigned. */
  async function containerThreadFor(
    tenantId: string,
    workbenchId: string,
    parentMessageId: string,
    root: WorkbenchThread,
  ): Promise<WorkbenchThread> {
    const containerId = messageToThread.get(
      messageKey(tenantId, workbenchId, parentMessageId),
    );
    if (containerId === undefined) return root;
    return threads.get(containerId) ?? root;
  }

  async function anchoredReplyThread(
    input: OpenReplyThreadInput,
    mode: "reply" | "fork",
  ): Promise<WorkbenchThread> {
    const key = workbenchKey(input.tenantId, input.workbenchId);
    const root = await ensureRootThread(input.tenantId, input.workbenchId);
    const ids = byWorkbench.get(key) ?? [];
    for (const id of ids) {
      const t = threads.get(id);
      if (t?.kind === "reply" && t.parentMessageId === input.parentMessageId) {
        return t;
      }
    }
    const container = await containerThreadFor(
      input.tenantId,
      input.workbenchId,
      input.parentMessageId,
      root,
    );
    const anchor = resolveThreadAnchor(root, container);
    if (anchor.blocked && mode === "reply") throw new ThreadDepthCapError();
    const row: WorkbenchThread = {
      id: newThreadId(),
      tenantId: input.tenantId,
      workbenchId: input.workbenchId,
      kind: "reply",
      parentMessageId: input.parentMessageId,
      parentThreadId: anchor.parentThreadId,
      runRef: null,
      title: input.title ?? null,
      createdAt: new Date(),
    };
    threads.set(row.id, row);
    byWorkbench.set(key, [...ids, row.id]);
    return row;
  }

  return {
    ensureRootThread,

    async createDeliveryThread(input) {
      const key = workbenchKey(input.tenantId, input.workbenchId);
      const ids = byWorkbench.get(key) ?? [];
      for (const id of ids) {
        const t = threads.get(id);
        if (t?.kind === "delivery" && t.runRef === input.runRef) return t;
      }
      const row: WorkbenchThread = {
        id: newThreadId(),
        tenantId: input.tenantId,
        workbenchId: input.workbenchId,
        kind: "delivery",
        parentMessageId: null,
        parentThreadId: null,
        runRef: input.runRef,
        title: input.title ?? null,
        createdAt: new Date(),
      };
      threads.set(row.id, row);
      byWorkbench.set(key, [...ids, row.id]);
      return row;
    },

    openReplyThread: (input) => anchoredReplyThread(input, "reply"),
    forkThread: (input) => anchoredReplyThread(input, "fork"),

    async getThread(tenantId, threadId) {
      const t = threads.get(threadId);
      if (t === undefined || t.tenantId !== tenantId) return undefined;
      return t;
    },

    async listThreads(tenantId, workbenchId) {
      const ids = byWorkbench.get(workbenchKey(tenantId, workbenchId)) ?? [];
      return ids
        .flatMap((id) => {
          const t = threads.get(id);
          return t === undefined ? [] : [t];
        })
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },

    async assignMessage(input) {
      messageToThread.set(
        messageKey(input.tenantId, input.workbenchId, input.messageId),
        input.threadId,
      );
      const list = threadMessages.get(input.threadId) ?? [];
      if (!list.includes(input.messageId)) {
        threadMessages.set(input.threadId, [...list, input.messageId]);
      }
    },

    async listMessageIds(tenantId, threadId) {
      const t = threads.get(threadId);
      if (t === undefined || t.tenantId !== tenantId) return [];
      return threadMessages.get(threadId) ?? [];
    },

    async threadIdForMessage(tenantId, workbenchId, messageId) {
      return messageToThread.get(messageKey(tenantId, workbenchId, messageId));
    },

    async listThreadAssignments(tenantId, workbenchId) {
      const prefix = `${workbenchKey(tenantId, workbenchId)}::`;
      const assignments = new Map<string, string>();
      for (const [key, threadId] of messageToThread) {
        if (!key.startsWith(prefix)) continue;
        assignments.set(key.slice(prefix.length), threadId);
      }
      return assignments;
    },
  };
}

export type ThreadDb<
  TSchema extends Record<string, unknown> = Record<string, never>,
> = PostgresJsDatabase<TSchema>;

function mapThreadRow(
  row: typeof workbenchThreads.$inferSelect,
): WorkbenchThread {
  return {
    id: row.id,
    tenantId: row.tenantId,
    workbenchId: row.workbenchId,
    kind: asKind(row.kind),
    parentMessageId: row.parentMessageId ?? null,
    parentThreadId: row.parentThreadId ?? null,
    runRef: row.runRef ?? null,
    title: row.title ?? null,
    createdAt: row.createdAt,
  };
}

export function createDrizzleThreadStore<
  TSchema extends Record<string, unknown>,
>(db: ThreadDb<TSchema>): ThreadStore {
  async function selectRootThread(
    tenantId: string,
    workbenchId: string,
  ): Promise<WorkbenchThread | undefined> {
    const rows = await db
      .select()
      .from(workbenchThreads)
      .where(
        and(
          eq(workbenchThreads.tenantId, tenantId),
          eq(workbenchThreads.workbenchId, workbenchId),
          eq(workbenchThreads.kind, "root"),
        ),
      )
      .orderBy(asc(workbenchThreads.createdAt))
      .limit(1);
    return rows[0] ? mapThreadRow(rows[0]) : undefined;
  }

  async function ensureRootThread(
    tenantId: string,
    workbenchId: string,
  ): Promise<WorkbenchThread> {
    const existing = await selectRootThread(tenantId, workbenchId);
    if (existing) return existing;
    // Insert-first, not select-then-insert: two concurrent first
    // writers both attempt the insert, the partial unique index
    // (tenant_id, workbench_id) WHERE kind = 'root' serializes them,
    // and the loser gets an empty `returning()` rather than a
    // duplicate root thread — re-select picks up the winner's row.
    const id = newThreadId();
    const inserted = await db
      .insert(workbenchThreads)
      .values({
        id,
        tenantId,
        workbenchId,
        kind: "root",
        parentMessageId: null,
        parentThreadId: null,
        runRef: null,
        title: null,
      })
      .onConflictDoNothing({
        target: [workbenchThreads.tenantId, workbenchThreads.workbenchId],
        where: eq(workbenchThreads.kind, "root"),
      })
      .returning();
    const row = inserted[0];
    if (row) return mapThreadRow(row);
    const reselected = await selectRootThread(tenantId, workbenchId);
    if (!reselected) {
      throw new Error("expected root thread row after conflicting insert");
    }
    return reselected;
  }

  /** The thread a message currently lives in, or `root` if unassigned. */
  async function containerThreadFor(
    tenantId: string,
    workbenchId: string,
    parentMessageId: string,
    root: WorkbenchThread,
  ): Promise<WorkbenchThread> {
    const rows = await db
      .select({ threadId: workbenchThreadMessages.threadId })
      .from(workbenchThreadMessages)
      .where(
        and(
          eq(workbenchThreadMessages.tenantId, tenantId),
          eq(workbenchThreadMessages.workbenchId, workbenchId),
          eq(workbenchThreadMessages.messageId, parentMessageId),
        ),
      )
      .limit(1);
    const containerId = rows[0]?.threadId;
    if (containerId === undefined) return root;
    const containerRows = await db
      .select()
      .from(workbenchThreads)
      .where(
        and(
          eq(workbenchThreads.tenantId, tenantId),
          eq(workbenchThreads.id, containerId),
        ),
      )
      .limit(1);
    return containerRows[0] ? mapThreadRow(containerRows[0]) : root;
  }

  async function selectReplyThread(
    tenantId: string,
    workbenchId: string,
    parentMessageId: string,
  ): Promise<WorkbenchThread | undefined> {
    const rows = await db
      .select()
      .from(workbenchThreads)
      .where(
        and(
          eq(workbenchThreads.tenantId, tenantId),
          eq(workbenchThreads.workbenchId, workbenchId),
          eq(workbenchThreads.kind, "reply"),
          eq(workbenchThreads.parentMessageId, parentMessageId),
        ),
      )
      .orderBy(asc(workbenchThreads.createdAt))
      .limit(1);
    return rows[0] ? mapThreadRow(rows[0]) : undefined;
  }

  async function anchoredReplyThread(
    input: OpenReplyThreadInput,
    mode: "reply" | "fork",
  ): Promise<WorkbenchThread> {
    const existing = await selectReplyThread(
      input.tenantId,
      input.workbenchId,
      input.parentMessageId,
    );
    if (existing) return existing;
    const root = await ensureRootThread(input.tenantId, input.workbenchId);
    const container = await containerThreadFor(
      input.tenantId,
      input.workbenchId,
      input.parentMessageId,
      root,
    );
    const anchor = resolveThreadAnchor(root, container);
    if (anchor.blocked && mode === "reply") throw new ThreadDepthCapError();
    // Insert-first, not select-then-insert: two concurrent first
    // repliers to the same message both attempt the insert, the
    // partial unique index (tenant_id, workbench_id,
    // parent_message_id) WHERE kind = 'reply' serializes them, and
    // the loser's empty `returning()` re-selects the winner's row
    // rather than creating a duplicate reply thread.
    const id = newThreadId();
    const inserted = await db
      .insert(workbenchThreads)
      .values({
        id,
        tenantId: input.tenantId,
        workbenchId: input.workbenchId,
        kind: "reply",
        parentMessageId: input.parentMessageId,
        parentThreadId: anchor.parentThreadId,
        runRef: null,
        title: input.title ?? null,
      })
      .onConflictDoNothing({
        target: [
          workbenchThreads.tenantId,
          workbenchThreads.workbenchId,
          workbenchThreads.parentMessageId,
        ],
        where: eq(workbenchThreads.kind, "reply"),
      })
      .returning();
    const row = inserted[0];
    if (row) return mapThreadRow(row);
    const reselected = await selectReplyThread(
      input.tenantId,
      input.workbenchId,
      input.parentMessageId,
    );
    if (!reselected) {
      throw new Error(`expected ${mode} thread row after conflicting insert`);
    }
    return reselected;
  }

  async function selectDeliveryThread(
    tenantId: string,
    workbenchId: string,
    runRef: string,
  ): Promise<WorkbenchThread | undefined> {
    const rows = await db
      .select()
      .from(workbenchThreads)
      .where(
        and(
          eq(workbenchThreads.tenantId, tenantId),
          eq(workbenchThreads.workbenchId, workbenchId),
          eq(workbenchThreads.kind, "delivery"),
          eq(workbenchThreads.runRef, runRef),
        ),
      )
      .limit(1);
    return rows[0] ? mapThreadRow(rows[0]) : undefined;
  }

  return {
    ensureRootThread,

    async createDeliveryThread(input) {
      // Insert-first, not select-then-insert: two concurrent first
      // deliveries of the same run both attempt the insert, the
      // partial unique index (tenant_id, workbench_id, run_ref) WHERE
      // kind = 'delivery' AND run_ref IS NOT NULL serializes them, and
      // the loser's empty `returning()` re-selects the winner's row
      // rather than creating a duplicate delivery thread.
      const id = newThreadId();
      const inserted = await db
        .insert(workbenchThreads)
        .values({
          id,
          tenantId: input.tenantId,
          workbenchId: input.workbenchId,
          kind: "delivery",
          parentMessageId: null,
          parentThreadId: null,
          runRef: input.runRef,
          title: input.title ?? null,
        })
        .onConflictDoNothing({
          target: [
            workbenchThreads.tenantId,
            workbenchThreads.workbenchId,
            workbenchThreads.runRef,
          ],
          // Matches `workbench_threads_delivery_key`'s predicate in
          // ./schema.ts exactly — the ON CONFLICT arbiter predicate
          // must match the partial index's own predicate, not just be
          // implied by it.
          where: sql`${workbenchThreads.kind} = 'delivery' AND ${workbenchThreads.runRef} IS NOT NULL`,
        })
        .returning();
      const row = inserted[0];
      if (row) return mapThreadRow(row);
      const reselected = await selectDeliveryThread(
        input.tenantId,
        input.workbenchId,
        input.runRef,
      );
      if (!reselected) {
        throw new Error(
          "expected delivery thread row after conflicting insert",
        );
      }
      return reselected;
    },

    openReplyThread: (input) => anchoredReplyThread(input, "reply"),
    forkThread: (input) => anchoredReplyThread(input, "fork"),

    async getThread(tenantId, threadId) {
      const rows = await db
        .select()
        .from(workbenchThreads)
        .where(
          and(
            eq(workbenchThreads.tenantId, tenantId),
            eq(workbenchThreads.id, threadId),
          ),
        )
        .limit(1);
      return rows[0] ? mapThreadRow(rows[0]) : undefined;
    },

    async listThreads(tenantId, workbenchId) {
      const rows = await db
        .select()
        .from(workbenchThreads)
        .where(
          and(
            eq(workbenchThreads.tenantId, tenantId),
            eq(workbenchThreads.workbenchId, workbenchId),
          ),
        )
        .orderBy(asc(workbenchThreads.createdAt));
      return rows.map(mapThreadRow);
    },

    async assignMessage(input) {
      await db
        .insert(workbenchThreadMessages)
        .values({
          tenantId: input.tenantId,
          workbenchId: input.workbenchId,
          threadId: input.threadId,
          messageId: input.messageId,
        })
        .onConflictDoNothing();
    },

    async listMessageIds(tenantId, threadId) {
      const rows = await db
        .select({ messageId: workbenchThreadMessages.messageId })
        .from(workbenchThreadMessages)
        .where(
          and(
            eq(workbenchThreadMessages.tenantId, tenantId),
            eq(workbenchThreadMessages.threadId, threadId),
          ),
        )
        .orderBy(asc(workbenchThreadMessages.createdAt));
      return rows.map((r) => r.messageId);
    },

    async threadIdForMessage(tenantId, workbenchId, messageId) {
      const rows = await db
        .select({ threadId: workbenchThreadMessages.threadId })
        .from(workbenchThreadMessages)
        .where(
          and(
            eq(workbenchThreadMessages.tenantId, tenantId),
            eq(workbenchThreadMessages.workbenchId, workbenchId),
            eq(workbenchThreadMessages.messageId, messageId),
          ),
        )
        .limit(1);
      return rows[0]?.threadId;
    },

    async listThreadAssignments(tenantId, workbenchId) {
      const rows = await db
        .select({
          messageId: workbenchThreadMessages.messageId,
          threadId: workbenchThreadMessages.threadId,
        })
        .from(workbenchThreadMessages)
        .where(
          and(
            eq(workbenchThreadMessages.tenantId, tenantId),
            eq(workbenchThreadMessages.workbenchId, workbenchId),
          ),
        );
      return new Map(rows.map((row) => [row.messageId, row.threadId]));
    },
  };
}

/**
 * Contract routines delivery uses: create (or reuse) a delivery thread
 * for a run in a workbench, then the launcher posts into that thread.
 */
export async function createDeliveryThread(
  store: ThreadStore,
  input: CreateDeliveryThreadInput,
): Promise<WorkbenchThread> {
  await store.ensureRootThread(input.tenantId, input.workbenchId);
  return store.createDeliveryThread(input);
}
