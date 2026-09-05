// Proves the Slack tag ingress env-gate: absent SLACK_BOT_TOKEN/
// SLACK_SIGNING_SECRET never registers the webhook route; the pair
// present without SLACK_WORKBENCH_TENANT_SLUG/SLACK_DEFAULT_AGENT_DEFINITION_ID
// fails boot loudly (there is no honest default for either); the full
// config registers the route and inherits real Slack signature
// verification from `@corbits/slack-tag`/`corbits-tag/slack` — request/
// reply behavior itself is covered by `packages/slack-tag`'s own tests.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import type { HubConfig } from "../src/config.ts";
import { createHub } from "../src/index.ts";
import { dbGate } from "../../../scripts/e2e/db-gate";

// DB-gated: skipped when DATABASE_URL is unset, matching this repo's
// convention for tests that talk to a real Postgres.
const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const describeIfDb = dbGate(DATABASE_URL, import.meta.path);
const SLACK_WEBHOOK_PATH = "/api/tag/slack/webhook";
const TENANT_SLUG = `slack-tag-test-${crypto.randomUUID().slice(0, 8)}`;

const root = mkdtempSync(path.join(tmpdir(), "hub-slack-tag-mount-"));
const staticDir = path.join(root, "static");
mkdirSync(staticDir, { recursive: true });
writeFileSync(path.join(staticDir, "index.html"), "<html>shell</html>");
mkdirSync(path.join(root, "data"), { recursive: true });

const config: HubConfig = {
  databaseUrl: DATABASE_URL,
  baseUrl: "http://localhost:3000",
  sessionSecret: "insecure-test-only-session-secret-0000",
  hubDataDir: path.join(root, "data"),
  hubStaticDir: staticDir,
  defaultTenantSlug: "workbench",
  signupRateLimit: { windowSeconds: 60, max: 5 },
  signInRateLimit: { windowSeconds: 60, max: 10 },
  socialProviders: {},
  allowUnverifiedEmails: true,
  sidecarProvisioners: [],
  envProviderKeys: {},
  envProviderBaseUrls: {},
  chatIdleReapMs: 30 * 60_000,
  envCredentialPlantAdmin: {
    email: "alice@example.com",
    password: "password123",
    orgSlug: "workbench",
  },
  signupMode: "closed",
  allowedEmailDomains: [],
  allowPlaintextSecrets: true,
};

const closers: (() => Promise<void>)[] = [];
let tenantId: string | undefined;

async function seedTenant(): Promise<string> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    const id = `tnt_${crypto.randomUUID().replaceAll("-", "")}`;
    await sql`
      INSERT INTO "tenant" (id, name, slug, domain, created_at, updated_at)
      VALUES (${id}, ${"Slack Tag Test Bench"}, ${TENANT_SLUG}, ${`${TENANT_SLUG}.localhost`}, now(), now())
    `;
    return id;
  } finally {
    await sql.end();
  }
}

async function unseedTenant(id: string): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 });
  try {
    await sql`DELETE FROM "tenant" WHERE id = ${id}`;
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  if (DATABASE_URL === "") return;
  tenantId = await seedTenant();
});

afterAll(async () => {
  for (const close of closers) await close();
  if (tenantId !== undefined) await unseedTenant(tenantId);
  rmSync(root, { recursive: true, force: true });
});

const SLACK_ENV_KEYS = [
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_WORKBENCH_TENANT_SLUG",
  "SLACK_DEFAULT_AGENT_DEFINITION_ID",
] as const;
const savedEnv = new Map(SLACK_ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(async () => {
  for (const key of SLACK_ENV_KEYS) {
    const saved = savedEnv.get(key);
    if (saved === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = saved;
  }
  // Close each test's hub as soon as its test ends rather than letting
  // every hub booted in this file stay live (and its background loops
  // — relaunch sweep among them — keep running) until `afterAll`. Three
  // live hubs contending for the same Postgres connections is exactly
  // the kind of self-inflicted race this file should not add on top of
  // CL-7453's fix in `apps/hub/src/index.ts`.
  let closer: (() => Promise<void>) | undefined;
  while ((closer = closers.pop()) !== undefined) await closer();
});

async function bootHub(): Promise<Awaited<ReturnType<typeof createHub>>> {
  const hub = await createHub(config);
  closers.push(hub.close);
  return hub;
}

describeIfDb("Slack tag ingress env-gate", () => {
  test("absent SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET never registers the webhook route", async () => {
    for (const key of SLACK_ENV_KEYS) Reflect.deleteProperty(process.env, key);

    const hub = await bootHub();
    const res = await hub.app.request(SLACK_WEBHOOK_PATH, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  test("the credential pair without a tenant slug and definition id fails boot loudly", async () => {
    process.env["SLACK_BOT_TOKEN"] = "xoxb-test";
    process.env["SLACK_SIGNING_SECRET"] = "shhh-test";
    delete process.env["SLACK_WORKBENCH_TENANT_SLUG"];
    delete process.env["SLACK_DEFAULT_AGENT_DEFINITION_ID"];

    await expect(bootHub()).rejects.toThrow(
      /SLACK_WORKBENCH_TENANT_SLUG|SLACK_DEFAULT_AGENT_DEFINITION_ID/,
    );
  });

  test("a fully configured mount registers the route and rejects a bad signature", async () => {
    process.env["SLACK_BOT_TOKEN"] = "xoxb-test";
    process.env["SLACK_SIGNING_SECRET"] = "shhh-test";
    process.env["SLACK_WORKBENCH_TENANT_SLUG"] = TENANT_SLUG;
    process.env["SLACK_DEFAULT_AGENT_DEFINITION_ID"] =
      "wfd_does_not_matter_for_this_test";

    const hub = await bootHub();
    const res = await hub.app.request(SLACK_WEBHOOK_PATH, {
      method: "POST",
      body: "{}",
      headers: {
        "x-slack-request-timestamp": Math.floor(Date.now() / 1000).toString(),
        "x-slack-signature":
          "v0=0000000000000000000000000000000000000000000000000000000000000000",
      },
    });
    expect(res.status).toBe(401);
  });
});
