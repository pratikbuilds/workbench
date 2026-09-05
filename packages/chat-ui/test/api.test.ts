// The chat API client, tested at our wiring the same way test/auth.test.tsx
// tests session.ts: stub global fetch, call the exported function, assert
// both the request it made and how it parses the response.

import { afterEach, describe, expect, test } from "bun:test";

import { UnauthenticatedError } from "@corbits/api-query";
import { InferenceSettingsApiError } from "@corbits/inference-settings";
import {
  ChatApiError,
  createWorkbench,
  describeChatError,
  runDisplayName,
  inviteAgent,
  JIMMY_QUICK_CREATE,
  listWorkbenches,
  listAllWorkbenches,
  listRuns,
  listInvitableDefinitions,
  listTenantInvitableDefinitions,
  listVisibleAgentDefinitions,
  listWorkbenchAgents,
  openAgentDm,
  listMessages,
  listPinnedMessages,
  quickCreateJimmy,
  sendMessage,
  fetchWorkbenchBlob,
  getWorkbenchSettings,
  patchWorkbenchSettings,
  getBenchChatSettings,
  patchBenchChatSettings,
  pinMessage,
  postWorkbenchOnboardingStep,
  toggleReaction,
  unpinMessage,
} from "../src/api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type RecordedCall = { readonly path: string; readonly init?: RequestInit };

function stubFetch(respond: (path: string) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    calls.push(init === undefined ? { path } : { path, init });
    return Promise.resolve(respond(path));
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("listWorkbenches", () => {
  test("fetches the tenant's workbenches filtered by kind and parses the envelope", async () => {
    const calls = stubFetch(() =>
      json({
        items: [
          {
            id: "c1",
            title: "General",
            kind: "workbench",
            pinned: true,
            participants: [],
          },
        ],
      }),
    );
    const workbenches = await listWorkbenches("tenant_1", "workbench");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/workbenches?kind=workbench",
    );
    expect(workbenches).toEqual([
      {
        id: "c1",
        title: "General",
        kind: "workbench",
        pinned: true,
        participants: [],
      },
    ]);
  });

  test("parses a row's own workbench tenancy, and a legacy row's null", async () => {
    const calls = stubFetch(() =>
      json({
        items: [
          {
            id: "c1",
            title: "General",
            kind: "workbench",
            pinned: true,
            participants: [],
            tenancy: { tenantId: "tnt_1" },
          },
          {
            id: "c2",
            title: "Legacy",
            kind: "workbench",
            pinned: false,
            participants: [],
            tenancy: null,
          },
        ],
      }),
    );
    const workbenches = await listWorkbenches("tenant_1", "workbench");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/workbenches?kind=workbench",
    );
    expect(workbenches[0]?.tenancy).toEqual({ tenantId: "tnt_1" });
    expect(workbenches[1]?.tenancy).toBeNull();
  });

  test("throws a ChatApiError on a malformed response", async () => {
    stubFetch(() => json({ items: [{ id: "c1" }] }));
    await expect(listWorkbenches("tenant_1", "chat")).rejects.toBeInstanceOf(
      ChatApiError,
    );
  });

  test("throws an UnauthenticatedError on 401", async () => {
    stubFetch(() => json(null, 401));
    await expect(listWorkbenches("tenant_1", "chat")).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });
});

describe("listAllWorkbenches", () => {
  test("fetches every workbench kind with no kind query param", async () => {
    const calls = stubFetch(() =>
      json({
        items: [
          {
            id: "c1",
            title: "General",
            kind: "workbench",
            pinned: true,
            participants: [],
          },
          {
            id: "c2",
            title: "echo",
            kind: "chat",
            pinned: false,
            participants: [],
          },
        ],
      }),
    );
    const workbenches = await listAllWorkbenches("tenant_1");
    expect(calls[0]?.path).toBe("/api/tenants/tenant_1/chat/workbenches");
    expect(workbenches.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});

describe("createWorkbench", () => {
  test("posts the name and kind and returns the created workbench", async () => {
    const calls = stubFetch(() =>
      json(
        {
          id: "c2",
          title: "Ops",
          kind: "workbench",
          pinned: true,
          participants: [],
        },
        201,
      ),
    );
    const workbench = await createWorkbench("tenant_1", {
      kind: "workbench",
      name: "Ops",
    });
    expect(calls[0]?.path).toBe("/api/tenants/tenant_1/chat/workbenches");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      kind: "workbench",
      name: "Ops",
    });
    expect(workbench.id).toBe("c2");
  });

  test("posts the definitionId (and no name) for a chat with no explicit name", async () => {
    const calls = stubFetch(() =>
      json(
        {
          id: "c3",
          title: "echo",
          kind: "chat",
          pinned: false,
          participants: [],
        },
        201,
      ),
    );
    const workbench = await createWorkbench("tenant_1", {
      kind: "chat",
      definitionId: "wfd_echo",
    });
    expect(calls[0]?.path).toBe("/api/tenants/tenant_1/chat/workbenches");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      kind: "chat",
      definitionId: "wfd_echo",
    });
    // With no explicit name, the server titles the chat by the agent's
    // handle — the client sends no name at all rather than guessing one.
    expect(workbench.title).toBe("echo");
  });

  test("posts the definitionId alongside an explicit name for a chat", async () => {
    const calls = stubFetch(() =>
      json(
        {
          id: "c4",
          title: "My research chat",
          kind: "chat",
          pinned: false,
          participants: [],
        },
        201,
      ),
    );
    await createWorkbench("tenant_1", {
      kind: "chat",
      definitionId: "wfd_echo",
      name: "My research chat",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      kind: "chat",
      definitionId: "wfd_echo",
      name: "My research chat",
    });
  });
});

describe("sendMessage", () => {
  test("posts { parts } with the TextPart payload", async () => {
    const calls = stubFetch(() =>
      json({ id: "m1", createdAt: "2026-01-01T00:00:00.000Z" }, 201),
    );
    await sendMessage("tenant_1", "chan_1", [{ kind: "text", text: "hello" }]);
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/workbenches/chan_1/messages",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      parts: [{ kind: "text", text: "hello" }],
    });
  });

  test("includes threadId when posting into a thread", async () => {
    const calls = stubFetch(() =>
      json(
        {
          id: "m1",
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: "thr_1",
        },
        201,
      ),
    );
    await sendMessage("tenant_1", "chan_1", [{ kind: "text", text: "reply" }], {
      threadId: "thr_1",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      parts: [{ kind: "text", text: "reply" }],
      threadId: "thr_1",
    });
  });
});

describe("listMessages", () => {
  test("decodes a mixed-kind message list", async () => {
    stubFetch(() =>
      json({
        items: [
          {
            id: "m1",
            createdAt: "2026-01-01T00:00:00.000Z",
            parts: [{ kind: "text", text: "hi" }],
            sender: { name: null, address: "someone@agents.example" },
          },
        ],
      }),
    );
    const page = await listMessages("tenant_1", "chan_1");
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.parts[0]).toEqual({ kind: "text", text: "hi" });
  });

  test("decodes a message's sender", async () => {
    stubFetch(() =>
      json({
        items: [
          {
            id: "m2",
            createdAt: "2026-01-01T00:00:00.000Z",
            parts: [{ kind: "text", text: "hi" }],
            sender: {
              name: "Researcher",
              address: "researcher@agents.example",
            },
          },
        ],
      }),
    );
    const page = await listMessages("tenant_1", "chan_1");
    expect(page.items[0]?.sender).toEqual({
      name: "Researcher",
      address: "researcher@agents.example",
    });
  });

  test("throws a ChatApiError when a message is missing its sender", async () => {
    stubFetch(() =>
      json({
        items: [
          {
            id: "m3",
            createdAt: "2026-01-01T00:00:00.000Z",
            parts: [{ kind: "text", text: "hi" }],
          },
        ],
      }),
    );
    await expect(listMessages("tenant_1", "chan_1")).rejects.toBeInstanceOf(
      ChatApiError,
    );
  });
});

describe("fetchWorkbenchBlob", () => {
  test("requests the workbench's blob route and returns the base64 body", async () => {
    const calls = stubFetch(() => json({ contentBase64: "aGVsbG8=" }));
    const content = await fetchWorkbenchBlob("tenant_1", "chan_1", "blob_m1_1");
    expect(content).toBe("aGVsbG8=");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/workbenches/chan_1/blobs/blob_m1_1",
    );
  });

  test("throws a ChatApiError on a non-2xx response", async () => {
    stubFetch(() => json({ error: { code: "not_found" } }, 404));
    await expect(
      fetchWorkbenchBlob("tenant_1", "chan_1", "blob_missing"),
    ).rejects.toBeInstanceOf(ChatApiError);
  });
});

describe("listRuns", () => {
  test("parses the runs listing", async () => {
    stubFetch(() =>
      json([
        {
          id: "run_1",
          tenantId: "tenant_1",
          definitionAssetId: "agents/researcher/workflow.json",
          status: "deployed",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ]),
    );
    const runs = await listRuns("tenant_1");
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run !== undefined && runDisplayName(run)).toBe("workflow");
  });
});

describe("listTenantInvitableDefinitions", () => {
  test("fetches the tenant-wide listing with no workbench id", async () => {
    const calls = stubFetch(() =>
      json({ items: [{ id: "wfd_echo", name: "echo" }] }),
    );
    const items = await listTenantInvitableDefinitions("tenant_1");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/invitable-definitions",
    );
    expect(items).toEqual([{ id: "wfd_echo", name: "echo" }]);
  });
});

describe("listInvitableDefinitions", () => {
  test("fetches the workbench's invitable definitions", async () => {
    const calls = stubFetch(() =>
      json({ items: [{ id: "wfd_echo", name: "echo" }] }),
    );
    const items = await listInvitableDefinitions("tenant_1", "chan_1");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/workbenches/chan_1/invitable",
    );
    expect(items).toEqual([{ id: "wfd_echo", name: "echo" }]);
  });

  test("throws a ChatApiError on a malformed response", async () => {
    stubFetch(() => json({ items: [{ id: "wfd_echo" }] }));
    await expect(
      listInvitableDefinitions("tenant_1", "chan_1"),
    ).rejects.toBeInstanceOf(ChatApiError);
  });
});

describe("listWorkbenchAgents", () => {
  test("parses each agent with its person-facing display name (CL-6424)", async () => {
    const calls = stubFetch(() =>
      json({
        items: [
          {
            address: "ins_echo@acme.example",
            handle: "myra",
            definitionId: "wfd_echo",
            definitionAssetId: "ast_wfd_echo",
            displayName: "Myra",
          },
        ],
      }),
    );
    const items = await listWorkbenchAgents("tenant_1", "chan_1");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/workbenches/chan_1/agents",
    );
    expect(items).toEqual([
      {
        address: "ins_echo@acme.example",
        handle: "myra",
        definitionId: "wfd_echo",
        definitionAssetId: "ast_wfd_echo",
        displayName: "Myra",
      },
    ]);
  });

  test("throws a ChatApiError when an agent carries no display name", async () => {
    stubFetch(() =>
      json({
        items: [
          {
            address: "ins_echo@acme.example",
            handle: "myra",
            definitionId: "wfd_echo",
            definitionAssetId: "ast_wfd_echo",
          },
        ],
      }),
    );
    await expect(
      listWorkbenchAgents("tenant_1", "chan_1"),
    ).rejects.toBeInstanceOf(ChatApiError);
  });
});

describe("listVisibleAgentDefinitions", () => {
  test("fetches the tenant's visible agent definitions, own and inherited", async () => {
    const calls = stubFetch(() =>
      json({
        definitions: [
          {
            id: "wfd_outreach",
            name: "Outreach",
            tenantId: "tnt_root",
            tenantName: "Acme",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "wfd_local",
            name: "Local Agent",
            tenantId: "tnt_1",
            tenantName: "Acme / Engineering",
            createdAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      }),
    );
    const definitions = await listVisibleAgentDefinitions("tnt_1");
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/agent-definitions/visible");
    expect(definitions).toEqual([
      {
        id: "wfd_outreach",
        name: "Outreach",
        tenantId: "tnt_root",
        tenantName: "Acme",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "wfd_local",
        name: "Local Agent",
        tenantId: "tnt_1",
        tenantName: "Acme / Engineering",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  test("throws a ChatApiError on a malformed response", async () => {
    stubFetch(() => json({ definitions: [{ id: "wfd_outreach" }] }));
    await expect(listVisibleAgentDefinitions("tnt_1")).rejects.toBeInstanceOf(
      ChatApiError,
    );
  });
});

describe("openAgentDm", () => {
  test("creates a chat workbench with reuseExisting so a second open finds the same workbench", async () => {
    const calls = stubFetch(() =>
      json(
        {
          id: "c_dm",
          title: "Outreach",
          kind: "chat",
          pinned: false,
          participants: [],
        },
        201,
      ),
    );
    const workbench = await openAgentDm("tnt_root", "wfd_outreach");
    expect(calls[0]?.path).toBe("/api/tenants/tnt_root/chat/workbenches");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      kind: "chat",
      definitionId: "wfd_outreach",
      reuseExisting: true,
    });
    expect(workbench.id).toBe("c_dm");
  });
});

describe("inviteAgent", () => {
  test("posts the definitionId and returns the launched agent's address", async () => {
    const calls = stubFetch(() =>
      json(
        { address: "ins_invited1@acme.example", definitionId: "wfd_echo" },
        201,
      ),
    );
    const invited = await inviteAgent("tenant_1", "chan_1", "wfd_echo");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/workbenches/chan_1/invite",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      definitionId: "wfd_echo",
    });
    expect(invited).toEqual({
      address: "ins_invited1@acme.example",
      definitionId: "wfd_echo",
    });
  });
});

describe("postWorkbenchOnboardingStep", () => {
  test("posts the step to the workbench's onboarding route and parses the posted id", async () => {
    const calls = stubFetch(() => json({ id: "msg_1" }, 201));
    const step = {
      kind: "connect-github" as const,
      requiredForTemplate: "Code review",
      promise: "Three reviewers read every pull request.",
      steps: [
        { title: "Connect GitHub", why: "So reviewers can read your code." },
      ],
    };

    const posted = await postWorkbenchOnboardingStep(
      "tenant_1",
      "chan_1",
      step,
    );

    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/workbenches/chan_1/onboarding",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(step);
    expect(posted).toEqual({ id: "msg_1" });
  });

  test("a rejected step surfaces as a ChatApiError", async () => {
    stubFetch(() =>
      json({ error: { code: "bad_request", message: "nope" } }, 400),
    );

    await expect(
      postWorkbenchOnboardingStep("tenant_1", "chan_1", {
        kind: "connect-github",
        requiredForTemplate: "Code review",
        promise: "Three reviewers read every pull request.",
        steps: [],
      }),
    ).rejects.toBeInstanceOf(ChatApiError);
  });
});

describe("quickCreateJimmy", () => {
  test("posts Jimmy's own request shape to the agent-definitions create route", async () => {
    const calls = stubFetch(() => json({ id: "wfd_jimmy" }, 201));
    const created = await quickCreateJimmy("tenant_1");
    expect(calls[0]?.path).toBe("/api/tenants/tenant_1/agent-definitions");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(
      JIMMY_QUICK_CREATE,
    );
    expect(created).toEqual({ id: "wfd_jimmy" });
  });
});

describe("getWorkbenchSettings", () => {
  test("fetches a workbench's settings by tenant and workbench id", async () => {
    const calls = stubFetch(() =>
      json({
        id: "c1",
        title: "General",
        kind: "workbench",
        pinned: true,
        participants: [],
        settings: { "chat/contextWindow": 5 },
        contextWindow: { value: 5, source: "override" },
      }),
    );
    const settings = await getWorkbenchSettings("tenant_1", "c1");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/workbenches/c1/settings",
    );
    expect(settings.settings["chat/contextWindow"]).toBe(5);
    expect(settings.contextWindow).toEqual({ value: 5, source: "override" });
  });
});

describe("patchWorkbenchSettings", () => {
  test("PATCHes the given chat/* keys and returns the updated settings", async () => {
    const calls = stubFetch(() =>
      json({
        id: "c1",
        title: "Renamed",
        kind: "workbench",
        pinned: false,
        participants: [],
        settings: {
          "chat/name": "Renamed",
          "chat/pinned": false,
          "chat/contextWindow": 0,
        },
        contextWindow: { value: 0, source: "override" },
      }),
    );
    const settings = await patchWorkbenchSettings("tenant_1", "c1", {
      "chat/name": "Renamed",
      "chat/pinned": false,
      "chat/contextWindow": 0,
    });
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/workbenches/c1/settings",
    );
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      "chat/name": "Renamed",
      "chat/pinned": false,
      "chat/contextWindow": 0,
    });
    expect(settings.title).toBe("Renamed");
  });
});

describe("getBenchChatSettings", () => {
  test("fetches the bench's chat defaults", async () => {
    const calls = stubFetch(() =>
      json({ settings: { "chat/contextWindow": 30 }, contextWindow: 30 }),
    );
    const settings = await getBenchChatSettings("tenant_1");
    expect(calls[0]?.path).toBe("/api/tenants/tenant_1/chat/bench/settings");
    expect(settings.contextWindow).toBe(30);
  });
});

describe("patchBenchChatSettings", () => {
  test("PATCHes the bench's default context window", async () => {
    const calls = stubFetch(() =>
      json({ settings: { "chat/contextWindow": 42 }, contextWindow: 42 }),
    );
    const settings = await patchBenchChatSettings("tenant_1", {
      "chat/contextWindow": 42,
    });
    expect(calls[0]?.path).toBe("/api/tenants/tenant_1/chat/bench/settings");
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      "chat/contextWindow": 42,
    });
    expect(settings.contextWindow).toBe(42);
  });
});

describe("toggleReaction", () => {
  test("POSTs the emoji and parses the fresh per-emoji summary", async () => {
    const calls = stubFetch(() =>
      json({ emoji: "👍", count: 3, reactedByMe: true }),
    );
    const summary = await toggleReaction("tenant_1", "c1", "m1", "👍");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/workbenches/c1/messages/m1/reactions/toggle",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ emoji: "👍" });
    expect(summary).toEqual({ emoji: "👍", count: 3, reactedByMe: true });
  });
});

describe("pinMessage / unpinMessage", () => {
  test("pinMessage POSTs to the pin route and parses who/when", async () => {
    const calls = stubFetch(() =>
      json({
        messageId: "m1",
        pinnedBy: "prn_alice",
        pinnedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const pinned = await pinMessage("tenant_1", "c1", "m1");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/workbenches/c1/messages/m1/pin",
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(pinned).toEqual({
      messageId: "m1",
      pinnedBy: "prn_alice",
      pinnedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  test("unpinMessage DELETEs the same route and resolves on a 204", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await unpinMessage("tenant_1", "c1", "m1");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/workbenches/c1/messages/m1/pin",
    );
    expect(calls[0]?.init?.method).toBe("DELETE");
  });

  test("unpinMessage throws a ChatApiError on a non-ok response", async () => {
    stubFetch(() => new Response(null, { status: 404 }));
    await expect(unpinMessage("tenant_1", "c1", "m1")).rejects.toBeInstanceOf(
      ChatApiError,
    );
  });

  test("unpinMessage throws an UnauthenticatedError on 401", async () => {
    stubFetch(() => new Response(null, { status: 401 }));
    await expect(unpinMessage("tenant_1", "c1", "m1")).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });
});

describe("listPinnedMessages", () => {
  test("fetches the workbench's pins and parses each item's content plus who pinned it", async () => {
    const calls = stubFetch(() =>
      json({
        items: [
          {
            id: "m1",
            createdAt: "2026-01-01T00:00:00.000Z",
            parts: [{ kind: "text", text: "important" }],
            sender: { name: null, address: "prn_alice@acme.example" },
            pinnedBy: "prn_alice",
            pinnedAt: "2026-01-01T00:01:00.000Z",
          },
        ],
      }),
    );
    const pins = await listPinnedMessages("tenant_1", "c1");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tenant_1/chat/workbenches/c1/pins",
    );
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ id: "m1", pinnedBy: "prn_alice" });
  });
});

describe("runDisplayName", () => {
  test("never renders the raw asset id when it has no path shape", () => {
    expect(
      runDisplayName({
        id: "run_1",
        tenantId: "t1",
        definitionAssetId: "researcher",
        status: "deployed",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("Untitled agent");
  });
});

describe("describeChatError", () => {
  const fallback = "Couldn't load the models.";

  test("surfaces an InferenceSettingsApiError envelope userMessage on 500", () => {
    expect(
      describeChatError(
        new InferenceSettingsApiError("catalog boom", 500),
        fallback,
      ),
    ).toBe("catalog boom");
  });

  test("maps an InferenceSettingsApiError 401 the same way as ChatApiError", () => {
    expect(
      describeChatError(
        new InferenceSettingsApiError("signed out boom", 401),
        fallback,
      ),
    ).toBe("You're signed out. Sign in again to continue.");
    expect(describeChatError(new ChatApiError("boom", 401), fallback)).toBe(
      "You're signed out. Sign in again to continue.",
    );
  });

  test("maps a network InferenceSettingsApiError the same way as ChatApiError", () => {
    expect(
      describeChatError(
        new InferenceSettingsApiError("Failed to fetch"),
        fallback,
      ),
    ).toBe("Couldn't reach the server. Check your connection and try again.");
    expect(
      describeChatError(new ChatApiError("Failed to fetch"), fallback),
    ).toBe("Couldn't reach the server. Check your connection and try again.");
  });

  test("never leaks a ChatApiError path on 500", () => {
    expect(
      describeChatError(
        new ChatApiError(
          "The server answered 500 for /api/tenants/tnt_1/models.",
          500,
        ),
        fallback,
      ),
    ).toBe("Something went wrong on our end. Try again in a moment.");
  });
});
