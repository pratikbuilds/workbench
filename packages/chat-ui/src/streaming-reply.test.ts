import { describe, expect, test } from "bun:test";

import {
  hydrateStreamingReplyFromTurn,
  isAwaitingReply,
  isPendingReply,
  nextStreamingReplyState,
  openPendingReply,
  typingAgentNames,
  lastHumanMessageParts,
} from "./streaming-reply";

const HUMAN = { address: "prn_sawyer", handle: "Sawyer" };
const ADA = { address: "prn_ada@acme.example", handle: "Ada" };
const MYRA = { address: "myra@agents.example", handle: "Myra" };
const SCOUT = { address: "scout@agents.example", handle: "Scout" };

function agentEvent(inner: unknown) {
  return { eventType: "chat.agent", data: inner };
}

function delta(text: string) {
  return agentEvent({
    type: "inference.text.delta",
    seq: 1,
    data: { token: text.slice(-1), partial: { text } },
  });
}

const AWAITING_EMPTY = { phase: "awaiting", text: "" } as const;

function awaiting(text: string) {
  return { phase: "awaiting", text } as const;
}

describe("nextStreamingReplyState (CL-6115: token deltas fold into a growing reply)", () => {
  test("a non chat.agent event never opens or changes the reply", () => {
    expect(
      nextStreamingReplyState(null, { eventType: "chat.typing", data: {} }),
    ).toBeNull();
    const current = awaiting("hi");
    expect(
      nextStreamingReplyState(current, {
        eventType: "chat.pin",
        data: { type: "inference.text.delta" },
      }),
    ).toBe(current);
  });

  test("inference.start opens an empty in-progress reply", () => {
    expect(
      nextStreamingReplyState(
        null,
        agentEvent({ type: "inference.start", seq: 0, data: { model: "x" } }),
      ),
    ).toEqual(AWAITING_EMPTY);
  });

  test("inference.start never wipes tokens already streamed", () => {
    const state = awaiting("Hello");
    expect(
      nextStreamingReplyState(
        state,
        agentEvent({ type: "inference.start", seq: 9, data: { model: "x" } }),
      ),
    ).toBe(state);
  });

  test("each text delta replaces the reply with that delta's cumulative text", () => {
    let state = nextStreamingReplyState(
      null,
      agentEvent({ type: "inference.start", seq: 0, data: { model: "x" } }),
    );
    state = nextStreamingReplyState(state, delta("Hel"));
    expect(state).toEqual(awaiting("Hel"));
    state = nextStreamingReplyState(state, delta("Hello"));
    expect(state).toEqual(awaiting("Hello"));
  });

  test("inference.done clears the reply — the persisted message takes over", () => {
    const state = nextStreamingReplyState(
      awaiting("Hello there"),
      agentEvent({
        type: "inference.done",
        seq: 5,
        data: { turn: {}, usage: {}, source: "primary" },
      }),
    );
    expect(state).toBeNull();
  });

  test("inference.done keeps an empty pending reply — the next inference round is still owed", () => {
    const pending = awaiting("");
    expect(
      nextStreamingReplyState(
        pending,
        agentEvent({
          type: "inference.done",
          seq: 5,
          data: { turn: {}, usage: {}, source: "primary" },
        }),
      ),
    ).toBe(pending);
  });

  test("inference.done while idle stays idle — a late done is not a new turn", () => {
    expect(
      nextStreamingReplyState(
        null,
        agentEvent({
          type: "inference.done",
          seq: 5,
          data: { turn: {}, usage: {}, source: "primary" },
        }),
      ),
    ).toBeNull();
  });

  test("inference.error clears the reply rather than leaving a stuck cursor", () => {
    const state = nextStreamingReplyState(
      awaiting("Hello"),
      agentEvent({
        type: "inference.error",
        seq: 5,
        data: { error: {}, partial: { text: "Hello" } },
      }),
    );
    expect(state).toBeNull();
  });

  test("an event with no known inner shape (tool calls, usage) leaves the reply untouched", () => {
    const state = awaiting("Hello");
    expect(
      nextStreamingReplyState(
        state,
        agentEvent({
          type: "inference.tool_call.start",
          seq: 3,
          data: { callId: "c1", name: "search", partial: { text: "Hello" } },
        }),
      ),
    ).toBe(state);
  });

  test("reactor.start opens an empty reply when idle — the turn began before any tokens", () => {
    expect(
      nextStreamingReplyState(
        null,
        agentEvent({ type: "reactor.start", seq: 0, data: {} }),
      ),
    ).toEqual(AWAITING_EMPTY);
  });

  test("reactor.start never resets an in-progress reply", () => {
    const state = awaiting("Hello");
    expect(
      nextStreamingReplyState(
        state,
        agentEvent({ type: "reactor.start", seq: 9, data: {} }),
      ),
    ).toBe(state);
  });

  test("reactor.done and reactor.error clear the reply — the whole turn is over", () => {
    for (const type of ["reactor.done", "reactor.error"]) {
      expect(
        nextStreamingReplyState(
          awaiting("Hello"),
          agentEvent({ type, seq: 10, data: {} }),
        ),
      ).toBeNull();
    }
  });

  test("a malformed delta payload (no partial.text) is ignored rather than crashing", () => {
    const state = awaiting("Hello");
    expect(
      nextStreamingReplyState(
        state,
        agentEvent({ type: "inference.text.delta", seq: 2, data: {} }),
      ),
    ).toBe(state);
    expect(nextStreamingReplyState(state, agentEvent(null))).toBe(state);
    expect(nextStreamingReplyState(state, agentEvent("garbage"))).toBe(state);
  });
});

describe("nextStreamingReplyState (CL-6376: the typing pulse clears on a dispatch failure too)", () => {
  test("a chat.message carrying a turnFailed part clears a pending reply", () => {
    const state = awaiting("");
    expect(
      nextStreamingReplyState(state, {
        eventType: "chat.message",
        data: {
          id: "msg_1",
          parts: [
            { kind: "text", text: "I didn't get that one", turnFailed: true },
          ],
        },
      }),
    ).toBeNull();
  });

  test("an ordinary chat.message (no turnFailed part) leaves the reply untouched", () => {
    const state = awaiting("");
    expect(
      nextStreamingReplyState(state, {
        eventType: "chat.message",
        data: { id: "msg_1", parts: [{ kind: "text", text: "hi" }] },
      }),
    ).toBe(state);
  });

  test("a chat.message with no pending reply stays null", () => {
    expect(
      nextStreamingReplyState(null, {
        eventType: "chat.message",
        data: { parts: [{ kind: "text", text: "x", turnFailed: true }] },
      }),
    ).toBeNull();
  });
});

// CL-7201: a user-cancelled turn clears the same pulse a failed one does
// — `postCancelledNotice` carries `turnCancelled`, not `turnFailed`, so
// this is its own case rather than reusing the failure fixture above.
describe("nextStreamingReplyState (CL-7201: the typing pulse clears on a user cancellation too)", () => {
  test("a chat.message carrying a turnCancelled part settles the turn as replied", () => {
    const state = awaiting("");
    expect(
      nextStreamingReplyState(state, {
        eventType: "chat.message",
        data: {
          id: "msg_1",
          parts: [
            {
              kind: "text",
              text: "This turn was cancelled.",
              turnCancelled: true,
            },
          ],
        },
      }),
    ).toEqual({ phase: "replied" });
  });

  test("a chat.message from the cancelled agent's own address is never mistaken for a rendered reply", () => {
    const state = awaiting("");
    expect(
      nextStreamingReplyState(state, {
        eventType: "chat.message",
        data: {
          id: "msg_1",
          sender: { name: null, address: MYRA.address },
          parts: [
            {
              kind: "text",
              text: "This turn was cancelled.",
              turnCancelled: true,
            },
          ],
        },
      }),
    ).toEqual({ phase: "replied" });
  });

  test("inference.start after a turnCancelled notice does not reopen the pulse", () => {
    let state = nextStreamingReplyState(awaiting("Hello"), {
      eventType: "chat.message",
      data: {
        id: "msg_1",
        parts: [
          {
            kind: "text",
            text: "This turn was cancelled.",
            turnCancelled: true,
          },
        ],
      },
    });
    state = nextStreamingReplyState(
      state,
      agentEvent({ type: "inference.start", seq: 9, data: { model: "x" } }),
    );
    expect(isPendingReply(state)).toBe(false);
    expect(isAwaitingReply(state)).toBe(false);
  });

  test("a late text delta after a turnCancelled notice does not reopen the pulse", () => {
    let state = nextStreamingReplyState(awaiting("Hel"), {
      eventType: "chat.message",
      data: {
        id: "msg_1",
        parts: [
          {
            kind: "text",
            text: "This turn was cancelled.",
            turnCancelled: true,
          },
        ],
      },
    });
    state = nextStreamingReplyState(state, delta("Hello"));
    expect(isPendingReply(state)).toBe(false);
    expect(isAwaitingReply(state)).toBe(false);
  });

  test("reactor.start after a turnCancelled notice does not reopen the pulse", () => {
    let state = nextStreamingReplyState(awaiting(""), {
      eventType: "chat.message",
      data: {
        id: "msg_1",
        parts: [
          {
            kind: "text",
            text: "This turn was cancelled.",
            turnCancelled: true,
          },
        ],
      },
    });
    state = nextStreamingReplyState(
      state,
      agentEvent({ type: "reactor.start", seq: 0, data: {} }),
    );
    expect(isPendingReply(state)).toBe(false);
    expect(isAwaitingReply(state)).toBe(false);
  });
});

describe("isAwaitingReply (CL-7201: Stop stays up while tokens stream)", () => {
  test("is true for the whole awaiting phase, including streamed text", () => {
    expect(isAwaitingReply(awaiting(""))).toBe(true);
    expect(isAwaitingReply(awaiting("Hello"))).toBe(true);
  });

  test("is false when idle or already replied", () => {
    expect(isAwaitingReply(null)).toBe(false);
    expect(isAwaitingReply({ phase: "replied" })).toBe(false);
  });

  test("isPendingReply is only the tokenless pulse — not the Stop predicate", () => {
    expect(isPendingReply(awaiting("Hello"))).toBe(false);
    expect(isAwaitingReply(awaiting("Hello"))).toBe(true);
  });
});

describe("nextStreamingReplyState (CL-false-no-reply: rendered content, not a lifecycle event, ends the turn)", () => {
  test("a chat.message from the awaiting turn's agent moves straight to replied — the reply already rendered, connector.reply or not", () => {
    const state = awaiting("Full answer.");
    expect(
      nextStreamingReplyState(state, {
        eventType: "chat.message",
        data: {
          id: "msg_1",
          sender: { name: null, address: MYRA.address },
          parts: [{ kind: "text", text: "Full answer." }],
        },
      }),
    ).toEqual({ phase: "replied" });
  });

  test("a chat.message from the agent's own undelivered-notice address (turnFailed) is never mistaken for a rendered reply", () => {
    const state = awaiting("");
    expect(
      nextStreamingReplyState(state, {
        eventType: "chat.message",
        data: {
          id: "msg_1",
          sender: { name: null, address: MYRA.address },
          parts: [
            { kind: "text", text: "I didn't get that one", turnFailed: true },
          ],
        },
      }),
    ).toBeNull();
  });

  test("a chat.message from a human sender never ends the turn — it's not the agent's reply", () => {
    const state = awaiting("");
    expect(
      nextStreamingReplyState(state, {
        eventType: "chat.message",
        data: {
          id: "msg_1",
          sender: { name: null, address: HUMAN.address },
          parts: [{ kind: "text", text: "hi" }],
        },
      }),
    ).toBe(state);
  });

  test("a chat.message with no content parts never ends the turn", () => {
    const state = awaiting("");
    expect(
      nextStreamingReplyState(state, {
        eventType: "chat.message",
        data: {
          id: "msg_1",
          sender: { name: null, address: MYRA.address },
          parts: [],
        },
      }),
    ).toBe(state);
  });
});

describe("nextStreamingReplyState (CL-6432 reopened: a folded run parks after the reply — post-reply tool rounds never re-open the pulse)", () => {
  test("connector.reply moves the turn to the replied phase — the persisted message takes over the timeline", () => {
    expect(
      nextStreamingReplyState(
        awaiting("Hey! What are you working on right now?"),
        agentEvent({
          type: "connector.reply",
          seq: 9,
          data: { content: "Hey! What are you working on right now?" },
        }),
      ),
    ).toEqual({ phase: "replied" });
  });

  test("connector.reply settles an empty pending reply too — the reply is finalized even when its tokens never streamed here", () => {
    expect(
      nextStreamingReplyState(
        awaiting(""),
        agentEvent({
          type: "connector.reply",
          seq: 9,
          data: { content: "Hey!" },
        }),
      ),
    ).toEqual({ phase: "replied" });
  });

  test("the replied phase renders nothing — no pulse, no bubble", () => {
    const replied = nextStreamingReplyState(
      awaiting(""),
      agentEvent({ type: "connector.reply", seq: 9, data: { content: "x" } }),
    );
    expect(isPendingReply(replied)).toBe(false);
    expect(typingAgentNames(replied, [HUMAN, MYRA])).toEqual([]);
  });

  test("message.run.started opens the next turn's pulse — the one event that ends the replied phase from the stream", () => {
    const replied = nextStreamingReplyState(
      awaiting(""),
      agentEvent({ type: "connector.reply", seq: 9, data: { content: "x" } }),
    );
    expect(
      nextStreamingReplyState(
        replied,
        agentEvent({ type: "message.run.started", seq: 0, data: {} }),
      ),
    ).toEqual(AWAITING_EMPTY);
  });

  test("message.run.ended returns to idle from any phase — the bracket closed, nothing more streams", () => {
    for (const state of [awaiting(""), awaiting("Hello")]) {
      expect(
        nextStreamingReplyState(
          state,
          agentEvent({
            type: "message.run.ended",
            seq: 12,
            data: { status: "completed" },
          }),
        ),
      ).toBeNull();
    }
  });

  test("the live Myra sequence: reply posts, memory rounds follow, the run parks — the pulse never comes back", () => {
    // Captured from a live folded run (scratch stack, real provider): the
    // run brackets open per dequeued message, the visible reply streams
    // and posts via connector.reply, then post-reply tool-only rounds
    // (memory writes) run inference again, and the run PARKS — no
    // message.run.ended ever arrives.
    let state = openPendingReply(null);
    state = nextStreamingReplyState(
      state,
      agentEvent({ type: "message.run.started", seq: 0, data: {} }),
    );
    state = nextStreamingReplyState(
      state,
      agentEvent({ type: "inference.start", seq: 1, data: { model: "x" } }),
    );
    expect(isPendingReply(state)).toBe(true);
    state = nextStreamingReplyState(
      state,
      delta("Hey! What are you working on right now?"),
    );
    state = nextStreamingReplyState(
      state,
      agentEvent({
        type: "inference.done",
        seq: 4,
        data: { turn: {}, usage: {}, source: "primary" },
      }),
    );
    state = nextStreamingReplyState(
      state,
      agentEvent({
        type: "connector.reply",
        seq: 5,
        data: { content: "Hey! What are you working on right now?" },
      }),
    );
    expect(state).toEqual({ phase: "replied" });

    // Post-reply memory rounds: inference.start must NOT re-open the
    // pulse, and the textless inference.done must not strand one either.
    for (const round of [
      agentEvent({ type: "inference.start", seq: 6, data: { model: "x" } }),
      agentEvent({
        type: "inference.tool_call.start",
        seq: 7,
        data: { callId: "c1", name: "memory_write" },
      }),
      agentEvent({
        type: "tool.done",
        seq: 8,
        data: { result: { callId: "c1", content: [], isError: false } },
      }),
      agentEvent({
        type: "inference.done",
        seq: 9,
        data: { turn: {}, usage: {}, source: "primary" },
      }),
      agentEvent({ type: "inference.start", seq: 10, data: { model: "x" } }),
      agentEvent({
        type: "inference.done",
        seq: 11,
        data: { turn: {}, usage: {}, source: "primary" },
      }),
    ]) {
      state = nextStreamingReplyState(state, round);
      expect(state).toEqual({ phase: "replied" });
      expect(isPendingReply(state)).toBe(false);
    }
    // The run parks here: no message.run.ended, and the state stays
    // invisible until the next turn's message.run.started.
  });

  test("the next user turn brings the pulse back — replied never suppresses a genuinely new turn", () => {
    const replied = nextStreamingReplyState(
      awaiting(""),
      agentEvent({ type: "connector.reply", seq: 5, data: { content: "x" } }),
    );
    // Locally, the send itself re-opens the pulse...
    expect(openPendingReply(replied)).toEqual(AWAITING_EMPTY);
    // ...and on the stream, the dequeued message's own bracket does.
    let state = nextStreamingReplyState(
      replied,
      agentEvent({ type: "message.run.started", seq: 0, data: {} }),
    );
    expect(isPendingReply(state)).toBe(true);
    state = nextStreamingReplyState(
      state,
      agentEvent({ type: "inference.start", seq: 1, data: { model: "x" } }),
    );
    expect(isPendingReply(state)).toBe(true);
  });
});

describe("openPendingReply", () => {
  test("opens an empty pending reply when idle", () => {
    expect(openPendingReply(null)).toEqual(AWAITING_EMPTY);
  });

  test("opens an empty pending reply from a replied previous turn", () => {
    expect(openPendingReply({ phase: "replied" })).toEqual(AWAITING_EMPTY);
  });

  test("never resets a reply already streaming", () => {
    const state = awaiting("Hel");
    expect(openPendingReply(state)).toBe(state);
  });
});

describe("typingAgentNames", () => {
  test("no active reply means nobody is typing", () => {
    expect(typingAgentNames(null, [MYRA])).toEqual([]);
  });

  test("a pending reply with no tokens names the workbench's agent participant", () => {
    expect(typingAgentNames(awaiting(""), [HUMAN, MYRA])).toEqual(["Myra"]);
  });

  test("once tokens stream the bubble takes over — the typing line goes quiet", () => {
    expect(typingAgentNames(awaiting("Hel"), [HUMAN, MYRA])).toEqual([]);
  });

  test('a slugified handle is shown as a display name — "myra" reads "Myra"', () => {
    expect(
      typingAgentNames(awaiting(""), [
        { address: "myra@agents.example", handle: "myra" },
      ]),
    ).toEqual(["Myra"]);
  });

  test("no agent participant on the workbench means nobody is named", () => {
    expect(typingAgentNames(awaiting(""), [HUMAN])).toEqual([]);
  });

  test("a resolved display name wins over the slug-derived one (CL-6424)", () => {
    expect(
      typingAgentNames(
        awaiting(""),
        [HUMAN, MYRA],
        undefined,
        new Map([[MYRA.address, "Myra the Helper"]]),
      ),
    ).toEqual(["Myra the Helper"]);
  });

  test("names the mentioned agent, not the first agent on the workbench", () => {
    const jimmy = { address: "jimmy@agents.example", handle: "jimmy" };
    expect(
      typingAgentNames(
        awaiting(""),
        [HUMAN, MYRA, jimmy],
        [{ kind: "text", text: "hey @jimmy take a look" }],
      ),
    ).toEqual(["Jimmy"]);
  });

  test("a 1:1 with no mention still names the only agent", () => {
    expect(
      typingAgentNames(
        awaiting(""),
        [HUMAN, MYRA],
        [{ kind: "text", text: "hello" }],
      ),
    ).toEqual(["Myra"]);
  });

  test("two agents and no mention names nobody — we do not guess Myra", () => {
    const jimmy = { address: "jimmy@agents.example", handle: "jimmy" };
    expect(
      typingAgentNames(
        awaiting(""),
        [HUMAN, MYRA, jimmy],
        [{ kind: "text", text: "hello everyone" }],
      ),
    ).toEqual([]);
  });

  test("a principal@domain human @mention of Scout among two agents names Scout", () => {
    expect(
      typingAgentNames(
        awaiting(""),
        [ADA, MYRA, SCOUT],
        lastHumanMessageParts([
          {
            sender: { address: ADA.address },
            parts: [{ kind: "text", text: "hey @Scout take a look" }],
          },
          {
            sender: { address: SCOUT.address },
            parts: [{ kind: "text", text: "stream" }],
            streaming: true,
          },
        ]),
      ),
    ).toEqual(["Scout"]);
  });
});

describe("lastHumanMessageParts", () => {
  test("returns the latest human message, skipping agents and streaming bubbles", () => {
    expect(
      lastHumanMessageParts([
        {
          sender: { address: "prn_ada@acme.example" },
          parts: [{ kind: "text", text: "older" }],
        },
        {
          sender: { address: "prn_ada@acme.example" },
          parts: [{ kind: "text", text: "hey @Scout" }],
        },
        {
          sender: { address: "scout@agents.example" },
          parts: [{ kind: "text", text: "on it" }],
        },
        {
          sender: { address: "myra@agents.example" },
          parts: [{ kind: "text", text: "stream" }],
          streaming: true,
        },
      ]),
    ).toEqual([{ kind: "text", text: "hey @Scout" }]);
  });

  test("empty timeline means no addressed parts", () => {
    expect(lastHumanMessageParts([])).toBeUndefined();
  });
});

describe("hydrateStreamingReplyFromTurn (CL-6380: reattach snapshot)", () => {
  test("no running turn resumes to nothing", () => {
    expect(hydrateStreamingReplyFromTurn(null)).toBeNull();
  });

  test("a running turn with committed text opens the reply carrying it", () => {
    expect(
      hydrateStreamingReplyFromTurn({ textSnapshot: "streamed so far" }),
    ).toEqual(awaiting("streamed so far"));
  });

  test("a running turn with no text yet opens the same empty pending pulse as openPendingReply", () => {
    expect(hydrateStreamingReplyFromTurn({ textSnapshot: null })).toEqual(
      AWAITING_EMPTY,
    );
  });
});
