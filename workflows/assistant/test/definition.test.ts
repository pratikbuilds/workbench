// Tests for this package's own contract: the shape our factory
// commits to, its serialization guarantees, and its boundary. The
// platform's own normalization and validation are its business, not
// re-proven here.

import { expect, test } from "bun:test";
import type { StepPrimitive, WorkflowDefinition } from "@intx/workflow";

import {
  ASSISTANT_STEP_ID,
  ASSISTANT_SYSTEM_PROMPT,
  ASSISTANT_TOOL_PACKAGE_PINS,
  ASSISTANT_WORKFLOW_ID,
  buildAssistantWorkflow,
  serializeAssistantWorkflow,
} from "../src/index";

const INPUT = {
  triggerAddress: "ins_dep000000000000@example.test",
  inferencePreferences: [{ provider: "anthropic", model: "claude-test" }],
  turnTimeoutMs: 600000,
} as const;

function assistantStep(definition: WorkflowDefinition): StepPrimitive {
  const primitive = definition.steps[ASSISTANT_STEP_ID];
  if (primitive === undefined || primitive.kind !== "step") {
    throw new Error(
      `definition has no step primitive named ${ASSISTANT_STEP_ID}`,
    );
  }
  return primitive;
}

test("the definition has exactly one step, so a deployment stays conversational", () => {
  // A single-step deployment keeps one warm agent with durable memory
  // across runs; a second step would silently trade that memory away.
  // This assertion is the tripwire against that regression.
  const definition = buildAssistantWorkflow(INPUT);
  expect(definition.stepOrder).toEqual([ASSISTANT_STEP_ID]);
  expect(Object.keys(definition.steps)).toEqual([ASSISTANT_STEP_ID]);
});

test("the step carries an explicit per-turn timeout", () => {
  const definition = buildAssistantWorkflow(INPUT);
  expect(assistantStep(definition).timeout).toBe(INPUT.turnTimeoutMs);
});

test("the step is unbounded: it re-arms after every reply instead of completing after the first", () => {
  // The platform's step primitive defaults `triggers` to 1 (batch). A
  // conversation is the long-lived interactive agent that must never
  // self-complete — without this, the run ends after the greeting and
  // every later message is rejected as sent to a terminal run.
  expect(assistantStep(buildAssistantWorkflow(INPUT)).triggers).toBe(
    "unbounded",
  );
});

test("the workflow is triggered by mail to the given deployment address", () => {
  const definition = buildAssistantWorkflow(INPUT);
  expect(definition.id).toBe(ASSISTANT_WORKFLOW_ID);
  expect(definition.triggers).toEqual([
    { type: "mail", to: INPUT.triggerAddress },
  ]);
});

test("the agent carries the assistant prompt, the preferences, and inlines no tools", () => {
  const agent = assistantStep(buildAssistantWorkflow(INPUT)).agent;
  expect(agent.systemPrompt).toBe(ASSISTANT_SYSTEM_PROMPT);
  expect(agent.inference.sources).toEqual([...INPUT.inferencePreferences]);
  // Tools arrive as packages on the deploy, never inlined here: an
  // inline factory is a function-valued field the asset cannot carry.
  expect(agent.toolFactories).toEqual([]);
});

test("the prompt tells Myra a canned opener already greeted under her name — answer the first message, never greet again", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "posted on the timeline under your name",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "Never greet or introduce yourself again",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "answer their first message directly",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).not.toContain("kickoff brief");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "Never list your capabilities as a menu",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).not.toContain("standing job");
});

test("the prompt tells Myra to use ask_user instead of prose lists for enumerable-option interviews", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("ask_user");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("interactive card");
});

test("the prompt opens with a one-line identity and is organized into named sections", () => {
  expect(ASSISTANT_SYSTEM_PROMPT.startsWith("You are Myra")).toBe(true);
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("## Where you are");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("## Deciding what to do");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("## Tools");
});

test("the prompt grounds Myra inside the workbench — she never asks to be pointed at it", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("already inside the workbench");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "never ask to be pointed at the workbench",
  );
});

test("the prompt has Myra load the writing-system-prompts skill before authoring any agent prompt", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("writing-system-prompts");
});

test("the agent pins memory, capability, and the manager-tools bundles at the versions the workspace publishes", async () => {
  const agent = assistantStep(buildAssistantWorkflow(INPUT)).agent;
  expect(agent.toolPackagePins).toEqual(ASSISTANT_TOOL_PACKAGE_PINS);
  expect(ASSISTANT_TOOL_PACKAGE_PINS.map((pin) => pin.name)).toEqual([
    "@corbits/memory-tools",
    "@corbits/capability-tools",
    "@corbits/agent-directory-tools",
    "@corbits/connections-tools",
    "@corbits/catalog-tools",
    "@corbits/skills-tools",
    "@corbits/mcp-tools",
    "@corbits/interaction-tools",
    "@corbits/manus-tools",
    "@corbits/workflow-authoring-tools",
  ]);
  // A pin the registry cannot resolve fails every assistant deploy, so
  // each one must name a version the workspace actually publishes.
  for (const pin of ASSISTANT_TOOL_PACKAGE_PINS) {
    const manifestPath = new URL(
      `../../../packages/${pin.name.replace("@corbits/", "")}/package.json`,
      import.meta.url,
    );
    const manifest = (await Bun.file(manifestPath).json()) as {
      version: string;
    };
    expect({ name: pin.name, version: pin.version }).toEqual({
      name: pin.name,
      version: manifest.version,
    });
  }
});

test("the prompt tells Myra to discover an MCP server's tools before calling one", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("mcp_list_tools");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("mcp_call");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("never guess a tool name");
});

test("the prompt never writes tool JSON as reply text and does not memory_search a bare greeting", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("only through tool calls");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "never by writing a JSON object with a tool name into your reply",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "never memory_search a bare greeting",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "use memory only when you actually need a fact from earlier",
  );
});

test("the workflow pins manus-tools and does not require a Manus credential binding", () => {
  const definition = buildAssistantWorkflow(INPUT);
  expect(ASSISTANT_TOOL_PACKAGE_PINS.map((pin) => pin.name)).toContain(
    "@corbits/manus-tools",
  );
  expect(definition.credentialBindings ?? []).toEqual([]);
});

test("the definition survives the workflow-asset JSON round-trip", () => {
  const definition = buildAssistantWorkflow(INPUT);
  const revived: unknown = JSON.parse(serializeAssistantWorkflow(definition));
  expect(revived).toEqual(definition);
});

test("serialization fails loud on a function-valued field, naming its path", () => {
  const poisoned = {
    id: ASSISTANT_WORKFLOW_ID,
    triggers: [{ type: "manual" }],
    stepOrder: [ASSISTANT_STEP_ID],
    steps: {
      assistant: {
        kind: "step",
        id: ASSISTANT_STEP_ID,
        drainBehavior: "cancel",
        agent: {
          id: ASSISTANT_STEP_ID,
          systemPrompt: ASSISTANT_SYSTEM_PROMPT,
          toolFactories: [() => []],
          capabilities: [],
          inference: { sources: [] },
        },
      },
    },
  } as unknown as WorkflowDefinition;
  expect(() => serializeAssistantWorkflow(poisoned)).toThrow(
    /steps\.assistant\.agent\.toolFactories\[0\]/,
  );
});

test("an empty trigger address is rejected", () => {
  expect(() =>
    buildAssistantWorkflow({ ...INPUT, triggerAddress: "" }),
  ).toThrow(/triggerAddress/);
});

test("a non-positive or fractional turn timeout is rejected", () => {
  expect(() => buildAssistantWorkflow({ ...INPUT, turnTimeoutMs: 0 })).toThrow(
    /turnTimeoutMs/,
  );
  expect(() =>
    buildAssistantWorkflow({ ...INPUT, turnTimeoutMs: 0.5 }),
  ).toThrow(/turnTimeoutMs/);
});

// CL-5879: an outcome ("a sales motion", "a content pipeline", "a repo
// to maintain") is enough on its own for Myra to propose a team design
// — she never waits to be told the mechanism ("make an agent").
test("the prompt tells Myra to propose a team design from an outcome, never wait for the mechanism", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "never wait to be told the mechanism",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "work out the team yourself: which specialists it needs",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "say that plan back in one short paragraph before doing anything",
  );
});

test("the prompt asks only for facts Myra can't infer, never permission to use the mechanism", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "ask only for the handful of facts you genuinely can't infer",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "never 'should I create an agent for that?'",
  );
});

test("the prompt builds the whole team on the person's OK: agents, routines, and memory in one go", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "On their OK, build the whole thing in one go: create the " +
      "specialists (each gets their own chat), create the routines, " +
      "and save the facts they gave you to memory",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).not.toContain("invite them in");
  expect(ASSISTANT_SYSTEM_PROMPT).not.toContain("create_channel");
});

test("the prompt has a delegated specialist finish its thread with a summary back to the host/main", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "that @mention opens a thread for the deep-dive",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "finish its thread with a one-line summary addressed back to you " +
      "and the main conversation",
  );
});

// CL-6179: on a stated outcome, Myra runs a short, bounded discovery
// interview before proposing anything — never the open-ended intake
// this clause exists to rule out.
test("the prompt runs discovery inside 'Deciding what to do', in order: interview, propose, build, hand off", () => {
  const decidingSection = ASSISTANT_SYSTEM_PROMPT.slice(
    ASSISTANT_SYSTEM_PROMPT.indexOf("## Deciding what to do"),
    ASSISTANT_SYSTEM_PROMPT.indexOf("## Being a teammate"),
  );

  const interviewAt = decidingSection.indexOf("ask one or two sharp questions");
  const proposeAt = decidingSection.indexOf(
    "propose a small, named specialist team",
  );
  const buildAt = decidingSection.indexOf("Build only on a light confirmation");
  const skillAt = decidingSection.indexOf("load the writing-system-prompts");
  const createAgentAt = decidingSection.indexOf("create_agent");
  const handoffAt = decidingSection.indexOf(
    "Their own chats for focused work.",
  );

  for (const at of [
    interviewAt,
    proposeAt,
    buildAt,
    skillAt,
    createAgentAt,
    handoffAt,
  ]) {
    expect(at).toBeGreaterThan(-1);
  }
  expect(interviewAt).toBeLessThan(proposeAt);
  expect(proposeAt).toBeLessThan(buildAt);
  // The skill loads before create_agent ever fires.
  expect(skillAt).toBeLessThan(createAgentAt);
  expect(createAgentAt).toBeLessThan(handoffAt);
});

test("the prompt's discovery interview uses ask_user for enumerable options, never a long open-ended one", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "a tappable card via ask_user when the options are enumerable",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "never a long, open-ended interview",
  );
});

// CL-6350: Myra answers by default and only stands down when a message
// @-mentions a different teammate and not her — the reverse of her own
// @mention-to-delegate rule.
test("the prompt tells Myra to answer by default and stay out of a thread @-mentioning someone else", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain("You answer by default");
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "that is their turn — stay out of it",
  );
});

test("the prompt hands a built team off with the exact discovery closing line", () => {
  expect(ASSISTANT_SYSTEM_PROMPT).toContain(
    "Their own chats for focused work. Here when you want me to run " +
      "the hunt and hand things off.",
  );
  expect(ASSISTANT_SYSTEM_PROMPT).not.toContain("invite them into this");
  expect(ASSISTANT_SYSTEM_PROMPT).not.toContain("invite it into this");
});
