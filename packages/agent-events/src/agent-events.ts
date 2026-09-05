// Recognizers for the sidecar `agent.event` frames every folded-run
// observer keys off. `@corbits/chat`'s own process-wide orchestrator
// (replies into workbenches) subscribes to this same stream and needs
// these same two readings, so the parsing lives here, in a package it
// already builds on rather than duplicated inline. This module depends
// on nothing but
// the event shapes (`@intx/types`' `AgentEvent` union documents them;
// these readers stay structural since the stream's payload arrives as
// `unknown`), which is what keeps it importable from a browser context
// too (e.g. a future `@corbits/chat-ui` consumer).

/** The reply text of a `connector.reply` event, or undefined for any
 * other event or an empty reply. */
export function connectorReplyContent(event: unknown): string | undefined {
  if (
    typeof event !== "object" ||
    event === null ||
    (event as { type?: unknown }).type !== "connector.reply"
  ) {
    return undefined;
  }
  const content = (event as { data?: { content?: unknown } }).data?.content;
  return typeof content === "string" && content !== "" ? content : undefined;
}

/** One block of a `connector.reply`-producing turn, narrowed to the two
 * kinds a reply's chat representation must tell apart (CL-6378): visible
 * text, and a tool the model invoked. Every other `ContentBlock` variant
 * (thinking, citations, safety ratings, ...) carries no chat-part
 * equivalent yet and is left out rather than guessed at. */
export type ReplyContentBlock =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool-call";
      readonly callId: string;
      readonly name: string;
      readonly input: Record<string, unknown>;
    };

/** The ordered content blocks of an `inference.done` turn, narrowed to
 * `ReplyContentBlock`s, or undefined for any other event. This is the
 * structured alternative to `connectorReplyContent`'s flattened string:
 * reading blocks straight off `inference.done` (where the harness has
 * already separated a model's prose from its tool calls, see
 * `vendor/intx/hub-sessions/src/event-collector.ts`'s `handleInferenceDone`)
 * means a chat orchestrator building message parts never has to guess
 * which part of a reply's text was actually tool-call JSON the model
 * emitted inline — it reads the split the harness already made instead of
 * re-deriving it from prose. */
export function inferenceDoneBlocks(
  event: unknown,
): ReplyContentBlock[] | undefined {
  if (
    typeof event !== "object" ||
    event === null ||
    (event as { type?: unknown }).type !== "inference.done"
  ) {
    return undefined;
  }
  const content = (event as { data?: { turn?: { content?: unknown } } }).data
    ?.turn?.content;
  if (!Array.isArray(content)) return undefined;

  const blocks: ReplyContentBlock[] = [];
  for (const block of content as unknown[]) {
    if (typeof block !== "object" || block === null) continue;
    const typed = block as { type?: unknown };
    if (typed.type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text !== "") {
        blocks.push({ kind: "text", text });
      }
    } else if (typed.type === "tool_call") {
      const id = (block as { id?: unknown }).id;
      const name = (block as { name?: unknown }).name;
      const args = (block as { arguments?: unknown }).arguments;
      if (
        typeof id === "string" &&
        typeof name === "string" &&
        typeof args === "object" &&
        args !== null
      ) {
        blocks.push({
          kind: "tool-call",
          callId: id,
          name,
          input: args as Record<string, unknown>,
        });
      }
    }
  }
  return blocks;
}

/** A `tool.done` result, keyed by the `callId` it resolves — or undefined
 * for any other event. Pairs with `inferenceDoneBlocks`' `tool-call`
 * entries to fill in a tool-trace part's outcome once its call settles. */
export function toolDoneResult(
  event: unknown,
):
  | { callId: string; content: unknown; isError: boolean; detail?: unknown }
  | undefined {
  if (
    typeof event !== "object" ||
    event === null ||
    (event as { type?: unknown }).type !== "tool.done"
  ) {
    return undefined;
  }
  const result = (event as { data?: { result?: unknown } }).data?.result;
  if (typeof result !== "object" || result === null) return undefined;
  const callId = (result as { callId?: unknown }).callId;
  if (typeof callId !== "string") return undefined;
  const content = (result as { content?: unknown }).content;
  const isError = (result as { isError?: unknown }).isError === true;
  // `detail` rides alongside `content` on the underlying `ToolResult`
  // (`@intx/types/runtime`) as the side channel for structured metadata
  // that isn't meant for the model's own eyes — a missing-credential
  // signal (`@corbits/connections`' `parseMissingCredentialDetail`)
  // being the one caller today.
  const detail = (result as { detail?: unknown }).detail;
  return { callId, content, isError, detail };
}

export type MessageRunEnded = {
  readonly status: "completed" | "failed";
  readonly errorMessage: string | undefined;
};

/** The identity half of a `message.run.started`/`message.run.ended`
 * bracket pair — the two ids every open and close both carry. Chat's
 * orchestrator pairs them by `messageRunId` (reactor-minted per dequeue,
 * so a crash-and-replay of the same `messageId` still produces
 * unambiguous pairs) and matches `messageId` back to the dispatch mail
 * that woke the turn. Undefined for any other event. */
export type MessageRunBracket = {
  readonly messageId: string;
  readonly messageRunId: string;
};

export function messageRunBracket(
  event: unknown,
): MessageRunBracket | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const type = (event as { type?: unknown }).type;
  if (type !== "message.run.started" && type !== "message.run.ended") {
    return undefined;
  }
  const data = (
    event as { data?: { messageId?: unknown; messageRunId?: unknown } }
  ).data;
  if (
    typeof data?.messageId !== "string" ||
    typeof data?.messageRunId !== "string"
  ) {
    return undefined;
  }
  return { messageId: data.messageId, messageRunId: data.messageRunId };
}

/** A `message.run.started` bracket open — the harness's own per-message
 * start signal, minted fresh (`messageRunId`) for every dequeued
 * message, including a redelivery of the same `messageId` — or
 * undefined for any other event. Chat's orchestrator uses this to
 * re-arm its silent-turn notice per turn rather than only on a real
 * reply (see `chat-orchestrator.ts`'s `notifiedDropAddresses`). */
export function messageRunStarted(event: unknown): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { type?: unknown }).type === "message.run.started"
  );
}

/** A `message.run.ended` bracket close — the harness's own per-message
 * terminal signal (`status: "completed" | "failed"`) — or undefined for
 * any other event. */
export function messageRunEnded(event: unknown): MessageRunEnded | undefined {
  if (
    typeof event !== "object" ||
    event === null ||
    (event as { type?: unknown }).type !== "message.run.ended"
  ) {
    return undefined;
  }
  const data = (
    event as { data?: { status?: unknown; error?: { message?: unknown } } }
  ).data;
  if (data?.status !== "completed" && data?.status !== "failed") {
    return undefined;
  }
  const errorMessage =
    typeof data.error?.message === "string" ? data.error.message : undefined;
  return { status: data.status, errorMessage };
}
