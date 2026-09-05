import { expect, test } from "bun:test";

import { ASK_USER_TOOL, interactionTools } from "./tool";
import type { AskUserEnv } from "./tool";

function testEnv(): AskUserEnv {
  return {
    hubChatUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
  } as unknown as AskUserEnv;
}

async function withFetch<T>(
  fetchImpl: typeof fetch,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test("declares exactly ask_user, with no approval gate", () => {
  expect(interactionTools.definitions).toEqual([{ name: ASK_USER_TOOL }]);
});

test("requires the sanctioned env keys", () => {
  expect(interactionTools.requires).toEqual([
    "hubChatUrl",
    "sidecarToken",
    "address",
  ]);
});

test("interactionTools contributes no beforeToolExtension: ask_user never suspends", () => {
  const bundle = interactionTools(testEnv());
  expect(bundle.beforeToolExtension).toBeUndefined();
});

test("ask_user posts a question block and ends the turn with the answer arriving as the next message", async () => {
  let posted = false;
  const fetchImpl = (async () => {
    posted = true;
    return new Response(
      JSON.stringify({ id: "msg_1", createdAt: "2026-08-17T00:00:00.000Z" }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const bundle = interactionTools(testEnv());
  const call = {
    id: "call_1",
    name: ASK_USER_TOOL,
    arguments: {
      question: "Which environment?",
      options: ["Staging", "Production"],
    },
  };
  const result = await withFetch(fetchImpl, () =>
    bundle.run(call, new AbortController().signal),
  );

  expect(posted).toBe(true);
  expect(result.isError).toBeFalsy();
  expect(result.callId).toBe("call_1");
  expect(String(result.content)).toMatch(/end this turn/i);
  expect(String(result.content)).toMatch(/next inbound message/i);
});

test("ask_user's result text tells the model to stop, not to wait for a reply here", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({ id: "msg_1", createdAt: "2026-08-17T00:00:00.000Z" }),
      { status: 201 },
    )) as unknown as typeof fetch;

  const bundle = interactionTools(testEnv());
  const result = await withFetch(fetchImpl, () =>
    bundle.run(
      {
        id: "call_1",
        name: ASK_USER_TOOL,
        arguments: { question: "Which environment?", options: ["A", "B"] },
      },
      new AbortController().signal,
    ),
  );

  // This is instruction text in the model's own context, not something the
  // runtime enforces: nothing stops the model from calling another tool or
  // continuing to talk after reading it (docs/CHAT.md).
  expect(String(result.content)).toMatch(/end this turn now/i);
  expect(String(result.content)).toMatch(/do not wait for a reply here/i);
});

test("retrying ask_user for the same call reuses the questionId so a crash between post and return cannot orphan a second card", async () => {
  const postedQuestionIds: string[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      parts: readonly {
        block: { data: Record<string, unknown> };
      }[];
    };
    const questionId = body.parts[0]?.block.data["questionId"];
    if (typeof questionId === "string") postedQuestionIds.push(questionId);
    return new Response(
      JSON.stringify({
        id: `msg_${postedQuestionIds.length}`,
        createdAt: "2026-08-17T00:00:00.000Z",
      }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const bundle = interactionTools(testEnv());
  const call = {
    id: "call_1",
    name: ASK_USER_TOOL,
    arguments: {
      question: "Which environment?",
      options: ["Staging", "Production"],
    },
  };

  await withFetch(fetchImpl, () =>
    bundle.run(call, new AbortController().signal),
  );
  await withFetch(fetchImpl, () =>
    bundle.run(call, new AbortController().signal),
  );

  expect(postedQuestionIds).toHaveLength(2);
  const reusedId = postedQuestionIds[0];
  if (reusedId === undefined) {
    throw new Error("expected a posted questionId");
  }
  expect(postedQuestionIds[1]).toBe(reusedId);
  expect(reusedId).toMatch(/^q_[0-9a-f]{32}$/);
});

test("ask_user rejects fewer than 2 options before ever posting", async () => {
  let posted = false;
  const fetchImpl = (async () => {
    posted = true;
    return new Response("{}", { status: 201 });
  }) as unknown as typeof fetch;

  const bundle = interactionTools(testEnv());
  const result = await withFetch(fetchImpl, () =>
    bundle.run(
      {
        id: "call_1",
        name: ASK_USER_TOOL,
        arguments: { question: "Q?", options: ["only one"] },
      },
      new AbortController().signal,
    ),
  );

  expect(posted).toBe(false);
  expect(result.isError).toBe(true);
});

test("ask_user surfaces a no-own-channel failure as an error result, not a throw", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "not_found",
          userMessage: "no channel found",
          refId: "ref_test",
        },
      }),
      { status: 404 },
    )) as unknown as typeof fetch;

  const bundle = interactionTools(testEnv());
  const result = await withFetch(fetchImpl, () =>
    bundle.run(
      {
        id: "call_1",
        name: ASK_USER_TOOL,
        arguments: { question: "Q?", options: ["a", "b"] },
      },
      new AbortController().signal,
    ),
  );

  expect(result.isError).toBe(true);
  expect(result.content).toBe("no channel found");
});

test("an unknown tool name returns an honest error", async () => {
  const bundle = interactionTools(testEnv());
  const result = await bundle.run(
    { id: "call_1", name: "delete_everything", arguments: {} },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).toMatch(/unknown tool/);
});
