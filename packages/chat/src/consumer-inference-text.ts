/**
 * Person-facing inference copy. HTTP status, raw provider dumps, and
 * JSON error objects never belong on the timeline, in a sidebar preview,
 * or next to the composer — DESIGN.md Honesty is one consumer sentence.
 */

import {
  TOOLS_UNSUPPORTED_CONSUMER_MESSAGE,
  isToolsUnsupportedInferenceText,
} from "./tools-unsupported";

const HTTP_STATUS_MARK = /\[HTTP\s+\d+\]/i;
const TRAILING_HTTP_DUMP = /\s*\[HTTP\s+\d+\]:[\s\S]*$/i;

export const CONSUMER_INFERENCE_FAILURE_NOTICE =
  "This didn't go through. Try again, or check the connection in Settings.";

/**
 * Byte-for-byte copies of the two preambles `@intx/inference`'s
 * `formatInferenceError` writes for `credential_failure` and
 * `quota_exhausted`. Kept here so the bench-list preview path (CL-6735)
 * can refuse them without depending on `@corbits/chat-ui`. The chat-ui
 * drift guard still owns matching these against the published director.
 */
export const CLASSIFIED_INFERENCE_FAILURE_PREAMBLES: readonly string[] = [
  "This agent could not complete your request due to a credential error",
  "This agent could not complete your request because the API quota has been exhausted",
];

function isProviderJsonDump(raw: string): boolean {
  const trimmed = raw.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  return /"error"/i.test(trimmed);
}

function needsSanitization(raw: string): boolean {
  return HTTP_STATUS_MARK.test(raw) || isProviderJsonDump(raw);
}

/** Drop HTTP status, raw provider text, and classified failure preambles. */
export function consumerFacingInferenceText(raw: string): string {
  if (isToolsUnsupportedInferenceText(raw)) {
    return TOOLS_UNSUPPORTED_CONSUMER_MESSAGE;
  }
  if (!needsSanitization(raw) && !isClassifiedInferenceFailureText(raw)) {
    return raw;
  }
  const stripped = raw.replace(TRAILING_HTTP_DUMP, "").trim();
  if (
    stripped.length > 0 &&
    !needsSanitization(stripped) &&
    !isClassifiedInferenceFailureText(stripped)
  ) {
    return stripped;
  }
  return CONSUMER_INFERENCE_FAILURE_NOTICE;
}

/** True when `text` is (or starts with) a classified inference-failure preamble. */
export function isClassifiedInferenceFailureText(text: string): boolean {
  return CLASSIFIED_INFERENCE_FAILURE_PREAMBLES.some((preamble) =>
    text.startsWith(preamble),
  );
}

/**
 * Bench-list / sidebar preview copy (CL-6735): never the full failure
 * paragraph, never HTTP/raw provider dumps — a short consumer sentence
 * when the text is a classified failure.
 */
export function activityPreviewText(raw: string): string {
  const facing = consumerFacingInferenceText(raw);
  return facing;
}
