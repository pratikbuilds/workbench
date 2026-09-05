// Each of these reproduces one specific, observed way a real local model
// misbehaved -- every one cost us a bug the night this catalogue was
// built. They are asserted here as plain reply builders; cl-6478-demo.test.ts
// demonstrates the flagship case (malformedToolName) wired through a
// multi-turn sequence.
import { describe, expect, test } from "bun:test";
import { createOllamaMock, sequence } from "./index";

async function chat(
  fetchImpl: (req: Request) => Promise<Response>,
  body: unknown,
): Promise<Response> {
  return fetchImpl(
    new Request("http://mock-ollama/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

type ChatCompletionBody = {
  choices: {
    message: {
      content: string | null;
      tool_calls?: { function: { name: string; arguments: string } }[];
    };
    finish_reason: string;
  }[];
};

describe("ollama.reply adversarial scenarios", () => {
  test("malformedToolName carries CL-6478's exact leaked fragment", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() => ollama.reply.malformedToolName());

    const response = await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "run the sidecar bundle" }],
      tools: [{ type: "function", function: { name: "run_shell" } }],
    });
    const body = (await response.json()) as ChatCompletionBody;

    const name = body.choices[0]?.message.tool_calls?.[0]?.function.name;
    expect(name).toContain("\n</parameter");
  });

  test("toolNameOfLength emits a tool name of exactly the requested length", async () => {
    const ollama = createOllamaMock();
    for (const length of [63, 64, 65]) {
      ollama.onChat(() => ollama.reply.toolNameOfLength(length));
      const response = await chat(ollama.fetch, {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "go" }],
      });
      const body = (await response.json()) as ChatCompletionBody;
      const name = body.choices[0]?.message.tool_calls?.[0]?.function.name;
      expect(name).toHaveLength(length);
    }
  });

  test("textlessToolCall carries no text, only a tool call -- a tool-only round, not an empty reply", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() =>
      ollama.reply.textlessToolCall("create_agent", { name: "researcher" }),
    );

    const response = await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "make me an agent" }],
    });
    const body = (await response.json()) as ChatCompletionBody;

    expect(body.choices[0]?.message.content).toBeNull();
    expect(body.choices[0]?.message.tool_calls).toHaveLength(1);
    expect(body.choices[0]?.finish_reason).toBe("tool_calls");
  });

  test("wrongShapedToolArgs is valid JSON that does not match the declared schema", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() =>
      ollama.reply.wrongShapedToolArgs("search_flights", {
        destination_typo: "SFO",
        passengers: "two",
      }),
    );

    const response = await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "book me a flight" }],
    });
    const body = (await response.json()) as ChatCompletionBody;
    const rawArgs =
      body.choices[0]?.message.tool_calls?.[0]?.function.arguments;

    expect(() => JSON.parse(rawArgs ?? "")).not.toThrow();
    expect(JSON.parse(rawArgs ?? "{}")).toEqual({
      destination_typo: "SFO",
      passengers: "two",
    });
  });

  test("truncatedToolArgs reaches the wire byte-for-byte and is NOT valid JSON", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() =>
      ollama.reply.truncatedToolArgs("search_flights", '{"origin": "SFO"'),
    );

    const response = await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "book me a flight" }],
    });
    const body = (await response.json()) as ChatCompletionBody;
    const rawArgs =
      body.choices[0]?.message.tool_calls?.[0]?.function.arguments;

    expect(rawArgs).toBe('{"origin": "SFO"');
    expect(() => JSON.parse(rawArgs ?? "")).toThrow();
  });

  test("refusal returns plain declining text with a normal stop reason", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() => ollama.reply.refusal("I can't help with that."));

    const response = await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "do something unsafe" }],
    });
    const body = (await response.json()) as ChatCompletionBody;

    expect(body.choices[0]?.message.content).toBe("I can't help with that.");
    expect(body.choices[0]?.finish_reason).toBe("stop");
  });

  test("oversized produces a large text blob with a length finish reason", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() => ollama.reply.oversized(50_000));

    const response = await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "write me a very long story" }],
    });
    const body = (await response.json()) as ChatCompletionBody;

    expect(body.choices[0]?.message.content).toHaveLength(50_000);
    expect(body.choices[0]?.finish_reason).toBe("length");
  });

  test("hallucinatedToolName calls load_skill instead of skills_load", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(() => ollama.reply.hallucinatedToolName());

    const response = await chat(ollama.fetch, {
      model: "qwen3.8:27b",
      messages: [{ role: "user", content: "load the git skill" }],
      tools: [{ type: "function", function: { name: "skills_load" } }],
    });
    const body = (await response.json()) as ChatCompletionBody;

    const name = body.choices[0]?.message.tool_calls?.[0]?.function.name;
    expect(name).toBe("load_skill");
    expect(name).not.toBe("skills_load");
  });
});

describe("sequence", () => {
  test("scripts one reply per turn, then repeats the last one", async () => {
    const ollama = createOllamaMock();
    ollama.onChat(
      sequence([ollama.reply.malformedToolName(), ollama.reply.text("turn 2")]),
    );

    const turn1 = (await (
      await chat(ollama.fetch, {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "1" }],
      })
    ).json()) as ChatCompletionBody;
    const turn2 = (await (
      await chat(ollama.fetch, {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "2" }],
      })
    ).json()) as ChatCompletionBody;
    const turn3 = (await (
      await chat(ollama.fetch, {
        model: "qwen3.8:27b",
        messages: [{ role: "user", content: "3" }],
      })
    ).json()) as ChatCompletionBody;

    expect(turn1.choices[0]?.message.tool_calls?.[0]?.function.name).toContain(
      "\n</parameter",
    );
    expect(turn2.choices[0]?.message.content).toBe("turn 2");
    // sequence exhausted -- turn 3 repeats the last scripted reply rather
    // than throwing or falling back to a default.
    expect(turn3.choices[0]?.message.content).toBe("turn 2");
  });

  test("throws immediately when scripted with no replies", () => {
    expect(() => sequence([])).toThrow(/at least one reply/);
  });
});
