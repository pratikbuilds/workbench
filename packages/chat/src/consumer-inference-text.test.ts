import { describe, expect, test } from "bun:test";

import {
  CONSUMER_INFERENCE_FAILURE_NOTICE,
  consumerFacingInferenceText,
} from "./consumer-inference-text";

describe("consumerFacingInferenceText", () => {
  test("leaves ordinary replies unchanged", () => {
    expect(consumerFacingInferenceText("Hello there.")).toBe("Hello there.");
  });

  test("a classified credential failure is one recovery sentence, not a credential-error bubble", () => {
    const text = consumerFacingInferenceText(
      "This agent could not complete your request due to a credential error [HTTP 401]: API key is invalid.",
    );
    expect(text).toBe(CONSUMER_INFERENCE_FAILURE_NOTICE);
    expect(text.toLowerCase()).not.toContain("credential error");
    expect(text).not.toMatch(/\[HTTP/i);
    expect(text).not.toMatch(/401/);
    expect(text.toLowerCase()).not.toContain("api key is invalid");
  });

  test("a classified credential preamble without an HTTP dump is still recovery copy", () => {
    const text = consumerFacingInferenceText(
      "This agent could not complete your request due to a credential error",
    );
    expect(text).toBe(CONSUMER_INFERENCE_FAILURE_NOTICE);
    expect(text.toLowerCase()).not.toContain("credential error");
  });

  test("a classified quota failure is the same recovery sentence", () => {
    const text = consumerFacingInferenceText(
      "This agent could not complete your request because the API quota has been exhausted [HTTP 429]: rate limited",
    );
    expect(text).toBe(CONSUMER_INFERENCE_FAILURE_NOTICE);
    expect(text).not.toMatch(/\[HTTP/i);
  });

  test("a forced HTTP dump is not consumer copy", () => {
    const text = consumerFacingInferenceText("[HTTP 401]: API key is invalid.");
    expect(text).toBe(CONSUMER_INFERENCE_FAILURE_NOTICE);
    expect(text).not.toMatch(/\[HTTP/i);
    expect(text).not.toMatch(/401/);
    expect(text.toLowerCase()).not.toContain("api key is invalid");
  });

  test("a JSON provider-error object is not consumer copy", () => {
    const text = consumerFacingInferenceText(
      '{"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}',
    );
    expect(text).toBe(CONSUMER_INFERENCE_FAILURE_NOTICE);
    expect(text.toLowerCase()).not.toContain("invalid_api_key");
  });

  test("a tools-unsupported dump is the honest sentence, never the fatal preamble or HTTP", () => {
    const text = consumerFacingInferenceText(
      "This agent could not complete your request due to an unrecoverable inference error [HTTP 400]: 'tools' is not supported with this model.",
    );
    expect(text).toBe("This agent's model can't use tools.");
    expect(text).not.toMatch(/HTTP/i);
    expect(text).not.toContain("unrecoverable inference error");
    expect(text).not.toContain("not supported with this model");
  });
});
