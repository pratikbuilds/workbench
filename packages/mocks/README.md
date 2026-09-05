# @corbits/mocks

Deterministic mocks of the inference boundary — local providers first —
built to be consumed by our own tests, not adopted off the shelf. Three of
last night's worst defects (`tools: []` reaching the model with no
conversation history — CL-6448; a hallucinated tool name bricking a room —
CL-6478; `embeddinggemma` winning the chat default — CL-6477) lived at this
boundary and were only found by hand-building a logging proxy in front of
Ollama at 2am. This package turns each of those into a permanent CI
regression test with no GPU involved.

## Design bar

- **1:1 with how we actually consume providers**, not a kitchen sink. No
  video/TTS/vector-DB surface we will never call.
- **Tree-shakeable and pluggable.** Every provider is its own entry point —
  `@corbits/mocks/ollama` today — so a consumer imports only the provider it
  mocks. The package root (`@corbits/mocks`, no subpath) exports nothing —
  it exists only so the workspace's package-hygiene check has a bare
  import to resolve; it is not a barrel and never gains provider imports.
- **Assert on what we SEND, not just what comes back.** Every request the
  mock receives is captured and exposed through readable assertion methods
  — `expectModel`, `expectToolsDeclared`, `expectMessageRoles`,
  `expectHistoryContains` — instead of a test hand-digging through raw JSON.
- **Usable in-process and as a server.** `OllamaMock#fetch` is a plain
  Fetch-API handler a unit test wires directly into a `fetchImpl`, with no
  network involved. `OllamaMock#listen()` starts a real HTTP server on an
  ephemeral port for the e2e path, where the stack is pointed at an Ollama
  origin via env.

## Quickstart: `@corbits/mocks/ollama`

```ts
import { createOllamaMock } from "@corbits/mocks/ollama";

const ollama = createOllamaMock({
  models: [
    { name: "qwen3.8:27b", capabilities: ["completion", "tools"] },
    { name: "embeddinggemma:300m", capabilities: ["embedding"] },
  ],
});

// In-process: no network, no port. Wire ollama.fetch straight into
// whatever `fetchImpl` seam your code under test already accepts
// (testProviderCredential, fetchOllamaModelCatalog, the openai adapter's
// own fetch, ...).
const result = await testProviderCredential({
  provider: "ollama",
  apiKey: OLLAMA_PLACEHOLDER_SECRET,
  fetchImpl: ollama.fetch,
});

// As a server: for e2e, point the stack's OLLAMA_BASE_URL at this instead.
const server = await ollama.listen();
process.env.OLLAMA_BASE_URL = server.url;
// ...run the real stack...
await server.close();
```

### Scripting the model catalogue (CL-6477's shape)

`GET /api/tags` and `POST /api/show` are served straight off the
`models` you hand the mock — no need to pull a real model to test
model-selection logic:

```ts
const ollama = createOllamaMock({
  models: [
    { name: "embeddinggemma:300m", capabilities: ["embedding"] },
    { name: "qwen3.8:27b", capabilities: ["completion", "tools"] },
  ],
});

// preferCompletionCapable / hasCompletionCapableModel now have real,
// wire-shaped capability data to filter on, with no live Ollama instance.
```

### Scripting a chat reply

```ts
ollama.onChat((request) => {
  // `request` is the CapturedChatRequest this exact call received —
  // branch on it if the reply should depend on what was sent.
  return request.messages.some((m) => m.content.includes("book a flight"))
    ? ollama.reply.toolCall("search_flights", { origin: "SFO" })
    : ollama.reply.text("how can I help?");
});
```

`ollama.reply` covers the two shapes a real completion-capable model
returns: `.text(string)` for a plain assistant turn, `.toolCall(name, args)`
/ `.toolCalls([...])` for the tool-call branch. Both streaming
(`stream: true`, SSE chunks terminated with `data: [DONE]`) and
non-streaming requests are answered from the same scripted reply — the
mock reads `stream` off the request, the test never has to pick a
different handler for each.

### Asserting on the request (the highest-value half)

```ts
const request = ollama.requests.last();

// Would have caught CL-6448 D2 outright: tools: [] reaching the model.
request.expectToolsDeclared(["create_agent", "send_message"]);

// Pins the model actually dialed — catches a silent fallback to the
// adapter's default instead of the tenant's pinned choice.
request.expectModel("qwen3.8:27b");

// Would have caught CL-6448 D3: history collapsed to [system, latest user].
request.expectMessageRoles(["system", "user", "assistant", "user"]);

// Or, when only part of the history matters:
request.expectHistoryContains([
  { role: "system" },
  { role: "user", content: "book me a flight" },
  { role: "tool" },
]);
```

See `src/ollama/cl-6448-demo.test.ts` for the full demonstration: the same
assertions failing against CL-6448's broken request shape, and passing
once tools and history are actually sent.

### The adversarial output catalogue (CL-6478's shape)

Real local models misbehave in specific, repeatable ways. Every scenario
below reproduces one we actually hit — not a hypothetical edge case —
selectable in one line straight off `ollama.reply`, exactly like `.text`
and `.toolCall`:

```ts
ollama.onChat(() => ollama.reply.malformedToolName());
```

| Scenario                            | What it reproduces                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `.malformedToolName()`              | CL-6478's flagship case: `qwen3.8:27b` leaked `\n</parameter` into a tool-call function name.              |
| `.toolNameOfLength(n)`              | A tool name of exactly `n` characters — pass 63, 64, 65 to prove the boundary three shipping tools sit at. |
| `.textlessToolCall(name, args?)`    | An `inference.done` with no text at all — a tool-only round, not an empty reply.                           |
| `.wrongShapedToolArgs(name, args)`  | Valid JSON tool-call arguments that don't match the declared schema.                                       |
| `.truncatedToolArgs(name, rawArgs)` | Arguments that are NOT valid JSON — a mid-stream cutoff, reaching the wire byte-for-byte.                  |
| `.refusal(text?)`                   | The model declines to answer.                                                                              |
| `.oversized(approxChars?)`          | A large enough text blob to exercise a truncation or blob-spill path.                                      |
| `.hallucinatedToolName()`           | A model calling `load_skill` instead of the canonical `skills_load`.                                       |

`sequence([...])` scripts one reply per turn — turn 1 malformed, turn 2
normal — so CL-6478's "does the room survive?" contract is directly
testable:

```ts
import { sequence } from "@corbits/mocks/ollama";

ollama.onChat(
  sequence([
    ollama.reply.malformedToolName(),
    ollama.reply.text("turn 2 — does the room survive?"),
  ]),
);
```

CL-6478's real fix — `sanitizeToolNameForPersistence` in
`vendor/intx/hub-sessions/src/sanitize-tool-name.ts` — collapses a name
`@intx/inference`'s `encodeToolName` cannot round-trip to a stable
placeholder before it is ever persisted, so one bad tool-call name can
never wedge a room forever. `src/ollama/cl-6478-demo.test.ts` demonstrates
that regression-guard shape at this mock layer: a turn assembler that
persists the malformed name unchanged carries it straight into the next
turn's history. Wiring an equivalent guard through the real hub-sessions
turn assembler is a follow-up — this package proves the shape, it does not
(yet) replace that test.

## API shape

| Export                                                                                                                                                                           | What it's for                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `createOllamaMock(options?)`                                                                                                                                                     | Builds one mock instance. `options.models` seeds the `/api/tags` catalogue.  |
| `mock.fetch`                                                                                                                                                                     | A `(Request) => Promise<Response>` handler — the in-process path.            |
| `mock.listen(port?)`                                                                                                                                                             | Starts a real Bun HTTP server; returns `{ url, close() }` — the server path. |
| `mock.setModels(models)`                                                                                                                                                         | Rewrites the catalogue mid-test (a connect flow that re-reads it).           |
| `mock.onChat(handler)`                                                                                                                                                           | Scripts every subsequent `/v1/chat/completions` reply.                       |
| `mock.reply.text` / `.toolCall` / `.toolCalls`                                                                                                                                   | Builds an `OllamaChatReply` for a handler to return.                         |
| `mock.requests`                                                                                                                                                                  | The `CapturedRequestLog` — `.all`, `.count`, `.last()`, `.clear()`.          |
| `CapturedChatRequest`                                                                                                                                                            | One captured request: `.model`, `.tools`, `.messages`, plus every `expect*`. |
| `mock.reply.malformedToolName` / `.toolNameOfLength` / `.textlessToolCall` / `.wrongShapedToolArgs` / `.truncatedToolArgs` / `.refusal` / `.oversized` / `.hallucinatedToolName` | The adversarial output catalogue — see above.                                |
| `sequence(replies)`                                                                                                                                                              | Scripts one reply per turn for `onChat`; repeats the last once exhausted.    |

Routes covered: `GET /api/tags` (native catalogue), `POST /api/show`
(per-model capability probe), `POST /v1/chat/completions`
(openai-compatible chat, tool calls, streaming and non-streaming) — the
exact three endpoints `@corbits/connections`'s `credential-test.ts` and
the openai adapter's request-building actually call. No `/api/generate`,
`/api/embeddings`, or anything else Ollama exposes that we don't.

## Roadmap (not in this unit)

- **OpenAI-compatible and Anthropic provider mocks** — `@corbits/mocks/openai`
  and `@corbits/mocks/anthropic`, same request-capture and reply-scripting
  API shape as this one.
- **Wiring the CL-6478 regression guard through the real turn
  assembler** — `cl-6478-demo.test.ts` demonstrates the shape at this mock
  layer only; an equivalent test exercising `@workbench/hub-sessions`'s
  actual turn assembly (vendored, out of scope for this unit) is next.
- **Converging the scattered fakes** — `packages/evals`' github MCP fake
  and its stub inference harness should be rebuilt on top of this package
  rather than living on beside it.
