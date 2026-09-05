// CL-6476: an out-of-band `chat.settings` (credential settled elsewhere)
// must reach every `subscribeConnectState` listener through the host's
// own refresh — never only on the card's next mount.

import { afterEach, describe, expect, test } from "bun:test";
import type { ConnectGithubQuery } from "@corbits/chat-ui";

import { createChatConnectGithubActions } from "../src/connect-github-actions";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const DISCONNECTED = { kind: "disconnected" as const };
const CONNECTED = {
  kind: "connected" as const,
  orgName: "octocat",
  repos: [{ id: "1", name: "acme/widgets" }],
  selectedRepoIds: [] as string[],
};

function stubGithubState(state: () => unknown) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.endsWith("/github/state")) {
      return new Response(JSON.stringify(state()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unstubbed fetch: ${path}`);
  }) as typeof fetch;
}

describe("createChatConnectGithubActions notifySettingsChanged", () => {
  test("refresh fans the latest getConnectState to every subscriber", async () => {
    let wire = DISCONNECTED as unknown;
    stubGithubState(() => wire);
    const actions = createChatConnectGithubActions("tnt_1", "wb_1");
    const received: ConnectGithubQuery[] = [];
    const unsubscribe = actions.subscribeConnectState("m1", (state) => {
      received.push(state);
    });

    expect(await actions.getConnectState("m1")).toEqual(DISCONNECTED);
    expect(received).toEqual([]);

    wire = CONNECTED;
    await actions.notifySettingsChanged();

    expect(received).toEqual([CONNECTED]);
    unsubscribe();
  });
});
