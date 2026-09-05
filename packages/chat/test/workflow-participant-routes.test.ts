// Route-level tests for the workflow-run-authenticated participant-
// invite surface: authentication, the "run's address isn't a
// participant of any workbench" 404, and the happy-path invite
// (delegating to `launchAndJoinAgent`, so the join event and settings
// update land exactly as `POST /workbenches/:id/invite` produces them).
// Reuses `./test-support.ts`'s `TENANT`/`fakePlatform` and
// `createInMemoryChatStore`, matching `workbench-service.test.ts`'s style.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { createInMemoryChatStore } from "../src/store";
import { createInMemoryRoomMessageStore } from "../src/room-messages";
import {
  createWorkflowParticipantRoutes,
  type CreateWorkflowParticipantRoutesDeps,
  type WorkflowParticipantRunScope,
  type WorkflowRunAuthenticator,
} from "../src/workflow-participant-routes";
import { createInMemoryTurnClaimStore } from "../src/turn-claims";
import { createWorkbenchTurnQueue } from "../src/turn-queue";
import { createTurnCancelRegistry } from "../src/turn-cancellation";
import { createInMemoryWorkbenchTenancyStore } from "../src/workbench-tenancy";
import { fakePlatform, TENANT } from "./test-support";

const RUN_ID = "run_1";
const SIDECAR_TOKEN = "sidecar-token";
const RUN_ADDRESS = `${RUN_ID}@acme.example`;

const authenticateAsRun: WorkflowRunAuthenticator = {
  resolve: (token, address) =>
    Promise.resolve(
      token === SIDECAR_TOKEN && address === RUN_ADDRESS
        ? ({
            tenantId: TENANT.id,
            principalId: "prn_1",
            runId: RUN_ID,
          } satisfies WorkflowParticipantRunScope)
        : null,
    ),
};

function buildApp(
  overrides: Partial<CreateWorkflowParticipantRoutesDeps> = {},
): Hono {
  const store = overrides.store ?? createInMemoryChatStore();
  const publish = overrides.publish ?? (() => undefined);
  return createWorkflowParticipantRoutes({
    store,
    platform: overrides.platform ?? fakePlatform(),
    roomMessages: overrides.roomMessages ?? createInMemoryRoomMessageStore(),
    publish,
    turnQueue:
      overrides.turnQueue ??
      createWorkbenchTurnQueue({
        claims: createInMemoryTurnClaimStore({ ttlMs: 60_000 }),
        publish,
      }),
    turnCancellation: overrides.turnCancellation ?? createTurnCancelRegistry(),
    authenticator: overrides.authenticator ?? authenticateAsRun,
    tenancy: overrides.tenancy ?? createInMemoryWorkbenchTenancyStore(),
    sessionFor: overrides.sessionFor ?? (async () => ["session=test"]),
  }) as unknown as Hono;
}

const AUTH_HEADERS = {
  authorization: `Bearer ${SIDECAR_TOKEN}`,
  "x-workflow-run-address": RUN_ADDRESS,
};

test("POST /participants/invite is a 401 without a recognized run credential", async () => {
  const app = buildApp();
  const response = await app.request("/participants/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ definitionId: "wfd_echo" }),
  });
  expect(response.status).toBe(401);
});

test("a run whose address is not a participant of any workbench is a 404", async () => {
  const app = buildApp();
  const response = await app.request("/participants/invite", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({ definitionId: "wfd_echo" }),
  });
  expect(response.status).toBe(404);
});

test("an invalid body is a 400", async () => {
  const app = buildApp();
  const response = await app.request("/participants/invite", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(400);
});

test("invites the named definition into the caller's own workbench, resolved from its own participant address", async () => {
  const store = createInMemoryChatStore();
  await store.createWorkbenchSettings({
    tenantId: TENANT.id,
    workbenchId: "chan_1",
    settings: {
      "chat/kind": "workbench",
      "chat/participants": [{ address: RUN_ADDRESS, handle: "myra" }],
    },
    updatedBy: "prn_1",
  });
  const platform = fakePlatform({
    invitable: [{ id: "wfd_echo", name: "Echo" }],
  });

  const app = buildApp({ store, platform });
  const response = await app.request("/participants/invite", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({ definitionId: "wfd_echo" }),
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    address: string;
    definitionId: string;
    handle: string;
  };
  expect(body.address).toBe("ins_invited1@acme.example");
  expect(body.definitionId).toBe("wfd_echo");
  expect(body.handle).toBe("echo");
  expect(platform.launchInviteCalls).toEqual([
    {
      tenantId: TENANT.id,
      creatorPrincipalId: "prn_1",
      definitionId: "wfd_echo",
    },
  ]);

  const updated = await store.getWorkbenchSettings(TENANT.id, "chan_1");
  expect(updated?.settings["chat/participants"]).toEqual([
    { address: RUN_ADDRESS, handle: "myra" },
    { address: "ins_invited1@acme.example", handle: "echo" },
  ]);
});

test("inviting a different agent into the caller's kind: chat is a 409 kind_is_chat", async () => {
  const store = createInMemoryChatStore();
  await store.createWorkbenchSettings({
    tenantId: TENANT.id,
    workbenchId: "chan_dm",
    settings: {
      "chat/kind": "chat",
      "chat/definitionId": "wfd_assistant",
      "chat/participants": [{ address: RUN_ADDRESS, handle: "myra" }],
    },
    updatedBy: "prn_1",
  });
  const platform = fakePlatform({
    invitable: [{ id: "wfd_echo", name: "Echo" }],
  });

  const app = buildApp({ store, platform });
  const response = await app.request("/participants/invite", {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: JSON.stringify({ definitionId: "wfd_echo" }),
  });

  expect(response.status).toBe(409);
  const body = (await response.json()) as { error: { code: string } };
  expect(body.error.code).toBe("kind_is_chat");
  expect(platform.launchInviteCalls).toHaveLength(0);
});

describe("POST /participants/messages", () => {
  test("is a 401 without a recognized run credential", async () => {
    const app = buildApp();
    const response = await app.request("/participants/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "hi" }] }),
    });
    expect(response.status).toBe(401);
  });

  test("a run whose address is not a participant of any workbench is a 404", async () => {
    const app = buildApp();
    const response = await app.request("/participants/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ parts: [{ kind: "text", text: "hi" }] }),
    });
    expect(response.status).toBe(404);
  });

  test("an invalid body is a 400", async () => {
    const store = createInMemoryChatStore();
    await store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: "chan_1",
      settings: {
        "chat/kind": "workbench",
        "chat/participants": [{ address: RUN_ADDRESS, handle: "myra" }],
      },
      updatedBy: "prn_1",
    });
    const app = buildApp({ store });
    const response = await app.request("/participants/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ parts: "not an array" }),
    });
    expect(response.status).toBe(400);
  });

  test("posts a question block into the caller's own workbench as the run's own message", async () => {
    const store = createInMemoryChatStore();
    await store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: "chan_1",
      settings: {
        "chat/kind": "workbench",
        "chat/participants": [{ address: RUN_ADDRESS, handle: "myra" }],
      },
      updatedBy: "prn_1",
    });
    const platform = fakePlatform();
    const roomMessages = createInMemoryRoomMessageStore();

    const app = buildApp({ store, platform, roomMessages });
    const questionBlock = {
      kind: "block" as const,
      block: {
        type: "question",
        data: {
          questionId: "q_1",
          question: "Which environment?",
          options: ["Staging", "Production"],
        },
      },
    };
    const response = await app.request("/participants/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ parts: [questionBlock] }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; createdAt: string };
    expect(typeof body.id).toBe("string");

    // The block lands on the workbench's own timeline, under the run's
    // own address — the mail the send makes is the turn it asks of the
    // workbench's agent, addressed to that agent and never to the room.
    const listed = await roomMessages.listMessages({
      tenantId: TENANT.id,
      workbenchId: "chan_1",
    });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.id).toBe(body.id);
    expect(listed.items[0]?.sender.address).toBe(RUN_ADDRESS);
    expect(listed.items[0]?.senderPrincipalId).toBe("prn_1");
    expect(listed.items[0]?.parts).toEqual([questionBlock]);
    expect(
      platform.sentMail.every((mail) => mail.workbenchId !== "chan_1"),
    ).toBe(true);
  });

  test("re-posting a question block with the same questionId returns the existing card and does not insert a second message", async () => {
    const store = createInMemoryChatStore();
    await store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: "chan_1",
      settings: {
        "chat/kind": "workbench",
        "chat/participants": [{ address: RUN_ADDRESS, handle: "myra" }],
      },
      updatedBy: "prn_1",
    });
    const roomMessages = createInMemoryRoomMessageStore();
    const app = buildApp({ store, roomMessages });
    const questionBlock = {
      kind: "block" as const,
      block: {
        type: "question",
        data: {
          questionId: "q_retry1",
          question: "Which environment?",
          options: ["Staging", "Production"],
        },
      },
    };
    const post = () =>
      app.request("/participants/messages", {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({ parts: [questionBlock] }),
      });

    const first = await post();
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string; createdAt: string };

    const second = await post();
    expect(second.ok).toBe(true);
    const secondBody = (await second.json()) as {
      id: string;
      createdAt: string;
    };
    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.createdAt).toBe(firstBody.createdAt);

    const listed = await roomMessages.listMessages({
      tenantId: TENANT.id,
      workbenchId: "chan_1",
    });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.id).toBe(firstBody.id);
  });

  test("a different questionId still posts a second card", async () => {
    const store = createInMemoryChatStore();
    await store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: "chan_1",
      settings: {
        "chat/kind": "workbench",
        "chat/participants": [{ address: RUN_ADDRESS, handle: "myra" }],
      },
      updatedBy: "prn_1",
    });
    const roomMessages = createInMemoryRoomMessageStore();
    const app = buildApp({ store, roomMessages });
    const post = (questionId: string) =>
      app.request("/participants/messages", {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTH_HEADERS },
        body: JSON.stringify({
          parts: [
            {
              kind: "block",
              block: {
                type: "question",
                data: {
                  questionId,
                  question: "Which environment?",
                  options: ["Staging", "Production"],
                },
              },
            },
          ],
        }),
      });

    expect((await post("q_one")).status).toBe(201);
    expect((await post("q_two")).status).toBe(201);
    const listed = await roomMessages.listMessages({
      tenantId: TENANT.id,
      workbenchId: "chan_1",
    });
    expect(listed.items).toHaveLength(2);
  });

  test("posting a connect-service block records the pending connection on the workbench and publishes chat.settings", async () => {
    const store = createInMemoryChatStore();
    await store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: "chan_1",
      settings: {
        "chat/kind": "workbench",
        "chat/participants": [{ address: RUN_ADDRESS, handle: "myra" }],
      },
      updatedBy: "prn_1",
    });
    const published: { workbenchId: string; event: unknown }[] = [];
    const publish = (workbenchId: string, event: unknown) => {
      published.push({ workbenchId, event });
    };

    const app = buildApp({ store, publish });
    const response = await app.request("/participants/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        parts: [
          {
            kind: "block",
            block: {
              type: "connect-service",
              data: {
                connectorId: "gmail",
                displayName: "Gmail",
                reason: "Connect Gmail so I can send this for you.",
              },
            },
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    const updated = await store.getWorkbenchSettings(TENANT.id, "chan_1");
    expect(updated?.settings["connections/pending"]).toEqual(["gmail"]);
    const settingsEvents = published.filter(
      (entry) =>
        (entry.event as { type?: string }).type === "chat.settings" &&
        entry.workbenchId === "chan_1",
    );
    expect(settingsEvents.length).toBeGreaterThan(0);
  });

  test("a repeated connect-service block never duplicates the pending entry", async () => {
    const store = createInMemoryChatStore();
    await store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: "chan_1",
      settings: {
        "chat/kind": "workbench",
        "chat/participants": [{ address: RUN_ADDRESS, handle: "myra" }],
        "connections/pending": ["gmail"],
      },
      updatedBy: "prn_1",
    });
    const app = buildApp({ store });
    const response = await app.request("/participants/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({
        parts: [
          {
            kind: "block",
            block: {
              type: "connect-service",
              data: {
                connectorId: "gmail",
                displayName: "Gmail",
                reason: "Connect Gmail so I can send this for you.",
              },
            },
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    const updated = await store.getWorkbenchSettings(TENANT.id, "chan_1");
    expect(updated?.settings["connections/pending"]).toEqual(["gmail"]);
  });

  test("a plain text message leaves the pending connections untouched", async () => {
    const store = createInMemoryChatStore();
    await store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: "chan_1",
      settings: {
        "chat/kind": "workbench",
        "chat/participants": [{ address: RUN_ADDRESS, handle: "myra" }],
      },
      updatedBy: "prn_1",
    });
    const app = buildApp({ store });
    const response = await app.request("/participants/messages", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ parts: [{ kind: "text", text: "hi" }] }),
    });

    expect(response.status).toBe(201);
    const updated = await store.getWorkbenchSettings(TENANT.id, "chan_1");
    expect(updated?.settings["connections/pending"]).toBeUndefined();
  });
});

describe("POST /participants/mint-dm", () => {
  test("is a 401 without a recognized run credential", async () => {
    const app = buildApp();
    const response = await app.request("/participants/mint-dm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });
    expect(response.status).toBe(401);
  });

  test("a run whose address is not a participant of any workbench is a 404", async () => {
    const app = buildApp();
    const response = await app.request("/participants/mint-dm", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });
    expect(response.status).toBe(404);
  });

  test("an invalid body is a 400", async () => {
    const app = buildApp();
    const response = await app.request("/participants/mint-dm", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  test("is a 500 owner_unresolved when the parent tenant has no owner grant", async () => {
    const store = createInMemoryChatStore();
    await store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: "chan_dm",
      settings: {
        "chat/kind": "chat",
        "chat/definitionId": "wfd_assistant",
        "chat/participants": [{ address: RUN_ADDRESS, handle: "myra" }],
      },
      updatedBy: "prn_1",
    });
    const tenancy = createInMemoryWorkbenchTenancyStore();
    tenancy.registerExistingTenant(TENANT.id);
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "Echo" }],
    });

    const app = buildApp({ store, platform, tenancy });
    const response = await app.request("/participants/mint-dm", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("owner_unresolved");
    expect(platform.launchInviteCalls).toHaveLength(0);
  });

  test("mints a new kind:chat 1:1 and publishes chat.workbenches-mutated on the caller workbench", async () => {
    const store = createInMemoryChatStore();
    const callerWorkbenchId = "chan_dm";
    await store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: callerWorkbenchId,
      settings: {
        "chat/kind": "chat",
        "chat/definitionId": "wfd_assistant",
        "chat/participants": [{ address: RUN_ADDRESS, handle: "myra" }],
      },
      updatedBy: "prn_1",
    });
    const tenancy = createInMemoryWorkbenchTenancyStore();
    tenancy.registerExistingTenant(TENANT.id);
    tenancy.grantManageInTenant("usr_alice", TENANT.id);
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "Echo" }],
    });
    const published: { workbenchId: string; event: unknown }[] = [];
    const publish = (workbenchId: string, event: unknown) => {
      published.push({ workbenchId, event });
    };

    const app = buildApp({ store, platform, tenancy, publish });
    const response = await app.request("/participants/mint-dm", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      workbenchId: string;
      address: string;
      definitionId: string;
      handle: string;
    };
    expect(typeof body.workbenchId).toBe("string");
    expect(body.workbenchId).not.toBe(callerWorkbenchId);
    expect(body.address).toBe("ins_invited1@acme.example");
    expect(body.definitionId).toBe("wfd_echo");
    expect(body.handle).toBe("echo");
    expect(platform.launchInviteCalls).toEqual([
      {
        tenantId: TENANT.id,
        creatorPrincipalId: "prn_1",
        definitionId: "wfd_echo",
      },
    ]);

    const minted = await store.getWorkbenchSettings(
      TENANT.id,
      body.workbenchId,
    );
    expect(minted?.settings["chat/kind"]).toBe("chat");
    expect(minted?.settings["chat/definitionId"]).toBe("wfd_echo");
    expect(minted?.settings["chat/participants"]).toEqual([
      { address: "ins_invited1@acme.example", handle: "echo" },
    ]);

    // Caller DM is unchanged — mint never invites into Myra's chat.
    const caller = await store.getWorkbenchSettings(
      TENANT.id,
      callerWorkbenchId,
    );
    expect(caller?.settings["chat/participants"]).toEqual([
      { address: RUN_ADDRESS, handle: "myra" },
    ]);

    const mutated = published.filter(
      (entry) =>
        (entry.event as { type?: string }).type ===
          "chat.workbenches-mutated" && entry.workbenchId === callerWorkbenchId,
    );
    expect(mutated).toHaveLength(1);
    expect(
      published.some(
        (entry) =>
          (entry.event as { type?: string }).type ===
            "chat.workbenches-mutated" &&
          entry.workbenchId === body.workbenchId,
      ),
    ).toBe(false);
  });

  test("second mint-dm with the same definitionId reopens the existing chat instead of cloning", async () => {
    const store = createInMemoryChatStore();
    const callerWorkbenchId = "chan_dm";
    await store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: callerWorkbenchId,
      settings: {
        "chat/kind": "chat",
        "chat/definitionId": "wfd_assistant",
        "chat/participants": [{ address: RUN_ADDRESS, handle: "myra" }],
      },
      updatedBy: "prn_1",
    });
    const tenancy = createInMemoryWorkbenchTenancyStore();
    tenancy.registerExistingTenant(TENANT.id);
    tenancy.grantManageInTenant("usr_alice", TENANT.id);
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "Echo" }],
    });

    const app = buildApp({ store, platform, tenancy });
    const first = await app.request("/participants/mint-dm", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as {
      workbenchId: string;
      address: string;
      handle: string;
    };

    const second = await app.request("/participants/mint-dm", {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });
    expect(second.ok).toBe(true);
    const secondBody = (await second.json()) as {
      workbenchId: string;
      address: string;
      handle: string;
    };

    expect(secondBody.workbenchId).toBe(firstBody.workbenchId);
    expect(secondBody.address).toBe(firstBody.address);
    expect(secondBody.handle).toBe(firstBody.handle);
    expect(platform.launchInviteCalls).toHaveLength(1);

    const chats = await store.listWorkbenchSettings(TENANT.id, "chat");
    expect(chats).toHaveLength(2);
    expect(
      chats.filter((row) => row.settings["chat/definitionId"] === "wfd_echo"),
    ).toHaveLength(1);

    const caller = await store.getWorkbenchSettings(
      TENANT.id,
      callerWorkbenchId,
    );
    expect(caller?.settings["chat/participants"]).toEqual([
      { address: RUN_ADDRESS, handle: "myra" },
    ]);
  });
});
