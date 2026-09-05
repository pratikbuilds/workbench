// The mail-path core shared by every folded-run send/list surface:
// signing and persisting a message into a run's mailbox, and walking
// that mailbox with keyset pagination. Sender identity
// (`fromWorkbenchId`/participant semantics, whose address a message is
// "from") is a caller concern — this module takes the from-address and
// raw content as plain inputs and never synthesizes one from a
// principal id.
import { and, desc, eq, lt, or } from "drizzle-orm";
import { sessionMail } from "@intx/db/schema";
import { parseMailToEmail } from "@intx/mime";
import type { CryptoProvider, MessageAttachment } from "@intx/types/runtime";
import type { FoldedRunsDeps, ListedFoldedMail, SentFoldedMail } from "./types";

const MAIL_PAGE_SIZE = 50;

export type SendFoldedMailParams = {
  tenantId: string;
  sessionId: string;
  /** The address the run being sent to. */
  agentAddress: string;
  /** The honest sender identity — never a run id or principal id synthesized into an address. */
  from: string;
  domain: string;
  content: string;
  attachments?: MessageAttachment[];
  replyTo?: string;
  /**
   * RFC 5322 threading (CL-7450): the caller's own `Message-ID` for this
   * send, and the ancestry a reply correlates back through. A caller that
   * owns an identity for what it is sending (a chat timeline row) supplies
   * these; absent, `messageId` falls back to `<{mailId}@{domain}>` and
   * `inReplyTo` falls back to the legacy `replyTo` mapping below.
   */
  messageId?: string;
  inReplyTo?: string;
  references?: readonly string[];
  cryptoProvider: CryptoProvider;
};

/**
 * The signing/delivery step: turns `params` into a signed MIME message
 * and hands it to the agent via `sessionService.sendUserMessage`
 * (vendor delivers synchronously). This is the only unsafe-to-repeat
 * side effect in `sendFoldedMail` — a second call for the same mailId
 * delivers a second, distinct message to the agent — so it is the only
 * part `sendFoldedMailWithRetry` below is allowed to retry.
 */
async function deliverFoldedMailMIME(
  deps: Pick<FoldedRunsDeps, "sessionService">,
  params: SendFoldedMailParams,
  mailId: string,
  now: Date,
): Promise<Uint8Array> {
  const userMessageParams = {
    agentAddress: params.agentAddress,
    from: params.from,
    messageId: params.messageId ?? `<${mailId}@${params.domain}>`,
    date: now,
    content: params.content,
    sessionId: params.sessionId,
    tenantId: params.tenantId,
    cryptoProvider: params.cryptoProvider,
  };
  const withAttachments =
    params.attachments !== undefined
      ? { ...userMessageParams, attachments: params.attachments }
      : userMessageParams;
  const inReplyTo = params.inReplyTo ?? params.replyTo;
  const withReplyTo =
    inReplyTo !== undefined
      ? { ...withAttachments, inReplyTo }
      : withAttachments;
  const withReferences =
    params.references !== undefined && params.references.length > 0
      ? { ...withReplyTo, references: [...params.references] }
      : withReplyTo;
  return deps.sessionService.sendUserMessage(withReferences);
}

/**
 * Persists an already-delivered message into the run's mailbox and
 * notifies the run's own live subscribers. Called exactly once per
 * delivered `mailId` — never retried — so a failure here can never
 * cause a second delivery.
 */
async function recordFoldedMail(
  deps: Pick<FoldedRunsDeps, "db" | "sidecarRouter">,
  params: SendFoldedMailParams,
  mailId: string,
  now: Date,
  rawMIME: Uint8Array,
): Promise<SentFoldedMail> {
  await deps.db.insert(sessionMail).values({
    id: mailId,
    sessionId: params.sessionId,
    runId: null,
    tenantId: params.tenantId,
    direction: "inbound",
    status: "delivered",
    raw: rawMIME,
    createdAt: now,
  });

  deps.sidecarRouter.dispatchAgentEvent(params.agentAddress, {
    type: "mail.delivered",
    data: {
      id: mailId,
      direction: "inbound",
      receivedAt: now.toISOString(),
    },
  });

  return { id: mailId, createdAt: now.toISOString() };
}

/**
 * Signs and persists one message into a folded run's mailbox, and
 * notifies the run's own live subscribers. `sendUserMessage` (the
 * signing/MIME step) and the `session_mail` row share one clock read
 * so the MIME `Date` header and the row's `createdAt` never disagree
 * by however long signing and serialization take.
 */
export async function sendFoldedMail(
  deps: Pick<FoldedRunsDeps, "db" | "sessionService" | "sidecarRouter">,
  params: SendFoldedMailParams,
): Promise<SentFoldedMail> {
  const mailId = crypto.randomUUID();
  const now = new Date();
  const rawMIME = await deliverFoldedMailMIME(deps, params, mailId, now);
  return recordFoldedMail(deps, params, mailId, now, rawMIME);
}

/** `sendFoldedMailWithRetry`'s default bound: one initial attempt plus two retries. */
export const DEFAULT_SEND_FOLDED_MAIL_ATTEMPTS = 3;

export type SendFoldedMailAttemptResult =
  | { ok: true; mail: SentFoldedMail }
  | { ok: false; error: unknown; attempts: number };

/**
 * `sendFoldedMail`, with only its delivery step retried a bounded
 * number of times against a transient failure (a sidecar hiccup, a
 * momentary DB blip), and never throwing — a caller mid-launch (a
 * routine fire, a webhook delivery) has already committed a real run;
 * a first-turn mail that still fails after every retry must not
 * un-launch that run or hide it from correlation. The caller decides
 * what "still failed" means for it (log with the run's own id, surface
 * a delivery-failed marker, ...); this function only bounds the retry
 * and reports the outcome.
 *
 * Delivery and the `session_mail` write are retried separately, on
 * purpose: once `deliverFoldedMailMIME` succeeds, the message has
 * already reached the agent, so `recordFoldedMail` runs exactly once
 * against that one delivered `mailId` — a write failure there is
 * reported as a failed attempt, never retried, so it can never trigger
 * a second, duplicate delivery.
 */
export async function sendFoldedMailWithRetry(
  deps: Pick<FoldedRunsDeps, "db" | "sessionService" | "sidecarRouter">,
  params: SendFoldedMailParams,
  maxAttempts: number = DEFAULT_SEND_FOLDED_MAIL_ATTEMPTS,
): Promise<SendFoldedMailAttemptResult> {
  const mailId = crypto.randomUUID();
  const now = new Date();

  let lastError: unknown;
  let attemptsUsed = 0;
  let rawMIME: Uint8Array | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsUsed = attempt;
    try {
      rawMIME = await deliverFoldedMailMIME(deps, params, mailId, now);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (rawMIME === undefined) {
    return { ok: false, error: lastError, attempts: attemptsUsed };
  }

  try {
    const mail = await recordFoldedMail(deps, params, mailId, now, rawMIME);
    return { ok: true, mail };
  } catch (err) {
    return { ok: false, error: err, attempts: attemptsUsed };
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: createdAt.toISOString(), id }),
  ).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const parsed = JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf-8"),
  ) as {
    createdAt: string;
    id: string;
  };
  return { createdAt: new Date(parsed.createdAt), id: parsed.id };
}

export type ListFoldedMailParams = {
  tenantId: string;
  sessionId: string;
  cursor?: string;
};

/**
 * Keyset pagination on the same `(createdAt, id)` key the
 * newest-first ordering sorts by: a cursor names the last row the
 * caller has already seen, and this walks strictly older than it —
 * `createdAt < cursor.createdAt`, or a tie broken by `id < cursor.id`
 * — rather than re-fetching the newest page and searching for the
 * cursor inside it, which only ever finds it on page one.
 */
export async function listFoldedMail(
  deps: Pick<FoldedRunsDeps, "db">,
  params: ListFoldedMailParams,
): Promise<ListedFoldedMail> {
  const scope = and(
    eq(sessionMail.tenantId, params.tenantId),
    eq(sessionMail.sessionId, params.sessionId),
  );
  const cursor =
    params.cursor === undefined ? undefined : decodeCursor(params.cursor);
  const where =
    cursor === undefined
      ? scope
      : and(
          scope,
          or(
            lt(sessionMail.createdAt, cursor.createdAt),
            and(
              eq(sessionMail.createdAt, cursor.createdAt),
              lt(sessionMail.id, cursor.id),
            ),
          ),
        );

  const rows = await deps.db
    .select()
    .from(sessionMail)
    .where(where)
    .orderBy(desc(sessionMail.createdAt), desc(sessionMail.id))
    .limit(MAIL_PAGE_SIZE + 1);

  const hasMore = rows.length > MAIL_PAGE_SIZE;
  const page = rows.slice(0, MAIL_PAGE_SIZE);
  const items = page.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    mail: parseMailToEmail(row.raw, row.id),
  }));

  const last = page.length > 0 ? page[page.length - 1] : undefined;
  return hasMore && last !== undefined
    ? { items, nextCursor: encodeCursor(last.createdAt, last.id) }
    : { items };
}
