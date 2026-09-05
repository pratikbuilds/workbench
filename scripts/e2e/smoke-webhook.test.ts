// Smoke scenario 5/5 (CL-6004): webhook trigger. A workflow is bound to
// a `@corbits/webhook-triggers` row instead of a cadence; a correctly
// HMAC-signed payload delivered to the public ingress route launches a
// run. Zero-cost like `scripts/e2e/workbench-digest.test.ts`: the
// deployed workflow's only inference source is the hub's own
// noop-inference endpoint, so nothing here ever calls a real model
// provider.
//
// A webhook-fired run launches a standalone folded run via
// `@corbits/folded-runs` (see `packages/webhook-triggers/src/launch.ts`).
// There is no platform route that reads an arbitrary non-anchored run's
// events by bare id (the native events route requires a deployment-anchor
// run). This test instead reads the run row the ingress delivery created
// straight out of the database — a harness-side fact with no route,
// exactly as `provisionSidecar` already does for the sidecar identity
// row — and confirms the trigger itself recorded the delivery
// (`lastFiredAt`).

import {
  signPayload,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "@corbits/webhook-triggers";
import { describe, expect, test } from "bun:test";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  buildHeartbeatWorkflow,
  serializeHeartbeatWorkflow,
} from "../../workflows/heartbeat/src/index.ts";
import {
  api,
  assertNeverRealProvider,
  connectE2eDb,
  createCleanupHarness,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  hop,
  provisionSidecar,
  pushWorkflowSource,
  workflowDeployBody,
  startHub,
  startSidecar,
  type HubHandle,
} from "./harness.ts";

const { tempDir, track } = createCleanupHarness();

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "smoke-webhook: DATABASE_URL is not set; suite skipped. Set " +
      "DATABASE_URL (see .env.example) to run it; start Postgres with `docker compose -f docker-compose.test.yml up -d` " +
      "so this skip can never pass silently there.",
  );
}

function stringField(data: unknown, field: string, what: string): string {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value !== "") return value;
  }
  throw new Error(
    `${what}: missing string field "${field}": ${JSON.stringify(data)}`,
  );
}

describe.skipIf(databaseUrl === undefined)("smoke: webhook trigger", () => {
  test("a signed webhook delivery launches a run against the bound trigger", async () => {
    const url = databaseUrl;
    if (url === undefined) throw new Error("unreachable: suite is skipped");

    await hop("database setup", async () => {
      await resetSchema(url);
      await setupDatabase(url);
    });

    const hubDataDir = await tempDir("e2e-smoke-webhook-hub-data-");
    const sidecarDataDir = await tempDir("e2e-smoke-webhook-sidecar-data-");

    const sidecarId = "sidecar-e2e-smoke-webhook";
    const sidecarToken = crypto.randomUUID();
    await hop("sidecar provisioning", () =>
      provisionSidecar(url, sidecarId, sidecarToken),
    );

    const hub: HubHandle = await hop("hub boot", () =>
      startHub({
        databaseUrl: url,
        port: freePort(),
        sessionSecret: Buffer.from(
          crypto.getRandomValues(new Uint8Array(32)),
        ).toString("hex"),
        dataDir: hubDataDir,
      }),
    );
    track(hub);

    const sidecar = await hop("sidecar boot", () =>
      Promise.resolve(
        startSidecar({
          hubPort: Number(new URL(hub.baseUrl).port),
          sidecarId,
          token: sidecarToken,
          dataDir: sidecarDataDir,
        }),
      ),
    );
    track(sidecar);

    {
      const cookies = await hop("sign-up", async () => {
        const res = await api(hub.baseUrl, "POST", "/api/auth/sign-up/email", {
          name: "Webhook Smoke Tester",
          email: `smoke-webhook-${crypto.randomUUID()}@example.invalid`,
          password: `pw-${crypto.randomUUID()}`,
        });
        expectStatus("sign-up", res, 200);
        if (res.cookies.length === 0) {
          throw new Error("sign-up returned no session cookie");
        }
        return res.cookies;
      });

      const slug = `smokewh${crypto.randomUUID().slice(0, 8)}`;
      const tenantId = await hop("tenant creation", async () => {
        const res = await api(
          hub.baseUrl,
          "POST",
          "/api/tenants",
          { name: "Webhook Smoke", slug },
          cookies,
        );
        expectStatus("create tenant", res, 201);
        return stringField(res.data, "id", "create tenant");
      });

      // The zero-cost catalog chain: an anthropic-plugin provider whose
      // base URL is the hub's own noop-inference endpoint, never a real
      // model. Mirrors `workbench-digest.test.ts`'s noop catalog seeding.
      const noopBaseUrl = `${hub.baseUrl}/api/chat/noop-inference`;
      assertNeverRealProvider(noopBaseUrl, "noop catalog provider baseURL");
      await hop("noop catalog seeding", async () => {
        const model = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/catalog/models`,
          { canonicalName: "noop" },
          cookies,
        );
        expectStatus("create catalog model", model, 201);
        const modelId = stringField(model.data, "id", "create catalog model");

        const provider = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/providers`,
          { name: "anthropic", plugin: "anthropic" },
          cookies,
        );
        expectStatus("create provider", provider, 201);
        const providerId = stringField(provider.data, "id", "create provider");

        const credential = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/credentials`,
          {
            providerId,
            name: "anthropic-default",
            type: "api_key",
            secret: "noop",
          },
          cookies,
        );
        expectStatus("create credential", credential, 201);
        const credentialId = stringField(
          credential.data,
          "id",
          "create credential",
        );

        const catalogProvider = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/catalog/providers`,
          {
            name: "anthropic",
            plugin: "anthropic",
            baseURL: noopBaseUrl,
            credentialId,
          },
          cookies,
        );
        expectStatus("create catalog provider", catalogProvider, 201);
        const catalogProviderId = stringField(
          catalogProvider.data,
          "id",
          "create catalog provider",
        );

        const offering = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/catalog/offerings`,
          { modelId, providerId: catalogProviderId },
          cookies,
        );
        expectStatus("create catalog offering", offering, 201);
      });

      const assetName = "heartbeat";
      const { assetId, commitSha } = await hop(
        "workflow asset publication",
        async () => {
          const created = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenantId}/assets`,
            { kind: "workflow", name: assetName },
            cookies,
          );
          expectStatus("create workflow asset", created, 201);
          const id = stringField(created.data, "id", "create workflow asset");

          const minted = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenantId}/git-tokens`,
            {
              name: "e2e-smoke-webhook-push",
              resource: "asset:*",
              refPattern: "**",
              actions: ["can_read", "can_push"],
              expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            },
            cookies,
          );
          expectStatus("mint git token", minted, 201);

          const definition = buildHeartbeatWorkflow({
            triggerAddress: `heartbeat@${slug}.localhost`,
            inferencePreferences: [{ provider: "anthropic", model: "noop" }],
            turnTimeoutMs: 30_000,
          });
          const pushed = await pushWorkflowSource({
            baseUrl: hub.baseUrl,
            tenantId,
            assetName,
            tokenSecret: stringField(minted.data, "secret", "mint git token"),
            workflowJson: serializeHeartbeatWorkflow(definition),
          });
          return { assetId: id, commitSha: pushed.commitSha };
        },
      );

      const definitionId = await hop("workflow deploy", async () => {
        const sourceId = "src-smoke-webhook-e2e";
        assertNeverRealProvider(noopBaseUrl, "workflow deploy source baseURL");
        const body = workflowDeployBody({
          assetId,
          commitSha,
          sourceId: sourceId,
          provider: "anthropic",
          baseURL: noopBaseUrl,
          apiKey: "noop",
          model: "noop",
        });
        const deadline = Date.now() + 60_000;
        for (;;) {
          if (sidecar.exited()) {
            throw new Error(
              `sidecar exited before deploy; output:\n${sidecar.output()}`,
            );
          }
          const res = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenantId}/workflows/deployments`,
            body,
            cookies,
          );
          if (res.status === 502) {
            if (Date.now() > deadline) {
              throw new Error(
                `sidecar never became deployable (hub kept answering 502): ${JSON.stringify(res.data)}\nsidecar output:\n${sidecar.output()}`,
              );
            }
            await Bun.sleep(200);
            continue;
          }
          expectStatus("deploy heartbeat workflow", res, 201);
          break;
        }

        const listed = await api(
          hub.baseUrl,
          "GET",
          `/api/tenants/${tenantId}/workflows/definitions`,
          undefined,
          cookies,
        );
        expectStatus("list workflow definitions", listed, 200);
        const rows =
          typeof listed.data === "object" &&
          listed.data !== null &&
          "data" in listed.data
            ? (listed.data as { data: unknown[] }).data
            : (listed.data as unknown[]);
        const heartbeat = (rows as { id: string; name?: string }[]).find(
          (row) => row.name === assetName,
        );
        if (heartbeat === undefined) {
          throw new Error(
            `no workflow definition named "${assetName}": ${JSON.stringify(listed.data)}`,
          );
        }
        return heartbeat.id;
      });

      const { triggerId, secret } = await hop(
        "webhook trigger creation",
        async () => {
          const res = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenantId}/webhook-triggers`,
            {
              name: "Smoke webhook",
              workflowDefinitionId: definitionId,
              inputTemplate: "webhook smoke: {{event}}",
            },
            cookies,
          );
          expectStatus("create webhook trigger", res, 201);
          return {
            triggerId: stringField(res.data, "id", "create webhook trigger"),
            secret: stringField(res.data, "secret", "create webhook trigger"),
          };
        },
      );

      const instanceId = await hop(
        "a correctly signed delivery is accepted and launches a run",
        async () => {
          const rawBody = JSON.stringify({ event: "smoke-test" });
          const timestamp = String(Math.floor(Date.now() / 1000));
          const signature = signPayload(secret, timestamp, rawBody);
          const res = await fetch(`${hub.baseUrl}/api/webhooks/${triggerId}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [WEBHOOK_SIGNATURE_HEADER]: signature,
              [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
            },
            body: rawBody,
          });
          const data = (await res.json()) as {
            instanceId: string;
            address: string;
          };
          if (res.status !== 202) {
            throw new Error(
              `webhook delivery: expected HTTP 202, got ${res.status}: ${JSON.stringify(data)}`,
            );
          }
          if (data.instanceId === "" || data.address === "") {
            throw new Error(
              `webhook delivery response missing instanceId/address: ${JSON.stringify(data)}`,
            );
          }
          return data.instanceId;
        },
      );

      await hop("an incorrectly signed delivery is rejected", async () => {
        const rawBody = JSON.stringify({ event: "forged" });
        const res = await fetch(`${hub.baseUrl}/api/webhooks/${triggerId}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [WEBHOOK_SIGNATURE_HEADER]: "0".repeat(64),
            [WEBHOOK_TIMESTAMP_HEADER]: String(Math.floor(Date.now() / 1000)),
          },
          body: rawBody,
        });
        expect(res.status).toBe(401);
      });

      await hop(
        "the delivery is recorded and a run row exists for the launched instance",
        async () => {
          const triggerRes = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenantId}/webhook-triggers/${triggerId}`,
            undefined,
            cookies,
          );
          expectStatus("get webhook trigger", triggerRes, 200);
          const lastFiredAt = (
            triggerRes.data as { lastFiredAt: string | null }
          ).lastFiredAt;
          if (lastFiredAt === null) {
            throw new Error(
              `webhook trigger lastFiredAt was not recorded after delivery: ${JSON.stringify(triggerRes.data)}`,
            );
          }

          // No platform route reads a non-anchored run's row by bare id
          // (see the file header); this reads the fact the ingress
          // route's own launch is required to have produced, the same
          // way `provisionSidecar` reaches the database directly for a
          // fact no route exposes.
          const sql = await connectE2eDb(url);
          try {
            const rows = await sql.unsafe(
              `SELECT "id", "tenant_id" FROM "workflow_run" WHERE "id" = $1`,
              [instanceId],
            );
            if (rows.length !== 1) {
              throw new Error(
                `expected exactly one workflow_run row for instance ${instanceId}, found ${rows.length}`,
              );
            }
            expect(rows[0]?.["tenant_id"]).toBe(tenantId);
          } finally {
            await sql.end();
          }
        },
      );

      await hop(
        "the run's insights trace reads real spans once the run settles (CL-5910)",
        async () => {
          // The webhook-fired run turns inference against the noop source
          // asynchronously (see the sidecar dial-in above). The run itself
          // (`workflow_run`) is a long-lived folded run that stays
          // "running" indefinitely, the same way a chat workbench does —
          // it is the per-turn `inference_turn` row (written by
          // @intx/hub-sessions' event-collector) that records the turn.
          // Poll straight out of the database (no route reads a
          // non-anchored run's turns by bare id, per the file header)
          // until one exists — the reader must surface it regardless of
          // whether the turn has settled yet, rendering a still-running
          // turn as `awaiting` rather than waiting it out — then assert
          // the mounted RunTraceReader (apps/hub/src/index.ts) surfaces a
          // non-empty, honestly-timed trace through the real HTTP route —
          // never the "run_trace_reader_not_mounted" absent-shape this
          // route used to return unconditionally.
          const sql = await connectE2eDb(url);
          const deadline = Date.now() + 60_000;
          try {
            for (;;) {
              const rows = await sql.unsafe(
                `SELECT "status" FROM "inference_turn" WHERE "instance_id" = $1`,
                [instanceId],
              );
              if (rows.length > 0) break;
              if (Date.now() > deadline) {
                throw new Error(
                  `run ${instanceId} recorded no inference_turn within the deadline`,
                );
              }
              await Bun.sleep(200);
            }
          } finally {
            await sql.end();
          }

          const traceRes = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenantId}/insights/runs/${instanceId}/trace`,
            undefined,
            cookies,
          );
          expectStatus("get run trace", traceRes, 200);
          const trace = traceRes.data as {
            runId: string;
            spans: { id: string; kind: string; phase: string }[];
          };
          expect(trace.runId).toBe(instanceId);
          if (trace.spans.length === 0) {
            throw new Error(
              `run trace came back empty for a run with a recorded turn: ${JSON.stringify(trace)}`,
            );
          }
          const turnSpan = trace.spans.find((span) => span.kind === "turn");
          if (turnSpan === undefined) {
            throw new Error(
              `run trace had no "turn" span: ${JSON.stringify(trace)}`,
            );
          }
          expect(["ok", "awaiting", "failed"]).toContain(turnSpan.phase);
        },
      );

      console.log(
        "smoke-webhook: a signed delivery to the public ingress route " +
          "launched a real run row for a webhook trigger, " +
          "and its insights trace reads back real spans (CL-5910).",
      );
    }
  }, 180_000);
});
