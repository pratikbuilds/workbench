import { expect, test } from "bun:test";

import { defineEval } from "./define-eval.ts";
import { runEval, runMatrix } from "./runner.ts";
import type { ScorerResult, Target, Turn } from "./types.ts";

function fakeTarget(configName: string, replies: Record<string, Turn>): Target {
  const sent: string[] = [];
  return {
    configName,
    async sendTurn(human) {
      sent.push(human);
      const turn = replies[human];
      if (turn === undefined) {
        throw new Error(`fakeTarget: no scripted reply for "${human}"`);
      }
      return turn;
    },
    async close() {
      // no-op
    },
  };
}

function pass(name: string): ScorerResult {
  return { name, score: 1, pass: true, reason: "ok" };
}

function fail(name: string): ScorerResult {
  return { name, score: 0, pass: false, reason: "nope" };
}

test("runEval plays every step in order and grades against the growing transcript", async () => {
  const evalDef = defineEval({
    name: "two-step",
    description: "test",
    steps: [
      {
        human: "hello",
        expect: [
          (ctx) => {
            expect(ctx.turnIndex).toBe(0);
            expect(ctx.transcript).toHaveLength(1);
            return pass("greeted");
          },
        ],
      },
      {
        human: "second",
        expect: [
          (ctx) => {
            expect(ctx.turnIndex).toBe(1);
            expect(ctx.transcript).toHaveLength(2);
            return pass("followed-up");
          },
        ],
      },
    ],
  });

  const target = fakeTarget("default", {
    hello: { human: "hello", replyText: "hi there", toolCalls: [] },
    second: { human: "second", replyText: "sure", toolCalls: [] },
  });

  const result = await runEval(evalDef, target);
  expect(result.evalName).toBe("two-step");
  expect(result.configName).toBe("default");
  expect(result.steps).toHaveLength(2);
  expect(result.steps[0]?.scorerReports[0]).toMatchObject({
    name: "greeted",
    pass: true,
    stepIndex: 0,
  });
  expect(result.steps[1]?.scorerReports[0]).toMatchObject({
    name: "followed-up",
    pass: true,
    stepIndex: 1,
  });
});

test("runEval plays memorySeed turns before the scripted steps, ungraded", async () => {
  const evalDef = defineEval({
    name: "with-seed",
    description: "test",
    memorySeed: ["the sky is blue"],
    steps: [
      {
        human: "go",
        expect: [() => pass("only-scorer")],
      },
    ],
  });
  const seen: string[] = [];
  const target: Target = {
    configName: "default",
    async sendTurn(human) {
      seen.push(human);
      return { human, replyText: "ok", toolCalls: [] };
    },
    async close() {},
  };
  const result = await runEval(evalDef, target);
  expect(seen).toEqual(["Please remember: the sky is blue", "go"]);
  // Only the scripted step produces a scored EvalStepRecord.
  expect(result.steps).toHaveLength(1);
});

test("runMatrix runs every eval against every config and always closes the target", async () => {
  const evalA = defineEval({
    name: "a",
    description: "test",
    steps: [{ human: "hi", expect: [() => pass("p")] }],
  });
  const evalB = defineEval({
    name: "b",
    description: "test",
    steps: [{ human: "hi", expect: [() => fail("f")] }],
  });
  const closed: string[] = [];
  const results = await runMatrix(
    [evalA, evalB],
    [{ name: "cfg1" }, { name: "cfg2" }],
    async (configName) => ({
      configName,
      async sendTurn(human) {
        return { human, replyText: "ok", toolCalls: [] };
      },
      async close() {
        closed.push(configName);
      },
    }),
  );
  expect(results).toHaveLength(4);
  expect(closed).toEqual(["cfg1", "cfg2"]);
  expect(results.map((r) => `${r.evalName}/${r.configName}`).sort()).toEqual(
    ["a/cfg1", "a/cfg2", "b/cfg1", "b/cfg2"].sort(),
  );
});

test("runEval plays a persona step's sub-turns in order and scores the final one", async () => {
  const evalDef = defineEval({
    name: "persona-step",
    description: "test",
    steps: [
      {
        kind: "persona",
        opening: "set up my digest",
        persona: {
          name: "Dana",
          goal: "get a daily digest set up",
          knownFacts: { cadence: "every weekday at 8am" },
        },
        maxTurns: 5,
        expect: [
          (ctx) => {
            expect(ctx.transcript).toHaveLength(2);
            expect(ctx.turnIndex).toBe(1);
            return pass("final-turn-scored");
          },
        ],
      },
    ],
  });

  let turnCount = 0;
  const target: Target = {
    configName: "default",
    async sendTurn(human) {
      turnCount += 1;
      if (turnCount === 1) {
        return {
          human,
          replyText: "What cadence works for you?",
          toolCalls: [],
        };
      }
      return { human, replyText: "Great, all set.", toolCalls: [] };
    },
    async close() {},
  };
  const personaCall = async () => ({ text: "every weekday at 8am" });

  const result = await runEval(evalDef, target, personaCall);

  expect(result.steps).toHaveLength(1);
  expect(result.steps[0]?.scorerReports[0]).toMatchObject({
    name: "final-turn-scored",
    pass: true,
    stepIndex: 0,
  });
});

test("runEval throws rather than record a corrupted step if a persona sub-loop yields no turns", async () => {
  // Bypasses defineEval's maxTurns validation to prove runEval itself
  // guards against a malformed EvalDefinition, not just well-formed ones.
  const evalDef = {
    name: "malformed",
    description: "test",
    steps: [
      {
        kind: "persona" as const,
        opening: "set up my digest",
        persona: { name: "Dana", goal: "get a digest", knownFacts: {} },
        maxTurns: 0,
        expect: [],
      },
    ],
  };
  const target: Target = {
    configName: "cfg",
    async sendTurn(human) {
      return { human, replyText: "unreachable", toolCalls: [] };
    },
    async close() {},
  };

  await expect(runEval(evalDef, target)).rejects.toThrow(
    "runEval: step 0 produced no turns",
  );
});

test("runMatrix still closes the target when a run throws", async () => {
  const evalDef = defineEval({
    name: "boom",
    description: "test",
    steps: [{ human: "hi", expect: [] }],
  });
  let closed = false;
  await expect(
    runMatrix([evalDef], [{ name: "cfg" }], async (configName) => ({
      configName,
      async sendTurn() {
        throw new Error("target failed");
      },
      async close() {
        closed = true;
      },
    })),
  ).rejects.toThrow("target failed");
  expect(closed).toBe(true);
});

test("runEval drives an install-template step through the target's installTemplate", async () => {
  const evalDef = defineEval({
    name: "install",
    description: "test",
    steps: [
      {
        kind: "install-template",
        templateId: "code-review",
        expect: [
          (ctx) => {
            expect(ctx.transcript[ctx.turnIndex]?.replyText).toContain(
              "installed",
            );
            return pass("installed");
          },
        ],
      },
    ],
  });
  const installed: string[] = [];
  const target: Target = {
    configName: "cfg",
    async sendTurn() {
      throw new Error("install-template must never ride sendTurn");
    },
    async installTemplate(templateId) {
      installed.push(templateId);
      return {
        human: `(harness) install template "${templateId}"`,
        replyText: `template "${templateId}" installed`,
        toolCalls: [],
      };
    },
    async close() {},
  };

  const result = await runEval(evalDef, target);
  expect(installed).toEqual(["code-review"]);
  expect(result.steps[0]?.scorerReports[0]).toMatchObject({
    name: "installed",
    pass: true,
  });
});

test("runEval fails loudly when an install-template step meets a target without the capability", async () => {
  const evalDef = defineEval({
    name: "install-missing",
    description: "test",
    steps: [
      { kind: "install-template", templateId: "code-review", expect: [] },
    ],
  });
  const target: Target = {
    configName: "cfg",
    async sendTurn(human) {
      return { human, replyText: "unreachable", toolCalls: [] };
    },
    async close() {},
  };
  await expect(runEval(evalDef, target)).rejects.toThrow(
    "no installTemplate capability",
  );
});

test("runEval fires a fire-webhook step against the snapshot's enabled trigger", async () => {
  const evalDef = defineEval({
    name: "fire",
    description: "test",
    steps: [
      {
        kind: "fire-webhook",
        payload: { action: "opened" },
        expect: [],
      },
    ],
  });
  const fired: { triggerId: string; payload: unknown }[] = [];
  const target: Target = {
    configName: "cfg",
    async sendTurn() {
      throw new Error("fire-webhook must never ride sendTurn");
    },
    async snapshotWorld() {
      return {
        capturedAt: new Date().toISOString(),
        agentDefinitions: [],
        connections: [],
        webhookTriggers: [
          {
            id: "wt_disabled",
            name: "off",
            workflowDefinitionId: "wd_1",
            enabled: false,
          },
          {
            id: "wt_live",
            name: "on",
            workflowDefinitionId: "wd_1",
            enabled: true,
          },
        ],
        fakeReceipts: [],
      };
    },
    async fireWebhook(triggerId, payload) {
      fired.push({ triggerId, payload });
      return {
        human: `(harness) fire webhook trigger ${triggerId}`,
        replyText: "webhook delivery accepted",
        toolCalls: [],
      };
    },
    async close() {},
  };

  const result = await runEval(evalDef, target);
  expect(fired).toEqual([
    { triggerId: "wt_live", payload: { action: "opened" } },
  ]);
  expect(result.steps[0]?.turn.replyText).toContain("accepted");
});

test("runEval records an honest miss when a fire-webhook step finds no enabled trigger", async () => {
  const evalDef = defineEval({
    name: "fire-miss",
    description: "test",
    steps: [{ kind: "fire-webhook", payload: {}, expect: [] }],
  });
  const target: Target = {
    configName: "cfg",
    async sendTurn() {
      throw new Error("unreachable");
    },
    async fireWebhook() {
      throw new Error("must not fire with no enabled trigger");
    },
    async close() {},
  };
  const result = await runEval(evalDef, target);
  expect(result.steps[0]?.turn.replyText).toContain(
    "no enabled webhook_trigger",
  );
});
