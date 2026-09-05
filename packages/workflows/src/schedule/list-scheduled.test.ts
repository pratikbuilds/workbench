import { describe, expect, test } from "bun:test";

import { scheduledDefinitionsFromRows } from "./list-scheduled";

const AT = new Date("2026-01-01T00:00:00.000Z");

const digestProjection = {
  id: "wf_digest",
  stepOrder: ["digest"],
  steps: { digest: { kind: "step" } },
  triggers: [{ type: "schedule", cron: "0 9 * * *" }],
};

const mailOnlyProjection = {
  id: "wf_mail",
  stepOrder: ["step"],
  steps: { step: { kind: "step" } },
  triggers: [{ type: "mail", to: "x@example.com" }],
};

describe("scheduledDefinitionsFromRows", () => {
  test("includes a stopped scheduled definition", () => {
    const listed = scheduledDefinitionsFromRows([
      {
        definitionId: "wfd_digest",
        tenantId: "tnt_1",
        assetId: "ast_1",
        name: "workbench-digest",
        status: "stopped",
        createdAt: AT,
        updatedAt: AT,
        wireProjection: digestProjection,
      },
    ]);
    expect(listed).toEqual([
      {
        definitionId: "wfd_digest",
        assetId: "ast_1",
        name: "workbench-digest",
        tenantId: "tnt_1",
        status: "stopped",
        cron: "0 9 * * *",
        createdAt: AT,
        updatedAt: AT,
      },
    ]);
  });

  test("includes a deployed scheduled definition", () => {
    const listed = scheduledDefinitionsFromRows([
      {
        definitionId: "wfd_digest",
        tenantId: "tnt_1",
        assetId: "ast_1",
        name: "workbench-digest",
        status: "deployed",
        createdAt: AT,
        updatedAt: AT,
        wireProjection: digestProjection,
      },
    ]);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("deployed");
  });

  test("drops a definition with no ScheduleTrigger", () => {
    expect(
      scheduledDefinitionsFromRows([
        {
          definitionId: "wfd_mail",
          tenantId: "tnt_1",
          assetId: "ast_2",
          name: "assistant",
          status: "deployed",
          createdAt: AT,
          updatedAt: AT,
          wireProjection: mailOnlyProjection,
        },
      ]),
    ).toEqual([]);
  });

  test("drops a row with no asset id", () => {
    expect(
      scheduledDefinitionsFromRows([
        {
          definitionId: "wfd_digest",
          tenantId: "tnt_1",
          assetId: null,
          name: "workbench-digest",
          status: "deployed",
          createdAt: AT,
          updatedAt: AT,
          wireProjection: digestProjection,
        },
      ]),
    ).toEqual([]);
  });
});
