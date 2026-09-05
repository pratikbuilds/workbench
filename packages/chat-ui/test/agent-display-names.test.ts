import { describe, expect, test } from "bun:test";

import {
  agentDisplayNamesFromAgents,
  displayNameForAddress,
} from "../src/agent-display-names";

describe("agentDisplayNamesFromAgents", () => {
  test("keys each agent's display name by its participant address", () => {
    const names = agentDisplayNamesFromAgents([
      { address: "ins_echo@acme.example", displayName: "Myra" },
      { address: "ins_review@acme.example", displayName: "Reviewer" },
    ]);
    expect(names.get("ins_echo@acme.example")).toBe("Myra");
    expect(names.get("ins_review@acme.example")).toBe("Reviewer");
  });

  test("an empty snapshot builds an empty lookup", () => {
    expect(agentDisplayNamesFromAgents([]).size).toBe(0);
  });
});

describe("displayNameForAddress", () => {
  test("returns the known display name, never the handle slug", () => {
    const names = agentDisplayNamesFromAgents([
      { address: "ins_echo@acme.example", displayName: "Myra" },
    ]);
    expect(displayNameForAddress("ins_echo@acme.example", names)).toBe("Myra");
  });

  test("is undefined for an unknown address so the caller falls back", () => {
    const names = agentDisplayNamesFromAgents([
      { address: "ins_echo@acme.example", displayName: "Myra" },
    ]);
    expect(
      displayNameForAddress("ins_other@acme.example", names),
    ).toBeUndefined();
  });

  test("is undefined without a snapshot so the caller falls back", () => {
    expect(
      displayNameForAddress("ins_echo@acme.example", undefined),
    ).toBeUndefined();
  });
});
