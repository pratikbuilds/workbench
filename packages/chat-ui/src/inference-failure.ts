// Recognizes a classified inference failure's reply prose (CL-6092) — the
// one place `chat-ui` matches against the exact preambles
// `@intx/inference/src/default-director.ts`'s `formatInferenceError`
// writes for `"credential_failure"` and `"quota_exhausted"`
// (`InferenceError.category`, `@intx/types/runtime`). This is a prose
// match, not a structured read: by the time a reply reaches the chat
// timeline it is a plain `text` part with no metadata (see
// `vendor/intx/hub-sessions/src/event-collector.ts`'s `connector.reply`
// case, which persists the formatted string with `null` metadata) — the
// classification itself IS structured further upstream
// (`packages/chat/src/chat-orchestrator.ts`'s `postProviderHealthSignal`
// reads `TurnFinalized.errors[].category` directly, no parsing involved),
// but nothing carries that category down to this render layer.
//
// Conservative and narrow on purpose: matches only the two preambles a
// credential or quota failure gets, anchored at the start of the string
// (never a substring match, so an agent's own reply that happens to
// quote or discuss one of these phrases mid-sentence does not
// false-positive) and never the "temporary error"/"context limit"/
// "aborted" preambles those other categories get — a false match here
// would offer "Fix this connection" on a turn that was never a
// connection problem.
// Exported so `test/inference-preamble-drift.test.ts` can assert these
// stay byte-for-byte identical to the vendored source they're copied
// from, rather than each preamble living only as an inline literal no
// test can reach.
export const CLASSIFIED_INFERENCE_FAILURE_PREAMBLES: readonly string[] = [
  "This agent could not complete your request due to a credential error",
  "This agent could not complete your request because the API quota has been exhausted",
];

export {
  CONSUMER_INFERENCE_FAILURE_NOTICE,
  consumerFacingInferenceText,
} from "@corbits/chat/consumer-inference-text";

export function isClassifiedInferenceFailureText(text: string): boolean {
  return CLASSIFIED_INFERENCE_FAILURE_PREAMBLES.some((preamble) =>
    text.startsWith(preamble),
  );
}
