// Fan-out, context-loading, and join/invite behavior — the surface
// `./workbench-service.ts`'s `sendWorkbenchMessage` and `launchAndJoinAgent`
// own — exercised through the HTTP layer. Split out of
// `routes.test.ts` alongside the module itself.
import { describe, expect, test } from "bun:test";
import { InferenceResolutionError } from "@corbits/folded-runs";
import { createChatRoutes } from "../src/routes";
import { decodeParts } from "../src/codec";
import type { Part, TextPart } from "../src/parts";
import { createInMemoryWorkbenchTenancyStore } from "../src/workbench-tenancy";
import { AgentUnreachableError } from "../src/platform-port";
import {
  cannedGreeting,
  joinHumanParticipant,
  KindIsChatError,
  launchAndJoinAgent,
  postCannedGreeting,
  removeWorkbenchParticipant,
} from "../src/workbench-service";
import { createInMemoryChatStore } from "../src/store";
import {
  buildDeps,
  createWorkbench,
  fakePlatform,
  mountAs,
  nextTimelineMoment,
  settleFanout,
  TENANT,
  timelineEvents,
  timelineOf,
  timelineTexts,
} from "./test-support";
import {
  createInMemoryRoomMessageStore,
  postRoomMessage,
} from "../src/room-messages";
import { createInMemoryTurnMailCorrelationStore } from "../src/turn-mail-correlation";
import { createWorkbenchSubscriberRegistry } from "../src/workbench-events";
import type { ChatWorkbenchEvent } from "../src/platform-port";

describe("postCannedGreeting (CL-6126)", () => {
  test("posts the greeting onto the chat's own timeline, attributed to the agent's run", async () => {
    const roomMessages = createInMemoryRoomMessageStore();

    await postCannedGreeting(
      { roomMessages, publish: () => undefined },
      {
        tenantId: TENANT.id,
        workbenchId: "chan_1",
        agentAddress: "ins_agent1@acme.example",
        agentName: "Myra",
        senderName: "Alice",
      },
    );

    const listed = await roomMessages.listMessages({
      tenantId: TENANT.id,
      workbenchId: "chan_1",
    });
    expect(listed.items).toHaveLength(1);
    const posted = listed.items[0];
    expect(posted?.workbenchId).toBe("chan_1");
    expect(posted?.sender.address).toBe("ins_agent1@acme.example");
    expect(posted?.runId).toBe("ins_agent1");
    expect(posted?.parts).toEqual([
      {
        kind: "text",
        text: cannedGreeting({
          workbenchId: "chan_1",
          agentName: "Myra",
          senderName: "Alice",
        }),
      },
    ]);
  });

  test("the greeting names the opener and the agent, asks a question, and never names the workbench title", () => {
    const greeting = cannedGreeting({
      workbenchId: "chan_1",
      agentName: "Myra",
      senderName: "Ada",
    });
    expect(greeting).toContain("Ada");
    expect(greeting).toContain("Myra");
    expect(greeting).toMatch(/\?$/);
    expect(greeting).not.toContain("undefined");
  });

  test("a blank room's greeting offers agents, routines, and a shared channel, not catalog templates", () => {
    for (const workbenchId of ["chan_0", "chan_1", "chan_2", "chan_3"]) {
      const greeting = cannedGreeting({ workbenchId, agentName: "Myra" });
      expect(greeting).toMatch(/create more agents/i);
      expect(greeting).toMatch(/routines/i);
      expect(greeting).toMatch(/shared channel/i);
      expect(greeting).not.toMatch(/code[- ]review/i);
      expect(greeting).not.toMatch(/due[- ]diligence/i);
      expect(greeting).not.toMatch(/what do you want your Workbench to do/i);
    }
  });

  test("a blank room's greeting talks like a teammate offering next steps", () => {
    const greeting = cannedGreeting({
      workbenchId: "chan_1",
      agentName: "Myra",
    });
    expect(greeting).toMatch(/teammate|together|ours to work in/i);
    expect(greeting).toMatch(/create more agents/i);
    expect(greeting).toMatch(/set up routines/i);
    expect(greeting).toMatch(/open a shared channel/i);
  });

  test("the same chat always gets the same variation", () => {
    const input = { workbenchId: "chan_1", agentName: "Myra" };
    expect(cannedGreeting(input)).toBe(cannedGreeting(input));
  });

  test("different chats reach every variation", () => {
    const seeds = Array.from({ length: 32 }, (_, i) => `chan_${i}`);
    const variations = new Set(
      seeds.map((workbenchId) =>
        cannedGreeting({ workbenchId, agentName: "Myra" }),
      ),
    );
    expect(variations.size).toBe(4);
  });

  test.each(["chan_0", "chan_1", "chan_2", "chan_3"])(
    "an absent or empty sender name reads naturally (%s)",
    (workbenchId) => {
      const unnamed = cannedGreeting({ workbenchId, agentName: "Myra" });
      expect(unnamed).not.toContain("undefined");
      expect(unnamed).not.toContain("  ");
      expect(unnamed).toBe(
        cannedGreeting({ workbenchId, agentName: "Myra", senderName: "" }),
      );
    },
  );

  test("a post failure is swallowed, never thrown", async () => {
    const roomMessages = createInMemoryRoomMessageStore();
    roomMessages.insertMessage = async () => {
      throw new Error("the timeline is unavailable");
    };

    await expect(
      postCannedGreeting(
        { roomMessages, publish: () => undefined },
        {
          tenantId: TENANT.id,
          workbenchId: "chan_1",
          agentAddress: "ins_agent1@acme.example",
          agentName: "Myra",
        },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("message fan-out", () => {
  test("a mentioned agent is asked for a turn on its own mailbox, from the workbench", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "demo",
      participants: ["ins_echo1@acme.example"],
    });

    const parts: Part[] = [{ kind: "text", text: "hi @ins_echo1" }];
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      },
    );

    expect(response.status).toBe(201);
    await settleFanout();

    // The message itself is a row on the workbench's own timeline; the
    // one mail the send makes is the turn dispatch, addressed to the
    // agent's own instance and never to the room.
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.sentMail).toHaveLength(1);
    const dispatch = platform.sentMail[0];
    expect(dispatch?.workbenchId).toBe("ins_echo1");
    expect(dispatch?.fromWorkbenchId).toBe(workbench.id);
    expect(timelineTexts(await timelineOf(deps, workbench.id))).toEqual([
      "hi @ins_echo1",
    ]);
  });

  test("a turn dispatch records which message its mail answers (CL-6314)", async () => {
    const turnMail = createInMemoryTurnMailCorrelationStore();
    const deps = buildDeps({ turnMailCorrelation: turnMail });
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const dispatchMailIds: string[] = [];
    const deliverMail = platform.sendMail.bind(platform);
    platform.sendMail = async (input) => {
      const sent = await deliverMail(input);
      dispatchMailIds.push(sent.id);
      return sent;
    };
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "demo",
      participants: ["ins_echo1@acme.example"],
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hi @ins_echo1" }],
        }),
      },
    );

    expect(response.status).toBe(201);
    const sentBody = (await response.json()) as { id: string };
    await settleFanout();

    // The one mail the send made is the turn dispatch; its id is
    // recorded against the posted message — the correlation the reply
    // path reads back when the agent answers.
    expect(platform.sentMail).toHaveLength(1);
    const dispatchMailId = dispatchMailIds[0];
    if (dispatchMailId === undefined) {
      throw new Error("expected the dispatch to send one mail");
    }
    expect(
      await turnMail.findTurnMailSource({
        tenantId: TENANT.id,
        mailId: dispatchMailId,
      }),
    ).toEqual({
      tenantId: TENANT.id,
      workbenchId: workbench.id,
      sourceMessageId: sentBody.id,
    });
  });

  test("a posted message returns before the agents it names are asked for a turn", async () => {
    // The dispatch is held open, so "the sender's own message is on the
    // timeline while the routing is still in flight" is a fact about
    // ordering rather than a race the in-memory fake happens to win.
    let releaseDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const platform = fakePlatform();
    const deliverMail = platform.sendMail.bind(platform);
    platform.sendMail = async (input) => {
      if (input.workbenchId === "ins_echo1") await delivery;
      return deliverMail(input);
    };
    const deps = buildDeps({ platform });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hi @ins_echo1" }],
        }),
      },
    );

    expect(response.status).toBe(201);
    expect(timelineTexts(await timelineOf(deps, workbench.id))).toEqual([
      "hi @ins_echo1",
    ]);
    expect(platform.sentMail).toHaveLength(0);

    releaseDelivery();
    await settleFanout();
    expect(platform.sentMail).toHaveLength(1);
    expect(platform.sentMail[0]?.workbenchId).toBe("ins_echo1");
  });

  test("an undeliverable recipient is reported on the timeline in its own voice", async () => {
    const platform = fakePlatform();
    const deliverMail = platform.sendMail.bind(platform);
    platform.sendMail = async (input) => {
      if (input.workbenchId === "ins_echo1") {
        throw new Error("agent is unreachable");
      }
      return deliverMail(input);
    };
    const deps = buildDeps({ platform });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hi @ins_echo1" }],
        }),
      },
    );

    // The sender's own message still stands — only its delivery failed.
    expect(response.status).toBe(201);
    await settleFanout();

    // The notice lands on the workbench's own timeline, in the agent's
    // voice and under its own address — never as mail to the agent that
    // could not be reached in the first place.
    const timeline = await timelineOf(deps, workbench.id);
    const notice = timeline.find(
      (message) => message.sender.address === "ins_echo1@acme.example",
    );
    expect(notice?.workbenchId).toBe(workbench.id);
    expect(notice?.runId).toBe("ins_echo1");
    expect(notice?.parts).toEqual([
      {
        kind: "text",
        text: expect.stringContaining("send it again"),
        turnFailed: true,
      },
    ]);
  });

  // CL-6360: resending can never fix a missing or invalid model
  // credential, so the undelivered notice must say so instead of the
  // generic (and, for this cause, false) "send it again" line — for
  // every shape a credential/inference-resolution failure actually
  // takes: `InferenceResolutionError` (launch-time, no resolvable
  // source) and a runtime 401 `credential_failure`.
  describe("the undelivered notice is cause-aware", () => {
    async function noticeTextFor(
      dispatchFailure: unknown,
    ): Promise<TextPart | undefined> {
      const platform = fakePlatform();
      const deliverMail = platform.sendMail.bind(platform);
      platform.sendMail = async (input) => {
        if (input.workbenchId === "ins_echo1") throw dispatchFailure;
        return deliverMail(input);
      };
      const deps = buildDeps({ platform });
      const app = mountAs(createChatRoutes(deps), "prn_alice");
      const { body: workbench } = await createWorkbench(app, {
        kind: "workbench",
        participants: ["ins_echo1@acme.example"],
      });

      await app.request(`/workbenches/${workbench.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hi @ins_echo1" }],
        }),
      });
      await settleFanout();

      const timeline = await timelineOf(deps, workbench.id);
      const notice = timeline.find(
        (message) => message.sender.address === "ins_echo1@acme.example",
      );
      const part = notice?.parts[0];
      return part?.kind === "text" ? part : undefined;
    }

    test("InferenceResolutionError gets the model-unavailable copy, not 'send it again' or the raw dump", async () => {
      const part = await noticeTextFor(
        new InferenceResolutionError("test-launch", "no catalog source"),
      );
      expect(part?.text).toContain("model isn't available here");
      expect(part?.turnFailedReason).toBe("model_unavailable");
      expect(part?.text).not.toContain("send it again");
      expect(part?.text).not.toContain("add or check your model key");
      expect(part?.text).not.toContain("cannot resolve an inference source");
      expect(part?.text).not.toContain("no catalog source");
      expect(part?.text).not.toMatch(/HTTP/);
    });

    test("a 401 credential_failure gets the fix-your-key copy", async () => {
      const part = await noticeTextFor(
        Object.assign(new Error("unauthorized"), {
          status: 401,
          category: "credential_failure",
        }),
      );
      expect(part?.text).toContain("add or check your model key");
      expect(part?.text).not.toContain("send it again");
    });

    test("a genuinely transient failure keeps the retryable copy", async () => {
      const part = await noticeTextFor(new Error("sidecar unavailable"));
      expect(part?.text).toContain("send it again");
      expect(part?.text).not.toContain("model key");
    });

    // CL-6644: a dispatch failure that never surfaces a logged cause is
    // unfixable by anyone who cannot read the code — the notice must
    // carry a `reportError` refId a person can quote to support, and
    // that refId must be the one the caller actually logged.
    test("carries a reportError refId a person can quote to support", async () => {
      const part = await noticeTextFor(new Error("sidecar unavailable"));
      expect(part?.text).toMatch(/\(ref [^)]+\)$/);
    });
  });

  test("a message to a chat delivers to its agent without a mention", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.sentMail).toHaveLength(0); // the mint asks no agent for anything

    const parts: Part[] = [{ kind: "text", text: "hello, no mention here" }];
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      },
    );

    expect(response.status).toBe(201);
    await settleFanout();
    expect(platform.sentMail).toHaveLength(1); // one turn, asked of the chat's agent
    const dispatch = platform.sentMail[0];
    expect(dispatch?.workbenchId).toBe("ins_invited1");
    expect(dispatch?.fromWorkbenchId).toBe(workbench.id);
  });

  test("a message to a person-DM chat fans out to no one — the other party reads the workbench's own timeline", async () => {
    const deps = buildDeps();
    const tenancy = deps.tenancy as ReturnType<
      typeof createInMemoryWorkbenchTenancyStore
    >;
    tenancy.registerPrincipal(TENANT.id, {
      id: "prn_bob",
      kind: "user",
      status: "active",
      refId: "prn_bob",
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      principalId: "prn_bob",
    });

    const platform = deps.platform as ReturnType<typeof fakePlatform>;

    const parts: Part[] = [{ kind: "text", text: "hey Bob" }];
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      },
    );

    expect(response.status).toBe(201);
    await settleFanout();
    // Nobody to ask for a turn: the message is the whole event, and Bob
    // reads it off the chat's own timeline.
    expect(platform.sentMail).toHaveLength(0);
    expect(timelineTexts(await timelineOf(deps, workbench.id))).toContain(
      "hey Bob",
    );
  });

  test("a no-mention message in a workbench routes to its host — the first agent participant", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });

    const parts: Part[] = [{ kind: "text", text: "no mention at all" }];
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      },
    );

    expect(response.status).toBe(201);
    await settleFanout();
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.sentMail).toHaveLength(1); // one turn, asked of the host
    expect(platform.sentMail[0]?.workbenchId).toBe("ins_echo1");
  });

  test("a no-mention message in a multi-agent workbench delivers to the host only, not every agent", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [
          { id: "wfd_echo", name: "Echo" },
          { id: "wfd_second", name: "Second" },
        ],
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example", "ins_echo2@acme.example"],
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "no mention at all" }],
        }),
      },
    );

    expect(response.status).toBe(201);
    await settleFanout();
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    // One turn, asked of the host alone — never one per agent in the room.
    expect(platform.sentMail).toHaveLength(1);
    expect(platform.sentMail[0]?.workbenchId).toBe("ins_echo1");
  });

  test("a reply to an agent's message routes to that agent even unmentioned", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [
          { id: "wfd_echo", name: "Echo" },
          { id: "wfd_second", name: "Second" },
        ],
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example", "ins_echo2@acme.example"],
    });

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    // Simulates the orchestrator's own posted reply — under the agent's
    // run, no principal — landing on the workbench's timeline exactly as
    // `postReply` puts it there.
    const parent = await postRoomMessage(
      { roomMessages: deps.roomMessages, publish: () => undefined },
      {
        tenantId: TENANT.id,
        workbenchId: workbench.id,
        sender: { name: null, address: "ins_echo2@acme.example" },
        runId: "ins_echo2",
        parts: [{ kind: "text", text: "here's my answer" }],
      },
    );

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "thanks, no mention here" }],
          inReplyToMessageId: parent.id,
        }),
      },
    );

    expect(response.status).toBe(201);
    await settleFanout();
    expect(platform.sentMail.map((mail) => mail.workbenchId)).toEqual([
      "ins_echo2",
    ]);
  });

  test("a mention fan-out carries the prior workbench conversation, excluding the just-sent message", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });

    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "first message" }],
      }),
    });
    await nextTimelineMoment();
    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "second message" }],
      }),
    });
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hi @ins_echo1" }],
        }),
      },
    );
    expect(response.status).toBe(201);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    const decoded = decodeParts(copy?.content ?? { content: "" });

    // Exactly ONE text part: the context is merged into the message's
    // text, never sent as a part of its own — a second part makes the
    // copy multipart MIME, which the agent-side mail parser fails on.
    expect(decoded).toHaveLength(1);
    const [merged] = decoded;
    expect(merged?.kind).toBe("text");
    const mergedText = merged?.kind === "text" ? merged.text : "";
    expect(mergedText.split("\n")).toEqual([
      "[Workbench context — the most recent messages in this workbench, oldest " +
        "first. The actual message addressed to you follows after this " +
        "block.]",
      "user: first message",
      "user: second message",
      "",
      "hi @ins_echo1",
    ]);
  });

  test("no prior messages means no context part at all, copy identical to today", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hi @ins_echo1" }],
        }),
      },
    );
    expect(response.status).toBe(201);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    expect(copy?.content).toEqual({
      content: "hi @ins_echo1",
      replyTo: workbench.id,
    });
  });

  test("a default-route turn in room B does not include room A's rows", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: roomA } = await createWorkbench(app, {
      kind: "workbench",
      name: "room A",
      participants: ["ins_echo1@acme.example"],
    });
    const { body: roomB } = await createWorkbench(app, {
      kind: "workbench",
      name: "room B",
      participants: ["ins_echo1@acme.example"],
    });

    await app.request(`/workbenches/${roomA.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "room A secret: the launch is on Mars" }],
      }),
    });
    await settleFanout();
    await nextTimelineMoment();

    await app.request(`/workbenches/${roomB.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "room B note: we meet on Tuesday" }],
      }),
    });
    await settleFanout();
    await nextTimelineMoment();

    const response = await app.request(`/workbenches/${roomB.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "hello, no mention here" }],
      }),
    });
    expect(response.status).toBe(201);
    await settleFanout();

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const roomBMail = platform.sentMail.filter(
      (mail) => mail.fromWorkbenchId === roomB.id,
    );
    const copy = roomBMail[roomBMail.length - 1];
    const [contextPart] = decodeParts(copy?.content ?? { content: "" });
    const contextText = contextPart?.kind === "text" ? contextPart.text : "";

    expect(contextText).toContain("room B note: we meet on Tuesday");
    expect(contextText).toContain("hello, no mention here");
    expect(contextText).not.toContain("room A secret");
    expect(contextText).not.toContain("the launch is on Mars");
  });

  test("a chat's default-route fan-out carries this-room context", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "earlier turn" }] }),
    });
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hello, no mention here" }],
        }),
      },
    );
    expect(response.status).toBe(201);
    await settleFanout();

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const fanned = platform.sentMail[platform.sentMail.length - 1];
    const [contextPart] = decodeParts(fanned?.content ?? { content: "" });
    const contextText = contextPart?.kind === "text" ? contextPart.text : "";
    expect(contextText).toContain("earlier turn");
    expect(contextText).toContain("hello, no mention here");
  });

  test("a mention fan-out under the context window carries no dropped-history recap", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });
    await app.request(`/workbenches/${workbench.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": 5 }),
    });

    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "one" }] }),
    });
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hi @ins_echo1" }],
        }),
      },
    );
    expect(response.status).toBe(201);
    await settleFanout();

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    const [contextPart] = decodeParts(copy?.content ?? { content: "" });
    const contextText = contextPart?.kind === "text" ? contextPart.text : "";
    expect(contextText).not.toContain("Earlier in this conversation");
  });

  test("a mention fan-out beyond the context window prepends a recap of the dropped history", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });
    await app.request(`/workbenches/${workbench.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": 2 }),
    });

    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "the launch date is March 3rd" }],
      }),
    });
    await nextTimelineMoment();
    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "kept one" }] }),
    });
    await nextTimelineMoment();
    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "kept two" }] }),
    });
    await nextTimelineMoment();
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hi @ins_echo1" }],
        }),
      },
    );
    expect(response.status).toBe(201);
    await settleFanout();

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    const [contextPart] = decodeParts(copy?.content ?? { content: "" });
    const contextText = contextPart?.kind === "text" ? contextPart.text : "";

    expect(contextText).toContain("Earlier in this conversation");
    // 2, not 1: the workbench's own join event (from inviting ins_echo1 at
    // creation) is itself a dropped mail row, alongside "the launch
    // date" message — both fall outside the window of 2.
    expect(contextText).toContain("2 older messages");
    expect(contextText).toContain("the launch date is March 3rd");
    expect(contextText).toContain("user: kept one"); // still in-window
    expect(contextText).toContain("user: kept two"); // still in-window
    // The recap line itself precedes the still-in-window items.
    const lines = contextText.split("\n");
    const recapIndex = lines.findIndex((line) =>
      line.includes("Earlier in this conversation"),
    );
    const keptIndex = lines.findIndex((line) => line === "user: kept two");
    expect(recapIndex).toBeGreaterThan(-1);
    expect(recapIndex).toBeLessThan(keptIndex);
    expect(lines[recapIndex]).toMatch(/^system: /);
  });

  test("an agents-only dropped span still yields an honest count line, never a fabricated quote", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example", "ins_echo2@acme.example"],
    });
    await app.request(`/workbenches/${workbench.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": 1 }),
    });

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    // Simulates an agent's own posted reply landing on the timeline, the
    // way the orchestrator's `postReply` puts it there — no principal.
    await postRoomMessage(
      { roomMessages: deps.roomMessages, publish: () => undefined },
      {
        tenantId: TENANT.id,
        workbenchId: workbench.id,
        sender: { name: null, address: "ins_echo2@acme.example" },
        runId: "ins_echo2",
        parts: [
          { kind: "text", text: "agent-only reply, no facts a human said" },
        ],
      },
    );
    await nextTimelineMoment();
    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "kept" }] }),
    });
    await settleFanout();
    await nextTimelineMoment();
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hi @ins_echo1" }],
        }),
      },
    );
    expect(response.status).toBe(201);
    await settleFanout();

    const copy = platform.sentMail[platform.sentMail.length - 1];
    const [contextPart] = decodeParts(copy?.content ?? { content: "" });
    const contextText = contextPart?.kind === "text" ? contextPart.text : "";

    // 2, not 1: the workbench's own join event (from the two participants
    // at creation) is itself a dropped timeline row, alongside the
    // agent's reply — both fall outside the window of 1.
    expect(contextText).toContain("2 older messages");
    expect(contextText).not.toContain("agent-only reply");
    expect(contextText).toContain("no human messages");
  });

  test("a timeline load failure does not break the send; it fans out un-situated", async () => {
    const platform = fakePlatform();
    const roomMessages = createInMemoryRoomMessageStore();
    roomMessages.listMessages = () => {
      throw new Error("boom: the timeline is unavailable");
    };
    const deps = buildDeps({ platform, roomMessages });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hi @ins_echo1" }],
        }),
      },
    );

    expect(response.status).toBe(201);
    const copy = platform.sentMail[platform.sentMail.length - 1];
    expect(copy?.content).toEqual({
      content: "hi @ins_echo1",
      replyTo: workbench.id,
    });
  });

  test("inviting an agent joins it into the workbench and posts the join event", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(201);
    // Reply routing for the invited agent is the chat orchestrator's
    // concern now (see `chat-orchestrator.test.ts`), not a bridge this
    // route arms — this route only proves the join event was posted.
    const timeline = await timelineOf(deps, workbench.id);
    expect(timelineEvents(timeline, "workbench.agent-joined")).toHaveLength(1);
  });

  // CL-6120: a post-restart agent that exhausts the adapter's own
  // reclaim-settle-then-redeploy budget must not surface as an unhandled
  // 500 with a raw "agent is unreachable" stack trace. Since CL-6327 the
  // sender's message no longer travels through the agent at all, so an
  // unreachable agent cannot fail the send: the message stands, and the
  // room says plainly that the agent missed it.
  test("an agent that never becomes routable never fails the send; the timeline says so instead", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        sendMail() {
          throw new AgentUnreachableError("ins_echo1@acme.example");
        },
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });

    const parts: Part[] = [{ kind: "text", text: "hello?" }];
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      },
    );

    expect(response.status).toBe(201);
    await settleFanout();

    const timeline = await timelineOf(deps, workbench.id);
    expect(timelineTexts(timeline)).toContain("hello?");
    const notice = timeline.find(
      (message) => message.sender.address === "ins_echo1@acme.example",
    );
    expect(notice?.parts).toEqual([
      {
        kind: "text",
        text: expect.stringContaining("send it again"),
        turnFailed: true,
      },
    ]);
  });
});

describe("POST /workbenches/:id/invite", () => {
  test("launches the definition, appends the participant, and posts a join event", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      address: string;
      definitionId: string;
    };
    expect(body).toEqual({
      address: "ins_invited1@acme.example",
      definitionId: "wfd_echo",
    });

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.launchInviteCalls).toEqual([
      {
        tenantId: TENANT.id,
        creatorPrincipalId: "prn_alice",
        definitionId: "wfd_echo",
      },
    ]);

    const settingsRow = await deps.store.getWorkbenchSettings(
      TENANT.id,
      workbench.id,
    );
    // The handle is derived from the definition's own name ("Echo" ->
    // "echo") — never the run's own address local part, which is what
    // it fell back to before CL-6471's fix.
    expect(settingsRow?.settings["chat/participants"]).toEqual([
      { address: "ins_invited1@acme.example", handle: "echo" },
    ]);

    // Joining is a fact about the room, so it is posted onto the room's
    // own timeline — never mailed to anyone.
    expect(platform.sentMail).toHaveLength(0);
    const timeline = await timelineOf(deps, workbench.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.workbenchId).toBe(workbench.id);
    expect(timelineEvents(timeline, "workbench.agent-joined")).toEqual([
      {
        kind: "event",
        event: "workbench.agent-joined",
        data: expect.objectContaining({
          address: "ins_invited1@acme.example",
        }),
      },
    ]);
  });

  // One room participant = one standing principal (CL-6978): an
  // explicit re-invite of a definition this room already holds returns
  // the resident handle rather than minting a sibling or appending a
  // second participant row. `addParticipant` de-dupes the same address.
  test("an explicit re-invite of the same definition does not mint a second instance", async () => {
    let launches = 0;
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "echo" }],
      resolveDefinitionIdByAddress: async (address) =>
        address === "ins_invited1@acme.example" ? "wfd_echo" : undefined,
      launchInvite: async () => {
        launches += 1;
        return {
          instanceId: `ins_invited${launches}`,
          address: `ins_invited${launches}@acme.example`,
        };
      },
    });
    const deps = buildDeps({ platform });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const invite = () =>
      app.request(`/workbenches/${workbench.id}/invite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definitionId: "wfd_echo" }),
      });
    expect((await invite()).status).toBe(201);
    expect((await invite()).status).toBe(201);

    expect(platform.launchInviteCalls).toHaveLength(1);
    const settingsRow = await deps.store.getWorkbenchSettings(
      TENANT.id,
      workbench.id,
    );
    expect(settingsRow?.settings["chat/participants"]).toEqual([
      { address: "ins_invited1@acme.example", handle: "echo" },
    ]);
  });

  test("inviting the same definition into a second workbench reuses the standing address", async () => {
    const standing = {
      instanceId: "ins_sales",
      address: "ins_sales@acme.example",
    };
    const platform = fakePlatform({
      invitable: [{ id: "wfd_sales", name: "Sales" }],
      launchInvite: async () => standing,
    });
    const deps = buildDeps({ platform });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: first } = await createWorkbench(app, { kind: "workbench" });
    const { body: second } = await createWorkbench(app, { kind: "workbench" });

    const invite = (workbenchId: string) =>
      app.request(`/workbenches/${workbenchId}/invite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ definitionId: "wfd_sales" }),
      });
    expect((await invite(first.id)).status).toBe(201);
    expect((await invite(second.id)).status).toBe(201);

    expect(platform.launchInviteCalls).toHaveLength(2);
    const firstSettings = await deps.store.getWorkbenchSettings(
      TENANT.id,
      first.id,
    );
    const secondSettings = await deps.store.getWorkbenchSettings(
      TENANT.id,
      second.id,
    );
    expect(firstSettings?.settings["chat/participants"]).toEqual([
      { address: "ins_sales@acme.example", handle: "sales" },
    ]);
    expect(secondSettings?.settings["chat/participants"]).toEqual([
      { address: "ins_sales@acme.example", handle: "sales" },
    ]);
  });

  test("appends onto an existing participant list rather than replacing it", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["existing@acme.example"],
    });

    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    const settingsRow = await deps.store.getWorkbenchSettings(
      TENANT.id,
      workbench.id,
    );
    expect(settingsRow?.settings["chat/participants"]).toEqual([
      { address: "existing@acme.example", handle: "existing" },
      { address: "ins_invited1@acme.example", handle: "echo" },
    ]);
  });

  test("derives the mention handle from the invited definition's name, de-duplicating within the workbench", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "Echo" }],
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["echo@acme.example"],
    });

    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    const settingsRow = await deps.store.getWorkbenchSettings(
      TENANT.id,
      workbench.id,
    );
    expect(settingsRow?.settings["chat/participants"]).toEqual([
      { address: "echo@acme.example", handle: "echo" },
      { address: "ins_invited1@acme.example", handle: "echo-2" },
    ]);
  });

  test("derives the mention handle from the invited definition's display name (description) over its asset name", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [
          { id: "wfd_assistant", name: "assistant", description: "Myra" },
        ],
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_assistant" }),
    });

    const settingsRow = await deps.store.getWorkbenchSettings(
      TENANT.id,
      workbench.id,
    );
    expect(settingsRow?.settings["chat/participants"]).toEqual([
      { address: "ins_invited1@acme.example", handle: "myra" },
    ]);
  });

  // CL-6471: a freshly created/redeployed definition can miss the
  // `invitable` snapshot the caller pre-fetched (the exact "fresh stack,
  // instantiate a template" race the owner hit) — this must resolve the
  // real name live rather than degrading to the run's own address.
  test("a definition missing from the invitable snapshot still resolves its real name via a live lookup (CL-6471)", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [], // the stale/pre-fetched snapshot misses it
        resolveDefinitionNameSource: async (definitionId) =>
          definitionId === "wfd_reviewer"
            ? {
                name: "architecture-reviewer",
                description: "Architecture reviewer",
              }
            : undefined,
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_reviewer" }),
    });

    expect(response.status).toBe(201);
    const settingsRow = await deps.store.getWorkbenchSettings(
      TENANT.id,
      workbench.id,
    );
    // Never "ins_invited1" (the raw address local part) and never
    // "run_..."/"ins_..." in any form — the real, humanized name.
    expect(settingsRow?.settings["chat/participants"]).toEqual([
      { address: "ins_invited1@acme.example", handle: "architecture-reviewer" },
    ]);
  });

  test("a definition unresolvable anywhere fails loud rather than leaking the run's own address as its name (CL-6471)", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [] }), // no live lookup will find it either
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_ghost" }),
    });

    // Never a 201 with a participant record carrying a leaked id.
    expect(response.status).not.toBe(201);
    const settingsRow = await deps.store.getWorkbenchSettings(
      TENANT.id,
      workbench.id,
    );
    expect(settingsRow?.settings["chat/participants"]).toEqual([]);
  });

  test("a malformed body is rejected with the structured error envelope", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("a missing workbench is a 404", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/workbenches/ins_missing/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(404);
  });

  test("a denied grant is rejected before any launch is attempted", async () => {
    const platform = fakePlatform();
    const deps = buildDeps({
      platform,
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/workbenches/ins_x/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(403);
    expect(
      (platform as ReturnType<typeof fakePlatform>).launchInviteCalls,
    ).toHaveLength(0);
  });

  test("re-inviting the same definition into a chat reuses the resident — no extra launch", async () => {
    let launches = 0;
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "Echo" }],
      resolveDefinitionIdByAddress: async (address) =>
        address === "ins_invited1@acme.example" ? "wfd_echo" : undefined,
      launchInvite: async () => {
        launches += 1;
        return {
          instanceId: `ins_invited${launches}`,
          address: `ins_invited${launches}@acme.example`,
        };
      },
    });
    const deps = buildDeps({ platform });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    const response = await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { address: string };
    expect(body.address).toBe("ins_invited1@acme.example");
    expect(platform.launchInviteCalls).toHaveLength(1);
  });

  test("inviting a different agent into a chat is a 409 kind_is_chat", async () => {
    const platform = fakePlatform({
      invitable: [
        { id: "wfd_echo", name: "Echo" },
        { id: "wfd_copywriter", name: "Copywriter" },
      ],
    });
    const deps = buildDeps({ platform });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });
    expect(platform.launchInviteCalls).toHaveLength(1);

    const response = await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_copywriter" }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("kind_is_chat");
    expect(platform.launchInviteCalls).toHaveLength(1);
  });
});

describe("launchAndJoinAgent 1:1 chats", () => {
  const invitable = [
    { id: "wfd_echo", name: "Echo" },
    { id: "wfd_copywriter", name: "Copywriter" },
  ];

  test("throws KindIsChatError when a chat already has a different agent", async () => {
    const platform = fakePlatform({ invitable });
    await expect(
      launchAndJoinAgent(
        {
          store: createInMemoryChatStore(),
          platform,
          roomMessages: createInMemoryRoomMessageStore(),
          publish: () => undefined,
        },
        {
          tenantId: TENANT.id,
          principalId: "prn_alice",
          workbenchId: "chan_1",
          definitionId: "wfd_copywriter",
          existingSettings: {
            "chat/kind": "chat",
            "chat/definitionId": "wfd_echo",
            "chat/participants": [
              { address: "ins_echo@acme.example", handle: "echo" },
            ],
          },
          invitable,
        },
      ),
    ).rejects.toBeInstanceOf(KindIsChatError);
    expect(platform.launchInviteCalls).toHaveLength(0);
  });

  test("returns the resident when the chat already holds this definition", async () => {
    const platform = fakePlatform({
      invitable,
      resolveDefinitionIdByAddress: async (address) =>
        address === "ins_echo@acme.example" ? "wfd_echo" : undefined,
    });
    const joined = await launchAndJoinAgent(
      {
        store: createInMemoryChatStore(),
        platform,
        roomMessages: createInMemoryRoomMessageStore(),
        publish: () => undefined,
      },
      {
        tenantId: TENANT.id,
        principalId: "prn_alice",
        workbenchId: "chan_1",
        definitionId: "wfd_echo",
        existingSettings: {
          "chat/kind": "chat",
          "chat/definitionId": "wfd_echo",
          "chat/participants": [
            { address: "ins_echo@acme.example", handle: "echo" },
          ],
        },
        invitable,
      },
    );
    expect(joined.address).toBe("ins_echo@acme.example");
    expect(platform.launchInviteCalls).toHaveLength(0);
  });
});

describe("joinHumanParticipant / removeWorkbenchParticipant (CL-7194)", () => {
  const tenancy = { addWorkbenchMember: async () => undefined };

  test("joinHumanParticipant adds the member without a caller-supplied settings snapshot", async () => {
    const store = createInMemoryChatStore();
    await store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: "chan_1",
      settings: { "chat/kind": "workbench" },
      updatedBy: "prn_alice",
    });

    const result = await joinHumanParticipant(
      {
        store,
        roomMessages: createInMemoryRoomMessageStore(),
        publish: () => undefined,
        tenancy,
      },
      {
        tenantId: TENANT.id,
        principalId: "prn_alice",
        workbenchId: "chan_1",
        memberPrincipalId: "prn_bob",
        memberRefId: "prn_bob",
        memberHandle: "bob",
      },
    );

    expect(result.address).toBe("prn_bob");
    expect(result.settings["chat/participants"]).toEqual([
      { address: "prn_bob", handle: "bob" },
    ]);
  });

  // The in-memory store's mutateWorkbenchParticipants body has no
  // await between its read and write, so two Promise.all'd calls
  // against it can never actually interleave — this proves
  // joinHumanParticipant was correctly rewired onto the mutate-closure
  // call site (both invites land, no stale-snapshot rebuild), not that
  // the fix holds under real concurrency. That's what
  // settings-participants.drizzle.test.ts's real-Postgres tests prove.
  test("two invites issued together both land, rewired through the mutate closure", async () => {
    const store = createInMemoryChatStore();
    await store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: "chan_1",
      settings: { "chat/kind": "workbench" },
      updatedBy: "prn_alice",
    });
    const deps = {
      store,
      roomMessages: createInMemoryRoomMessageStore(),
      publish: () => undefined,
      tenancy,
    };

    await Promise.all([
      joinHumanParticipant(deps, {
        tenantId: TENANT.id,
        principalId: "prn_alice",
        workbenchId: "chan_1",
        memberPrincipalId: "prn_bob",
        memberRefId: "prn_bob",
        memberHandle: "bob",
      }),
      joinHumanParticipant(deps, {
        tenantId: TENANT.id,
        principalId: "prn_alice",
        workbenchId: "chan_1",
        memberPrincipalId: "prn_carol",
        memberRefId: "prn_carol",
        memberHandle: "carol",
      }),
    ]);

    const row = await store.getWorkbenchSettings(TENANT.id, "chan_1");
    const addresses = (
      row?.settings["chat/participants"] as { address: string }[]
    )
      .map((participant) => participant.address)
      .sort();
    expect(addresses).toEqual(["prn_bob", "prn_carol"]);
  });

  test("removeWorkbenchParticipant drops exactly the named participant", async () => {
    const store = createInMemoryChatStore();
    await store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: "chan_1",
      settings: {
        "chat/kind": "workbench",
        "chat/participants": [
          { address: "prn_bob", handle: "bob" },
          { address: "prn_carol", handle: "carol" },
        ],
      },
      updatedBy: "prn_alice",
    });

    const result = await removeWorkbenchParticipant(
      {
        store,
        roomMessages: createInMemoryRoomMessageStore(),
        publish: () => undefined,
      },
      {
        tenantId: TENANT.id,
        principalId: "prn_alice",
        workbenchId: "chan_1",
        participant: { address: "prn_bob", handle: "bob" },
      },
    );

    expect(result.settings["chat/participants"]).toEqual([
      { address: "prn_carol", handle: "carol" },
    ]);
  });
});

describe("one in-flight turn per workbench (CL-6331)", () => {
  test("three rapid messages to a room with two agents produce ordered, non-overlapping turns", async () => {
    // A controllable dispatcher: `sendMail` for the first agent
    // (`ins_a1`) is held open, once, until this test releases it — so
    // the test can prove a message arriving mid-turn queues rather than
    // dispatching, deterministically rather than racing the fake.
    let releaseFirstDispatch!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirstDispatch = resolve;
    });
    let resolveFirstDispatchStarted!: () => void;
    const firstDispatchStarted = new Promise<void>((resolve) => {
      resolveFirstDispatchStarted = resolve;
    });
    let holdConsumed = false;

    const testPlatform = fakePlatform();
    const deliverMail = testPlatform.sendMail.bind(testPlatform);
    testPlatform.sendMail = async (input) => {
      if (input.workbenchId === "ins_a1" && !holdConsumed) {
        holdConsumed = true;
        resolveFirstDispatchStarted();
        await held;
      }
      return deliverMail(input);
    };

    const registry = createWorkbenchSubscriberRegistry();
    const deps = buildDeps({
      platform: testPlatform,
      workbenchSubscribers: registry,
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "review",
      participants: ["ins_a1@acme.example", "ins_b1@acme.example"],
    });

    const queuedEvents: ChatWorkbenchEvent[] = [];
    registry.subscribe(workbench.id, (event) => {
      if (event.type === "chat.turn-queued") queuedEvents.push(event);
    });

    const send = (text: string) =>
      app.request(`/workbenches/${workbench.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ kind: "text", text }] }),
      });

    // Message 1 mentions @ins_a1 — it wins the workbench's turn claim
    // and its dispatch is held open by the fake above.
    const first = await send("hi @ins_a1, please review this");
    expect(first.status).toBe(201);
    await firstDispatchStarted;

    // Messages 2 and 3 arrive while the first turn is still in flight —
    // both must queue rather than dispatch, and the room must be told.
    const second = await send("hi @ins_b1, you too");
    expect(second.status).toBe(201);
    const third = await send("one more thing for the group");
    expect(third.status).toBe(201);

    // The first turn's dispatch is still held open — nothing has
    // actually been recorded as sent yet, only started.
    expect(testPlatform.sentMail).toHaveLength(0);
    expect(queuedEvents).toHaveLength(2);
    expect(
      queuedEvents.map(
        (event) => (event.data as { queueLength: number }).queueLength,
      ),
    ).toEqual([1, 2]);

    releaseFirstDispatch();
    await settleFanout();

    // The batched next turn reaches both agents — @ins_b1 from message
    // 2, and @ins_a1 again from message 3's default-routing-to-host —
    // deduplicated to one dispatch per agent, never two overlapping
    // turns.
    expect(testPlatform.sentMail).toHaveLength(3);
    const secondTurnRecipients = testPlatform.sentMail
      .slice(1)
      .map((mail) => mail.workbenchId)
      .sort();
    expect(secondTurnRecipients).toEqual(["ins_a1", "ins_b1"]);

    // Both queued messages' text reached the batched turn, ordered:
    // message 2's part decodes before message 3's.
    for (const mail of testPlatform.sentMail.slice(1)) {
      const attachments = (
        mail.content as {
          attachments: readonly { data: string }[];
        }
      ).attachments;
      const decoded = attachments
        .map((attachment) =>
          Buffer.from(attachment.data, "base64").toString("utf8"),
        )
        .join("\n");
      expect(decoded).toContain("you too");
      expect(decoded).toContain("one more thing");
      expect(
        decoded.indexOf("you too") < decoded.indexOf("one more thing"),
      ).toBe(true);
    }
  });
});
