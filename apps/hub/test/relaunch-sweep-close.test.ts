// Regression for CL-7453: createHub's relaunch sweep re-arms itself on
// a fixed [0, 2_000, 5_000, 15_000, 45_000] ms schedule (see
// `scheduleRelaunchSweep` in ../src/index.ts) and is never otherwise
// torn down. Before this fix, `hub.close()` stopped every other
// background loop (workflow scheduler, credential-expiry sweep,
// inbox-unsnooze sweep, bench provisioner, sidecar-allocation
// reconciliation) but left the relaunch sweep's timer running, so it
// kept firing — and logging `relaunch sweep pass failed: ...` when it
// queried a pool `close()` had already shut down — for the rest of the
// `bun test` process. A suite that boots several hubs back to back
// (slack-tag-mount.test.ts's env-gate suite among them) accumulated
// these leaked loops, contending with later tests' own boots for
// Postgres connections and surfacing as an intermittent test timeout.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HubConfig } from "../src/config.ts";
import { createHub } from "../src/index.ts";
import { dbGate } from "../../../scripts/e2e/db-gate";

const DATABASE_URL = process.env["DATABASE_URL"] ?? "";
const describeIfDb = dbGate(DATABASE_URL, import.meta.path);

const root = mkdtempSync(path.join(tmpdir(), "hub-relaunch-sweep-close-"));
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

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describeIfDb("relaunch sweep teardown", () => {
  test("does not run after hub.close()", async () => {
    const hub = await createHub(config);
    await hub.close();

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      // The sweep's own schedule reschedules at 0ms then 2_000ms; wait
      // past both so a leaked timer would have fired (and, querying a
      // pool `close()` already shut down, logged) at least once.
      await new Promise((resolve) => setTimeout(resolve, 2_200));
    } finally {
      console.error = originalError;
    }

    const leaked = errors.filter((line) =>
      line.includes("relaunch sweep pass failed"),
    );
    expect(leaked).toEqual([]);
  }, 10_000);
});
