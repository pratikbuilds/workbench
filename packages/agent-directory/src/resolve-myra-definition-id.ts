// Resolves Myra's own workflow-definition id for a tenant — the one
// piece of DB wiring every one-shot Myra caller in this codebase needs
// (this package's own `agent-definition-drafting.ts`), each of which
// takes it as an injected `resolveMyraDefinitionId` port rather than
// importing this module directly, so a test can stub it without
// touching a database.
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { workflowDefinition } from "@intx/db/schema";
import { WORKFLOW_CATALOG } from "@workbench/templates";

/** Myra's asset name in the seeded workflow catalog — the same lookup
 * `apps/web/src/myra-workbench.ts` does client-side, mirrored here for
 * the hub side. */
const MYRA_ASSET_NAME = WORKFLOW_CATALOG.find(
  (entry) => entry.displayName === "Myra",
)?.assetName;

export class MyraDefinitionUnresolvableError extends Error {
  constructor(tenantId: string, reason: string) {
    super(`Myra isn't available for tenant "${tenantId}": ${reason}`);
    this.name = "MyraDefinitionUnresolvableError";
  }
}

/**
 * Queries `workflowDefinition` by Myra's seeded asset name and
 * `tenantId` — there is no "current tenant's Myra" foreign key
 * anywhere else to join through.
 */
export async function resolveMyraDefinitionIdFromDb(
  db: DB["db"],
  tenantId: string,
): Promise<string> {
  if (MYRA_ASSET_NAME === undefined) {
    throw new MyraDefinitionUnresolvableError(
      tenantId,
      'the workflow catalog has no entry displayed as "Myra"',
    );
  }
  const row = await db.query.workflowDefinition.findFirst({
    where: and(
      eq(workflowDefinition.name, MYRA_ASSET_NAME),
      eq(workflowDefinition.tenantId, tenantId),
    ),
  });
  if (row === undefined || row.status !== "deployed" || row.assetId === null) {
    throw new MyraDefinitionUnresolvableError(
      tenantId,
      "no deployed Myra definition was found",
    );
  }
  return row.id;
}
