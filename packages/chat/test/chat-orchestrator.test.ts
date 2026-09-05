// Proves the orchestrator's own wiring: a `connector.reply` on the
// shared `agent.event` stream resolves the replying address to its
// folded run, finds the originating workbench (the room with a running
// turn, a unique membership, or an explicit from/replyTo/turn hint on
// the event), and posts the reply onto that timeline via
// `postRoomMessage`. A host in two rooms never gets one reply sprayed
// into both. Non-reply events are ignored for posting but still bump
// activity; an address the store never produced (no folded run) is
// ignored outright; `dispose` stops the subscription.
//
// Mail is left with exactly one job here — the delegation hop that
// dispatches a mentioned specialist's own mailbox — so a test that
// asserts on `sendMail` is asserting on that hop and nothing else.
//
// Also proves the `reactor.gate.blocked` -> approve-block wiring: an
// approval-gate park resolves its `correlationId` to the platform's own
// approval row and posts an `{type:"approve"}` block carrying that row's
// id and headline; a redelivered event, or one for an approval already
// resolved, posts nothing more.
import { describe, expect, test } from "bun:test";
import { createSidecarEmitter } from "@intx/hub-sessions";
import {
  createArtifactDeliveryHandler,
  createChatOrchestrator,
  POSTED_APPROVAL_GUARD_TTL_MS,
} from "../src/chat-orchestrator";
import { createInMemoryAgentTurnStore } from "../src/agent-turns";
import { parseBlock } from "../src/blocks";
import type { ChatPlatform, ChatWorkbenchEvent } from "../src/platform-port";
import {
  createInMemoryRoomMessageStore,
  postRoomMessage,
  type RoomMessage,
  type RoomMessageStore,
} from "../src/room-messages";
import type { WorkbenchSettingsRow } from "../src/store";
import { createInMemoryThreadStore } from "../src/threads";
import { createInMemoryTurnMailCorrelationStore } from "../src/turn-mail-correlation";
import type { WorkbenchSubscriberRegistry } from "../src/workbench-events";
import { createInMemoryWriteClaimStore } from "../src/write-claims";

// A fresh claim store per test, unless a test explicitly wants to share
// one across two separately-constructed orchestrators/handlers to prove
// a claim survives what a hub restart looks like from their point of
// view (see the "restart-shaped redelivery" tests below).
function fakeClaims() {
  return createInMemoryWriteClaimStore();
}

/**
 * The room timeline every poster writes to, plus the live-stream publish
 * that goes with it. `posted` is the recording every assertion below
 * reads: the real in-memory store does the work, this only remembers what
 * came back out of it, in order. `failPostOnCall` makes one nominated
 * post throw, for the partial-failure recovery cases.
 */
function fakeRoom(options?: { failPostOnCall: number }) {
  const posted: RoomMessage[] = [];
  const published: { workbenchId: string; event: ChatWorkbenchEvent }[] = [];
  const store = createInMemoryRoomMessageStore();
  let posts = 0;
  const roomMessages: RoomMessageStore = {
    async insertMessage(input) {
      posts += 1;
      if (posts === options?.failPostOnCall) {
        throw new Error("simulated room-message post failure");
      }
      const message = await store.insertMessage(input);
      posted.push(message);
      return message;
    },
    listMessages: store.listMessages,
    getMessage: store.getMessage,
    listActivity: store.listActivity,
    stampMailMessageId: store.stampMailMessageId,
    findByMailMessageId: store.findByMailMessageId,
    deleteMessage: store.deleteMessage,
  };
  const publish: WorkbenchSubscriberRegistry["publish"] = (
    workbenchId,
    event,
  ) => {
    published.push({ workbenchId, event });
  };
  return { roomMessages, publish, posted, published };
}

/** The agent-dispatch side: every `sendMail` the delegation hop makes. */
function fakeMail() {
  const sentMail: {
    tenantId: string;
    workbenchId: string;
    content: unknown;
    fromWorkbenchId?: string;
  }[] = [];
  const platform: Pick<ChatPlatform, "sendMail"> = {
    async sendMail(input) {
      sentMail.push(input as never);
      return {
        id: `mail_${sentMail.length}`,
        createdAt: new Date().toISOString(),
      };
    },
  };
  return { platform, sentMail };
}

function approvalRow(overrides?: {
  id?: string;
  status?: "pending" | "approved" | "rejected" | "timeout" | "expired";
}) {
  return {
    id: overrides?.id ?? "apr_1",
    tenantId: "ten_1",
    anchorRunId: "ins_echo1",
    runId: "ins_echo1",
    agentAddress: "ins_echo1@ten1.workbench.test",
    correlationId: "cor_1",
    toolDefinition: { name: "post_to_slack", description: "Post to Slack" },
    toolArguments: {},
    scope: null,
    status: overrides?.status ?? "pending",
    timeoutAt: null,
    resolvedAt: null,
    createdAt: new Date("2026-08-08T09:00:00.000Z"),
    updatedAt: new Date("2026-08-08T09:00:00.000Z"),
  } as const;
}

// The `workbench_launch` mapping row `readBindingByAddress` reads to
// turn an event-stream address into the room's own participant address
// (see `../src/agent-binding.ts`). Every scenario here predates any
// relaunch, so the stable id and the current run id are the same value
// — which is exactly the identity mapping a room starts life with.
function launchRowFor(runId: string, tenantId: string) {
  return {
    tenantId,
    instanceId: runId,
    currentRunId: runId,
    priorRunIds: [],
    foldedBody: {
      systemPrompt: "be helpful",
      toolPackagePins: [],
      grantRequirements: [],
      credentialBindings: [],
      model: null,
    },
    noopInference: false,
    createdAt: new Date("2026-08-08T09:00:00.000Z"),
  };
}

// The real `findFoldedRunByAddress` (exercised, not mocked, so this
// file never risks poisoning `@corbits/folded-runs`'s module namespace
// for `platform-adapter.test.ts` when the whole package's suite runs
// in one process) calls `db.query.workflowRun.findFirst({ where:
// eq(workflowRun.address, address) })`. Every scenario here configures
// at most one run, so this fake ignores the `where` filter and simply
// returns the configured run regardless of which address was queried
// — the same convention `platform-adapter.test.ts`'s own fake `db`
// uses.
function createFakeDb(run?: {
  id: string;
  tenantId: string;
  principalId?: string | null;
}) {
  return {
    query: {
      workflowRun: {
        findFirst: async () =>
          run === undefined
            ? undefined
            : { ...run, principalId: run.principalId ?? null },
      },
    },
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            run === undefined ? [] : [launchRowFor(run.id, run.tenantId)],
        }),
      }),
    }),
  };
}

function fakeMemory() {
  const added: unknown[] = [];
  return {
    memory: {
      async add(params: unknown) {
        added.push(params);
        return { documentId: "doc_1", versionId: "ver_1" };
      },
    },
    added,
  };
}

function workbenchRow(
  workbenchId: string,
  participantAddresses: string[],
): WorkbenchSettingsRow {
  return {
    tenantId: "ten_1",
    workbenchId,
    settings: {
      "chat/kind": "workbench",
      "chat/participants": participantAddresses.map((address) => ({
        address,
        handle: address.split("@")[0],
      })),
    },
    updatedBy: "prn_1",
    updatedAt: new Date(),
  };
}

describe("createChatOrchestrator", () => {
  test("posts a connector.reply onto the member workbench's timeline resolved from the store", async () => {
    const room = fakeRoom();
    // The reply's run id is the occurrence that produced it, taken from
    // the turn the dispatch seam opened — never derived from the address.
    const agentTurns = createInMemoryAgentTurnStore();
    await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      agentAddress: "ins_echo1@ten1.workbench.test",
      requestMessageIds: ["msg_1"],
    });
    const listWorkbenchSettingsCalls: string[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async (tenantId) => {
          listWorkbenchSettingsCalls.push(tenantId);
          return [
            workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
          ];
        },
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      agentTurns,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hello back" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listWorkbenchSettingsCalls).toEqual(["ten_1"]);
    expect(room.posted).toHaveLength(1);
    expect(room.posted[0]).toMatchObject({
      workbenchId: "ins_workbench1",
      sender: { name: null, address: "ins_echo1@ten1.workbench.test" },
      runId: "turn__0",
      parts: [{ kind: "text", text: "hello back" }],
    });
    const [settled] = await agentTurns.listTurns({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
    });
    expect(settled).toMatchObject({
      status: "completed",
      childRunId: "turn__0",
      replyMessageId: room.posted[0]?.id,
    });
    // The message is on every open timeline, not only in the table.
    expect(room.published).toHaveLength(1);
    expect(room.published[0]?.workbenchId).toBe("ins_workbench1");

    orchestrator.dispose();
  });

  test("a reply for room B does not land in room A when the same agent is in both", async () => {
    const room = fakeRoom();
    const agentTurns = createInMemoryAgentTurnStore();
    await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_room_b",
      agentAddress: "ins_echo1@ten1.workbench.test",
      requestMessageIds: ["msg_b"],
    });
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_room_a", ["ins_echo1@ten1.workbench.test"]),
          workbenchRow("ins_room_b", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      agentTurns,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "reply for room B" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted.map((message) => message.workbenchId)).toEqual([
      "ins_room_b",
    ]);
    expect(room.posted[0]).toMatchObject({
      workbenchId: "ins_room_b",
      parts: [{ kind: "text", text: "reply for room B" }],
    });

    orchestrator.dispose();
  });

  // CL-7172: waitUntilFree is per workbench, so the same host can have a
  // running turn in room A and room B at once. Collecting every running
  // row would post one connector.reply into both rooms and finishTurn
  // both — then the second reply would see no running turns and two
  // memberships and silently drop. Originating workbench is singular.
  test("a connector.reply does not post into two rooms that both have a running turn for the same agent", async () => {
    const room = fakeRoom();
    const agentTurns = createInMemoryAgentTurnStore();
    const agentAddress = "ins_echo1@ten1.workbench.test";
    const turnA = await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_room_a",
      agentAddress,
      requestMessageIds: ["msg_a"],
    });
    const turnB = await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_room_b",
      agentAddress,
      requestMessageIds: ["msg_b"],
    });
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_room_a", [agentAddress]),
          workbenchRow("ins_room_b", [agentAddress]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      agentTurns,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "one reply" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted.map((message) => message.workbenchId)).toEqual([]);
    expect(
      (await agentTurns.getTurn({ tenantId: "ten_1", turnId: turnA.id }))
        ?.status,
    ).toBe("running");
    expect(
      (await agentTurns.getTurn({ tenantId: "ten_1", turnId: turnB.id }))
        ?.status,
    ).toBe("running");

    orchestrator.dispose();
  });

  test("a connector.reply posts nowhere when the same agent is in two rooms and neither has a running turn", async () => {
    const room = fakeRoom();
    const agentTurns = createInMemoryAgentTurnStore();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_room_a", ["ins_echo1@ten1.workbench.test"]),
          workbenchRow("ins_room_b", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      agentTurns,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "orphan reply" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted.map((message) => message.workbenchId)).toEqual([]);

    orchestrator.dispose();
  });

  test("a connector.reply still posts when the agent has a single membership and no running turn", async () => {
    const room = fakeRoom();
    const agentTurns = createInMemoryAgentTurnStore();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      agentTurns,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "solo fallback" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted.map((message) => message.workbenchId)).toEqual([
      "ins_workbench1",
    ]);
    expect(room.posted[0]).toMatchObject({
      workbenchId: "ins_workbench1",
      parts: [{ kind: "text", text: "solo fallback" }],
    });

    orchestrator.dispose();
  });

  test("a connector.reply after a cancelled 1:1 turn is dropped, not posted unattached", async () => {
    const room = fakeRoom();
    const agentTurns = createInMemoryAgentTurnStore();
    const agentAddress = "ins_echo1@ten1.workbench.test";
    const turn = await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      agentAddress,
      requestMessageIds: ["msg_1"],
    });
    await agentTurns.finishTurn({
      tenantId: "ten_1",
      turnId: turn.id,
      status: "cancelled",
      error: "Cancelled by user",
    });
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", [agentAddress]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      agentTurns,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "late after stop" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toEqual([]);

    orchestrator.dispose();
  });

  test("a connector.reply correlated to room B does not finish room A's running turn", async () => {
    const room = fakeRoom();
    const agentTurns = createInMemoryAgentTurnStore();
    const agentAddress = "ins_echo1@ten1.workbench.test";
    const turnA = await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_room_a",
      agentAddress,
      requestMessageIds: ["msg_a"],
    });
    await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_room_b",
      agentAddress,
      requestMessageIds: ["msg_b"],
    });
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_room_a", [agentAddress]),
          workbenchRow("ins_room_b", [agentAddress]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      agentTurns,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_1",
      event: {
        type: "connector.reply",
        data: {
          content: "reply for room B",
          fromWorkbenchId: "ins_room_b",
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted.map((message) => message.workbenchId)).toEqual([
      "ins_room_b",
    ]);
    expect(
      (await agentTurns.getTurn({ tenantId: "ten_1", turnId: turnA.id }))
        ?.status,
    ).toBe("running");
    expect(
      (
        await agentTurns.findRunningTurn({
          tenantId: "ten_1",
          workbenchId: "ins_room_b",
          agentAddress,
        })
      )?.status,
    ).toBeUndefined();

    orchestrator.dispose();
  });

  // CL-7196: `resolveMemberWorkbenches` deliberately returns workbench ids
  // plural — one address can be a member of several benches, and each
  // bench's turn runs its own sidecar connection with its own
  // `sessionId`. Two such turns for the SAME agent, interleaved on the
  // shared `agent.event` stream, must never share in-flight state: room
  // A's inference/tool events, reply, and bracket-close must never
  // observe or consume anything room B's turn accumulated, and vice
  // versa — regardless of which turn's bracket closes first.
  test("two overlapping turns for one agent in two benches do not observe each other's state", async () => {
    const room = fakeRoom();
    const agentTurns = createInMemoryAgentTurnStore();
    const agentAddress = "ins_echo1@ten1.workbench.test";
    await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_room_a",
      agentAddress,
      requestMessageIds: ["msg_a"],
    });
    await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_room_b",
      agentAddress,
      requestMessageIds: ["msg_b"],
    });
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_room_a", [agentAddress]),
          workbenchRow("ins_room_b", [agentAddress]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      agentTurns,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    // Room B's turn starts thinking first: a text block, then a tool
    // call — accumulating in its own turn's bucket.
    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_room_b",
      event: {
        type: "inference.done",
        data: {
          turn: {
            content: [
              { type: "text", text: "Let me check that." },
              {
                type: "tool_call",
                id: "call_1",
                name: "web_search",
                arguments: {},
              },
            ],
          },
        },
      },
    });
    // Room A's turn, on a wholly different session, produces its own
    // text while room B's turn is still open.
    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_room_a",
      event: {
        type: "inference.done",
        data: { turn: { content: [{ type: "text", text: "Sure, one sec." }] } },
      },
    });
    // Room B's tool call resolves.
    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_room_b",
      event: {
        type: "tool.done",
        data: { result: { callId: "call_1", content: "3 results found" } },
      },
    });
    // Room A replies and closes first.
    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_room_a",
      event: {
        type: "connector.reply",
        data: { content: "Sure, one sec.", fromWorkbenchId: "ins_room_a" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_room_a",
      event: {
        type: "message.run.ended",
        data: { status: "completed", fromWorkbenchId: "ins_room_a" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Room B replies and closes after room A.
    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_room_b",
      event: {
        type: "connector.reply",
        data: {
          content: "Here's what I found.",
          fromWorkbenchId: "ins_room_b",
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_room_b",
      event: {
        type: "message.run.ended",
        data: { status: "completed", fromWorkbenchId: "ins_room_b" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Room A's own reply carries only its own text — never room B's
    // "Let me check that." text or its tool-trace.
    const postedInA = room.posted.filter(
      (message) => message.workbenchId === "ins_room_a",
    );
    expect(postedInA).toHaveLength(1);
    expect(postedInA[0]?.parts).toEqual([
      { kind: "text", text: "Sure, one sec." },
    ]);

    // Room B's own reply keeps its full accumulated [text, tool-trace] —
    // never swallowed by room A's bracket close, and never replaced by
    // just the flattened `content` string.
    const postedInB = room.posted.filter(
      (message) => message.workbenchId === "ins_room_b",
    );
    expect(postedInB).toHaveLength(1);
    expect(postedInB[0]?.parts).toEqual([
      { kind: "text", text: "Let me check that." },
      {
        kind: "tool-trace",
        name: "web_search",
        input: {},
        status: "success",
        output: "3 results found",
      },
    ]);

    // Neither bench got a spurious "I didn't manage to answer that one"
    // drop notice from the other turn's flag being stolen.
    expect(room.posted).toHaveLength(2);

    orchestrator.dispose();
  });

  // CL-6396: two overlapping running rows for the same (workbench, agent)
  // used to make `findRunningTurn`'s newest-occurrence pick a coin flip.
  // A reply that names turn__0 must close that row, never the later one.
  test("a reply named for turn__0 does not close an overlapping turn__1", async () => {
    const room = fakeRoom();
    const agentTurns = createInMemoryAgentTurnStore();
    const agentAddress = "ins_echo1@ten1.workbench.test";
    const first = await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      agentAddress,
      requestMessageIds: ["msg_0"],
    });
    const second = await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      agentAddress,
      requestMessageIds: ["msg_1"],
    });
    expect(first.childRunId).toBe("turn__0");
    expect(second.childRunId).toBe("turn__1");
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", [agentAddress]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      agentTurns,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_1",
      childRunId: "turn__0",
      event: { type: "connector.reply", data: { content: "first reply" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(1);
    expect(room.posted[0]).toMatchObject({
      runId: "turn__0",
      parts: [{ kind: "text", text: "first reply" }],
    });
    expect(
      (await agentTurns.getTurn({ tenantId: "ten_1", turnId: first.id }))
        ?.status,
    ).toBe("completed");
    expect(
      (await agentTurns.getTurn({ tenantId: "ten_1", turnId: second.id }))
        ?.status,
    ).toBe("running");

    orchestrator.dispose();
  });

  // CL-6396: a failed-turn notice is the same `postReply` path as a
  // successful `connector.reply`. Naming turn__0 must close that row
  // failed, leave the overlapping turn__1 running, and stamp the notice
  // with turn__0 — never the newest-occurrence pick.
  test("a failed-turn notice named for turn__0 does not close an overlapping turn__1", async () => {
    const room = fakeRoom();
    const agentTurns = createInMemoryAgentTurnStore();
    const agentAddress = "ins_echo1@ten1.workbench.test";
    const first = await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      agentAddress,
      requestMessageIds: ["msg_0"],
    });
    const second = await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      agentAddress,
      requestMessageIds: ["msg_1"],
    });
    expect(first.childRunId).toBe("turn__0");
    expect(second.childRunId).toBe("turn__1");
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", [agentAddress]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      agentTurns,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_1",
      childRunId: "turn__0",
      event: {
        type: "message.run.ended",
        data: { status: "failed", error: { message: "provider timed out" } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(1);
    expect(room.posted[0]).toMatchObject({
      runId: "turn__0",
      parts: [{ kind: "text", text: "provider timed out" }],
    });
    expect(
      (await agentTurns.getTurn({ tenantId: "ten_1", turnId: first.id }))
        ?.status,
    ).toBe("failed");
    expect(
      (await agentTurns.getTurn({ tenantId: "ten_1", turnId: second.id }))
        ?.status,
    ).toBe("running");

    orchestrator.dispose();
  });

  // CL-6396: an old sidecar's agent.event frames omit childRunId. The one
  // documented fallback is newest-occurrence — the later overlapping row
  // receives the reply, not a spray and not a late-reply invent.
  test("a reply with no childRunId still finishes the newest overlapping turn", async () => {
    const room = fakeRoom();
    const agentTurns = createInMemoryAgentTurnStore();
    const agentAddress = "ins_echo1@ten1.workbench.test";
    const first = await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      agentAddress,
      requestMessageIds: ["msg_0"],
    });
    const second = await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      agentAddress,
      requestMessageIds: ["msg_1"],
    });
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", [agentAddress]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      agentTurns,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "legacy reply" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(1);
    expect(room.posted[0]?.runId).toBe("turn__1");
    expect(
      (await agentTurns.getTurn({ tenantId: "ten_1", turnId: first.id }))
        ?.status,
    ).toBe("running");
    expect(
      (await agentTurns.getTurn({ tenantId: "ten_1", turnId: second.id }))
        ?.status,
    ).toBe("completed");

    orchestrator.dispose();
  });

  // CL-6396: two turns on one sidecar session must not share the
  // reply-parts accumulator. Turn 0's late `message.run.ended` used to
  // `take()` the session-keyed bucket after turn 1 had already started
  // accumulating, swallowing turn 1's structured parts.
  test("sequential turns on one sessionId with distinct childRunIds do not steal reply-parts", async () => {
    const room = fakeRoom();
    const agentTurns = createInMemoryAgentTurnStore();
    const agentAddress = "ins_echo1@ten1.workbench.test";
    const first = await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      agentAddress,
      requestMessageIds: ["msg_0"],
    });
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", [agentAddress]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      agentTurns,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_shared",
      childRunId: "turn__0",
      event: {
        type: "inference.done",
        data: { turn: { content: [{ type: "text", text: "first thought" }] } },
      },
    });
    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_shared",
      childRunId: "turn__0",
      event: {
        type: "connector.reply",
        data: { content: "first thought" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      (await agentTurns.getTurn({ tenantId: "ten_1", turnId: first.id }))
        ?.status,
    ).toBe("completed");

    const second = await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      agentAddress,
      requestMessageIds: ["msg_1"],
    });
    expect(second.childRunId).toBe("turn__1");

    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_shared",
      childRunId: "turn__1",
      event: {
        type: "inference.done",
        seq: 1,
        data: {
          turn: {
            content: [
              { type: "text", text: "Let me check that." },
              {
                type: "tool_call",
                id: "call_1",
                name: "web_search",
                arguments: { query: "second thought" },
              },
            ],
          },
        },
      },
    });
    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_shared",
      childRunId: "turn__1",
      event: {
        type: "tool.done",
        seq: 2,
        data: {
          result: { callId: "call_1", content: "3 results found" },
        },
      },
    });
    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_shared",
      childRunId: "turn__1",
      event: {
        type: "inference.done",
        seq: 3,
        data: {
          turn: { content: [{ type: "text", text: "second thought" }] },
        },
      },
    });
    // Late bracket-close for the first turn, still on the shared session.
    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_shared",
      childRunId: "turn__0",
      event: {
        type: "message.run.ended",
        data: { status: "completed", messageRunId: "mr_0", messageId: "msg_0" },
      },
    });
    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_shared",
      childRunId: "turn__1",
      event: {
        type: "connector.reply",
        data: { content: "second thought" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(2);
    expect(room.posted[0]?.parts).toEqual([
      { kind: "text", text: "first thought" },
    ]);
    expect(room.posted[1]?.parts).toEqual([
      { kind: "text", text: "Let me check that." },
      {
        kind: "tool-trace",
        name: "web_search",
        input: { query: "second thought" },
        status: "success",
        output: "3 results found",
      },
      { kind: "text", text: "second thought" },
    ]);
    expect(room.posted[1]?.runId).toBe("turn__1");
    expect(
      (await agentTurns.getTurn({ tenantId: "ten_1", turnId: second.id }))
        ?.status,
    ).toBe("completed");

    orchestrator.dispose();
  });

  // CL-6378: a turn's `inference.done` events already split the model's
  // output into prose and tool calls (see `event-collector.ts`'s
  // `handleInferenceDone`), and `tool.done` resolves each call's
  // outcome. The orchestrator must read that structure and post it as
  // ordered [text, tool-trace, text] parts — never fold a tool call's
  // JSON into a `TextPart`'s prose, which is the leak this test guards
  // against.
  test("a turn with a tool call posts [text, tool-trace, text] parts, with zero raw JSON in any text part", async () => {
    const room = fakeRoom();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    const agentAddress = "ins_echo1@ten1.workbench.test";

    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_1",
      event: {
        type: "inference.done",
        seq: 1,
        data: {
          turn: {
            content: [
              { type: "text", text: "Let me check that." },
              {
                type: "tool_call",
                id: "call_1",
                name: "web_search",
                arguments: { query: "web search browser" },
              },
            ],
          },
        },
      },
    });
    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_1",
      event: {
        type: "tool.done",
        seq: 2,
        data: {
          result: { callId: "call_1", content: "3 results found" },
        },
      },
    });
    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_1",
      event: {
        type: "inference.done",
        seq: 3,
        data: {
          turn: { content: [{ type: "text", text: "Here's what I found." }] },
        },
      },
    });
    events.emit("agent.event", {
      agentAddress,
      sessionId: "ses_1",
      event: {
        type: "connector.reply",
        data: { content: "Here's what I found." },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(1);
    const parts = room.posted[0]?.parts;
    expect(parts).toEqual([
      { kind: "text", text: "Let me check that." },
      {
        kind: "tool-trace",
        name: "web_search",
        input: { query: "web search browser" },
        status: "success",
        output: "3 results found",
      },
      { kind: "text", text: "Here's what I found." },
    ]);
    for (const part of parts ?? []) {
      if (part.kind === "text") {
        expect(part.text).not.toContain("{");
      }
    }

    orchestrator.dispose();
  });

  test("the host's reply mentioning a specialist fans out to that specialist too — the delegation hop", async () => {
    const room = fakeRoom();
    const { platform, sentMail } = fakeMail();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_myra1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", [
            "ins_myra1@ten1.workbench.test",
            "ins_echo1@ten1.workbench.test",
          ]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_myra1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "connector.reply",
        data: { content: "@ins_echo1 can you take this one" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // The reply itself lands on the workbench's own timeline...
    expect(room.posted).toHaveLength(1);
    expect(room.posted[0]).toMatchObject({
      workbenchId: "ins_workbench1",
      sender: { address: "ins_myra1@ten1.workbench.test" },
    });
    // ...and only the hop that wakes the mentioned specialist is mail.
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]).toMatchObject({
      tenantId: "ten_1",
      workbenchId: "ins_echo1",
      fromWorkbenchId: "ins_workbench1",
    });

    orchestrator.dispose();
  });

  // CL-6314 helpers. Thread-inheritance tests drive the orchestrator
  // through the same correlation the production dispatch writes — a
  // recorded `(mailId -> source message)` row plus the bracket events
  // naming that mail — against the real in-memory thread and correlation
  // stores, so every assertion below proves the posted row AND its
  // membership land in the source message's thread.
  //
  // `findFoldedRunByAddress` is exercised for real (see this file's
  // header comment), so the two-address fake answers by call order
  // rather than inspecting the drizzle `where` expression: the tests
  // below await a macrotask between emissions, so resolutions happen in
  // emission order.
  function twoRunDb(
    first: { id: string; tenantId: string },
    second: { id: string; tenantId: string },
  ) {
    const runs = [first, second];
    let runCallIndex = 0;
    let launchCallIndex = 0;
    return {
      query: {
        workflowRun: {
          findFirst: async () => {
            const run = runs[runCallIndex];
            runCallIndex += 1;
            return run === undefined
              ? undefined
              : { ...run, principalId: null };
          },
        },
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              const run = runs[launchCallIndex];
              launchCallIndex += 1;
              return run === undefined
                ? []
                : [launchRowFor(run.id, run.tenantId)];
            },
          }),
        }),
      }),
    };
  }

  function bracketed(
    mailId: string,
    messageRunId: string,
    domain: string = "ten1.workbench.test",
  ) {
    return {
      started: {
        type: "message.run.started",
        data: {
          messageId: `<${mailId}@${domain}>`,
          messageRunId,
          receivedAt: Date.now(),
        },
      },
      ended: {
        type: "message.run.ended",
        data: {
          messageRunId,
          messageId: `<${mailId}@${domain}>`,
          status: "completed",
        },
      },
    };
  }

  test("an agent's reply inherits the thread of the message that woke it (CL-6314)", async () => {
    const room = fakeRoom();
    const threads = createInMemoryThreadStore();
    const turnMail = createInMemoryTurnMailCorrelationStore();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      threads,
      turnMailCorrelation: turnMail,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    // A human sub-conversation already running in its own thread: a
    // parent on the root feed, a reply thread under it, the waking
    // message inside that thread — posted exactly the human path posts
    // them (row thread id plus membership row).
    const root = await threads.ensureRootThread("ten_1", "ins_workbench1");
    const parent = await postRoomMessage(
      { roomMessages: room.roomMessages, publish: room.publish },
      {
        tenantId: "ten_1",
        workbenchId: "ins_workbench1",
        sender: { name: "Alice", address: "alice@ten1.workbench.test" },
        parts: [{ kind: "text", text: "kicking this off" }],
        threadId: root.id,
      },
    );
    await threads.assignMessage({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      threadId: root.id,
      messageId: parent.id,
    });
    const thread = await threads.openReplyThread({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      parentMessageId: parent.id,
    });
    const waking = await postRoomMessage(
      { roomMessages: room.roomMessages, publish: room.publish },
      {
        tenantId: "ten_1",
        workbenchId: "ins_workbench1",
        sender: { name: "Alice", address: "alice@ten1.workbench.test" },
        parts: [{ kind: "text", text: "@ins_echo1 what do you think?" }],
        threadId: thread.id,
      },
    );
    await threads.assignMessage({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      threadId: thread.id,
      messageId: waking.id,
    });
    // What `dispatchTurn` wrote when it delivered the waking message.
    await turnMail.recordTurnMail({
      tenantId: "ten_1",
      mailId: "mail_1",
      workbenchId: "ins_workbench1",
      sourceMessageId: waking.id,
    });

    const bracket = bracketed("mail_1", "mrun_1");
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: bracket.started,
    });
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "connector.reply",
        data: { content: "Looks good to me." },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const reply = room.posted.find(
      (message) => message.sender.address === "ins_echo1@ten1.workbench.test",
    );
    expect(reply).toMatchObject({ workbenchId: "ins_workbench1" });
    // The reply's own row carries the thread, and so does its
    // membership — the read model sees it in the thread either way.
    expect(reply?.threadId).toBe(thread.id);
    expect(
      await threads.threadIdForMessage(
        "ten_1",
        "ins_workbench1",
        reply?.id ?? "",
      ),
    ).toBe(thread.id);

    orchestrator.dispose();
  });

  test("a reply still inherits the waking thread after a restart-shaped new orchestrator with no open bracket (CL-6314)", async () => {
    const room = fakeRoom();
    const threads = createInMemoryThreadStore();
    const turnMail = createInMemoryTurnMailCorrelationStore();
    const agentTurns = createInMemoryAgentTurnStore();
    const poster = { roomMessages: room.roomMessages, publish: room.publish };
    const parent = await postRoomMessage(poster, {
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sender: { name: "Alice", address: "alice@ten1.workbench.test" },
      parts: [{ kind: "text", text: "kicking this off" }],
    });
    const thread = await threads.openReplyThread({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      parentMessageId: parent.id,
    });
    const waking = await postRoomMessage(poster, {
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sender: { name: "Alice", address: "alice@ten1.workbench.test" },
      parts: [{ kind: "text", text: "@ins_echo1 what do you think?" }],
      threadId: thread.id,
    });
    await threads.assignMessage({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      threadId: thread.id,
      messageId: waking.id,
    });
    // What `dispatchTurn` wrote — both durable halves, then a brand-new
    // orchestrator the way the hub would after a restart: empty
    // `openBrackets`, no replayed `message.run.started`.
    await turnMail.recordTurnMail({
      tenantId: "ten_1",
      mailId: "mail_restart",
      workbenchId: "ins_workbench1",
      sourceMessageId: waking.id,
    });
    await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      agentAddress: "ins_echo1@ten1.workbench.test",
      requestMessageIds: [waking.id],
    });

    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      threads,
      turnMailCorrelation: turnMail,
      agentTurns,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "connector.reply",
        data: { content: "Looks good to me." },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const reply = room.posted.find(
      (message) => message.sender.address === "ins_echo1@ten1.workbench.test",
    );
    expect(reply?.threadId).toBe(thread.id);
    expect(
      await threads.threadIdForMessage(
        "ten_1",
        "ins_workbench1",
        reply?.id ?? "",
      ),
    ).toBe(thread.id);

    orchestrator.dispose();
  });

  test("a reply to a root-thread message resolves to the root thread — the same rule, not a special case (CL-6314)", async () => {
    const room = fakeRoom();
    const threads = createInMemoryThreadStore();
    const turnMail = createInMemoryTurnMailCorrelationStore();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      threads,
      turnMailCorrelation: turnMail,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    const root = await threads.ensureRootThread("ten_1", "ins_workbench1");
    // A root-feed message carries no membership row — that absence IS
    // the "root thread" answer, resolved here rather than special-cased.
    const waking = await postRoomMessage(
      { roomMessages: room.roomMessages, publish: room.publish },
      {
        tenantId: "ten_1",
        workbenchId: "ins_workbench1",
        sender: { name: "Alice", address: "alice@ten1.workbench.test" },
        parts: [{ kind: "text", text: "@ins_echo1 hello" }],
      },
    );
    await turnMail.recordTurnMail({
      tenantId: "ten_1",
      mailId: "mail_2",
      workbenchId: "ins_workbench1",
      sourceMessageId: waking.id,
    });

    const bracket = bracketed("mail_2", "mrun_2");
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: bracket.started,
    });
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "connector.reply",
        data: { content: "Hello back." },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const reply = room.posted.find(
      (message) => message.sender.address === "ins_echo1@ten1.workbench.test",
    );
    expect(reply?.threadId).toBe(root.id);
    expect(
      await threads.threadIdForMessage(
        "ten_1",
        "ins_workbench1",
        reply?.id ?? "",
      ),
    ).toBe(root.id);

    orchestrator.dispose();
  });

  test("parallel agent sub-conversations stay in their own threads (CL-6314)", async () => {
    const room = fakeRoom();
    const threads = createInMemoryThreadStore();
    const turnMail = createInMemoryTurnMailCorrelationStore();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: twoRunDb(
        { id: "ins_echo1", tenantId: "ten_1" },
        { id: "ins_myra1", tenantId: "ten_1" },
      ) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", [
            "ins_myra1@ten1.workbench.test",
            "ins_echo1@ten1.workbench.test",
          ]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      threads,
      turnMailCorrelation: turnMail,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    const poster = { roomMessages: room.roomMessages, publish: room.publish };
    const parentOne = await postRoomMessage(poster, {
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sender: { name: "Alice", address: "alice@ten1.workbench.test" },
      parts: [{ kind: "text", text: "track one" }],
    });
    const parentTwo = await postRoomMessage(poster, {
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sender: { name: "Alice", address: "alice@ten1.workbench.test" },
      parts: [{ kind: "text", text: "track two" }],
    });
    const threadOne = await threads.openReplyThread({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      parentMessageId: parentOne.id,
    });
    const threadTwo = await threads.openReplyThread({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      parentMessageId: parentTwo.id,
    });
    expect(threadOne.id).not.toBe(threadTwo.id);
    const wakingOne = await postRoomMessage(poster, {
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sender: { name: "Alice", address: "alice@ten1.workbench.test" },
      parts: [{ kind: "text", text: "@ins_echo1 track one" }],
      threadId: threadOne.id,
    });
    const wakingTwo = await postRoomMessage(poster, {
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sender: { name: "Alice", address: "alice@ten1.workbench.test" },
      parts: [{ kind: "text", text: "@ins_myra1 track two" }],
      threadId: threadTwo.id,
    });
    for (const [threadId, message] of [
      [threadOne.id, wakingOne],
      [threadTwo.id, wakingTwo],
    ] as const) {
      await threads.assignMessage({
        tenantId: "ten_1",
        workbenchId: "ins_workbench1",
        threadId,
        messageId: message.id,
      });
    }
    await turnMail.recordTurnMail({
      tenantId: "ten_1",
      mailId: "mail_1",
      workbenchId: "ins_workbench1",
      sourceMessageId: wakingOne.id,
    });
    await turnMail.recordTurnMail({
      tenantId: "ten_1",
      mailId: "mail_2",
      workbenchId: "ins_workbench1",
      sourceMessageId: wakingTwo.id,
    });

    const first = bracketed("mail_1", "mrun_1");
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: first.started,
    });
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "on track one" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = bracketed("mail_2", "mrun_2");
    events.emit("agent.event", {
      agentAddress: "ins_myra1@ten1.workbench.test",
      sessionId: "ses_2",
      event: second.started,
    });
    events.emit("agent.event", {
      agentAddress: "ins_myra1@ten1.workbench.test",
      sessionId: "ses_2",
      event: { type: "connector.reply", data: { content: "on track two" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const replyOne = room.posted.find(
      (message) => message.sender.address === "ins_echo1@ten1.workbench.test",
    );
    const replyTwo = room.posted.find(
      (message) => message.sender.address === "ins_myra1@ten1.workbench.test",
    );
    // Each reply in its own waking thread — neither spills into the
    // other's, and neither lands loose on the root feed.
    expect(replyOne?.threadId).toBe(threadOne.id);
    expect(replyTwo?.threadId).toBe(threadTwo.id);

    orchestrator.dispose();
  });

  test("delegation falls out of the general rule: a specialist's reply threads under the delegating message's thread (CL-6314)", async () => {
    const room = fakeRoom();
    const threads = createInMemoryThreadStore();
    const turnMail = createInMemoryTurnMailCorrelationStore();
    const { platform } = fakeMail();
    const delegationMailIds: string[] = [];
    const deliverMail = platform.sendMail.bind(platform);
    platform.sendMail = async (input) => {
      const sent = await deliverMail(input);
      delegationMailIds.push(sent.id);
      return sent;
    };
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: twoRunDb(
        { id: "ins_myra1", tenantId: "ten_1" },
        { id: "ins_echo1", tenantId: "ten_1" },
      ) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", [
            "ins_myra1@ten1.workbench.test",
            "ins_echo1@ten1.workbench.test",
          ]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform,
      threads,
      turnMailCorrelation: turnMail,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    // A human asks the host from inside a thread — the dispatch wrote
    // that correlation the same way every human mention does.
    const poster = { roomMessages: room.roomMessages, publish: room.publish };
    const parent = await postRoomMessage(poster, {
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sender: { name: "Alice", address: "alice@ten1.workbench.test" },
      parts: [{ kind: "text", text: "needs a specialist" }],
    });
    const thread = await threads.openReplyThread({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      parentMessageId: parent.id,
    });
    const waking = await postRoomMessage(poster, {
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sender: { name: "Alice", address: "alice@ten1.workbench.test" },
      parts: [{ kind: "text", text: "@ins_myra1 can you look?" }],
      threadId: thread.id,
    });
    await threads.assignMessage({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      threadId: thread.id,
      messageId: waking.id,
    });
    await turnMail.recordTurnMail({
      tenantId: "ten_1",
      mailId: "mail_human",
      workbenchId: "ins_workbench1",
      sourceMessageId: waking.id,
    });

    // The host replies, delegating to the specialist by @mention.
    const hostBracket = bracketed("mail_human", "mrun_host");
    events.emit("agent.event", {
      agentAddress: "ins_myra1@ten1.workbench.test",
      sessionId: "ses_1",
      event: hostBracket.started,
    });
    events.emit("agent.event", {
      agentAddress: "ins_myra1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "connector.reply",
        data: { content: "@ins_echo1 can you take this one" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The host's own reply inherits the waking message's thread — hosts
    // are not special-cased out of the rule anymore.
    const delegatingMessage = room.posted.find(
      (message) => message.sender.address === "ins_myra1@ten1.workbench.test",
    );
    expect(delegatingMessage?.threadId).toBe(thread.id);
    // And the delegation hop recorded its own correlation, keyed by the
    // mail id it just got back — no in-memory delegation map involved.
    const delegationMailId = delegationMailIds[0];
    if (delegationMailId === undefined) {
      throw new Error("expected the delegation hop to send one mail");
    }
    if (delegatingMessage?.id === undefined) {
      throw new Error("expected the host's delegating message to be posted");
    }
    expect(
      await turnMail.findTurnMailSource({
        tenantId: "ten_1",
        mailId: delegationMailId,
      }),
    ).toEqual({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sourceMessageId: delegatingMessage.id,
    });

    // The specialist wakes, does its deep-dive, and replies — inside
    // the bracket the delegation mail opened for it.
    const specialistBracket = bracketed(delegationMailId, "mrun_specialist");
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_2",
      event: specialistBracket.started,
    });
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_2",
      event: {
        type: "connector.reply",
        data: { content: "Done — filed the ticket." },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The specialist's reply lands in the delegating message's thread —
    // the same thread, not a new sub-thread opened for the delegation.
    const specialistReply = room.posted.find(
      (message) => message.sender.address === "ins_echo1@ten1.workbench.test",
    );
    expect(specialistReply).toMatchObject({ workbenchId: "ins_workbench1" });
    expect(specialistReply?.threadId).toBe(thread.id);
    expect(
      await threads.threadIdForMessage(
        "ten_1",
        "ins_workbench1",
        specialistReply?.id ?? "",
      ),
    ).toBe(thread.id);
    const listed = await threads.listThreads("ten_1", "ins_workbench1");
    expect(listed.map((entry) => entry.kind).sort()).toEqual(["reply", "root"]);

    orchestrator.dispose();
  });

  test("a reply with no recorded correlation still posts, unthreaded — never lost (CL-6314)", async () => {
    const room = fakeRoom();
    const threads = createInMemoryThreadStore();
    const turnMail = createInMemoryTurnMailCorrelationStore();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      threads,
      turnMailCorrelation: turnMail,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    // No bracket, no correlation row, no running turn — a mail this
    // process never dispatched (a pre-rollout mail): the reply still
    // posts, exactly as before threads.
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "connector.reply",
        data: { content: "Sorry for the wait — filed the ticket." },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const reply = room.posted.find(
      (message) => message.sender.address === "ins_echo1@ten1.workbench.test",
    );
    expect(reply).toMatchObject({ workbenchId: "ins_workbench1" });
    expect(reply?.threadId).toBeNull();
    expect(
      await threads.threadIdForMessage(
        "ten_1",
        "ins_workbench1",
        reply?.id ?? "",
      ),
    ).toBeUndefined();

    orchestrator.dispose();
  });

  test("a silent turn's notice inherits the thread of the message that woke it (CL-6314)", async () => {
    const room = fakeRoom();
    const threads = createInMemoryThreadStore();
    const turnMail = createInMemoryTurnMailCorrelationStore();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      threads,
      turnMailCorrelation: turnMail,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    const poster = { roomMessages: room.roomMessages, publish: room.publish };
    const parent = await postRoomMessage(poster, {
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sender: { name: "Alice", address: "alice@ten1.workbench.test" },
      parts: [{ kind: "text", text: "still there?" }],
    });
    const thread = await threads.openReplyThread({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      parentMessageId: parent.id,
    });
    const waking = await postRoomMessage(poster, {
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sender: { name: "Alice", address: "alice@ten1.workbench.test" },
      parts: [{ kind: "text", text: "@ins_echo1 are you still there?" }],
      threadId: thread.id,
    });
    await threads.assignMessage({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      threadId: thread.id,
      messageId: waking.id,
    });
    await turnMail.recordTurnMail({
      tenantId: "ten_1",
      mailId: "mail_9",
      workbenchId: "ins_workbench1",
      sourceMessageId: waking.id,
    });

    // The turn ends with no `connector.reply` this process ever saw —
    // the bracket close names the waking mail, so the honest notice
    // lands where a reply would have.
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "message.run.ended",
        data: {
          messageRunId: "mrun_9",
          messageId: "<mail_9@ten1.workbench.test>",
          status: "completed",
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(3);
    const notice = room.posted[room.posted.length - 1];
    expect(notice?.threadId).toBe(thread.id);

    orchestrator.dispose();
  });

  // CL-6137 / turn-drop notice (stress round 3): a turn that never
  // emits `connector.reply` content is no longer invisible — the
  // bracket close posts an honest in-workbench notice — but a reply this
  // process already saw for the turn is never followed by a redundant
  // notice, and a redelivered bracket-close event posts at most one.
  test("message.run.ended posts a notice only for a turn that ended with no reply, once per redelivery", async () => {
    const room = fakeRoom();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    // Turn 1: a reply, then its own bracket close — one post, from the
    // reply alone, no notice on top of it.
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hi" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "message.run.ended", data: { status: "completed" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(room.posted).toHaveLength(1);

    // Turn 2: a silent completion — no reply this process ever saw for
    // it — posts the honest empty-turn notice.
    const silentEnd = {
      type: "message.run.ended",
      data: { status: "completed" },
    };
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: silentEnd,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(room.posted).toHaveLength(2);
    expect(room.posted[1]?.parts).toEqual([
      {
        kind: "text",
        text: "I didn't manage to answer that one — say it again and I'll pick it up.",
      },
    ]);

    // Turn 2's end event redelivered (sidecar reconnect, wire-layer
    // replay) — no second notice.
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: silentEnd,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(room.posted).toHaveLength(2);

    // Turn 3: a fresh reply after the silent turn 2 still posts — the
    // bracket-close bookkeeping never leaves stale state behind.
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hi again" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(room.posted).toHaveLength(3);

    orchestrator.dispose();
  });

  // CL-turn-drop-root: two silent turns back to back (no reply either
  // time — a real, if rare, inference outcome under load, not just a
  // redelivery of the same bracket-close) must each get their own
  // notice. Before this fix, `notifiedDropAddresses` only cleared on a
  // real `connector.reply`, so the second silent turn's notice was
  // swallowed by the guard the first silent turn left set — a user
  // sending consecutive messages during a rough patch saw exactly one
  // notice ever, then total silence with no trace anywhere.
  test("message.run.ended posts a notice for EACH silent turn, not just the first", async () => {
    const room = fakeRoom();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    // Turn 1: silent completion, no reply — posts the notice.
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "message.run.ended", data: { status: "completed" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(room.posted).toHaveLength(1);

    // Turn 2 opens (a genuinely new message, not a redelivery) —
    // re-arms the notice guard for this fresh turn.
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "message.run.started", data: { messageId: "m2" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Turn 2 also ends silently — must post its OWN notice, not be
    // swallowed by turn 1's already-set guard.
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "message.run.ended", data: { status: "completed" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(room.posted).toHaveLength(2);

    orchestrator.dispose();
  });

  test("message.run.ended posts a failed-turn notice for a failed turn, not a raw dump bubble", async () => {
    const room = fakeRoom();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "message.run.ended",
        data: { status: "failed", error: { message: "provider timed out" } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(1);
    expect(room.posted[0]?.parts).toEqual([
      { kind: "text", text: "provider timed out", turnFailed: true },
    ]);

    orchestrator.dispose();
  });

  test("message.run.ended classifies a tools-unsupported failure as a failed-turn notice", async () => {
    const room = fakeRoom();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "message.run.ended",
        data: {
          status: "failed",
          error: {
            message:
              "This agent could not complete your request due to an unrecoverable inference error [HTTP 400]: 'tools' is not supported with this model.",
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(1);
    expect(room.posted[0]?.parts).toEqual([
      {
        kind: "text",
        text: "This agent's model can't use tools.",
        turnFailed: true,
        turnFailedReason: "tools_unsupported",
      },
    ]);
    const postedText = (room.posted[0]?.parts[0] as { text: string }).text;
    expect(postedText).not.toMatch(/HTTP/i);
    expect(postedText).not.toContain("unrecoverable inference error");
    expect(postedText).not.toContain("not supported with this model");

    orchestrator.dispose();
  });

  test("a connector.reply that is a tools-unsupported dump becomes a failed-turn notice, not a bubble", async () => {
    const room = fakeRoom();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "connector.reply",
        data: {
          content:
            "This agent could not complete your request due to an unrecoverable inference error [HTTP 400]: 'tools' is not supported with this model.",
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(1);
    expect(room.posted[0]?.parts).toEqual([
      {
        kind: "text",
        text: "This agent's model can't use tools.",
        turnFailed: true,
        turnFailedReason: "tools_unsupported",
      },
    ]);

    orchestrator.dispose();
  });

  test("a connector.reply of ordinary tool-not-supported prose stays completed with original text", async () => {
    const room = fakeRoom();
    const agentTurns = createInMemoryAgentTurnStore();
    await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      agentAddress: "ins_echo1@ten1.workbench.test",
      requestMessageIds: ["msg_1"],
    });
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      agentTurns,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    const original = "The grep tool is not supported in this sandbox.";
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "connector.reply",
        data: { content: original },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(1);
    expect(room.posted[0]?.parts).toEqual([{ kind: "text", text: original }]);
    const [settled] = await agentTurns.listTurns({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
    });
    expect(settled).toMatchObject({
      status: "completed",
      replyMessageId: room.posted[0]?.id,
    });

    orchestrator.dispose();
  });

  test("ignores non-reply events for posting but still bumps activity", async () => {
    const room = fakeRoom();
    const recordActivityCalls: string[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: { listWorkbenchSettings: async () => [] },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
      recordActivity: (address) => recordActivityCalls.push(address),
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.turn.started", data: {} },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(0);
    expect(recordActivityCalls).toEqual(["ins_echo1@ten1.workbench.test"]);

    orchestrator.dispose();
  });

  test("ignores an address with no folded run", async () => {
    const room = fakeRoom();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb(undefined) as never,
      store: { listWorkbenchSettings: async () => [] },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "unknown@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hi" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(0);

    orchestrator.dispose();
  });

  test("dispose unsubscribes from the event stream", async () => {
    const room = fakeRoom();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    orchestrator.dispose();

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hi" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(0);
  });

  test("posts an approve block for a gate-blocked approval, keyed off the platform's own row", async () => {
    const room = fakeRoom();
    const findByCorrelationIdCalls: string[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      claims: fakeClaims(),
      approvals: {
        findByCorrelationId: async (correlationId) => {
          findByCorrelationIdCalls.push(correlationId);
          return approvalRow();
        },
      },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "reactor.gate.blocked",
        data: { reason: "approval", gateId: "gate_1", correlationId: "cor_1" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(findByCorrelationIdCalls).toEqual(["cor_1"]);
    expect(room.posted).toHaveLength(1);
    expect(room.posted[0]).toMatchObject({
      workbenchId: "ins_workbench1",
      sender: { name: null, address: "ins_echo1@ten1.workbench.test" },
      runId: "ins_echo1",
    });

    const parts = room.posted[0]?.parts ?? [];
    expect(parts).toHaveLength(1);
    const part = parts[0];
    if (part?.kind !== "block") throw new Error("expected a block part");
    const parsed = parseBlock(part.block);
    if (!parsed.ok) throw new Error(parsed.summary);
    expect(parsed.block).toEqual({
      type: "approve",
      data: { approvalId: "apr_1", title: "Post to Slack" },
    });

    orchestrator.dispose();
  });

  test("an approve block threads under the turn that produced it (CL-6314)", async () => {
    const room = fakeRoom();
    const threads = createInMemoryThreadStore();
    const turnMail = createInMemoryTurnMailCorrelationStore();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      threads,
      turnMailCorrelation: turnMail,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => approvalRow() },
    });

    const poster = { roomMessages: room.roomMessages, publish: room.publish };
    const parent = await postRoomMessage(poster, {
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sender: { name: "Alice", address: "alice@ten1.workbench.test" },
      parts: [{ kind: "text", text: "ship it" }],
    });
    const thread = await threads.openReplyThread({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      parentMessageId: parent.id,
    });
    const waking = await postRoomMessage(poster, {
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sender: { name: "Alice", address: "alice@ten1.workbench.test" },
      parts: [{ kind: "text", text: "@ins_echo1 ship it" }],
      threadId: thread.id,
    });
    await threads.assignMessage({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      threadId: thread.id,
      messageId: waking.id,
    });
    await turnMail.recordTurnMail({
      tenantId: "ten_1",
      mailId: "mail_7",
      workbenchId: "ins_workbench1",
      sourceMessageId: waking.id,
    });

    // The approval gate parks mid-turn — inside the waking mail's open
    // bracket — so the card lands in the turn's own thread.
    const bracket = bracketed("mail_7", "mrun_7");
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: bracket.started,
    });
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "reactor.gate.blocked",
        data: { reason: "approval", gateId: "gate_1", correlationId: "cor_1" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(3);
    const card = room.posted[room.posted.length - 1];
    const parts = card?.parts ?? [];
    expect(parts).toHaveLength(1);
    expect(parts[0]?.kind).toBe("block");
    expect(card?.threadId).toBe(thread.id);
    expect(
      await threads.threadIdForMessage(
        "ten_1",
        "ins_workbench1",
        card?.id ?? "",
      ),
    ).toBe(thread.id);

    orchestrator.dispose();
  });

  test("an approve block still threads after a restart-shaped new orchestrator with no open bracket (CL-6314)", async () => {
    const room = fakeRoom();
    const threads = createInMemoryThreadStore();
    const turnMail = createInMemoryTurnMailCorrelationStore();
    const agentTurns = createInMemoryAgentTurnStore();
    const poster = { roomMessages: room.roomMessages, publish: room.publish };
    const parent = await postRoomMessage(poster, {
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sender: { name: "Alice", address: "alice@ten1.workbench.test" },
      parts: [{ kind: "text", text: "ship it" }],
    });
    const thread = await threads.openReplyThread({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      parentMessageId: parent.id,
    });
    const waking = await postRoomMessage(poster, {
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sender: { name: "Alice", address: "alice@ten1.workbench.test" },
      parts: [{ kind: "text", text: "@ins_echo1 ship it" }],
      threadId: thread.id,
    });
    await threads.assignMessage({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      threadId: thread.id,
      messageId: waking.id,
    });
    await turnMail.recordTurnMail({
      tenantId: "ten_1",
      mailId: "mail_restart_approve",
      workbenchId: "ins_workbench1",
      sourceMessageId: waking.id,
    });
    await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      agentAddress: "ins_echo1@ten1.workbench.test",
      requestMessageIds: [waking.id],
    });

    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      threads,
      turnMailCorrelation: turnMail,
      agentTurns,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => approvalRow() },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "reactor.gate.blocked",
        data: { reason: "approval", gateId: "gate_1", correlationId: "cor_1" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const card = room.posted.find((message) =>
      message.parts.some((part) => part.kind === "block"),
    );
    expect(card?.threadId).toBe(thread.id);
    expect(
      await threads.threadIdForMessage(
        "ten_1",
        "ins_workbench1",
        card?.id ?? "",
      ),
    ).toBe(thread.id);

    orchestrator.dispose();
  });

  test("ignores a gate-blocked event for a non-approval gate", async () => {
    const room = fakeRoom();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      claims: fakeClaims(),
      approvals: {
        findByCorrelationId: async () => {
          throw new Error("should never be consulted for a non-approval gate");
        },
      },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "reactor.gate.blocked",
        data: { reason: "budget", gateId: "gate_1", correlationId: "cor_1" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(0);

    orchestrator.dispose();
  });

  test("a redelivered gate-blocked event does not post a second card", async () => {
    const room = fakeRoom();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => approvalRow() },
    });

    const emitGateBlocked = () =>
      events.emit("agent.event", {
        agentAddress: "ins_echo1@ten1.workbench.test",
        sessionId: "ses_1",
        event: {
          type: "reactor.gate.blocked",
          data: {
            reason: "approval",
            gateId: "gate_1",
            correlationId: "cor_1",
          },
        },
      });

    emitGateBlocked();
    await new Promise((resolve) => setTimeout(resolve, 0));
    emitGateBlocked();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(1);

    orchestrator.dispose();
  });

  test("a gate-blocked event for an already-resolved approval posts nothing", async () => {
    const room = fakeRoom();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      claims: fakeClaims(),
      approvals: {
        findByCorrelationId: async () => approvalRow({ status: "approved" }),
      },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "reactor.gate.blocked",
        data: { reason: "approval", gateId: "gate_1", correlationId: "cor_1" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(0);

    orchestrator.dispose();
  });

  // CL-7229: `postedApprovalIds` is bounded by `POSTED_APPROVAL_GUARD_TTL_MS`
  // rather than growing one entry per approval ever carded for the life of
  // the hub process. Proves both halves: the entry is actually evicted
  // after the TTL, and — the safety property that matters — a redelivery
  // that arrives after eviction still posts nothing for an approval that
  // has since resolved, because the live status re-read in
  // `postApproveBlock` is the real guard; the in-memory guard is only ever
  // an optimization on top of it.
  test("an evicted approval guard entry still can't cause a duplicate card once the approval has resolved", async () => {
    const room = fakeRoom();
    const events = createSidecarEmitter();
    let status: "pending" | "approved" = "pending";
    let now = 0;

    const orchestrator = createChatOrchestrator(
      {
        db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
        store: {
          listWorkbenchSettings: async () => [
            workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
          ],
        },
        roomMessages: room.roomMessages,
        publish: room.publish,
        platform: fakeMail().platform,
        events,
        claims: fakeClaims(),
        approvals: {
          findByCorrelationId: async () => approvalRow({ status }),
        },
      },
      { now: () => now },
    );

    const emitGateBlocked = () =>
      events.emit("agent.event", {
        agentAddress: "ins_echo1@ten1.workbench.test",
        sessionId: "ses_1",
        event: {
          type: "reactor.gate.blocked",
          data: {
            reason: "approval",
            gateId: "gate_1",
            correlationId: "cor_1",
          },
        },
      });

    emitGateBlocked();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(room.posted).toHaveLength(1);

    // A redelivery well within the TTL is still deduped by the guard.
    now += 1_000;
    emitGateBlocked();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(room.posted).toHaveLength(1);

    // The approval resolves — a human acted on the card already posted —
    // and enough time passes for the guard entry to be evicted.
    status = "approved";
    now += POSTED_APPROVAL_GUARD_TTL_MS + 1;

    // A very late, redelivered gate-blocked event arrives (a stale
    // wire-layer replay) for the now-evicted, now-resolved approval.
    emitGateBlocked();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // No second card: the live status re-read still catches it even
    // though the in-memory guard no longer remembers this approval.
    expect(room.posted).toHaveLength(1);

    orchestrator.dispose();
  });
});

describe("createArtifactDeliveryHandler", () => {
  test("posts a FilePart into every member workbench for a finalized turn naming a persisted artifact", async () => {
    const room = fakeRoom();
    const handler = createArtifactDeliveryHandler({
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({ id: "run_1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events: createSidecarEmitter(),
      claims: fakeClaims(),
    });

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      errors: [],
      toolCalls: [
        {
          isError: false,
          result: JSON.stringify({
            id: "art_1",
            version: 1,
            title: "Notes",
            kind: "text",
            persisted: true,
          }),
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(1);
    expect(room.posted[0]?.workbenchId).toBe("ins_workbench1");
    expect(room.posted[0]?.parts).toEqual([
      {
        kind: "file",
        name: "Notes",
        mediaType: "text/plain",
        artifactId: "art_1",
      },
    ]);
  });

  test("a finalized turn's artifacts thread under the turn that produced them (CL-6314)", async () => {
    const room = fakeRoom();
    const threads = createInMemoryThreadStore();
    const agentTurns = createInMemoryAgentTurnStore();
    const handler = createArtifactDeliveryHandler({
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({ id: "run_1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events: createSidecarEmitter(),
      claims: fakeClaims(),
      agentTurns,
      threads,
    });

    const poster = { roomMessages: room.roomMessages, publish: room.publish };
    const parent = await postRoomMessage(poster, {
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sender: { name: "Alice", address: "alice@ten1.workbench.test" },
      parts: [{ kind: "text", text: "make notes" }],
    });
    const thread = await threads.openReplyThread({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      parentMessageId: parent.id,
    });
    const waking = await postRoomMessage(poster, {
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      sender: { name: "Alice", address: "alice@ten1.workbench.test" },
      parts: [{ kind: "text", text: "@run_1 make notes" }],
      threadId: thread.id,
    });
    await threads.assignMessage({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      threadId: thread.id,
      messageId: waking.id,
    });
    // The turn the dispatch seam opened for the waking message.
    const turn = await agentTurns.startTurn({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      agentAddress: "run_1@ten1.workbench.test",
      requestMessageIds: [waking.id],
    });

    handler("run_1@ten1.workbench.test", {
      turnId: turn.id,
      errors: [],
      toolCalls: [
        {
          isError: false,
          result: JSON.stringify({
            id: "art_1",
            version: 1,
            title: "Notes",
            kind: "text",
            persisted: true,
          }),
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(3);
    const delivery = room.posted[room.posted.length - 1];
    expect(delivery?.parts).toEqual([
      {
        kind: "file",
        name: "Notes",
        mediaType: "text/plain",
        artifactId: "art_1",
      },
    ]);
    expect(delivery?.threadId).toBe(thread.id);
    expect(
      await threads.threadIdForMessage(
        "ten_1",
        "ins_workbench1",
        delivery?.id ?? "",
      ),
    ).toBe(thread.id);
  });

  test("sends nothing when the turn's tool calls name no persisted artifact", async () => {
    const room = fakeRoom();
    const handler = createArtifactDeliveryHandler({
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({ id: "run_1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events: createSidecarEmitter(),
      claims: fakeClaims(),
    });

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      errors: [],
      toolCalls: [{ isError: false, result: "{}" }],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(0);
  });

  test("records a memory entry for a persisted artifact, attributed to the run's own tenant + principal — never a model-supplied value", async () => {
    const { memory, added } = fakeMemory();
    const room = fakeRoom();
    const handler = createArtifactDeliveryHandler({
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({
        id: "run_1",
        tenantId: "ten_1",
        principalId: "prn_1",
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events: createSidecarEmitter(),
      claims: fakeClaims(),
      memory,
    });

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      errors: [],
      toolCalls: [
        {
          isError: false,
          // A model-supplied tenantId/principalId in the tool result must
          // never override the run's own authenticated identity — the
          // recognized shape doesn't even carry those fields, so there is
          // nothing to override with.
          result: JSON.stringify({
            id: "art_1",
            version: 1,
            title: "Notes",
            kind: "text",
            persisted: true,
          }),
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(added).toEqual([
      {
        tenantId: "ten_1",
        principalId: "prn_1",
        kind: "artifact",
        content: {
          title: "Notes",
          text: 'Library artifact "Notes" (text) was created.',
        },
        attributes: { artifactId: "art_1" },
      },
    ]);
  });

  test("records nothing when the memory plane is not mounted", async () => {
    const room = fakeRoom();
    const handler = createArtifactDeliveryHandler({
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({
        id: "run_1",
        tenantId: "ten_1",
        principalId: "prn_1",
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events: createSidecarEmitter(),
      claims: fakeClaims(),
    });

    // No throw, no memory dependency touched — `deps.memory` is absent.
    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      errors: [],
      toolCalls: [
        {
          isError: false,
          result: JSON.stringify({
            id: "art_1",
            version: 1,
            title: "Notes",
            kind: "text",
            persisted: true,
          }),
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("records nothing when the run has no principal to attribute the entry to", async () => {
    const { memory, added } = fakeMemory();
    const room = fakeRoom();
    const handler = createArtifactDeliveryHandler({
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({
        id: "run_1",
        tenantId: "ten_1",
        principalId: null,
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events: createSidecarEmitter(),
      claims: fakeClaims(),
      memory,
    });

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      errors: [],
      toolCalls: [
        {
          isError: false,
          result: JSON.stringify({
            id: "art_1",
            version: 1,
            title: "Notes",
            kind: "text",
            persisted: true,
          }),
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(added).toHaveLength(0);
  });

  // CL-6039: mirrors `createChatOrchestrator`'s own "a redelivered
  // gate-blocked event does not post a second card" test above, but for
  // the finalized-turn write surfaces, and one step further —
  // `postedApprovalIds` there is a plain `Set` scoped to one
  // orchestrator instance, so that test only proves same-process
  // redelivery is deduped. Here the SAME `claims` store is handed to two
  // separately-constructed handlers, simulating what a hub restart looks
  // like from the write surfaces' point of view (a fresh process, a
  // fresh in-memory `Set` if there were one — but the durable claim
  // table survives), proving the dedup holds even then.
  test("a redelivered finalized turn posts no second FilePart and records no second memory entry, even across a restart-shaped new handler instance", async () => {
    const room = fakeRoom();
    const { memory, added } = fakeMemory();
    const claims = fakeClaims();
    const deps = {
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({
        id: "run_1",
        tenantId: "ten_1",
        principalId: "prn_1",
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events: createSidecarEmitter(),
      claims,
      memory,
    };
    const turn = {
      turnId: "turn_restart_1",
      errors: [],
      toolCalls: [
        {
          isError: false,
          result: JSON.stringify({
            id: "art_1",
            version: 1,
            title: "Notes",
            kind: "text",
            persisted: true,
          }),
        },
      ],
    };

    const firstHandler = createArtifactDeliveryHandler(deps);
    firstHandler("run_1@ten1.workbench.test", turn);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A brand-new handler, built fresh the way the hub would after a
    // restart — but backed by the same durable `claims` store.
    const secondHandler = createArtifactDeliveryHandler(deps);
    secondHandler("run_1@ten1.workbench.test", turn);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(1);
    expect(added).toHaveLength(1);
  });

  // CL-6039 (critique follow-up): a claim won for one artifact must not
  // outlive a write that never happened. Before the release-on-failure
  // fix, the turn-wide claim meant the SECOND artifact's failure would
  // have permanently lost that entry (claim already held, redelivery
  // skips it) while the FIRST artifact's success was never at risk of
  // duplication in the first place — this test inverts that scenario:
  // proves the failed entry recovers on redelivery, and the succeeded
  // one is still not duplicated.
  test("a mid-loop memory.add failure loses no entry: the failed artifact recovers on redelivery, the one that already succeeded is not duplicated", async () => {
    const added: unknown[] = [];
    let addCalls = 0;
    const memory = {
      async add(params: unknown) {
        addCalls += 1;
        if (addCalls === 2) throw new Error("simulated memory.add failure");
        added.push(params);
        return { documentId: "doc_1", versionId: "ver_1" };
      },
    };
    const room = fakeRoom();
    const deps = {
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({
        id: "run_1",
        tenantId: "ten_1",
        principalId: "prn_1",
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events: createSidecarEmitter(),
      claims: fakeClaims(),
      memory,
    };
    const turn = {
      turnId: "turn_partial_1",
      errors: [],
      toolCalls: [
        {
          isError: false,
          result: JSON.stringify({
            id: "art_1",
            version: 1,
            title: "First",
            kind: "text",
            persisted: true,
          }),
        },
        {
          isError: false,
          result: JSON.stringify({
            id: "art_2",
            version: 1,
            title: "Second",
            kind: "text",
            persisted: true,
          }),
        },
      ],
    };
    const handler = createArtifactDeliveryHandler(deps);

    handler("run_1@ten1.workbench.test", turn);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // art_1 recorded; art_2's add threw, releasing its claim.
    expect(added).toHaveLength(1);
    expect(
      (added[0] as { attributes: { artifactId: string } }).attributes
        .artifactId,
    ).toBe("art_1");

    // Redelivery: art_1's claim is still held (skipped, not re-added);
    // art_2's claim was released, so it is retried and this time
    // succeeds (addCalls no longer lands on the throwing 2nd call).
    handler("run_1@ten1.workbench.test", turn);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(added).toHaveLength(2);
    expect(
      added
        .map(
          (entry) =>
            (entry as { attributes: { artifactId: string } }).attributes
              .artifactId,
        )
        .sort(),
    ).toEqual(["art_1", "art_2"]);
  });

  test("a mid-loop post failure loses no FilePart: the failed workbench recovers on redelivery, the one that already succeeded is not duplicated", async () => {
    const room = fakeRoom({ failPostOnCall: 2 });
    const handler = createArtifactDeliveryHandler({
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({ id: "run_1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
          workbenchRow("ins_workbench2", ["run_1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events: createSidecarEmitter(),
      claims: fakeClaims(),
    });
    const turn = {
      turnId: "turn_partial_2",
      errors: [],
      toolCalls: [
        {
          isError: false,
          result: JSON.stringify({
            id: "art_1",
            version: 1,
            title: "Notes",
            kind: "text",
            persisted: true,
          }),
        },
      ],
    };

    handler("run_1@ten1.workbench.test", turn);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // One workbench got its FilePart; the other's post threw, releasing
    // its claim.
    expect(room.posted).toHaveLength(1);

    // Redelivery: the workbench that already succeeded is not reposted;
    // the one whose post failed is retried and this time succeeds.
    handler("run_1@ten1.workbench.test", turn);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(room.posted).toHaveLength(2);
    expect(room.posted.map((message) => message.workbenchId).sort()).toEqual([
      "ins_workbench1",
      "ins_workbench2",
    ]);
  });
});

// CL-6092: a finalized turn's classified inference failure — never any
// other error — reported to `providerHealth` when exactly one provider
// is connected.
describe("createArtifactDeliveryHandler provider health signal (CL-6092)", () => {
  function baseDeps(overrides?: {
    providerHealth?: { reportInferenceFailure: (args: unknown) => void };
    listConnectedProviders?: (tenantId: string) => Promise<readonly string[]>;
  }) {
    const room = fakeRoom();
    return {
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({ id: "run_1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events: createSidecarEmitter(),
      claims: fakeClaims(),
      ...overrides,
    };
  }

  test("reports a credential_failure error when exactly one provider is connected", async () => {
    const reported: unknown[] = [];
    const handler = createArtifactDeliveryHandler(
      baseDeps({
        providerHealth: {
          reportInferenceFailure: (args) => reported.push(args),
        },
        listConnectedProviders: async () => ["anthropic"],
      }),
    );

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      toolCalls: [],
      errors: [{ category: "credential_failure", message: "bad api key" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Reports the classified category, never the turn's own error message
    // (CL-6092) — a provider's runtime error text is never stored.
    expect(reported).toEqual([
      {
        tenantId: "ten_1",
        provider: "anthropic",
        category: "credential_failure",
      },
    ]);
  });

  test("reports a quota_exhausted error the same way", async () => {
    const reported: unknown[] = [];
    const handler = createArtifactDeliveryHandler(
      baseDeps({
        providerHealth: {
          reportInferenceFailure: (args) => reported.push(args),
        },
        listConnectedProviders: async () => ["openai"],
      }),
    );

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      toolCalls: [],
      errors: [{ category: "quota_exhausted", message: "quota exhausted" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reported).toHaveLength(1);
  });

  test("does not report an ordinary (non-classified) inference error", async () => {
    const reported: unknown[] = [];
    const handler = createArtifactDeliveryHandler(
      baseDeps({
        providerHealth: {
          reportInferenceFailure: (args) => reported.push(args),
        },
        listConnectedProviders: async () => ["anthropic"],
      }),
    );

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      toolCalls: [],
      errors: [{ category: "retryable", message: "temporary blip" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reported).toHaveLength(0);
  });

  test("does not report when the turn has no errors at all", async () => {
    const reported: unknown[] = [];
    const handler = createArtifactDeliveryHandler(
      baseDeps({
        providerHealth: {
          reportInferenceFailure: (args) => reported.push(args),
        },
        listConnectedProviders: async () => ["anthropic"],
      }),
    );

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      toolCalls: [],
      errors: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reported).toHaveLength(0);
  });

  test("never guesses a provider when more than one is connected", async () => {
    const reported: unknown[] = [];
    const handler = createArtifactDeliveryHandler(
      baseDeps({
        providerHealth: {
          reportInferenceFailure: (args) => reported.push(args),
        },
        listConnectedProviders: async () => ["anthropic", "openai"],
      }),
    );

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      toolCalls: [],
      errors: [{ category: "credential_failure", message: "bad api key" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reported).toHaveLength(0);
  });

  test("does nothing when no providerHealth port is configured", async () => {
    const handler = createArtifactDeliveryHandler(
      baseDeps({ listConnectedProviders: async () => ["anthropic"] }),
    );

    expect(() =>
      handler("run_1@ten1.workbench.test", {
        turnId: "turn_1",
        toolCalls: [],
        errors: [{ category: "credential_failure", message: "bad api key" }],
      }),
    ).not.toThrow();
  });
});

describe("createChatOrchestrator daily transcript digest (CL-5852 M3b)", () => {
  test("records at most one memory entry per workbench per day for a connector.reply", async () => {
    const { memory, added } = fakeMemory();
    const events = createSidecarEmitter();
    const room = fakeRoom();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({
        id: "ins_echo1",
        tenantId: "ten_1",
        principalId: "prn_1",
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
      memory,
    });

    const emitReply = (content: string) =>
      events.emit("agent.event", {
        agentAddress: "ins_echo1@ten1.workbench.test",
        sessionId: "ses_1",
        event: { type: "connector.reply", data: { content } },
      });

    emitReply("first reply of the day");
    await new Promise((resolve) => setTimeout(resolve, 0));
    emitReply("second reply of the day");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      tenantId: "ten_1",
      principalId: "prn_1",
      kind: "transcript-digest",
      content: { text: "first reply of the day" },
      attributes: { workbenchId: "ins_workbench1" },
    });

    orchestrator.dispose();
  });

  test("records nothing when the memory plane is not mounted", async () => {
    const events = createSidecarEmitter();
    const room = fakeRoom();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({
        id: "ins_echo1",
        tenantId: "ten_1",
        principalId: "prn_1",
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hi" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    orchestrator.dispose();
  });

  // CL-6039: the digest's once-per-workbench-per-day bound used to be the
  // process-local `ingestedWorkbenchDays` Set documented (before this
  // change) as "resets on restart". Folded into the same durable
  // `claims` store the two posters above use, so — unlike before — a
  // restart no longer risks a second digest entry for a day already
  // ingested.
  test("still records at most one digest entry per workbench per day across a restart-shaped new orchestrator instance", async () => {
    const { memory, added } = fakeMemory();
    const claims = fakeClaims();
    const room = fakeRoom();
    const deps = {
      db: createFakeDb({
        id: "ins_echo1",
        tenantId: "ten_1",
        principalId: "prn_1",
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      approvals: { findByCorrelationId: async () => null },
      claims,
      memory,
    };

    const firstEvents = createSidecarEmitter();
    const firstOrchestrator = createChatOrchestrator({
      ...deps,
      events: firstEvents,
    });
    firstEvents.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "first reply" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    firstOrchestrator.dispose();

    // A brand-new orchestrator, built fresh the way the hub would after
    // a restart — but backed by the same durable `claims` store, so its
    // own fresh (and here entirely absent) in-process state can't
    // re-ingest the day's digest.
    const secondEvents = createSidecarEmitter();
    const secondOrchestrator = createChatOrchestrator({
      ...deps,
      events: secondEvents,
    });
    secondEvents.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "second reply" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    secondOrchestrator.dispose();

    expect(added).toHaveLength(1);
  });

  // CL-6039 (critique follow-up), the digest's narrower version of the
  // same finding: a workbench-day claim survives a `memory.add` that
  // throws unless the write is explicitly released, which would have
  // left that day's digest permanently un-recordable (claimed, but
  // never written, and no later reply that day can win the same claim).
  test("a memory.add failure releases the workbench-day claim, so the next reply that day still records a digest entry", async () => {
    let addCalls = 0;
    const added: unknown[] = [];
    const memory = {
      async add(params: unknown) {
        addCalls += 1;
        if (addCalls === 1) throw new Error("simulated memory.add failure");
        added.push(params);
        return { documentId: "doc_1", versionId: "ver_1" };
      },
    };
    const events = createSidecarEmitter();
    const room = fakeRoom();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({
        id: "ins_echo1",
        tenantId: "ten_1",
        principalId: "prn_1",
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      roomMessages: room.roomMessages,
      publish: room.publish,
      platform: fakeMail().platform,
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
      memory,
    });

    const emitReply = (content: string) =>
      events.emit("agent.event", {
        agentAddress: "ins_echo1@ten1.workbench.test",
        sessionId: "ses_1",
        event: { type: "connector.reply", data: { content } },
      });

    emitReply("first reply of the day");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The first attempt failed, and nothing was recorded — but this
    // must not be permanent: the claim was released on failure.
    expect(added).toHaveLength(0);

    emitReply("second reply of the day");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      content: { text: "second reply of the day" },
    });

    orchestrator.dispose();
  });
});
