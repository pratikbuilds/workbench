// Tests for the connect-settling half of the in-room connect flow: a
// connection completing in the browser settles every room that was waiting
// on it — the pending entry clears, `chat.settings` fires so the card
// flips, an event-only system notice lands on the timeline (CL-6741), and
// the agent that asked for the connector is woken via `dispatchTurn` /
// `sendMail` without a new timeline row authored as the signed-in user. A
// room matched only through the template's own pending key settles without
// waking anyone.
import { expect, test } from "bun:test";

import { createInMemoryAgentTurnStore } from "../src/agent-turns";
import { createInMemoryChatStore } from "../src/store";
import { createInMemoryRoomMessageStore } from "../src/room-messages";
import { createInMemoryTurnClaimStore } from "../src/turn-claims";
import { createWorkbenchTurnQueue } from "../src/turn-queue";
import {
  CONNECTION_CONNECTED_EVENT,
  settleConnectedService,
} from "../src/connect-pending";
import { fakePlatform, TENANT } from "./test-support";

const HUMAN_ADDRESS = "prn_owner@acme.example";
const AGENT_ADDRESS = "ins_myra@acme.example";

async function seedWorkbench(
  store: ReturnType<typeof createInMemoryChatStore>,
  workbenchId: string,
  pending: readonly string[] | undefined,
) {
  await store.createWorkbenchSettings({
    tenantId: TENANT.id,
    workbenchId,
    settings: {
      "chat/kind": "workbench",
      "chat/participants": [
        { address: HUMAN_ADDRESS, handle: "owner" },
        { address: AGENT_ADDRESS, handle: "myra" },
      ],
      ...(pending !== undefined ? { "connections/pending": pending } : {}),
    },
    updatedBy: "prn_owner",
  });
}

async function seedTemplateWorkbench(
  store: ReturnType<typeof createInMemoryChatStore>,
  workbenchId: string,
  templatePending: readonly string[],
) {
  await store.createWorkbenchSettings({
    tenantId: TENANT.id,
    workbenchId,
    settings: {
      "chat/kind": "workbench",
      "chat/participants": [
        { address: HUMAN_ADDRESS, handle: "owner" },
        { address: AGENT_ADDRESS, handle: "myra" },
      ],
      "template/id": "code-review",
      "template/pendingConnections": templatePending,
    },
    updatedBy: "prn_owner",
  });
}

function buildDeps() {
  const store = createInMemoryChatStore();
  const roomMessages = createInMemoryRoomMessageStore();
  const agentTurns = createInMemoryAgentTurnStore();
  const platform = fakePlatform();
  const published: { workbenchId: string; event: { type?: string } }[] = [];
  const publish = (workbenchId: string, event: unknown) => {
    published.push({ workbenchId, event: event as { type?: string } });
  };
  const deps = {
    store,
    platform,
    roomMessages,
    publish,
    agentTurns,
    turnQueue: createWorkbenchTurnQueue({
      claims: createInMemoryTurnClaimStore({ ttlMs: 60_000 }),
      publish,
    }),
  };
  return { store, roomMessages, published, platform, agentTurns, deps };
}

function expectEventOnlySettleNotice(
  items: Awaited<
    ReturnType<
      ReturnType<typeof createInMemoryRoomMessageStore>["listMessages"]
    >
  >["items"],
  displayName: string,
) {
  const notices = items.filter(
    (item) =>
      item.parts.length > 0 &&
      item.parts.every((part) => part.kind === "event"),
  );
  expect(notices.length).toBeGreaterThanOrEqual(1);
  const notice = notices[0];
  expect(notice).toBeDefined();
  if (notice === undefined) return;
  expect(notice.senderPrincipalId).toBeNull();
  expect(notice.sender.address).not.toBe(HUMAN_ADDRESS);
  const part = notice.parts[0];
  expect(part).toBeDefined();
  if (part === undefined) return;
  expect(part.kind).toBe("event");
  if (part.kind !== "event") return;
  expect(part.event).toBe(CONNECTION_CONNECTED_EVENT);
  expect(part.data).toEqual({
    connectorId: expect.any(String),
    displayName,
  });
}

test("After connect, no new timeline row is authored as the signed-in user by the product", async () => {
  const { store, roomMessages, published, platform, agentTurns, deps } =
    buildDeps();
  await seedWorkbench(store, "chan_waiting", ["gmail", "exa"]);
  await seedWorkbench(store, "chan_other", undefined);

  await settleConnectedService(deps, {
    tenantId: TENANT.id,
    principalId: "prn_owner",
    connectorId: "gmail",
    displayName: "Gmail",
  });

  const settled = await store.getWorkbenchSettings(TENANT.id, "chan_waiting");
  expect(settled?.settings["connections/pending"]).toEqual(["exa"]);
  expect(
    published.some(
      (entry) =>
        entry.workbenchId === "chan_waiting" &&
        entry.event.type === "chat.settings",
    ),
  ).toBe(true);
  expect(published.some((entry) => entry.event.type === "chat.message")).toBe(
    true,
  );

  const listed = await roomMessages.listMessages({
    tenantId: TENANT.id,
    workbenchId: "chan_waiting",
  });
  expect(listed.items).toHaveLength(1);
  expectEventOnlySettleNotice(listed.items, "Gmail");

  expect(platform.sentMail).toHaveLength(1);
  expect(platform.sentMail[0]?.workbenchId).toBe("ins_myra");
  expect(platform.sentMail[0]?.fromWorkbenchId).toBe("chan_waiting");
  expect(platform.sentMail[0]?.principalId).toBe("prn_owner");
  expect(platform.sentMail[0]?.content.content).toContain("Gmail");

  const turns = await agentTurns.listTurns({
    tenantId: TENANT.id,
    workbenchId: "chan_waiting",
  });
  expect(turns).toHaveLength(1);
  expect(turns[0]?.agentAddress).toBe(AGENT_ADDRESS);
  expect(turns[0]?.requestMessageIds).toEqual([]);

  const untouched = await store.getWorkbenchSettings(TENANT.id, "chan_other");
  expect(untouched?.settings["connections/pending"]).toBeUndefined();
  const otherMessages = await roomMessages.listMessages({
    tenantId: TENANT.id,
    workbenchId: "chan_other",
  });
  expect(otherMessages.items).toHaveLength(0);
});

test("Connect card flips in place; agent wakes without a forged user message", async () => {
  const { store, roomMessages, published, platform, agentTurns, deps } =
    buildDeps();
  await seedWorkbench(store, "chan_waiting", ["gmail"]);
  await roomMessages.insertMessage({
    id: "msg_1",
    tenantId: TENANT.id,
    workbenchId: "chan_waiting",
    sender: { name: "owner", address: HUMAN_ADDRESS },
    senderPrincipalId: "prn_owner",
    parts: [{ kind: "text", text: "send that email" }],
  });
  await roomMessages.insertMessage({
    id: "msg_2",
    tenantId: TENANT.id,
    workbenchId: "chan_waiting",
    sender: { name: "myra", address: AGENT_ADDRESS },
    runId: "ins_myra",
    parts: [{ kind: "text", text: "connect Gmail so I can send it" }],
  });

  await settleConnectedService(deps, {
    tenantId: TENANT.id,
    principalId: "prn_owner",
    connectorId: "gmail",
    displayName: "Gmail",
  });

  const settled = await store.getWorkbenchSettings(TENANT.id, "chan_waiting");
  expect(settled?.settings["connections/pending"]).toEqual([]);
  expect(
    published.some(
      (entry) =>
        entry.workbenchId === "chan_waiting" &&
        entry.event.type === "chat.settings",
    ),
  ).toBe(true);
  expect(published.some((entry) => entry.event.type === "chat.message")).toBe(
    true,
  );

  const listed = await roomMessages.listMessages({
    tenantId: TENANT.id,
    workbenchId: "chan_waiting",
  });
  expect(listed.items).toHaveLength(3);
  expect(listed.items.map((item) => item.id).toSorted()).toEqual(
    expect.arrayContaining(["msg_1", "msg_2"]),
  );
  expect(
    listed.items.some((item) =>
      JSON.stringify(item.parts).includes("is connected now"),
    ),
  ).toBe(false);
  expectEventOnlySettleNotice(listed.items, "Gmail");
  expect(
    listed.items.filter((item) => item.senderPrincipalId === "prn_owner"),
  ).toHaveLength(1);

  expect(platform.sentMail).toHaveLength(1);
  expect(platform.sentMail[0]?.workbenchId).toBe("ins_myra");

  const turns = await agentTurns.listTurns({
    tenantId: TENANT.id,
    workbenchId: "chan_waiting",
  });
  expect(turns[0]?.agentAddress).toBe(AGENT_ADDRESS);
  expect(turns[0]?.requestMessageIds).toEqual(["msg_1", "msg_2"]);
});

test("matches a pending mcp-prefixed entry when the preset connects under its bare slug", async () => {
  const { store, roomMessages, deps } = buildDeps();
  await seedWorkbench(store, "chan_waiting", ["mcp:notion"]);

  await settleConnectedService(deps, {
    tenantId: TENANT.id,
    principalId: "prn_owner",
    connectorId: "notion",
    displayName: "Notion",
  });

  const settled = await store.getWorkbenchSettings(TENANT.id, "chan_waiting");
  expect(settled?.settings["connections/pending"]).toEqual([]);
  const listed = await roomMessages.listMessages({
    tenantId: TENANT.id,
    workbenchId: "chan_waiting",
  });
  expect(listed.items).toHaveLength(1);
  expectEventOnlySettleNotice(listed.items, "Notion");
});

test("settles a room whose GitHub card is pending under the code-review template's own key — a credential created out of band (not through that card's own submit) still reaches it, and no agent is woken", async () => {
  const { store, roomMessages, published, platform, agentTurns, deps } =
    buildDeps();
  await seedTemplateWorkbench(store, "chan_template", ["github"]);

  await settleConnectedService(deps, {
    tenantId: TENANT.id,
    principalId: "prn_owner",
    connectorId: "github",
    displayName: "GitHub",
  });

  const settled = await store.getWorkbenchSettings(TENANT.id, "chan_template");
  expect(settled?.settings["template/pendingConnections"]).toEqual([]);
  expect(settled?.settings["template/id"]).toBe("code-review");
  expect(
    published.some(
      (entry) =>
        entry.workbenchId === "chan_template" &&
        entry.event.type === "chat.settings",
    ),
  ).toBe(true);
  expect(published.some((entry) => entry.event.type === "chat.message")).toBe(
    true,
  );

  const listed = await roomMessages.listMessages({
    tenantId: TENANT.id,
    workbenchId: "chan_template",
  });
  expect(listed.items).toHaveLength(1);
  expectEventOnlySettleNotice(listed.items, "GitHub");
  // The room's walkthrough was posted by the product, not asked for by an
  // agent mid-turn: the notice comes from the system address, and the
  // room's first agent participant is never dispatched a turn.
  expect(listed.items[0]?.sender.address).toBe("system@chan_template");

  expect(platform.sentMail).toHaveLength(0);
  const turns = await agentTurns.listTurns({
    tenantId: TENANT.id,
    workbenchId: "chan_template",
  });
  expect(turns).toHaveLength(0);
});

test("a code-review template room never wakes an agent when GitHub connects — even if connections/pending also names it", async () => {
  const { store, roomMessages, platform, agentTurns, deps } = buildDeps();
  await store.createWorkbenchSettings({
    tenantId: TENANT.id,
    workbenchId: "chan_review",
    settings: {
      "chat/kind": "workbench",
      "chat/participants": [
        { address: HUMAN_ADDRESS, handle: "owner" },
        {
          address: "ins_architecture-reviewer@acme.example",
          handle: "architecture-reviewer",
        },
        {
          address: "ins_correctness-reviewer@acme.example",
          handle: "correctness-reviewer",
        },
      ],
      "template/id": "code-review",
      "connections/pending": ["github"],
      "template/pendingConnections": ["github"],
    },
    updatedBy: "prn_owner",
  });

  await settleConnectedService(deps, {
    tenantId: TENANT.id,
    principalId: "prn_owner",
    connectorId: "github",
    displayName: "GitHub",
  });

  const settled = await store.getWorkbenchSettings(TENANT.id, "chan_review");
  expect(settled?.settings["connections/pending"]).toEqual([]);
  expect(settled?.settings["template/pendingConnections"]).toEqual([]);

  const listed = await roomMessages.listMessages({
    tenantId: TENANT.id,
    workbenchId: "chan_review",
  });
  expectEventOnlySettleNotice(listed.items, "GitHub");
  expect(listed.items[0]?.sender.address).toBe("system@chan_review");
  expect(platform.sentMail).toHaveLength(0);
  const turns = await agentTurns.listTurns({
    tenantId: TENANT.id,
    workbenchId: "chan_review",
  });
  expect(turns).toHaveLength(0);
});

test("a code-review room that only has connections/pending for GitHub still does not dispatch a reviewer", async () => {
  const { store, platform, agentTurns, deps } = buildDeps();
  await store.createWorkbenchSettings({
    tenantId: TENANT.id,
    workbenchId: "chan_review_pending",
    settings: {
      "chat/kind": "workbench",
      "chat/participants": [
        { address: HUMAN_ADDRESS, handle: "owner" },
        {
          address: "ins_architecture-reviewer@acme.example",
          handle: "architecture-reviewer",
        },
      ],
      "template/id": "code-review",
      "connections/pending": ["github"],
    },
    updatedBy: "prn_owner",
  });

  await settleConnectedService(deps, {
    tenantId: TENANT.id,
    principalId: "prn_owner",
    connectorId: "github",
    displayName: "GitHub",
  });

  expect(platform.sentMail).toHaveLength(0);
  const turns = await agentTurns.listTurns({
    tenantId: TENANT.id,
    workbenchId: "chan_review_pending",
  });
  expect(turns).toHaveLength(0);
});

test("a room pending under both keys still wakes its host agent", async () => {
  const { store, roomMessages, platform, agentTurns, deps } = buildDeps();
  await store.createWorkbenchSettings({
    tenantId: TENANT.id,
    workbenchId: "chan_both",
    settings: {
      "chat/kind": "workbench",
      "chat/participants": [
        { address: HUMAN_ADDRESS, handle: "owner" },
        { address: AGENT_ADDRESS, handle: "myra" },
      ],
      "connections/pending": ["github"],
      "template/pendingConnections": ["github"],
    },
    updatedBy: "prn_owner",
  });

  await settleConnectedService(deps, {
    tenantId: TENANT.id,
    principalId: "prn_owner",
    connectorId: "github",
    displayName: "GitHub",
  });

  const settled = await store.getWorkbenchSettings(TENANT.id, "chan_both");
  expect(settled?.settings["connections/pending"]).toEqual([]);
  expect(settled?.settings["template/pendingConnections"]).toEqual([]);

  const listed = await roomMessages.listMessages({
    tenantId: TENANT.id,
    workbenchId: "chan_both",
  });
  expect(listed.items[0]?.sender.address).toBe(AGENT_ADDRESS);
  expect(platform.sentMail).toHaveLength(1);
  const turns = await agentTurns.listTurns({
    tenantId: TENANT.id,
    workbenchId: "chan_both",
  });
  expect(turns[0]?.agentAddress).toBe(AGENT_ADDRESS);
});

test("System / settle notices are not presented as the human's messages", async () => {
  const { store, roomMessages, deps } = buildDeps();
  await seedWorkbench(store, "chan_waiting", ["github"]);

  await settleConnectedService(deps, {
    tenantId: TENANT.id,
    principalId: "prn_owner",
    connectorId: "github",
    displayName: "GitHub",
  });

  const listed = await roomMessages.listMessages({
    tenantId: TENANT.id,
    workbenchId: "chan_waiting",
  });
  expect(listed.items).toHaveLength(1);
  expectEventOnlySettleNotice(listed.items, "GitHub");
  expect(
    listed.items.filter((item) => item.sender.address === HUMAN_ADDRESS),
  ).toHaveLength(0);
  expect(
    listed.items.filter((item) => item.senderPrincipalId === "prn_owner"),
  ).toHaveLength(0);
  expect(
    listed.items.some((item) =>
      item.parts.some((part) => part.kind === "text"),
    ),
  ).toBe(false);
});

test("a connector no room is waiting on settles nothing", async () => {
  const { store, roomMessages, published, platform, deps } = buildDeps();
  await seedWorkbench(store, "chan_1", ["exa"]);

  await settleConnectedService(deps, {
    tenantId: TENANT.id,
    principalId: "prn_owner",
    connectorId: "gmail",
    displayName: "Gmail",
  });

  const untouched = await store.getWorkbenchSettings(TENANT.id, "chan_1");
  expect(untouched?.settings["connections/pending"]).toEqual(["exa"]);
  expect(published).toHaveLength(0);
  const listed = await roomMessages.listMessages({
    tenantId: TENANT.id,
    workbenchId: "chan_1",
  });
  expect(listed.items).toHaveLength(0);
  expect(platform.sentMail).toHaveLength(0);
});
