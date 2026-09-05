// The hub composition root must serve the package draft routes (CL-6749)
// rather than a local `{ code, message }` 422 the client cannot parse.

import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";

test("hub mounts package draft routes rather than a local {code, message} 422", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  expect(source).toContain("createAgentDefinitionDraftRoutes");
  expect(source).not.toMatch(/code:\s*"drafting_failed"/);
});
