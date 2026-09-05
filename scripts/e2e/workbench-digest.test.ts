// A light end-to-end smoke test for the workbench-digest workflow: the
// real hub and sidecar as spawned processes against a real Postgres, a
// workbench-digest deployment whose inference source is the hub's own
// `noop-inference` endpoint (not a placeholder, not a real provider),
// and a trigger that runs the step to completion.
//
// This is the proof-by-construction that workbench-digest costs nothing
// to run frequently: the deploy's source is a real, reachable endpoint
// (unlike the walking skeleton's `https://inference.invalid`
// placeholder), so a run started against it actually resolves its
// inference call — against `noop-inference`'s constant, locally
// served reply, never a real model.

import { describe, test } from "bun:test";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  WORKBENCH_DIGEST_STEP_ID,
  buildWorkbenchDigestWorkflow,
  serializeWorkbenchDigestWorkflow,
} from "../../workflows/workbench-digest/src/index.ts";
import {
  api,
  createCleanupHarness,
  e2eDatabaseUrl,
  expectStatus,
  expectStepCompleted,
  freePort,
  hop,
  provisionSidecar,
  pushWorkflowSource,
  workflowDeployBody,
  startHub,
  startSidecar,
  waitForRunCompletion,
  type ApiResult,
  type HubHandle,
} from "./harness.ts";

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "workbench-digest: DATABASE_URL is not set; suite skipped. " +
      "Set DATABASE_URL (see .env.example) to run it; " +
      "start Postgres with `docker compose -f docker-compose.test.yml up -d`.",
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

function runIds(data: unknown): string[] {
  if (
    typeof data === "object" &&
    data !== null &&
    "runIds" in data &&
    Array.isArray((data as Record<string, unknown>)["runIds"])
  ) {
    return (data as { runIds: unknown[] }).runIds.filter(
      (id): id is string => typeof id === "string",
    );
  }
  throw new Error(`expected a runIds array: ${JSON.stringify(data)}`);
}

/**
 * `waitForRunCompletion` must outlive the step timeout. When both were
 * 30s, a turn that ran to its own timeout was reported as "no terminal
 * event" (RunStarted + StepStarted only) instead of RunFailed. The step
 * timeout stays 30s to match seed and heartbeat; the waiter is longer so
 * a 30s step kill is observed as RunFailed.
 */
const DIGEST_TURN_TIMEOUT_MS = 30_000;
const DIGEST_RUN_COMPLETION_TIMEOUT_MS = 60_000;

const { tempDir, track } = createCleanupHarness();

describe.skipIf(databaseUrl === undefined)("workbench-digest workflow", () => {
  // Previously skipped (CL-6004): the same upstream defect documented in
  // heartbeat.test.ts — the first mail trigger against a freshly deployed
  // single-step workflow deterministically failed with RunFailed / "one or
  // more steps failed" regardless of step timeout length, confirming the
  // defect was systemic to the mail-triggered single-step deploy path in
  // vendor/intx/hub-sessions, not heartbeat-specific. Now fixed in the
  // vendored tree (see `docs/revendor-inventory.md`).
  test("launching workbench-digest against the hub's own noop-inference endpoint completes a run", async () => {
    const url = databaseUrl;
    if (url === undefined) throw new Error("unreachable: suite is skipped");

    await hop("database setup", async () => {
      await resetSchema(url);
      await setupDatabase(url);
    });

    const sidecarId = "sidecar-e2e-workbench-digest";
    const sidecarToken = crypto.randomUUID();
    await hop("sidecar provisioning", () =>
      provisionSidecar(url, sidecarId, sidecarToken),
    );

    const hub: HubHandle = await hop("hub boot", async () => {
      const handle = await startHub({
        databaseUrl: url,
        port: freePort(),
        sessionSecret: Buffer.from(
          crypto.getRandomValues(new Uint8Array(32)),
        ).toString("hex"),
        dataDir: await tempDir("e2e-workbench-digest-hub-data-"),
      });
      track(handle);
      return handle;
    });

    const sidecar = await hop("sidecar boot", async () => {
      const app = startSidecar({
        hubPort: new URL(hub.baseUrl).port
          ? Number(new URL(hub.baseUrl).port)
          : 80,
        sidecarId,
        token: sidecarToken,
        dataDir: await tempDir("e2e-workbench-digest-sidecar-data-"),
      });
      track(app);
      return app;
    });

    const user = await hop("sign-up", async () => {
      const res = await api(hub.baseUrl, "POST", "/api/auth/sign-up/email", {
        name: "Workbench Digest Tester",
        email: `workbench-digest-${crypto.randomUUID()}@example.invalid`,
        password: `pw-${crypto.randomUUID()}`,
      });
      expectStatus("sign-up", res, 200);
      if (res.cookies.length === 0) {
        throw new Error("sign-up returned no session cookie");
      }
      return res;
    });

    const slug = `e2ecd${crypto.randomUUID().slice(0, 8)}`;
    const tenantId = await hop("tenant creation", async () => {
      const res = await api(
        hub.baseUrl,
        "POST",
        "/api/tenants",
        { name: "Workbench Digest Smoke", slug },
        user.cookies,
      );
      expectStatus("create tenant", res, 201);
      return stringField(res.data, "id", "create tenant");
    });

    const assetName = "workbench-digest";
    const { assetId, commitSha } = await hop(
      "workflow asset publication",
      async () => {
        const created = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/assets`,
          { kind: "workflow", name: assetName },
          user.cookies,
        );
        expectStatus("create workflow asset", created, 201);
        const id = stringField(created.data, "id", "create workflow asset");

        const minted = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/git-tokens`,
          {
            name: "e2e-workbench-digest-push",
            resource: "asset:*",
            refPattern: "**",
            actions: ["can_read", "can_push"],
            expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          },
          user.cookies,
        );
        expectStatus("mint git token", minted, 201);

        const definition = buildWorkbenchDigestWorkflow({
          inferencePreferences: [{ provider: "anthropic", model: "noop" }],
          turnTimeoutMs: DIGEST_TURN_TIMEOUT_MS,
        });
        const pushed = await pushWorkflowSource({
          baseUrl: hub.baseUrl,
          tenantId,
          assetName,
          tokenSecret: stringField(minted.data, "secret", "mint git token"),
          workflowJson: serializeWorkbenchDigestWorkflow(definition),
        });
        return { assetId: id, commitSha: pushed.commitSha };
      },
    );

    // The deploy's source is the hub's own, really-reachable
    // noop-inference endpoint — not a placeholder like the walking
    // skeleton's `https://inference.invalid`. That distinction is the
    // whole point of this suite: a run started against this source
    // actually completes an inference call, at zero cost, because
    // noop-inference answers it locally without reaching a real model.
    const deploymentId = await hop("workflow deploy", async () => {
      const sourceId = "src-workbench-digest-e2e";
      const body = workflowDeployBody({
        assetId,
        commitSha,
        sourceId: sourceId,
        provider: "anthropic",
        baseURL: `${hub.baseUrl}/api/chat/noop-inference`,
        apiKey: "noop",
        model: "noop",
      });
      const deadline = Date.now() + 60_000;
      let res: ApiResult;
      for (;;) {
        if (sidecar.exited()) {
          throw new Error(
            `sidecar exited before deploy; output:\n${sidecar.output()}`,
          );
        }
        res = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/workflows/deployments`,
          body,
          user.cookies,
        );
        if (res.status !== 502) break;
        if (Date.now() > deadline) {
          throw new Error(
            `sidecar never became deployable (hub kept answering 502): ` +
              `${JSON.stringify(res.data)}\nsidecar output:\n${sidecar.output()}`,
          );
        }
        await Bun.sleep(200);
      }
      expectStatus("deploy workbench-digest workflow", res, 201);
      return stringField(res.data, "id", "deploy workbench-digest workflow");
    });

    const startedRunId = await hop(
      "workbench-digest run starts against noop-inference",
      async () => {
        const before = new Set(
          runIds(
            (
              await api(
                hub.baseUrl,
                "GET",
                `/api/tenants/${tenantId}/workflows/${deploymentId}/runs`,
                undefined,
                user.cookies,
              )
            ).data,
          ),
        );

        const triggered = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/workflows/${deploymentId}/mail`,
          { content: "message count: 0" },
          user.cookies,
        );
        expectStatus("trigger workbench-digest mail", triggered, 202);

        const deadline = Date.now() + 30_000;
        for (;;) {
          const listed = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenantId}/workflows/${deploymentId}/runs`,
            undefined,
            user.cookies,
          );
          const started = runIds(listed.data).find((id) => !before.has(id));
          if (started !== undefined) return started;
          if (Date.now() > deadline) {
            throw new Error(
              "workbench-digest trigger was accepted but no run started within 30s",
            );
          }
          await Bun.sleep(200);
        }
      },
    );

    // The real gate: a run id proves only that the mail route accepted
    // the trigger. Whether the deployment actually resolves — the
    // step's agent launching, its turn completing against
    // noop-inference, the run reaching a terminal state — is only
    // proven by the run's own event log. A broken agent launch or a
    // rejected inference call surfaces here as RunFailed (or no
    // terminal event at all), failing this loudly instead of a
    // "started" run standing in for a working platform.
    const events = await hop("workbench-digest run completes", () =>
      waitForRunCompletion(
        hub.baseUrl,
        tenantId,
        deploymentId,
        startedRunId,
        user.cookies,
        DIGEST_RUN_COMPLETION_TIMEOUT_MS,
      ),
    );
    expectStepCompleted(events, WORKBENCH_DIGEST_STEP_ID);

    console.log(
      "workbench-digest: gate achieved: a run completed against the " +
        "real, reachable noop-inference source, proving the " +
        "deployment resolves at zero cost.",
    );
  }, 180_000);
});
