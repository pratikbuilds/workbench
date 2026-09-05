// Regression for CL-6334: `SKILLS_TOOL_PACKAGE_PIN` named
// `@corbits/tools-skills`, but `tool-registry-publish`'s
// `CORBITS_TOOL_PACKAGE_DIRS` never listed that package's directory, so
// a definition pinning skills carried a pin the corbits-tools registry
// could never resolve at launch.
import { describe, expect, test } from "bun:test";
import type { DB } from "@intx/db";
import type { AssetService } from "@intx/hub-sessions";
import { describeCorbitsToolPackages } from "@corbits/tool-registry-publish";
import {
  buildAgentDefinitionWorkflow,
  createAgentDefinitionCore,
  serializeAgentDefinitionWorkflow,
  SKILLS_TOOL_PACKAGE_PIN,
  withAgentToolPackagePin,
} from "./agent-workflow";
import { createInMemoryDefinitionSkillsStore } from "./skills-store";

describe("SKILLS_TOOL_PACKAGE_PIN", () => {
  test("resolves through the corbits-tools registry", async () => {
    const descriptions = await describeCorbitsToolPackages();
    const match = descriptions.find(
      (description) => description.name === SKILLS_TOOL_PACKAGE_PIN.name,
    );
    expect(match).toBeDefined();
    expect(match?.version).toBe(SKILLS_TOOL_PACKAGE_PIN.version);
  });
});

// CL-7389: a runtime tool-package pin must resolve to a concrete,
// published version — never the npm "any version" range `*` — so a
// later tarball landing in the registry never silently changes what an
// already-deployed specialist runs.
describe("withAgentToolPackagePin", () => {
  function freshWorkflowJson(): string {
    return serializeAgentDefinitionWorkflow(
      buildAgentDefinitionWorkflow({
        handle: "pin-test",
        tenantDomain: "example.test",
        description: "",
        systemPrompt: "You are a test agent.",
      }),
    );
  }

  test("rejects a wildcard version", () => {
    expect(() =>
      withAgentToolPackagePin(freshWorkflowJson(), {
        name: "@corbits/memory-tools",
        version: "*",
      }),
    ).toThrow(/never "\*"/);
  });

  test.each(["latest", "^1", "~1.2", "", ">=1.0.0", "1.x"])(
    "rejects a non-exact version %p",
    (version) => {
      expect(() =>
        withAgentToolPackagePin(freshWorkflowJson(), {
          name: "@corbits/memory-tools",
          version,
        }),
      ).toThrow();
    },
  );

  test("accepts a concrete version", () => {
    const nextWorkflowJson = withAgentToolPackagePin(freshWorkflowJson(), {
      name: "@corbits/memory-tools",
      version: "1.2.3",
    });
    const definition = JSON.parse(nextWorkflowJson) as {
      steps: Record<
        string,
        { agent: { toolPackagePins?: { name: string; version: string }[] } }
      >;
    };
    const [step] = Object.values(definition.steps);
    expect(step?.agent.toolPackagePins).toContainEqual({
      name: "@corbits/memory-tools",
      version: "1.2.3",
    });
  });
});

// CL-7389: a `create_agent`/`POST /agent-definitions` call pinning several
// tool packages by name shares one registry resolver across all of them
// (`createPinnedVersionResolver`), so it costs one ancestor walk and one
// tarball listing, never one per pin.
describe("createAgentDefinitionCore: shared registry resolution across pins", () => {
  test("a five-pin create does one tenant lookup, one asset lookup, and one tarball listing", async () => {
    const counters = { tenant: 0, asset: 0, list: 0 };
    const db = {
      query: {
        tenant: {
          findFirst: async () => {
            counters.tenant++;
            return { parentId: null };
          },
        },
        asset: {
          findFirst: async () => {
            counters.asset++;
            return {
              id: "ast_corbits_tools",
              tenantId: "tnt_1",
              kind: "package-registry" as const,
              name: "corbits-tools",
            };
          },
        },
        workflowDefinition: {
          findFirst: async () => ({
            id: "def_1",
            tenantId: "tnt_1",
            assetId: "ast_1",
            name: "scout",
            description: null,
            currentVersion: "1",
            status: "deployed",
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        },
      },
    } as unknown as DB["db"];
    const assetService: AssetService = {
      createAsset: () =>
        Promise.resolve({
          id: "ast_1",
          tenantId: "tnt_1",
          kind: "workflow" as const,
          name: "scout",
          displayName: "Scout",
          creatorPrincipalId: "prn_1",
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      populateAsset: () => Promise.resolve({ commitSha: "deadbeef" }),
      readAssetBlob: () => {
        throw new Error("not used");
      },
      listAssetBlobs: () => {
        counters.list++;
        return Promise.resolve([
          "corbits-a-tools-1.0.0.tgz",
          "corbits-b-tools-1.0.0.tgz",
          "corbits-c-tools-1.0.0.tgz",
          "corbits-d-tools-1.0.0.tgz",
          "corbits-e-tools-1.0.0.tgz",
        ]);
      },
    };
    await createAgentDefinitionCore(
      {
        db,
        assetService,
        skillIndex: { resolve: () => Promise.resolve([]) },
        skillsStore: createInMemoryDefinitionSkillsStore(),
        deployer: {
          deploy: () =>
            Promise.resolve({
              deploymentId: "dep_1",
              definitionAssetId: "ast_1",
              status: "deployed" as const,
            }),
        },
      },
      {
        tenantId: "tnt_1",
        principalId: "prn_1",
        tenantDomain: "acme.example",
        handle: "scout",
        name: "Scout",
        systemPrompt: "You are Scout.",
        skills: [],
        toolPackagePins: [
          "@corbits/a-tools",
          "@corbits/b-tools",
          "@corbits/c-tools",
          "@corbits/d-tools",
          "@corbits/e-tools",
        ],
      },
    );
    expect(counters.list).toBe(1);
    expect(counters.asset).toBe(1);
    expect(counters.tenant).toBe(1);
  });
});
