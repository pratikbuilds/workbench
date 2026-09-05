// The one place a bench's default workflows are ever deployed
// (CL-6457). Connecting a provider used to do it inline: a pasted key
// sat on "Connecting…" for minutes while five workflows deployed at
// ~20s each, and the owner reasonably concluded the app had frozen.
// Connect now does the durable, fast half only — persist the credential,
// seed its catalog — and this converges the bench afterwards, off the
// request path entirely.
//
// It is a drain over `onboarding.pending_seed`, not a queue of jobs: the
// row IS the work item, and what it means is "this bench has a
// credential and does not yet have its agents". That framing is what
// makes the three properties fall out rather than have to be engineered:
//
//   - Idempotent. Every pass re-reads the bench's actual asset and
//     deployment state (`isFullySeeded`) before doing anything, and the
//     deploy step underneath (`seedTenant`) is ensure-then-create at
//     every step. A pass over a bench that is already done deploys
//     nothing and simply clears the row.
//   - Convergent. A pass that gets partway — the sidecar-unavailable
//     class `ensureSeeded` reports as `seeded-pending-agents` — leaves
//     the row in place, so the next pass picks up exactly the workflows
//     that are still missing.
//   - Restart-safe. Nothing about a bench's outstanding work lives in
//     this process. A hub that dies mid-deploy leaves the row behind,
//     and the next boot's first tick finishes it. In-memory state here
//     is only ever an optimization (a dedupe guard, a retry backoff),
//     never a fact the system needs to be correct.
//
// Sessions are the one thing a background loop cannot inherit: there is
// no request to borrow cookies from. `sessionFor` is that seam — the
// composition root decides how a session is minted for a user, and this
// module stays out of the auth mechanism entirely.

import { reportError } from "@corbits/error-sink";
import {
  publishCorbitsToolsRegistry,
  type ToolRegistryPublisher,
  type WorkflowPusher,
} from "@corbits/seeding";
import { type ApiCall } from "@corbits/hub-api-client";
import { ensureSeeded } from "./complete-credential";
import { isFullySeeded } from "./provision";
import {
  PENDING_SEED_SCAN_LIMIT,
  type PendingSeed,
  type PendingSeedListCursor,
  type PendingSeedStore,
} from "./pending-seed";

export const PROVISIONING_POLL_INTERVAL_MS = 15_000;
const RETRY_BACKOFF_BASE_MS = 15_000;
const RETRY_BACKOFF_CEILING_MS = 10 * 60 * 1000;

/**
 * Mints the hub session the drain acts under for one user's own bench,
 * or `undefined` when no session can be minted (an account since
 * deleted, an auth backend briefly unavailable). Returning `undefined`
 * holds the bench for a later pass — it never discards the row.
 */
export type SessionForUser = (args: {
  userId: string;
  tenantId: string;
}) => Promise<string[] | undefined>;

export type BenchProvisionerDeps = {
  api: ApiCall;
  hubUrl: string;
  store: PendingSeedStore;
  pushWorkflow: WorkflowPusher;
  sessionFor: SessionForUser;
  log: (line: string) => void;
  logError?: (line: string) => void;
  /** Test seams. Production passes neither; the real implementations are
   * the module-level imports above. */
  ensureSeededFn?: typeof ensureSeeded;
  isFullySeededFn?: typeof isFullySeeded;
  /**
   * Republish an empty or missing `corbits-tools` registry. Same job
   * grant reconcile does on every sign-in — not a hot agent-launch
   * path. Production uses `publishCorbitsToolsRegistry`.
   */
  publishToolRegistryFn?: ToolRegistryPublisher;
  now?: () => number;
};

/** What one pass over one bench concluded. `converged` and `pending` are
 * both healthy — the difference is only whether there is more to do. */
export type BenchProvisionOutcome = "converged" | "pending" | "failed";

export type DrainReport = {
  readonly converged: number;
  readonly pending: number;
  readonly failed: number;
  /** Benches skipped this tick because a previous failure's backoff has
   * not elapsed, or because a pass over them is still running. */
  readonly deferred: number;
  /** True when this tick stopped because its scan page filled the limit
   * with more rows still in the table. The next tick continues after this
   * page's cursor rather than restarting at the oldest row. False when
   * the scan reached the end of the table. */
  readonly truncated: boolean;
};

export type BenchProvisioner = {
  /** One bench, start to finish. Exposed so a connect can kick its own
   * bench immediately instead of waiting out a poll interval. */
  provisionBench(
    seed: PendingSeed,
  ): Promise<BenchProvisionOutcome | "deferred">;
  drainOnce(args?: { ignoreBackoff?: boolean }): Promise<DrainReport>;
  /** Fire-and-forget drain for callers that must not wait on it — a
   * route that just wrote a pending row, or hub boot. Never rejects. */
  wake(): void;
  start(args?: { intervalMs?: number }): void;
  stop(): void;
};

function benchKey(seed: { userId: string; tenantId: string }): string {
  return `${seed.userId}:${seed.tenantId}`;
}

export function createBenchProvisioner(
  deps: BenchProvisionerDeps,
): BenchProvisioner {
  const now = deps.now ?? Date.now;
  const logError = deps.logError ?? deps.log;
  const runEnsureSeeded = deps.ensureSeededFn ?? ensureSeeded;
  const runIsFullySeeded = deps.isFullySeededFn ?? isFullySeeded;
  const runPublishToolRegistry =
    deps.publishToolRegistryFn ?? publishCorbitsToolsRegistry;

  const inFlight = new Map<string, Promise<BenchProvisionOutcome>>();
  // Backoff bookkeeping for a failing bench, keyed the same way
  // `inFlight` is. This is process-local, in-memory state — never a
  // fact the system needs to be correct, only a hammering guard — but
  // with no eviction it survives its own bench forever: a bench that
  // fails permanently accumulates here even after its `pending_seed`
  // row TTL-expires out from under it (CL-7233). `userId`/`tenantId`
  // are carried alongside the counters (not re-derived from the map
  // key) so `pruneOrphanedHolds` can ask the store directly whether a
  // hold's row still exists, rather than assuming a compound string key
  // splits back apart cleanly.
  const holds = new Map<
    string,
    {
      retryAfter: number;
      failureCount: number;
      userId: string;
      tenantId: string;
    }
  >();
  let timer: ReturnType<typeof setInterval> | undefined;
  let scanAfter: PendingSeedListCursor | undefined;

  function holdOff(seed: { userId: string; tenantId: string }): void {
    const key = benchKey(seed);
    const failures = (holds.get(key)?.failureCount ?? 0) + 1;
    const backoff = Math.min(
      RETRY_BACKOFF_BASE_MS * 2 ** (failures - 1),
      RETRY_BACKOFF_CEILING_MS,
    );
    holds.set(key, {
      retryAfter: now() + backoff,
      failureCount: failures,
      userId: seed.userId,
      tenantId: seed.tenantId,
    });
  }

  function clearHold(key: string): void {
    holds.delete(key);
  }

  /**
   * Reclaims a hold whose bench is permanently gone rather than merely
   * quiet this tick (CL-7233). A hold already appearing in `due` is
   * left alone unconditionally — its row still exists, backoff or not.
   * For every other hold, `store.read` is the authoritative check
   * (unlike `due`, which is `listDue`'s capped-and-unordered page and
   * can omit a row that still exists): a row is deleted the moment it
   * is read past its TTL, so `undefined` here means the row is truly
   * gone, not just off this tick's page.
   */
  async function pruneOrphanedHolds(
    due: readonly PendingSeed[],
  ): Promise<void> {
    const dueKeys = new Set(due.map(benchKey));
    for (const [key, hold] of holds) {
      if (dueKeys.has(key)) continue;
      const row = await deps.store.read({
        userId: hold.userId,
        tenantId: hold.tenantId,
      });
      if (row === undefined) holds.delete(key);
    }
  }

  async function runOnce(seed: PendingSeed): Promise<BenchProvisionOutcome> {
    const cookies = await deps.sessionFor({
      userId: seed.userId,
      tenantId: seed.tenantId,
    });
    if (cookies === undefined) {
      logError(
        `bench provisioning for tenant ${seed.tenantId} has no session to act under; holding for a later pass`,
      );
      return "failed";
    }

    // Repair an empty or missing corbits-tools registry the same way
    // sign-in reconciles seed grants — before the fully-seeded check,
    // so a bench whose assistant is already deployed does not drain as
    // done while GET tarballs is still [].
    try {
      await runPublishToolRegistry({
        api: deps.api,
        cookies,
        hubUrl: deps.hubUrl,
        tenantId: seed.tenantId,
        log: deps.log,
      });
    } catch (cause) {
      reportError(cause, {
        operation: "pending_seed_publish_tool_registry",
        tenantId: seed.tenantId,
      });
      logError(
        `bench provisioning for tenant ${seed.tenantId} could not publish corbits-tools; holding for a later pass`,
      );
      return "failed";
    }

    if (await runIsFullySeeded(deps.api, cookies, seed.tenantId)) {
      await deps.store.clear({
        userId: seed.userId,
        tenantId: seed.tenantId,
      });
      return "converged";
    }

    const seededArgs = {
      api: deps.api,
      cookies,
      hubUrl: deps.hubUrl,
      pushWorkflow: deps.pushWorkflow,
      log: deps.log,
      tenant: {
        tenantId: seed.tenantId,
        tenantSlug: "",
        principalId: seed.principalId,
        tenantDomain: seed.tenantDomain,
      },
      provider: seed.provider,
      apiKey: seed.apiKey,
      ...(seed.baseURLOverride !== undefined
        ? { baseURLOverride: seed.baseURLOverride }
        : {}),
    };
    const result = await runEnsureSeeded(seededArgs);

    if (result.kind === "seeded-pending-agents") {
      deps.log(
        `bench ${seed.tenantId} is partly provisioned (${result.deployed.length} live, ${result.pending.length} waiting); its pending row stays for the next pass`,
      );
      return "pending";
    }

    await deps.store.clear({ userId: seed.userId, tenantId: seed.tenantId });
    deps.log(
      `bench ${seed.tenantId} finished provisioning: ${result.workflows.length} agents live`,
    );
    return "converged";
  }

  async function provisionBench(
    seed: PendingSeed,
  ): Promise<BenchProvisionOutcome | "deferred"> {
    const key = benchKey(seed);
    const running = inFlight.get(key);
    if (running !== undefined) return "deferred";

    const operation = (async (): Promise<BenchProvisionOutcome> => {
      try {
        const outcome = await runOnce(seed);
        if (outcome === "converged") clearHold(key);
        else holdOff(seed);
        return outcome;
      } catch (cause) {
        // report-error-ignore: CL-7234 routes this drain catch through
        // reportError the way provision.ts already does
        const message = cause instanceof Error ? cause.message : String(cause);
        logError(
          `bench provisioning for tenant ${seed.tenantId} failed; its pending row stays for a retry: ${message}`,
        );
        holdOff(seed);
        return "failed";
      }
    })();

    inFlight.set(key, operation);
    try {
      return await operation;
    } finally {
      if (inFlight.get(key) === operation) inFlight.delete(key);
    }
  }

  async function drainOnce(
    args: { ignoreBackoff?: boolean } = {},
  ): Promise<DrainReport> {
    const page = await deps.store.listDue({
      limit: PENDING_SEED_SCAN_LIMIT,
      ...(scanAfter !== undefined ? { after: scanAfter } : {}),
    });
    let converged = 0;
    let pending = 0;
    let failed = 0;
    let deferred = 0;

    for (const seed of page.seeds) {
      const key = benchKey(seed);
      const heldUntil = holds.get(key)?.retryAfter;
      if (
        args.ignoreBackoff !== true &&
        heldUntil !== undefined &&
        heldUntil > now()
      ) {
        deferred += 1;
        continue;
      }
      if (args.ignoreBackoff === true) clearHold(key);

      const outcome = await provisionBench(seed);
      if (outcome === "converged") converged += 1;
      else if (outcome === "pending") pending += 1;
      else if (outcome === "failed") failed += 1;
      else deferred += 1;
    }

    if (page.truncated && page.next !== undefined) {
      scanAfter = page.next;
    } else {
      scanAfter = undefined;
    }

    await pruneOrphanedHolds(page.seeds);

    return {
      converged,
      pending,
      failed,
      deferred,
      truncated: page.truncated,
    };
  }

  function wake(): void {
    void drainOnce().catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      logError(`bench provisioning drain failed: ${message}`);
      // Not scoped to any one bench — a whole-tick failure (listDue
      // itself throwing, say) rather than one seed's own provisioning
      // failure, which already carries tenant context via holdOff
      // (CL-7234).
      reportError(cause, { operation: "bench_provisioning_drain" });
    });
  }

  return {
    provisionBench,
    drainOnce,
    wake,
    start(args = {}) {
      if (timer !== undefined) return;
      timer = setInterval(
        wake,
        args.intervalMs ?? PROVISIONING_POLL_INTERVAL_MS,
      );
      timer.unref?.();
      wake();
    },
    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
