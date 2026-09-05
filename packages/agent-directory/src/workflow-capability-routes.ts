// The sanctioned path for a workflow-process child to add itself a
// capability (`@corbits/capability-tools`'s `request_capability`,
// CL-6084) — the execution half of `POST /:definitionId/capabilities`
// / `GET /capabilities/inventory` in `./routes.ts`, mirroring
// `@corbits/skills`' `createWorkflowSkillRoutes` and
// `@corbits/artifacts-hub`'s workflow-artifacts routes: a workflow child
// has no browser session, only its sidecar bearer token and its own run
// address, so it authenticates through a `WorkflowRunAuthenticator`
// rather than the tenant-session pipeline `./routes.ts` uses.
//
// Mounted OUTSIDE the tenant prefix for that reason, at
// `/api/workflow-capabilities`. Identity NEVER rides in a request body
// or path beyond the definitionId itself: the tenant and principal
// every write is scoped to come from the authenticated run alone.
//
// Authorization decision (deliberate, see CL-6085 for the durable fix):
// the vendored grant-materialization path never seeds a `kind:
// "workflow"` run's own principal a `workflow-definition: <its own
// id>/update` grant — `requireGrant` would 403 every self-update call a
// run makes for its own definition until that vendor gap closes. Rather
// than block `request_capability` on an unpublished vendor change, this
// route skips a grant-store check entirely for the ONE case it accepts:
// a call whose authenticated run targets its OWN definitionId. That
// narrow case is already gated by a stronger control than a grant row —
// `@corbits/capability-tools`' `request_capability` tool declares
// `approval: "ask"` (`@intx/agent`'s native per-invocation gate), so the
// reactor suspends every call as a pending approval and renders it
// in-chat BEFORE this route ever runs; a human already had to approve
// the specific addition. The human is the authorizer here, not a grant
// row. This route still enforces, unconditionally: (1) the caller's run
// must resolve to a live tenant/principal/run via the sidecar-token +
// run-address check below, (2) the path `definitionId` must equal the
// resolved run's OWN definitionId (rejected 403 otherwise — a run can
// never touch another definition through this surface), and (3) the
// addition must fail closed against the tenant's live capability
// inventory (`assertCapabilityInInventory`, unchanged from the
// tenant-session route). CL-6085 tracks seeding the real self-update
// grant in vendor grant materialization, at which point this route can
// route through `requireGrant` like every other definition-mutating
// surface instead of carrying this interim rule.
import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { DB } from "@intx/db";
import { workflowDefinition, workflowRun } from "@intx/db/schema";
import type { AssetService } from "@intx/hub-sessions";

import { isWorkbenchHostDefinitionName } from "@corbits/chat/workbench-host-naming";

import { commitAgentCapabilityAdd } from "./capability-add";
import {
  AddCapabilityInput,
  assertCapabilityInInventory,
  CapabilityOutOfInventoryError,
  type CapabilityInventoryProvider,
} from "./capability-inventory";
import {
  RetiredWorkflowEnvelopeError,
  statusForAgentDefinitionDeployError,
  WorkflowAuthorError,
  type AgentDefinitionDeployer,
} from "./definition-asset";
import type { PinnedSkillIndexResolver } from "./routes";
import type { DefinitionSkillsStore } from "./skills-store";
import { makeErrorEnvelope } from "@corbits/error-sink";

/**
 * The tenant + principal + run a presented sidecar token and run
 * address resolve to. Declared structurally (mirroring
 * `@corbits/skills`' `WorkflowRunScope`) rather than importing
 * `@corbits/artifacts-hub`'s concrete type, so this package carries no
 * dependency on the artifacts plane; `apps/hub` supplies
 * `@corbits/artifacts-hub`'s `createWorkflowRunAuthenticator`, which
 * satisfies this shape exactly (it resolves a superset: `runId` too).
 */
export type WorkflowCapabilityRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly runId: string;
};

export type WorkflowRunAuthenticator = {
  resolve(
    token: string,
    runAddress: string,
  ): Promise<WorkflowCapabilityRunScope | null>;
};

export type WorkflowCapabilitiesEnv = {
  Variables: { workflowCapabilityScope: WorkflowCapabilityRunScope };
};

function definitionNotFound(definitionId: string) {
  return makeErrorEnvelope({
    code: "not_found",
    userMessage: `No agent definition "${definitionId}" in this workbench`,
  });
}

/** Same host-guard `./routes.ts` applies: a workbench host is never a
 * target a workflow run may mutate through this surface either. */
function hostGuardedRow(
  row: { readonly name: string; readonly assetId: string | null } | undefined,
): row is { readonly name: string; readonly assetId: string } {
  return (
    row !== undefined &&
    row.assetId !== null &&
    !isWorkbenchHostDefinitionName(row.name)
  );
}

export type CreateWorkflowCapabilityRoutesDeps = {
  db: DB["db"];
  assetService: AssetService;
  skillIndex: PinnedSkillIndexResolver;
  skillsStore: DefinitionSkillsStore;
  capabilityInventory: CapabilityInventoryProvider;
  authenticator: WorkflowRunAuthenticator;
  /** Deploys the definition's commit through the native source pipeline
   * after the rewrite; the composition root injects the SAME
   * `WorkflowDeployer` `@corbits/workflows`'s `./authoring`'s registry
   * calls. */
  deployer: AgentDefinitionDeployer;
};

export function createWorkflowCapabilityRoutes(
  deps: CreateWorkflowCapabilityRoutesDeps,
): Hono<WorkflowCapabilitiesEnv> {
  const app = new Hono<WorkflowCapabilitiesEnv>();

  app.onError((err, c) => {
    if (err instanceof CapabilityOutOfInventoryError) {
      return c.json(
        makeErrorEnvelope({ code: "bad_request", userMessage: err.message }),
        400,
      );
    }
    if (err instanceof RetiredWorkflowEnvelopeError) {
      return c.json(
        makeErrorEnvelope({ code: "conflict", userMessage: err.message }),
        409,
      );
    }
    if (err instanceof WorkflowAuthorError) {
      return c.json(
        makeErrorEnvelope({ code: err.reason, userMessage: err.message }),
        statusForAgentDefinitionDeployError(err.reason),
      );
    }
    throw err;
  });

  app.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = await deps.authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage:
            "Missing or unrecognized sidecar bearer token / run address",
        }),
        401,
      );
    }
    c.set("workflowCapabilityScope", scope);
    await next();
  });

  app.get("/inventory", async (c) => {
    const scope = c.get("workflowCapabilityScope");
    const inventory = await deps.capabilityInventory.resolve({
      tenantId: scope.tenantId,
      principalId: scope.principalId,
    });
    return c.json(inventory);
  });

  app.post("/:definitionId/capabilities", async (c) => {
    const scope = c.get("workflowCapabilityScope");
    const definitionId = c.req.param("definitionId");

    // Resolve the calling run's OWN definitionId and reject outright if
    // the path names anything else — a run may only ever touch its own
    // definition through this surface (see the file-level "why" comment
    // for the full authorization decision this enforces in place of a
    // grant-store check).
    const run = await deps.db.query.workflowRun.findFirst({
      where: eq(workflowRun.id, scope.runId),
    });
    if (run === undefined || run.definitionId !== definitionId) {
      return c.json(
        makeErrorEnvelope({
          code: "forbidden",
          userMessage:
            "A workflow run may only request capabilities for its own agent definition",
        }),
        403,
      );
    }

    const body = AddCapabilityInput(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid capability: ${body.summary}`,
        }),
        400,
      );
    }

    const row = await deps.db.query.workflowDefinition.findFirst({
      where: and(
        eq(workflowDefinition.id, definitionId),
        eq(workflowDefinition.tenantId, scope.tenantId),
      ),
    });
    if (!hostGuardedRow(row)) {
      return c.json(definitionNotFound(definitionId), 404);
    }

    const inventory = await deps.capabilityInventory.resolve({
      tenantId: scope.tenantId,
      principalId: scope.principalId,
    });
    // Throws `CapabilityOutOfInventoryError`, caught by `app.onError`
    // above — fail closed against exactly the inventory this call just
    // fetched, never a stale or wider one. Unchanged from the
    // tenant-session route's own fail-closed check.
    assertCapabilityInInventory(body, inventory);

    const added = await commitAgentCapabilityAdd({
      db: deps.db,
      assetService: deps.assetService,
      deployer: deps.deployer,
      skillsStore: deps.skillsStore,
      skillIndex: deps.skillIndex,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      assetId: row.assetId,
      handle: row.name,
      body,
    });
    return c.json(added);
  });

  return app;
}
