// Plays an `EvalDefinition` against a `Target`, step by step, running
// each step's scorers against the transcript recorded so far. Pure
// orchestration — the target owns every side effect (sending a turn,
// observing tool calls); this module never talks to a hub directly,
// which is what makes it testable against a fake target with no real
// stack booted (see runner.test.ts).
import { runPersonaStep } from "./persona-runner.ts";
import type {
  EvalDefinition,
  EvalRunResult,
  EvalStep,
  EvalStepRecord,
  ScorerReport,
  Target,
  Turn,
  WorldSnapshot,
} from "./types.ts";

function emptyWorldSnapshot(): WorldSnapshot {
  return {
    capturedAt: new Date().toISOString(),
    agentDefinitions: [],
    connections: [],
    webhookTriggers: [],
    fakeReceipts: [],
  };
}

async function playStep(
  step: EvalStep,
  target: Target,
  personaCall?: (prompt: string) => Promise<{ text: string }>,
): Promise<readonly Turn[]> {
  if (step.kind === "persona") {
    return runPersonaStep(step, target, personaCall);
  }
  if (step.kind === "install-template") {
    if (target.installTemplate === undefined) {
      throw new Error(
        `runEval: step installs template "${step.templateId}" but target ` +
          `"${target.configName}" has no installTemplate capability`,
      );
    }
    return [await target.installTemplate(step.templateId)];
  }
  if (step.kind === "fire-webhook") {
    if (target.fireWebhook === undefined) {
      throw new Error(
        `runEval: step fires a webhook but target "${target.configName}" ` +
          "has no fireWebhook capability",
      );
    }
    const world = (await target.snapshotWorld?.()) ?? emptyWorldSnapshot();
    const trigger = world.webhookTriggers.find((row) => row.enabled);
    if (trigger === undefined) {
      // The honest record of the miss, graded red by the step's own
      // scorers — never a crash that hides every later step, and never
      // a pretend delivery.
      return [
        {
          human: "(harness) fire webhook",
          replyText:
            "no enabled webhook_trigger exists to fire — start-reviewing " +
            "never minted one (its repo listing and the /complete " +
            "credential prove still require a reachable GitHub REST API)",
          toolCalls: [],
        },
      ];
    }
    return [await target.fireWebhook(trigger.id, step.payload)];
  }
  return [await target.sendTurn(step.human)];
}

export async function runEval(
  evalDef: EvalDefinition,
  target: Target,
  personaCall?: (prompt: string) => Promise<{ text: string }>,
): Promise<EvalRunResult> {
  const startedAt = new Date().toISOString();
  const transcript: Turn[] = [];
  const steps: EvalStepRecord[] = [];

  for (const seed of evalDef.memorySeed ?? []) {
    const turn = await target.sendTurn(`Please remember: ${seed}`);
    transcript.push(turn);
  }

  for (const [stepIndex, step] of evalDef.steps.entries()) {
    const stepTurns = await playStep(step, target, personaCall);
    const turn = stepTurns[stepTurns.length - 1];
    if (turn === undefined) {
      throw new Error(`runEval: step ${String(stepIndex)} produced no turns`);
    }
    transcript.push(...stepTurns);
    const turnIndex = transcript.length - 1;
    const world = (await target.snapshotWorld?.()) ?? emptyWorldSnapshot();
    const scorerReports: ScorerReport[] = [];
    for (const scorer of step.expect) {
      const scorerResult = await scorer({ transcript, turnIndex, world });
      scorerReports.push({ ...scorerResult, stepIndex });
    }
    steps.push({ stepIndex, turn, scorerReports });
  }

  return {
    evalName: evalDef.name,
    configName: target.configName,
    startedAt,
    finishedAt: new Date().toISOString(),
    steps,
  };
}

/**
 * Runs every eval against a target built per matrix entry. `targetFor`
 * constructs and owns one `Target` per config (a live hub+sidecar
 * connection in production, a fake in tests) and is responsible for
 * `close()`ing anything it opens — `runMatrix` always closes the
 * target it received, even when a run throws, so a failed eval never
 * leaks a live connection.
 */
export async function runMatrix(
  evals: readonly EvalDefinition[],
  configs: readonly { name: string }[],
  targetFor: (configName: string) => Promise<Target>,
): Promise<EvalRunResult[]> {
  const results: EvalRunResult[] = [];
  for (const config of configs) {
    const target = await targetFor(config.name);
    try {
      for (const evalDef of evals) {
        results.push(await runEval(evalDef, target));
      }
    } finally {
      await target.close();
    }
  }
  return results;
}
