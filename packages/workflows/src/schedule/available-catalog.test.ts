import { describe, expect, test } from "bun:test";

import { availableCatalogWorkflowsFrom } from "./available-catalog";

describe("availableCatalogWorkflowsFrom", () => {
  test("excludes a catalog name that already has a deployed definition", () => {
    const result = availableCatalogWorkflowsFrom({
      catalogAssetNames: ["echo", "code-review"],
      deployedNames: new Set(["echo"]),
      isConnectorSatisfied: () => true,
    });
    expect(result.map((r) => r.assetName)).toEqual(["code-review"]);
  });

  test("skips a catalog name with no WORKFLOW_CATALOG entry rather than throwing", () => {
    const result = availableCatalogWorkflowsFrom({
      catalogAssetNames: ["not-a-real-workflow"],
      deployedNames: new Set(),
      isConnectorSatisfied: () => true,
    });
    expect(result).toEqual([]);
  });

  test("a workflow with no required connections is always satisfied", () => {
    const result = availableCatalogWorkflowsFrom({
      catalogAssetNames: ["echo"],
      deployedNames: new Set(),
      isConnectorSatisfied: () => false,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.requiredConnections).toEqual([]);
    expect(result[0]?.missingConnections).toEqual([]);
    expect(result[0]?.connectionsSatisfied).toBe(true);
  });

  test("a workflow whose required connection is not satisfied names it as missing", () => {
    const result = availableCatalogWorkflowsFrom({
      catalogAssetNames: ["code-review"],
      deployedNames: new Set(),
      isConnectorSatisfied: () => false,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.requiredConnections).toEqual(["github"]);
    expect(result[0]?.missingConnections).toEqual(["github"]);
    expect(result[0]?.connectionsSatisfied).toBe(false);
  });

  test("a workflow whose required connection is satisfied carries no missing connections", () => {
    const result = availableCatalogWorkflowsFrom({
      catalogAssetNames: ["code-review"],
      deployedNames: new Set(),
      isConnectorSatisfied: (id) => id === "github",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.missingConnections).toEqual([]);
    expect(result[0]?.connectionsSatisfied).toBe(true);
  });

  test("defaults every entry to deployable when no pin check is given", () => {
    const result = availableCatalogWorkflowsFrom({
      catalogAssetNames: ["echo"],
      deployedNames: new Set(),
      isConnectorSatisfied: () => true,
    });
    expect(result[0]?.deployable).toBe(true);
    expect(result[0]?.notDeployableReason).toBeUndefined();
  });

  test("marks an entry not deployable with a machine reason when the pin check says no", () => {
    const result = availableCatalogWorkflowsFrom({
      catalogAssetNames: ["code-review"],
      deployedNames: new Set(),
      isConnectorSatisfied: () => true,
      isDeployableOnThisPin: () => false,
    });
    expect(result[0]?.deployable).toBe(false);
    expect(result[0]?.notDeployableReason).toBe(
      "credential_bindings_unsupported",
    );
  });

  test("carries the display name and description straight from WORKFLOW_CATALOG", () => {
    const result = availableCatalogWorkflowsFrom({
      catalogAssetNames: ["echo"],
      deployedNames: new Set(),
      isConnectorSatisfied: () => true,
    });
    expect(result[0]?.displayName.length).toBeGreaterThan(0);
    expect(result[0]?.description.length).toBeGreaterThan(0);
  });
});
