// The Routines page's seam to authored workflow definitions that carry a
// ScheduleTrigger: list, run-now, and pause/resume. Pause/resume is the
// same agent-directory status PUT seed uses (`stopped` / `deployed`).

import { type } from "arktype";
import type { ArkErrors } from "arktype";
import { useQuery } from "@tanstack/react-query";
import type { APIQuery } from "@corbits/api-query";
import {
  ApiQueryError,
  UnauthenticatedError,
  toAPIQuery,
} from "@corbits/api-query";

import { setAgentDefinitionStatus } from "./agents-api";

export const ScheduledWorkflowDefinition = type({
  definitionId: "string",
  assetId: "string",
  name: "string",
  tenantId: "string",
  status: "'deployed' | 'stopped'",
  cron: "string",
  createdAt: "string",
  updatedAt: "string",
});

export type ScheduledWorkflowDefinition =
  typeof ScheduledWorkflowDefinition.infer;

const ScheduledWorkflowsResponse = type({
  items: ScheduledWorkflowDefinition.array(),
});

export const AvailableCatalogWorkflow = type({
  assetName: "string",
  displayName: "string",
  description: "string",
  requiredConnections: "string[]",
  missingConnections: "string[]",
  connectionsSatisfied: "boolean",
  deployable: "boolean",
  "notDeployableReason?": "'credential_bindings_unsupported'",
});

export type AvailableCatalogWorkflow = typeof AvailableCatalogWorkflow.infer;

const AvailableCatalogWorkflowsResponse = type({
  items: AvailableCatalogWorkflow.array(),
});

const RunNowResponse = type({ runId: "string" });

type Validator<T> = (data: unknown) => T | ArkErrors;

async function request<T>(
  path: string,
  schema: Validator<T>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  } catch (cause) {
    throw new ApiQueryError(
      cause instanceof Error ? cause.message : String(cause),
      undefined,
      path,
    );
  }
  if (response.status === 401) {
    throw new ApiQueryError("Not signed in.", 401, path);
  }
  if (!response.ok) {
    const detail = await response
      .json()
      .then(
        (body: { error?: { userMessage?: string } }) =>
          body.error?.userMessage ?? "",
      )
      .catch(() => "");
    throw new ApiQueryError(
      detail === "" ? `The server answered ${response.status}.` : detail,
      response.status,
      path,
    );
  }
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = schema(body);
  if (parsed instanceof type.errors) {
    throw new ApiQueryError(
      `Unexpected response shape: ${parsed.summary}`,
      undefined,
      path,
    );
  }
  return parsed;
}

export function scheduledWorkflowsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/workflows/scheduled`;
}

export function availableCatalogWorkflowsPath(tenantId: string): string {
  return `/api/tenants/${tenantId}/workflows/available`;
}

export function listAvailableCatalogWorkflows(
  tenantId: string,
): Promise<readonly AvailableCatalogWorkflow[]> {
  return request(
    availableCatalogWorkflowsPath(tenantId),
    AvailableCatalogWorkflowsResponse,
  ).then((page) => page.items);
}

export function scheduledWorkflowRunPath(
  tenantId: string,
  definitionId: string,
): string {
  return `/api/tenants/${tenantId}/workflows/scheduled/${encodeURIComponent(definitionId)}/run`;
}

export function listScheduledWorkflows(
  tenantId: string,
): Promise<readonly ScheduledWorkflowDefinition[]> {
  return request(
    scheduledWorkflowsPath(tenantId),
    ScheduledWorkflowsResponse,
  ).then((page) => page.items);
}

export function runScheduledWorkflowNow(
  tenantId: string,
  definitionId: string,
): Promise<{ runId: string }> {
  return request(
    scheduledWorkflowRunPath(tenantId, definitionId),
    RunNowResponse,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export function setScheduledWorkflowStatus(
  tenantId: string,
  definitionId: string,
  status: "deployed" | "stopped",
): Promise<{ readonly status: string }> {
  return setAgentDefinitionStatus(tenantId, definitionId, status);
}

/**
 * Tenant-scoped query via TanStack Query. Keys must be stable arrays that
 * already include the tenant id under the `["tenant", tenantId, ...]`
 * convention so a bench switch can `removeQueries` the whole prefix.
 * When `enabled` is false the previous result is not kept on screen — TQ
 * drops the active fetch and the adapter reports loading until re-enabled.
 */
export function useTenantQuery<T>(
  key: readonly unknown[],
  enabled: boolean,
  fetcher: () => Promise<T>,
): APIQuery<T> {
  const result = useQuery({
    queryKey: key,
    enabled,
    queryFn: async () => {
      try {
        return await fetcher();
      } catch (cause) {
        if (cause instanceof ApiQueryError && cause.status === 401) {
          throw new UnauthenticatedError();
        }
        throw cause;
      }
    },
  });
  return toAPIQuery(result);
}
