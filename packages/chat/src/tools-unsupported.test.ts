import { describe, expect, test } from "bun:test";

import {
  TOOLS_UNSUPPORTED_CONSUMER_MESSAGE,
  isToolsUnsupportedInferenceText,
} from "./tools-unsupported";

const FATAL_PREAMBLE =
  "This agent could not complete your request due to an unrecoverable inference error";

describe("isToolsUnsupportedInferenceText", () => {
  test("classifies a formatted inference dump whose provider message is tools-unsupported", () => {
    expect(
      isToolsUnsupportedInferenceText(
        `${FATAL_PREAMBLE} [HTTP 400]: 'tools' is not supported with this model.`,
      ),
    ).toBe(true);
  });

  test("classifies a JSON provider dump that says the model cannot use tools", () => {
    expect(
      isToolsUnsupportedInferenceText(
        `${FATAL_PREAMBLE} [HTTP 400]: {"error":{"message":"does not support tools","type":"invalid_request_error"}}`,
      ),
    ).toBe(true);
  });

  test("classifies a registry capability miss for function-calling", () => {
    expect(
      isToolsUnsupportedInferenceText(
        "offering anthropic/claude-haiku is missing required capability function-calling",
      ),
    ).toBe(true);
  });

  test("does not classify an unrelated HTTP 400", () => {
    expect(
      isToolsUnsupportedInferenceText(
        `${FATAL_PREAMBLE} [HTTP 400]: invalid_request_error: max_tokens must be positive`,
      ),
    ).toBe(false);
  });

  test("does not classify embedding/chat-capability failures", () => {
    expect(
      isToolsUnsupportedInferenceText("this model does not support generate"),
    ).toBe(false);
    expect(
      isToolsUnsupportedInferenceText("this model does not support chat"),
    ).toBe(false);
  });

  test("does not classify ordinary replies that mention tools", () => {
    expect(
      isToolsUnsupportedInferenceText(
        "I can use tools to look that up if you want.",
      ),
    ).toBe(false);
  });

  test("does not classify ordinary tool-not-supported connector prose", () => {
    expect(
      isToolsUnsupportedInferenceText(
        "The grep tool is not supported in this sandbox.",
      ),
    ).toBe(false);
    expect(
      isToolsUnsupportedInferenceText(
        "The search tool is not supported in this environment.",
      ),
    ).toBe(false);
  });
});

describe("TOOLS_UNSUPPORTED_CONSUMER_MESSAGE", () => {
  test("is one honest sentence with no HTTP, registry, or provider dump", () => {
    expect(TOOLS_UNSUPPORTED_CONSUMER_MESSAGE).toBe(
      "This agent's model can't use tools.",
    );
    expect(TOOLS_UNSUPPORTED_CONSUMER_MESSAGE).not.toMatch(/HTTP/i);
    expect(TOOLS_UNSUPPORTED_CONSUMER_MESSAGE.toLowerCase()).not.toContain(
      "function-calling",
    );
  });
});
