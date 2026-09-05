// The wire shape for `GET /api/tenants/:tenantId/workflows/definitions/
// :definitionAssetId/detail` (`./detail-route.ts`) — a definition's own
// page reads this and nothing else. Pure/browser-safe: no `@intx/*`, no
// `drizzle-orm`, no `hono` — the same promise `@corbits/workflows/client`
// makes, so `apps/web` can import it directly.
import { type } from "arktype";

export const WorkflowDetailStep = type({
  id: "string",
  role: "string",
  "director?": "string | null",
  "model?": "string | null",
  toolPins: "string[]",
  grants: "string[]",
});
export type WorkflowDetailStep = typeof WorkflowDetailStep.infer;

export const WorkflowDetailSource = type({
  commitSha: "string",
  entry: "string",
  origin: "string",
});
export type WorkflowDetailSource = typeof WorkflowDetailSource.infer;

export const WorkflowDefinitionDetail = type({
  definitionAssetId: "string",
  assetName: "string",
  displayName: "string",
  "description?": "string | null",
  lifecycle:
    "'source-only' | 'pending-approval' | 'deployed' | 'superseded' | 'build-failed'",
  "currentDefinitionId?": "string | null",
  "wireHash?": "string | null",
  "source?": WorkflowDetailSource.or("null"),
  steps: WorkflowDetailStep.array(),
  grants: {
    declared: "string[]",
    approved: "string[]",
  },
  credentialBindings: "string[]",
});
export type WorkflowDefinitionDetail = typeof WorkflowDefinitionDetail.infer;

/** Copy for the "why not launchable" strip — the next honest action for
 * every lifecycle short of `deployed`. `null` for `deployed`: nothing to
 * say, the strip does not render. */
export function workflowNotLaunchableReason(
  lifecycle: WorkflowDefinitionDetail["lifecycle"],
): string | null {
  switch (lifecycle) {
    case "deployed":
      return null;
    case "source-only":
      return "This workflow's source has never been deployed — deploy it to make it launchable.";
    case "pending-approval":
      return "A deploy is waiting on human approval before it can run.";
    case "superseded":
      return "A newer deploy replaced this one — redeploy or roll forward to make it launchable again.";
    case "build-failed":
      return "The last deploy attempt did not produce a runnable definition — check the deploy and try again.";
  }
}

export function workflowDetailPath(definitionAssetId: string): string {
  return `/workflows/${encodeURIComponent(definitionAssetId)}`;
}
