import { describe, expect, test } from "bun:test";

import {
  AGENT_TURN_STALE_MS,
  createInMemoryAgentTurnStore,
  createTurnFreedSignal,
} from "./agent-turns";

const BASE = {
  tenantId: "ten_1",
  workbenchId: "wb_1",
  agentAddress: "ins_echo1@acme.example",
  requestMessageIds: ["msg_1"],
};

describe("createInMemoryAgentTurnStore", () => {
  test("a turn opens running, with the child run id its occurrence will use", async () => {
    const store = createInMemoryAgentTurnStore();
    const turn = await store.startTurn(BASE);

    expect(turn.status).toBe("running");
    expect(turn.occurrence).toBe(0);
    expect(turn.childRunId).toBe("turn__0");
    expect(turn.replyMessageId).toBeNull();
    expect(turn.endedAt).toBeNull();
    expect(turn.requestMessageIds).toEqual(["msg_1"]);
  });

  test("occurrences advance per (workbench, agent), never across them", async () => {
    const store = createInMemoryAgentTurnStore();
    const first = await store.startTurn(BASE);
    const second = await store.startTurn(BASE);
    const otherAgent = await store.startTurn({
      ...BASE,
      agentAddress: "ins_echo2@acme.example",
    });
    const otherWorkbench = await store.startTurn({
      ...BASE,
      workbenchId: "wb_2",
    });

    expect([first.childRunId, second.childRunId]).toEqual([
      "turn__0",
      "turn__1",
    ]);
    expect(otherAgent.childRunId).toBe("turn__0");
    expect(otherWorkbench.childRunId).toBe("turn__0");
  });

  test("finishing records the outcome, the reply, and the section run", async () => {
    const store = createInMemoryAgentTurnStore();
    const opened = await store.startTurn(BASE);

    const finished = await store.finishTurn({
      tenantId: BASE.tenantId,
      turnId: opened.id,
      status: "completed",
      sectionRunId: "wfr_section1",
      replyMessageId: "msg_reply",
    });

    expect(finished?.status).toBe("completed");
    expect(finished?.sectionRunId).toBe("wfr_section1");
    expect(finished?.replyMessageId).toBe("msg_reply");
    expect(finished?.endedAt).not.toBeNull();
    expect(finished?.childRunId).toBe(opened.childRunId);
  });

  test("a failed turn is recorded as failed, with its reason", async () => {
    const store = createInMemoryAgentTurnStore();
    const opened = await store.startTurn(BASE);

    const finished = await store.finishTurn({
      tenantId: BASE.tenantId,
      turnId: opened.id,
      status: "failed",
      error: "the agent never answered",
    });

    expect(finished?.status).toBe("failed");
    expect(finished?.error).toBe("the agent never answered");
  });

  test("a turn is never readable or writable from another tenant", async () => {
    const store = createInMemoryAgentTurnStore();
    const opened = await store.startTurn(BASE);

    expect(
      await store.getTurn({ tenantId: "ten_other", turnId: opened.id }),
    ).toBeUndefined();
    expect(
      await store.finishTurn({
        tenantId: "ten_other",
        turnId: opened.id,
        status: "completed",
      }),
    ).toBeUndefined();
  });

  test("listing is newest first and scoped to its workbench", async () => {
    const store = createInMemoryAgentTurnStore();
    const first = await store.startTurn(BASE);
    await Bun.sleep(2);
    const second = await store.startTurn(BASE);
    await store.startTurn({ ...BASE, workbenchId: "wb_2" });

    const listed = await store.listTurns({
      tenantId: BASE.tenantId,
      workbenchId: BASE.workbenchId,
    });
    expect(listed.map((turn) => turn.id)).toEqual([second.id, first.id]);
  });

  // CL-6396: two simultaneously-running rows for the same (workbench, agent)
  // are no longer a coin flip when the caller names the occurrence. The
  // newest-occurrence pick remains the documented fallback for a lookup
  // that omits childRunId (an old sidecar's agent.event frames).
  test("findRunningTurn names a specific occurrence when childRunId is given", async () => {
    const store = createInMemoryAgentTurnStore();
    const first = await store.startTurn(BASE);
    const second = await store.startTurn(BASE);
    expect(first.childRunId).toBe("turn__0");
    expect(second.childRunId).toBe("turn__1");
    expect(first.status).toBe("running");
    expect(second.status).toBe("running");

    expect((await store.findRunningTurn(BASE))?.id).toBe(second.id);
    expect(
      (await store.findRunningTurn({ ...BASE, childRunId: "turn__0" }))?.id,
    ).toBe(first.id);
    expect(
      (await store.findRunningTurn({ ...BASE, childRunId: "turn__1" }))?.id,
    ).toBe(second.id);
    expect(
      await store.findRunningTurn({ ...BASE, childRunId: "turn__9" }),
    ).toBeUndefined();
  });

  // CL-7200: listing used to sort by startedAt string alone, while
  // findRunningTurn sorted by occurrence. Two turns sharing a timestamp
  // (same-millisecond ISO strings compare equal) then disagreed — listing
  // kept Map insertion order, the running-turn resolver picked the later
  // occurrence. Both orderings share startedAt then occurrence as the
  // deterministic tiebreak so they name the same newest turn.
  test("listing and findRunningTurn agree when two turns share a timestamp", async () => {
    const clock = 1_000;
    const store = createInMemoryAgentTurnStore({ now: () => clock });
    const first = await store.startTurn(BASE);
    const second = await store.startTurn(BASE);
    expect(first.startedAt).toBe(second.startedAt);
    expect(second.occurrence).toBeGreaterThan(first.occurrence);

    expect((await store.findRunningTurn(BASE))?.id).toBe(second.id);
    const listed = await store.listTurns({
      tenantId: BASE.tenantId,
      workbenchId: BASE.workbenchId,
    });
    expect(listed.map((turn) => turn.id)).toEqual([second.id, first.id]);
  });

  // CL-6451: a dispatch the supervisor failed (or a hub that died
  // mid-turn) never sends the event that closes its row, so a turn
  // still `running` past the occurrence timeout is dead by construction
  // — it fails visibly instead of showing "typing" forever.
  test("a running turn past the stale cutoff reads back failed, never running", async () => {
    let clock = 1_000;
    const store = createInMemoryAgentTurnStore({ now: () => clock });
    await store.startTurn(BASE);

    clock += AGENT_TURN_STALE_MS + 1;

    expect(await store.findRunningTurn(BASE)).toBeUndefined();
    const listed = await store.listTurns({
      tenantId: BASE.tenantId,
      workbenchId: BASE.workbenchId,
    });
    expect(listed[0]?.status).toBe("failed");
    expect(listed[0]?.error).not.toBeNull();
    expect(listed[0]?.endedAt).not.toBeNull();
  });

  test("a running turn within the stale cutoff stays running", async () => {
    let clock = 1_000;
    const store = createInMemoryAgentTurnStore({ now: () => clock });
    const opened = await store.startTurn(BASE);

    clock += AGENT_TURN_STALE_MS - 1;

    expect((await store.findRunningTurn(BASE))?.id).toBe(opened.id);
  });

  test("starting a new turn expires a stale predecessor rather than leaving two running", async () => {
    let clock = 1_000;
    const store = createInMemoryAgentTurnStore({ now: () => clock });
    const stale = await store.startTurn(BASE);

    clock += AGENT_TURN_STALE_MS + 1;
    const fresh = await store.startTurn(BASE);

    expect((await store.findRunningTurn(BASE))?.id).toBe(fresh.id);
    expect(
      (await store.getTurn({ tenantId: BASE.tenantId, turnId: stale.id }))
        ?.status,
    ).toBe("failed");
  });

  // CL-6670: `dispatchTurn` awaits this before opening a second occurrence
  // for the same (workbench, agent) — the fix for two messages sent to
  // one agent a few seconds apart each winning a `running` row while the
  // other's reply was still in flight, which left `findRunningTurn`
  // guessing which real reply belonged to which row.
  describe("waitUntilFree (CL-6670)", () => {
    test("resolves immediately when the agent has no running turn", async () => {
      const store = createInMemoryAgentTurnStore();
      // No timeout needed: a hanging promise would fail this test itself.
      await store.waitUntilFree(BASE);
    });

    test("blocks until the running turn finishes, never before", async () => {
      const store = createInMemoryAgentTurnStore();
      const opened = await store.startTurn(BASE);

      let freed = false;
      const waiting = store.waitUntilFree(BASE).then(() => {
        freed = true;
      });

      // Give the pending promise every chance to (wrongly) resolve early.
      await Promise.resolve();
      await Promise.resolve();
      expect(freed).toBe(false);

      await store.finishTurn({
        tenantId: BASE.tenantId,
        turnId: opened.id,
        status: "completed",
      });
      await waiting;
      expect(freed).toBe(true);
    });

    test("a different agent's wait is never blocked by this one's turn", async () => {
      const store = createInMemoryAgentTurnStore();
      await store.startTurn(BASE);

      // Would hang (and fail the test on timeout) if this incorrectly
      // shared the first agent's gate.
      await store.waitUntilFree({
        ...BASE,
        agentAddress: "ins_other@acme.example",
      });
    });

    test("a failed turn also frees the wait", async () => {
      const store = createInMemoryAgentTurnStore();
      const opened = await store.startTurn(BASE);

      let freed = false;
      const waiting = store.waitUntilFree(BASE).then(() => {
        freed = true;
      });
      await Promise.resolve();
      expect(freed).toBe(false);

      await store.finishTurn({
        tenantId: BASE.tenantId,
        turnId: opened.id,
        status: "failed",
        error: "boom",
      });
      await waiting;
      expect(freed).toBe(true);
    });

    // CL-7193: a key that keeps timing out (nothing ever calls `notify`)
    // used to leave one abandoned resolve in the waiter Set per attempt
    // forever. An `AbortSignal` now lets a timed-out wait remove itself
    // immediately instead of lingering until its own backstop fires.
    test("an aborted wait throws instead of reporting the agent free", async () => {
      const store = createInMemoryAgentTurnStore();
      await store.startTurn(BASE);
      const controller = new AbortController();

      const waiting = store.waitUntilFree(BASE, controller.signal);
      controller.abort(new Error("deadline"));

      await expect(waiting).rejects.toThrow("deadline");
    });

    test("an already-aborted signal throws immediately, without polling", async () => {
      const store = createInMemoryAgentTurnStore();
      await store.startTurn(BASE);
      const controller = new AbortController();
      controller.abort(new Error("already gone"));

      await expect(
        store.waitUntilFree(BASE, controller.signal),
      ).rejects.toThrow("already gone");
    });
  });

  // CL-7193: `finishTurn` used to overwrite a turn's row unconditionally.
  // A dispatch deadline closing a turn as `failed` and the turn's own
  // late reply closing it as `completed` could race — whichever landed
  // last silently clobbered the other, discarding its `replyMessageId`.
  // `finishTurn` is now compare-and-set on `status === "running"`, so
  // exactly one of two racing closes ever applies.
  describe("finishTurn is compare-and-set on status (CL-7193)", () => {
    test("a second finishTurn call on an already-finished turn is a no-op", async () => {
      const store = createInMemoryAgentTurnStore();
      const opened = await store.startTurn(BASE);

      const first = await store.finishTurn({
        tenantId: BASE.tenantId,
        turnId: opened.id,
        status: "failed",
        error: "turn dispatch timed out",
      });
      expect(first?.status).toBe("failed");

      const second = await store.finishTurn({
        tenantId: BASE.tenantId,
        turnId: opened.id,
        status: "completed",
        replyMessageId: "msg_late_reply",
      });
      expect(second).toBeUndefined();

      const stored = await store.getTurn({
        tenantId: BASE.tenantId,
        turnId: opened.id,
      });
      expect(stored?.status).toBe("failed");
      expect(stored?.replyMessageId).toBeNull();
    });

    // CL-7201: a turn cancelled by the user must never be resurrected by
    // a real reply that lands after the fact -- exactly the same
    // guarantee CL-7193 already gives a timed-out turn against a late
    // reply, now exercised for the cancel outcome specifically, since
    // cancellation is a NEW way to close a turn out from under work
    // that is still in flight (an approval gate answer, an ordinary
    // reply) and has no code of its own to fall back on if
    // this compare-and-set ever regressed.
    test("a turn cancelled while a real reply is in flight cannot be reopened by that reply landing late", async () => {
      const store = createInMemoryAgentTurnStore();
      const opened = await store.startTurn(BASE);

      const cancelled = await store.finishTurn({
        tenantId: BASE.tenantId,
        turnId: opened.id,
        status: "cancelled",
        error: "Cancelled by user",
      });
      expect(cancelled?.status).toBe("cancelled");

      // The agent (or an approval gate answer correlating to this
      // turn) finishes its work anyway -- CL-7230's known ceiling
      // is that nothing here can stop it -- and tries to close the same
      // turn as a normal completed reply.
      const lateReply = await store.finishTurn({
        tenantId: BASE.tenantId,
        turnId: opened.id,
        status: "completed",
        replyMessageId: "msg_late_reply",
      });
      expect(lateReply).toBeUndefined();

      const stored = await store.getTurn({
        tenantId: BASE.tenantId,
        turnId: opened.id,
      });
      expect(stored?.status).toBe("cancelled");
      expect(stored?.replyMessageId).toBeNull();
    });
  });

  // CL-7201: the cancel endpoint's fallback sweep -- settling a turn
  // whose dispatch has already moved off the caller's own call stack
  // (its `sendMail` resolved, an abort signal has nothing left to
  // reach) -- must see every currently-running turn for a workbench,
  // not just the newest one. `listTurns` alone is the wrong primitive
  // for that sweep: it has no status filter and pages to
  // `AGENT_TURNS_PAGE_SIZE`, so a busy workbench could silently leave
  // older running turns unsettled.
  describe("findRunningTurns (CL-7201)", () => {
    test("returns every running turn for a workbench, across agents, excluding settled ones", async () => {
      const store = createInMemoryAgentTurnStore();
      const first = await store.startTurn(BASE);
      const second = await store.startTurn({
        ...BASE,
        agentAddress: "ins_echo2@acme.example",
      });
      const settled = await store.startTurn({
        ...BASE,
        agentAddress: "ins_echo3@acme.example",
      });
      await store.finishTurn({
        tenantId: BASE.tenantId,
        turnId: settled.id,
        status: "completed",
        replyMessageId: "msg_done",
      });
      await store.startTurn({ ...BASE, workbenchId: "wb_other" });

      const running = await store.findRunningTurns({
        tenantId: BASE.tenantId,
        workbenchId: BASE.workbenchId,
      });

      expect(new Set(running.map((turn) => turn.id))).toEqual(
        new Set([first.id, second.id]),
      );
    });

    test("returns nothing for a workbench with no running turns", async () => {
      const store = createInMemoryAgentTurnStore();
      const running = await store.findRunningTurns({
        tenantId: BASE.tenantId,
        workbenchId: BASE.workbenchId,
      });
      expect(running).toEqual([]);
    });
  });
});

// CL-7193: the process-local pubsub `waitUntilFree` is built on. Exercised
// directly because the defect it fixes -- a backstop firing before
// `notify` leaves its waiter in the Set forever -- is about the waiter
// bookkeeping itself, not any one store's behavior.
describe("createTurnFreedSignal (CL-7193)", () => {
  test("a backstop that fires before notify removes its own waiter from the Set", async () => {
    const freed = createTurnFreedSignal();

    await freed.wait("key", 1);

    expect(freed.waiterCount("key")).toBe(0);
  });

  test("repeated timed-out waits never grow the waiter Set", async () => {
    const freed = createTurnFreedSignal();

    for (let i = 0; i < 25; i++) {
      await freed.wait("key", 1);
    }

    expect(freed.waiterCount("key")).toBe(0);
  });

  test("notify clears the backstop timer so it never fires again after resolving", async () => {
    const freed = createTurnFreedSignal();
    const waiting = freed.wait("key", 10_000);

    freed.notify("key");
    await waiting;

    expect(freed.waiterCount("key")).toBe(0);
  });

  test("an aborted wait removes itself from the Set immediately", async () => {
    const freed = createTurnFreedSignal();
    const controller = new AbortController();

    const waiting = freed.wait("key", 10_000, controller.signal);
    expect(freed.waiterCount("key")).toBe(1);

    controller.abort();
    await waiting;

    expect(freed.waiterCount("key")).toBe(0);
  });

  test("a different key's waiters are never touched by another key's notify", async () => {
    const freed = createTurnFreedSignal();
    let otherFreed = false;
    const waiting = freed.wait("other", 10_000).then(() => {
      otherFreed = true;
    });

    freed.notify("key");
    await Promise.resolve();
    expect(otherFreed).toBe(false);
    expect(freed.waiterCount("other")).toBe(1);

    freed.notify("other");
    await waiting;
    expect(otherFreed).toBe(true);
  });
});
