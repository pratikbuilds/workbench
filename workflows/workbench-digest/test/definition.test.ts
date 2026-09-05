// Tests for this package's own contract: the shape our factory
// commits to, its serialization guarantees, and its boundary. The
// platform's own normalization and validation are its business, not
// re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  WORKBENCH_DIGEST_SCHEDULE_CRON,
  WORKBENCH_DIGEST_STEP_ID,
  WORKBENCH_DIGEST_SYSTEM_PROMPT,
  WORKBENCH_DIGEST_WORKFLOW_ID,
  buildWorkbenchDigestWorkflow,
  serializeWorkbenchDigestWorkflow,
} from "../src/index";

const INPUT = {
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 60000,
} as const;

function digestStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[WORKBENCH_DIGEST_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${WORKBENCH_DIGEST_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition has exactly one step", () => {
  const definition = buildWorkbenchDigestWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([WORKBENCH_DIGEST_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([WORKBENCH_DIGEST_STEP_ID]);
});

test("the step carries an explicit per-turn timeout", () => {
  const definition = buildWorkbenchDigestWorkflow(INPUT);
  expect(digestStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the workflow is triggered on the daily 09:00 UTC schedule", () => {
  const definition = buildWorkbenchDigestWorkflow(INPUT);
  expect(definition.id).toBe(WORKBENCH_DIGEST_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "schedule", cron: "0 9 * * *" },
  ]);
  expect(WORKBENCH_DIGEST_SCHEDULE_CRON).toBe("0 9 * * *");
});

test("the agent instructs relaying the exact summary line, carries the preferences, and inlines no tools", () => {
  const agent = digestStep(buildWorkbenchDigestWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(WORKBENCH_DIGEST_SYSTEM_PROMPT);
  expect(agent.inference.sources).toEqual([...INPUT.inferencePreferences]);
  // Tools arrive as packages on the deploy, never inlined here: an
  // inline factory is a function-valued field the asset cannot carry.
  expect(agent.toolFactories).toEqual([]);
});

test("the definition survives the workflow-asset JSON round-trip", () => {
  const definition = buildWorkbenchDigestWorkflow(INPUT);
  const revived: unknown = JSON.parse(
    serializeWorkbenchDigestWorkflow(definition),
  );
  expect(revived).toEqual(definition);
});

test("serialization fails loud on a function-valued field, naming its path", () => {
  const poisoned = {
    id: WORKBENCH_DIGEST_WORKFLOW_ID,
    triggers: [{ type: "manual" }],
    stepOrder: [WORKBENCH_DIGEST_STEP_ID],
    steps: {
      "workbench-digest": {
        kind: "step",
        id: WORKBENCH_DIGEST_STEP_ID,
        drainBehavior: "cancel",
        agent: {
          id: WORKBENCH_DIGEST_STEP_ID,
          systemPrompt: WORKBENCH_DIGEST_SYSTEM_PROMPT,
          toolFactories: [() => []],
          capabilities: [],
          inference: { sources: [] },
        },
      },
    },
  } as unknown as WorkflowDefinition;
  expect(() => serializeWorkbenchDigestWorkflow(poisoned)).toThrow(
    /steps\.workbench-digest\.agent\.toolFactories\[0\]/,
  );
});

test("a non-positive or fractional turn timeout is rejected", () => {
  expect(() =>
    buildWorkbenchDigestWorkflow({ ...INPUT, turnTimeoutMs: 0 }),
  ).toThrow(/turnTimeoutMs/);
  expect(() =>
    buildWorkbenchDigestWorkflow({ ...INPUT, turnTimeoutMs: 0.5 }),
  ).toThrow(/turnTimeoutMs/);
});
