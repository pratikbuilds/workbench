import { describe, expect, test } from "bun:test";

import {
  CONSUMER_INFERENCE_FAILURE_NOTICE,
  consumerFacingInferenceText,
  isClassifiedInferenceFailureText,
} from "./inference-failure";

describe("consumerFacingInferenceText", () => {
  test("maps a classified credential failure to one recovery sentence", () => {
    expect(
      consumerFacingInferenceText(
        "This agent could not complete your request due to a credential error [HTTP 401]: API key is invalid",
      ),
    ).toBe(CONSUMER_INFERENCE_FAILURE_NOTICE);
    expect(
      consumerFacingInferenceText(
        "This agent could not complete your request because the API quota has been exhausted [HTTP 429]: rate limited",
      ),
    ).toBe(CONSUMER_INFERENCE_FAILURE_NOTICE);
  });

  test("a forced [HTTP 401] dump is not consumer copy", () => {
    const leaked = "[HTTP 401]: API key is invalid";
    const facing = consumerFacingInferenceText(leaked);
    expect(facing).not.toContain("[HTTP");
    expect(facing).not.toContain("401");
    expect(facing).not.toContain("API key is invalid");
  });

  test("a tools-unsupported dump is one honest sentence, never HTTP or registry copy", () => {
    const text = consumerFacingInferenceText(
      "This agent could not complete your request due to an unrecoverable inference error [HTTP 400]: 'tools' is not supported with this model.",
    );
    expect(text).toBe("This agent's model can't use tools.");
    expect(text).not.toMatch(/HTTP/i);
    expect(text).not.toContain("function-calling");
    expect(text).not.toContain("unrecoverable inference error");
  });

  test("leaves cause-aware undelivered-notice copy untouched", () => {
    const notice =
      "I can't reach a model right now — add or check your model key in Settings, then I'll pick this up.";
    expect(consumerFacingInferenceText(notice)).toBe(notice);
  });
});

describe("isClassifiedInferenceFailureText", () => {
  test("matches a credential_failure reply, status code included", () => {
    expect(
      isClassifiedInferenceFailureText(
        "This agent could not complete your request due to a credential error [HTTP 401]: invalid api key",
      ),
    ).toBe(true);
  });

  test("a stripped credential_failure reply is recovery copy, not the classified preamble", () => {
    const facing = consumerFacingInferenceText(
      "This agent could not complete your request due to a credential error [HTTP 401]: invalid api key",
    );
    expect(facing).toBe(CONSUMER_INFERENCE_FAILURE_NOTICE);
    expect(facing.toLowerCase()).not.toContain("credential error");
    expect(
      isClassifiedInferenceFailureText(
        "This agent could not complete your request due to a credential error [HTTP 401]: invalid api key",
      ),
    ).toBe(true);
  });

  test("matches a quota_exhausted reply", () => {
    expect(
      isClassifiedInferenceFailureText(
        "This agent could not complete your request because the API quota has been exhausted [HTTP 429]: rate limited",
      ),
    ).toBe(true);
  });

  test("does not match a retryable/context_overflow/fatal/aborted reply", () => {
    expect(
      isClassifiedInferenceFailureText(
        "This agent encountered a temporary error communicating with the inference provider [HTTP 503]: upstream down",
      ),
    ).toBe(false);
    expect(
      isClassifiedInferenceFailureText(
        "This agent could not complete your request because the conversation exceeded the model's context limit: too long",
      ),
    ).toBe(false);
    expect(
      isClassifiedInferenceFailureText(
        "This agent could not complete your request due to an unrecoverable inference error [HTTP 402]: payment required",
      ),
    ).toBe(false);
    expect(
      isClassifiedInferenceFailureText(
        "This agent's inference request was aborted",
      ),
    ).toBe(false);
  });

  test("does not match an ordinary agent reply, even one that mentions credentials mid-sentence", () => {
    expect(
      isClassifiedInferenceFailureText(
        "I'd due to a credential error need your API key to continue.",
      ),
    ).toBe(false);
    expect(
      isClassifiedInferenceFailureText("Here are the results you asked for."),
    ).toBe(false);
  });
});
