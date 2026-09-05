import type { CapturedChatRequest } from "./capture";
import type { OllamaChatReply } from "./types";

// CL-6478's exact wire value: qwen3.8:27b leaked a stray `\n</parameter`
// fragment into a tool-call function name. Persisted unchanged into turn
// history, @intx/inference's encodeToolName throws re-encoding it on every
// following turn's request, bricking the room forever. The real fix lives
// at vendor/intx/hub-sessions/src/sanitize-tool-name.ts
// (sanitizeToolNameForPersistence, MALFORMED_TOOL_NAME) -- this is the
// exact shape it guards against, reproducible here with no GPU. See
// cl-6478-demo.test.ts for the regression-guard shape.
const CL_6478_MALFORMED_TOOL_NAME =
  "@intx/tools-posix/sidecar-bundle:run_shell\n</parameter";

// A model calling the tool by its old, retired name instead of the
// canonical `skills_load` (packages/tools-skills/src/tool.ts). `load_skill`
// no longer exists as a tool; this fixture reproduces a model still
// guessing it.
const HALLUCINATED_TOOL_NAME = "load_skill";

function nameOfExactLength(length: number): string {
  const prefix = "namespaced_tool_probe_";
  const padded = prefix + "x".repeat(Math.max(length - prefix.length, 0));
  return padded.slice(0, Math.max(length, 0));
}

export type AdversarialReplies = {
  /** CL-6478's flagship case: qwen3.8:27b emitted `\n</parameter` inside a
   * function name, which -- unsanitized -- permanently bricked the room.
   * See cl-6478-demo.test.ts for the regression-guard shape. */
  malformedToolName(): OllamaChatReply;
  /** A tool-call function name of exactly `length` characters. Three
   * shipping tools' encoded names sit at 63 of the 64-character wire cap
   * `encodeToolName` enforces (`ROUND_TRIP_LIMIT` in
   * vendor/intx/hub-sessions/src/sanitize-tool-name.ts) -- pass 63, 64,
   * and 65 to prove the boundary from both sides. */
  toolNameOfLength(length: number): OllamaChatReply;
  /** A tool-only completion carrying no `text` at all -- the turn
   * machinery must treat this as a valid tool-only round, not an empty
   * reply. */
  textlessToolCall(name: string, args?: unknown): OllamaChatReply;
  /** Valid JSON tool-call arguments that don't match the tool's declared
   * schema -- the model invented fields, renamed one, or used the wrong
   * type. */
  wrongShapedToolArgs(name: string, args: unknown): OllamaChatReply;
  /** `rawArguments` reaches the wire byte-for-byte, unlike every other
   * builder here -- the only way to script a tool call whose arguments
   * are NOT valid JSON, the shape a truncated mid-stream cutoff produces
   * on a real model. */
  truncatedToolArgs(name: string, rawArguments: string): OllamaChatReply;
  /** The model declines to answer instead of completing the turn. */
  refusal(text?: string): OllamaChatReply;
  /** A large enough text blob to exercise a truncation or blob-spill path
   * (`finishReason: "length"` -- the model hit its token cap). */
  oversized(approxChars?: number): OllamaChatReply;
  /** A plausible-but-nonexistent tool name -- a model calling `load_skill`,
   * the tool's retired name, when the canonical tool is `skills_load`. */
  hallucinatedToolName(): OllamaChatReply;
};

/**
 * Seeded canned failures a scripted `onChat` handler returns in one call --
 * every one reproduces a specific, observed way a real local model
 * misbehaved, not a hypothetical edge case. Merged onto `OllamaMock.reply`
 * so a test reaches for these exactly like `.text` / `.toolCall` /
 * `.toolCalls`: `ollama.reply.malformedToolName()`,
 * `ollama.reply.refusal()`, `ollama.reply.oversized(500_000)`.
 */
export function createAdversarialReplies(): AdversarialReplies {
  return {
    malformedToolName: () => ({
      toolCalls: [{ name: CL_6478_MALFORMED_TOOL_NAME, arguments: {} }],
      finishReason: "tool_calls",
    }),
    toolNameOfLength: (length) => ({
      toolCalls: [{ name: nameOfExactLength(length), arguments: {} }],
      finishReason: "tool_calls",
    }),
    textlessToolCall: (name, args = {}) => ({
      toolCalls: [{ name, arguments: args }],
      finishReason: "tool_calls",
    }),
    wrongShapedToolArgs: (name, args) => ({
      toolCalls: [{ name, arguments: args }],
      finishReason: "tool_calls",
    }),
    truncatedToolArgs: (name, rawArguments) => ({
      toolCalls: [{ name, arguments: undefined, rawArguments }],
      finishReason: "tool_calls",
    }),
    refusal: (text = "I can't help with that request.") => ({
      text,
      finishReason: "stop",
    }),
    oversized: (approxChars = 200_000) => ({
      text: "x".repeat(approxChars),
      finishReason: "length",
    }),
    hallucinatedToolName: () => ({
      toolCalls: [{ name: HALLUCINATED_TOOL_NAME, arguments: {} }],
      finishReason: "tool_calls",
    }),
  };
}

/**
 * Scripts one reply per turn -- turn 1 gets `replies[0]`, turn 2 gets
 * `replies[1]`, and so on; once `replies` runs out, every later turn
 * repeats the last one. Pass straight to `onChat`:
 *
 * ```ts
 * ollama.onChat(sequence([
 *   ollama.reply.malformedToolName(),
 *   ollama.reply.text("turn 2 -- does the room survive?"),
 * ]));
 * ```
 *
 * This is the shape CL-6478's "does the room survive the next turn?"
 * contract needs: script the bad turn once, then assert the room is still
 * alive on the turn after.
 */
export function sequence(
  replies: readonly OllamaChatReply[],
): (request: CapturedChatRequest) => OllamaChatReply {
  if (replies.length === 0) {
    throw new Error("sequence() needs at least one reply");
  }
  let turn = 0;
  return () => {
    const index = Math.min(turn, replies.length - 1);
    turn += 1;
    const reply = replies[index];
    if (reply === undefined) {
      throw new Error("unreachable: sequence index out of bounds");
    }
    return reply;
  };
}
