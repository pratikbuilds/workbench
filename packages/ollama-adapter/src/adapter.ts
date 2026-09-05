// The `ollama` provider adapter: the built-in OpenAI Chat Completions
// adapter (SSE parsing, retry/pacing header extraction, message
// marshaling — all unmodified), wrapped so `buildRequest` applies
// operator-configured overrides onto the request body before it ships.
//
// Ollama's openai-compatible `/v1/chat/completions` endpoint takes
// `max_tokens` (mapped internally to Ollama's native `num_predict`) but has
// no OpenAI-shaped field for context window — that rides through the
// endpoint's `options` passthrough object as `options.num_ctx`, exactly
// like a native `/api/chat` call. A silently-dropped `num_ctx` (set on the
// wrong field, or as a top-level key the endpoint ignores) is the failure
// mode this adapter exists to rule out. Reasoning effort rides through the
// same `reasoning_effort` field Ollama already recognizes for gpt-oss
// models on this endpoint.
import { createOpenAIAdapter } from "@intx/inference/providers";
import type {
  AdapterFactory,
  BuiltRequest,
  ProviderAdapter,
} from "@intx/inference";
import type {
  InferenceEvent,
  LastCycleSource,
  TokenUsage,
} from "@intx/types/runtime";

import {
  parseOllamaAdapterConfig,
  resolveOverride,
  type OllamaAdapterOverride,
} from "./overrides";
import { createThinkSplitState, reclassifyThinkingEvents } from "./think-tags";
import {
  createInlineToolJsonState,
  reclassifyInlineToolJsonEvents,
  responseChunkIsTerminal,
  setDeclaredToolNames,
} from "./inline-tool-json";

type OllamaChatBody = {
  options?: Record<string, unknown>;
  max_tokens?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  stream_options?: { include_usage: boolean };
};

function applyOverride(
  built: BuiltRequest,
  override: OllamaAdapterOverride,
): BuiltRequest {
  const body = JSON.parse(built.body) as OllamaChatBody;
  // Without include_usage, Ollama's OpenAI-compat stream often ends with no
  // usage object; the harness then synthesizes zero token counts that Insights
  // used to display as Cost $0.00 / 0/0 (CL-6659).
  body.stream_options = { include_usage: true };
  if (override.numCtx !== undefined) {
    body.options = { ...body.options, num_ctx: override.numCtx };
  }
  if (override.maxOutputTokens !== undefined) {
    // The built-in adapter already set whichever of these two fields its
    // quirks resolved to; overwrite that same field rather than assuming
    // one, so the override wins regardless of which one is in play.
    if (body.max_completion_tokens !== undefined) {
      body.max_completion_tokens = override.maxOutputTokens;
    } else {
      body.max_tokens = override.maxOutputTokens;
    }
  }
  if (override.reasoningEffort !== undefined) {
    body.reasoning_effort = override.reasoningEffort;
  }
  return { ...built, body: JSON.stringify(body) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function openaiShapedUsage(value: unknown): TokenUsage | null {
  if (!isPlainObject(value)) return null;
  const input = asNonNegativeInt(value["prompt_tokens"]);
  const output = asNonNegativeInt(value["completion_tokens"]);
  if (input === null && output === null) return null;
  const details = value["prompt_tokens_details"];
  const completionDetails = value["completion_tokens_details"];
  const cacheRead = isPlainObject(details)
    ? asNonNegativeInt(details["cached_tokens"])
    : null;
  const thinking = isPlainObject(completionDetails)
    ? asNonNegativeInt(completionDetails["reasoning_tokens"])
    : null;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: 0,
    thinking: thinking ?? 0,
  };
}

function ollamaTokenUsageFromChunk(raw: string): TokenUsage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;
    const fromUsage = openaiShapedUsage(parsed["usage"]);
    if (fromUsage !== null) return fromUsage;
    const input = asNonNegativeInt(parsed["prompt_eval_count"]);
    const output = asNonNegativeInt(parsed["eval_count"]);
    if (input === null && output === null) return null;
    return {
      input: input ?? 0,
      output: output ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    };
  } catch {
    // report-error-ignore: a non-JSON SSE chunk is the common case, not a
    // failure — this function is "usage if present", never an error path.
    return null;
  }
}

function withOllamaUsage(
  events: readonly InferenceEvent[],
  raw: string,
  source: LastCycleSource,
): InferenceEvent[] {
  if (events.some((event) => event.type === "inference.usage")) {
    return [...events];
  }
  const usage = ollamaTokenUsageFromChunk(raw);
  if (usage === null) return [...events];
  return [
    ...events,
    {
      type: "inference.usage",
      seq: 0,
      data: { usage, source },
    },
  ];
}

/**
 * `AdapterFactory` for the `ollama` provider key, the named export a
 * `SIDECAR_ADAPTER_MANIFEST` entry points at. `quirks` is this package's
 * own {@link OllamaAdapterConfig} (an `InferenceSource.quirks` bag), not
 * the built-in adapter's `OpenAIQuirks` — the wrapped adapter is
 * constructed with no quirks of its own, so its request/response handling
 * is exactly the shipped default except for this override pass.
 */
export const createOllamaAdapter: AdapterFactory = (
  source: LastCycleSource,
  quirks?: unknown,
): ProviderAdapter => {
  const config = parseOllamaAdapterConfig(quirks);
  const inner = createOpenAIAdapter(source);
  // One split state per adapter instance: the registry resolves a fresh
  // adapter per request (see `createAdapterRegistry`'s own doc comment),
  // so this safely tracks "are we inside a `<think>` span" across every
  // chunk of one response without leaking state between requests.
  const streamThinkState = createThinkSplitState();
  const jsonThinkState = createThinkSplitState();
  const streamInlineState = createInlineToolJsonState();
  const jsonInlineState = createInlineToolJsonState();
  return {
    ...inner,
    buildRequest: (messages, model, options) => {
      setDeclaredToolNames(streamInlineState, options.tools);
      setDeclaredToolNames(jsonInlineState, options.tools);
      return applyOverride(
        inner.buildRequest(messages, model, options),
        resolveOverride(config, model),
      );
    },
    parseResponse: (sseData) =>
      withOllamaUsage(
        reclassifyInlineToolJsonEvents(
          reclassifyThinkingEvents(
            inner.parseResponse(sseData),
            streamThinkState,
          ),
          streamInlineState,
          { flush: responseChunkIsTerminal(sseData) },
        ),
        sseData,
        source,
      ),
    parseJSONResponse: (body) =>
      withOllamaUsage(
        reclassifyInlineToolJsonEvents(
          reclassifyThinkingEvents(
            inner.parseJSONResponse(body),
            jsonThinkState,
          ),
          jsonInlineState,
          { flush: true },
        ),
        body,
        source,
      ),
  };
};
