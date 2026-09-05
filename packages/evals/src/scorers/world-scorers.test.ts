import { describe, expect, test } from "bun:test";

import type { ScorerContext, WorldSnapshot } from "../types.ts";
import {
  agentHasTools,
  connectionIsLive,
  fakeReceived,
} from "./world-scorers.ts";

function worldCtx(world: Partial<WorldSnapshot>): ScorerContext {
  return {
    transcript: [],
    turnIndex: 0,
    world: {
      capturedAt: "2026-01-01T00:00:00.000Z",
      agentDefinitions: [],
      connections: [],
      webhookTriggers: [],
      fakeReceipts: [],
      ...world,
    },
  };
}

describe("agentHasTools", () => {
  test("passes when the named agent has every tool pinned", () => {
    const ctx = worldCtx({
      agentDefinitions: [
        {
          id: "def-1",
          name: "AI Daily researcher",
          displayName: null,
          toolPackagePins: [
            "@corbits/web-search-tools",
            "@corbits/memory-tools",
          ],
          skills: [],
          model: null,
        },
      ],
    });
    const r = agentHasTools("AI Daily researcher", [
      "@corbits/web-search-tools",
    ])(ctx);
    expect(r.pass).toBe(true);
  });

  test("fails when the agent is missing a required tool", () => {
    const ctx = worldCtx({
      agentDefinitions: [
        {
          id: "def-1",
          name: "AI Daily researcher",
          displayName: null,
          toolPackagePins: ["@corbits/memory-tools"],
          skills: [],
          model: null,
        },
      ],
    });
    const r = agentHasTools("AI Daily researcher", [
      "@corbits/web-search-tools",
    ])(ctx);
    expect(r.pass).toBe(false);
    expect(r.reason).toContain("@corbits/web-search-tools");
  });

  test("fails when the agent doesn't exist yet", () => {
    const r = agentHasTools("Nobody", ["x"])(worldCtx({}));
    expect(r.pass).toBe(false);
  });
});

describe("connectionIsLive", () => {
  test("passes for a live connection, fails for none found", () => {
    const ctx = worldCtx({
      connections: [
        { slug: "github", name: "GitHub", url: "https://x", live: true },
      ],
    });
    expect(connectionIsLive("github")(ctx).pass).toBe(true);
    expect(connectionIsLive("attio")(ctx).pass).toBe(false);
  });

  test("fails for a connection that exists but isn't live", () => {
    const ctx = worldCtx({
      connections: [
        { slug: "github", name: "GitHub", url: "https://x", live: false },
      ],
    });
    expect(connectionIsLive("github")(ctx).pass).toBe(false);
  });
});

describe("fakeReceived", () => {
  test("passes once a matching call was received", () => {
    const ctx = worldCtx({
      fakeReceipts: [
        {
          server: "github",
          toolName: "list_pull_requests",
          arguments: { repo: "corbitsdev/workbench" },
        },
      ],
    });
    expect(fakeReceived("github", "list_pull_requests")(ctx).pass).toBe(true);
    expect(fakeReceived("github", "create_issue")(ctx).pass).toBe(false);
  });

  test("applies the optional argument matcher", () => {
    const ctx = worldCtx({
      fakeReceipts: [
        {
          server: "github",
          toolName: "create_issue",
          arguments: { repo: "a" },
        },
      ],
    });
    expect(
      fakeReceived(
        "github",
        "create_issue",
        (args) => args["repo"] === "b",
      )(ctx).pass,
    ).toBe(false);
    expect(
      fakeReceived(
        "github",
        "create_issue",
        (args) => args["repo"] === "a",
      )(ctx).pass,
    ).toBe(true);
  });
});
