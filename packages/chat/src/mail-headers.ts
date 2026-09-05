// RFC 5322 threading headers for a workbench timeline row (CL-7104).
//
// Chat is a mail thread: a message row dispatched to an agent carries its
// own `Message-ID`, and the reply that answers it names that id in
// `In-Reply-To` / `References`. Correlation is those headers and nothing
// else — no `Interchange-Correlation-ID`, no reply-to-address heuristic.
//
// A row's Message-ID is derived, never minted separately: `<rowId@domain>`
// over the row's own primary key and the mail domain the workbench's
// participants are addressed in. Deriving it means the same row always
// produces the same header, so stamping it twice is a no-op and reading a
// header back names exactly one row.
import { localPartOf } from "./agent-address";

/** The RFC 5322 `Message-ID` for a timeline row: `<rowId@domain>`. */
export function mailMessageIdFor(rowId: string, domain: string): string {
  return `<${rowId}@${domain}>`;
}

/**
 * The timeline row a `Message-ID` names — the inverse of
 * `mailMessageIdFor`. A value with no `<...>` framing, or no `@`, is
 * returned unchanged, so an id minted by any other transport simply
 * misses the row lookup rather than crashing it.
 */
export function rowIdFromMailMessageId(header: string): string {
  const framed =
    header.startsWith("<") && header.endsWith(">") && header.length > 2
      ? header.slice(1, -1)
      : header;
  return localPartOf(framed);
}

/**
 * The threading headers for a row being dispatched as mail. `ancestors`
 * is the row's parent chain, root first (see `mailAncestryOf` in
 * `./threads.ts`); `References` is exactly that chain and `In-Reply-To`
 * is its tail, per RFC 5322. A root-feed row has neither.
 */
export function mailThreadHeaders(input: {
  readonly rowId: string;
  readonly domain: string;
  readonly ancestors: readonly string[];
}): {
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
} {
  const messageId = mailMessageIdFor(input.rowId, input.domain);
  const references = input.ancestors.map((ancestor) =>
    mailMessageIdFor(ancestor, input.domain),
  );
  const inReplyTo = references[references.length - 1];
  return {
    messageId,
    ...(inReplyTo !== undefined ? { inReplyTo } : {}),
    ...(references.length > 0 ? { references } : {}),
  };
}

/**
 * The `Message-ID` an inbound reply answers: `In-Reply-To` when it has
 * one, otherwise the tail of `References` — the nearest ancestor either
 * header names. Undefined when the reply threads under nothing at all,
 * which the caller must report rather than guess a parent for.
 */
export function parentMailMessageId(headers: {
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
}): string | undefined {
  if (headers.inReplyTo !== undefined && headers.inReplyTo !== "") {
    return headers.inReplyTo;
  }
  const references = headers.references ?? [];
  const tail = references[references.length - 1];
  return tail !== undefined && tail !== "" ? tail : undefined;
}

/**
 * Splits a raw `References` header value into its Message-IDs.
 * RFC 5322 separates them by whitespace (folding included), so any run
 * of whitespace is the separator and empty segments are dropped.
 */
export function parseReferences(value: string): readonly string[] {
  return value.split(/\s+/).filter((entry) => entry.length > 0);
}
