import { type } from "arktype";
import { describe, expect, test } from "bun:test";

import {
  CONNECTOR_REGISTRY,
  MCP_PRESETS,
} from "@workbench/templates/connectors";

import {
  deliveryWorkbenchRequiredForWorkflowName,
  isAutomatableWorkflowName,
  isConversationalWorkflowName,
  validateTriggerFieldsAtCreate,
  workflowDisplayName,
  workflowCatalogEntry,
  WorkflowTriggerField,
  WORKFLOW_CATALOG,
} from "./catalog";

describe("workflow catalog", () => {
  test("marks workbench-digest, heartbeat, and morning-brief automatable, not echo or assistant", () => {
    expect(isAutomatableWorkflowName("workbench-digest")).toBe(true);
    expect(isAutomatableWorkflowName("heartbeat")).toBe(true);
    expect(isAutomatableWorkflowName("morning-brief")).toBe(true);
    expect(isAutomatableWorkflowName("echo")).toBe(false);
    expect(isAutomatableWorkflowName("assistant")).toBe(false);
  });

  test("marks the granola-call parent automatable, not its process-granola-call child", () => {
    // The parent is schedule-attachable; the child is spawned per call and
    // must never appear as an independent Routines-picker option.
    expect(isAutomatableWorkflowName("granola-call")).toBe(true);
    expect(isAutomatableWorkflowName("process-granola-call")).toBe(false);
  });

  test("prefers the catalog display name for the granola-call workflows", () => {
    expect(workflowDisplayName("granola-call")).toBe("Granola call notes");
    expect(workflowDisplayName("process-granola-call")).toBe(
      "Process Granola call",
    );
  });

  test("does not mark pain-point-collateral automatable — its approval gate is a poor fit for unattended scheduling", () => {
    expect(isAutomatableWorkflowName("pain-point-collateral")).toBe(false);
    expect(workflowDisplayName("pain-point-collateral")).toBe(
      "Pain-point collateral",
    );
  });

  test("does not mark collateral-generation automatable — on-demand only, gated behind its final approval", () => {
    expect(isAutomatableWorkflowName("collateral-generation")).toBe(false);
    expect(workflowDisplayName("collateral-generation")).toBe(
      "Collateral generation",
    );
  });

  test("marks reddit-opportunity-scanner on-demand — its approval gates make it a poor unattended fit", () => {
    expect(isAutomatableWorkflowName("reddit-opportunity-scanner")).toBe(false);
    expect(workflowDisplayName("reddit-opportunity-scanner")).toBe(
      "Reddit opportunity scanner",
    );
  });

  test("does not mark last-30-days-research automatable — on-demand only, gated behind a human-supplied topic per run", () => {
    expect(isAutomatableWorkflowName("last-30-days-research")).toBe(false);
    expect(workflowDisplayName("last-30-days-research")).toBe(
      "Last 30 days research report",
    );
  });

  test("rejects agent handles and workbench-host names as automatable", () => {
    expect(isAutomatableWorkflowName("my-researcher")).toBe(false);
    expect(isAutomatableWorkflowName("workbench-host-abc")).toBe(false);
    expect(isAutomatableWorkflowName("wfd_deadbeef")).toBe(false);
  });

  test("prefers catalog display names over raw asset names", () => {
    expect(workflowDisplayName("workbench-digest")).toBe("Workbench digest");
    expect(workflowDisplayName("heartbeat")).toBe("Heartbeat");
    expect(workflowDisplayName("morning-brief")).toBe("Morning brief");
    expect(workflowDisplayName("echo")).toBe("Echo");
    expect(workflowDisplayName("assistant")).toBe("Myra");
  });

  test("productizes the seeded assistant under the Myra display name", () => {
    // The assistant workflow ships in DEFAULT_WORKFLOWS for every personal
    // bench. Its catalog display name is the productized label Myra, not
    // the generic "Assistant" — the routines picker and seeded asset both
    // read it from here.
    expect(workflowDisplayName("assistant")).toBe("Myra");
    const entry = WORKFLOW_CATALOG.find((e) => e.assetName === "assistant");
    expect(entry?.displayName).toBe("Myra");
  });

  test("falls back to description, then humanized name — never blank", () => {
    expect(workflowDisplayName("unknown-flow", "  Weekly brief  ")).toBe(
      "Weekly brief",
    );
    expect(workflowDisplayName("last-30-days")).toBe("Last 30 Days");
  });

  describe("isConversationalWorkflowName", () => {
    test("marks only the seeded assistant/Myra definition conversational", () => {
      expect(isConversationalWorkflowName("assistant")).toBe(true);
    });

    test("marks every workflow utility, automatable or not, non-conversational", () => {
      expect(isConversationalWorkflowName("echo")).toBe(false);
      expect(isConversationalWorkflowName("workbench-digest")).toBe(false);
      expect(isConversationalWorkflowName("last-30-days-research")).toBe(false);
      expect(isConversationalWorkflowName("heartbeat")).toBe(false);
      expect(isConversationalWorkflowName("process-granola-call")).toBe(false);
    });

    test("treats a name absent from the catalog as conversational — a runtime agent-directory definition", () => {
      expect(isConversationalWorkflowName("my-researcher")).toBe(true);
      expect(isConversationalWorkflowName("wfd_deadbeef")).toBe(true);
    });

    // CL-6649: `echo` and `last-30-days-research` are both non-automatable
    // AND non-conversational — the exact combination that let a picker
    // gated on `!isAutomatableWorkflowName` alone (rather than
    // `isConversationalWorkflowName`) mistake a routine's delivery
    // workflow, and the Echo wiring check, for an invitable chat agent.
    test("a non-automatable utility is still non-conversational (the CL-6649 trap)", () => {
      for (const name of ["echo", "last-30-days-research"]) {
        expect(isAutomatableWorkflowName(name)).toBe(false);
        expect(isConversationalWorkflowName(name)).toBe(false);
      }
    });

    test("every catalog entry declares a conversational flag", () => {
      for (const entry of WORKFLOW_CATALOG) {
        expect(typeof entry.conversational).toBe("boolean");
      }
    });
  });

  test("every catalog entry has a non-empty display name", () => {
    for (const entry of WORKFLOW_CATALOG) {
      expect(entry.displayName.trim().length).toBeGreaterThan(0);
      expect(entry.assetName).toMatch(/^[a-z0-9-]+$/);
    }
  });

  describe("deliveryMode", () => {
    test("every catalog entry declares a delivery mode", () => {
      for (const entry of WORKFLOW_CATALOG) {
        expect(["workbench", "inbox"]).toContain(entry.deliveryMode);
      }
    });

    test("no catalog entry currently delivers to inbox", () => {
      const inboxEntries = WORKFLOW_CATALOG.filter(
        (entry) => entry.deliveryMode === "inbox",
      );
      expect(inboxEntries).toEqual([]);
    });

    test("deliveryWorkbenchRequiredForWorkflowName is true for every known catalog entry", () => {
      for (const entry of WORKFLOW_CATALOG) {
        expect(deliveryWorkbenchRequiredForWorkflowName(entry.assetName)).toBe(
          true,
        );
      }
    });

    test("an unknown workflow name defaults to workbench-required", () => {
      expect(deliveryWorkbenchRequiredForWorkflowName("unknown-workflow")).toBe(
        true,
      );
    });
  });

  test("every catalog entry carries honest demo-card copy", () => {
    for (const entry of WORKFLOW_CATALOG) {
      expect(entry.whatItDoes.trim().length).toBeGreaterThan(0);
      expect(entry.exampleOutput.trim().length).toBeGreaterThan(0);
      expect(entry.typicalDuration.trim().length).toBeGreaterThan(0);
      // No fake precision or invented metrics dressed up as facts.
      expect(entry.whatItDoes).not.toMatch(/%|\$\d/);
    }
  });

  test("every exampleOutput is a single capitalized readout fragment with no trailing period", () => {
    for (const entry of WORKFLOW_CATALOG) {
      expect(entry.exampleOutput).not.toContain("\n");
      expect(entry.exampleOutput.endsWith(".")).toBe(false);
      expect(entry.exampleOutput[0]).toBe(
        entry.exampleOutput[0]?.toUpperCase(),
      );
    }
  });

  test("every requiredConnections id names a connector a person can actually connect", () => {
    // Either a native connector (its own credential plugin and tool
    // package) or an MCP preset a person connects under Plugins — Attio
    // is only ever the latter here, reached through `@corbits/mcp-tools`.
    const connectable = new Set([
      ...Object.keys(CONNECTOR_REGISTRY),
      ...MCP_PRESETS.map((preset) => preset.slug),
    ]);
    for (const entry of WORKFLOW_CATALOG) {
      for (const connectorId of entry.requiredConnections) {
        expect(connectable.has(connectorId)).toBe(true);
      }
    }
  });

  test("pins the GTM ports to the connectors their tool packages actually need", () => {
    const byAssetName = new Map(
      WORKFLOW_CATALOG.map((entry) => [entry.assetName, entry]),
    );
    expect(byAssetName.get("granola-call")?.requiredConnections).toEqual([
      "granola",
    ]);
    expect(
      byAssetName.get("process-granola-call")?.requiredConnections,
    ).toEqual(["granola"]);
    expect(byAssetName.get("morning-brief")?.requiredConnections).toEqual([
      "granola",
      "linear",
    ]);
    expect(
      byAssetName.get("pain-point-collateral")?.requiredConnections,
    ).toEqual(["granola"]);
    expect(
      byAssetName.get("collateral-generation")?.requiredConnections,
    ).toEqual(["granola", "linear"]);
    expect(
      byAssetName.get("reddit-opportunity-scanner")?.requiredConnections,
    ).toEqual(["scrapecreators"]);
    expect(
      byAssetName.get("last-30-days-research")?.requiredConnections,
    ).toEqual(["exa"]);
  });

  test("workflows with no external connector requirement declare an empty list", () => {
    const byAssetName = new Map(
      WORKFLOW_CATALOG.map((entry) => [entry.assetName, entry]),
    );
    expect(byAssetName.get("echo")?.requiredConnections).toEqual([]);
    expect(byAssetName.get("assistant")?.requiredConnections).toEqual([]);
    expect(byAssetName.get("heartbeat")?.requiredConnections).toEqual([]);
    expect(byAssetName.get("workbench-digest")?.requiredConnections).toEqual(
      [],
    );
  });

  describe("triggerFields", () => {
    test("every declared triggerFields entry matches the WorkflowTriggerField shape", () => {
      for (const entry of WORKFLOW_CATALOG) {
        if (entry.triggerFields === undefined) continue;
        const parsed = WorkflowTriggerField.array()(entry.triggerFields);
        expect(parsed instanceof type.errors).toBe(false);
      }
    });

    test("every triggerFields key is unique within its entry and non-blank labeled", () => {
      for (const entry of WORKFLOW_CATALOG) {
        if (entry.triggerFields === undefined) continue;
        const keys = entry.triggerFields.map((field) => field.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const field of entry.triggerFields) {
          expect(field.label.trim().length).toBeGreaterThan(0);
        }
      }
    });

    test("last-30-days-research declares a required topic and an optional focus", () => {
      const entry = workflowCatalogEntry("last-30-days-research");
      expect(entry?.triggerFields).toEqual([
        {
          key: "topic",
          kind: "text",
          label: "Topic",
          placeholder: "AI coding agents",
          required: true,
          help: "What to research over the last 30 days.",
        },
        {
          key: "focus",
          kind: "text",
          label: "Focus",
          placeholder: "Competing launches",
          required: false,
          help: "Optional — narrows which angle of the topic to chase.",
        },
      ]);
    });

    test("pain-point-collateral declares its either/or transcript and noteId as optional", () => {
      // Neither field is required on its own — the workflow's intake tool
      // accepts either one (or neither, and teaches what to send next); see
      // workflows/pain-point-collateral/src/intake-tool.ts's IntakeArgs.
      const entry = workflowCatalogEntry("pain-point-collateral");
      expect(entry?.triggerFields?.map((f) => f.key)).toEqual([
        "transcript",
        "noteId",
      ]);
      for (const field of entry?.triggerFields ?? []) {
        expect(field.required).toBe(false);
      }
    });

    test("workflows with no named trigger inputs declare no triggerFields", () => {
      // Heartbeat and workbench-digest take no human-supplied content at
      // create time — heartbeat ignores its trigger entirely, and
      // workbench-digest's content is computed server-side by the scheduler,
      // not typed in by a person.
      expect(workflowCatalogEntry("heartbeat")?.triggerFields).toBeUndefined();
      expect(
        workflowCatalogEntry("workbench-digest")?.triggerFields,
      ).toBeUndefined();
    });
  });

  // Two required fields, one "agent"-kind and one "text"-kind — an
  // explicit local fixture, not pulled from any catalog entry, so this
  // block's assertions about required/blank/non-string handling stay
  // meaningful regardless of which entries the catalog happens to carry.
  const AGENT_AND_PROMPT_FIELDS: readonly WorkflowTriggerField[] = [
    { key: "agent", kind: "agent", label: "Agent", required: true },
    { key: "prompt", kind: "text", label: "Prompt", required: true },
  ];

  // CL-6358: inputs bind at USE, never at creation — a scheduled
  // definition (or a seed preset) must be creatable with a required
  // trigger field left entirely unbound. `validateTriggerFieldsAtCreate`
  // is the boundary check the schedule create path applies now:
  // absence of a required field is never rejected, only a value the
  // caller explicitly provided but left malformed is.
  describe("validateTriggerFieldsAtCreate", () => {
    const fields = AGENT_AND_PROMPT_FIELDS;

    test("a required field left entirely unbound passes at create time", () => {
      expect(
        validateTriggerFieldsAtCreate(fields, { prompt: "Do it" }),
      ).toEqual({ ok: true });
    });

    test("last-30-days-research seeds with Topic unbound", () => {
      const researchFields = workflowCatalogEntry("last-30-days-research")
        ?.triggerFields as readonly WorkflowTriggerField[];
      expect(validateTriggerFieldsAtCreate(researchFields, {})).toEqual({
        ok: true,
      });
    });

    test("a provided-but-blank required field still fails: a caller who sets it must set it honestly", () => {
      const result = validateTriggerFieldsAtCreate(fields, {
        agent: "   ",
        prompt: "Do it",
      });
      expect(result.ok).toBe(false);
    });

    test("a provided non-string value for a required field still fails", () => {
      const result = validateTriggerFieldsAtCreate(fields, {
        agent: 12345,
        prompt: "Do it",
      });
      expect(result.ok).toBe(false);
    });

    test("a fully valid input still passes", () => {
      expect(
        validateTriggerFieldsAtCreate(fields, {
          agent: "wfd_1",
          prompt: "Do it",
        }),
      ).toEqual({ ok: true });
    });
  });
});
