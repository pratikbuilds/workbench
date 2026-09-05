// CL-6055: the scripted local-rip proof — everything a brand-new
// person does from sign-up through connecting their first real
// provider. One sequential scenario against a real hub, a real
// sidecar, and a real Postgres.
//
// Phase A (onboard → connect): closed-by-default signup is respected
// → sign up → first-login provisioning mints a personal bench,
// unseeded (no hub-owned seed model) → connecting a real inference
// credential through the key path (`POST /api/onboarding/complete`'s
// own machinery, called directly — see the stubbing note below) fully
// seeds every default workflow, including "assistant" → the
// Connections surface (the tenant's own credentials list, the same
// route `connectorStatus` in `@workbench/settings-ui` reads) honestly
// reflects the connected credential.
//
// Until CL-6057, this suite documented a real platform gap instead of
// hiding it: the "assistant" default workflow pins
// `@corbits/memory-tools`, and that pin only resolved once an operator
// had published a `package-registry`-kind asset named "corbits-tools"
// carrying its tarball. CL-7071 moved that publish off `seedTenant`
// onto `workbench setup` (the root tenant; descendants inherit). The
// boot-ensured root is the personal bench's parent, so the provisioned
// personal bench is a child of the root: an explicit
// `publishCorbitsToolsRegistry` hop onto that bench stands in for
// setup, then `ensureSeeded` deploys without packing.
//
// Stubbing note: onboarding's own `POST /api/onboarding/complete` route
// (`testAndPersistCredential`, from `@workbench/onboarding`'s
// `complete-credential.ts`) stores a pasted key immediately, with no
// live probe of the provider gating it (CL-6123) — so there is nothing
// left to stub there. This suite still drives the same two halves the
// route itself calls (`testAndPersistCredential`/`ensureSeeded`)
// directly rather than through HTTP, the same way `chat.test.ts` drives
// `seedCatalog` directly rather than going through an HTTP surface that
// has no test seam. Every call these two halves make is real HTTP
// against the spawned hub, and no provider is ever dialed during phase
// A: the resulting deployments carry the stub key as a stored,
// never-triggered source (`confirmDeployments: false`, matching
// onboarding's own connect flow — see `ensureSeeded`'s doc comment), so
// a made-up key is exactly as good as a real one for proving that leg.
//
// The deployed sources' `baseURL` is the real Anthropic host
// (`CATALOG_SEEDS`), which is the honest key-path behavior — phase A
// deliberately does not run those sources through
// `assertNeverRealProvider`, since flagging a real provider host here
// would be a false positive: it is never called, only stored.
//
// This suite once continued with a Phase B (task dispatch) and Phase C
// (trace and "Let Myra choose" planner legs) proving the tasks
// primitive end to end. That primitive was removed in favor of
// workflows/routines (owner ruling); this suite now covers onboard →
// connect only.

import { describe, expect, test } from "bun:test";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  CATALOG_WORKFLOWS,
  catalogWorkflowDeployableOnThisPin,
  createGitWorkflowPusher,
  DEFAULT_WORKFLOWS,
  isLiveDeploymentStatus,
  publishCorbitsToolsRegistry,
  seedTenant,
} from "../../packages/seeding/src/index.ts";
import {
  createHubAPI,
  parseAs,
  type ApiCall,
} from "../../packages/hub-api-client/src/index.ts";
import {
  findPersonalTenant,
  testAndPersistCredential,
  ensureSeeded,
  modelSourceFor,
} from "../../packages/onboarding/src/complete-credential.ts";
import { CredentialResponse, paginatedSchema } from "@intx/types";
import {
  api,
  createCleanupHarness,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  hop,
  provisionSidecar,
  startHub,
  startSidecar,
  type HubHandle,
} from "./harness.ts";

const { tempDir, track } = createCleanupHarness();

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "local-rip: DATABASE_URL is not set; suite skipped. Set DATABASE_URL " +
      "(see .env.example) to run it; start Postgres with `docker compose -f docker-compose.test.yml up -d` so this skip " +
      "can never pass silently there.",
  );
}

// A key that is never sent anywhere: onboarding never probes it (see
// the stubbing note above), and the deployments it seeds are never
// triggered. Named so it can never be mistaken for a real secret if it
// leaks into a log line or a bug report.
const STUB_API_KEY = "e2e-local-rip-stub-key-not-real";

function stringField(data: unknown, field: string, what: string): string {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value !== "") return value;
  }
  throw new Error(
    `${what}: missing string field "${field}": ${JSON.stringify(data)}`,
  );
}

async function signUp(
  baseUrl: string,
  name: string,
): Promise<{ userId: string; email: string; cookies: string[] }> {
  const email = `local-rip-${crypto.randomUUID()}@example.invalid`;
  const password = `pw-${crypto.randomUUID()}`;
  const res = await api(baseUrl, "POST", "/api/auth/sign-up/email", {
    name,
    email,
    password,
  });
  expectStatus(`sign-up for ${name}`, res, 200);
  if (res.cookies.length === 0) {
    throw new Error(`sign-up for ${name} returned no session cookie`);
  }
  const userId = stringField(
    (res.data as { user: unknown }).user,
    "id",
    `sign-up user field for ${name}`,
  );
  return { userId, email, cookies: res.cookies };
}

describe.skipIf(databaseUrl === undefined)(
  "local-rip: onboard → connect",
  () => {
    test("a brand-new person signs up, gets a personal bench, and connects a real provider through the key path", async () => {
      const url = databaseUrl;
      if (url === undefined) throw new Error("unreachable: suite is skipped");

      await hop("database setup", async () => {
        await resetSchema(url);
        const report = await setupDatabase(url);
        expect(report.action).toBe("migrated");
      });

      // Closed-by-default: a hub with no WORKBENCH_SIGNUP override (the
      // platform's own default, per `apps/hub/src/config.ts`) refuses a
      // brand-new person outright, right at sign-up — the access-policy
      // gate is wired into better-auth's own sign-up hook, one layer
      // earlier than onboarding's own provisioning gate — proven against
      // a short-lived hub of its own so the rest of this scenario's hub
      // (which needs open signup to run at all) never muddies the
      // assertion.
      await hop("closed-by-default signup is respected", async () => {
        const closedHub = await startHub({
          databaseUrl: url,
          port: freePort(),
          sessionSecret: Buffer.from(
            crypto.getRandomValues(new Uint8Array(32)),
          ).toString("hex"),
          dataDir: await tempDir("e2e-local-rip-closed-hub-data-"),
          extraEnv: { WORKBENCH_SIGNUP: "closed" },
        });
        try {
          const res = await api(
            closedHub.baseUrl,
            "POST",
            "/api/auth/sign-up/email",
            {
              name: "Closed Signup Tester",
              email: `local-rip-closed-${crypto.randomUUID()}@example.invalid`,
              password: `pw-${crypto.randomUUID()}`,
            },
          );
          expectStatus("closed-signup sign-up attempt", res, 403);
          const body = res.data as { error: string };
          expect(body.error).toBe("signup_closed");
        } finally {
          await closedHub.stop();
        }
      });

      const sidecarId = "local-rip-sidecar";
      const sidecarToken = crypto.randomUUID();
      await provisionSidecar(url, sidecarId, sidecarToken);

      const hub: HubHandle = await hop("hub boot", async () =>
        startHub({
          databaseUrl: url,
          port: freePort(),
          sessionSecret: Buffer.from(
            crypto.getRandomValues(new Uint8Array(32)),
          ).toString("hex"),
          dataDir: await tempDir("e2e-local-rip-hub-data-"),
          // Deliberately no ANTHROPIC_API_KEY: like `smoke-onboarding`,
          // this hub carries no hub-owned seed model credential, so
          // first-login provisioning must report the bench as
          // provisioned-but-unseeded — this scenario's own connect step
          // is what finishes seeding it.
        }),
      );
      track(hub);

      const sidecar = startSidecar({
        hubPort: new URL(hub.baseUrl).port
          ? Number(new URL(hub.baseUrl).port)
          : 80,
        sidecarId,
        token: sidecarToken,
        dataDir: await tempDir("e2e-local-rip-sidecar-data-"),
      });
      track(sidecar);

      const hubApi: ApiCall = createHubAPI(hub.baseUrl);

      const user = await hop("sign-up", () =>
        signUp(hub.baseUrl, "Local Rip Tester"),
      );

      await hop(
        "a membership probe before naming reports needs-onboarding",
        async () => {
          const res = await api(
            hub.baseUrl,
            "POST",
            "/api/onboarding/provision",
            undefined,
            user.cookies,
          );
          expectStatus("provision probe", res, 200);
          expect((res.data as { kind: string }).kind).toBe("needs-onboarding");
        },
      );

      const provisioned = await hop(
        "first-login provisioning mints a personal bench, unseeded",
        async () => {
          const res = await api(
            hub.baseUrl,
            "POST",
            "/api/onboarding/provision",
            { name: "Local Rip Tester's Bench" },
            user.cookies,
          );
          expectStatus("provision", res, 200);
          const data = res.data as {
            kind: string;
            tenantId: string;
            tenantSlug: string;
            seeded: boolean;
            seedSkipReason?: string;
          };
          expect(data.kind).toBe("provisioned");
          expect(data.seeded).toBe(false);
          expect(typeof data.seedSkipReason).toBe("string");
          return data;
        },
      );

      await hop(
        "the provisioned bench is a real tenant membership",
        async () => {
          const res = await api(
            hub.baseUrl,
            "GET",
            "/api/me/principals",
            undefined,
            user.cookies,
          );
          expectStatus("list principals", res, 200);
          const rows = (res.data as { data: { tenantId: string }[] }).data;
          const own = rows.find((row) => row.tenantId === provisioned.tenantId);
          if (own === undefined) {
            throw new Error(
              `provisioned tenant ${provisioned.tenantId} is missing from the caller's own principals: ${JSON.stringify(rows)}`,
            );
          }
        },
      );

      const tenant = await hop(
        "the freshly provisioned bench resolves through findPersonalTenant",
        async () => {
          const found = await findPersonalTenant(
            hubApi,
            user.cookies,
            provisioned.tenantSlug,
          );
          if (found === undefined) {
            throw new Error(
              `findPersonalTenant found nothing for slug ${provisioned.tenantSlug}`,
            );
          }
          expect(found.tenantId).toBe(provisioned.tenantId);
          return found;
        },
      );

      const pushWorkflow = createGitWorkflowPusher();

      const connected = await hop(
        "connecting a real inference credential via the key path (no provider probe — CL-6123)",
        async () => {
          const result = await testAndPersistCredential({
            api: hubApi,
            cookies: user.cookies,
            hubUrl: hub.baseUrl,
            userId: user.userId,
            userEmail: user.email,
            provider: "anthropic",
            apiKey: STUB_API_KEY,
            pushWorkflow,
            log: () => undefined,
          });
          if (result.kind !== "connected") {
            throw new Error(
              `expected the key-path connect to succeed, got: ${JSON.stringify(result)}`,
            );
          }
          expect(result.tenantId).toBe(tenant.tenantId);
          return result;
        },
      );

      // The deploy step needs the sidecar's dial-in to have completed —
      // ensureSeeded's own deployment call answers 502 until it has,
      // and (unlike the native workflow-deploy route the walking
      // skeleton retries directly) that 502 surfaces as a thrown
      // CliError rather than a response this suite can branch on. Every
      // step ensureSeeded/seedTenant takes is itself ensure-then-create,
      // so retrying the whole call is safe.
      async function deploySeededWorkflows(
        workflows: typeof DEFAULT_WORKFLOWS,
      ): Promise<Awaited<ReturnType<typeof seedTenant>>> {
        const deadline = Date.now() + 60_000;
        for (;;) {
          if (sidecar.exited()) {
            throw new Error(
              `sidecar exited before default workflows could deploy; output:\n${sidecar.output()}`,
            );
          }
          try {
            return await seedTenant({
              api: hubApi,
              cookies: user.cookies,
              hubUrl: hub.baseUrl,
              tenant: {
                tenantId: tenant.tenantId,
                principalId: tenant.principalId,
                domain: tenant.tenantDomain,
              },
              model: await modelSourceFor(
                hubApi,
                user.cookies,
                tenant.tenantId,
                "anthropic",
                STUB_API_KEY,
              ),
              pushWorkflow,
              log: () => undefined,
              workflows,
              confirmDeployments: false,
            });
          } catch (cause) {
            if (Date.now() > deadline) throw cause;
            await Bun.sleep(200);
          }
        }
      }

      // CL-7071: seedTenant/ensureSeeded no longer pack. The provisioned
      // personal bench is a child of the boot-ensured root, so publish
      // `corbits-tools` onto the bench itself the way `workbench setup`
      // does onto the root. Then ensureSeeded deploys assistant without
      // packing.
      await hop(
        "publish corbits-tools onto the provisioned root bench (setup's job, not seed's)",
        async () => {
          await publishCorbitsToolsRegistry({
            api: hubApi,
            cookies: user.cookies,
            hubUrl: hub.baseUrl,
            tenantId: tenant.tenantId,
            log: () => undefined,
          });
        },
      );

      await hop(
        "the real, unmodified connect flow fully seeds every default workflow, including 'assistant'",
        async () => {
          const deadline = Date.now() + 60_000;
          for (;;) {
            if (sidecar.exited()) {
              throw new Error(
                `sidecar exited before ensureSeeded could run; output:\n${sidecar.output()}`,
              );
            }
            try {
              await ensureSeeded({
                api: hubApi,
                cookies: user.cookies,
                hubUrl: hub.baseUrl,
                pushWorkflow,
                log: () => undefined,
                tenant: connected,
                provider: "anthropic",
                apiKey: STUB_API_KEY,
              });
              break;
            } catch (cause) {
              if (Date.now() > deadline) throw cause;
              await Bun.sleep(200);
            }
          }
        },
      );

      await hop(
        "the default workflow (assistant) plus the credential-free on-demand catalog (echo, workbench-digest, last-30-days-research, code-review) deploy and go live (CL-7074: only assistant is seeded automatically; the rest deploy here via the same seeding-library path a real on-demand deploy would use)",
        async () => {
          // CATALOG_WORKFLOWS grew (CL-7073) to cover every workflows/
          // source package, including six whose definition wires a real
          // `credentialBindings` entry. On the current Interchange pin,
          // this front's `deployWorkflowSource` port has no
          // `credentialCipher` seam to resolve those bindings (see
          // `catalogWorkflowDeployableOnThisPin`,
          // `docs/seed-reconciliation.md`) — these six cannot deploy
          // through this front at all right now, and are excluded here
          // until the Interchange re-pin (CL-7107 / PR #632, pin
          // 692c3106) adds that seam. This hop keeps asserting
          // deploy-and-go-live for every workflow this pin CAN deploy;
          // `template-block-routes.test.ts` covers the excluded ones'
          // 409 route refusal against fakes.
          const workflows = [
            ...DEFAULT_WORKFLOWS,
            ...CATALOG_WORKFLOWS.filter((workflow) =>
              catalogWorkflowDeployableOnThisPin(workflow.assetName),
            ),
          ];
          await deploySeededWorkflows(workflows);
          for (const workflow of workflows) {
            const assetsRes = await api(
              hub.baseUrl,
              "GET",
              `/api/tenants/${tenant.tenantId}/assets?kind=workflow&inherited=false`,
              undefined,
              user.cookies,
            );
            expectStatus(
              `list assets for ${workflow.assetName}`,
              assetsRes,
              200,
            );
            const assets = assetsRes.data as { id: string; name: string }[];
            const asset = assets.find((a) => a.name === workflow.assetName);
            if (asset === undefined) {
              throw new Error(`no asset named ${workflow.assetName}`);
            }
            const deploymentsRes = await api(
              hub.baseUrl,
              "GET",
              `/api/tenants/${tenant.tenantId}/workflows/deployments`,
              undefined,
              user.cookies,
            );
            expectStatus(
              `list deployments for ${workflow.assetName}`,
              deploymentsRes,
              200,
            );
            const deployments = deploymentsRes.data as {
              definitionAssetId: string;
              status: string;
            }[];
            const live = deployments.find(
              (d) =>
                d.definitionAssetId === asset.id &&
                isLiveDeploymentStatus(d.status),
            );
            if (live === undefined) {
              throw new Error(
                `no live deployment for ${workflow.assetName}: ${JSON.stringify(deployments)}`,
              );
            }
          }
        },
      );

      await hop(
        "the Connections surface reflects the connected credential",
        async () => {
          const res = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenant.tenantId}/credentials`,
            undefined,
            user.cookies,
          );
          expectStatus("list tenant credentials", res, 200);
          const credentials = parseAs(
            paginatedSchema(CredentialResponse),
            res.data,
            "credentials response",
          ).data;
          // The self-served connect flow names the credential by the
          // connector's display name ("Anthropic") — see
          // `credentialDisplayName` in `@workbench/onboarding`'s
          // `complete-credential.ts`: the Plugins gallery resolver looks
          // a credential up by that exact name, so seeding under the
          // old `inferenceCredentialName` convention would leave it
          // invisible to the gallery.
          const planted = credentials.find(
            (credential) => credential.name === "Anthropic",
          );
          if (planted === undefined) {
            throw new Error(
              `no "Anthropic" credential on the tenant's Connections surface: ${JSON.stringify(credentials)}`,
            );
          }
          expect(planted.status).toBe("active");
          expect(planted.type).toBe("api_key");
        },
      );
    }, 180_000);
  },
);
