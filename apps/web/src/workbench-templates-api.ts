// Reads a workbench template's manifest from the bench library (CL-6344)
// — `instant-agent-create.ts` instantiates from this seeded row, never
// from a hardcoded `@workbench/templates` import. The read itself
// is what converges the shelf (CL-6458), so these routes answer for a
// bench of any age. The wire shape is the library's `{id, content}`
// entry; the content string re-enters through the catalog's own
// `WorkbenchDefinition` schema, so a corrupt or stale library row fails
// loud here rather than half-instantiating a workbench.

import { type } from "arktype";
import {
  parseWorkbenchDefinition,
  type WorkbenchDefinition,
} from "@workbench/templates";
import { ApiQueryError } from "@corbits/api-query";
import { parseErrorEnvelope } from "@corbits/error-sink";

const TemplateLibraryEntry = type({ id: "string > 0", content: "string > 0" });

/** What the picker offers rows from: the ids this bench's library can
 * actually serve, so a kind is never offered and then dead-ended on a
 * missing manifest at create time. */
export const TemplateLibraryPage = type({ data: TemplateLibraryEntry.array() });

const TemplateBlockDeployResponse = type({
  id: "string > 0",
  created: "boolean",
});

/**
 * Deploys one of a manifest's referenced block workflows through the
 * hub's source-form deploy (`POST /template-blocks/:assetName/deploy`,
 * CL-6405) — `instantiateWorkbenchTemplate`'s `deployBlockWorkflow`
 * port. `created: false` means the tenant already carried a deployed
 * definition under this asset name (a retried or second instantiation).
 */
export async function deployWorkbenchTemplateBlock(
  tenantId: string,
  assetName: string,
): Promise<{ readonly created: boolean }> {
  const path = `/api/tenants/${tenantId}/template-blocks/${assetName}/deploy`;
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    throw new ApiQueryError(
      cause instanceof Error ? cause.message : String(cause),
      undefined,
      path,
    );
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const envelope = parseErrorEnvelope(json);
    throw new ApiQueryError(
      envelope?.error.userMessage ?? `The server answered ${response.status}.`,
      response.status,
      path,
      envelope?.error.refId,
    );
  }
  const parsed = TemplateBlockDeployResponse(json);
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(
      `Couldn't set that up — the answer didn't look right: ${parsed.summary}`,
      undefined,
      path,
    );
  }
  return { created: parsed.created };
}

/**
 * The seeded manifest for `templateId`, or null when the library has no
 * such entry (a bench whose boot seed hasn't run yet — the caller
 * decides whether that's fatal for the template being created).
 */
export async function fetchWorkbenchTemplateManifest(
  tenantId: string,
  templateId: string,
): Promise<WorkbenchDefinition | null> {
  const path = `/api/tenants/${tenantId}/library/templates/${templateId}`;
  let response: Response;
  try {
    response = await fetch(path, { headers: { accept: "application/json" } });
  } catch (cause) {
    throw new ApiQueryError(
      cause instanceof Error ? cause.message : String(cause),
      undefined,
      path,
    );
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new ApiQueryError(
      `The server answered ${response.status}.`,
      response.status,
      path,
    );
  }
  const entry = TemplateLibraryEntry(
    await response.json().catch(() => undefined),
  );
  if (entry instanceof type.errors) {
    throw new ApiQueryError(
      `Unexpected template entry shape: ${entry.summary}`,
      undefined,
      path,
    );
  }
  return parseWorkbenchDefinition(entry.content);
}
