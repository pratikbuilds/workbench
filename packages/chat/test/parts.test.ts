import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  BlockPart,
  EventPart,
  FilePart,
  Part,
  parsePart,
  ReasoningPart,
  TextPart,
  ToolTracePart,
} from "../src/parts";

describe("Part schemas", () => {
  test("TextPart accepts a valid text part", () => {
    const result = TextPart({ kind: "text", text: "hello" });
    expect(result instanceof type.errors).toBe(false);
  });

  test("TextPart accepts turnFailedReason on a failed-turn notice", () => {
    const result = TextPart({
      kind: "text",
      text: "This agent's model isn't available here.",
      turnFailed: true,
      turnFailedReason: "model_unavailable",
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test("TextPart accepts tools_unsupported as a failed-turn reason", () => {
    const result = TextPart({
      kind: "text",
      text: "This agent's model can't use tools.",
      turnFailed: true,
      turnFailedReason: "tools_unsupported",
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test("ReasoningPart accepts a valid reasoning part", () => {
    const result = ReasoningPart({ kind: "reasoning", text: "thinking..." });
    expect(result instanceof type.errors).toBe(false);
  });

  test("ToolTracePart accepts a part with no output yet", () => {
    const result = ToolTracePart({
      kind: "tool-trace",
      name: "search",
      input: { query: "workbench" },
      status: "running",
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test("ToolTracePart accepts a completed part with output", () => {
    const result = ToolTracePart({
      kind: "tool-trace",
      name: "search",
      input: { query: "workbench" },
      output: { results: [] },
      status: "success",
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test("BlockPart accepts opaque generative-UI data", () => {
    const result = BlockPart({
      kind: "block",
      block: { type: "poll", data: { options: ["a", "b"] } },
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test("FilePart accepts a blobId reference", () => {
    const result = FilePart({
      kind: "file",
      name: "report.pdf",
      mediaType: "application/pdf",
      blobId: "blob_abc_1",
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test("FilePart accepts inline data", () => {
    const result = FilePart({
      kind: "file",
      name: "report.pdf",
      mediaType: "application/pdf",
      data: "cGRm",
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test("FilePart rejects both blobId and data set", () => {
    const result = FilePart({
      kind: "file",
      name: "report.pdf",
      mediaType: "application/pdf",
      blobId: "blob_abc_1",
      data: "cGRm",
    });
    expect(result instanceof type.errors).toBe(true);
  });

  test("FilePart rejects neither blobId nor data set", () => {
    const result = FilePart({
      kind: "file",
      name: "report.pdf",
      mediaType: "application/pdf",
    });
    expect(result instanceof type.errors).toBe(true);
  });

  test("FilePart accepts an artifactId with neither blobId nor data — the artifact's bytes live in the Library row, not chat's blob store", () => {
    const result = FilePart({
      kind: "file",
      name: "Notes",
      mediaType: "text/plain",
      artifactId: "art_1",
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test("FilePart accepts an artifactId alongside a blobId", () => {
    const result = FilePart({
      kind: "file",
      name: "Notes",
      mediaType: "text/plain",
      blobId: "blob_1",
      artifactId: "art_1",
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test("FilePart rejects an artifactId set alongside both blobId and data", () => {
    const result = FilePart({
      kind: "file",
      name: "Notes",
      mediaType: "text/plain",
      blobId: "blob_1",
      data: "aGVsbG8=",
      artifactId: "art_1",
    });
    expect(result instanceof type.errors).toBe(true);
  });

  test("EventPart accepts a timeline event", () => {
    const result = EventPart({
      kind: "event",
      event: "member.joined",
      data: { userId: "u_1" },
    });
    expect(result instanceof type.errors).toBe(false);
  });

  test("Part union rejects a structurally invalid part", () => {
    const result = Part({ kind: "text", text: 42 });
    expect(result instanceof type.errors).toBe(true);
  });

  test("Part union rejects an unknown kind", () => {
    const result = Part({ kind: "unknown-kind" });
    expect(result instanceof type.errors).toBe(true);
  });

  test("parsePart returns a valid part", () => {
    const part = parsePart({ kind: "text", text: "hi" });
    expect(part).toEqual({ kind: "text", text: "hi" });
  });

  test("parsePart throws a precise error for invalid data", () => {
    expect(() => parsePart({ kind: "text", text: 42 })).toThrow(
      /invalid chat part/,
    );
  });

  test("parsePart throws for completely malformed input", () => {
    expect(() => parsePart("not an object")).toThrow(/invalid chat part/);
  });
});
