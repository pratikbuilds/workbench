// The sanctioned path for a workflow-process child (Myra, or any
// conversational agent) to see which third-party connections this
// workbench has live, and to hand a human a link to connect one that
// isn't — CL-myra-manager-tools. Mirrors `@corbits/agent-directory`'s
// `createWorkflowCapabilityRoutes` and `@corbits/skills`'
// `createWorkflowSkillRoutes`: a workflow child has no browser session,
// only its sidecar bearer token and its own run address, so it
// authenticates through a `WorkflowRunAuthenticator` rather than the
// tenant-session pipeline `./routes.ts` uses.
//
// Mounted OUTSIDE the tenant prefix for that reason, at
// `/api/workflow-connections`. Identity NEVER rides in a request body:
// the tenant every read is scoped to come from the authenticated run
// alone.
//
// `GET /connections` reports a connector connected through the same
// resolution an actual agent launch uses to deliver its credential —
// `@intx/db`'s `resolveCredentialRequirement`, keyed on the connector's
// registry `id` as its provider name (CL-6492). This is deliberately NOT
// `@corbits/chat`'s `listConnectedProviders`: that lister answers from the
// model catalog (`modelProvider`, seeded only for inference providers by
// `persistConnectorCredential`'s `seedCatalog` step), so every
// non-inference connector — GitHub, Linear, Notion, Sentry, Exa — reads
// "not connected" there even with a live, verified credential. Resolving
// through `resolveCredentialRequirement` instead covers both kinds
// uniformly: an inference provider's credential (however it was named —
// `persistConnectorCredential`'s own `displayName` row, or an onboarding
// seed's `<id>-default` row) and a tool connector's credential both
// resolve the same way, by `provider.name = descriptor.id` and an active
// `credential` row against it, with no per-connector-kind branch here.
//
// No `requireGrant` on `GET /connections`, unlike `./routes.ts`'s
// tenant-session routes: this endpoint is read-only and mutates nothing,
// so there is no write to gate. The companion `request_connection` tool
// (`@corbits/connections-tools`) needs no route at all — it validates a
// connector id against the same `CONNECTOR_REGISTRY` and builds a
// deep-link string, entirely in-process, never touching the network or
// completing OAuth itself — so this file only ever grows the one
// endpoint below.
import { Hono } from "hono";

import type { ConnectorDescriptor } from "./descriptor";
import type { McpServerConnection } from "./mcp-server-store";

/**
 * The tenant + principal + run a presented sidecar token and run
 * address resolve to. Declared structurally (mirroring
 * `@corbits/agent-directory`'s `WorkflowCapabilityRunScope` and
 * `@corbits/skills`' `WorkflowRunScope`) rather than importing
 * `@corbits/artifacts-hub`'s concrete type, so this package carries no
 * dependency on the artifacts plane; `apps/hub` supplies
 * `@corbits/artifacts-hub`'s `createWorkflowRunAuthenticator`, which
 * satisfies this shape exactly (it resolves a superset: `runId` too).
 * Only `tenantId` is read below — `principalId`/`runId` are kept on the
 * shape purely for consistency with the other workflow-run routes.
 */
export type WorkflowConnectionRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly runId: string;
};

export type WorkflowRunAuthenticator = {
  resolve(
    token: string,
    runAddress: string,
  ): Promise<WorkflowConnectionRunScope | null>;
};

export type WorkflowConnectionsEnv = {
  Variables: { workflowConnectionScope: WorkflowConnectionRunScope };
};

export type ConnectionSummary = {
  readonly id: string;
  readonly displayName: string;
  readonly docsUrl: string;
  readonly connected: boolean;
};

export type CreateWorkflowConnectionRoutesDeps = {
  readonly authenticator: WorkflowRunAuthenticator;
  /** The connector set this build ships — this package carries none of
   * its own (CL-7384), so a caller always supplies one. */
  readonly registry: Readonly<Record<string, ConnectorDescriptor>>;
  /** A port, not a raw `db` handle — keeps this package decoupled from
   * the credentials schema by taking ports rather than reaching for
   * database access directly.
   * `apps/hub` supplies `@intx/db`'s `resolveCredentialRequirement`,
   * curried over `db` and the `"tenant"` source (the same resolution
   * `buildCredentialDelivery` uses at agent-launch time to decide whether
   * a tool actually gets a credential), so this route reports exactly
   * what an agent could really use — never a catalog-derived guess. */
  readonly isConnectorConnected: (
    tenantId: string,
    connectorId: string,
  ) => Promise<boolean>;
  /** Backs `GET /mcp-servers` (`@corbits/mcp-tools`' `mcp_list_servers`):
   * every `mcp:<slug>` server this tenant has connected. `apps/hub`
   * supplies `@corbits/connections`' own `listMcpServerConnections`
   * (`mcp-server-store.ts`) — a direct DB read, since this route has no
   * tenant-session cookies to reuse `./mcp-server-routes.ts`'s hub-HTTP
   * listing. Optional so an environment that hasn't wired MCP support
   * yet degrades to an empty list rather than a route-mount error. */
  readonly listMcpServers?: (
    tenantId: string,
  ) => Promise<readonly McpServerConnection[]>;
};

export function createWorkflowConnectionRoutes(
  deps: CreateWorkflowConnectionRoutesDeps,
): Hono<WorkflowConnectionsEnv> {
  const app = new Hono<WorkflowConnectionsEnv>();

  app.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = await deps.authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        {
          error: {
            code: "unauthorized",
            message:
              "Missing or unrecognized sidecar bearer token / run address",
          },
        },
        401,
      );
    }
    c.set("workflowConnectionScope", scope);
    await next();
  });

  app.get("/connections", async (c) => {
    const scope = c.get("workflowConnectionScope");
    const descriptors = Object.values(deps.registry);
    const connections: ConnectionSummary[] = await Promise.all(
      descriptors.map(async (descriptor) => ({
        id: descriptor.id,
        displayName: descriptor.displayName,
        docsUrl: descriptor.docsUrl,
        connected: await deps.isConnectorConnected(
          scope.tenantId,
          descriptor.id,
        ),
      })),
    );
    return c.json({ data: connections }, 200);
  });

  app.get("/mcp-servers", async (c) => {
    const scope = c.get("workflowConnectionScope");
    const servers = (await deps.listMcpServers?.(scope.tenantId)) ?? [];
    return c.json({ data: servers }, 200);
  });

  return app;
}
