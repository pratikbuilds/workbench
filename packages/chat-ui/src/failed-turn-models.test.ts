import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "@corbits/inference-settings";

import {
  failedTurnModelChoices,
  failedTurnToolCapableModelChoices,
} from "./failed-turn-models";

function model(
  canonicalName: string,
  capabilities: ModelInfo["offerings"][number]["capabilities"],
  displayName = canonicalName,
): ModelInfo {
  return {
    id: `model-${canonicalName}`,
    canonicalName,
    displayName,
    offerings: [
      {
        offeringId: `offering-${canonicalName}`,
        providerId: "provider-a",
        providerName: "anthropic",
        plugin: "anthropic",
        priority: 0,
        deploymentTags: [],
        capabilities: [...capabilities],
        pricing: [],
      },
    ],
  };
}

const CHAT_ONLY = model("google/gemini-2.5-flash", ["plain-text"], "Flash");
const TOOL_CAPABLE = model(
  "anthropic/claude-sonnet",
  ["plain-text", "function-calling-multi-turn"],
  "Sonnet",
);
const UNCATALOGED = model("qwen3:8b", [], "qwen3:8b");

describe("failedTurnModelChoices", () => {
  test("keeps chat-capable models, including ones without tools", () => {
    const choices = failedTurnModelChoices([
      CHAT_ONLY,
      TOOL_CAPABLE,
      UNCATALOGED,
    ]);
    expect(choices.map((choice) => choice.canonicalName)).toEqual([
      "google/gemini-2.5-flash",
      "anthropic/claude-sonnet",
      "qwen3:8b",
    ]);
  });
});

describe("failedTurnToolCapableModelChoices", () => {
  test("keeps only models whose offerings advertise function-calling", () => {
    const choices = failedTurnToolCapableModelChoices([
      CHAT_ONLY,
      TOOL_CAPABLE,
      UNCATALOGED,
    ]);
    expect(choices.map((choice) => choice.canonicalName)).toEqual([
      "anthropic/claude-sonnet",
    ]);
  });
});
