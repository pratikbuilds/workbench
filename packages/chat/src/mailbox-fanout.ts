// Fans a sent workbench message into every human participant's mailbox
// (CL-7450). A person's message already lands durably on the room's own
// timeline (`room-messages.ts`); this is the second, independent copy
// `@corbits/mailbox` keeps per human principal, addressed by the same
// RFC 5322 `Message-ID` the row was stamped with (`./mail-headers.ts`).
//
// Only human participants get a mailbox row — an agent's own inbox is its
// run's live mail queue, dispatched through `WorkbenchMail.sendMail`
// (`./platform-port.ts`), never this package's `@corbits/mailbox` mount.
// `mentions.ts`'s `isAgentAddress` is the same human/agent split the rest
// of this package already uses for fan-out.
//
// The write itself is behind the small `MailboxWriter` port below, not
// called against `@corbits/mailbox` directly: `writeChatMailboxFanout`'s
// own logic (who gets a row, which direction, what the shared Message-ID
// and refs are) is what this ticket is actually about, and it is
// unit-testable with an in-memory writer that never touches Postgres.
// `createDrizzleMailboxWriter` is the one production implementation, and
// is the only piece that needs a live `@corbits/mailbox` schema.
//
// Every recipient's row shares this row's own frame `messageId` — the
// caller-supplied `messageId` on every `writeMailboxMessages` item — so
// the stored frame's `Message-ID:` header, the cached
// `principal_mail.message_id` column, and the value a reply's
// `In-Reply-To` names all agree. Idempotency rides the package's own
// default transport key (`mailboxKey.transport`, direction-scoped) rather
// than a caller-minted one: nothing here has a reason to override it.
//
// The whole fan-out is ONE batch, written in ONE transaction
// (`@corbits/mailbox`'s `writeMailboxMessages`): a failure partway
// through never leaves some recipients delivered and others missing, and
// a retry after a genuine failure simply re-attempts every row (none of
// which committed). No fallback: a write that fails is reported through
// `reportError` and rethrown — never swallowed into a partially-delivered
// send that looks successful to its caller. A participant address this
// tenant has no principal for is a different, expected case (a stale or
// removed member) and is reported and skipped rather than failing the
// whole send; the sender's OWN principal missing from the row's tenant
// (a share member from another tenant, sending into the owning bench) is
// equally expected and is logged at debug rather than reported — see
// `writeChatMailboxFanout`'s doc comment.
import { getLogger } from "@intx/log";
import {
  writeMailboxMessages,
  type MailboxDb,
  type MailboxEventBus,
  type MailboxRef,
  type WriteMailboxMessagesItem,
} from "@corbits/mailbox";
import { reportError } from "@corbits/error-sink";
import { isAgentAddress } from "./mentions";
import type { ParticipantRecord } from "./participants";

const logger = getLogger(["chat", "mailbox-fanout"]);

/**
 * Thrown by `writeChatMailboxFanout` when its batch write fails. Carries
 * the `refId` its own `reportError` call already minted, so a caller that
 * turns this into a consumer-facing response quotes that same ref rather
 * than reporting the failure a second time under a different one — see
 * `routes.ts`'s send handler, which is the one place this is caught.
 */
export class MailboxFanoutFailedError extends Error {
  readonly refId: string;
  constructor(refId: string, options?: { cause?: unknown }) {
    super("mailbox fan-out failed", options);
    this.name = "MailboxFanoutFailedError";
    this.refId = refId;
  }
}

/** One recipient's row within a fan-out batch. */
export type MailboxBatchItem = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly address: string;
  readonly fromAddress: string;
  readonly subject: string;
  readonly body: string;
  /** This row's own RFC 5322 `Message-ID` — the frame header, the
   * `principal_mail.message_id` cache column, and (barring a caller
   * override the batch never supplies) the transport idempotency key
   * all derive from this one value. */
  readonly messageId: string;
  readonly direction: "inbound" | "outbound";
  readonly inReplyTo?: string;
  /** The full ancestry chain, oldest first (`mailAncestryOf`) — what the
   * stored frame's `References:` header carries. Absent on a root-feed
   * row, which answers nothing. */
  readonly references?: readonly string[];
  readonly refs?: readonly MailboxRef[];
};

export type MailboxBatchResult = {
  readonly messageKey: string;
  readonly id: string | null;
};

/**
 * The write seam `writeChatMailboxFanout` calls through — an entire
 * conversation turn's mailbox rows as ONE transaction. Split from
 * `@corbits/mailbox`'s own call surface so this package's fan-out LOGIC
 * (who gets a row, which direction, the shared Message-ID and refs) is
 * unit-testable against an in-memory fake, with only
 * `createDrizzleMailboxWriter` below needing a live database.
 */
export interface MailboxWriter {
  /**
   * Writes every item in one transaction — `@corbits/mailbox`'s
   * `writeMailboxMessages` semantics: a throw from any item rolls back
   * the whole batch, and a per-item `messageKey` collision (retry
   * idempotency) is a no-op for that item, not a rollback trigger.
   * Returns one result per item, in item order.
   */
  writeBatch(
    items: readonly MailboxBatchItem[],
  ): Promise<readonly MailboxBatchResult[]>;
}

/** The production `MailboxWriter`: a thin pass-through onto
 * `@corbits/mailbox`'s own `writeMailboxMessages` batch call — no
 * hand-rolled inserts against the package's schema. */
export function createDrizzleMailboxWriter(
  db: MailboxDb,
  bus?: MailboxEventBus,
): MailboxWriter {
  return {
    async writeBatch(items) {
      const batch: WriteMailboxMessagesItem[] = items.map((item) => ({
        scope: { tenantId: item.tenantId, principalId: item.principalId },
        args: {
          address: item.address,
          fromAddress: item.fromAddress,
          subject: item.subject,
          body: item.body,
          messageId: item.messageId,
          direction: item.direction,
          ...(item.inReplyTo !== undefined
            ? { inReplyTo: item.inReplyTo }
            : {}),
          ...(item.references !== undefined && item.references.length > 0
            ? { references: [...item.references] }
            : {}),
          ...(item.refs !== undefined ? { refs: [...item.refs] } : {}),
        },
      }));
      return writeMailboxMessages(db, batch, bus !== undefined ? { bus } : {});
    },
  };
}

export type MailboxFanoutDeps = {
  readonly writer: MailboxWriter;
  /**
   * The subset of `candidateIds` that name a real principal in
   * `tenantId` — the host's own control-plane check (Interchange's
   * `principal` table). A participant address whose principal this
   * returns nothing for is reported and skipped rather than attempted:
   * `@corbits/mailbox`'s FK would refuse the insert anyway, but as a
   * database error deep in a transaction rather than a name a person
   * reading the report can act on.
   */
  readonly resolveKnownPrincipalIds: (
    tenantId: string,
    candidateIds: readonly string[],
  ) => Promise<ReadonlySet<string>>;
  /**
   * The mail domain rows in `tenantId` are addressed under. Always the
   * ROW'S OWN tenant (the workbench's owning bench, `ownerTenantId` in
   * `routes.ts` terms) — never the caller's acting tenant, which for a
   * shared-workbench (projected-tenant) sender can differ. Every
   * recipient's address, including the sender's own, uses this domain.
   */
  readonly resolveTenantDomain: (tenantId: string) => Promise<string>;
};

export type WriteChatMailboxFanoutInput = {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly senderAddress: string;
  readonly senderPrincipalId: string;
  readonly participants: readonly ParticipantRecord[];
  /** This row's own RFC 5322 `Message-ID` (`mailMessageIdFor`), already
   * minted against the row's OWNING tenant's domain. */
  readonly messageId: string;
  readonly inReplyTo?: string;
  /** The full ancestry chain, oldest first — see `MailboxBatchItem`'s own
   * doc comment. */
  readonly references?: readonly string[];
  readonly subject: string;
  readonly body: string;
};

/** The human participants of a workbench, by their bare principal id —
 * a human's own participant address is never suffixed with a domain
 * (see `workbench-service.ts`'s member-add path), unlike an agent's. */
function humanPrincipalIds(
  participants: readonly ParticipantRecord[],
): readonly string[] {
  return participants
    .filter((participant) => !isAgentAddress(participant.address))
    .map((participant) => participant.address);
}

/**
 * Writes the sent message into every human participant's mailbox: an
 * "outbound" copy in the sender's own, an "inbound" copy in every other
 * human's, all sharing this row's Message-ID and its workbench ref, as
 * ONE batch (`MailboxWriter.writeBatch`) — one transaction, all rows or
 * none. Throws when the batch itself fails — the caller must not report
 * the send as fully delivered when it wasn't.
 *
 * The sender's own principal missing from `tenantId` (rows for a shared
 * workbench live in the OWNING tenant; a share member sending from a
 * projected tenant may have no principal row there at all) is expected,
 * not an error: the sender's own copy is skipped quietly, at debug, and
 * every other human participant still gets their row. Any OTHER
 * participant missing a known principal (a stale or removed member) is
 * reported and skipped the way it always was.
 */
export async function writeChatMailboxFanout(
  deps: MailboxFanoutDeps,
  input: WriteChatMailboxFanoutInput,
): Promise<void> {
  const domain = await deps.resolveTenantDomain(input.tenantId);

  const candidateIds = new Set(humanPrincipalIds(input.participants));
  candidateIds.add(input.senderPrincipalId);
  const candidateList = [...candidateIds];

  const known = await deps.resolveKnownPrincipalIds(
    input.tenantId,
    candidateList,
  );

  const refs: MailboxRef[] = [{ kind: "workbench", id: input.workbenchId }];
  const batch: MailboxBatchItem[] = [];

  for (const principalId of candidateList) {
    if (!known.has(principalId)) {
      if (principalId === input.senderPrincipalId) {
        logger.debug(
          "sender {principalId} has no principal in the row's tenant " +
            "{tenantId} (a share member sending into a bench it does not " +
            "belong to); skipping its own mailbox copy",
          { principalId, tenantId: input.tenantId },
        );
        continue;
      }
      reportError(new Error(`no principal "${principalId}" in tenant`), {
        operation: "chat.mailboxFanout.resolveParticipant",
        tenantId: input.tenantId,
        roomId: input.workbenchId,
        extra: { principalId },
      });
      continue;
    }

    const address = `${principalId}@${domain}`;
    batch.push({
      tenantId: input.tenantId,
      principalId,
      address,
      fromAddress: input.senderAddress,
      subject: input.subject,
      body: input.body,
      messageId: input.messageId,
      direction:
        principalId === input.senderPrincipalId ? "outbound" : "inbound",
      refs,
      ...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo } : {}),
      ...(input.references !== undefined && input.references.length > 0
        ? { references: input.references }
        : {}),
    });
  }

  if (batch.length === 0) return;

  try {
    await deps.writer.writeBatch(batch);
  } catch (err) {
    const refId = reportError(err, {
      operation: "chat.mailboxFanout.write",
      tenantId: input.tenantId,
      roomId: input.workbenchId,
      extra: { messageId: input.messageId },
    });
    throw new MailboxFanoutFailedError(refId, { cause: err });
  }
}

/** A plain-text rendering of a message's parts, for the mailbox frame's
 * body — the same set of `TextPart`s a mention scan reads, joined the
 * way a person would read the message top to bottom. A message with no
 * text at all (attachment-only) falls back to listing its parts, so a
 * mailbox copy of a file share is never a blank body. */
export function mailboxBodyOf(
  parts: readonly { kind: string; text?: string; name?: string }[],
): string {
  const textParts = parts
    .filter(
      (part): part is { kind: "text"; text: string } =>
        part.kind === "text" && typeof part.text === "string",
    )
    .map((part) => part.text);
  if (textParts.length > 0) return textParts.join("\n\n");

  const attachments = parts
    .filter(
      (part): part is { kind: "file"; name: string } =>
        part.kind === "file" && typeof part.name === "string",
    )
    .map((part) => `Attachment: ${part.name}`);
  return attachments.join("\n");
}

/** A short subject line derived from a message's body: its first line,
 * clipped to a conventional mail-subject length. Applies equally to an
 * attachment-only body (`mailboxBodyOf`'s "Attachment: <name>" lines),
 * so a file share gets a real subject rather than "(no subject)". */
export function mailboxSubjectOf(body: string): string {
  const firstLine = body.split("\n")[0]?.trim() ?? "";
  const MAX_SUBJECT_LENGTH = 78;
  return firstLine.length > MAX_SUBJECT_LENGTH
    ? `${firstLine.slice(0, MAX_SUBJECT_LENGTH - 1)}…`
    : firstLine || "(no subject)";
}
