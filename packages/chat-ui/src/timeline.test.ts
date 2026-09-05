import { describe, expect, test } from "bun:test";

import { friendlyEventText } from "./timeline";
import type { ParticipantRecord } from "./api";
import type { Part } from "./api";

function agentJoinedPart(address: string): Part & { kind: "event" } {
  return {
    kind: "event",
    event: "workbench.agent-joined",
    data: { address },
  };
}

describe("friendlyEventText — workbench.agent-joined (CL-6594)", () => {
  test("names the agent by its participant handle", () => {
    const participants: readonly ParticipantRecord[] = [
      { address: "run_scout@dana.localhost", handle: "scout" },
    ];
    expect(
      friendlyEventText(
        agentJoinedPart("run_scout@dana.localhost"),
        participants,
      ),
    ).toBe("Scout joined");
  });

  test("falls back to the address's own local part, never a generic noun, when the roster hasn't caught up with this address yet", () => {
    const participants: readonly ParticipantRecord[] = [
      { address: "run_myra@dana.localhost", handle: "myra" },
    ];
    expect(
      friendlyEventText(
        agentJoinedPart("run_scout@dana.localhost"),
        participants,
      ),
    ).toBe("Run Scout joined");
  });

  test("falls back to the generic line only when the event itself carries no address at all", () => {
    const part: Part & { kind: "event" } = {
      kind: "event",
      event: "workbench.agent-joined",
      data: {},
    };
    expect(friendlyEventText(part, [])).toBe("An agent joined");
  });

  test("prefers the resolved display name over the handle slug (CL-6424)", () => {
    const participants: readonly ParticipantRecord[] = [
      { address: "run_myra@dana.localhost", handle: "myra" },
    ];
    expect(
      friendlyEventText(
        agentJoinedPart("run_myra@dana.localhost"),
        participants,
        new Map([["run_myra@dana.localhost", "Myra the Helper"]]),
      ),
    ).toBe("Myra the Helper joined");
  });
});

describe("friendlyEventText — connection.connected (CL-6741)", () => {
  test("names the connected service and points at Plugins", () => {
    const part: Part & { kind: "event" } = {
      kind: "event",
      event: "connection.connected",
      data: { connectorId: "github", displayName: "GitHub" },
    };
    expect(friendlyEventText(part, [])).toBe(
      "GitHub connected successfully. Manage in Plugins",
    );
  });
});
