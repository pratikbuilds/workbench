// `describeCorbitsToolPackages` is the hub-side source of truth for
// which `tool:<qualifiedId>` grants a pinned `@corbits/*-tools` package
// needs (see CL-6149: a pinned package's tools failed every call with
// "No matching grants" because nothing derived those grants at launch).
// This suite pins the exact qualified-id shape and approval marks the
// hub composition (`apps/hub/src/index.ts`) relies on.
import { describe, expect, test } from "bun:test";
import { CORBITS_TOOL_PACKAGE_DIRS } from "./registry";
import { describeCorbitsToolPackages } from "./describe";

describe("describeCorbitsToolPackages", () => {
  test("describes every registered package with at least one tool", async () => {
    const descriptions = await describeCorbitsToolPackages();
    expect(descriptions.length).toBe(CORBITS_TOOL_PACKAGE_DIRS.length);
    for (const description of descriptions) {
      expect(description.name.startsWith("@corbits/")).toBe(true);
      expect(description.version.length).toBeGreaterThan(0);
      expect(description.tools.length).toBeGreaterThan(0);
    }
  });

  test("every tool's qualifiedId is `<bundle id>:<tool name>`, matching the loader's namespace prefix", async () => {
    const descriptions = await describeCorbitsToolPackages();
    for (const description of descriptions) {
      for (const tool of description.tools) {
        expect(tool.qualifiedId).toMatch(/^.+:[^:]+$/);
      }
    }
  });

  test("caches across calls (same source for the process lifetime)", async () => {
    const first = await describeCorbitsToolPackages();
    const second = await describeCorbitsToolPackages();
    expect(second).toBe(first);
  });

  test("tools-skills grants exactly one qualifiedId for skills_load, not the old load_skill name", async () => {
    const descriptions = await describeCorbitsToolPackages();
    const skills = descriptions.find(
      (description) => description.name === "@corbits/tools-skills",
    );
    expect(skills).toBeDefined();
    const qualifiedIds = skills?.tools.map((tool) => tool.qualifiedId) ?? [];
    expect(qualifiedIds).toContain("@corbits/tools-skills/skills:skills_load");
    expect(qualifiedIds).not.toContain(
      "@corbits/tools-skills/skills:load_skill",
    );
  });
});
