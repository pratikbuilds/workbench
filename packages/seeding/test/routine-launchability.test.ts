// CL-6495 found that every routine "run now" (and every scheduled
// fire) launched through `@corbits/folded-runs`' `readFoldedBody` (via
// `apps/hub/src/routine-launcher.ts`), which has always required
// exactly one step — a multi-step `DEFAULT_WORKFLOWS` entry threw
// synchronously, uncaught, turning into a bare 500 on the very first
// launch attempt. That fix folded the one offending workflow back to a
// single step as a workaround.
//
// The routine launcher no longer hard-blocks a multi-step definition
// (`apps/hub/src/routine-launcher.ts` now routes it onto Interchange's
// native workflow-run trigger — see
// `apps/hub/src/native-workflow-routine-launch.ts`), so this test no
// longer asserts every entry is single-step; that would re-encode the
// exact restriction CL-6499 removed and block every future multi-step
// workflow forever. What still matters, for EVERY entry regardless of
// step count: it must actually be launchable — a well-formed step
// graph a launcher (folded or native) can run to completion, not a
// dangling reference nothing would ever execute.
import { expect, test } from "bun:test";

import {
  CATALOG_WORKFLOWS,
  DEFAULT_WORKFLOWS,
  type ModelSource,
} from "../src/seed";

const FAKE_MODEL: ModelSource = {
  provider: "ollama",
  model: "qwen-test",
  baseURL: "http://localhost:11434",
  apiKey: "test-key",
};

type SerializedStepDefinition = {
  readonly stepOrder: readonly string[];
  readonly steps: Readonly<Record<string, unknown>>;
};

test("every default and on-demand catalog workflow's deployed definition is a well-formed, launchable step graph", () => {
  for (const workflow of [...DEFAULT_WORKFLOWS, ...CATALOG_WORKFLOWS]) {
    const json = workflow.buildJson("example.test", [
      { provider: FAKE_MODEL.provider, model: FAKE_MODEL.model },
    ]);
    const definition = JSON.parse(json) as SerializedStepDefinition;

    expect(
      definition.stepOrder.length,
      `"${workflow.assetName}" deploys a definition with no steps at all`,
    ).toBeGreaterThan(0);

    // Every step named in `stepOrder` must actually be defined, and
    // vice versa — a step order that outruns its step map is exactly
    // the shape that would launch and silently stop partway through,
    // regardless of which launcher runs it.
    expect(
      new Set(Object.keys(definition.steps)),
      `"${workflow.assetName}"'s stepOrder and steps map disagree on which steps exist`,
    ).toEqual(new Set(definition.stepOrder));
  }
});
