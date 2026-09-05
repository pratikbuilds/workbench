// Gives a running workflow (Myra) a way to pin a skill onto ANY
// definition in its own tenant — the execution half of a `pin_skill`
// tool the workbench-tools side wires up, mirroring this package's own
// `createWorkflowCapabilityRoutes`: a workflow child has
// no browser session, only its sidecar bearer token and its own run
// address, so it authenticates through a `WorkflowRunAuthenticator`
// rather than the tenant-session pipeline `./routes.ts` uses. Mounted
// OUTSIDE tenant-session middleware.
//
// Unlike `workflow-capability-routes.ts` (self-DEFINITION scoped: a run
// may only touch its own agent definition), this surface is
// self-TENANT scoped: the caller may pin a skill onto any definition
// that belongs to its own tenant, including a definition someone else
// authored. That is deliberately wider, for the same reason
// `workflow-dispatch-routes.ts`'s file header gives for skipping
// `requireGrant`: `@corbits/skills-tools`' `pin_skill` tool declares
// `approval: "ask"`, so the reactor suspends every call as a pending
// approval and renders it in-chat before this route ever runs — a
// human already approved this exact pin. The human is the authorizer
// here, not a grant row; this route still enforces, unconditionally,
// that the target definition belongs to the authenticated run's own
// tenant and is never a workbench host (the same host guard
// `workflow-capability-routes.ts` applies).
import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { DB } from "@intx/db";
import { workflowDefinition } from "@intx/db/schema";
import type { AssetService } from "@intx/hub-sessions";

import { isWorkbenchHostDefinitionName } from "@corbits/chat/workbench-host-naming";

import { reindexPinnedSkills } from "./agent-workflow";
import { commitLatestAgentAssetSnapshot } from "./asset-write";
import {
  RetiredWorkflowEnvelopeError,
  statusForAgentDefinitionDeployError,
  writeAndDeployAgentDefinition,
  WorkflowAuthorError,
  type AgentDefinitionDeployer,
} from "./definition-asset";
import type { PinnedSkillIndexResolver } from "./routes";
import type { DefinitionSkillsStore } from "./skills-store";
import { makeErrorEnvelope } from "@corbits/error-sink";
import type {
  WorkflowCapabilityRunScope,
  WorkflowRunAuthenticator as WorkflowCapabilityRunAuthenticator,
} from "./workflow-capability-routes";

/** Structurally the same run scope `workflow-capability-routes.ts`
 * resolves — reused by type alias rather than a fresh declaration, since
 * this route lives in the same package and there is no cycle risk to
 * avoid (contrast `workflow-dispatch-routes.ts`, which is in a different
 * package and redeclares the shape for that reason). */
export type WorkflowSkillPinRunScope = WorkflowCapabilityRunScope;
export type WorkflowRunAuthenticator = WorkflowCapabilityRunAuthenticator;

export type WorkflowSkillPinEnv = {
  Variables: { workflowSkillPinScope: WorkflowSkillPinRunScope };
};

function definitionNotFound(definitionId: string) {
  return makeErrorEnvelope({
    code: "not_found",
    userMessage: `No agent definition "${definitionId}" in this workbench`,
  });
}

/** Same host-guard `./routes.ts`/`./workflow-capability-routes.ts`
 * apply: a workbench host is never a target a workflow run may mutate
 * through this surface either. Duplicated rather than imported since
 * `workflow-capability-routes.ts` does not export its own copy. */
function hostGuardedRow(
  row: { readonly name: string; readonly assetId: string | null } | undefined,
): row is { readonly name: string; readonly assetId: string } {
  return (
    row !== undefined &&
    row.assetId !== null &&
    !isWorkbenchHostDefinitionName(row.name)
  );
}

const PinBody = type({
  definitionId: "string > 0",
  skillName: "string > 0",
});

export type CreateWorkflowSkillPinRoutesDeps = {
  db: DB["db"];
  assetService: AssetService;
  skillIndex: PinnedSkillIndexResolver;
  skillsStore: DefinitionSkillsStore;
  authenticator: WorkflowRunAuthenticator;
  /** Deploys the definition's commit through the native source pipeline
   * after the rewrite; the composition root injects the SAME
   * `WorkflowDeployer` `@corbits/workflows`'s `./authoring`'s registry
   * calls. */
  deployer: AgentDefinitionDeployer;
};

export function createWorkflowSkillPinRoutes(
  deps: CreateWorkflowSkillPinRoutesDeps,
): Hono<WorkflowSkillPinEnv> {
  const app = new Hono<WorkflowSkillPinEnv>();

  // A definition whose asset predates the source-form cutover cannot be
  // read or re-pinned until it is re-authored — a client-visible
  // conflict, never a server fault.
  app.onError((err, c) => {
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
    c.set("workflowSkillPinScope", scope);
    await next();
  });

  app.post("/pin", async (c) => {
    const scope = c.get("workflowSkillPinScope");
    const body = PinBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid pin: ${body.summary}`,
        }),
        400,
      );
    }

    const row = await deps.db.query.workflowDefinition.findFirst({
      where: and(
        eq(workflowDefinition.id, body.definitionId),
        eq(workflowDefinition.tenantId, scope.tenantId),
      ),
    });
    if (!hostGuardedRow(row)) {
      return c.json(definitionNotFound(body.definitionId), 404);
    }

    const next = await commitLatestAgentAssetSnapshot({
      assetService: deps.assetService,
      assetId: row.assetId,
      operation: "pin skill",
      prepare: async (snapshot) => {
        const skills = await deps.skillsStore.getSkills(row.assetId);
        const nextSkills = skills.includes(body.skillName)
          ? skills
          : [...skills, body.skillName];
        return {
          workflowJson: reindexPinnedSkills(
            snapshot,
            await deps.skillIndex.resolve(
              scope.tenantId,
              scope.principalId,
              nextSkills,
            ),
          ),
          message: `Pin ${body.skillName} skill to ${row.name}`,
          afterWrite: () => deps.skillsStore.setSkills(row.assetId, nextSkills),
          result: { skills: nextSkills },
        };
      },
      write: async ({ workflowJson, message }) => {
        await writeAndDeployAgentDefinition({
          assetService: deps.assetService,
          deployer: deps.deployer,
          tenantId: scope.tenantId,
          principalId: scope.principalId,
          assetId: row.assetId,
          handle: row.name,
          workflowJson,
          message,
        });
      },
    });

    return c.json(next);
  });

  return app;
}
