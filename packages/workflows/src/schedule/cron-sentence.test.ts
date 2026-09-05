// Contract: a sentence, in the reader's words, naming the zone only when
// there is a clock to read in it, and never the raw expression — not
// `cronstrue`'s exact phrasing.
import { describe, expect, test } from "bun:test";

import { cronHasWallClock, cronSentence } from "./cron-sentence";

const LOOKS_LIKE_CRON = /\*|\d+\s+\d+\s/;

function expectSentence(sentence: string | null): string {
  expect(sentence).not.toBeNull();
  const text = sentence as string;
  expect(text).not.toMatch(LOOKS_LIKE_CRON);
  expect(text.length).toBeGreaterThan(3);
  return text;
}

describe("cronHasWallClock", () => {
  test("a pinned hour or minute is a clock reading", () => {
    expect(cronHasWallClock("0 9 * * *")).toBe(true);
    expect(cronHasWallClock("30 * * * *")).toBe(true);
  });

  test("a pure cadence has no clock, in any zone", () => {
    expect(cronHasWallClock("* * * * *")).toBe(false);
    expect(cronHasWallClock("*/15 * * * *")).toBe(false);
    expect(cronHasWallClock("* */2 * * *")).toBe(false);
  });
});

describe("cronSentence", () => {
  test("a weekday morning schedule reads as words naming its zone", () => {
    const sentence = expectSentence(cronSentence("0 9 * * 1-5"));
    expect(sentence).toStartWith("At ");
    expect(sentence).toContain("Friday");
    expect(sentence).toEndWith("(UTC)");
  });

  test("the named zone is the one the wall clock is read in", () => {
    expect(cronSentence("30 14 * * *", "America/Los_Angeles")).toEndWith(
      "(America/Los_Angeles)",
    );
  });

  test("a pure cadence names no zone — it is the same in every zone", () => {
    const sentence = expectSentence(cronSentence("*/15 * * * *"));
    expect(sentence).toStartWith("Every ");
    expect(sentence).not.toContain("UTC");
  });

  test("null for an expression that cannot be described", () => {
    expect(cronSentence("not a cron")).toBeNull();
    expect(cronSentence("")).toBeNull();
  });
});
