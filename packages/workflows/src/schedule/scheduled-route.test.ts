import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";

import {
  createScheduledWorkflowRoutes,
  RUN_NOW_CONTENT,
} from "./scheduled-route";
import type { ScheduledWorkflowDefinition } from "./list-scheduled";
import type { AvailableCatalogWorkflow } from "./available-catalog";

const TENANT = {
  id: "tnt_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.workbench.test",
};
const PRINCIPAL = {
  id: "prn_1",
  tenantId: TENANT.id,
  kind: "user" as const,
  refId: "prn_1",
  status: "active" as const,
};

const AT = new Date("2026-01-01T00:00:00.000Z");

const digest: ScheduledWorkflowDefinition = {
  definitionId: "wfd_digest",
  assetId: "ast_1",
  name: "workbench-digest",
  tenantId: TENANT.id,
  status: "stopped",
  cron: "0 9 * * *",
  createdAt: AT,
  updatedAt: AT,
};

const allowAll: RequireGrant = () => async (_c, next) => {
  await next();
};

function mount(
  runNow: (args: {
    tenantId: string;
    definitionId: string;
    principalId: string;
    fromDomain: string;
    content: string;
    name: string;
    assetId: string;
  }) => Promise<{ runId: string }>,
  listed: readonly ScheduledWorkflowDefinition[],
  overrides: {
    requireGrant?: RequireGrant;
    catalogAssetNames?: readonly string[];
    listAvailable?: () => Promise<readonly AvailableCatalogWorkflow[]>;
  } = {},
): Hono<TenantEnv> {
  const asTenant: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT as never);
    c.set("principal", PRINCIPAL as never);
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asTenant);
  app.route(
    "/",
    createScheduledWorkflowRoutes({
      db: {} as never,
      requireGrant: overrides.requireGrant ?? allowAll,
      runNow,
      listScheduled: async () => listed,
      ...(overrides.catalogAssetNames !== undefined
        ? { catalogAssetNames: overrides.catalogAssetNames }
        : {}),
      ...(overrides.listAvailable !== undefined
        ? { listAvailable: overrides.listAvailable }
        : {}),
    }),
  );
  return app;
}

describe("createScheduledWorkflowRoutes", () => {
  test("GET /scheduled includes a stopped definition", async () => {
    const app = mount(async () => ({ runId: "run_x" }), [digest]);
    const res = await app.request("/scheduled");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: readonly { definitionId: string; status: string }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.definitionId).toBe("wfd_digest");
    expect(body.items[0]?.status).toBe("stopped");
  });

  test("POST /scheduled/:id/run fires with Run now. content", async () => {
    const calls: unknown[] = [];
    const app = mount(
      async (args) => {
        calls.push(args);
        return { runId: "run_now_1" };
      },
      [digest],
    );
    const res = await app.request("/scheduled/wfd_digest/run", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: "run_now_1" });
    expect(calls).toEqual([
      {
        tenantId: TENANT.id,
        definitionId: "wfd_digest",
        principalId: PRINCIPAL.id,
        fromDomain: TENANT.domain,
        content: RUN_NOW_CONTENT,
        name: digest.name,
        assetId: digest.assetId,
      },
    ]);
  });

  test("POST /scheduled/:id/run 404s when the definition is not scheduled", async () => {
    const app = mount(async () => ({ runId: "run_x" }), [digest]);
    const res = await app.request("/scheduled/wfd_missing/run", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  test("GET /available answers the injected available list", async () => {
    const entry: AvailableCatalogWorkflow = {
      assetName: "code-review",
      displayName: "Code review",
      description: "Reviews a pull request and posts one review back on it.",
      requiredConnections: ["github"],
      missingConnections: ["github"],
      connectionsSatisfied: false,
      deployable: true,
    };
    const app = mount(async () => ({ runId: "run_x" }), [], {
      catalogAssetNames: ["code-review"],
      listAvailable: async () => [entry],
    });
    const res = await app.request("/available");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [entry] });
  });

  test("GET /available denies without the workflow:* read grant", async () => {
    const deny: RequireGrant = () => async (c) => {
      return c.json({ error: { code: "forbidden" } }, 403);
    };
    const app = mount(async () => ({ runId: "run_x" }), [], {
      requireGrant: deny,
      listAvailable: async () => [],
    });
    const res = await app.request("/available");
    expect(res.status).toBe(403);
  });
});
