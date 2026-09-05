import { describe, expect, test } from "bun:test";

import {
  AVAILABLE_SKILLS_CLOSE_TAG,
  AVAILABLE_SKILLS_OPEN_TAG,
  buildAvailableSkillsStanza,
  stripAvailableSkillsStanza,
  withAvailableSkills,
} from "./prompt";

const PINNED = [
  { name: "triage", description: "Sorts inbound issues." },
  { name: "summarize", description: "Condenses a long thread." },
];

describe("buildAvailableSkillsStanza", () => {
  test("lists each pinned skill's name and description", () => {
    const stanza = buildAvailableSkillsStanza(PINNED);
    expect(stanza).toContain("- triage: Sorts inbound issues.");
    expect(stanza).toContain("- summarize: Condenses a long thread.");
  });

  test("names skills_load as the way to read a body", () => {
    expect(buildAvailableSkillsStanza(PINNED)).toContain("skills_load");
  });

  test("is empty when nothing is pinned", () => {
    expect(buildAvailableSkillsStanza([])).toBe("");
  });
});

describe("withAvailableSkills", () => {
  test("appends the stanza after the author's prompt", () => {
    const prompt = withAvailableSkills("You are a helpful agent.", PINNED);
    expect(prompt.startsWith("You are a helpful agent.")).toBe(true);
    expect(prompt).toContain(AVAILABLE_SKILLS_OPEN_TAG);
    expect(prompt).toContain(AVAILABLE_SKILLS_CLOSE_TAG);
  });

  test("carries no skill body — the index is names and descriptions only", () => {
    const prompt = withAvailableSkills("Base.", [
      { name: "triage", description: "Sorts inbound issues." },
    ]);
    expect(prompt).not.toContain("Step 1: read the issue");
  });

  test("re-pinning replaces the prior stanza instead of stacking one", () => {
    const once = withAvailableSkills("Base.", PINNED);
    const twice = withAvailableSkills(once, PINNED);
    expect(twice).toBe(once);
    expect(twice.split(AVAILABLE_SKILLS_OPEN_TAG)).toHaveLength(2);
  });

  test("unpinning every skill leaves the author's prompt alone", () => {
    const pinned = withAvailableSkills("You are a helpful agent.", PINNED);
    expect(withAvailableSkills(pinned, [])).toBe("You are a helpful agent.");
  });
});

describe("stripAvailableSkillsStanza", () => {
  test("removes an injected stanza wherever it sits", () => {
    const prompt = withAvailableSkills("Base prompt.", PINNED);
    expect(stripAvailableSkillsStanza(prompt)).toBe("Base prompt.");
  });

  test("leaves a prompt that never carried one untouched", () => {
    expect(stripAvailableSkillsStanza("Base prompt.")).toBe("Base prompt.");
  });
});
