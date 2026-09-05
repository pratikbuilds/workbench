// Tenant-scoped Insights read API. Mounted under the platform's native
// tenant middleware; every number that cannot be known is returned as
// null, never a fabricated zero. usage/activity/tools roll up the
// requested tenant's whole descendant subtree when `deps.db` is wired
// (see resolveScope) — the same route serves a single workbench's own
// numbers (leaf, no descendants) and a workspace's cross-workbench
// aggregate (parent, its child workbenches). `/scope` is the read-only
// counterpart a caller uses to discover that shape: its own name, its
// parent (if any), and the sibling workbenches to switch between —
// filtered to tenants the caller holds an active principal in (see
// callerTenantIds), never a sibling or parent name the caller has no
// membership in.
import { Hono } from "hono";
import { type } from "arktype";
import { eq, and, inArray } from "drizzle-orm";

import { getDescendantTenants, schema, type DB } from "@intx/db";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import {
  activityByDay,
  emptyToolCallReader,
  summarizeLatency,
  summarizeUsage,
  summarizeUsageByTenant,
  teamSpaceWorkbenchRows,
  type RunTraceReader,
  type ToolCallReader,
} from "./queries";
import type { UsageStore } from "./store";
import type { TurnLatencyStore } from "./latency-store";
import { makeErrorEnvelope } from "@corbits/error-sink";

const RangeQuery = type({
  "from?": "string",
  "to?": "string",
});

function parseRange(raw: { from?: string; to?: string }):
  | {
      from?: Date;
      to?: Date;
    }
  | type.errors {
  const opts: { from?: Date; to?: Date } = {};
  if (raw.from !== undefined) {
    const d = new Date(raw.from);
    if (Number.isNaN(d.getTime())) {
      return type.errors as unknown as type.errors;
    }
    opts.from = d;
  }
  if (raw.to !== undefined) {
    const d = new Date(raw.to);
    if (Number.isNaN(d.getTime())) {
      return type.errors as unknown as type.errors;
    }
    opts.to = d;
  }
  return opts;
}

export type CreateInsightsRoutesDeps = {
  store: UsageStore;
  requireGrant: RequireGrant;
  runTraceReader?: RunTraceReader;
  toolCallReader?: ToolCallReader;
  /** CL-6257 per-message-run stage latency (message-received → reactor.start
   * → inference.start → first-token → reply-posted). Omitted mounts, no
   * `/latency` numbers — `/latency` still returns 200 with every stage
   * null rather than 404, since latency is an optional overlay, not a
   * required Insights capability. */
  latencyStore?: TurnLatencyStore;
  /**
   * Tenant-hierarchy handle for scope resolution. usage/activity/tools
   * aggregate over the requested tenant plus every descendant it has
   * (see getDescendantTenants) — no separate "aggregate" flag or route:
   * calling with a workbench's own id stays a single-tenant view (it has
   * no descendants), calling with its workspace parent rolls up every
   * child workbench, at this query layer rather than one fetch per
   * tenant. Omitted, every query stays scoped to exactly the requested
   * tenant (no hierarchy lookup, same behavior as before this scope
   * existed).
   */
  db?: DB["db"];
};

async function resolveScope(
  db: DB["db"] | undefined,
  tenantId: string,
): Promise<readonly string[]> {
  if (db === undefined) return [tenantId];
  return getDescendantTenants(db, tenantId);
}

/**
 * Shared `?from=&to=` parsing for every range-scoped route below (`/usage`,
 * `/activity`, `/tools`, `/workbenches`) — one bad-request shape instead of
 * four near-identical copies drifting apart.
 */
function parseRangeQuery(
  query: Record<string, string>,
): { from?: Date; to?: Date } | Response {
  const raw = RangeQuery(query);
  if (raw instanceof type.errors) {
    return Response.json(
      makeErrorEnvelope({
        code: "bad_request",
        userMessage: `invalid query: ${raw.summary}`,
      }),
      { status: 400 },
    );
  }
  const range = parseRange(raw);
  if (range instanceof type.errors) {
    return Response.json(
      makeErrorEnvelope({
        code: "bad_request",
        userMessage: "invalid from/to timestamp",
      }),
      { status: 400 },
    );
  }
  return range;
}

/**
 * Display names for a tenant scope. Never falls back to querying the DB
 * with an empty `id` list, and never invents a name — a scope id with no
 * matching tenant row (deleted between the descendant walk and this
 * lookup) just falls back to its own id, same as `/scope`'s own
 * best-effort labeling does for a parent row that vanished mid-request.
 */
async function tenantNames(
  db: DB["db"] | undefined,
  tenantId: string,
  tenantName: string,
  scope: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (db === undefined || scope.length === 0) {
    return new Map([[tenantId, tenantName]]);
  }
  const rows = await db.query.tenant.findMany({
    where: inArray(schema.tenant.id, scope as string[]),
    columns: { id: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * The set of tenant ids the calling user holds an active principal in —
 * the same `principal.kind === "user" && principal.refId === user.id`
 * lookup `/api/me/principals` (vendor's `routes/me.ts`) uses to derive a
 * user's cross-tenant memberships. `/scope` intersects this against a
 * tenant's siblings/parent so it can never name a tenant the caller has
 * no membership in, regardless of which tenant they asked about.
 */
async function callerTenantIds(
  db: DB["db"],
  userId: string,
): Promise<ReadonlySet<string>> {
  const rows = await db.query.principal.findMany({
    where: and(
      eq(schema.principal.kind, "user"),
      eq(schema.principal.refId, userId),
      eq(schema.principal.status, "active"),
    ),
    columns: { tenantId: true },
  });
  return new Set(rows.map((r) => r.tenantId));
}

export function createInsightsRoutes(
  deps: CreateInsightsRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();
  const tools = deps.toolCallReader ?? emptyToolCallReader();

  app.get("/usage", deps.requireGrant("insights:*", "read"), async (c) => {
    const range = parseRangeQuery(c.req.query());
    if (range instanceof Response) return range;
    const tenant = c.get("tenant");
    const scope = await resolveScope(deps.db, tenant.id);
    const summary = await summarizeUsage(deps.store, scope, range);
    return c.json(summary);
  });

  app.get("/activity", deps.requireGrant("insights:*", "read"), async (c) => {
    const range = parseRangeQuery(c.req.query());
    if (range instanceof Response) return range;
    const tenant = c.get("tenant");
    const scope = await resolveScope(deps.db, tenant.id);
    const days = await activityByDay(deps.store, scope, range);
    return c.json({ days });
  });

  app.get("/tools", deps.requireGrant("insights:*", "read"), async (c) => {
    const range = parseRangeQuery(c.req.query());
    if (range instanceof Response) return range;
    const tenant = c.get("tenant");
    const scope = await resolveScope(deps.db, tenant.id);
    const toolsSummary = await tools.summarize(scope, range);
    return c.json({ tools: toolsSummary });
  });

  /**
   * The global Insights landing's "activity by workbench" chart: the same
   * usage rollup `/usage` already computes for the whole scope, split back
   * out per tenant and named — so the landing can rank workbenches and
   * link each bar to `/insights/workbench/:tenantId` instead of only
   * seeing the scope's sum. Calling it for a leaf workbench (no
   * descendants) returns that one workbench's own row.
   *
   * A `parentId === null` requested tenant is the account root, the
   * container real workbenches live under (CL-6089). An empty parent row
   * is a duplicate of the "All workbenches" landing and is dropped
   * (CL-6368). A parent that recorded turns of its own stays in the
   * breakdown so those turns are not silently excluded (CL-6659).
   */
  app.get(
    "/workbenches",
    deps.requireGrant("insights:*", "read"),
    async (c) => {
      const range = parseRangeQuery(c.req.query());
      if (range instanceof Response) return range;
      const tenant = c.get("tenant");
      const scope = await resolveScope(deps.db, tenant.id);
      const [rows, names] = await Promise.all([
        summarizeUsageByTenant(deps.store, scope, range),
        tenantNames(deps.db, tenant.id, tenant.name, scope),
      ]);
      const items = teamSpaceWorkbenchRows(rows, {
        tenantId: tenant.id,
        isTeamSpace: tenant.parentId === null,
      })
        .map((row) => ({
          tenantId: row.tenantId,
          name: names.get(row.tenantId) ?? row.tenantId,
          turns: row.turns,
          tokens: row.tokens,
          costUsd: row.costUsd,
        }))
        .sort((a, b) => b.turns - a.turns);
      return c.json({ items });
    },
  );

  app.get("/latency", deps.requireGrant("insights:*", "read"), async (c) => {
    const range = parseRangeQuery(c.req.query());
    if (range instanceof Response) return range;
    if (deps.latencyStore === undefined) {
      return c.json({
        toReactorStart: { p50Ms: null, p95Ms: null, samples: 0 },
        toInferenceStart: { p50Ms: null, p95Ms: null, samples: 0 },
        toFirstToken: { p50Ms: null, p95Ms: null, samples: 0 },
        toReplyPosted: { p50Ms: null, p95Ms: null, samples: 0 },
        total: { p50Ms: null, p95Ms: null, samples: 0 },
      });
    }
    const tenant = c.get("tenant");
    const scope = await resolveScope(deps.db, tenant.id);
    const summary = await summarizeLatency(deps.latencyStore, scope, range);
    return c.json(summary);
  });

  app.get("/scope", deps.requireGrant("insights:*", "read"), async (c) => {
    const tenant = c.get("tenant");
    const self = { tenantId: tenant.id, name: tenant.name };
    const selfOnly = () =>
      c.json({
        tenantId: tenant.id,
        name: tenant.name,
        parent: null,
        workbenches: [self],
      });
    const user = c.get("user");
    if (deps.db === undefined || tenant.parentId === null || user === null) {
      return selfOnly();
    }
    const memberTenantIds = await callerTenantIds(deps.db, user.id);
    const siblings = await deps.db.query.tenant.findMany({
      where: eq(schema.tenant.parentId, tenant.parentId),
      columns: { id: true, name: true },
    });
    // Only siblings (and self) the caller actually holds a principal in —
    // never a name or tenantId belonging to a tenant they aren't a member
    // of, no matter what the requested tenant's own membership allows.
    const workbenches = siblings.filter((s) => memberTenantIds.has(s.id));
    if (!memberTenantIds.has(tenant.parentId)) {
      return c.json({
        tenantId: tenant.id,
        name: tenant.name,
        parent: null,
        workbenches: workbenches.map((s) => ({ tenantId: s.id, name: s.name })),
      });
    }
    const parentRow = await deps.db.query.tenant.findFirst({
      where: eq(schema.tenant.id, tenant.parentId),
      columns: { id: true, name: true },
    });
    if (parentRow === undefined) {
      return c.json({
        tenantId: tenant.id,
        name: tenant.name,
        parent: null,
        workbenches: workbenches.map((s) => ({ tenantId: s.id, name: s.name })),
      });
    }
    return c.json({
      tenantId: tenant.id,
      name: tenant.name,
      parent: { tenantId: parentRow.id, name: parentRow.name },
      workbenches: workbenches.map((s) => ({ tenantId: s.id, name: s.name })),
    });
  });

  app.get(
    "/runs/:runId/trace",
    deps.requireGrant("insights:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const runId = c.req.param("runId");
      if (deps.runTraceReader === undefined) {
        return c.json(
          {
            runId,
            spans: null,
            absent: "run_trace_reader_not_mounted",
          },
          200,
        );
      }
      // No recorded trace is a normal state for a run (recorded before
      // tracing, or trace rows pruned) — answer the same absent envelope
      // as an unmounted reader instead of 404ing a lookup the run-detail
      // page fires on every open.
      const trace = await deps.runTraceReader.getTrace(tenant.id, runId);
      if (trace === null) {
        return c.json(
          {
            runId,
            spans: null,
            absent: "trace_not_recorded",
          },
          200,
        );
      }
      return c.json(trace);
    },
  );

  return app;
}
