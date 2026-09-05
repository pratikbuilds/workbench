// Reads the tenant's actual state straight off the platform's own
// tables and stores — the same "read the platform's own tables
// directly" convention `./trace.ts` already established for tool
// calls, extended here to agent definitions, connections, and
// webhook triggers. A scorer that only ever saw the transcript could check
// what the agent *said/called*; this is what lets it check what
// actually exists afterward.
//
// Every read below mirrors a real, already-shipped read path instead
// of reinventing one:
//   - agent definitions: `@corbits/agent-directory`'s
//     `listVisibleAgentDefinitions` query shape, minus its DM-only
//     filtering (a world snapshot wants every deployed definition, not
//     just the conversational ones a sidebar would show), then
//     `readAgentCapabilities` on the definition its asset's source tree
//     carries, read back through `readAgentDefinitionWorkflowJson` —
//     the same pair `GET /:definitionId/capabilities` calls.
//   - connections: `@corbits/connections`'
//     `listMcpServerConnections` verbatim — it already filters to an
//     active credential, so everything it returns is "live".
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { resolveCredentialByName, schema } from "@intx/db";
import type { AssetService } from "@intx/hub-sessions";
import {
  readAgentCapabilities,
  readAgentDefinitionWorkflowJson,
} from "@corbits/agent-directory";
import { webhookTrigger as webhookTriggerTable } from "@corbits/webhook-triggers";
import {
  connectorDescriptors,
  listMcpServerConnections,
} from "@corbits/connections";
import { CONNECTOR_REGISTRY } from "@workbench/templates/connectors";

import type { FakeReceipt, WorldSnapshot } from "../types.ts";

/** The infra `captureWorldSnapshot` reads through — a real `@intx/db`
 * drizzle handle and `AssetService`, the same two things
 * `agent-directory`'s own routes already depend on, so a caller
 * standing up a live target has both on hand already.
 * `fakeReceiptsReader` is gap 3's recording-MCP-fake feed: omitted (or
 * returning `[]`) when no fake is wired for the eval. */
export interface WorldSnapshotInfra {
  readonly db: DB["db"];
  readonly assetService: AssetService;
  readonly fakeReceiptsReader?: () => readonly FakeReceipt[];
  /** Test seam over `@intx/db`'s ancestor-walking credential resolver,
   * defaulting to the real one — the same resolution the Plugins layer
   * and the hub's own `resolveGithubConfig` binding use. */
  readonly resolveCredentialByNameFn?: typeof resolveCredentialByName;
}

async function readAgentDefinitions(
  db: DB["db"],
  assetService: AssetService,
  tenantId: string,
) {
  const rows = await db.query.workflowDefinition.findMany({
    where: and(
      eq(schema.workflowDefinition.tenantId, tenantId),
      eq(schema.workflowDefinition.status, "deployed"),
    ),
  });

  const deployable = rows.filter(
    (row): row is typeof row & { assetId: string } => row.assetId !== null,
  );
  return Promise.all(
    deployable.map(async (row) => {
      const workflowJson = await readAgentDefinitionWorkflowJson(
        assetService,
        row.assetId,
      );
      const capabilities = readAgentCapabilities(workflowJson);
      return {
        id: row.id,
        name: row.name,
        displayName: row.description,
        toolPackagePins: capabilities.toolPackagePins.map((pin) => pin.name),
        skills: [] as readonly string[],
        model: capabilities.model ?? null,
      };
    }),
  );
}

async function readConnections(
  db: DB["db"],
  tenantId: string,
  resolveByName: typeof resolveCredentialByName,
) {
  const mcpConnections = await listMcpServerConnections(db, tenantId);
  const fromMcp = mcpConnections.map((connection) => ({
    slug: connection.slug,
    name: connection.name,
    url: connection.url,
    live: true,
  }));

  // Connector credentials (the Plugins layer): a connector's credential
  // row is named after its descriptor's displayName — the exact
  // resolution `@corbits/connections`' plugins module and the hub's
  // own `resolveGithubConfig` binding use — so a GitHub PAT connected
  // through the connections layer shows up here as slug "github",
  // which is not an MCP server and was invisible to this snapshot
  // before.
  const fromConnectors: typeof fromMcp = [];
  for (const descriptor of connectorDescriptors(CONNECTOR_REGISTRY)) {
    const row = await resolveByName(db, tenantId, descriptor.displayName);
    if (row === null) continue;
    fromConnectors.push({
      slug: descriptor.id,
      name: descriptor.displayName,
      url: "",
      live: true,
    });
  }
  return [...fromMcp, ...fromConnectors];
}

async function readWebhookTriggers(db: DB["db"], tenantId: string) {
  const rows = await db
    .select()
    .from(webhookTriggerTable)
    .where(eq(webhookTriggerTable.tenantId, tenantId));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    workflowDefinitionId: row.workflowDefinitionId,
    enabled: row.enabled,
  }));
}

/**
 * Captures everything a world-snapshot scorer can check about the
 * tenant right now: its deployed agent definitions (with tools/skills/
 * model), its live connections, and whatever a recording MCP fake has
 * received so far. Read-only — never mutates anything.
 */
export async function captureWorldSnapshot(
  infra: WorldSnapshotInfra,
  tenantId: string,
): Promise<WorldSnapshot> {
  const [agentDefinitions, connections, webhookTriggers] = await Promise.all([
    readAgentDefinitions(infra.db, infra.assetService, tenantId),
    readConnections(
      infra.db,
      tenantId,
      infra.resolveCredentialByNameFn ?? resolveCredentialByName,
    ),
    readWebhookTriggers(infra.db, tenantId),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    agentDefinitions,
    connections,
    webhookTriggers,
    fakeReceipts: infra.fakeReceiptsReader?.() ?? [],
  };
}
