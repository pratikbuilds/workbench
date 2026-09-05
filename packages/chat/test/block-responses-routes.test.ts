// HTTP surface for the poll/form response round-trip: membership gating,
// upsert-as-change-vote, poll aggregation, form privacy (never another
// principal's raw submission), the `messageId`+`blockId` anti-hijack scope,
// cross-tenant isolation, and the `block.response` event appended to the
// workbench's own timeline.
import { describe, expect, test } from "bun:test";

import { createChatRoutes } from "../src/routes";
import { createInMemoryBlockResponseStore } from "../src/block-responses";
import { createInMemoryChatStore } from "../src/store";
import type { ChatStore } from "../src/store";
import { createInMemoryRoomMessageStore } from "../src/room-messages";
import type { RoomMessageStore } from "../src/room-messages";
import {
  buildDeps,
  createWorkbench,
  fakePlatform,
  mountAs,
  TENANT,
  timelineEvents,
  timelineOf,
  timelineTexts,
} from "./test-support";

/** A `RoomMessageStore` whose next attempt to post a text-bearing message
 * (the answer, never the `block.response` event) throws once, then
 * delegates normally — used to simulate a notify failure a retry
 * recovers from. */
function roomMessagesFailingNextAnswer(
  base: RoomMessageStore,
): RoomMessageStore {
  let shouldFail = true;
  return {
    ...base,
    async insertMessage(input) {
      const isAnswerText = input.parts.some((part) => part.kind === "text");
      if (isAnswerText && shouldFail) {
        shouldFail = false;
        throw new Error("simulated notify failure");
      }
      return base.insertMessage(input);
    },
  };
}

function responsesUrl(workbenchId: string, messageId: string, blockId: string) {
  return `/workbenches/${workbenchId}/messages/${messageId}/blocks/${blockId}/responses`;
}

async function vote(
  app: ReturnType<typeof mountAs>,
  workbenchId: string,
  messageId: string,
  blockId: string,
  choiceIds: string[],
) {
  return app.request(responsesUrl(workbenchId, messageId, blockId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "poll", choiceIds }),
  });
}

async function submitForm(
  app: ReturnType<typeof mountAs>,
  workbenchId: string,
  messageId: string,
  blockId: string,
  values: Record<string, string>,
) {
  return app.request(responsesUrl(workbenchId, messageId, blockId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "form", values }),
  });
}

async function getResponses(
  app: ReturnType<typeof mountAs>,
  workbenchId: string,
  messageId: string,
  blockId: string,
) {
  return app.request(responsesUrl(workbenchId, messageId, blockId));
}

async function newWorkbench(store: ChatStore) {
  const workbenchId = "run_workbench1";
  await store.createWorkbenchSettings({
    tenantId: TENANT.id,
    workbenchId,
    settings: { "chat/kind": "workbench" },
    updatedBy: "prn_alice",
  });
  return workbenchId;
}

describe("block response routes — gating", () => {
  test("no blockResponses store injected: POST and GET both 404, never silently no-op", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = await newWorkbench(deps.store);

    const post = await vote(app, workbenchId, "m1", "blk_poll1", ["a"]);
    expect(post.status).toBe(404);

    const get = await getResponses(app, workbenchId, "m1", "blk_poll1");
    expect(get.status).toBe(404);
  });

  test("a denied grant is rejected before any response is stored", async () => {
    const store = createInMemoryBlockResponseStore();
    const deps = buildDeps({
      blockResponses: store,
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = await newWorkbench(deps.store);

    const post = await vote(app, workbenchId, "m1", "blk_poll1", ["a"]);
    expect(post.status).toBe(403);

    const rows = await store.listBlockResponses(
      TENANT.id,
      workbenchId,
      "m1",
      "blk_poll1",
    );
    expect(rows).toHaveLength(0);
  });

  test("an unknown workbench id 404s rather than accepting a response into nowhere", async () => {
    const deps = buildDeps({
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const post = await vote(app, "run_ghost", "m1", "blk_poll1", ["a"]);
    expect(post.status).toBe(404);
  });

  test("a workbench that belongs to a different tenant is invisible: 404, not leaked cross-tenant", async () => {
    const store = createInMemoryBlockResponseStore();
    const deps = buildDeps({ blockResponses: store });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body } = await createWorkbench(app, {
      kind: "workbench",
      name: "General",
    });

    const otherTenantStore = createInMemoryChatStore();
    const otherDeps = buildDeps({
      store: otherTenantStore,
      blockResponses: store,
    });
    const otherApp = mountAs(createChatRoutes(otherDeps), "prn_mallory");

    const post = await vote(otherApp, body.id, "m1", "blk_poll1", ["a"]);
    expect(post.status).toBe(404);
    const get = await getResponses(otherApp, body.id, "m1", "blk_poll1");
    expect(get.status).toBe(404);
  });
});

describe("block response routes — poll aggregation and change-vote", () => {
  test("a vote is tallied and reported as this principal's own response", async () => {
    const deps = buildDeps({
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = await newWorkbench(deps.store);

    const post = await vote(app, workbenchId, "m1", "blk_poll1", ["tue"]);
    expect(post.status).toBe(200);

    const get = await getResponses(app, workbenchId, "m1", "blk_poll1");
    const body = (await get.json()) as {
      tally: Record<string, number>;
      total: number;
      own: unknown;
    };
    expect(body.tally).toEqual({ tue: 1 });
    expect(body.total).toBe(1);
    expect(body.own).toEqual({ kind: "poll", choiceIds: ["tue"] });
  });

  test("a second vote from the same principal changes it — upsert, not a second respondent", async () => {
    const deps = buildDeps({
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = await newWorkbench(deps.store);

    await vote(app, workbenchId, "m1", "blk_poll1", ["tue"]);
    await vote(app, workbenchId, "m1", "blk_poll1", ["thu"]);

    const get = await getResponses(app, workbenchId, "m1", "blk_poll1");
    const body = (await get.json()) as {
      tally: Record<string, number>;
      total: number;
    };
    expect(body.tally).toEqual({ thu: 1 });
    expect(body.total).toBe(1);
  });

  test("multiple principals' votes tally correctly, and each only ever sees its own `own`", async () => {
    const store = createInMemoryBlockResponseStore();
    const deps = buildDeps({ blockResponses: store });
    const appAlice = mountAs(createChatRoutes(deps), "prn_alice");
    const appBob = mountAs(createChatRoutes(deps), "prn_bob");
    const workbenchId = await newWorkbench(deps.store);

    await vote(appAlice, workbenchId, "m1", "blk_poll1", ["tue"]);
    await vote(appBob, workbenchId, "m1", "blk_poll1", ["tue"]);

    const asAlice = (await (
      await getResponses(appAlice, workbenchId, "m1", "blk_poll1")
    ).json()) as { tally: Record<string, number>; total: number; own: unknown };
    expect(asAlice.tally).toEqual({ tue: 2 });
    expect(asAlice.total).toBe(2);
    expect(asAlice.own).toEqual({ kind: "poll", choiceIds: ["tue"] });
  });

  test("an empty choiceIds array is rejected", async () => {
    const deps = buildDeps({
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = await newWorkbench(deps.store);

    const post = await vote(app, workbenchId, "m1", "blk_poll1", []);
    expect(post.status).toBe(400);
  });
});

describe("block response routes — form privacy", () => {
  test("a form submission is never returned to a different principal, only tallied nowhere", async () => {
    const store = createInMemoryBlockResponseStore();
    const deps = buildDeps({ blockResponses: store });
    const appAlice = mountAs(createChatRoutes(deps), "prn_alice");
    const appBob = mountAs(createChatRoutes(deps), "prn_bob");
    const workbenchId = await newWorkbench(deps.store);

    await submitForm(appAlice, workbenchId, "m1", "blk_form1", {
      feedback: "Alice's private notes",
    });

    const asBob = (await (
      await getResponses(appBob, workbenchId, "m1", "blk_form1")
    ).json()) as { own: unknown; tally: Record<string, number> };
    expect(asBob.own).toBeNull();
    expect(asBob.tally).toEqual({});

    const asAlice = (await (
      await getResponses(appAlice, workbenchId, "m1", "blk_form1")
    ).json()) as { own: unknown };
    expect(asAlice.own).toEqual({
      kind: "form",
      values: { feedback: "Alice's private notes" },
    });
  });
});

describe("block response routes — anti-hijack scope", () => {
  test("the same agent-authored blockId in two different messages never collides", async () => {
    const deps = buildDeps({
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = await newWorkbench(deps.store);

    await vote(app, workbenchId, "m1", "blk_shared", ["a"]);
    await vote(app, workbenchId, "m2", "blk_shared", ["b"]);

    const m1 = (await (
      await getResponses(app, workbenchId, "m1", "blk_shared")
    ).json()) as { tally: Record<string, number> };
    const m2 = (await (
      await getResponses(app, workbenchId, "m2", "blk_shared")
    ).json()) as { tally: Record<string, number> };
    expect(m1.tally).toEqual({ a: 1 });
    expect(m2.tally).toEqual({ b: 1 });
  });
});

describe("block response routes — question answers", () => {
  test("answering a question posts the answer into the workbench as the responder's own message", async () => {
    const platform = fakePlatform();
    const deps = buildDeps({
      platform,
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = await newWorkbench(deps.store);

    const post = await app.request(
      responsesUrl(workbenchId, "m1", "blk_question1"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "question",
          answer: "Production",
          optionIndex: 1,
        }),
      },
    );
    expect(post.status).toBe(200);

    // Two messages land on the timeline: the answer-as-message, and the
    // block.response event -- both authored by the responding principal,
    // and neither mailed anywhere.
    const timeline = await timelineOf(deps, workbenchId);
    expect(timeline).toHaveLength(2);
    expect(
      timeline.every((message) => message.senderPrincipalId === "prn_alice"),
    ).toBe(true);
    expect(timelineTexts(timeline)).toEqual(["Production"]);
    expect(timelineEvents(timeline, "block.response")).toHaveLength(1);
    expect(platform.sentMail).toHaveLength(0);

    const get = await getResponses(app, workbenchId, "m1", "blk_question1");
    const body = (await get.json()) as { own: unknown };
    expect(body.own).toMatchObject({
      kind: "question",
      answer: "Production",
      optionIndex: 1,
    });
    expect((body.own as { notifiedAt: unknown }).notifiedAt).toEqual(
      expect.any(String),
    );
  });

  test("changing an answer updates the stored response but never dispatches a second turn", async () => {
    const platform = fakePlatform();
    const deps = buildDeps({
      platform,
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = await newWorkbench(deps.store);

    const first = await app.request(
      responsesUrl(workbenchId, "m1", "blk_question1"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "question", answer: "Staging" }),
      },
    );
    expect(first.status).toBe(200);

    const second = await app.request(
      responsesUrl(workbenchId, "m1", "blk_question1"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "question", answer: "Production" }),
      },
    );
    expect(second.status).toBe(200);

    // Only the first answer ever became a message the agent was asked to
    // turn on -- the second lands in the stored row (and its own
    // `block.response` event) but never re-sends or re-dispatches.
    const timeline = await timelineOf(deps, workbenchId);
    expect(timelineTexts(timeline)).toEqual(["Staging"]);
    expect(timelineEvents(timeline, "block.response")).toHaveLength(2);

    const get = await getResponses(app, workbenchId, "m1", "blk_question1");
    const body = (await get.json()) as { own: unknown };
    expect(body.own).toMatchObject({
      kind: "question",
      answer: "Production",
    });
    expect((body.own as { notifiedAt: unknown }).notifiedAt).toEqual(
      expect.any(String),
    );
  });

  test("a double-click resubmitting the identical answer never dispatches a second turn", async () => {
    const platform = fakePlatform();
    const deps = buildDeps({
      platform,
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = await newWorkbench(deps.store);

    const submit = () =>
      app.request(responsesUrl(workbenchId, "m1", "blk_question1"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "question", answer: "Production" }),
      });

    const [first, second] = await Promise.all([submit(), submit()]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const timeline = await timelineOf(deps, workbenchId);
    expect(timelineTexts(timeline)).toEqual(["Production"]);
  });

  test("a failed notification releases the claim so a retried answer still reaches the agent", async () => {
    const platform = fakePlatform();
    const roomMessages = roomMessagesFailingNextAnswer(
      createInMemoryRoomMessageStore(),
    );
    const deps = buildDeps({
      platform,
      roomMessages,
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = await newWorkbench(deps.store);

    const submit = () =>
      app.request(responsesUrl(workbenchId, "m1", "blk_question1"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "question", answer: "Production" }),
      });

    const failed = await submit();
    expect(failed.status).toBe(500);
    const failedBody = (await failed.json()) as {
      error: { code: string; userMessage: string };
    };
    expect(failedBody.error.code).toBe("notify_failed");
    expect(failedBody.error.userMessage).toMatch(/ref /);

    // The answer itself was already durable even though the notify failed.
    const afterFailure = await getResponses(
      app,
      workbenchId,
      "m1",
      "blk_question1",
    );
    const afterFailureBody = (await afterFailure.json()) as { own: unknown };
    expect(afterFailureBody.own).toEqual({
      kind: "question",
      answer: "Production",
      notifiedAt: null,
    });
    expect(timelineTexts(await timelineOf(deps, workbenchId))).toEqual([]);

    const retried = await submit();
    expect(retried.status).toBe(200);

    const timeline = await timelineOf(deps, workbenchId);
    expect(timelineTexts(timeline)).toEqual(["Production"]);
    expect(timelineEvents(timeline, "block.response")).toHaveLength(2);
  });

  test("a question response without answer text is rejected", async () => {
    const deps = buildDeps({
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = await newWorkbench(deps.store);

    const post = await app.request(
      responsesUrl(workbenchId, "m1", "blk_question1"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "question", answer: "" }),
      },
    );
    expect(post.status).toBe(400);
  });
});

describe("block response routes — block.response event", () => {
  test("a response appends a machine-readable event onto the workbench's own timeline", async () => {
    const platform = fakePlatform();
    const deps = buildDeps({
      platform,
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = await newWorkbench(deps.store);

    await vote(app, workbenchId, "m1", "blk_poll1", ["tue"]);

    expect(platform.sentMail).toHaveLength(0);
    const timeline = await timelineOf(deps, workbenchId);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.senderPrincipalId).toBe("prn_alice");
    const [event] = timelineEvents(timeline, "block.response");
    expect(event?.data).toMatchObject({
      messageId: "m1",
      blockId: "blk_poll1",
      kind: "poll",
      choiceIds: ["tue"],
    });
  });
});
