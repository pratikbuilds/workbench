// The instantiate path's block-workflow deploy surface (CL-6405):
// `instantiateWorkbenchTemplate`'s `deployBlockWorkflow` port binds to
// `POST /:assetName/deploy` here, the way its `createParticipantAgent`
// port binds to `POST /agent-definitions`. Mounted per-tenant inside
// the platform's native tenant middleware, mirroring
// `./connect-github-routes.ts`: every side effect a host needs — the
// tenant's default inference preferences, and the actual source-form
// asset write + `workflow_definition` projection — arrives as an
// injected port, so `apps/hub` is the only place drizzle and the
// `AssetService` are touched and this stays testable with plain fakes.
import { Hono } from "hono";
import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { makeErrorEnvelope } from "@corbits/error-sink";
import { catalogWorkflowDeployableOnThisPin } from "@corbits/seeding";

import {
  buildBlockWorkflowSource,
  type BlockWorkflowBuildInput,
} from "./block-workflows";

const DEPLOY_FAILED_MESSAGE =
  "Couldn't set up this template's workflow. Try again in a moment.";

// Six catalog workflows carry `credentialBindings` their definition needs
// resolved at deploy time; this pin's `deployWorkflowSource` port has no
// `credentialCipher` seam to resolve them (see
// `catalogWorkflowDeployableOnThisPin`, `docs/seed-reconciliation.md`).
// Refusing here, before `deployWorkflowSource` is ever called, keeps that
// gap an honest 409 instead of the deployer throwing into the 500 branch
// below.
const NOT_DEPLOYABLE_YET_MESSAGE = "Coming with the next platform update.";

export type TemplateBlockRoutesDeps = {
  requireGrant: RequireGrant;
  /** Where a failure's real cause goes — the same CL-6360 idiom
   * `./connect-github-routes.ts` documents: the client sees one honest
   * `userMessage`, the raw detail lands here. */
  log: (line: string) => void;
  /** The tenant's default inference preferences — the same resolution a
   * fresh workbench host launches against (`@corbits/chat`'s
   * `createWorkbenchHostInferencePreferencesResolver`), so a deployed
   * block runs on the model the bench actually connected. */
  inferencePreferences(
    tenantId: string,
  ): Promise<BlockWorkflowBuildInput["inferencePreferences"]>;
  /** The source-form deploy itself: renders `workflowJson` into a
   * `@corbits/workflows`'s `./source` tree on a `workflow`-kind asset and
   * projects it onto a `workflow_definition` row — the exact
   * materialization `createAgentDefinitionCore` runs for a participant
   * agent, minus its agent-only prompt/skills machinery. `created` is
   * `false` when the tenant already carries a deployed definition under
   * `assetName` (the port skips instead of double-deploying). */
  deployWorkflowSource(args: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly assetName: string;
    readonly displayName: string;
    readonly workflowJson: string;
  }): Promise<{ readonly id: string; readonly created: boolean }>;
};

export function createTemplateBlockRoutes(
  deps: TemplateBlockRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.post(
    "/:assetName/deploy",
    deps.requireGrant("workflow:*", "create"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const assetName = c.req.param("assetName");

      const source = buildBlockWorkflowSource(assetName, {
        tenantDomain: tenant.domain,
        inferencePreferences: await deps.inferencePreferences(tenant.id),
      });
      if (source === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: `"${assetName}" isn't a deployable template workflow.`,
          }),
          404,
        );
      }

      if (!catalogWorkflowDeployableOnThisPin(assetName)) {
        return c.json(
          makeErrorEnvelope({
            code: "not_deployable_yet",
            userMessage: NOT_DEPLOYABLE_YET_MESSAGE,
          }),
          409,
        );
      }

      try {
        const result = await deps.deployWorkflowSource({
          tenantId: tenant.id,
          principalId: principal.id,
          assetName: source.assetName,
          displayName: source.displayName,
          workflowJson: source.workflowJson,
        });
        return c.json(
          { id: result.id, created: result.created },
          result.created ? 201 : 200,
        );
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        deps.log(
          `template-blocks: deploying "${assetName}" failed for tenant ${tenant.id}: ${message}`,
        );
        return c.json(
          makeErrorEnvelope({
            code: "deploy_failed",
            userMessage: DEPLOY_FAILED_MESSAGE,
          }),
          500,
        );
      }
    },
  );

  return app;
}
