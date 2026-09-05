import { describe, expect, test } from "bun:test";

import {
  bringInLoadErrorMessage,
  buildMemberAvatarStack,
} from "./chat-workspace";
import type { ParticipantRecord } from "./api";
import { avatarClassForPrincipal } from "./avatar";
import { CHAT_STRINGS } from "./strings";

describe("buildMemberAvatarStack", () => {
  test("identifies agent participants with agent tone for Corbit rendering", () => {
    const participants: readonly ParticipantRecord[] = [
      { address: "run_myra@dana.localhost", handle: "myra" },
      { address: "run_scout@dana.localhost", handle: "scout" },
    ];

    const stack = buildMemberAvatarStack(participants);

    expect(stack).toHaveLength(2);
    expect(stack.map((entry) => entry.label)).toEqual(["Myra", "Scout"]);
    expect(stack.every((entry) => entry.tone === "agent")).toBe(true);
  });

  test("is the static roster only — live presence is a separate stack", () => {
    const participants: readonly ParticipantRecord[] = [
      { address: "run_myra@dana.localhost", handle: "myra" },
      { address: "run_scout@dana.localhost", handle: "scout" },
    ];

    const stack = buildMemberAvatarStack(participants);

    expect(stack.map((entry) => entry.label)).toEqual(["Myra", "Scout"]);
    expect(stack.every((entry) => entry.tone === "agent")).toBe(true);
  });

  test("includes the signed-in human from the roster even with empty presence (CL-6779)", () => {
    // Onboarding/template rooms list the human as a participant before any
    // presence snapshot arrives — the stack must not be agent-only.
    const participants: readonly ParticipantRecord[] = [
      { address: "run_myra@dana.localhost", handle: "myra" },
      { address: "prn_dana", handle: "Dana" },
    ];

    const stack = buildMemberAvatarStack(participants);

    expect(stack.map((entry) => entry.label)).toEqual(["Myra", "Dana"]);
    expect(stack.map((entry) => entry.tone)).toEqual(["agent", "neutral"]);
    const human = stack[1];
    expect(human?.key).toBe("prn_dana");
    expect(human?.initials).toBe("D");
    expect(human?.avatarClassName).toBe(avatarClassForPrincipal("prn_dana"));
  });

  test("prefers the signed-in display name over a raw participant handle", () => {
    const participants: readonly ParticipantRecord[] = [
      { address: "prn_self", handle: "ada-handle" },
    ];

    const stack = buildMemberAvatarStack(participants, undefined, {
      principalId: "prn_self",
      name: "Ada Lovelace",
    });

    expect(stack.map((entry) => entry.label)).toEqual(["Ada Lovelace"]);
    expect(stack.map((entry) => entry.initials)).toEqual(["A"]);
  });

  test("prefers resolved agent display names over handle slugs (CL-6424)", () => {
    const participants: readonly ParticipantRecord[] = [
      { address: "run_myra@dana.localhost", handle: "myra" },
    ];

    const stack = buildMemberAvatarStack(
      participants,
      new Map([["run_myra@dana.localhost", "Myra the Helper"]]),
    );

    expect(stack.map((entry) => entry.label)).toEqual(["Myra the Helper"]);
  });
});

describe("bringInLoadErrorMessage (CL-6839)", () => {
  test("no failures yields null — honest empty stays empty", () => {
    expect(bringInLoadErrorMessage([], null)).toBeNull();
  });

  test("members-only failure uses the people copy", () => {
    expect(bringInLoadErrorMessage(["members"], new Error("x"))).toBe(
      CHAT_STRINGS.mentionMembersLoadError,
    );
  });

  test("invitable-agents-only failure uses the agents copy", () => {
    expect(bringInLoadErrorMessage(["invitableAgents"], new Error("x"))).toBe(
      CHAT_STRINGS.mentionInvitableLoadError,
    );
  });

  test("both failures use the combined copy", () => {
    expect(
      bringInLoadErrorMessage(["members", "invitableAgents"], new Error("x")),
    ).toBe(CHAT_STRINGS.mentionBringInLoadError);
  });
});
