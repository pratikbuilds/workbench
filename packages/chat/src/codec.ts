import { type } from "arktype";
import { type Part, parsePart } from "./parts";

// The platform's mail-send contract accepts plain text plus a flat list
// of MIME attachments (`{ mimeType, data, name }`, `data` base64-encoded)
// — see the `SendMessage` request schema and `MessageAttachment` shape
// the hub's mail routes validate against. The platform's MIME allowlist
// rejects unknown `application/vnd.*` types, so every non-text part rides
// as `application/json`; a lone `TextPart` needs no attachment at all and
// travels as plain `content`, the simplest shape the platform accepts.
//
// This is the *send* shape only. Reading mail back (list/read endpoints)
// returns a differently-shaped, JMAP-style response — see `decodeMail`
// below for that side of the contract.

export type MailContent = {
  content: string;
  attachments?: {
    mimeType: string;
    data: string;
    name?: string;
  }[];
  /**
   * Set when this mail is a mention fan-out copy: the id of the
   * workbench the message originated in, carried as a reply-to
   * reference rather than a relay hop. Absent on ordinary mail,
   * including everything sent directly to a workbench's own anchor.
   */
  replyTo?: string;
  /**
   * RFC 5322 threading headers for the dispatched frame (CL-7450): the
   * row's own `Message-ID` and the ancestry a reply correlates back
   * through. `mailThreadHeaders` in `./mail-headers.ts` builds these from
   * `mailAncestryOf`; absent on mail with no chat-row identity of its own.
   */
  messageId?: string;
  inReplyTo?: string;
  references?: readonly string[];
};

function encodeBase64(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64");
}

function decodeBase64(data: string): string {
  return Buffer.from(data, "base64").toString("utf-8");
}

/**
 * Encode a `Part[]` into the platform mail content shape. A message
 * consisting of exactly one `TextPart` encodes to bare `content`, with no
 * attachments — the simplest form the platform accepts. Every other case
 * (multiple parts, or a single non-text part) encodes each part as an
 * attachment, in order: `TextPart`s ride `text/plain` with their raw text
 * as the attachment body; every other kind rides `application/json` with
 * the part's JSON as the attachment body. `content` itself carries no
 * information in this case and is left empty.
 */
export function encodeParts(
  parts: Part[],
  opts?: {
    replyTo?: string;
    messageId?: string;
    inReplyTo?: string;
    references?: readonly string[];
  },
): MailContent {
  const replyTo = opts?.replyTo;
  const threading = {
    ...(opts?.messageId !== undefined ? { messageId: opts.messageId } : {}),
    ...(opts?.inReplyTo !== undefined ? { inReplyTo: opts.inReplyTo } : {}),
    ...(opts?.references !== undefined && opts.references.length > 0
      ? { references: opts.references }
      : {}),
  };

  if (parts.length === 1 && parts[0]?.kind === "text") {
    const base = { content: parts[0].text, ...threading };
    return replyTo !== undefined ? { ...base, replyTo } : base;
  }

  const attachments = parts.map((part, index) => {
    if (part.kind === "text") {
      return {
        mimeType: "text/plain",
        data: encodeBase64(part.text),
        name: `part-${index}.txt`,
      };
    }
    return {
      mimeType: "application/json",
      data: encodeBase64(JSON.stringify(part)),
      name: `part-${index}.json`,
    };
  });

  const base = { content: "", attachments, ...threading };
  return replyTo !== undefined ? { ...base, replyTo } : base;
}

/**
 * Decode the platform mail content shape back into a `Part[]`. Mail with
 * no attachments is bare text — either a chat-authored single `TextPart`
 * round-tripping through `encodeParts`, or mail authored by a non-chat
 * sender — and decodes to a single `TextPart` either way, which is
 * defined behavior rather than a fallback. Mail with attachments decodes
 * each one back to its part, rejecting anything that is not a `text/plain`
 * or `application/json` attachment, or whose `application/json` body is
 * not valid JSON or not a structurally valid `Part`.
 */
export function decodeParts(mail: MailContent): Part[] {
  if (mail.attachments === undefined || mail.attachments.length === 0) {
    return [{ kind: "text", text: mail.content }];
  }

  return mail.attachments.map((attachment, index) => {
    if (attachment.mimeType === "text/plain") {
      return parsePart({ kind: "text", text: decodeBase64(attachment.data) });
    }
    if (attachment.mimeType === "application/json") {
      let json: unknown;
      try {
        json = JSON.parse(decodeBase64(attachment.data));
      } catch (err) {
        throw new Error(
          `mail attachment ${index} (${attachment.name ?? "unnamed"}) is not valid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
      return parsePart(json);
    }
    throw new Error(
      `mail attachment ${index} (${attachment.name ?? "unnamed"}) has unsupported MIME type "${attachment.mimeType}"; expected "text/plain" or "application/json"`,
    );
  });
}

// The shape the platform's mail read path (list/read endpoints) actually
// returns: a JMAP-style Email. Body text lives in `bodyValues`, addressed
// by the `partId`s named in `textBody`; attachments are references
// (`blobId`, `name`, `type`, `size`) into blob storage, never inline
// bytes — a caller fetches each blob's bytes separately. Only the fields
// the codec needs are modeled here; the platform's response carries more
// (sender/recipient envelope, headers, timestamps) that chat parts don't
// need to round-trip.
const MailReadContent = type({
  textBody: type({ partId: "string", type: "string" }).array(),
  bodyValues: "Record<string, unknown>",
  attachments: type({
    blobId: "string",
    "name?": "string | null",
    type: "string",
    size: "number",
  }).array(),
  "from?": type({ name: "string | null", email: "string" }).array(),
});
export type MailReadContent = typeof MailReadContent.infer;

export type MailSender = {
  readonly name: string | null;
  readonly address: string;
};

/**
 * Derives the sender identity off the platform's JMAP `from` envelope —
 * the counterpart to `decodeMail` that surfaces who sent a message
 * rather than what it contains. `from` always carries at least one
 * entry for real mail (chat-authored or otherwise); a mail read shape
 * with no `from` at all is a broken invariant, not a normal state, so
 * this throws loudly rather than fabricating an anonymous sender.
 */
export function senderOf(mail: unknown): MailSender {
  const parsed = MailReadContent(mail);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid mail read content: ${parsed.summary}`);
  }
  const from = parsed.from?.[0];
  if (from === undefined) {
    throw new Error('mail carries no envelope "from" to derive a sender from');
  }
  return { name: from.name, address: from.email };
}

const PREVIEW_MAX_LENGTH = 80;

/**
 * A bounded, best-effort preview snippet for a workbench-list row: the
 * message's plain text, whitespace-collapsed and truncated to
 * `PREVIEW_MAX_LENGTH` characters. Text parts only — an attachment-only
 * message (a file, a structured block) previews as empty rather than a
 * fabricated "[attachment]" placeholder, and a mail shape this can't
 * parse previews as empty too, since this is list-row decoration, never
 * the message content path itself (that's `decodeMail`, which throws
 * loudly on the same malformed input).
 */
export function extractTextPreview(mail: unknown): string {
  const parsed = MailReadContent(mail);
  if (parsed instanceof type.errors) return "";

  const segments: string[] = [];
  for (const body of parsed.textBody) {
    const value = BodyValue(parsed.bodyValues[body.partId]);
    if (!(value instanceof type.errors) && value.value.length > 0) {
      segments.push(value.value);
    }
  }

  const text = segments.join(" ").replace(/\s+/g, " ").trim();
  return text.length > PREVIEW_MAX_LENGTH
    ? `${text.slice(0, PREVIEW_MAX_LENGTH).trimEnd()}…`
    : text;
}

const BodyValue = type({ value: "string" });

/**
 * Fetches the bytes of a blob referenced by an attachment's `blobId`
 * (`GET /:instanceId/blobs/:blobId` on the platform). Returns either
 * decoded text or raw bytes; `decodeMail` accepts either.
 */
export type FetchBlob = (blobId: string) => Promise<string | Uint8Array>;

function blobToText(blob: string | Uint8Array): string {
  return typeof blob === "string" ? blob : Buffer.from(blob).toString("utf-8");
}

/**
 * Decode the platform's JMAP-shaped mail read content into a `Part[]`.
 * This is the counterpart to `decodeParts` for the read path: a route
 * that lists or fetches mail gets back this shape, not `MailContent`.
 *
 * Text carried in `textBody`/`bodyValues` becomes a `TextPart` (skipped
 * if empty, so an attachment-only message doesn't gain a spurious blank
 * part). Each attachment is resolved by MIME type: `application/json`
 * attachments are fetched and parsed as a structured `Part` (throwing
 * loudly on malformed JSON or a JSON body that isn't a valid `Part`);
 * `text/plain` attachments are fetched and become a `TextPart`; every
 * other MIME type becomes a `FilePart` carrying the `blobId` without
 * fetching its bytes, so large files are never pulled into memory just
 * to decode a message list.
 */
export async function decodeMail(
  mail: unknown,
  opts: { fetchBlob: FetchBlob },
): Promise<Part[]> {
  const parsed = MailReadContent(mail);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid mail read content: ${parsed.summary}`);
  }

  const parts: Part[] = [];

  for (const body of parsed.textBody) {
    const rawValue = parsed.bodyValues[body.partId];
    const value = BodyValue(rawValue);
    if (value instanceof type.errors) {
      throw new Error(
        `mail body part "${body.partId}" has no textual value in bodyValues: ${value.summary}`,
      );
    }
    if (value.value.length > 0) {
      parts.push({ kind: "text", text: value.value });
    }
  }

  /**
   * Compensates for a defect in the platform's MIME part extraction: the
   * blob route returns a leaf attachment's raw MIME slice — its own
   * header block still attached — instead of the header-stripped body
   * every intermediate depth already produces. Until the upstream fix
   * lands (walkParts in the platform's mime package should strip the
   * leaf the way it strips every level above it), fetched blob text that
   * begins with a well-formed header block has that block removed here.
   * Delete this function the moment blobs arrive header-free; the codec
   * tests carry both fixtures so the removal is a red/green edit.
   */
  function stripLeafMimeHeaders(text: string): string {
    const separator = text.indexOf("\r\n\r\n");
    if (separator === -1) return text;
    const head = text.slice(0, separator);
    const headerShaped = head
      .split("\r\n")
      .every(
        (line) =>
          /^[\x21-\x39\x3b-\x7e]+:\s?.*$/.test(line) || /^[ \t]/.test(line),
      );
    if (!headerShaped || !/^content-/im.test(head)) return text;
    const body = text.slice(separator + 4);
    // The raw slice was never transfer-decoded either; honor the encoding
    // named by the header block being stripped.
    if (/^content-transfer-encoding:\s*base64\s*$/im.test(head)) {
      return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
    }
    return body;
  }

  for (const attachment of parsed.attachments) {
    const label = attachment.name ?? attachment.blobId;

    if (attachment.type === "application/json") {
      const text = stripLeafMimeHeaders(
        blobToText(await opts.fetchBlob(attachment.blobId)),
      );
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (err) {
        throw new Error(
          `attachment blob "${attachment.blobId}" (${label}) is not valid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
      parts.push(parsePart(json));
      continue;
    }

    if (attachment.type === "text/plain") {
      const text = stripLeafMimeHeaders(
        blobToText(await opts.fetchBlob(attachment.blobId)),
      );
      parts.push({ kind: "text", text });
      continue;
    }

    parts.push({
      kind: "file",
      name: label,
      mediaType: attachment.type,
      blobId: attachment.blobId,
    });
  }

  return parts;
}
