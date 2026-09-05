// Launches a workflow run from a verified webhook delivery, through
// the exact same primitive `@corbits/chat`'s invite flow uses
// (`launchFoldedRun` from `@corbits/folded-runs`) rather than any
// route-internal reimplementation of session orchestration. This
// package never talks to `sessionService`/`sidecarRouter` directly —
// only through `folded-runs`, the shared launch core the platform's
// own `POST /workflows/runs` route is mirrored from.
//
// The post-launch mail send is hardened the same way
// `apps/hub/src/routine-launcher.ts` hardens its own identical shape
// (both call the one shared `sendFoldedMailWithRetry` seam in
// `@corbits/folded-runs`, so this is one behavior, not two copies of
// it): a delivery already accepted (202) has already committed a real
// run by the time this function's own `sendFoldedMailWithRetry` call
// runs, so a delivery-failed mail must not throw past
// `createWebhookIngressRoutes` — that would both hide the run (no
// `store.recordFired` call) and, if the sender's webhook client retries
// the same delivery on a 5xx, mint a second, duplicate run for one
// event. On exhausted retries this only reports the failure through
// `@corbits/error-sink`, naming the run.
import { reportError } from "@corbits/error-sink";
import { and, eq } from "drizzle-orm";
import {
  domainOf,
  launchFoldedRun,
  readDefinitionProjection,
  readFoldedBody,
  sendFoldedMailWithRetry,
  tagCredentialCipher,
  type FoldedRunMode,
  type FoldedRunsDeps,
  type LaunchFoldedRunParams,
  type CryptoProviderCache,
} from "@corbits/folded-runs";
import type { DB } from "@intx/db";
import { tenant as tenantTable, workflowDefinition } from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import { formatRunAddress, type CredentialCipher } from "@intx/types";

import { renderInputTemplate } from "./mapping";
import type { WebhookTriggerRow } from "./schema";

export type LaunchWebhookTriggerDeps = FoldedRunsDeps & {
  db: DB["db"];
  cryptoProviderCache: CryptoProviderCache;
  /**
   * Decrypts catalog secrets when the launched run resolves inference
   * sources. Required: a webhook launch always goes through
   * `launchFoldedRun`, and omitting the cipher would hand ciphertext to
   * the provider as an API key. Tagged at entry — missing or wrong-shape
   * input fails closed before any launch work.
   */
  credentialCipher: CredentialCipher;
  /**
   * The shape the launched run deploys as — the host wires this to
   * `@corbits/chat`'s `AGENT_SECTION_MODE`, the same `onTrigger`
   * section every room-invited agent deploys as (CL-6329). Injected
   * rather than imported because this package depends on
   * `@corbits/folded-runs` alone, never on chat.
   */
  launchMode: FoldedRunMode;
  /**
   * Builds the `persistExtra` the launch commits atomically with its
   * run rows — the host wires this to `@corbits/chat`'s
   * `workbenchLaunchPersistExtra`, the stable-id → current-run mapping
   * chat's relaunch machinery resolves through. Without it a run that
   * dies with its sidecar can never be relaunched: nothing maps a
   * stable participant id onto it (CL-6367).
   */
  persistLaunch: (input: {
    readonly tenantId: string;
    readonly instanceId: string;
    readonly foldedBody: LaunchFoldedRunParams["foldedBody"];
  }) => NonNullable<LaunchFoldedRunParams["persistExtra"]>;
  /**
   * Records the inference chain the launch just deployed with on that
   * same mapping row — the host wires this to `@corbits/chat`'s
   * `recordSourcesDigest`. `persistLaunch` runs before the deploy
   * resolves the chain, so the digest lands in a second write; without
   * it a rotated provider key never reaches this run (CL-6687).
   */
  recordLaunchSources: (input: {
    readonly instanceId: string;
    readonly sourcesDigest: string;
  }) => Promise<void>;
};

export type LaunchedWebhookTrigger = {
  readonly instanceId: string;
  readonly triggerAddress: string;
};

/**
 * Resolves the trigger's referenced workflow definition (must be
 * deployed and materialized, same precondition `@corbits/chat`'s
 * `launchInvite` enforces), launches it via `launchFoldedRun`, then
 * delivers the rendered input mapping as the run's first inbound
 * message via `sendFoldedMailWithRetry` — the same mail primitive a
 * chat message send uses, bounded-retried rather than a bare send (see
 * the module doc comment). The webhook sender itself is never a
 * principal on the platform, so the mail's `from` names the trigger,
 * not a person.
 */
export async function launchWebhookTrigger(
  deps: LaunchWebhookTriggerDeps,
  trigger: WebhookTriggerRow,
  payload: unknown,
): Promise<LaunchedWebhookTrigger> {
  const credentialCipher = tagCredentialCipher(deps.credentialCipher);
  const launchDeps = { ...deps, credentialCipher };

  const definitionRow = await launchDeps.db.query.workflowDefinition.findFirst({
    where: and(
      eq(workflowDefinition.id, trigger.workflowDefinitionId),
      eq(workflowDefinition.tenantId, trigger.tenantId),
    ),
  });
  if (definitionRow === undefined) {
    throw new Error(
      `webhook trigger "${trigger.id}" names no workflow definition ` +
        `"${trigger.workflowDefinitionId}" for its tenant`,
    );
  }
  if (definitionRow.status !== "deployed") {
    throw new Error(
      `workflow definition "${trigger.workflowDefinitionId}" is not in a ` +
        `launchable state (status: ${definitionRow.status})`,
    );
  }
  if (definitionRow.assetId === null) {
    throw new Error(
      `workflow definition "${trigger.workflowDefinitionId}" has not been ` +
        "materialized",
    );
  }

  const tenantRow = await launchDeps.db.query.tenant.findFirst({
    where: eq(tenantTable.id, trigger.tenantId),
  });
  if (tenantRow === undefined) {
    throw new Error(`no tenant "${trigger.tenantId}"`);
  }

  const projection = await readDefinitionProjection(
    launchDeps.db,
    definitionRow,
  );
  const foldedBody = readFoldedBody(
    projection,
    definitionRow.grantRequirements,
  );
  if (foldedBody.systemPrompt === "") {
    throw new Error(
      `workflow definition "${trigger.workflowDefinitionId}" cannot be ` +
        "launched without a system prompt configured",
    );
  }

  const instanceId = generateId("workflowRun");
  const triggerAddress = formatRunAddress(instanceId, tenantRow.domain);

  const launched = await launchFoldedRun(launchDeps, {
    tenantId: trigger.tenantId,
    instanceId,
    triggerAddress,
    definitionId: trigger.workflowDefinitionId,
    foldedBody,
    launchLabel: `webhook trigger "${trigger.name}"`,
    mode: launchDeps.launchMode,
    persistExtra: launchDeps.persistLaunch({
      tenantId: trigger.tenantId,
      instanceId,
      foldedBody,
    }),
  });
  await launchDeps.recordLaunchSources({
    instanceId,
    sourcesDigest: launched.sourcesDigest,
  });

  const content = renderInputTemplate(trigger.inputTemplate, payload);
  // Keyed by the launched run's instance id (`generateId("workflowRun")`),
  // the same string shape chat uses for workbench ids — share the host's
  // process-wide cache so those lookups cannot mint different keys.
  const cryptoProvider = await launchDeps.cryptoProviderCache.get(instanceId);
  const result = await sendFoldedMailWithRetry(launchDeps, {
    tenantId: trigger.tenantId,
    sessionId: launched.sessionId,
    agentAddress: triggerAddress,
    from: `webhook-trigger:${trigger.id}`,
    domain: domainOf(triggerAddress),
    content,
    cryptoProvider,
  });
  if (!result.ok) {
    reportError(result.error, {
      operation: "webhookTriggers.launch.deliverInput",
      tenantId: trigger.tenantId,
      agentId: triggerAddress,
      extra: {
        instanceId,
        triggerId: trigger.id,
        attempts: result.attempts,
      },
    });
  }

  return { instanceId, triggerAddress };
}
