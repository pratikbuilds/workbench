// A recorded MCP fake's fixture shape (CL-6338): what tools an
// external MCP server (GitHub, Attio, Sumble, ...) advertises, and the
// canned `(tool, arguments) -> response` pairs a fake stood up from
// `startMcpFake` (./mcp-fake-server.ts) replays. Checked into the repo
// as plain JSON under `recordings/` — deterministic and reviewable in
// a PR diff, the same "record-as-truth JSON, no migration" convention
// other product JSON columns already use.
import { type } from "arktype";

export interface RecordedCall {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly response: { readonly isError: boolean; readonly content: unknown };
}

export interface McpFakeToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

/** Matched by (tool, arguments) equality; first match wins, exact-match
 * only — an unrecorded call is a hard fixture gap the fake fails loudly
 * on, never silently defaulted (see mcp-fake-server.ts). */
export interface McpFakeRecording {
  readonly server: string;
  readonly tools: readonly McpFakeToolDefinition[];
  readonly calls: readonly RecordedCall[];
}

const RecordedCallSchema = type({
  tool: "string",
  arguments: "Record<string, unknown>",
  response: {
    isError: "boolean",
    content: "unknown",
  },
});

const McpFakeToolDefinitionSchema = type({
  name: "string",
  "description?": "string",
  inputSchema: "Record<string, unknown>",
});

const McpFakeRecordingSchema = type({
  server: "string",
  tools: McpFakeToolDefinitionSchema.array(),
  calls: RecordedCallSchema.array(),
});

/** Parses untrusted JSON (a fixture file read off disk) into a
 * `McpFakeRecording` — the trust-boundary check every external-data
 * read in this repo goes through, never a bare `as McpFakeRecording`. */
export function parseMcpFakeRecording(data: unknown): McpFakeRecording {
  const parsed = McpFakeRecordingSchema(data);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid MCP fake recording: ${parsed.summary}`);
  }
  return parsed;
}
