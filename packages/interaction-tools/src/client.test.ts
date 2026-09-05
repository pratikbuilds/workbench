import { expect, test } from "bun:test";

import { NoOwnChannelError, postQuestion } from "./client";
import type { AskUserClientConfig } from "./client";

function testConfig(fetchImpl: typeof fetch): AskUserClientConfig {
  return {
    hubChatUrl: "https://hub.example.com",
    sidecarToken: "sc-token",
    address: "run_1@workflow",
    fetchImpl,
  };
}

test("postQuestion posts a question block to the workflow-chat participants/messages endpoint with sidecar auth", async () => {
  let seenUrl: string | undefined;
  let seenHeaders: Record<string, string> | undefined;
  let seenBody: unknown;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = init?.headers as Record<string, string>;
    seenBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ id: "msg_1", createdAt: "2026-08-17T00:00:00.000Z" }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const result = await postQuestion(testConfig(fetchImpl), {
    question: "Which environment?",
    subtitle: "Pick the closest match.",
    options: ["Staging", "Production"],
    allowFreeText: true,
  });

  expect(seenUrl).toBe(
    "https://hub.example.com/api/workflow-chat/participants/messages",
  );
  expect(seenHeaders?.["authorization"]).toBe("Bearer sc-token");
  expect(seenHeaders?.["x-workflow-run-address"]).toBe("run_1@workflow");
  const body = seenBody as {
    parts: readonly {
      kind: string;
      block: { type: string; data: Record<string, unknown> };
    }[];
  };
  expect(body.parts).toHaveLength(1);
  expect(body.parts[0]?.kind).toBe("block");
  expect(body.parts[0]?.block.type).toBe("question");
  expect(body.parts[0]?.block.data["question"]).toBe("Which environment?");
  expect(body.parts[0]?.block.data["subtitle"]).toBe("Pick the closest match.");
  expect(body.parts[0]?.block.data["options"]).toEqual([
    "Staging",
    "Production",
  ]);
  expect(body.parts[0]?.block.data["allowFreeText"]).toBe(true);
  expect(typeof body.parts[0]?.block.data["questionId"]).toBe("string");
  expect(result.messageId).toBe("msg_1");
  expect(result.questionId).toBe(
    body.parts[0]?.block.data["questionId"] as string,
  );
});

test("postQuestion stamps a caller-supplied questionId on the card instead of minting", async () => {
  let seenBody: unknown;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    seenBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ id: "msg_1", createdAt: "2026-08-17T00:00:00.000Z" }),
      { status: 201 },
    );
  }) as unknown as typeof fetch;

  const result = await postQuestion(testConfig(fetchImpl), {
    question: "Which environment?",
    options: ["Staging", "Production"],
    questionId: "q_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });

  const body = seenBody as {
    parts: readonly {
      kind: string;
      block: { type: string; data: Record<string, unknown> };
    }[];
  };
  expect(body.parts[0]?.block.data["questionId"]).toBe(
    "q_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  expect(result.questionId).toBe("q_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  expect(result.messageId).toBe("msg_1");
});

test("a 404 from the route surfaces as NoOwnChannelError", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "not_found",
          userMessage: "no channel",
          refId: "ref_test",
        },
      }),
      { status: 404 },
    )) as unknown as typeof fetch;

  try {
    await postQuestion(testConfig(fetchImpl), {
      question: "Q?",
      options: ["a", "b"],
    });
    throw new Error("expected NoOwnChannelError");
  } catch (error) {
    expect(error).toBeInstanceOf(NoOwnChannelError);
    expect((error as Error).message).toBe("no channel");
  }
});

test("a non-ok, non-404 response surfaces the envelope userMessage", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "internal_error",
          userMessage: "the hub could not post the question",
          refId: "ref_test",
        },
      }),
      { status: 500 },
    )) as unknown as typeof fetch;

  await expect(
    postQuestion(testConfig(fetchImpl), {
      question: "Q?",
      options: ["a", "b"],
    }),
  ).rejects.toThrow("the hub could not post the question");
});

test("reads userMessage even when a legacy message field is also present", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "internal_error",
          message: "legacy",
          userMessage: "canonical",
          refId: "ref_test",
        },
      }),
      { status: 500 },
    )) as unknown as typeof fetch;

  try {
    await postQuestion(testConfig(fetchImpl), {
      question: "Q?",
      options: ["a", "b"],
    });
    throw new Error("expected postQuestion to throw");
  } catch (error) {
    expect((error as Error).message).toBe(
      "Posting the question failed: canonical",
    );
  }
});

test("a 404 envelope with only error.message falls back, never the legacy field", async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        error: { code: "not_found", message: "legacy" },
      }),
      { status: 404 },
    )) as unknown as typeof fetch;

  try {
    await postQuestion(testConfig(fetchImpl), {
      question: "Q?",
      options: ["a", "b"],
    });
    throw new Error("expected NoOwnChannelError");
  } catch (error) {
    expect(error).toBeInstanceOf(NoOwnChannelError);
    expect((error as Error).message).toBe(
      "The caller has no channel of its own to post into",
    );
  }
});

test("a non-ok, non-envelope response falls back to status text", async () => {
  const fetchImpl = (async () =>
    new Response("boom", {
      status: 500,
      statusText: "Internal Server Error",
    })) as unknown as typeof fetch;

  try {
    await postQuestion(testConfig(fetchImpl), {
      question: "Q?",
      options: ["a", "b"],
    });
    throw new Error("expected postQuestion to throw");
  } catch (error) {
    expect((error as Error).message).toBe(
      "Posting the question failed: 500 Internal Server Error",
    );
  }
});
