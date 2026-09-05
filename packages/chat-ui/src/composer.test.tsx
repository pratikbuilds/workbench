import { describe, expect, test } from "bun:test";

import {
  canStopComposer,
  insertTextAtCaret,
  spliceDictationTranscript,
  speechRecognitionConstructor,
  transcriptFromSpeechResults,
} from "./composer";
import { isAwaitingReply } from "./streaming-reply";

describe("insertTextAtCaret", () => {
  test("splices the insertion in at the caret", () => {
    const result = insertTextAtCaret("hello world", 6, "@myra ");
    expect(result.text).toBe("hello @myra world");
    expect(result.caret).toBe(12);
  });

  test("appends at the end when the caret sits past the text", () => {
    const result = insertTextAtCaret("hi", 2, "@myra ");
    expect(result.text).toBe("hi@myra ");
    expect(result.caret).toBe(8);
  });

  test("inserts into an empty draft", () => {
    const result = insertTextAtCaret("", 0, "@myra ");
    expect(result.text).toBe("@myra ");
    expect(result.caret).toBe(6);
  });
});

describe("spliceDictationTranscript", () => {
  test("inserts a space so two words do not glue together", () => {
    const result = spliceDictationTranscript("hello", "", "world");
    expect(result.text).toBe("hello world");
    expect(result.caret).toBe(11);
  });

  test("does not add a second space when the prefix already ends with one", () => {
    const result = spliceDictationTranscript("hello ", "", "world");
    expect(result.text).toBe("hello world");
    expect(result.caret).toBe(11);
  });

  test("keeps a following suffix on its own word boundary", () => {
    const result = spliceDictationTranscript("hello", "there", "world");
    expect(result.text).toBe("hello world there");
    expect(result.caret).toBe(11);
  });

  test("drops an empty transcript without changing the draft", () => {
    const result = spliceDictationTranscript("hello", " there", "   ");
    expect(result.text).toBe("hello there");
    expect(result.caret).toBe(5);
  });
});

describe("transcriptFromSpeechResults", () => {
  test("concatenates every alternative in order", () => {
    expect(
      transcriptFromSpeechResults([
        { isFinal: true, length: 1, 0: { transcript: "hello " } },
        { isFinal: false, length: 1, 0: { transcript: "world" } },
      ]),
    ).toBe("hello world");
  });
});

describe("speechRecognitionConstructor", () => {
  test("returns null when the browser has no speech recognition", () => {
    expect(speechRecognitionConstructor({})).toBeNull();
  });

  test("prefers SpeechRecognition over the webkit prefix", () => {
    function SpeechRecognition() {
      return undefined;
    }
    function webkitSpeechRecognition() {
      return undefined;
    }
    const found = speechRecognitionConstructor({
      SpeechRecognition,
      webkitSpeechRecognition,
    });
    expect(Object.is(found, SpeechRecognition)).toBe(true);
  });

  test("falls back to webkitSpeechRecognition", () => {
    function webkitSpeechRecognition() {
      return undefined;
    }
    const found = speechRecognitionConstructor({ webkitSpeechRecognition });
    expect(Object.is(found, webkitSpeechRecognition)).toBe(true);
  });
});

// CL-7201: the composer's stop affordance is a stand-in for "is there a
// turn to cancel" — offered whenever the host says a turn is running,
// independent of the composer's own `sending`/`preparing` state (queuing
// a follow-up message while a turn runs is still allowed, so the stop
// affordance and the send button coexist rather than one gating the
// other).
describe("canStopComposer", () => {
  test("offers Stop while the host reports a turn running", () => {
    expect(canStopComposer({ running: true })).toBe(true);
  });

  test("offers nothing when no turn is running", () => {
    expect(canStopComposer({ running: false })).toBe(false);
  });

  test("offers Stop while awaiting a turn that already has streamed text", () => {
    expect(
      canStopComposer({
        running: isAwaitingReply({ phase: "awaiting", text: "Hello" }),
      }),
    ).toBe(true);
  });
});
