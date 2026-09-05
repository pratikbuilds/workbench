// Insights over packages/insights: cost KPIs, activity bars, token mosaic,
// cost-by-model, calls-by-tool, recent purpose runs, runs history, and
// run-trace detail. Data may still be EMPTY_OVERALL_USAGE /
// activitySeriesForWindow at the client boundary; zero-turn landings hide
// Cost / Activity / Tokens chrome rather than showing zero KPI tiles. Null
// cost/rate still means "rate unknown" when turns exist — em-dash, not a
// fabricated cost.
// Stage layout mirrors the shell mock: KPI row → chart/card grid → recent runs.

import {
  Badge,
  BarChart,
  PageShell,
  RichEmptyState,
  RUN_STATUS_DOT_TONE,
  RUN_STATUS_TONE,
  Skeleton,
  StatGrid,
  StatGridItem,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TimeSeriesChart,
  TokenMosaic,
  TraceWaterfall,
  type BadgeTone,
  type RunStatus,
  type TraceSpan,
} from "@corbits/react-ui";
import { ChartBar } from "@corbits/icons";
import {
  runOutcomeStatus,
  runStatusLabel,
  withListingAbandoned,
} from "@corbits/workflows/client";
import type * as React from "react";
import { useEffect, useMemo, useState } from "react";

import {
  activitySeriesForWindow,
  createInsightsWindow,
  durationLabel,
  EMPTY_OVERALL_USAGE,
  formatCount,
  formatRate,
  formatUsd,
  INSIGHTS_WINDOW_DAYS,
  modelsWithMissingRates,
  modelsWithUnreportedTokens,
  tokensLabel,
  topModelsByCost,
  type DayActivity,
  type InsightsRange,
  type ModelUsage,
  type OverallUsage,
} from "@corbits/insights/client";

import { workflowRunStatuses, type WorkflowRunStatus } from "@intx/types";
import { SignedOutNotice, type APIQuery } from "@corbits/api-query";
import {
  workbenchesQueryKey,
  listWorkbenches,
  type Workbench,
} from "@corbits/chat-ui";

import { useAPIQuery } from "../api";
import { useBench } from "../bench-context";
import {
  workbenchIdForWorkbenchTenant,
  resolveWorkbenchInsightsScope,
  type WorkbenchInsightsResolution,
} from "../insights-workbench-scope";
import { workbenchInsightsPath } from "../insights-deeplinks";
import { parseInsightsPath } from "../insights-path";
import {
  ActivityResponseSchema,
  InsightsScopeSchema,
  LatencySummarySchema,
  OverallUsageSchema,
  RunTraceSchema,
  ToolsResponseSchema,
  TopLevelRunsSchema,
  WorkbenchesResponseSchema,
  insightsActivityPath,
  insightsLatencyPath,
  insightsRunTracePath,
  insightsScopePath,
  insightsToolsPath,
  insightsTopLevelRunsPath,
  insightsUsagePath,
  insightsWorkbenchesPath,
  type InsightsRun,
  type InsightsScope,
  type LatencySummary,
  type RunTrace,
  type ToolCall,
  type WorkbenchUsage,
} from "../insights-api";
import {
  computeInsightsStats,
  computeTraceStats,
  filterRunsByCreatedAt,
  groupRunsByDefinition,
  purposeRunsForInsights,
  runDisplayName,
} from "../insights-stats";
import { useNavigate } from "../navigation";
import { tenantKeys } from "../query-client";
import { INSIGHTS_PATH_PREFIX, INSIGHTS_RUNS_PATH } from "../path-ids";
import { StageTopBar } from "../shell/stage-top-bar";
import {
  listScheduledWorkflows,
  useTenantQuery,
  type ScheduledWorkflowDefinition,
} from "../routines-api";
import { WorkbenchTimelineRoute } from "./workbench-timeline";

function dash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A platform workflow run's status (`WorkflowRunStatus`) doesn't spell
 * react-ui's `RunStatus` vocabulary the same way — normalize onto it here
 * so the badge tone always comes from `RUN_STATUS_TONE`, the one source
 * every run-status tone reads from, rather than a second opinion invented
 * on this page. */
const WORKFLOW_RUN_STATUS_ALIAS: Readonly<
  Record<WorkflowRunStatus, RunStatus>
> = {
  deployed: "completed",
  running: "running",
  updating: "running",
  error: "failed",
  stopped: "stopped",
};

export function statusTone(status: WorkflowRunStatus): BadgeTone {
  return RUN_STATUS_TONE[WORKFLOW_RUN_STATUS_ALIAS[status]];
}

function isWorkflowRunStatus(status: string): status is WorkflowRunStatus {
  return workflowRunStatuses.some((value) => value === status);
}

function insightsStatusTone(status: string): BadgeTone {
  if (status === "completed") return RUN_STATUS_TONE.completed;
  if (status === "failed") return RUN_STATUS_TONE.failed;
  if (status === "cancelled") return RUN_STATUS_TONE.stopped;
  if (isWorkflowRunStatus(status)) return statusTone(status);
  return "neutral";
}

function tileValue(value: string | number | null, loading: boolean): string {
  if (loading) return "";
  if (value === null) return "—";
  return String(value);
}

/** "1.2s / 3.4s" for a latency stage's p50/p95, or an em-dash pair when
 * the stage recorded no samples in range (see LatencyStageStat). */
function latencyStatValue(stat: {
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
}): string {
  const p50 = stat.p50Ms === null ? "—" : durationLabel(stat.p50Ms);
  const p95 = stat.p95Ms === null ? "—" : durationLabel(stat.p95Ms);
  return `${p50} / ${p95}`;
}

function tokenParts(summary: OverallUsage) {
  const t = summary.tokens;
  return [
    { label: "Input", value: t.input },
    { label: "Output", value: t.output },
    { label: "Cache read", value: t.cacheRead },
    { label: "Cache write", value: t.cacheWrite },
    { label: "Thinking", value: t.thinking },
  ].filter((p) => p.value > 0);
}

export function toTraceSpans(trace: RunTrace): TraceSpan[] {
  if (trace.spans === null || trace.spans.length === 0) return [];
  const origin = Math.min(...trace.spans.map((s) => s.start), 0);
  const end = Math.max(...trace.spans.map((s) => s.end), origin + 1);
  const span = Math.max(1, end - origin);
  return trace.spans.map((s) => {
    const base = {
      id: s.id,
      label: s.label,
      kind: s.kind,
      start: (s.start - origin) / span,
      end: (s.end - origin) / span,
      durationLabel: s.durationMs === null ? null : durationLabel(s.durationMs),
      phase: s.phase,
      timingSource: s.timingSource,
    };
    const tok = tokensLabel(s.tokens);
    if (s.error !== null && tok !== undefined) {
      return { ...base, tokensLabel: tok, error: s.error };
    }
    if (s.error !== null) return { ...base, error: s.error };
    if (tok !== undefined) return { ...base, tokensLabel: tok };
    return base;
  });
}

function cacheHitRate(summary: OverallUsage): number | null {
  const t = summary.tokens;
  const denom = t.input + t.cacheRead;
  if (denom === 0) return null;
  return t.cacheRead / denom;
}

/** Weekday short label for a UTC YYYY-MM-DD activity day. */
function dayWeekdayLabel(day: string): string {
  const date = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return day.slice(5);
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    timeZone: "UTC",
  });
}

/** Prefer the most recent 7 buckets when the sink returns a longer window. */
function recentActivityDays(
  days: readonly DayActivity[],
  limit = 7,
): readonly DayActivity[] {
  if (days.length <= limit) return days;
  return days.slice(days.length - limit);
}

function runsDetailLabel(stats: {
  readonly running: number;
  readonly errored: number;
}): string {
  if (stats.running > 0) {
    return `${formatCount(stats.running)} running`;
  }
  if (stats.errored > 0) {
    return `${formatCount(stats.errored)} errored`;
  }
  return "runs";
}

function InsightsStat({
  label,
  value,
  detail,
  onClick,
  loading,
  sparklineValues,
  sparklineLabel,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly onClick?: () => void;
  readonly loading?: boolean;
  /** Real per-day series backing this tile's trend line — omitted (not
   * padded/estimated) whenever the underlying window lacks one. */
  readonly sparklineValues?: readonly number[];
  readonly sparklineLabel?: string;
}) {
  if (loading === true) {
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-4">
        <span className="text-[10px] font-semibold tracking-[0.12em] uppercase text-muted-foreground">
          {label}
        </span>
        <Skeleton className="h-[26px] w-16" />
      </div>
    );
  }
  return (
    <StatGridItem
      label={label}
      value={value}
      {...(detail === undefined ? {} : { sub: detail })}
      {...(onClick === undefined ? {} : { onClick })}
      {...(sparklineValues === undefined ? {} : { sparklineValues })}
      {...(sparklineLabel === undefined ? {} : { sparklineLabel })}
    />
  );
}

/** Clickable-row semantics shared by the recent-runs and history tables —
 * mirrors react-ui's `DataTable` row affordance (button role, Enter/Space
 * activation) for tables fed by data already resident in this page. */
function onRowActivate(onActivate: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    className: "cursor-pointer insights-row-clickable",
    onClick: onActivate,
    onKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onActivate();
      }
    },
  };
}

function ActivityBars({ days }: { readonly days: readonly DayActivity[] }) {
  const window = recentActivityDays(days);
  return (
    <BarChart
      title="Activity"
      description={`Last ${window.length} days`}
      data={window.map((d) => ({
        label: dayWeekdayLabel(d.day),
        value: d.turns,
      }))}
      valueLabel="Turns"
      format={formatCount}
    />
  );
}

/** Workbenches that recorded at least one turn in the window — the global
 * landing's "active workbenches" KPI. Never counts a workbench that only
 * exists (a leaf with zero usage) as active. */
function activeWorkbenchCount(workbenches: readonly WorkbenchUsage[]): number {
  return workbenches.filter((w) => w.turns > 0).length;
}

const WORKBENCH_BARS_LIMIT = 8;

/**
 * Ranked activity-by-workbench list: the tenancy-wide landing's answer to
 * "which workbenches are actually busy" — each row a mini bar (relative to
 * the busiest workbench in view) that opens that workbench's own scoped
 * view, same clickable-row affordance as the rest of this page
 * (`onRowActivate`) rather than a bespoke chart interaction.
 */
function WorkbenchActivityBars({
  workbenches,
  onSelectWorkbench,
}: {
  readonly workbenches: readonly WorkbenchUsage[];
  readonly onSelectWorkbench: (tenantId: string) => void;
}) {
  const ranked = [...workbenches]
    .sort((a, b) => b.turns - a.turns)
    .slice(0, WORKBENCH_BARS_LIMIT);
  const max = Math.max(1, ...ranked.map((w) => w.turns));

  return (
    <Table aria-label="Activity by workbench" className="insights-data-table">
      <TableBody>
        {ranked.map((workbench) => (
          <TableRow
            key={workbench.tenantId}
            {...onRowActivate(() => onSelectWorkbench(workbench.tenantId))}
          >
            <TableCell>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-sm font-semibold">
                  {workbench.name}
                </span>
                <div className="insights-workbench-bar-track">
                  <div
                    className="insights-workbench-bar-fill"
                    style={{ width: `${(workbench.turns / max) * 100}%` }}
                  />
                </div>
              </div>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatCount(workbench.turns)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** "Done" folds every settled-without-error outcome (deployed and manually
 * stopped) together — the landing asks for done vs. failed, not a full
 * status breakdown (that detail stays on the KPI tiles / run history). */
function runOutcomeData(stats: {
  readonly deployed: number;
  readonly stopped: number;
  readonly errored: number;
  readonly running: number;
}) {
  return [
    { label: "Done", value: stats.deployed + stats.stopped },
    { label: "Failed", value: stats.errored },
    { label: "Running", value: stats.running },
  ];
}

/** Tokens-by-model series for the tokens-over-time chart. Token volume is
 * a known number only when the adapter reported it; unreported turns are
 * excluded from this series rather than plotted as a silent zero. Capped
 * to the top models by cost (the models that matter most to the spend
 * story), same as `TimeSeriesChart`'s own "≤5 series" rule. */
function tokensOverTimeSeries(days: readonly DayActivity[]) {
  const models = topModelsByCost(days).filter((model) =>
    days.some(
      (d) => (d.byModel.find((m) => m.model === model)?.tokens ?? 0) > 0,
    ),
  );
  return models.map((model) => ({
    label: model,
    values: days.map(
      (day) => day.byModel.find((m) => m.model === model)?.tokens ?? 0,
    ),
  }));
}

/** Real per-day run counts, bucketed onto `activityDays`' own UTC day keys —
 * the Runs KPI's sparkline shape, built from the same run records the
 * recent-runs/history tables render rather than a synthesized series. */
export function runsPerDay(
  runs: readonly InsightsRun[],
  days: readonly DayActivity[],
): number[] {
  const counts = new Map<string, number>(days.map((d) => [d.day, 0]));
  for (const run of runs) {
    const day = run.createdAt.slice(0, 10);
    const current = counts.get(day);
    if (current !== undefined) counts.set(day, current + 1);
  }
  return days.map((d) => counts.get(d.day) ?? 0);
}

/** Real per-day cost, summed across models — the Cost KPI's sparkline
 * shape. Callers only use this when every model's rate is known for the
 * window (`modelsWithMissingRates` is empty); otherwise a day with an
 * unpriced model would silently read as cheaper than it was. */
export function costPerDay(days: readonly DayActivity[]): number[] {
  return days.map((d) =>
    d.byModel.reduce((sum, m) => sum + (m.costUsd ?? 0), 0),
  );
}

/** Wall-clock time since a run started, in the same "2m 12s" form as the
 * rest of this page (`durationLabel`) — never a fabricated live counter. */
export function elapsedLabel(createdAt: string, now: number): string {
  const startMs = Date.parse(createdAt);
  if (Number.isNaN(startMs)) return "—";
  return durationLabel(Math.max(0, now - startMs));
}

const ELAPSED_TICK_MS = 1_000;

/** Ticks once a second while `enabled` — the clock the elapsed label next to
 * the pulsing `StatusDot` reads from, so it counts up like the live indicator
 * beside it instead of freezing at whatever instant this component mounted
 * or last re-rendered for an unrelated reason. */
function useTickingNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/** A run actually in flight right now (`status: running | updating`) —
 * liveness is not a windowed property, so this filters the full run set,
 * never the range-filtered one. A persisted `endedAt` means the fire
 * already finished, even if `status` still reads `running`. A live fire
 * with an in-flight turn stays in flight however old it is; without an
 * explicit no-in-flight signal, missing `turns` is not abandonment.
 */
export function isRunningNow(
  run: InsightsRun,
  now: number = Date.now(),
): boolean {
  const outcome = runOutcomeStatus(withListingAbandoned(run, now), now);
  return outcome === "running" || outcome === "updating";
}

function insightsRunStatus(run: InsightsRun, now: number = Date.now()): string {
  return runOutcomeStatus(withListingAbandoned(run, now), now) ?? run.status;
}

/**
 * "Running now" — a horizontally scrolling strip of the runs actually in
 * flight this instant (`status: running | updating`), not a fabricated
 * live-metrics ticker. Renders nothing when nothing is running, same
 * convention as react-ui's `WorkflowDock`: an empty "nothing running" strip
 * is a permanent fixture reporting the normal case, not an empty state worth
 * showing.
 */
function RunningNowStrip({
  runs,
  onOpenRun,
}: {
  readonly runs: readonly InsightsRun[];
  readonly onOpenRun: (id: string) => void;
}) {
  const maybeLive = runs.some(
    (run) => run.status === "running" || run.status === "updating",
  );
  const now = useTickingNow(maybeLive);
  const running = runs.filter((run) => isRunningNow(run, now));
  if (running.length === 0) return null;

  return (
    <section className="insights-running-now" aria-label="Running now">
      <div className="insights-running-now-head">
        <h3>Running now</h3>
        <span className="insights-running-now-count">
          {formatCount(running.length)} in progress
        </span>
      </div>
      <ul className="insights-running-now-strip">
        {running.map((run) => (
          <li key={run.id}>
            <button
              type="button"
              className="insights-flight"
              onClick={() => onOpenRun(run.id)}
            >
              <StatusDot
                label={runStatusLabel("running")}
                tone={RUN_STATUS_DOT_TONE.running}
                live
              />
              <span className="insights-flight-name">
                {runDisplayName(run)}
              </span>
              <span className="insights-flight-elapsed">
                {elapsedLabel(run.createdAt, now)}
              </span>
              <Badge tone={RUN_STATUS_TONE.running}>
                {runStatusLabel("running")}
              </Badge>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ModelCostTable({
  models,
}: {
  readonly models: readonly ModelUsage[];
}) {
  return (
    <Table
      aria-label="Cost by model"
      className="insights-data-table insights-table-inert"
    >
      <TableHeader>
        <TableRow>
          <TableHead>Model</TableHead>
          <TableHead>Cost</TableHead>
          <TableHead>Input</TableHead>
          <TableHead>Cache read</TableHead>
          <TableHead>Output</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.map((m) => (
          <TableRow key={m.model}>
            <TableCell title={m.model}>{m.model}</TableCell>
            <TableCell>
              {m.costUsd === null || (m.tokens.total === 0 && m.turns > 0)
                ? "—"
                : formatUsd(m.costUsd)}
            </TableCell>
            <TableCell>
              {m.tokens.total === 0 && m.turns > 0
                ? "—"
                : formatCount(m.tokens.input)}
            </TableCell>
            <TableCell>
              {m.tokens.total === 0 && m.turns > 0
                ? "—"
                : formatCount(m.tokens.cacheRead)}
            </TableCell>
            <TableCell>
              {m.tokens.total === 0 && m.turns > 0
                ? "—"
                : formatCount(m.tokens.output)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ToolCallsTable({ tools }: { readonly tools: readonly ToolCall[] }) {
  return (
    <Table
      aria-label="Calls by tool"
      className="insights-data-table insights-table-inert"
    >
      <TableHeader>
        <TableRow>
          <TableHead>Tool</TableHead>
          <TableHead>Calls</TableHead>
          <TableHead>Errors</TableHead>
          <TableHead>Error rate</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tools.map((t) => (
          <TableRow key={t.tool}>
            <TableCell title={t.tool}>{t.tool}</TableCell>
            <TableCell>{formatCount(t.calls)}</TableCell>
            <TableCell>{formatCount(t.errors)}</TableCell>
            <TableCell>{formatRate(t.errorRate)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RecentRunRows({
  runs,
  onOpenRun,
  onOpenRuns,
}: {
  readonly runs: readonly InsightsRun[];
  readonly onOpenRun: (id: string) => void;
  readonly onOpenRuns: () => void;
}) {
  return (
    <Table aria-label="Recent runs" className="insights-data-table">
      <TableBody>
        {runs.map((row) => (
          <TableRow
            key={row.id}
            data-ctx-insights-run={row.id}
            {...onRowActivate(() => onOpenRun(row.id))}
          >
            <TableCell>
              <div className="flex min-w-0 flex-col gap-0.5">
                <strong className="truncate text-sm font-semibold">
                  {runDisplayName(row)}
                </strong>
                <span className="truncate text-xs text-muted-foreground">
                  {formatWhen(row.createdAt)}
                </span>
              </div>
            </TableCell>
            <TableCell className="text-right">
              <Badge tone={insightsStatusTone(insightsRunStatus(row))}>
                {runStatusLabel(insightsRunStatus(row))}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
        <TableRow {...onRowActivate(onOpenRuns)}>
          <TableCell
            colSpan={2}
            className="font-semibold text-primary-emphasis"
          >
            All runs & traces →
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

function InsightsLanding({
  summary,
  activity,
  byModel,
  byTool,
  runs,
  runsNextCursor,
  routines,
  workbenches,
  latency,
  range,
  loading,
  onOpenRun,
  onOpenRuns,
  onSelectWorkbench,
}: {
  readonly summary: OverallUsage | null;
  readonly activity: readonly DayActivity[] | null;
  readonly byModel: readonly ModelUsage[] | null;
  readonly byTool: readonly ToolCall[] | null;
  readonly runs: readonly InsightsRun[];
  /** The feed's own `nextCursor` (`limit=100` fetch, see
   * `insightsTopLevelRunsPath`) — non-null means more runs exist in this
   * window than the 100 fetched, so the KPIs/sparkline/outcome chart below
   * disclose the cap instead of silently presenting a truncated series as
   * complete. */
  readonly runsNextCursor: string | null;
  readonly routines: readonly ScheduledWorkflowDefinition[];
  /** Null while `/workbenches` hasn't resolved (or this landing is already
   * scoped to one workbench, where a breakdown of one has nothing to
   * show) — the activity-by-workbench chart and active-workbenches KPI
   * both hide rather than render a fabricated single-row chart. */
  readonly workbenches: readonly WorkbenchUsage[] | null;
  /** Null while `/latency` (CL-6257) hasn't resolved. */
  readonly latency: LatencySummary | null;
  /** Same 7-day window as usage/activity/tools requests. */
  readonly range: InsightsRange;
  readonly loading: boolean;
  readonly onOpenRun: (id: string) => void;
  readonly onOpenRuns: () => void;
  readonly onSelectWorkbench: (tenantId: string) => void;
}) {
  // KPI count + recent list only — history/detail keep full run list.
  const windowedRuns = filterRunsByCreatedAt(runs, range.from, range.to);
  const stats = computeInsightsStats(windowedRuns, routines);
  const purposeRuns = purposeRunsForInsights(windowedRuns);

  // Liveness is not a windowed property: a run that started before
  // `range.from` and is still going is running right now regardless of when
  // it started, so "Running now" reads off every fetched run, never the
  // range-filtered subset above.
  const runningNow = purposeRunsForInsights(runs).filter((run) =>
    isRunningNow(run),
  );

  // Absent usage → zeros at the client boundary (never demo peaks / em-dash
  // for "no spend"). Real fetched summary is preserved when present.
  const usage = summary ?? EMPTY_OVERALL_USAGE;
  const mosaicParts = tokenParts(usage);
  const hitRate = cacheHitRate(usage);
  const missingRates = modelsWithMissingRates(usage);
  const unreportedTokens = modelsWithUnreportedTokens(usage);
  const tokensUnreported = usage.turns > 0 && usage.tokens.total === 0;
  const activityDays = activitySeriesForWindow(activity ?? [], range);
  const activityWindowEmpty = recentActivityDays(activityDays).every(
    (d) => d.turns === 0,
  );
  const models = byModel !== null && byModel.length > 0 ? byModel : null;
  const tools = byTool !== null && byTool.length > 0 ? byTool : null;
  const recent = purposeRuns.slice(0, 12);
  const tokensSeries = tokensOverTimeSeries(activityDays);
  const noUsageInWindow = !loading && usage.turns === 0;

  // KPI sparklines: only ever a real per-day series already backing this
  // window's other charts, never estimated to fill a gap.
  const turnsSparkline = activityDays.map((d) => d.turns);
  const tokensSparkline = activityDays.map((d) => d.tokens);
  const runsSparkline = runsPerDay(purposeRuns, activityDays);
  const costSparkline =
    missingRates.length === 0 && unreportedTokens.length === 0
      ? costPerDay(activityDays)
      : undefined;

  return (
    <div className="insights-layout">
      <StatGrid columns={4}>
        {noUsageInWindow ? null : (
          <InsightsStat
            label="Cost"
            value={tileValue(
              tokensUnreported ? "—" : formatUsd(usage.costUsd),
              loading,
            )}
            detail={
              tokensUnreported
                ? "Token counts were not reported"
                : `${formatCount(usage.tokens.total)} tokens`
            }
            loading={loading}
            sparklineLabel="Cost per day this week"
            {...(costSparkline === undefined
              ? {}
              : { sparklineValues: costSparkline })}
          />
        )}
        {noUsageInWindow ? null : (
          <InsightsStat
            label="Activity"
            value={tileValue(formatCount(usage.turns), loading)}
            detail="turns"
            loading={loading}
            sparklineValues={turnsSparkline}
            sparklineLabel="Turns per day this week"
          />
        )}
        {noUsageInWindow ? null : (
          <InsightsStat
            label="Tokens in / out"
            value={tileValue(
              tokensUnreported
                ? "—"
                : `${formatCount(usage.tokens.input)} / ${formatCount(usage.tokens.output)}`,
              loading,
            )}
            detail={tokensUnreported ? "not reported" : "input / output"}
            loading={loading}
            {...(tokensUnreported ? {} : { sparklineValues: tokensSparkline })}
            sparklineLabel="Tokens per day this week"
          />
        )}
        <InsightsStat
          label="Runs"
          value={tileValue(formatCount(stats.totalRuns), loading)}
          detail={runsDetailLabel(stats)}
          onClick={onOpenRuns}
          loading={loading}
          sparklineValues={runsSparkline}
          sparklineLabel="Runs per day this week"
        />
        {workbenches !== null ? (
          <InsightsStat
            label="Active workbenches"
            value={tileValue(
              `${formatCount(activeWorkbenchCount(workbenches))} / ${formatCount(workbenches.length)}`,
              loading,
            )}
            detail="with usage this window"
            loading={loading}
          />
        ) : null}
        {runningNow.length > 0 || loading ? (
          <InsightsStat
            label="Running now"
            value={tileValue(formatCount(runningNow.length), loading)}
            detail="in flight"
            loading={loading}
          />
        ) : null}
      </StatGrid>

      <RunningNowStrip runs={runningNow} onOpenRun={onOpenRun} />

      {latency !== null && latency.total.samples > 0 ? (
        <StatGrid columns={4}>
          <InsightsStat
            label="Turn latency (p50 / p95)"
            value={latencyStatValue(latency.total)}
            detail={`${formatCount(latency.total.samples)} turns`}
            loading={loading}
          />
          <InsightsStat
            label="To first token (p50 / p95)"
            value={latencyStatValue(latency.toFirstToken)}
            detail="wait until first token"
            loading={loading}
          />
          <InsightsStat
            label="Reply after first token (p50 / p95)"
            value={latencyStatValue(latency.toReplyPosted)}
            detail="first token → reply posted"
            loading={loading}
          />
          {latency.toReactorStart.samples > 0 ? (
            <InsightsStat
              label="Cold start (p50 / p95)"
              value={latencyStatValue(latency.toReactorStart)}
              detail="wait before the model starts"
              loading={loading}
            />
          ) : null}
        </StatGrid>
      ) : null}

      {noUsageInWindow && !activityWindowEmpty ? (
        <p className="insights-note">No usage recorded yet in this window.</p>
      ) : null}

      {unreportedTokens.length > 0 ? (
        <p className="insights-note">
          Token counts were not reported for: {unreportedTokens.join(", ")}.
          Those turns do not contribute a fabricated cost or token total.
        </p>
      ) : null}

      {missingRates.length > 0 ? (
        <p className="insights-note">
          Rates unknown for: {missingRates.join(", ")}. Those turns do not
          contribute a fabricated cost.
        </p>
      ) : null}

      {runsNextCursor !== null ? (
        <p className="insights-note">
          Runs, sparkline, and outcomes below reflect the 100 most recent runs —
          more exist in this window.{" "}
          <button
            type="button"
            className="font-semibold text-primary-emphasis"
            onClick={onOpenRuns}
          >
            See all runs & traces
          </button>
          .
        </p>
      ) : null}

      <div className="insights-grid">
        <section className="insights-panel">
          {activityWindowEmpty ? (
            <RichEmptyState
              icon={<ChartBar />}
              title="No activity yet"
              description={
                noUsageInWindow
                  ? "No usage recorded yet in this window."
                  : "Activity shows up here once there are turns in this window."
              }
            />
          ) : (
            <ActivityBars days={activityDays} />
          )}
        </section>

        {mosaicParts.length > 0 ? (
          <section className="insights-panel">
            <h3>Token mix</h3>
            <TokenMosaic parts={mosaicParts} label="Token usage by class" />
            <StatGrid columns={2} className="mt-3.5">
              <InsightsStat
                label="Cache hit"
                value={tileValue(formatRate(hitRate), false)}
                detail="cache read / (input + cache read)"
              />
              <InsightsStat
                label="Total tokens"
                value={formatCount(usage.tokens.total)}
                detail={`${formatCount(usage.turns)} turns`}
              />
            </StatGrid>
          </section>
        ) : null}

        <section className="insights-panel">
          <h3>Cost by model</h3>
          {models !== null ? (
            <ModelCostTable models={models} />
          ) : (
            <RichEmptyState
              icon={<ChartBar />}
              title="No model usage yet"
              description="Costs show up here once a model has been used in this window."
            />
          )}
        </section>

        <section className="insights-panel">
          <h3>Calls by tool</h3>
          {tools !== null ? (
            <ToolCallsTable tools={tools} />
          ) : (
            <RichEmptyState
              icon={<ChartBar />}
              title="No tool calls yet"
              description="Tool calls show up here once an agent has made one in this window."
            />
          )}
        </section>

        {tokensSeries.length > 0 ? (
          <section className="insights-panel">
            <TimeSeriesChart
              title="Tokens over time by model"
              description={`Last ${activityDays.length} days`}
              labels={activityDays.map((d) => dayWeekdayLabel(d.day))}
              series={tokensSeries}
              variant="area"
              format={formatCount}
            />
          </section>
        ) : null}

        {stats.totalRuns > 0 ? (
          <section className="insights-panel">
            <BarChart
              title="Run outcomes"
              description={`${formatCount(stats.totalRuns)} runs`}
              data={runOutcomeData(stats)}
              valueLabel="Runs"
              format={formatCount}
            />
          </section>
        ) : null}

        {workbenches !== null ? (
          <section className="insights-panel">
            <h3>Activity by workbench</h3>
            {workbenches.length > 0 ? (
              <WorkbenchActivityBars
                workbenches={workbenches}
                onSelectWorkbench={onSelectWorkbench}
              />
            ) : (
              <RichEmptyState
                icon={<ChartBar />}
                title="No workbench activity yet"
                description="Activity by workbench shows up here once a workbench has usage in this window."
              />
            )}
          </section>
        ) : null}
      </div>

      <section className="insights-section">
        <div className="insights-section-head">
          <h2>Recent runs</h2>
        </div>
        {recent.length > 0 ? (
          <RecentRunRows
            runs={recent}
            onOpenRun={onOpenRun}
            onOpenRuns={onOpenRuns}
          />
        ) : (
          <RichEmptyState
            icon={<ChartBar />}
            title="No runs yet"
            description="When a routine or automation fires, it shows up here."
          />
        )}
      </section>
    </div>
  );
}

export function runDurationLabel(run: InsightsRun): string {
  if (run.endedAt === undefined || run.endedAt === null) return "—";
  const startMs = Date.parse(run.createdAt);
  const endMs = Date.parse(run.endedAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return "—";
  return durationLabel(Math.max(0, endMs - startMs));
}

function DefinitionRunTable({
  groupKey,
  displayName,
  runs,
  onOpenRun,
}: {
  readonly groupKey: string;
  readonly displayName: string;
  readonly runs: readonly InsightsRun[];
  readonly onOpenRun: (id: string) => void;
}) {
  return (
    <section className="insights-panel" data-definition-group={groupKey}>
      <h3>{displayName}</h3>
      <Table aria-label={displayName} className="insights-data-table">
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((row) => (
            <TableRow
              key={row.id}
              data-ctx-insights-run={row.id}
              {...onRowActivate(() => onOpenRun(row.id))}
            >
              <TableCell>
                <Badge tone={insightsStatusTone(insightsRunStatus(row))}>
                  {runStatusLabel(insightsRunStatus(row))}
                </Badge>
              </TableCell>
              <TableCell>{formatWhen(row.createdAt)}</TableCell>
              <TableCell>{runDurationLabel(row)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

export function InsightsRunsHistory({
  runs,
  loading,
  nextCursor,
  onOpenRun,
}: {
  readonly runs: readonly InsightsRun[];
  readonly loading: boolean;
  /** The feed's own `nextCursor` (from `insightsTopLevelRunsPath`'s
   * `limit=100` fetch) — non-null means more runs exist than were fetched,
   * so the view says so instead of silently truncating at 100. */
  readonly nextCursor: string | null;
  readonly onOpenRun: (id: string) => void;
}) {
  const purpose = purposeRunsForInsights(runs);
  const groups = groupRunsByDefinition(purpose);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[
          { label: "Insights", href: INSIGHTS_PATH_PREFIX },
          { label: "Run history" },
        ]}
        subtitle={`${purpose.length} runs`}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageShell width="full" className="page-fill">
          <div className="insights-layout">
            {loading ? (
              <Skeleton className="h-40 w-full" />
            ) : groups.length === 0 ? (
              <RichEmptyState
                icon={<ChartBar />}
                title="No runs yet"
                description="When a routine or automation fires, it shows up here."
              />
            ) : (
              <>
                <div className="insights-grid">
                  {groups.map((group) => (
                    <DefinitionRunTable
                      key={group.groupKey}
                      groupKey={group.groupKey}
                      displayName={group.displayName}
                      runs={group.runs}
                      onOpenRun={onOpenRun}
                    />
                  ))}
                </div>
                {nextCursor !== null ? (
                  <p className="insights-note">
                    Showing the 100 most recent runs.
                  </p>
                ) : null}
              </>
            )}
          </div>
        </PageShell>
      </div>
    </div>
  );
}

export function InsightsRunDetail({
  run,
  trace,
}: {
  readonly run: InsightsRun | null;
  readonly trace: APIQuery<RunTrace>;
}) {
  const spans = trace.kind === "ready" ? toTraceSpans(trace.data) : [];
  const traceStats =
    trace.kind === "ready" && !("absent" in trace.data)
      ? computeTraceStats(trace.data.spans)
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[
          { label: "Runs", href: INSIGHTS_RUNS_PATH },
          { label: run !== null ? runDisplayName(run) : "Run" },
        ]}
        subtitle={run !== null ? formatWhen(run.createdAt) : null}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageShell width="full" className="page-fill">
          <div className="insights-layout">
            <StatGrid columns={5}>
              {/* Owner is not carried by WorkflowRunResponse yet — dash, not
                  a fabricated identity. */}
              <InsightsStat label="Owner" value="—" />
              <InsightsStat
                label="Steps"
                value={dash(traceStats?.steps ?? null)}
                loading={trace.kind === "loading"}
              />
              <InsightsStat
                label="Completed"
                value={dash(traceStats?.completed ?? null)}
                loading={trace.kind === "loading"}
              />
              <InsightsStat
                label="Failed"
                value={dash(traceStats?.failed ?? null)}
                loading={trace.kind === "loading"}
              />
              <InsightsStat
                label="Duration"
                value={dash(
                  traceStats !== null
                    ? durationLabel(traceStats.durationMs)
                    : null,
                )}
                loading={trace.kind === "loading"}
              />
            </StatGrid>

            {trace.kind === "loading" ? (
              <Skeleton className="h-48 w-full" />
            ) : null}
            {trace.kind === "error" ? (
              <RichEmptyState
                title="Trace not available"
                description={
                  trace.message.includes("404") ||
                  trace.message.toLowerCase().includes("not found")
                    ? "We didn't record a timeline for this run."
                    : trace.message
                }
              />
            ) : null}
            {trace.kind === "unauthenticated" ? <SignedOutNotice /> : null}
            {trace.kind === "ready" && spans.length > 0 ? (
              <section className="insights-panel">
                <h3>Timeline</h3>
                <TraceWaterfall
                  title="Run trace"
                  spans={spans}
                  description={`${spans.length} step${spans.length === 1 ? "" : "s"}`}
                />
              </section>
            ) : null}
            {trace.kind === "ready" && spans.length === 0 ? (
              <RichEmptyState
                title="Empty trace"
                description="This run finished before we started recording steps."
              />
            ) : null}
          </div>
        </PageShell>
      </div>
    </div>
  );
}

/**
 * The landing view's default scope, and every non-landing mode's scope,
 * as one pure decision so it can be unit-tested without mounting the
 * route. `/scope` (packages/insights/src/routes.ts) only ever reports a
 * `parent` when the caller holds an active principal in it — a present
 * parent means "caller is a workspace member" and the default becomes
 * the cross-workbench aggregate ("All workbenches"); otherwise the
 * default is the caller's own current workbench, labeled with its name.
 * Either way the result is always a tenant `/scope` itself vouches the
 * caller can see — there is no default that can 403.
 */
const WINDOW_REFRESH_MS = 60_000;

/** The insights [from, to] window, re-anchored to now once a minute. */
export function useInsightsWindow(): InsightsRange {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), WINDOW_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  return useMemo(() => createInsightsWindow(undefined, now), [now]);
}

export function resolveInsightsScope({
  mode,
  selectedTenantId,
  scopeData,
}: {
  readonly mode: "landing" | "runs" | "run" | "workbench";
  readonly selectedTenantId: string | null;
  readonly scopeData: InsightsScope | null;
}): { effectiveTenantId: string | null; scopeLabel: string } {
  if (mode !== "landing") {
    return {
      effectiveTenantId: selectedTenantId,
      scopeLabel: "All workbenches",
    };
  }
  if (scopeData?.parent) {
    return {
      effectiveTenantId: scopeData.parent.tenantId,
      scopeLabel: "All workbenches",
    };
  }
  // The root tenancy with no parent IS the aggregate: every workbench's
  // runs land on it, so the landing view is all workbenches by
  // definition — label it that way instead of the tenant's own name,
  // which reads like a single workbench. Before `/scope` resolves this
  // falls back to the same honest placeholder rather than the raw
  // tenant id, so the dashboard never blocks on it and never shows one.
  if (scopeData !== null) {
    return {
      effectiveTenantId: scopeData.tenantId,
      scopeLabel: "All workbenches",
    };
  }
  return {
    effectiveTenantId: selectedTenantId,
    scopeLabel: "All workbenches",
  };
}

/**
 * Landing-view scope switcher: "All workbenches" (the cross-workbench
 * aggregate this landing always shows — always the pressed option, since
 * every other pill navigates straight to that sibling's own workbench-scoped
 * Insights, CL-5879, rather than switching this same page's scope inline)
 * versus each sibling workbench by name. Hidden entirely when `/scope`
 * reports no parent — a root workbench with no siblings has nothing to
 * switch to.
 */
function InsightsScopeSwitcher({
  scope,
  onSelect,
}: {
  readonly scope: InsightsScope | null;
  readonly onSelect: (tenantId: string | null) => void;
}) {
  if (scope === null || scope.parent === null) return null;
  return (
    <div
      className="insights-scope-switcher"
      role="group"
      aria-label="Insights scope"
    >
      <button
        type="button"
        aria-pressed={true}
        data-active={true}
        className="insights-scope-switcher-option"
        onClick={() => onSelect(null)}
      >
        All workbenches
      </button>
      {scope.workbenches.map((workbench) => (
        <button
          key={workbench.tenantId}
          type="button"
          aria-pressed={false}
          data-active={false}
          className="insights-scope-switcher-option"
          onClick={() => onSelect(workbench.tenantId)}
        >
          {workbench.name}
        </button>
      ))}
    </div>
  );
}

export function InsightsPage({
  path,
  summary,
  activity,
  byTool,
  runs,
  routines,
  workbenches,
  latency,
  range,
  scope,
  resolveWorkbenchIdForTenant,
  scopeLabel,
}: {
  readonly path: string;
  readonly summary: APIQuery<OverallUsage>;
  readonly activity: APIQuery<readonly DayActivity[]>;
  readonly byTool: APIQuery<readonly ToolCall[]>;
  readonly runs: APIQuery<{
    data: readonly InsightsRun[];
    nextCursor: string | null;
  }>;
  readonly routines: APIQuery<readonly ScheduledWorkflowDefinition[]>;
  /** `/workbenches` — this scope's own row plus one per descendant
   * workbench, used for the "activity by workbench" chart and the
   * "active workbenches" KPI. */
  readonly workbenches: APIQuery<{
    items: readonly WorkbenchUsage[];
  }>;
  /** `/latency` — CL-6257 per-message-run stage p50/p95. */
  readonly latency: APIQuery<LatencySummary>;
  /** Stable 7-day window created once per route mount. */
  readonly range: InsightsRange;
  /** `/scope` result — own identity, parent (if any), sibling
   * workbenches. Null while loading/absent; the switcher hides itself. */
  readonly scope: InsightsScope | null;
  /** A workbench usage row (and the scope switcher's sibling pills) only
   * carry that workbench's tenant id — this resolves it to the workbench
   * that opens `/insights/workbench/:workbenchId` for it (CL-5879), or null
   * when no workbench in view carries that tenancy. */
  readonly resolveWorkbenchIdForTenant: (tenantId: string) => string | null;
  /** "All workbenches" or the current workbench's own name — always known
   * even before `/scope` resolves (falls back to the raw id). */
  readonly scopeLabel: string;
}) {
  const navigate = useNavigate();
  const { mode, runId } = parseInsightsPath(path);
  const { selectedTenantId } = useBench();

  const unauth =
    summary.kind === "unauthenticated" ||
    runs.kind === "unauthenticated" ||
    routines.kind === "unauthenticated";

  if (unauth) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Insights" }]} />
        <PageShell width="full" className="page-fill">
          <SignedOutNotice />
        </PageShell>
      </div>
    );
  }

  const loading =
    summary.kind === "loading" ||
    activity.kind === "loading" ||
    runs.kind === "loading" ||
    routines.kind === "loading";

  // Usage/activity/tools errors must surface. Loading and ready-empty /
  // no-tenant still use EMPTY_OVERALL_USAGE at the data boundary so the
  // dashboard never invents spend; zero-turn chrome hides usage tiles.
  // Runs/routines soft-empty on landing.
  const usageErrorRetry =
    summary.kind === "error"
      ? summary.retry
      : activity.kind === "error"
        ? activity.retry
        : byTool.kind === "error"
          ? byTool.retry
          : null;

  const summaryData =
    summary.kind === "ready" ? summary.data : EMPTY_OVERALL_USAGE;
  const activityData = activity.kind === "ready" ? activity.data : [];
  const byModelData = summaryData.byModel;
  const byToolData = byTool.kind === "ready" ? byTool.data : [];
  const runsData = runs.kind === "ready" ? runs.data.data : [];
  const runsNextCursor = runs.kind === "ready" ? runs.data.nextCursor : null;
  const routinesData = routines.kind === "ready" ? routines.data : [];
  const workbenchesData =
    workbenches.kind === "ready" ? workbenches.data.items : null;
  const latencyData = latency.kind === "ready" ? latency.data : null;

  if (mode === "run" && runId !== null) {
    const run = runsData.find((r) => r.id === runId) ?? null;
    // Only fetch trace when we have a tenant; unauthenticated already handled.
    return (
      <InsightsRunDetailRoute
        runId={runId}
        run={run}
        tenantId={selectedTenantId}
      />
    );
  }

  if (mode === "runs") {
    return (
      <InsightsRunsHistory
        runs={runsData}
        loading={runs.kind === "loading"}
        nextCursor={runsNextCursor}
        onOpenRun={(id) =>
          navigate(`${INSIGHTS_RUNS_PATH}/${encodeURIComponent(id)}`)
        }
      />
    );
  }

  if (usageErrorRetry !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Insights" }]} />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<ChartBar />}
            title="Couldn't load insights"
            description="Something went wrong on our side. Try again in a moment."
            actions={[{ label: "Retry", onClick: usageErrorRetry }]}
          />
        </PageShell>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "Insights" }]}
        subtitle={`${scopeLabel} · Last ${INSIGHTS_WINDOW_DAYS} days`}
        actions={
          <InsightsScopeSwitcher
            scope={scope}
            onSelect={(tenantId) => {
              if (tenantId === null) {
                navigate(INSIGHTS_PATH_PREFIX);
                return;
              }
              const workbenchId = resolveWorkbenchIdForTenant(tenantId);
              if (workbenchId !== null)
                navigate(workbenchInsightsPath(workbenchId));
            }}
          />
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageShell width="full" className="page-fill">
          <InsightsLanding
            summary={summaryData}
            activity={activityData}
            byModel={byModelData}
            byTool={byToolData}
            runs={runsData}
            runsNextCursor={runsNextCursor}
            routines={routinesData}
            workbenches={workbenchesData}
            latency={latencyData}
            range={range}
            loading={loading}
            onOpenRun={(id) =>
              navigate(`${INSIGHTS_RUNS_PATH}/${encodeURIComponent(id)}`)
            }
            onOpenRuns={() => navigate(INSIGHTS_RUNS_PATH)}
            onSelectWorkbench={(tenantId) => {
              const workbenchId = resolveWorkbenchIdForTenant(tenantId);
              if (workbenchId !== null)
                navigate(workbenchInsightsPath(workbenchId));
            }}
          />
        </PageShell>
      </div>
    </div>
  );
}

export function InsightsRunDetailRoute({
  runId,
  run,
  tenantId,
}: {
  readonly runId: string;
  readonly run: InsightsRun | null;
  readonly tenantId: string | null;
}) {
  const trace = useAPIQuery(
    tenantId === null ? "" : insightsRunTracePath(tenantId, runId),
    RunTraceSchema,
  );

  return <InsightsRunDetail run={run} trace={trace} />;
}

/**
 * Insights scoped to one workbench (CL-5879) — `/insights/workbench/:workbenchId`
 * resolves the workbench's own workbench tenant (see
 * `../insights-workbench-scope.ts`) and titles the page by the WORKBENCH name,
 * never the tenant's. A true legacy workbench (tenancy `null`) and an id
 * absent from the bench's own workbench list (a stale
 * `/insights/workbench/:tenantId` link, or any other mis-wired id — that
 * route is retired) both get an honest empty state instead of a doomed
 * tenant-scoped fetch.
 */
function InsightsWorkbenchPage({
  workbenchId,
  workbenchesLoading,
  resolution,
  benchTenantId,
  onOpenRun,
}: {
  readonly workbenchId: string;
  readonly workbenchesLoading: boolean;
  readonly resolution: WorkbenchInsightsResolution;
  readonly benchTenantId: string | null;
  readonly onOpenRun: (id: string) => void;
}) {
  if (workbenchesLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Insights" }]} />
        <PageShell width="full" className="page-fill">
          <Skeleton className="h-48 w-full" />
        </PageShell>
      </div>
    );
  }
  if (resolution.kind === "not-found") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Insights" }]} />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<ChartBar />}
            title="Workbench not found"
            description="This conversation may have been deleted, or you may not have access to it."
          />
        </PageShell>
      </div>
    );
  }
  if (resolution.kind === "legacy") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Insights" }]} />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<ChartBar />}
            title="No insights for this conversation yet"
            description="This conversation predates per-workbench insights."
          />
        </PageShell>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[
          { label: "Insights", href: INSIGHTS_PATH_PREFIX },
          { label: resolution.title },
        ]}
        subtitle={`Last ${INSIGHTS_WINDOW_DAYS} days`}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageShell width="full" className="page-fill">
          <WorkbenchTimelineRoute
            benchTenantId={benchTenantId}
            workbenchId={workbenchId}
            onOpenRun={onOpenRun}
          />
        </PageShell>
      </div>
    </div>
  );
}

export function InsightsRoute({ path }: { readonly path?: string }) {
  const { selectedTenantId } = useBench();
  const navigate = useNavigate();
  const currentPath =
    path ??
    (typeof window !== "undefined"
      ? window.location.pathname
      : INSIGHTS_PATH_PREFIX);
  const { mode, workbenchId } = parseInsightsPath(currentPath);

  // A sliding window: `to` re-anchors to now every minute, so the
  // dashboard keeps up with live turns instead of freezing at whatever
  // instant the page mounted. The minute granularity keeps query keys
  // stable between ticks.
  const range = useInsightsWindow();

  // Own identity, parent (a workspace, if this workbench has one), and
  // sibling workbenches — read once off the current workbench regardless
  // of scope, since it describes the switcher options, not the data
  // itself. See @corbits/insights' routes.ts `/scope`.
  const scope = useAPIQuery(
    selectedTenantId === null ? "" : insightsScopePath(selectedTenantId),
    InsightsScopeSchema,
  );
  const scopeData = scope.kind === "ready" ? scope.data : null;

  // The bench's own workbench list, shared with `ChatWorkspace`'s sidebar via
  // `workbenchesQueryKey` (never a bespoke fetch of its own) — the single
  // mechanism behind both directions of workbench↔workbench-tenant
  // resolution (CL-5879): a `/insights/workbench/:workbenchId` deep link
  // resolving its own tenant below, and a usage row's tenant id resolving
  // back to the workbench that opens it (`resolveWorkbenchIdForTenant`, fed to
  // `InsightsPage` for the "activity by workbench" rows and the scope
  // switcher's sibling pills).
  const workbenchesOfKind = useTenantQuery(
    selectedTenantId === null
      ? ["tenant", "none", "workbenches", "workbench"]
      : workbenchesQueryKey(selectedTenantId, "workbench"),
    selectedTenantId !== null,
    () => listWorkbenches(selectedTenantId as string, "workbench"),
  );
  const chatsOfKind = useTenantQuery(
    selectedTenantId === null
      ? ["tenant", "none", "workbenches", "chat"]
      : workbenchesQueryKey(selectedTenantId, "chat"),
    selectedTenantId !== null,
    () => listWorkbenches(selectedTenantId as string, "chat"),
  );
  const workbenchesLoading =
    workbenchesOfKind.kind === "loading" || chatsOfKind.kind === "loading";
  const allWorkbenches: readonly Workbench[] = [
    ...(workbenchesOfKind.kind === "ready" ? workbenchesOfKind.data : []),
    ...(chatsOfKind.kind === "ready" ? chatsOfKind.data : []),
  ];
  const resolveWorkbenchIdForTenant = (tenantId: string): string | null =>
    workbenchIdForWorkbenchTenant(allWorkbenches, tenantId);
  const workbenchResolution: WorkbenchInsightsResolution | null =
    mode === "workbench" && workbenchId !== null
      ? resolveWorkbenchInsightsScope(allWorkbenches, workbenchId)
      : null;

  const { effectiveTenantId, scopeLabel } = resolveInsightsScope({
    mode,
    selectedTenantId,
    scopeData,
  });

  const summary = useAPIQuery(
    effectiveTenantId === null
      ? ""
      : insightsUsagePath(effectiveTenantId, range),
    OverallUsageSchema,
  );
  const activityRaw = useAPIQuery(
    effectiveTenantId === null
      ? ""
      : insightsActivityPath(effectiveTenantId, range),
    ActivityResponseSchema,
  );
  const toolsRaw = useAPIQuery(
    effectiveTenantId === null
      ? ""
      : insightsToolsPath(effectiveTenantId, range),
    ToolsResponseSchema,
  );
  const runs = useAPIQuery(
    effectiveTenantId === null
      ? ""
      : insightsTopLevelRunsPath(effectiveTenantId),
    TopLevelRunsSchema,
  );
  // Only meaningful on the cross-workbench landing — mode "workbench" renders
  // `InsightsWorkbenchPage` instead of `InsightsPage`, so there is nothing
  // here to chart and the fetch stays disabled.
  const workbenches = useAPIQuery(
    effectiveTenantId === null || mode !== "landing"
      ? ""
      : insightsWorkbenchesPath(effectiveTenantId, range),
    WorkbenchesResponseSchema,
  );
  // CL-6257 turn-latency tiles: same landing-only scope as `workbenches`
  // above (the per-workbench route renders `InsightsWorkbenchPage`'s
  // timeline instead of this landing, so there is nothing here to show).
  const latency = useAPIQuery(
    effectiveTenantId === null || mode !== "landing"
      ? ""
      : insightsLatencyPath(effectiveTenantId, range),
    LatencySummarySchema,
  );
  const routines = useTenantQuery(
    selectedTenantId === null
      ? ["tenant", "none", "routines"]
      : tenantKeys.routines(selectedTenantId),
    selectedTenantId !== null,
    () => listScheduledWorkflows(selectedTenantId as string),
  );

  const routinesForPage: APIQuery<readonly ScheduledWorkflowDefinition[]> =
    selectedTenantId === null ? { kind: "ready", data: [] } : routines;

  // Unwrap package envelopes ({ days }, { tools }) for the page surface.
  const activity: APIQuery<readonly DayActivity[]> =
    activityRaw.kind === "ready"
      ? { kind: "ready", data: activityRaw.data.days }
      : activityRaw;
  const byTool: APIQuery<readonly ToolCall[]> =
    toolsRaw.kind === "ready"
      ? { kind: "ready", data: toolsRaw.data.tools }
      : toolsRaw;

  // No tenant in scope: zero usage/run defaults so the page shows an
  // honest empty state without inventing nonzero workbench usage or runs.
  const emptySummary: APIQuery<OverallUsage> =
    effectiveTenantId === null
      ? { kind: "ready", data: EMPTY_OVERALL_USAGE }
      : summary;
  const activityForPage: APIQuery<readonly DayActivity[]> =
    effectiveTenantId === null ? { kind: "ready", data: [] } : activity;
  const byToolForPage: APIQuery<readonly ToolCall[]> =
    effectiveTenantId === null ? { kind: "ready", data: [] } : byTool;
  const runsForPage: APIQuery<{
    data: readonly InsightsRun[];
    nextCursor: string | null;
  }> =
    effectiveTenantId === null
      ? { kind: "ready", data: { data: [], nextCursor: null } }
      : runs;

  if (
    mode === "workbench" &&
    workbenchId !== null &&
    workbenchResolution !== null
  ) {
    return (
      <InsightsWorkbenchPage
        workbenchId={workbenchId}
        workbenchesLoading={workbenchesLoading}
        resolution={workbenchResolution}
        benchTenantId={selectedTenantId}
        onOpenRun={(id) =>
          navigate(`${INSIGHTS_RUNS_PATH}/${encodeURIComponent(id)}`)
        }
      />
    );
  }

  return (
    <InsightsPage
      path={currentPath}
      summary={emptySummary}
      activity={activityForPage}
      byTool={byToolForPage}
      runs={runsForPage}
      routines={routinesForPage}
      workbenches={workbenches}
      latency={latency}
      range={range}
      scope={scopeData}
      resolveWorkbenchIdForTenant={resolveWorkbenchIdForTenant}
      scopeLabel={scopeLabel}
    />
  );
}
