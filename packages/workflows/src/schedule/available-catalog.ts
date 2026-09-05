// The Routines page's "Available" section (CL-7073): every catalog
// workflow (`@corbits/seeding`'s `CATALOG_WORKFLOWS` — injected here by
// asset name so this package never depends back on `@corbits/seeding`,
// which already depends on `@corbits/workflows`) that has no deployed
// definition of that asset name on the caller's bench yet, alongside
// this package's own `WORKFLOW_CATALOG` display metadata, whether the
// tenant already satisfies its required connections, and whether the
// entry can deploy at all on this Interchange pin.
//
// Connection satisfaction mirrors `@corbits/settings-ui`'s
// `connectorStatus` (same active-credential rule) but, like Plugins'
// own connector status and credential resolution, walks the tenant's
// ancestor chain (`@intx/db`'s `getAncestorChain`) rather than the exact
// tenant alone: a connector reads "satisfied" when the nearest ancestor
// (child shadows parent, same precedence `resolveProviderByName` uses)
// carrying a `provider` row named after the connector id either has no
// credential yet (nothing to fail) or its newest credential is `active`.
// An `expired`/`error`/`revoked` credential reads as unsatisfied, the
// same "needs attention" case `connectorStatus` reports. Every
// connector this tenant's catalog might need is resolved with exactly
// one `IN` query per table (`provider`, `credential`) rather than one
// round trip per connector.
import { and, desc, eq, inArray } from "drizzle-orm";
import { getAncestorChain, type DB } from "@intx/db";
import { credential, provider, workflowDefinition } from "@intx/db/schema";

import { workflowCatalogEntry } from "../catalog";

export type NotDeployableReason = "credential_bindings_unsupported";

export type AvailableCatalogWorkflow = {
  readonly assetName: string;
  readonly displayName: string;
  readonly description: string;
  readonly requiredConnections: readonly string[];
  readonly missingConnections: readonly string[];
  readonly connectionsSatisfied: boolean;
  /**
   * Whether this entry can deploy through
   * `POST /template-blocks/:assetName/deploy` on the current Interchange
   * pin. `false` for a catalog workflow whose definition carries
   * `credentialBindings` this pin's deploy front has no
   * `credentialCipher` seam to resolve (see
   * `catalogWorkflowDeployableOnThisPin`,
   * `docs/seed-reconciliation.md`) — closes at the Interchange re-pin
   * (CL-7107 / PR #632, pin 692c3106).
   */
  readonly deployable: boolean;
  readonly notDeployableReason?: NotDeployableReason;
};

/**
 * The read-only-of-a-database-round-trip core: given which asset names
 * are already deployed and synchronous "is this connector satisfied" /
 * "can this deploy on this pin" lookups, computes the available list.
 * Split out from `listAvailableCatalogWorkflows` so this — the actual
 * per-entry filtering and shaping logic — has a test that needs no
 * Postgres.
 */
export function availableCatalogWorkflowsFrom(args: {
  readonly catalogAssetNames: readonly string[];
  readonly deployedNames: ReadonlySet<string>;
  readonly isConnectorSatisfied: (connectorId: string) => boolean;
  readonly isDeployableOnThisPin?: (assetName: string) => boolean;
}): readonly AvailableCatalogWorkflow[] {
  const {
    catalogAssetNames,
    deployedNames,
    isConnectorSatisfied,
    isDeployableOnThisPin = () => true,
  } = args;
  const available: AvailableCatalogWorkflow[] = [];
  for (const assetName of catalogAssetNames) {
    if (deployedNames.has(assetName)) continue;
    const entry = workflowCatalogEntry(assetName);
    if (entry === undefined) continue;

    const missingConnections = entry.requiredConnections.filter(
      (connectorId) => !isConnectorSatisfied(connectorId),
    );
    const deployable = isDeployableOnThisPin(assetName);

    available.push({
      assetName,
      displayName: entry.displayName,
      description: entry.whatItDoes,
      requiredConnections: entry.requiredConnections,
      missingConnections,
      connectionsSatisfied: missingConnections.length === 0,
      deployable,
      ...(deployable
        ? {}
        : { notDeployableReason: "credential_bindings_unsupported" as const }),
    });
  }
  return available;
}

/**
 * Resolves every named connector's satisfaction for one tenant in exactly
 * one `provider` query and one `credential` query, walking the tenant's
 * ancestor chain (child shadows parent) the same way Plugins' own
 * connector status and credential resolution do — rather than one query
 * pair per connector.
 */
async function connectionSatisfactionByConnector(
  db: DB["db"],
  tenantId: string,
  connectorIds: ReadonlySet<string>,
): Promise<ReadonlyMap<string, boolean>> {
  const satisfaction = new Map<string, boolean>();
  if (connectorIds.size === 0) return satisfaction;

  const chain = await getAncestorChain(db, tenantId);
  const providerRows = await db.query.provider.findMany({
    where: and(
      inArray(provider.tenantId, chain),
      inArray(provider.name, [...connectorIds]),
    ),
    columns: { id: true, tenantId: true, name: true },
  });

  const credentialRows =
    providerRows.length === 0
      ? []
      : await db.query.credential.findMany({
          where: inArray(
            credential.providerId,
            providerRows.map((row) => row.id),
          ),
          columns: { providerId: true, status: true, createdAt: true },
          orderBy: [desc(credential.createdAt)],
        });
  const newestCredentialByProviderId = new Map<
    string,
    (typeof credentialRows)[number]
  >();
  for (const row of credentialRows) {
    if (!newestCredentialByProviderId.has(row.providerId)) {
      newestCredentialByProviderId.set(row.providerId, row);
    }
  }

  for (const connectorId of connectorIds) {
    let satisfied = false;
    for (const tenantIdInChain of chain) {
      const providerRow = providerRows.find(
        (row) => row.tenantId === tenantIdInChain && row.name === connectorId,
      );
      if (providerRow === undefined) continue;
      const newest = newestCredentialByProviderId.get(providerRow.id);
      satisfied = newest === undefined || newest.status === "active";
      break;
    }
    satisfaction.set(connectorId, satisfied);
  }
  return satisfaction;
}

/**
 * Every catalog asset name with no deployed `workflow_definition` on this
 * tenant yet, enriched with `WORKFLOW_CATALOG` metadata, connection
 * satisfaction, and pin deployability. `catalogAssetNames` names the full
 * deployable-through-the-catalog-instantiate-route set (`@corbits/seeding`'s
 * `CATALOG_WORKFLOWS`, by asset name) and `isDeployableOnThisPin` names
 * `@corbits/seeding`'s `catalogWorkflowDeployableOnThisPin` — both the
 * caller's job, not this package's, since importing that package here
 * would cycle back through its own dependency on `@corbits/workflows`. A
 * catalog name with no `WORKFLOW_CATALOG` entry is skipped rather than
 * thrown on: the two lists are asserted equal elsewhere
 * (`packages/seeding/test`), so this is defense against the caller
 * passing a stale name, not an expected path.
 */
export async function listAvailableCatalogWorkflows(args: {
  readonly db: DB["db"];
  readonly tenantId: string;
  readonly catalogAssetNames: readonly string[];
  readonly isDeployableOnThisPin?: (assetName: string) => boolean;
}): Promise<readonly AvailableCatalogWorkflow[]> {
  const { db, tenantId, catalogAssetNames, isDeployableOnThisPin } = args;

  const deployed = await db.query.workflowDefinition.findMany({
    where: and(
      eq(workflowDefinition.tenantId, tenantId),
      eq(workflowDefinition.origin, "authored"),
      eq(workflowDefinition.status, "deployed"),
    ),
    columns: { name: true },
  });
  const deployedNames = new Set(deployed.map((row) => row.name));

  const allConnectorIds = new Set(
    catalogAssetNames.flatMap(
      (assetName) => workflowCatalogEntry(assetName)?.requiredConnections ?? [],
    ),
  );
  const connectorSatisfaction = await connectionSatisfactionByConnector(
    db,
    tenantId,
    allConnectorIds,
  );

  return availableCatalogWorkflowsFrom({
    catalogAssetNames,
    deployedNames,
    isConnectorSatisfied: (connectorId) =>
      connectorSatisfaction.get(connectorId) ?? false,
    ...(isDeployableOnThisPin !== undefined ? { isDeployableOnThisPin } : {}),
  });
}
