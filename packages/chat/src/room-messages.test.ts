import { describe, expect, test } from "bun:test";

import { CONSUMER_INFERENCE_FAILURE_NOTICE } from "./consumer-inference-text";
import {
  createInMemoryRoomMessageStore,
  postRoomMessage,
  previewOf,
} from "./room-messages";

const TENANT = "tnt_1";
const WORKBENCH = "run_room";

function recordingPublisher() {
  const published: { workbenchId: string; type: string; data: unknown }[] = [];
  return {
    published,
    publish: (workbenchId: string, event: { type: string; data: unknown }) => {
      published.push({ workbenchId, type: event.type, data: event.data });
    },
  };
}

describe("postRoomMessage", () => {
  test("persists the message and publishes it onto the workbench's stream", async () => {
    const roomMessages = createInMemoryRoomMessageStore();
    const publisher = recordingPublisher();

    const posted = await postRoomMessage(
      { roomMessages, publish: publisher.publish },
      {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        sender: { name: null, address: "prn_ada@acme.example" },
        senderPrincipalId: "prn_ada",
        parts: [{ kind: "text", text: "morning" }],
      },
    );

    const listed = await roomMessages.listMessages({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
    });
    expect(listed.items.map((message) => message.id)).toEqual([posted.id]);
    // The full rendered row — sender and parts included — so a
    // subscriber can render this message with no follow-up GET.
    expect(publisher.published).toEqual([
      {
        workbenchId: WORKBENCH,
        type: "chat.message",
        data: {
          id: posted.id,
          workbenchId: WORKBENCH,
          createdAt: posted.createdAt,
          threadId: null,
          sender: { name: null, address: "prn_ada@acme.example" },
          parts: [{ kind: "text", text: "morning" }],
        },
      },
    ]);
  });

  test("persists a consumer sentence, not HTTP status or a raw provider dump", async () => {
    const roomMessages = createInMemoryRoomMessageStore();
    const publisher = recordingPublisher();

    const posted = await postRoomMessage(
      { roomMessages, publish: publisher.publish },
      {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        sender: { name: null, address: "run_myra@acme.example" },
        runId: "run_myra",
        parts: [
          {
            kind: "text",
            text: "This agent could not complete your request due to a credential error [HTTP 401]: API key is invalid.",
          },
        ],
      },
    );

    expect(posted.parts).toEqual([
      {
        kind: "text",
        text: CONSUMER_INFERENCE_FAILURE_NOTICE,
      },
    ]);
    const listed = await roomMessages.listMessages({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
    });
    expect(listed.items[0]?.parts).toEqual(posted.parts);
    expect(JSON.stringify(publisher.published)).not.toMatch(/\[HTTP/);
    expect(JSON.stringify(publisher.published)).not.toContain(
      "API key is invalid",
    );
  });

  test("an agent's message carries its run, a human's carries its principal", async () => {
    const roomMessages = createInMemoryRoomMessageStore();
    const publisher = recordingPublisher();
    const post = (input: Parameters<typeof postRoomMessage>[1]) =>
      postRoomMessage({ roomMessages, publish: publisher.publish }, input);

    const human = await post({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      sender: { name: null, address: "prn_ada@acme.example" },
      senderPrincipalId: "prn_ada",
      parts: [{ kind: "text", text: "who's there?" }],
    });
    const agent = await post({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      sender: { name: null, address: "run_myra@acme.example" },
      runId: "run_myra",
      parts: [{ kind: "text", text: "me" }],
    });

    expect(human.senderPrincipalId).toBe("prn_ada");
    expect(human.runId).toBeNull();
    expect(agent.runId).toBe("run_myra");
    expect(agent.senderPrincipalId).toBeNull();
  });

  test("one workbench's timeline never leaks into another's", async () => {
    const roomMessages = createInMemoryRoomMessageStore();
    const publisher = recordingPublisher();
    await postRoomMessage(
      { roomMessages, publish: publisher.publish },
      {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        sender: { name: null, address: "prn_ada@acme.example" },
        parts: [{ kind: "text", text: "ours" }],
      },
    );

    const other = await roomMessages.listMessages({
      tenantId: TENANT,
      workbenchId: "run_elsewhere",
    });
    expect(other.items).toEqual([]);
  });
});

describe("listMessages", () => {
  test("reads newest first and pages back through the cursor", async () => {
    const roomMessages = createInMemoryRoomMessageStore();
    const publisher = recordingPublisher();
    const ids: string[] = [];
    for (let index = 0; index < 55; index += 1) {
      const posted = await postRoomMessage(
        { roomMessages, publish: publisher.publish },
        {
          tenantId: TENANT,
          workbenchId: WORKBENCH,
          sender: { name: null, address: "prn_ada@acme.example" },
          parts: [{ kind: "text", text: `message ${index}` }],
        },
      );
      ids.push(posted.id);
    }

    const page1 = await roomMessages.listMessages({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
    });
    expect(page1.items).toHaveLength(50);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await roomMessages.listMessages({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      cursor: page1.nextCursor as string,
    });
    expect(page2.items).toHaveLength(5);
    expect(page2.nextCursor).toBeUndefined();
    // Every message appears exactly once across the two pages: a cursor
    // never skips a message and never repeats one.
    const paged = [...page1.items, ...page2.items].map((message) => message.id);
    expect(new Set(paged)).toEqual(new Set(ids));
  });
});

describe("listActivity", () => {
  test("reports the newest message, the unread count, and a preview", async () => {
    const roomMessages = createInMemoryRoomMessageStore();
    const publisher = recordingPublisher();
    const post = (text: string) =>
      postRoomMessage(
        { roomMessages, publish: publisher.publish },
        {
          tenantId: TENANT,
          workbenchId: WORKBENCH,
          sender: { name: null, address: "prn_ada@acme.example" },
          parts: [{ kind: "text", text }],
        },
      );

    const first = await post("first");
    await Bun.sleep(2);
    const second = await post("second");

    const activity = await roomMessages.listActivity({
      tenantId: TENANT,
      workbenches: [
        { workbenchId: WORKBENCH, sinceCreatedAt: first.createdAt },
        { workbenchId: "run_never_opened" },
      ],
    });

    expect(activity[WORKBENCH]).toEqual({
      unreadCount: 1,
      lastActivityAt: second.createdAt,
      preview: "second",
    });
    // A workbench with no messages is absent, never a fabricated zero.
    expect(activity["run_never_opened"]).toBeUndefined();
  });

  // CL-6735: bench-list preview never shows the credential-error paragraph
  // (or HTTP/raw dumps). Prefer the last good human/agent text; fall back
  // to the short consumer notice when nothing earlier qualifies.
  // CL-6795 (preview blanks/ignores the latest user message) is separate —
  // this only skips failed-turn / classified-failure copy, never a normal
  // human or agent reply.
  test("a failed turn previews the last good text, never the failure paragraph", async () => {
    const roomMessages = createInMemoryRoomMessageStore();
    const publisher = recordingPublisher();
    const post = (
      parts: Parameters<typeof postRoomMessage>[1]["parts"],
      sender: { name: null; address: string } = {
        name: null,
        address: "prn_ada@acme.example",
      },
    ) =>
      postRoomMessage(
        { roomMessages, publish: publisher.publish },
        { tenantId: TENANT, workbenchId: WORKBENCH, sender, parts },
      );

    await post([{ kind: "text", text: "draft the agenda" }]);
    await Bun.sleep(2);
    const failed = await post(
      [
        {
          kind: "text",
          text: "This agent could not complete your request due to a credential error [HTTP 401]: API key is invalid.",
          turnFailed: true,
        },
      ],
      { name: null, address: "run_myra@acme.example" },
    );

    const activity = await roomMessages.listActivity({
      tenantId: TENANT,
      workbenches: [{ workbenchId: WORKBENCH }],
    });

    expect(activity[WORKBENCH]?.lastActivityAt).toBe(failed.createdAt);
    expect(activity[WORKBENCH]?.preview).toBe("draft the agenda");
    expect(activity[WORKBENCH]?.preview).not.toMatch(/credential error/i);
    expect(activity[WORKBENCH]?.preview).not.toMatch(/\[HTTP/i);
    expect(activity[WORKBENCH]?.preview).not.toContain("API key");
  });

  test("a lone failed turn falls back to the short consumer notice", async () => {
    const roomMessages = createInMemoryRoomMessageStore();
    const publisher = recordingPublisher();
    await postRoomMessage(
      { roomMessages, publish: publisher.publish },
      {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        sender: { name: null, address: "run_myra@acme.example" },
        runId: "run_myra",
        parts: [
          {
            kind: "text",
            text: "I can't reach a model right now — add or check your model key in Settings, then I'll pick this up. (ref abc)",
            turnFailed: true,
          },
        ],
      },
    );

    const activity = await roomMessages.listActivity({
      tenantId: TENANT,
      workbenches: [{ workbenchId: WORKBENCH }],
    });

    expect(activity[WORKBENCH]?.preview).toBe(
      CONSUMER_INFERENCE_FAILURE_NOTICE,
    );
    expect(activity[WORKBENCH]?.preview).not.toMatch(/model key/i);
    expect(activity[WORKBENCH]?.preview).not.toMatch(/ref /i);
  });

  // CL-6795: bench-list preview settles on the latest person-facing text —
  // never a blank title-only row while readable messages exist, and never a
  // stale greeting preferred over a newer human message.
  test("a newer user message previews over a stale agent greeting", async () => {
    const roomMessages = createInMemoryRoomMessageStore();
    const publisher = recordingPublisher();
    await postRoomMessage(
      { roomMessages, publish: publisher.publish },
      {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        sender: { name: "Myra", address: "run_myra@acme.example" },
        runId: "run_myra",
        parts: [
          { kind: "text", text: "Hi — I'm Myra. What are we working on?" },
        ],
      },
    );
    await Bun.sleep(2);
    const user = await postRoomMessage(
      { roomMessages, publish: publisher.publish },
      {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        sender: { name: null, address: "prn_ada@acme.example" },
        parts: [{ kind: "text", text: "draft the agenda for Monday" }],
      },
    );

    const activity = await roomMessages.listActivity({
      tenantId: TENANT,
      workbenches: [{ workbenchId: WORKBENCH }],
    });

    expect(activity[WORKBENCH]?.lastActivityAt).toBe(user.createdAt);
    expect(activity[WORKBENCH]?.preview).toBe("draft the agenda for Monday");
    expect(activity[WORKBENCH]?.preview).not.toMatch(/I'm Myra/i);
  });

  test("a join notice after readable text keeps the prior preview, never blanks", async () => {
    const roomMessages = createInMemoryRoomMessageStore();
    const publisher = recordingPublisher();
    await postRoomMessage(
      { roomMessages, publish: publisher.publish },
      {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        sender: { name: null, address: "prn_ada@acme.example" },
        parts: [{ kind: "text", text: "let's pull Scout in" }],
      },
    );
    await Bun.sleep(2);
    const joined = await postRoomMessage(
      { roomMessages, publish: publisher.publish },
      {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        sender: { name: null, address: "run_scout@acme.example" },
        runId: "run_scout",
        parts: [
          {
            kind: "event",
            event: "workbench.agent-joined",
            data: { address: "run_scout@acme.example" },
          },
        ],
      },
    );

    const activity = await roomMessages.listActivity({
      tenantId: TENANT,
      workbenches: [{ workbenchId: WORKBENCH }],
    });

    expect(activity[WORKBENCH]?.lastActivityAt).toBe(joined.createdAt);
    expect(activity[WORKBENCH]?.preview).toBe("let's pull Scout in");
  });
});

describe("previewOf", () => {
  test("collapses whitespace and truncates long text", () => {
    expect(previewOf([{ kind: "text", text: " hello   there \n" }])).toBe(
      "hello there",
    );
    expect(previewOf([{ kind: "text", text: "x".repeat(120) }])).toEndWith("…");
  });

  test("an attachment-only message previews as nothing", () => {
    expect(
      previewOf([
        {
          kind: "file",
          name: "notes.pdf",
          mediaType: "application/pdf",
          blobId: "blb_1",
        },
      ]),
    ).toBe("");
  });

  test("does not preview HTTP status, raw provider dumps, or the failure paragraph", () => {
    expect(
      previewOf([
        {
          kind: "text",
          text: "This agent could not complete your request due to a credential error [HTTP 401]: API key is invalid.",
        },
      ]),
    ).toBe(CONSUMER_INFERENCE_FAILURE_NOTICE);
    expect(
      previewOf([
        {
          kind: "text",
          text: "This agent could not complete your request because the API quota has been exhausted [HTTP 429]: rate limited",
        },
      ]),
    ).toBe(CONSUMER_INFERENCE_FAILURE_NOTICE);
  });

  test("a turnFailed notice is never the bench-list preview copy", () => {
    expect(
      previewOf([
        {
          kind: "text",
          text: "I didn't get that one — send it again and I'll pick it up. (ref xyz)",
          turnFailed: true,
        },
      ]),
    ).toBe(CONSUMER_INFERENCE_FAILURE_NOTICE);
  });
});
