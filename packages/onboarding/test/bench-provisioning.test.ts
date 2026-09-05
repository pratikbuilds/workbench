// The background provisioner: the only thing in the system that
// deploys a bench's default workflows (CL-6457). Connect persists a
// credential and returns; this converges the bench afterwards, and has
// to hold three properties no HTTP request can hold for it — it is
// idempotent (a second pass over an already-seeded bench deploys
// nothing), convergent (a half-provisioned bench finishes on a later
// pass), and restart-safe (a fresh process with nothing in memory picks
// up whatever the crashed one left in the pending-seed table).
import { describe, expect, test } from "bun:test";
import { createEnvKeyCredentialCipher } from "@intx/crypto";
import type { CredentialCipher } from "@intx/types";
import { DEFAULT_WORKFLOWS } from "@corbits/seeding";
import {
  createBenchProvisioner,
  type BenchProvisionerDeps,
} from "../src/bench-provisioning";
import {
  createInMemoryPendingSeedStore,
  PENDING_SEED_SCAN_LIMIT,
  type PendingSeed,
  type PendingSeedStore,
} from "../src/pending-seed";

const TEST_KEY = Buffer.alloc(32, 33);
function testCipher(): CredentialCipher {
  return createEnvKeyCredentialCipher(TEST_KEY);
}

const SEED: PendingSeed = {
  userId: "user_1",
  tenantId: "ten_1",
  principalId: "prn_1",
  tenantDomain: "user-1.bench.local",
  provider: "anthropic",
  apiKey: "sk-ant-connected",
};

const ALL_WORKFLOWS = DEFAULT_WORKFLOWS.map((workflow) => workflow.assetName);

/** A provisioner wired entirely to fakes: no hub, no sidecar, no git
 * push. `seededTenants` is the fake bench state both the seeded-check
 * and the deploy step read and write, so idempotence and convergence
 * are observable as call counts rather than asserted by inspection. */
function harness(
  overrides: Partial<BenchProvisionerDeps> & { store?: PendingSeedStore } = {},
) {
  const store = overrides.store ?? createInMemoryPendingSeedStore(testCipher());
  const deployedByTenant = new Map<string, string[]>();
  const calls = {
    isFullySeeded: 0,
    ensureSeeded: 0,
    sessionFor: 0,
    publishToolRegistry: 0,
  };
  const logged: string[] = [];

  const deps: BenchProvisionerDeps = {
    api: (async () => {
      throw new Error("the fakes below stand in for every hub call");
    }) as unknown as BenchProvisionerDeps["api"],
    hubUrl: "https://bench.example.com",
    store,
    pushWorkflow: async () => ({
      outcome: "pushed" as const,
      commitSha: "a".repeat(40),
    }),
    sessionFor: async () => {
      calls.sessionFor += 1;
      return ["better-auth.session_token=minted"];
    },
    log: (line) => logged.push(line),
    isFullySeededFn: async (_api, _cookies, tenantId) => {
      calls.isFullySeeded += 1;
      return (
        (deployedByTenant.get(tenantId) ?? []).length === ALL_WORKFLOWS.length
      );
    },
    publishToolRegistryFn: async () => {
      calls.publishToolRegistry += 1;
    },
    ensureSeededFn: async (args) => {
      calls.ensureSeeded += 1;
      deployedByTenant.set(args.tenant.tenantId, [...ALL_WORKFLOWS]);
      return { kind: "seeded", workflows: ALL_WORKFLOWS };
    },
    ...overrides,
  };

  return {
    provisioner: createBenchProvisioner(deps),
    store,
    calls,
    logged,
    deployedByTenant,
  };
}

describe("createBenchProvisioner", () => {
  test("converges a freshly connected bench and clears its pending row", async () => {
    const { provisioner, store, calls, deployedByTenant } = harness();
    await store.put(SEED);

    const report = await provisioner.drainOnce();

    expect(calls.ensureSeeded).toBe(1);
    expect(deployedByTenant.get("ten_1")).toEqual(ALL_WORKFLOWS);
    expect(report).toMatchObject({ converged: 1, truncated: false });
    expect(
      await store.read({ userId: "user_1", tenantId: "ten_1" }),
    ).toBeUndefined();
  });

  test("is idempotent: a second drain over an already-seeded bench deploys nothing", async () => {
    const { provisioner, store, calls } = harness();
    await store.put(SEED);

    await provisioner.drainOnce();
    // The row is gone after the first pass, so re-arm it the way a
    // duplicate connect would and prove the seeded-check short-circuits.
    await store.put(SEED);
    await provisioner.drainOnce();

    expect(calls.ensureSeeded).toBe(1);
  });

  test("re-running over a bench someone else already seeded deploys nothing and still clears the row", async () => {
    const { provisioner, store, calls, deployedByTenant } = harness();
    deployedByTenant.set("ten_1", [...ALL_WORKFLOWS]);
    await store.put(SEED);

    const report = await provisioner.drainOnce();

    expect(calls.ensureSeeded).toBe(0);
    expect(report).toMatchObject({ converged: 1, truncated: false });
    expect(
      await store.read({ userId: "user_1", tenantId: "ten_1" }),
    ).toBeUndefined();
  });

  test("a half-provisioned bench keeps its row and converges on a later pass", async () => {
    let attempt = 0;
    const { provisioner, store } = harness({
      ensureSeededFn: async () => {
        attempt += 1;
        return attempt === 1
          ? {
              kind: "seeded-pending-agents",
              deployed: ALL_WORKFLOWS.slice(0, 2),
              pending: ALL_WORKFLOWS.slice(2),
              message: "agents pending",
            }
          : { kind: "seeded", workflows: ALL_WORKFLOWS };
      },
    });
    await store.put(SEED);

    const first = await provisioner.drainOnce();
    expect(first).toMatchObject({ pending: 1 });
    // The row survives precisely so the next pass can finish the job.
    expect(await store.read({ userId: "user_1", tenantId: "ten_1" })).toEqual(
      SEED,
    );

    const second = await provisioner.drainOnce({ ignoreBackoff: true });
    expect(second).toMatchObject({ converged: 1 });
    expect(
      await store.read({ userId: "user_1", tenantId: "ten_1" }),
    ).toBeUndefined();
  });

  test("a deploy failure leaves the row for the next pass rather than losing the bench", async () => {
    let attempt = 0;
    const { provisioner, store, logged } = harness({
      ensureSeededFn: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("sidecar exploded");
        return { kind: "seeded", workflows: ALL_WORKFLOWS };
      },
    });
    await store.put(SEED);

    const first = await provisioner.drainOnce();
    expect(first).toMatchObject({ failed: 1 });
    expect(await store.read({ userId: "user_1", tenantId: "ten_1" })).toEqual(
      SEED,
    );
    expect(logged.some((line) => line.includes("sidecar exploded"))).toBe(true);

    const second = await provisioner.drainOnce({ ignoreBackoff: true });
    expect(second).toMatchObject({ converged: 1 });
  });

  test("a failed bench is held off by backoff instead of hammering every tick", async () => {
    let attempts = 0;
    const { provisioner, store } = harness({
      ensureSeededFn: async () => {
        attempts += 1;
        throw new Error("sidecar still down");
      },
    });
    await store.put(SEED);

    await provisioner.drainOnce();
    const held = await provisioner.drainOnce();

    expect(attempts).toBe(1);
    expect(held).toMatchObject({ deferred: 1 });
  });

  test("restart-resume: a fresh provisioner with empty memory finishes what a crashed one left behind", async () => {
    const store = createInMemoryPendingSeedStore(testCipher());
    // The "crashed" process: it wrote the row, then died before its
    // deploy ever ran.
    await store.put(SEED);

    // A brand-new provisioner — no in-flight map, no backoff state, no
    // knowledge of the connect that wrote the row — boots and drains.
    const { provisioner, calls, deployedByTenant } = harness({ store });
    const report = await provisioner.drainOnce();

    expect(calls.ensureSeeded).toBe(1);
    expect(deployedByTenant.get("ten_1")).toEqual(ALL_WORKFLOWS);
    expect(report).toMatchObject({ converged: 1, truncated: false });
  });

  test("overlapping drains never double-deploy the same bench", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    let deploys = 0;
    const { provisioner, store } = harness({
      ensureSeededFn: async () => {
        deploys += 1;
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return { kind: "seeded", workflows: ALL_WORKFLOWS };
      },
    });
    await store.put(SEED);

    await Promise.all([provisioner.drainOnce(), provisioner.drainOnce()]);

    expect(maxConcurrent).toBe(1);
    expect(deploys).toBe(1);
  });

  test("pending-seed drain publishes corbits-tools before the fully-seeded check", async () => {
    const order: string[] = [];
    const { provisioner, store, calls } = harness({
      publishToolRegistryFn: async () => {
        order.push("publish");
      },
      isFullySeededFn: async () => {
        order.push("seeded-check");
        return true;
      },
    });
    await store.put(SEED);

    const report = await provisioner.drainOnce();

    expect(order).toEqual(["publish", "seeded-check"]);
    expect(calls.ensureSeeded).toBe(0);
    expect(report).toMatchObject({ converged: 1 });
    expect(
      await store.read({ userId: "user_1", tenantId: "ten_1" }),
    ).toBeUndefined();
  });

  test("a publish throw holds the pending row and does not call ensureSeeded", async () => {
    const { provisioner, store, calls } = harness({
      publishToolRegistryFn: async () => {
        throw new Error("pack exploded");
      },
    });
    await store.put(SEED);

    const report = await provisioner.drainOnce();

    expect(calls.ensureSeeded).toBe(0);
    expect(calls.isFullySeeded).toBe(0);
    expect(report).toMatchObject({ failed: 1 });
    expect(await store.read({ userId: "user_1", tenantId: "ten_1" })).toEqual(
      SEED,
    );
  });

  test("a bench whose user has no mintable session is left alone, not dropped", async () => {
    const { provisioner, store, calls } = harness({
      sessionFor: async () => undefined,
    });
    await store.put(SEED);

    const report = await provisioner.drainOnce();

    expect(calls.ensureSeeded).toBe(0);
    expect(report).toMatchObject({ failed: 1 });
    expect(await store.read({ userId: "user_1", tenantId: "ten_1" })).toEqual(
      SEED,
    );
  });

  test("a permanently-failing bench's backoff is reclaimed once its row is gone, not only on success", async () => {
    // Simulates the CL-7233 orphan case: the pending_seed row disappears
    // (TTL-expiry or otherwise) while the bench is still backed off from
    // repeated failures — the retry-hold bookkeeping must not survive
    // the row that justified it.
    const { provisioner, store } = harness({
      ensureSeededFn: async () => {
        throw new Error("sidecar still down");
      },
    });
    await store.put(SEED);

    const first = await provisioner.drainOnce();
    expect(first).toMatchObject({ failed: 1 });
    // Confirm the hold is actually in effect before the row disappears —
    // otherwise this test would pass for the wrong reason.
    const stillBackedOff = await provisioner.drainOnce();
    expect(stillBackedOff).toMatchObject({ deferred: 1 });

    // The row is gone by some path other than this provisioner's own
    // convergence (an admin action, or read-time TTL expiry elsewhere).
    await store.clear({ userId: "user_1", tenantId: "ten_1" });
    const afterRowGone = await provisioner.drainOnce();
    expect(afterRowGone).toMatchObject({
      converged: 0,
      pending: 0,
      failed: 0,
      deferred: 0,
    });

    // A brand-new connect for the same user/tenant must not inherit the
    // dead bench's backoff — without eviction, this would come back
    // deferred instead of attempted.
    await store.put(SEED);
    const freshAttempt = await provisioner.drainOnce();
    expect(freshAttempt).toMatchObject({ failed: 1 });
  });

  test("drains every waiting bench in one tick, not just the first", async () => {
    const { provisioner, store, calls } = harness();
    await store.put(SEED);
    await store.put({ ...SEED, userId: "user_2", tenantId: "ten_2" });

    const report = await provisioner.drainOnce();

    expect(calls.ensureSeeded).toBe(2);
    expect(report).toMatchObject({ converged: 2, truncated: false });
  });

  test("DrainReport.truncated is true when more due rows remain behind this tick's page", async () => {
    const seen = new Set<string>();
    const { provisioner, store } = harness({
      ensureSeededFn: async (args) => {
        seen.add(args.tenant.tenantId);
        return {
          kind: "seeded-pending-agents",
          deployed: [],
          pending: ALL_WORKFLOWS,
          message: "agents pending",
        };
      },
    });
    for (let index = 0; index < PENDING_SEED_SCAN_LIMIT + 3; index += 1) {
      await store.put({
        ...SEED,
        userId: `user_${index}`,
        tenantId: `ten_${index}`,
      });
    }

    const first = await provisioner.drainOnce();
    expect(first.truncated).toBe(true);
    expect(first.pending).toBe(PENDING_SEED_SCAN_LIMIT);
    expect(seen.size).toBe(PENDING_SEED_SCAN_LIMIT);

    const second = await provisioner.drainOnce();
    expect(second.truncated).toBe(false);
    expect(second.pending).toBe(3);
    expect(seen.size).toBe(PENDING_SEED_SCAN_LIMIT + 3);
  });

  test("rows past the scan limit still get a drain pass across ticks, even when the first page never converges", async () => {
    const seen = new Set<string>();
    const { provisioner, store } = harness({
      ensureSeededFn: async (args) => {
        seen.add(args.tenant.tenantId);
        return {
          kind: "seeded-pending-agents",
          deployed: [],
          pending: ALL_WORKFLOWS,
          message: "agents pending",
        };
      },
    });
    const total = PENDING_SEED_SCAN_LIMIT + 3;
    for (let index = 0; index < total; index += 1) {
      await store.put({
        ...SEED,
        userId: `user_${index}`,
        tenantId: `ten_${index}`,
      });
    }

    await provisioner.drainOnce();
    await provisioner.drainOnce();

    expect(seen.size).toBe(total);
    for (let index = 0; index < total; index += 1) {
      expect(seen.has(`ten_${index}`)).toBe(true);
    }
  });
});
