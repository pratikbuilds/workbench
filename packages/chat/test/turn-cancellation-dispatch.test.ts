// CL-7201: cancellation has two independent ways to reach a running
// turn, and both must settle the row honestly (never claim `failed`
// for something the user asked for) with exactly one notice on the
// timeline:
//
// 1. The turn is still reachable on our own call stack (`waitUntilFree`
//    still waiting, or `dispatchTurn`'s `sendMail` still in flight) --
//    the cancellation registry's `AbortSignal` cuts it short directly.
// 2. The turn's dispatch has already resolved and moved off our call
//    stack entirely (the agent is generating, or parked on an approval
//    gate somewhere in the execution plane this package has no
//    visibility into) -- `cancelWorkbenchTurn`'s sweep
//    is the only thing left that can settle the row, per CL-7230's
//    ceiling: it can record the outcome, not stop the underlying work.
import { describe, expect, test } from "bun:test";

import { createInMemoryAgentTurnStore } from "../src/agent-turns";
import { createChatRoutes } from "../src/routes";
import { createTurnCancelRegistry } from "../src/turn-cancellation";
import { createWorkbenchSubscriberRegistry } from "../src/workbench-events";
import { cancelWorkbenchTurn } from "../src/workbench-service";
import {
  buildDeps,
  createWorkbench,
  fakePlatform,
  mountAs,
  settleFanout,
  TENANT,
  timelineOf,
} from "./test-support";

async function postHello(app: ReturnType<typeof mountAs>, workbenchId: string) {
  return app.request(`/workbenches/${workbenchId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ kind: "text", text: "hello" }] }),
  });
}

describe("cancelWorkbenchTurn (CL-7201)", () => {
  test("cancelling a turn stuck inside dispatchTurn's sendMail settles it cancelled, not failed, with one honest notice", async () => {
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "echo" }],
    });
    platform.sendMail = () => new Promise<never>(() => {});
    const agentTurns = createInMemoryAgentTurnStore();
    const turnCancellation = createTurnCancelRegistry();
    const workbenchSubscribers = createWorkbenchSubscriberRegistry();

    // Generous on purpose: proves cancellation beats the deadline rather
    // than racing it.
    const deps = buildDeps({
      platform,
      agentTurns,
      turnCancellation,
      workbenchSubscribers,
      turnDispatchTimeoutMs: 60_000,
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    void postHello(app, workbench.id);
    // Let dispatchTurn actually start (startTurn + the stuck sendMail
    // call) before cancelling -- otherwise there is nothing in flight
    // yet to cancel.
    await Bun.sleep(5);

    const result = await cancelWorkbenchTurn(
      {
        agentTurns,
        turnCancellation,
        roomMessages: deps.roomMessages,
        publish: workbenchSubscribers.publish,
      },
      { tenantId: TENANT.id, workbenchId: workbench.id },
    );
    await settleFanout();

    expect(result.cancelledCount).toBe(1);

    const turns = await agentTurns.listTurns({
      tenantId: TENANT.id,
      workbenchId: workbench.id,
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe("cancelled");

    const timeline = await timelineOf(deps, workbench.id);
    const cancelledNotices = timeline.filter((message) =>
      message.parts.some(
        (part) => part.kind === "text" && part.turnCancelled === true,
      ),
    );
    expect(cancelledNotices).toHaveLength(1);

    const undeliveredNotices = timeline.filter((message) =>
      message.parts.some(
        (part) => part.kind === "text" && part.turnFailed === true,
      ),
    );
    expect(undeliveredNotices).toHaveLength(0);
  });

  test("cancelling a turn whose dispatch already resolved off our call stack still settles it via the sweep", async () => {
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "echo" }],
    });
    const agentTurns = createInMemoryAgentTurnStore();
    const turnCancellation = createTurnCancelRegistry();
    const workbenchSubscribers = createWorkbenchSubscriberRegistry();
    const deps = buildDeps({
      platform,
      agentTurns,
      turnCancellation,
      workbenchSubscribers,
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    await postHello(app, workbench.id);
    await settleFanout();

    // Sanity: nothing in this harness closes the row on its own --
    // proves the later "cancelled" status came from the sweep, not from
    // some other path already having settled it.
    const beforeCancel = await agentTurns.listTurns({
      tenantId: TENANT.id,
      workbenchId: workbench.id,
    });
    expect(beforeCancel[0]?.status).toBe("running");

    const result = await cancelWorkbenchTurn(
      {
        agentTurns,
        turnCancellation,
        roomMessages: deps.roomMessages,
        publish: workbenchSubscribers.publish,
      },
      { tenantId: TENANT.id, workbenchId: workbench.id },
    );

    expect(result.cancelledCount).toBe(1);
    const after = await agentTurns.listTurns({
      tenantId: TENANT.id,
      workbenchId: workbench.id,
    });
    expect(after[0]?.status).toBe("cancelled");

    const timeline = await timelineOf(deps, workbench.id);
    const cancelledNotices = timeline.filter((message) =>
      message.parts.some(
        (part) => part.kind === "text" && part.turnCancelled === true,
      ),
    );
    expect(cancelledNotices).toHaveLength(1);
  });

  test("a late reply landing after cancellation cannot reopen the turn", async () => {
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "echo" }],
    });
    const agentTurns = createInMemoryAgentTurnStore();
    const turnCancellation = createTurnCancelRegistry();
    const workbenchSubscribers = createWorkbenchSubscriberRegistry();
    const deps = buildDeps({
      platform,
      agentTurns,
      turnCancellation,
      workbenchSubscribers,
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    await postHello(app, workbench.id);
    await settleFanout();

    await cancelWorkbenchTurn(
      {
        agentTurns,
        turnCancellation,
        roomMessages: deps.roomMessages,
        publish: workbenchSubscribers.publish,
      },
      { tenantId: TENANT.id, workbenchId: workbench.id },
    );

    const [turn] = await agentTurns.listTurns({
      tenantId: TENANT.id,
      workbenchId: workbench.id,
    });
    if (turn === undefined) throw new Error("expected a turn to be running");
    const lateReply = await agentTurns.finishTurn({
      tenantId: TENANT.id,
      turnId: turn.id,
      status: "completed",
      replyMessageId: "msg_late",
    });
    expect(lateReply).toBeUndefined();

    const stored = await agentTurns.getTurn({
      tenantId: TENANT.id,
      turnId: turn.id,
    });
    expect(stored?.status).toBe("cancelled");
  });

  test("cancelling a workbench with nothing running is a harmless no-op", async () => {
    const agentTurns = createInMemoryAgentTurnStore();
    const turnCancellation = createTurnCancelRegistry();
    const workbenchSubscribers = createWorkbenchSubscriberRegistry();
    const deps = buildDeps({
      agentTurns,
      turnCancellation,
      workbenchSubscribers,
    });

    const result = await cancelWorkbenchTurn(
      {
        agentTurns,
        turnCancellation,
        roomMessages: deps.roomMessages,
        publish: workbenchSubscribers.publish,
      },
      { tenantId: TENANT.id, workbenchId: "wb_never_ran" },
    );

    expect(result.cancelledCount).toBe(0);
  });

  test("cancelling without an agentTurns store configured never throws", async () => {
    const turnCancellation = createTurnCancelRegistry();
    const workbenchSubscribers = createWorkbenchSubscriberRegistry();
    const deps = buildDeps({ turnCancellation, workbenchSubscribers });

    const result = await cancelWorkbenchTurn(
      {
        turnCancellation,
        roomMessages: deps.roomMessages,
        publish: workbenchSubscribers.publish,
      },
      { tenantId: TENANT.id, workbenchId: "wb_1" },
    );

    expect(result.cancelledCount).toBe(0);
  });

  test("timeout and cancel during in-flight sendMail produce exactly one notice", async () => {
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "echo" }],
    });
    platform.sendMail = () => new Promise<never>(() => {});
    const agentTurns = createInMemoryAgentTurnStore();
    const turnCancellation = createTurnCancelRegistry();
    const workbenchSubscribers = createWorkbenchSubscriberRegistry();
    const deps = buildDeps({
      platform,
      agentTurns,
      turnCancellation,
      workbenchSubscribers,
      turnDispatchTimeoutMs: 20,
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    void postHello(app, workbench.id);
    await Bun.sleep(5);

    const result = await cancelWorkbenchTurn(
      {
        agentTurns,
        turnCancellation,
        roomMessages: deps.roomMessages,
        publish: workbenchSubscribers.publish,
      },
      { tenantId: TENANT.id, workbenchId: workbench.id },
    );
    await settleFanout();

    expect(result.cancelledCount).toBe(1);

    const timeline = await timelineOf(deps, workbench.id);
    const notices = timeline.filter((message) =>
      message.parts.some(
        (part) =>
          part.kind === "text" &&
          (part.turnCancelled === true || part.turnFailed === true),
      ),
    );
    expect(notices).toHaveLength(1);
    expect(
      notices[0]?.parts.some(
        (part) => part.kind === "text" && part.turnCancelled === true,
      ),
    ).toBe(true);
  });
});
