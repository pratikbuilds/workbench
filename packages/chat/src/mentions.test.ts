import { describe, expect, test } from "bun:test";

import { isAgentAddress, mentionedParticipants } from "./mentions";

describe("isAgentAddress", () => {
  test("a bare agent address (local@domain) is an agent address", () => {
    expect(isAgentAddress("scout@agents.example")).toBe(true);
  });

  test("a bare human principal id with no @ is not an agent address", () => {
    expect(isAgentAddress("prn_sawyer")).toBe(false);
  });

  test("a tenant-scoped human principal (prn_...@tenant.domain) is not an agent address", () => {
    expect(isAgentAddress("prn_ada@acme.example")).toBe(false);
  });
});

describe("mentionedParticipants", () => {
  test("mentions an agent by handle but never a human principal", () => {
    const participants = [
      { address: "scout@agents.example", handle: "scout" },
      { address: "prn_ada@acme.example", handle: "ada" },
    ];
    expect(
      mentionedParticipants(
        [{ kind: "text", text: "hey @scout and @ada take a look" }],
        participants,
      ),
    ).toEqual(["scout@agents.example"]);
  });
});
