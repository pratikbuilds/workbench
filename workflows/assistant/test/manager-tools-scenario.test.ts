// A scripted playback of the owner's canonical GTM scenario (CL-5879
// manager-tools follow-up), exercised directly against the manager-tools
// bundles' `run()` with a single fake `fetch` standing in for every
// workflow-run-authenticated route those bundles call. This proves the
// CONTRACT across packages — a tool call's request shape matches what
// each route expects, and a route's response shape matches what each
// client parses — end to end through real bundle code, with no model
// or hub process involved.
//
// What this test does NOT prove: that a live model, given the assistant
// system prompt, actually chooses this tool sequence on its own. That is
// an [Intx/repo gap] this suite cannot close — it requires a live
// inference call (or at minimum a recorded transcript against a real
// model), which is out of scope for a unit suite. What IS proven here,
// honestly: every tool call this scenario needs is wired, its inputs
// are accepted by the real route contracts, and outputs from one step
// (a newly created agent's id) flow correctly into the next step's
// input (that agent is minted its own 1:1 chat) — the exact mechanical
// chain a model would need to walk.
//
// Scenario played back (owner's script) against three connectors that
// are registered (Exa, Granola, Linear). A connector name that is
// neither a fixed `CONNECTOR_REGISTRY` entry nor a curated MCP preset
// is separately asserted to be honestly rejected (fail-closed against
// the real registry, never a fabricated connector).
//   1. Myra is asked to set up a GTM sales motion.
//   2. She checks which connections exist; none of Exa/Granola/Linear
//      are connected, so she hands over connect links for each.
//   3. Once the human connects them (simulated: the fake connections
//      state flips to connected), she creates two specialist agents —
//      a call-notes extractor and a weekly-analytics agent — minting
//      each specialist its own 1:1 chat (never inviting into Myra's).
import { expect, test } from "bun:test";
import type { ToolCall } from "@intx/types/runtime";

import {
  connectionsTools,
  LIST_CONNECTIONS_TOOL,
  REQUEST_CONNECTION_TOOL,
  type WorkflowConnectionEnv,
} from "@corbits/connections-tools";
import {
  agentDirectoryTools,
  CREATE_AGENT_TOOL,
  type WorkflowAgentDirectoryEnv,
} from "@corbits/agent-directory-tools";

const HUB = "https://hub.example.com";

function call(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ToolCall {
  return { id, name, arguments: args };
}

/** Minimal in-memory hub double: tracks which connectors are connected
 * and which agent definitions have been created, and routes every
 * request the two bundles under test can issue to the exact response
 * shape their own clients parse. Any request this fake doesn't
 * recognize fails the test loudly (thrown 404), rather than silently
 * returning something a real hub never would. */
function createFakeHub() {
  const connected = new Set<string>();
  const createdDefinitions: { id: string; name: string }[] = [];
  const mintedDefinitionIds: string[] = [];
  const invitedDefinitionIds: string[] = [];
  const postedCards: {
    connectorId: string;
    displayName: string;
    reason: string;
  }[] = [];

  // Mirrors the real `CONNECTOR_REGISTRY` entries for these three ids
  // (`packages/connections/src/registry.ts`) closely enough for this
  // route double; `request_connection` itself validates against the
  // REAL registry, not this list, so the fail-closed assertion below is
  // still testing real code.
  const registry = [
    { id: "exa", displayName: "Exa", docsUrl: "https://exa.ai/docs" },
    { id: "granola", displayName: "Granola", docsUrl: "https://granola.ai" },
    { id: "linear", displayName: "Linear", docsUrl: "https://linear.app/docs" },
  ];

  const fetchImpl = (async (
    input: string | Request | URL,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;

    if (
      url.pathname === "/api/workflow-connections/connections" &&
      method === "GET"
    ) {
      return Response.json({
        data: registry.map((entry) => ({
          ...entry,
          connected: connected.has(entry.id),
        })),
      });
    }

    if (
      url.pathname === "/api/workflow-connections/mcp-servers" &&
      method === "GET"
    ) {
      return Response.json({ data: [] });
    }

    if (
      url.pathname === "/api/workflow-agent-directory/definitions" &&
      method === "POST" &&
      body
    ) {
      const id = `def_${String(createdDefinitions.length + 1)}`;
      createdDefinitions.push({ id, name: body["name"] as string });
      return Response.json(
        {
          id,
          name: body["name"],
          description: null,
          currentVersion: "1",
          status: "deployed",
          skills: [],
          modelNote: null,
        },
        { status: 201 },
      );
    }

    if (
      url.pathname === "/api/workflow-chat/participants/messages" &&
      method === "POST" &&
      body
    ) {
      // The connect-service card post `request_connection` (CL-6393)
      // makes into the caller's own room. Recorded so the scenario can
      // assert the card itself, not just the tool's advice text.
      const parts = body["parts"] as {
        kind: string;
        block: { type: string; data: Record<string, unknown> };
      }[];
      const block = parts[0]?.block;
      if (parts[0]?.kind !== "block" || block?.type !== "connect-service") {
        throw new Error("fake hub: expected one connect-service block part");
      }
      postedCards.push({
        connectorId: block.data["connectorId"] as string,
        displayName: block.data["displayName"] as string,
        reason: block.data["reason"] as string,
      });
      return Response.json(
        {
          id: `msg_${String(postedCards.length)}`,
          createdAt: "2026-08-16T00:00:00.000Z",
        },
        { status: 201 },
      );
    }

    if (
      url.pathname === "/api/workflow-chat/participants/mint-dm" &&
      method === "POST" &&
      body
    ) {
      const definitionId = body["definitionId"] as string;
      mintedDefinitionIds.push(definitionId);
      return Response.json(
        {
          workbenchId: `wb_${definitionId}`,
          address: `${definitionId}@workflow`,
          definitionId,
          handle: definitionId,
        },
        { status: 201 },
      );
    }

    if (
      url.pathname === "/api/workflow-chat/participants/invite" &&
      method === "POST" &&
      body
    ) {
      const definitionId = body["definitionId"] as string;
      invitedDefinitionIds.push(definitionId);
      return Response.json(
        {
          address: `${definitionId}@workflow`,
          definitionId,
          handle: definitionId,
        },
        { status: 201 },
      );
    }

    throw new Error(`fake hub: unhandled ${method} ${url.pathname}`);
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    connected,
    createdDefinitions,
    invitedDefinitionIds,
    mintedDefinitionIds,
    postedCards,
  };
}

test("GTM scenario: connect three services, then create two specialist agents", async () => {
  const hub = createFakeHub();

  // None of these two bundles' `WorkflowXEnv` types expose a
  // `fetchImpl` test seam (only their `client.ts`'s own config type
  // does, never threaded from `env`) — the established pattern this
  // repo's other tool-bundle tests use instead (see
  // `packages/capability-tools/src/tool.test.ts`) is to monkey-patch
  // `globalThis.fetch` for the call, restored in a `finally`.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = hub.fetchImpl;
  try {
    await runScenario(hub);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function runScenario(
  hub: ReturnType<typeof createFakeHub>,
): Promise<void> {
  const connectionsEnv: WorkflowConnectionEnv = {
    hubConnectionsUrl: HUB,
    sidecarToken: "sc-token",
    address: "run_myra@workflow",
  } as unknown as WorkflowConnectionEnv;
  const agentDirectoryEnv: WorkflowAgentDirectoryEnv = {
    hubAgentDirectoryUrl: HUB,
    hubChatUrl: HUB,
    sidecarToken: "sc-token",
    address: "run_myra@workflow",
  } as unknown as WorkflowAgentDirectoryEnv;

  // Step 2: Myra checks what's connected — nothing is, yet.
  const connectionsBundle = connectionsTools(connectionsEnv);
  const initialList = await connectionsBundle.run(
    call("c1", LIST_CONNECTIONS_TOOL, {}),
    new AbortController().signal,
  );
  expect(initialList.isError).toBe(false);
  expect(String(initialList.content)).toContain("Exa");
  expect(String(initialList.content)).toContain("Connected: none.");

  // A connector name that is neither a fixed `CONNECTOR_REGISTRY`
  // entry, a curated MCP preset, nor a connected MCP server makes
  // `request_connection` tell the agent to keep helping with what it
  // can do (CL-6393) — never "go add a server and report back".
  const unknown = await connectionsBundle.run(
    call("req_unknown", REQUEST_CONNECTION_TOOL, { connector: "acmecrm" }),
    new AbortController().signal,
  );
  expect(unknown.isError).toBe(false);
  expect(String(unknown.content)).toContain("acmecrm");
  expect(String(unknown.content)).not.toContain("name and URL");
  expect(hub.postedCards).toHaveLength(0);

  // She puts a connect card in the room for each of the three (real)
  // services (CL-6393) — the card is what the human clicks; the tool
  // result only tells Myra to keep helping in the meantime.
  for (const connector of ["exa", "granola", "linear"]) {
    const result = await connectionsBundle.run(
      call(`req_${connector}`, REQUEST_CONNECTION_TOOL, { connector }),
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(String(result.content)).toMatch(/card/i);
    expect(String(result.content)).toMatch(/keep helping/i);
  }
  expect(hub.postedCards.map((card) => card.connectorId)).toEqual([
    "exa",
    "granola",
    "linear",
  ]);
  expect(hub.postedCards.map((card) => card.displayName)).toEqual([
    "Exa",
    "Granola",
    "Linear",
  ]);
  for (const card of hub.postedCards) {
    expect(card.reason.length).toBeGreaterThan(0);
  }

  // Human connects all three (simulated).
  hub.connected.add("exa");
  hub.connected.add("granola");
  hub.connected.add("linear");

  const afterConnect = await connectionsBundle.run(
    call("c2", LIST_CONNECTIONS_TOOL, {}),
    new AbortController().signal,
  );
  expect(String(afterConnect.content)).toContain(
    "Not connected: GitHub MCP, Notion, Sentry, Attio, Railway, PostHog, Sumble, Canva.",
  );
  expect(String(afterConnect.content)).toContain(
    "Connected: Granola, Exa, Linear.",
  );

  // Step 3: Myra creates the two specialist agents she needs, minting
  // each its own 1:1 chat (the tool's default).
  const agentDirectoryBundle = agentDirectoryTools(agentDirectoryEnv);
  const callNotesAgent = await agentDirectoryBundle.run(
    call("a1", CREATE_AGENT_TOOL, {
      name: "Call Notes Extractor",
      systemPrompt:
        "Extract structured notes and action items from Granola call " +
        "transcripts and summarize them for the team.",
    }),
    new AbortController().signal,
  );
  expect(callNotesAgent.isError).toBe(false);
  const analyticsAgent = await agentDirectoryBundle.run(
    call("a2", CREATE_AGENT_TOOL, {
      name: "Weekly Analytics",
      systemPrompt:
        "Produce a weekly analytical rollup of sales-motion activity " +
        "for the team.",
    }),
    new AbortController().signal,
  );
  expect(analyticsAgent.isError).toBe(false);

  expect(hub.createdDefinitions.map((d) => d.name)).toEqual([
    "Call Notes Extractor",
    "Weekly Analytics",
  ]);
  // Both got their own chat (the default), never invited into Myra's.
  expect(hub.mintedDefinitionIds).toEqual(
    hub.createdDefinitions.map((d) => d.id),
  );
  expect(hub.invitedDefinitionIds).toEqual([]);
}
