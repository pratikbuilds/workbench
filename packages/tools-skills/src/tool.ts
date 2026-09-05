// The `@corbits/tools-skills` bundle: `skills_list`, `skills_search`,
// and `skills_load` — the agent-facing half of the skill registry. A
// definition's pinned skills are already named in its system prompt's
// `<available_skills>` index (`@corbits/skills`' `withAvailableSkills`);
// `skills_load` is how the model turns one of those names into the actual
// instructions, so the index stays cheap and only the skills a turn
// truly needs are paid for in context.
//
// Fail-closed throughout: a transport, HTTP, auth, or shape failure
// comes back as a `ToolResult` with `isError: true` naming the failure.
// None of the three ever degrades to an empty list or an invented body —
// an agent told "no skills" behaves very differently from one told "the
// registry is unreachable", and only the second is honest.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";

import { listSkills, loadSkill, searchSkills } from "./client";

export const SKILLS_LIST_TOOL = "skills_list";
export const SKILLS_SEARCH_TOOL = "skills_search";
export const SKILLS_LOAD_TOOL = "skills_load";

/** Env this bundle needs beyond `BaseEnv`: the run's hub-reach credential. */
export interface WorkflowSkillsToolEnv extends BaseEnv {
  readonly hubSkillsUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

function errorResult(callId: string, err: unknown): ToolResult {
  return {
    callId,
    isError: true,
    content: err instanceof Error ? err.message : String(err),
  };
}

function clientConfig(env: WorkflowSkillsToolEnv) {
  return {
    hubSkillsUrl: env.hubSkillsUrl,
    sidecarToken: env.sidecarToken,
    runAddress: env.address,
  };
}

async function runSkillsList(
  env: WorkflowSkillsToolEnv,
  call: ToolCall,
): Promise<ToolResult> {
  try {
    const skills = await listSkills(clientConfig(env));
    return {
      callId: call.id,
      isError: false,
      content: JSON.stringify({ skills }),
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runSkillsSearch(
  env: WorkflowSkillsToolEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const query = call.arguments["query"];
  if (typeof query !== "string" || query === "") {
    return errorResult(call.id, new Error("skills_search requires a query"));
  }
  try {
    const skills = await searchSkills(clientConfig(env), query);
    return {
      callId: call.id,
      isError: false,
      content: JSON.stringify({ skills }),
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runSkillsLoad(
  env: WorkflowSkillsToolEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const name = call.arguments["name"];
  if (typeof name !== "string" || name === "") {
    return errorResult(call.id, new Error("skills_load requires a skill name"));
  }
  try {
    const skill = await loadSkill(clientConfig(env), name);
    return { callId: call.id, isError: false, content: JSON.stringify(skill) };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

export const skillsTools = defineTool<WorkflowSkillsToolEnv>({
  id: "@corbits/tools-skills/skills",
  requires: ["hubSkillsUrl", "sidecarToken", "address"],
  definitions: [
    { name: SKILLS_LIST_TOOL },
    { name: SKILLS_SEARCH_TOOL },
    { name: SKILLS_LOAD_TOOL },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: SKILLS_LIST_TOOL,
        description:
          "Lists every skill available in this workbench — name and " +
          "description only. Returns an error result naming the failure " +
          "when the registry is unreachable; that is never the same as " +
          "the workbench having no skills.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: SKILLS_SEARCH_TOOL,
        description:
          "Searches this workbench's skills by name and description. " +
          "Use it to find a skill for a task before deciding you must " +
          "improvise one.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to search for." },
          },
          required: ["query"],
        },
      },
      {
        name: SKILLS_LOAD_TOOL,
        description:
          "Reads one skill's full instructions by name. Call this " +
          "before following a skill listed in <available_skills> — the " +
          "index carries only a description, never the instructions " +
          "themselves.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The skill's name, exactly as listed.",
            },
          },
          required: ["name"],
        },
      },
    ],
    run: (call: ToolCall, _signal: AbortSignal) => {
      switch (call.name) {
        case SKILLS_LIST_TOOL:
          return runSkillsList(env, call);
        case SKILLS_SEARCH_TOOL:
          return runSkillsSearch(env, call);
        case SKILLS_LOAD_TOOL:
          return runSkillsLoad(env, call);
        default:
          return Promise.resolve(
            errorResult(
              call.id,
              new Error(`@corbits/tools-skills: unknown tool "${call.name}"`),
            ),
          );
      }
    },
  }),
});
