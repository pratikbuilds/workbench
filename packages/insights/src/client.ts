// Browser-safe Insights domain helpers: formatting, windowing, and empty
// defaults shared by any UI over packages/insights data. No postgres,
// drizzle, or hono import reaches this module — see client.test.ts.
//
// Absent *usage* (empty sink / no tenant) is zero metrics and an empty day
// series — see EMPTY_OVERALL_USAGE / activitySeriesForWindow. Null cost/rate
// still means "rate unknown" when turns exist; that is not coerced to zero.

export type TokenTotals = {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
  readonly thinking: number;
  readonly total: number;
};

export type ModelUsage = {
  readonly model: string;
  readonly turns: number;
  readonly tokens: TokenTotals;
  readonly costUsd: number | null;
};

export type OverallUsage = {
  readonly turns: number;
  readonly tokens: TokenTotals;
  readonly costUsd: number | null;
  readonly byModel: readonly ModelUsage[];
};

export type ModelDayUsage = {
  readonly model: string;
  readonly tokens: number;
  readonly costUsd: number | null;
};

export type DayActivity = {
  readonly day: string;
  readonly turns: number;
  readonly tokens: number;
  readonly byModel: readonly ModelDayUsage[];
};

/** One workbench's usage totals, ranked for the global landing's
 * activity-by-workbench chart. */
export type WorkbenchUsage = {
  readonly tenantId: string;
  readonly name: string;
  readonly turns: number;
  readonly tokens: TokenTotals;
  readonly costUsd: number | null;
};

/** Stable ISO from/to shared by usage, activity, and tools path builders. */
export type InsightsRange = {
  readonly from: string;
  readonly to: string;
};

/** Default Insights landing window (honest 7-day KPIs and charts). */
export const INSIGHTS_WINDOW_DAYS = 7;

/** Zero token totals — empty sink / no usage recorded. */
export const EMPTY_TOKEN_TOTALS: TokenTotals = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  thinking: 0,
  total: 0,
};

/**
 * Single empty-usage default for the Insights client. Use when there is no
 * tenant or the sink has no rows — never invent demo peaks. API errors must
 * surface as load failures, not this zero object. `costUsd` is 0 (no spend),
 * not null (unknown rate).
 */
export const EMPTY_OVERALL_USAGE: OverallUsage = {
  turns: 0,
  tokens: { ...EMPTY_TOKEN_TOTALS },
  costUsd: 0,
  byModel: [],
};

/**
 * Build a fixed [from, to] window ending at `now`. Pass an explicit `now`
 * (and keep the result) so React query keys stay stable across rerenders.
 */
export function createInsightsWindow(
  days: number = INSIGHTS_WINDOW_DAYS,
  now: Date = new Date(),
): InsightsRange {
  const to = now.toISOString();
  const from = new Date(
    now.getTime() - days * 24 * 60 * 60 * 1000,
  ).toISOString();
  return { from, to };
}

/**
 * Pad sparse (or empty) activity into a fixed day series ending on `range.to`.
 * Missing days are zero turns/tokens so charts stay shaped and never invent
 * nonzero peaks. Overlay preserves any real day counts from the sink.
 */
export function activitySeriesForWindow(
  days: readonly DayActivity[],
  range: InsightsRange,
  windowDays: number = INSIGHTS_WINDOW_DAYS,
): DayActivity[] {
  const end = new Date(range.to);
  const endUTC = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate(),
  );
  if (Number.isNaN(endUTC) || windowDays <= 0) return [];

  const dayMs = 86_400_000;
  const byDay = new Map(days.map((d) => [d.day, d] as const));
  const out: DayActivity[] = [];
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const key = new Date(endUTC - offset * dayMs).toISOString().slice(0, 10);
    const hit = byDay.get(key);
    out.push(hit ?? { day: key, turns: 0, tokens: 0, byModel: [] });
  }
  return out;
}

/**
 * Top N models by total cost across `days` (ties broken by tokens), for the
 * global landing's tokens/cost-over-time chart — same "≤5 series, sum the
 * rest" rule `TimeSeriesChart` itself documents, applied before the data
 * reaches it rather than inside it.
 */
export function topModelsByCost(
  days: readonly DayActivity[],
  limit = 5,
): readonly string[] {
  const totals = new Map<string, { cost: number; tokens: number }>();
  for (const day of days) {
    for (const entry of day.byModel) {
      const current = totals.get(entry.model) ?? { cost: 0, tokens: 0 };
      totals.set(entry.model, {
        cost: current.cost + (entry.costUsd ?? 0),
        tokens: current.tokens + entry.tokens,
      });
    }
  }
  return [...totals.entries()]
    .sort(([, a], [, b]) => b.cost - a.cost || b.tokens - a.tokens)
    .slice(0, limit)
    .map(([model]) => model);
}

/**
 * Format USD cost. Null/undefined means rate unknown → em-dash.
 * Zero is real empty spend → `$0.00` (do not treat as absent).
 */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value < 0.01 && value > 0) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Compact integer; null/undefined → em-dash. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString();
}

/** Rate 0–1 as percent; null → em-dash. */
export function formatRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value * 100)}%`;
}

export function durationLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function tokensLabel(
  tokens: {
    readonly input: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly output: number;
    readonly thinking: number;
  } | null,
): string | undefined {
  if (tokens === null) return undefined;
  const total =
    tokens.input +
    tokens.cacheRead +
    tokens.cacheWrite +
    tokens.output +
    tokens.thinking;
  // Zero total is real empty usage — omit chrome entirely. Never invent
  // "0 tok" (CL-6877 / DESIGN empty-zero).
  if (total === 0) return undefined;
  return `${total.toLocaleString()} tok`;
}

/**
 * Consumer-safe cost · tokens chrome for sidebar / compact usage lines.
 * Zero spend stays `$0.00`; zero or absent tokens omit the tok segment —
 * never `$0.00 · 0 tok`. Callers must not invent a `"0 tok"` fallback.
 */
export function usageChromeLabel(usage: {
  readonly costUsd: number | null | undefined;
  readonly tokens: {
    readonly input: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly output: number;
    readonly thinking: number;
  } | null;
}): string {
  const cost = formatUsd(usage.costUsd);
  const tok = tokensLabel(usage.tokens);
  if (usage.costUsd === null && tok === undefined) return "—";
  return tok === undefined ? cost : `${cost} · ${tok}`;
}

/** Models with tokens but no known rate (costUsd null). */
export function modelsWithMissingRates(usage: OverallUsage): readonly string[] {
  return usage.byModel
    .filter((m) => m.costUsd === null && m.tokens.total > 0)
    .map((m) => m.model);
}

/** Models that recorded turns but no token counts — not the same as $0 spend. */
export function modelsWithUnreportedTokens(
  usage: OverallUsage,
): readonly string[] {
  return usage.byModel
    .filter((m) => m.turns > 0 && m.tokens.total === 0)
    .map((m) => m.model);
}
