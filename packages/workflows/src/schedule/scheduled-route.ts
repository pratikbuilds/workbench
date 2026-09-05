// GET /api/tenants/:tenantId/workflows/scheduled — authored definitions
// whose frozen projection has a ScheduleTrigger, including `stopped`.
// POST /scheduled/:definitionId/run — fire that definition now.
// GET /api/tenants/:tenantId/workflows/available — this bench's sibling
// list (CL-7073): every catalog workflow with no deployed definition of
// that asset name yet, so the Routines page can offer it with an Add
// action.
import { Hono } from "hono";
import type { DB } from "@intx/db";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import {
  listScheduledWorkflowDefinitions,
  type ScheduledWorkflowDefinition,
} from "./list-scheduled";
import {
  listAvailableCatalogWorkflows,
  type AvailableCatalogWorkflow,
} from "./available-catalog";

export const RUN_NOW_CONTENT = "Run now.";

export type RunScheduledDefinition = (args: {
  tenantId: string;
  definitionId: string;
  principalId: string;
  fromDomain: string;
  content: string;
  name: string;
  assetId: string;
}) => Promise<{ runId: string }>;

export type CreateScheduledWorkflowRoutesDeps = {
  db: DB["db"];
  requireGrant: RequireGrant;
  runNow: RunScheduledDefinition;
  listScheduled?: (
    db: DB["db"],
    tenantId: string,
  ) => Promise<readonly ScheduledWorkflowDefinition[]>;
  /** Every asset name deployable through the catalog instantiate route —
   * `@corbits/seeding`'s `CATALOG_WORKFLOWS`, by asset name. Passed in by
   * the caller (`apps/hub`) rather than imported here: `@corbits/seeding`
   * already depends on this package, so importing it back would cycle. */
  catalogAssetNames?: readonly string[];
  /** `@corbits/seeding`'s `catalogWorkflowDeployableOnThisPin`, passed in
   * rather than imported here for the same reason `catalogAssetNames`
   * is: `@corbits/seeding` already depends on this package. Defaults to
   * "everything is deployable" so a caller that never wires this in
   * (a test double, an older caller) keeps its prior behavior. */
  catalogWorkflowDeployable?: (assetName: string) => boolean;
  listAvailable?: (
    db: DB["db"],
    tenantId: string,
    catalogAssetNames: readonly string[],
  ) => Promise<readonly AvailableCatalogWorkflow[]>;
};

export function createScheduledWorkflowRoutes({
  db,
  requireGrant,
  runNow,
  listScheduled = listScheduledWorkflowDefinitions,
  catalogAssetNames = [],
  catalogWorkflowDeployable,
  listAvailable = (dbHandle, tenantId, names) =>
    listAvailableCatalogWorkflows({
      db: dbHandle,
      tenantId,
      catalogAssetNames: names,
      ...(catalogWorkflowDeployable !== undefined
        ? { isDeployableOnThisPin: catalogWorkflowDeployable }
        : {}),
    }),
}: CreateScheduledWorkflowRoutesDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get("/available", requireGrant("workflow:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const items = await listAvailable(db, tenant.id, catalogAssetNames);
    return c.json({ items });
  });

  app.get(
    "/scheduled",
    requireGrant("workflow-definition:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const items = await listScheduled(db, tenant.id);
      return c.json({
        items: items.map((item) => ({
          definitionId: item.definitionId,
          assetId: item.assetId,
          name: item.name,
          tenantId: item.tenantId,
          status: item.status,
          cron: item.cron,
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        })),
      });
    },
  );

  app.post(
    "/scheduled/:definitionId/run",
    requireGrant("workflow-run:*", "create"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const definitionId = c.req.param("definitionId");
      const items = await listScheduled(db, tenant.id);
      const found = items.find((item) => item.definitionId === definitionId);
      if (found === undefined) {
        return c.json(
          {
            error: {
              code: "not_found",
              message: "Scheduled workflow not found",
            },
          },
          404,
        );
      }
      const { runId } = await runNow({
        tenantId: tenant.id,
        definitionId,
        principalId: principal.id,
        fromDomain: tenant.domain,
        content: RUN_NOW_CONTENT,
        name: found.name,
        assetId: found.assetId,
      });
      return c.json({ runId });
    },
  );

  return app;
}
