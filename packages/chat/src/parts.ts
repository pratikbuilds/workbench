import { type } from "arktype";

// The wire contract for chat message content. Every message a thread
// carries is a `Part[]`; each part is a structural arktype schema with a
// `kind` discriminant, parsed at the trust boundary rather than cast.

export const TextPart = type({
  kind: "'text'",
  text: "string",
  /** Set only on the undelivered-turn notice `postUndeliveredNotice`
   * posts in an unreachable agent's own voice (CL-6332) — the client's
   * one signal that this particular text bubble is a failed turn's
   * notice, not an ordinary reply, so it renders the failed-turn strip
   * (`PrFailedTurnStrip`) instead of a plain bubble. Absent on every
   * other text part. */
  "turnFailed?": "boolean",
  /** Set with `turnFailed` when the cause is a missing/unresolvable
   * model (`InferenceResolutionError`) or a model that cannot use tools
   * — the failed-turn strip renders named recovery (picker + Settings
   * hop) instead of Retry. Absent on every other text part. */
  "turnFailedReason?": "'model_unavailable' | 'tools_unsupported'",
  /** Set only on the cancelled-turn notice `postCancelledNotice`
   * (`./workbench-service.ts`) posts in the cancelled agent's own voice
   * (CL-7201) — distinct from `turnFailed`: a user cancelling a turn is
   * not a failure, and the frontend renders it with its own honest copy
   * rather than `FailedTurnStrip`'s "didn't reply" framing. Absent on
   * every other text part. */
  "turnCancelled?": "boolean",
});
export type TextPart = typeof TextPart.infer;

export const ReasoningPart = type({
  kind: "'reasoning'",
  text: "string",
});
export type ReasoningPart = typeof ReasoningPart.infer;

export const ToolTracePart = type({
  kind: "'tool-trace'",
  name: "string",
  input: "unknown",
  "output?": "unknown",
  status: "'pending' | 'running' | 'success' | 'error'",
});
export type ToolTracePart = typeof ToolTracePart.infer;

export const BlockPart = type({
  kind: "'block'",
  block: {
    type: "string",
    data: "unknown",
  },
});
export type BlockPart = typeof BlockPart.infer;

// A file rides either as a reference into platform blob storage (`blobId`,
// for content already persisted) or as inline base64 bytes (`data`, for
// content the codec is encoding fresh). Exactly one of those two must be
// present. `artifactId` is an orthogonal, optional link back to a Library
// artifact (see `@corbits/artifacts`) — set when this file is also a
// persisted Library row (e.g. a workflow finalize tool's output, CL-6000),
// independent of whether the bytes themselves also live in chat's own blob
// store.
export const FilePart = type({
  kind: "'file'",
  name: "string",
  mediaType: "string",
  "blobId?": "string",
  "data?": "string",
  "artifactId?": "string",
}).narrow((part, ctx) => {
  const hasBlobId = part.blobId !== undefined;
  const hasData = part.data !== undefined;
  // An artifact-backed file needs neither: its bytes live in the Library
  // artifact row `artifactId` names, not in chat's own blob store, so
  // `blobId`/`data` stay optional (but still mutually exclusive) once
  // `artifactId` is set.
  if (part.artifactId !== undefined) {
    if (hasBlobId && hasData) {
      return ctx.reject("`blobId` and `data` cannot both be set on a FilePart");
    }
    return true;
  }
  if (hasBlobId === hasData) {
    return ctx.reject(
      "exactly one of `blobId` or `data` must be set on a FilePart",
    );
  }
  return true;
});
export type FilePart = typeof FilePart.infer;

export const EventPart = type({
  kind: "'event'",
  event: "string",
  data: "unknown",
});
export type EventPart = typeof EventPart.infer;

export const Part = TextPart.or(ReasoningPart)
  .or(ToolTracePart)
  .or(BlockPart)
  .or(FilePart)
  .or(EventPart);
export type Part = typeof Part.infer;

/**
 * Parse untrusted data as a `Part`, throwing a precise error rather than
 * returning malformed or partially-trusted data. The only supported way
 * to bring external JSON into the `Part` type.
 */
export function parsePart(data: unknown): Part {
  const result = Part(data);
  if (result instanceof type.errors) {
    throw new Error(`invalid chat part: ${result.summary}`);
  }
  return result;
}
