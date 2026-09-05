// The chat connect card's host port for MCP presets: a token preset
// (GitHub MCP) resolves to the key-paste affordance with its docs link,
// and a submitted key rides the preset connect route — never the
// fixed-registry credential route.

import { afterEach, describe, expect, test } from "bun:test";

import { createChatConnectServiceActions } from "../src/connect-service-actions";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type RecordedCall = {
  readonly path: string;
  readonly method: string;
  readonly body?: unknown;
};

function stubFetch(respond: (path: string, method: string) => Response) {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    const method = init?.method ?? "GET";
    calls.push({
      path,
      method,
      ...(typeof init?.body === "string"
        ? { body: JSON.parse(init.body) as unknown }
        : {}),
    });
    return respond(path, method);
  }) as unknown as typeof fetch;
  return calls;
}

const PRESET_LIST = {
  data: [
    {
      slug: "github-mcp",
      displayName: "GitHub MCP",
      description: "Search code, work with issues and pull requests.",
      url: "https://api.githubcopilot.com/mcp/",
      connectionMode: "token",
      docsUrl: "https://github.com/settings/tokens",
      connected: false,
    },
  ],
};

describe("createChatConnectServiceActions with a token preset", () => {
  test("getConnectState maps a disconnected token preset to key-paste with its docs link", async () => {
    stubFetch(() => new Response(JSON.stringify(PRESET_LIST)));
    const actions = createChatConnectServiceActions("tnt_1", "/bench");

    const state = await actions.getConnectState("github-mcp");

    expect(state).toEqual({
      kind: "disconnected",
      affordance: "api-key",
      docsUrl: "https://github.com/settings/tokens",
    });
  });

  test("submitKey connects the preset with the pasted token via the mcp-servers route", async () => {
    const calls = stubFetch((_path, method) => {
      if (method === "POST") {
        return new Response(
          JSON.stringify({
            slug: "github-mcp",
            name: "GitHub MCP",
            url: "https://api.githubcopilot.com/mcp/",
            toolCount: 40,
          }),
        );
      }
      return new Response(JSON.stringify(PRESET_LIST));
    });
    const actions = createChatConnectServiceActions("tnt_1", "/bench");

    const result = await actions.submitKey("github-mcp", "ghp_pasted");

    expect(result).toEqual({ ok: true });
    const post = calls.find((call) => call.method === "POST");
    expect(post?.path).toBe("/api/tenants/tnt_1/mcp-servers");
    expect(post?.body).toMatchObject({
      presetSlug: "github-mcp",
      token: "ghp_pasted",
    });
  });

  test("a connected token preset reads back connected", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [{ ...PRESET_LIST.data[0], connected: true }],
          }),
        ),
    );
    const actions = createChatConnectServiceActions("tnt_1", "/bench");

    expect(await actions.getConnectState("github-mcp")).toEqual({
      kind: "connected",
    });
  });

  test("notifySettingsChanged re-reads subscribed connectors and fans listeners", async () => {
    let listed = PRESET_LIST;
    stubFetch(() => new Response(JSON.stringify(listed)));
    const actions = createChatConnectServiceActions("tnt_1", "/bench");
    const received: unknown[] = [];
    const unsubscribe = actions.subscribeConnectState("github-mcp", (query) => {
      received.push(query);
    });

    expect(await actions.getConnectState("github-mcp")).toEqual({
      kind: "disconnected",
      affordance: "api-key",
      docsUrl: "https://github.com/settings/tokens",
    });
    expect(received).toEqual([]);

    listed = {
      data: PRESET_LIST.data.map((entry) => ({ ...entry, connected: true })),
    };
    await actions.notifySettingsChanged();

    expect(received).toEqual([{ kind: "connected" }]);
    unsubscribe();
  });
});
