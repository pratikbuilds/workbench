// The Granola webhook card's seam to `@corbits/webhook-triggers`'
// management routes (mint/rotate a signed inbound address). Nothing here
// adds a route — listings, create, and rotate already exist; this module
// only shapes the fetch calls, `connections-api.ts`-style: same wrapper,
// same error class convention, arktype at the trust boundary.
//
// `packages/settings-ui` never imports `apps/web/src/webhook-triggers-api.ts`
// — apps depend on packages, never the reverse — so this duplicates the
// same thin-client shape that module already uses, trimmed to only the
// fields the Granola card reads.
//
// A webhook trigger's secret is never stored beyond the component state
// that shows it once: the hub returns it only on create or rotate, never
// on a list/get read. See `packages/webhook-triggers/src/management-routes.ts`.

import { type } from "arktype";

import { apiRequest, type Validator } from "./api-request";

export class GranolaWebhookApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function request<T>(
  path: string,
  schema: Validator<T>,
  verb: string,
  init?: RequestInit,
): Promise<T> {
  return apiRequest(path, schema, verb, GranolaWebhookApiError, init);
}

const WebhookTriggerFields = {
  id: "string",
  name: "string",
  workflowDefinitionId: "string",
  enabled: "boolean",
  createdAt: "string",
  lastFiredAt: "string | null",
} as const;

export const GranolaWebhookTrigger = type(WebhookTriggerFields);
export type GranolaWebhookTrigger = typeof GranolaWebhookTrigger.infer;

const GranolaWebhookTriggerWithSecret = type({
  ...WebhookTriggerFields,
  secret: "string",
});
export type GranolaWebhookTriggerWithSecret =
  typeof GranolaWebhookTriggerWithSecret.infer;

export function listGranolaWebhookTriggers(
  tenantId: string,
): Promise<readonly GranolaWebhookTrigger[]> {
  return request(
    `/api/tenants/${tenantId}/webhook-triggers`,
    type({ items: GranolaWebhookTrigger.array() }),
    "loading webhooks",
  ).then((page) => page.items);
}

/** Default input mapping — a webhook trigger sends a fixed
 * message rather than an editable template; see
 * `packages/webhook-triggers/src/mapping.ts` and
 * `apps/web/src/webhook-triggers-api.ts`'s identical constant. */
const DEFAULT_WEBHOOK_INPUT_TEMPLATE = "New webhook delivery.";

export function createGranolaWebhookTrigger(
  tenantId: string,
  workflowDefinitionId: string,
  name: string,
): Promise<GranolaWebhookTriggerWithSecret> {
  return request(
    `/api/tenants/${tenantId}/webhook-triggers`,
    GranolaWebhookTriggerWithSecret,
    "creating that webhook",
    {
      method: "POST",
      body: JSON.stringify({
        name,
        workflowDefinitionId,
        inputTemplate: DEFAULT_WEBHOOK_INPUT_TEMPLATE,
      }),
    },
  );
}

export function rotateGranolaWebhookTriggerSecret(
  tenantId: string,
  id: string,
): Promise<GranolaWebhookTriggerWithSecret> {
  return request(
    `/api/tenants/${tenantId}/webhook-triggers/${id}/rotate-secret`,
    GranolaWebhookTriggerWithSecret,
    "rotating that secret",
    { method: "POST", body: JSON.stringify({}) },
  );
}

/** The URL a sender posts deliveries to — a pure function of the trigger
 * id and origin, matching `POST /api/webhooks/:triggerId`
 * (`packages/webhook-triggers/src/ingress-routes.ts`). No route returns
 * it; every caller builds it client-side. */
export function webhookTriggerUrl(triggerId: string): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `${origin}/api/webhooks/${triggerId}`;
}

/** An illustrative example of a POST body Granola might send — pure
 * documentation, matching `webhook-triggers-api.ts`'s
 * `sampleWebhookPayload`. `@corbits/webhook-triggers` places no
 * constraint on payload shape beyond "valid JSON". */
export function sampleGranolaWebhookPayload(): string {
  return JSON.stringify(
    { event: "call.completed", data: { callId: "call_123" } },
    null,
    2,
  );
}

const WorkflowDefinitionSummary = type({
  id: "string",
  name: "string",
});
export type WorkflowDefinitionSummary = typeof WorkflowDefinitionSummary.infer;

const WorkflowDefinitionRecord = type({
  id: "string",
  name: "string",
  status: "string",
  "description?": "string | null",
});

const DefinitionsPage = type({
  data: WorkflowDefinitionRecord.array(),
  "nextCursor?": "string | null",
});

const PAGE_LIMIT = 100;

/**
 * Every workflow definition on the tenant, walking pagination, reduced to
 * `{id, name}` — enough to find which definition id(s) belong to the
 * `granola-call` asset. Walks the platform's raw definitions listing
 * without extra filtering, which the card doesn't need.
 */
export async function listGranolaWorkflowDefinitions(
  tenantId: string,
): Promise<readonly WorkflowDefinitionSummary[]> {
  const collected: WorkflowDefinitionSummary[] = [];
  let cursor: string | null = null;
  for (;;) {
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor !== null) query.set("cursor", cursor);
    const page = await request(
      `/api/tenants/${tenantId}/workflows/definitions?${query}`,
      DefinitionsPage,
      "loading workflow definitions",
    );
    collected.push(...page.data.map(({ id, name }) => ({ id, name })));
    if (page.nextCursor === undefined || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return collected;
}
