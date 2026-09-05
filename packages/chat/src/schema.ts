// Product tables @corbits/chat owns (see scripts/checks/no-product-tenancy
// ALLOWLIST): workbench_settings, workbench_read_state, workbench_launch,
// workbench_tenancy, message_reactions, and pinned_messages. These tables
// live in their own `chat` Postgres schema,
// fully siloed from the platform's `public` schema — see
// docs/package-migrations.md. `tenantId`/`principalId` are plain text
// identifiers, not foreign keys, so referencing platform tenant/principal
// ids works identically from a named schema.
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const chatSchema = pgSchema("chat");

/**
 * Settings for a single workbench, record-as-truth: `settings` is a
 * namespaced jsonb blob (`"chat/..."` keys plus extension namespaces)
 * rather than a column per setting, so new settings never require a
 * migration.
 */
export const workbenchSettings = chatSchema.table(
  "workbench_settings",
  {
    tenantId: text("tenant_id").notNull(),
    workbenchId: text("workbench_id").notNull(),
    settings: jsonb("settings").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.workbenchId] })],
);

/**
 * Bench-wide chat defaults — one row per tenant, the same
 * record-as-truth jsonb shape as `workbenchSettings` (a `"chat/..."`
 * namespaced blob rather than a column per setting). A workbench with no
 * override for a given key inherits its value from here; see
 * `resolveContextWindow` in `./workbench-settings.ts` for how the two are
 * folded into one effective value.
 */
export const chatBenchSettings = chatSchema.table("chat_bench_settings", {
  tenantId: text("tenant_id").primaryKey(),
  settings: jsonb("settings").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Per-principal read cursor for a workbench — humans and agents alike,
 * since both are principals on the platform. `workbenchId` is the
 * workflow-run/instance id that identifies the workbench.
 */
export const workbenchReadState = chatSchema.table(
  "workbench_read_state",
  {
    tenantId: text("tenant_id").notNull(),
    workbenchId: text("workbench_id").notNull(),
    principalId: text("principal_id").notNull(),
    lastSeenCreatedAt: timestamp("last_seen_created_at", {
      withTimezone: true,
    }).notNull(),
    lastSeenId: text("last_seen_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.workbenchId, table.principalId],
    }),
  ],
);

/**
 * The folded launch body of every instance this package launches —
 * one row per invited agent — written in the launch transaction and
 * read back to wake a slept instance without reaching for the
 * definition's asset.
 *
 * This row is also the address→run mapping the whole room depends on.
 * `instanceId` is the STABLE participant id — the id an invited agent
 * was first minted under — and
 * `formatRunAddress(instanceId, domain)` is the address the room
 * addresses this agent by forever (participant records, message
 * `senderAddress`, mention handles). `currentRunId` is the run actually
 * executing behind it. The two are equal until the first relaunch;
 * after a run dies terminally (a mid-turn crash), `currentRunId` is
 * re-pointed at a FRESH run with a fresh id, a fresh address, and a
 * fresh durable event log, while the stable id — and therefore the
 * room, its timeline, its settings, and every participant record —
 * does not move. See `./agent-binding.ts`.
 */
export const workbenchLaunch = chatSchema.table("workbench_launch", {
  tenantId: text("tenant_id").notNull(),
  instanceId: text("instance_id").primaryKey(),
  /**
   * The live `workflow_run.id` this stable id currently resolves to.
   * Unique: one run backs at most one room participant.
   */
  currentRunId: text("current_run_id").notNull().unique(),
  /**
   * Every run that used to be `currentRunId`, oldest first. A relaunch
   * mints a fresh run with its own principal, and a folded run's mail
   * session is resolved from its principal — so an attachment a reader
   * uploaded before the crash lives on a session the live run cannot
   * see. This is the trail `fetchBlob` walks back through so a blob
   * posted to the room yesterday is still downloadable today.
   */
  priorRunIds: jsonb("prior_run_ids").notNull().default([]),
  foldedBody: jsonb("folded_body").notNull(),
  /**
   * `@corbits/folded-runs`' `inferenceSourcesDigest` of the chain the
   * current run last deployed with — secret included, hashed. A send
   * compares it against today's resolution so a rotated API key
   * reaches a live agent (CL-6687); `null` until the run's first
   * deploy, and for rows that predate the column.
   */
  sourcesDigest: text("sources_digest"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * The parent↔child link between a bench and the native tenant a
 * workbench was minted as (see `./workbench-tenancy.ts`). No native
 * child-tenant listing route exists upstream (`parentId` is stored on
 * `tenant` but never queried by any hub-api route), so this table is
 * the honest source for "which workbenches are child tenancies of this
 * bench" — chat owns it rather than leaving the question unanswerable.
 * `tenantId` is unique: a workbench tenant is minted for exactly one
 * workbench, never shared.
 */
export const workbenchTenancy = chatSchema.table("workbench_tenancy", {
  workbenchId: text("workbench_id").primaryKey(),
  tenantId: text("tenant_id").notNull().unique(),
  parentTenantId: text("parent_tenant_id").notNull(),
  slug: text("slug").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Every message posted into a workbench — the room's own timeline
 * (CL-6327). A message is a row here and nowhere else: posting one is a
 * single insert plus a publish onto the workbench's live stream, with no
 * mail, no wake, and no sidecar hop on the write path. `parts` is the
 * decoded `Part[]` a client renders directly (see `./parts.ts`), so
 * reading the timeline is a query rather than a decode of someone else's
 * envelope.
 *
 * `senderPrincipalId` is set for a human's own message and null for an
 * agent's (an agent posts under its run's address); `runId` names the
 * agent run a message came out of, null for anything a human wrote.
 */
export const workbenchMessages = chatSchema.table(
  "workbench_messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workbenchId: text("workbench_id").notNull(),
    senderAddress: text("sender_address").notNull(),
    senderName: text("sender_name"),
    senderPrincipalId: text("sender_principal_id"),
    runId: text("run_id"),
    threadId: text("thread_id"),
    /**
     * The RFC 5322 `Message-ID` this row went out as when it was
     * dispatched to an agent (CL-7104) — `<id@domain>`, derived from the
     * row's own primary key and stamped once at dispatch. Null for a row
     * that was never dispatched as mail (a join notice, an event, a
     * message nobody was asked to answer).
     */
    mailMessageId: text("mail_message_id"),
    parts: jsonb("parts").notNull(),
    // Millisecond precision, not the default microsecond: a cursor is a
    // JS `Date` rendered to an ISO string, which carries milliseconds
    // and nothing finer. Stored any finer, a keyset page's `created_at =
    // cursor` tie-break could never match and a message sharing a
    // millisecond with the cursor row would fall out of the timeline
    // between pages.
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("workbench_messages_feed_idx").on(
      table.tenantId,
      table.workbenchId,
      table.createdAt,
    ),
  ],
);

/**
 * A thread inside a workbench. The root feed is the thread with
 * `kind = 'root'` (one per workbench). Reply threads hang off a parent
 * message id; delivery threads hang off a routine run ref. Messages
 * themselves live in `workbenchMessages` — this table is workbench
 * thread identity only (see `./threads.ts`).
 */
export const workbenchThreads = chatSchema.table(
  "workbench_threads",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workbenchId: text("workbench_id").notNull(),
    /** root | reply | delivery */
    kind: text("kind").notNull(),
    /** Message id this reply thread answers; null for root/delivery. */
    parentMessageId: text("parent_message_id"),
    /**
     * The thread this one hangs directly off: null for the root
     * thread, the root thread's id for a depth-1 thread, a depth-1
     * thread's id for a depth-2 sub-thread. Two levels, stop — see
     * `resolveThreadAnchor` in `./threads.ts`.
     */
    parentThreadId: text("parent_thread_id"),
    /** Routine/run reference for delivery threads; null otherwise. */
    runRef: text("run_ref"),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("workbench_threads_workbench_idx").on(
      table.tenantId,
      table.workbenchId,
    ),
    uniqueIndex("workbench_threads_root_key")
      .on(table.tenantId, table.workbenchId)
      .where(sql`${table.kind} = 'root'`),
    uniqueIndex("workbench_threads_reply_key")
      .on(table.tenantId, table.workbenchId, table.parentMessageId)
      .where(sql`${table.kind} = 'reply'`),
    // `run_ref` is nullable (root/reply rows never set it), and a
    // partial unique index treats NULLs as distinct rather than equal
    // — so the predicate excludes them explicitly rather than relying
    // on every delivery-thread caller to always supply one.
    uniqueIndex("workbench_threads_delivery_key")
      .on(table.tenantId, table.workbenchId, table.runRef)
      .where(sql`${table.kind} = 'delivery' AND ${table.runRef} IS NOT NULL`),
  ],
);

/**
 * Membership of a platform mail message id in a thread. A message
 * belongs to exactly one thread (root feed by default).
 */
export const workbenchThreadMessages = chatSchema.table(
  "workbench_thread_messages",
  {
    tenantId: text("tenant_id").notNull(),
    workbenchId: text("workbench_id").notNull(),
    threadId: text("thread_id").notNull(),
    messageId: text("message_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.workbenchId, table.messageId],
    }),
    index("workbench_thread_messages_thread_idx").on(
      table.tenantId,
      table.threadId,
    ),
  ],
);

/**
 * One workbench's projection into a sibling tenant (CL-5882's
 * Slack-Connect-style shared workbenches). The owning tenant is never
 * inferable from `workbenchId` alone (a workbench's own tenancy lives in
 * `workbenchTenancy`/`workbench_settings`, not here), so it's carried
 * explicitly — `getShare`/`listSharesForWorkbench` in `./workbench-share.ts`
 * always take it rather than re-deriving it. A row here is created only
 * after `FederationTrustStore.hasBilateralTrust` passes (see
 * `./workbench-share.ts`'s `createShare`); this table records that a
 * projection *exists*, never that trust does — trust can later be
 * revoked without cascading a delete here (see `docs/TENANCY.md`).
 */
export const workbenchShare = chatSchema.table(
  "workbench_share",
  {
    owningTenantId: text("owning_tenant_id").notNull(),
    workbenchId: text("workbench_id").notNull(),
    projectedTenantId: text("projected_tenant_id").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workbenchId, table.projectedTenantId] }),
    index("workbench_share_projected_idx").on(table.projectedTenantId),
  ],
);

/**
 * Which principals of a projected tenant can actually see a shared
 * workbench — a share never auto-adds anyone (see `docs/TENANCY.md`'s
 * scope boundary): each side's own admin explicitly adds their own
 * principals here via `POST /workbenches/:id/share-members`, fully
 * separate from the owning tenant's own `chat/participants`. Scoped by
 * `projectedTenantId` first (matching the primary access question,
 * "can this caller, in this tenant, see this workbench") so two tenants
 * sharing the same workbench keep fully independent membership.
 */
export const workbenchShareMember = chatSchema.table(
  "workbench_share_member",
  {
    projectedTenantId: text("projected_tenant_id").notNull(),
    workbenchId: text("workbench_id").notNull(),
    principalId: text("principal_id").notNull(),
    addedBy: text("added_by").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.projectedTenantId, table.workbenchId, table.principalId],
    }),
  ],
);

/**
 * One poll/form response per principal per block, upsert-on-repeat (see
 * `./block-responses.ts`). `blockId` is the agent-authored `pollId`/`formId`
 * — never unique on its own — so every row is additionally scoped by
 * `messageId`: the block this row answers is the one in *this specific*
 * message, never any other message that happens to reuse the same id.
 */
export const blockResponses = chatSchema.table(
  "block_responses",
  {
    tenantId: text("tenant_id").notNull(),
    workbenchId: text("workbench_id").notNull(),
    messageId: text("message_id").notNull(),
    blockId: text("block_id").notNull(),
    principalId: text("principal_id").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Question-only claim flag: null until a question's answer has been
    // sent into the workbench and its turn dispatched. See
    // `claimBlockResponseNotification` in `./block-responses.ts`.
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    // Scopes `releaseBlockResponseNotification` to the exact claim it
    // took, set together with `notifiedAt`, so a release can never
    // clobber a claim it does not hold. See `./block-responses.ts`.
    notificationClaimToken: text("notification_claim_token"),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.workbenchId,
        table.messageId,
        table.blockId,
        table.principalId,
      ],
    }),
    index("block_responses_block_idx").on(
      table.tenantId,
      table.workbenchId,
      table.messageId,
      table.blockId,
    ),
  ],
);

/**
 * One row per (tenant, workbench, message, emoji, principal) — a
 * principal either has reacted with a given emoji on a given message
 * or hasn't; there is no count column, the row's presence *is* the
 * count (see `./reactions.ts`'s `toggleReaction`, which inserts on a
 * miss and deletes on a hit — true toggle semantics, never an
 * increment/decrement counter that can drift from reality). The
 * natural composite key doubles as the anti-double-react guard: a
 * second `INSERT` for the same five columns can only ever be the same
 * toggle flipping back off.
 */
export const messageReactions = chatSchema.table(
  "message_reactions",
  {
    tenantId: text("tenant_id").notNull(),
    workbenchId: text("workbench_id").notNull(),
    messageId: text("message_id").notNull(),
    emoji: text("emoji").notNull(),
    principalId: text("principal_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.workbenchId,
        table.messageId,
        table.emoji,
        table.principalId,
      ],
    }),
    index("message_reactions_message_idx").on(
      table.tenantId,
      table.workbenchId,
      table.messageId,
    ),
  ],
);

/**
 * One row per pinned message — a message is pinned or it isn't, so
 * this is presence-as-truth the same way `messageReactions` is: no
 * `pinned: boolean` column anywhere, the row's existence is the pin.
 * `pinnedBy`/`pinnedAt` record who pinned it and when for the pinned
 * strip's byline; unpinning deletes the row outright rather than
 * soft-deleting it, since there is no history feature reading pin/unpin
 * churn today.
 */
export const pinnedMessages = chatSchema.table(
  "pinned_messages",
  {
    tenantId: text("tenant_id").notNull(),
    workbenchId: text("workbench_id").notNull(),
    messageId: text("message_id").notNull(),
    pinnedBy: text("pinned_by").notNull(),
    pinnedAt: timestamp("pinned_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.workbenchId, table.messageId],
    }),
    index("pinned_messages_workbench_idx").on(
      table.tenantId,
      table.workbenchId,
    ),
  ],
);

/**
 * One row per message, recording the client-generated send identity
 * (CL-6251) a composer submit carried on `POST .../messages` —
 * presence-as-truth the same way `messageReactions`/`pinnedMessages`
 * are, here recording which `clientId` a message id was sent under so
 * the sender's own optimistic bubble can reconcile with the confirmed
 * message by identity rather than content/timing.
 */
export const messageClientIds = chatSchema.table(
  "message_client_ids",
  {
    tenantId: text("tenant_id").notNull(),
    workbenchId: text("workbench_id").notNull(),
    messageId: text("message_id").notNull(),
    clientId: text("client_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.workbenchId, table.messageId],
    }),
  ],
);

/**
 * Durable redelivery-dedup claim for the finalized-turn write surfaces in
 * `./chat-orchestrator.ts` (CL-6039): `postFinalizedTurnMemoryEntries`,
 * `postFinalizedTurnArtifacts`, and `postDailyTranscriptDigest` each claim
 * a row here — via `INSERT ... ON CONFLICT DO NOTHING`, never
 * check-then-write — before doing their one write. A redelivered
 * `onTurnFinalized` (sidecar reconnect, hub restart replaying the event
 * collector) loses the claim race the second time and skips the write
 * outright, unlike `postedApprovalIds`/`ingestedWorkbenchDays` in
 * `chat-orchestrator.ts`, which are process-local `Set`s that reset on
 * restart. `surface` distinguishes the three call sites so a `memory`
 * claim and an `artifact` claim for the same turn never collide, and
 * `claimKey` is either the finalized turn's own `turnId` (memory/artifact)
 * or `"${workbenchId}:${date}"` (digest, folding in its former per-day
 * bound).
 */
export const finalizedTurnWriteClaim = chatSchema.table(
  "finalized_turn_write_claim",
  {
    tenantId: text("tenant_id").notNull(),
    surface: text("surface").notNull(),
    claimKey: text("claim_key").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.surface, table.claimKey],
    }),
  ],
);

/**
 * Which workbench message a dispatch mail answers (CL-6314): written by
 * the dispatch seam right after its send resolves, read by the reply
 * path when the agent's `message.run.started` bracket names that mail.
 * Insert-only — a second record for the same mail is a no-op (see
 * `turn-mail-correlation.ts`), so the primary key is the whole dedup
 * story and this table needs no other index.
 */
export const turnMailCorrelation = chatSchema.table(
  "turn_mail_correlation",
  {
    tenantId: text("tenant_id").notNull(),
    mailId: text("mail_id").notNull(),
    workbenchId: text("workbench_id").notNull(),
    sourceMessageId: text("source_message_id").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.mailId],
    }),
  ],
);

/**
 * The turn projection (CL-6329): one row per agent turn, opened by the
 * dispatch seam and closed when the turn settles. Traceability is a
 * product concern, so a room answers "which run produced this reply, and
 * how did that turn end" from its own rows rather than from the
 * execution plane's — the same shape gtm's event collector settled on.
 *
 * A turn's identity is (warm section run, occurrence). The workflow
 * runtime names an occurrence's child run `turn__<n>` and assigns `n`
 * sequentially per section run, so `child_run_id` here is exactly the id
 * the reply message's `run_id` carries. `section_run_id` is null until a
 * dispatch gets far enough to learn it.
 */
export const agentTurns = chatSchema.table(
  "agent_turns",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    workbenchId: text("workbench_id").notNull(),
    agentAddress: text("agent_address").notNull(),
    sectionRunId: text("section_run_id"),
    childRunId: text("child_run_id").notNull(),
    occurrence: integer("occurrence").notNull(),
    requestMessageIds: jsonb("request_message_ids").notNull(),
    replyMessageId: text("reply_message_id"),
    /** running | completed | failed */
    status: text("status").notNull(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_turns_workbench_idx").on(
      table.tenantId,
      table.workbenchId,
      table.startedAt,
    ),
    unique("agent_turns_occurrence_key").on(
      table.tenantId,
      table.workbenchId,
      table.agentAddress,
      table.occurrence,
    ),
  ],
);
