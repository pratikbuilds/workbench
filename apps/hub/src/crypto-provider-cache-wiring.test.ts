// Pins CL-7284: createHub constructs one CryptoProviderCache and hands
// that same reference to every mail sender. A second constructor would
// still typecheck; this scan is the pin. crypto-cache.test.ts covers the
// Map; platform-adapter.test.ts covers chat injection only.
//
// CL-4455 removed the custom routine scheduler's `createHubRoutineLauncher`
// call site: a native ScheduleTrigger now fires through
// `triggerNativeWorkflowRoutineRun` (native-workflow-routine-launch.ts),
// which signs its trigger mail with a freshly generated per-call keypair
// rather than the shared cache — there is no longer a fourth mail-sender
// call site to pin here.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const HUB_DIR = path.join(import.meta.dir, "..");
const HUB_INDEX = path.join(import.meta.dir, "index.ts");

function productionTsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") return [];
      return productionTsFilesUnder(full);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [full]
      : [];
  });
}

/** The full `callee(...)` text of the first call in `source`. */
function firstCall(source: string, callee: string): string {
  const token = `${callee}(`;
  const start = source.indexOf(token);
  if (start < 0) {
    throw new Error(
      `expected ${callee}(...) in ${path.relative(HUB_DIR, HUB_INDEX)}`,
    );
  }
  let depth = 1;
  let i = start + token.length;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    i += 1;
  }
  return source.slice(start, i);
}

describe("hub crypto-provider cache wiring", () => {
  test("createHub constructs one cache and passes it to every mail sender", () => {
    const sites = productionTsFilesUnder(HUB_DIR).flatMap((file) => {
      const matches = readFileSync(file, "utf8").match(
        /createCryptoProviderCache\s*\(/g,
      );
      return matches === null ? [] : matches.map(() => file);
    });
    expect(sites).toEqual([HUB_INDEX]);

    const source = readFileSync(HUB_INDEX, "utf8");
    const assigned =
      /const\s+(\w+)\s*=\s*createCryptoProviderCache\s*\(\s*\)/.exec(
        source,
      )?.[1];
    if (assigned === undefined) {
      throw new Error(
        "createHub must assign createCryptoProviderCache() to a const",
      );
    }

    expect(firstCall(source, "createHubChatPlatform")).toContain(assigned);
    expect(firstCall(source, "launchWebhookTrigger")).toContain(
      `cryptoProviderCache: ${assigned}`,
    );
    expect(firstCall(source, "runOneShotFoldedPrompt")).toContain(assigned);
  });
});
