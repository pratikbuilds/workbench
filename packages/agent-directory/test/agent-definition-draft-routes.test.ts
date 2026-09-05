// Draft-route envelope (CL-6749): a fail-closed Myra draft answers the
// canonical `{ code, userMessage, refId }` envelope, reports through
// `reportError` so the person can quote the same id, and never puts a
// legacy `{ code, message }` body — or a stack — on the wire.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { configureSync, resetSync } from "@intx/log";

import type { RequireGrant, TenantEnv } from "@intx/hub-api";
import { makeErrorEnvelope, parseErrorEnvelope } from "@corbits/error-sink";

import { MyraAgentDefinitionDraftingUnavailableError } from "../src/agent-definition-drafting";
import { createAgentDefinitionDraftRoutes } from "../src/agent-definition-draft-routes";

const TENANT = {
  id: "tnt_1",
  name: "Acme",
  slug: "acme",
  domain: "acme.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const PRINCIPAL = {
  id: "prn_1",
  tenantId: TENANT.id,
  kind: "user" as const,
  refId: "prn_1",
  status: "active" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const allowAll: RequireGrant = () => async (_c, next) => {
  await next();
};

const DRAFT_FAILED_MESSAGE =
  "Myra couldn't draft a starting prompt for that. Write one yourself, or try again.";

function buildApp(
  draftAgentDefinition?: (input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly name: string;
    readonly purpose?: string;
  }) => Promise<{
    readonly systemPrompt: string;
    readonly toolPackagePins: readonly string[];
    readonly skills: readonly string[];
  }>,
): Hono<TenantEnv> {
  const routes = createAgentDefinitionDraftRoutes({
    requireGrant: allowAll,
    ...(draftAgentDefinition !== undefined ? { draftAgentDefinition } : {}),
  });
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", PRINCIPAL);
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}

async function postDraft(
  app: Hono<TenantEnv>,
  body: unknown,
): Promise<Response> {
  return app.request("/agent-definitions/draft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let records: { properties: Record<string, unknown> }[];

function installCapturingSink(): void {
  records = [];
  configureSync({
    reset: true,
    sinks: {
      capture: (record) => {
        records.push(record as { properties: Record<string, unknown> });
      },
    },
    loggers: [
      { category: ["errors"], sinks: ["capture"], lowestLevel: "debug" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "warning" },
    ],
  });
}

beforeEach(() => installCapturingSink());
afterEach(() => resetSync());

describe("agent-definition draft route envelope", () => {
  test("a drafting failure answers 422 makeErrorEnvelope and reports the same refId", async () => {
    const app = buildApp(() =>
      Promise.reject(
        new MyraAgentDefinitionDraftingUnavailableError("tnt_1", "no myra"),
      ),
    );

    const res = await postDraft(app, { name: "Research Buddy" });

    expect(res.status).toBe(422);
    const body: unknown = await res.json();
    const envelope = parseErrorEnvelope(body);
    expect(envelope).toBeDefined();
    expect(envelope?.error.code).toBe("drafting_failed");
    expect(envelope?.error.userMessage).toBe(DRAFT_FAILED_MESSAGE);
    expect(typeof envelope?.error.refId).toBe("string");
    expect(envelope?.error.refId.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("no myra");
    expect(JSON.stringify(body)).not.toContain("stack");
    expect(
      (body as { error: { message?: unknown } }).error.message,
    ).toBeUndefined();

    expect(records).toHaveLength(1);
    expect(records[0]?.properties.refId).toBe(envelope?.error.refId);
    expect(records[0]?.properties.operation).toBe(
      "agentDirectory.draftAgentDefinition",
    );
    expect(records[0]?.properties.tenantId).toBe("tnt_1");
  });

  test("a malformed body answers 400 makeErrorEnvelope, not {code, message}", async () => {
    const app = buildApp(() =>
      Promise.resolve({
        systemPrompt: "unused",
        toolPackagePins: [],
        skills: [],
      }),
    );

    const res = await postDraft(app, {});
    expect(res.status).toBe(400);
    const body: unknown = await res.json();
    const envelope = parseErrorEnvelope(body);
    expect(envelope).toBeDefined();
    expect(envelope?.error.code).toBe("bad_request");
    expect(envelope?.error.userMessage.length).toBeGreaterThan(0);
    expect(
      (body as { error: { message?: unknown } }).error.message,
    ).toBeUndefined();
  });

  test("an unexpected throw is not mapped to drafting_failed", async () => {
    const app = buildApp(() => Promise.reject(new Error("disk full")));
    app.onError((_err, c) =>
      c.json(
        makeErrorEnvelope({
          code: "internal_error",
          userMessage: "Something went wrong. Please try again.",
        }),
        500,
      ),
    );
    const res = await postDraft(app, { name: "Research Buddy" });
    expect(res.status).toBe(500);
    const body: unknown = await res.json();
    const envelope = parseErrorEnvelope(body);
    expect(envelope?.error.code).toBe("internal_error");
  });
});
