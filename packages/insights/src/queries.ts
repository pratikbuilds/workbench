import type { AuditAuthz } from "@intx/types/audit";

import {
  costUsd,
  totalTokens,
  type TokenClasses,
} from "@corbits/provider-pricing";

import type { UsageStore, UsageTurnRecord } from "./store";
import type { TurnLatencyStore } from "./latency-store";

export type TokenTotals = {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly thinking: number;
  readonly total: number;
};

export type ModelUsageSummary = {
  readonly model: string;
  readonly turns: number;
  readonly tokens: TokenTotals;
  /**
   * USD cost for this model, or null when any contributing turn has no
   * reported cost and no (provider, model) rate.
   */
  readonly costUsd: number | null;
};

export type OverallUsageSummary = {
  readonly turns: number;
  readonly tokens: TokenTotals;
  readonly costUsd: number | null;
  readonly byModel: readonly ModelUsageSummary[];
};

/** One model's tokens/cost within a single day bucket. */
export type ModelDayUsage = {
  readonly model: string;
  readonly tokens: number;
  /** USD cost for this model on this day, or null when its rate is unknown. */
  readonly costUsd: number | null;
};

export type DayActivity = {
  /** ISO date (YYYY-MM-DD) in UTC. */
  readonly day: string;
  readonly turns: number;
  readonly tokens: number;
  /** Same day's tokens/cost split by model — the global landing's
   * tokens/cost-over-time chart stacks on this rather than re-querying. */
  readonly byModel: readonly ModelDayUsage[];
};

/** One workbench's usage totals — the global landing's per-workbench
 * activity chart. */
export type WorkbenchUsage = {
  readonly tenantId: string;
  readonly turns: number;
  readonly tokens: TokenTotals;
  readonly costUsd: number | null;
};

function emptyTokens(): TokenClasses {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 };
}

function addTokens(a: TokenClasses, b: TokenClasses): TokenClasses {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    thinking: a.thinking + b.thinking,
  };
}

function toTotals(t: TokenClasses): TokenTotals {
  return { ...t, total: totalTokens(t) };
}

/** Empty-sink usage summary: zero turns/tokens/cost, no model rows. */
export function emptyOverallUsageSummary(): OverallUsageSummary {
  return {
    turns: 0,
    tokens: toTotals(emptyTokens()),
    costUsd: 0,
    byModel: [],
  };
}

function turnCostUsd(row: UsageTurnRecord): number | null {
  if (row.reportedCostUsd !== null) return row.reportedCostUsd;
  // A recorded turn with no token counts is not $0 spend — we did not
  // observe usage, so cost is unknown (CL-6659). Catalog FREE rates still
  // apply once tokens are present.
  if (totalTokens(row.tokens) === 0) return null;
  return costUsd({
    provider: row.provider ?? "",
    model: row.model,
    tokens: row.tokens,
  });
}

function addCosts(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a + b;
}

/** Fold a row set already scoped to the caller's tenant(s) into an overall
 * summary — the shared core `summarizeUsage` and `summarizeUsageByTenant`
 * both reduce to, so per-tenant and cross-tenant totals can never drift
 * apart in how a rate is applied or a null cost is decided. */
function summarizeRows(rows: readonly UsageTurnRecord[]): OverallUsageSummary {
  if (rows.length === 0) return emptyOverallUsageSummary();

  const byModel = new Map<
    string,
    { turns: number; tokens: TokenClasses; costUsd: number | null }
  >();
  for (const row of rows) {
    const current = byModel.get(row.model) ?? {
      turns: 0,
      tokens: emptyTokens(),
      costUsd: 0,
    };
    byModel.set(row.model, {
      turns: current.turns + 1,
      tokens: addTokens(current.tokens, row.tokens),
      costUsd: addCosts(current.costUsd, turnCostUsd(row)),
    });
  }

  const modelSummaries: ModelUsageSummary[] = [];
  let overallTokens = emptyTokens();
  let overallTurns = 0;
  let overallCost: number | null = 0;

  for (const [model, agg] of [...byModel.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    modelSummaries.push({
      model,
      turns: agg.turns,
      tokens: toTotals(agg.tokens),
      costUsd: agg.costUsd,
    });

    overallTokens = addTokens(overallTokens, agg.tokens);
    overallTurns += agg.turns;
    overallCost = addCosts(overallCost, agg.costUsd);
  }

  return {
    turns: overallTurns,
    tokens: toTotals(overallTokens),
    costUsd: overallCost,
    byModel: modelSummaries,
  };
}

/**
 * Aggregate usage by model and overall for a tenant scope. `tenantIds`
 * is one tenant for a single-workbench view, or a workspace parent plus
 * its child workbenches for the cross-workbench rollup — the sum happens
 * here, at the DB-query layer, not by the caller fetching per tenant and
 * adding client-side. Empty sink → zeros (see emptyOverallUsageSummary).
 * Cost is null when any contributing class lacks a rate — never a
 * fabricated cost for unknown rates.
 */
export async function summarizeUsage(
  store: UsageStore,
  tenantIds: readonly string[],
  opts?: { from?: Date; to?: Date },
): Promise<OverallUsageSummary> {
  const rows = await store.listUsageByTenants(tenantIds, opts);
  if (rows.length === 0) return emptyOverallUsageSummary();
  return summarizeRows(rows);
}

/**
 * Same rollup as `summarizeUsage`, but split back out per tenant — the
 * global Insights landing's "activity by workbench" chart, so it can rank
 * and link to individual workbenches instead of only seeing their sum.
 * Every id in `tenantIds` gets an entry, zeroed when that tenant recorded
 * no usage in range, so a quiet workbench still shows up as a zero bar
 * rather than silently disappearing from the ranking.
 */
export async function summarizeUsageByTenant(
  store: UsageStore,
  tenantIds: readonly string[],
  opts?: { from?: Date; to?: Date },
): Promise<readonly WorkbenchUsage[]> {
  const rows = await store.listUsageByTenants(tenantIds, opts);

  const byTenant = new Map<string, UsageTurnRecord[]>();
  for (const row of rows) {
    const bucket = byTenant.get(row.tenantId);
    if (bucket === undefined) byTenant.set(row.tenantId, [row]);
    else bucket.push(row);
  }

  return tenantIds.map((tenantId) => {
    const summary = summarizeRows(byTenant.get(tenantId) ?? []);
    return {
      tenantId,
      turns: summary.turns,
      tokens: summary.tokens,
      costUsd: summary.costUsd,
    };
  });
}

/**
 * Team-space `/workbenches` rows: drop an empty parent (it is a duplicate
 * of the "All workbenches" landing, CL-6368). Keep the parent when it
 * recorded turns of its own — otherwise those turns vanish from the
 * breakdown (CL-6659).
 */
export function teamSpaceWorkbenchRows<
  T extends { readonly tenantId: string; readonly turns: number },
>(
  rows: readonly T[],
  opts: { readonly tenantId: string; readonly isTeamSpace: boolean },
): readonly T[] {
  if (!opts.isTeamSpace) return rows;
  return rows.filter((row) => row.tenantId !== opts.tenantId || row.turns > 0);
}

/**
 * Activity histogram by UTC day across a tenant scope (see summarizeUsage
 * for what `tenantIds` means). Token totals are known when the adapter
 * reported them; a recorded turn with every class at zero is an honest
 * absence, not $0.00. Pre-sink history simply does not appear.
 */
export async function activityByDay(
  store: UsageStore,
  tenantIds: readonly string[],
  opts?: { from?: Date; to?: Date },
): Promise<readonly DayActivity[]> {
  const rows = await store.listUsageByTenants(tenantIds, opts);
  const days = new Map<
    string,
    {
      turns: number;
      tokens: number;
      byModel: Map<string, { tokens: TokenClasses; costUsd: number | null }>;
    }
  >();

  for (const row of rows) {
    const day = row.recordedAt.toISOString().slice(0, 10);
    const current = days.get(day) ?? {
      turns: 0,
      tokens: 0,
      byModel: new Map(),
    };
    current.turns += 1;
    current.tokens += totalTokens(row.tokens);
    const modelAgg = current.byModel.get(row.model) ?? {
      tokens: emptyTokens(),
      costUsd: 0,
    };
    current.byModel.set(row.model, {
      tokens: addTokens(modelAgg.tokens, row.tokens),
      costUsd: addCosts(modelAgg.costUsd, turnCostUsd(row)),
    });
    days.set(day, current);
  }

  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, agg]) => ({
      day,
      turns: agg.turns,
      tokens: agg.tokens,
      byModel: [...agg.byModel.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([model, modelAgg]) => ({
          model,
          tokens: totalTokens(modelAgg.tokens),
          costUsd: modelAgg.costUsd,
        })),
    }));
}

/**
 * Run-trace detail is owned by workflow_run / inference_turn / turn_part
 * in the platform schema (see @corbits/insights' createDrizzleRunTraceReader
 * for the concrete reader). This package's route layer does not re-query
 * those tables itself — the hub mount injects a RunTraceReader. A tenant
 * that mounts none receives an explicit absent result rather than a
 * fabricated empty trace.
 */
export type RunTraceSpan = {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly durationMs: number | null;
  readonly tokens: TokenClasses | null;
  readonly phase: "ok" | "awaiting" | "failed";
  readonly error: string | null;
  /**
   * Authorization verdict for a `kind: "tool"` span. Verdicts are recorded
   * only in the sidecar-side git-backed audit trail (`AuditRecord`, written
   * via `IsogitStore.commitAudit`), which the hub's Postgres-only
   * composition root has no read path into today — so this is always
   * `null` for now, an honest absence rather than a fabricated verdict.
   * The field exists so CL-5927 (Settings · Audit) can consume tool-call
   * rows from this same reader once that read path is wired.
   * Only ever populated for `kind: "tool"` spans (other kinds never carry
   * a verdict); `undefined` and `null` are not interchangeable here —
   * optional (`authz?:`) only because most call sites never set it, while
   * the reader always sets `null` explicitly for tool spans as an honest
   * "not reachable yet" rather than an unset "no opinion on whether this
   * exists".
   */
  readonly authz?: AuditAuthz | null;
  /**
   * How this span's start/end were derived. "measured" means real
   * wall-clock timestamps (inference_turn.startedAt/endedAt); "ordinal"
   * means the span was positioned by turn_part.ordinal within its
   * enclosing turn's window, not a real timestamp (see `positionInTurn`
   * in trace-reader.ts) — an honest sequence marker, not a duration
   * measurement.
   */
  readonly timingSource: "measured" | "ordinal";
};

export type RunTrace = {
  readonly runId: string;
  readonly spans: readonly RunTraceSpan[];
};

export type RunTraceReader = {
  getTrace(tenantId: string, runId: string): Promise<RunTrace | null>;
};

export type ToolCallSummary = {
  readonly tool: string;
  readonly calls: number;
  readonly errors: number;
  readonly errorRate: number | null;
};

/**
 * Calls-by-tool requires turn_part access. When no reader is mounted,
 * return an empty list (no fabricated tools) and document the gap.
 * `tenantIds` carries the same single-tenant-or-scope contract as
 * summarizeUsage/activityByDay — a real reader owns merging across the
 * scope itself, at its own query layer.
 */
export type ToolCallReader = {
  summarize(
    tenantIds: readonly string[],
    opts?: { from?: Date; to?: Date },
  ): Promise<readonly ToolCallSummary[]>;
};

export function emptyToolCallReader(): ToolCallReader {
  return {
    async summarize() {
      return [];
    },
  };
}

/**
 * Nearest-rank percentile over already-sorted-ascending values. Null on
 * an empty input — no fabricated p50/p95 for a stage with zero samples.
 */
export function percentile(
  sorted: readonly number[],
  p: number,
): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(p * sorted.length) - 1;
  const clamped = Math.min(Math.max(rank, 0), sorted.length - 1);
  return sorted[clamped] ?? null;
}

/** p50/p95 (milliseconds) over one stage's durations, or null when that
 * stage recorded no samples in range — e.g. `reactorStart` on a scope
 * with no cold starts this window. */
export type LatencyStageStat = {
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly samples: number;
};

export type LatencySummary = {
  /** message-received → reactor.start (cold starts only; see TurnLatencyRecord). */
  readonly toReactorStart: LatencyStageStat;
  /** reactor.start (or message-received, on a warm session) → inference.start. */
  readonly toInferenceStart: LatencyStageStat;
  /** inference.start → first token. */
  readonly toFirstToken: LatencyStageStat;
  /** first token → reply posted. */
  readonly toReplyPosted: LatencyStageStat;
  /** message-received → reply posted, end to end. */
  readonly total: LatencyStageStat;
};

function stageStat(durationsMs: number[]): LatencyStageStat {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  return {
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    samples: sorted.length,
  };
}

/**
 * Aggregates recorded message-run latency into p50/p95 per stage across a
 * tenant scope (same `tenantIds` contract as summarizeUsage). A row
 * missing a stage's timestamp (a warm session's null `reactorStartAt`)
 * simply contributes no sample to that stage — it is not zeroed and it
 * is not dropped from the other stages it did record.
 */
export async function summarizeLatency(
  store: TurnLatencyStore,
  tenantIds: readonly string[],
  opts?: { from?: Date; to?: Date },
): Promise<LatencySummary> {
  const rows = await store.listLatencyByTenants(tenantIds, opts);

  const toReactorStart: number[] = [];
  const toInferenceStart: number[] = [];
  const toFirstToken: number[] = [];
  const toReplyPosted: number[] = [];
  const total: number[] = [];

  for (const row of rows) {
    const receivedAt = row.receivedAt.getTime();
    const replyPostedAt = row.replyPostedAt.getTime();
    total.push(replyPostedAt - receivedAt);

    if (row.reactorStartAt !== null) {
      toReactorStart.push(row.reactorStartAt.getTime() - receivedAt);
    }
    const inferenceStartFrom = row.reactorStartAt ?? row.receivedAt;
    if (row.inferenceStartAt !== null) {
      toInferenceStart.push(
        row.inferenceStartAt.getTime() - inferenceStartFrom.getTime(),
      );
    }
    if (row.inferenceStartAt !== null && row.firstTokenAt !== null) {
      toFirstToken.push(
        row.firstTokenAt.getTime() - row.inferenceStartAt.getTime(),
      );
    }
    if (row.firstTokenAt !== null) {
      toReplyPosted.push(replyPostedAt - row.firstTokenAt.getTime());
    }
  }

  return {
    toReactorStart: stageStat(toReactorStart),
    toInferenceStart: stageStat(toInferenceStart),
    toFirstToken: stageStat(toFirstToken),
    toReplyPosted: stageStat(toReplyPosted),
    total: stageStat(total),
  };
}

export type { UsageTurnRecord };
