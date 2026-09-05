// Mission Control (CL-6488/CL-6489): the bench's dashboard — what needs a
// decision, what's running, and a way back into recent context. A new
// top-level route (`/mission-control`), never `/` — `/` stays the Myra
// land-hop redirect (see routes.tsx's header comment). Every panel here is
// backed by a query already used elsewhere in this app (pending
// approvals, top-level runs, insights activity); nothing on this page is
// invented. A panel with no honest data source renders an empty state
// naming what's missing instead of a fabricated number.

import {
  Badge,
  Button,
  PageShell,
  RichEmptyState,
  RUN_STATUS_TONE,
  Skeleton,
  StatGrid,
  StatGridItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  formatRelativeTime,
  toast,
} from "@corbits/react-ui";
import type { BadgeTone } from "@corbits/react-ui";
import { ChatCircleDots, Plus, Robot } from "@corbits/icons";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { formatUsd } from "@corbits/insights/client";
import { CHAT_STRINGS, type Workbench } from "@corbits/chat-ui";
import {
  runOutcomeStatus,
  runStatusLabel,
  withListingAbandoned,
} from "@corbits/workflows/client";

import { approveApproval, rejectApproval, useAPIQuery } from "../api";
import { useBench } from "../bench-context";
import { ActivityResponseSchema, insightsActivityPath } from "../insights-api";
import { Link } from "../navigation";
import {
  usePendingApprovals,
  type PendingApproval,
} from "../pending-approvals";
import { tenantKeys } from "../query-client";
import { NEW_WORKBENCH_PATH } from "../routes";
import { useBenchActivity } from "../shell/bench-activity";
import type { RoutineActivityItem } from "../shell/routine-activity";
import { StageTopBar } from "../shell/stage-top-bar";
import { workbenchPath } from "../workbench-path";

function dash(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

type InFlightRow = {
  readonly key: string;
  readonly label: string;
  readonly context: string;
  readonly createdAt: string;
  readonly statusLabel: string;
  readonly statusTone: BadgeTone;
  readonly steps: string;
};

function listingFromRoutine(routine: RoutineActivityItem, now: number) {
  return withListingAbandoned(
    {
      createdAt: routine.startedAt,
      status: routine.status,
      ...(routine.endedAt !== undefined ? { endedAt: routine.endedAt } : {}),
      ...(routine.hasInFlightTurn !== undefined
        ? { hasInFlightTurn: routine.hasInFlightTurn }
        : {}),
      ...(routine.turns !== undefined ? { turns: routine.turns } : {}),
    },
    now,
  );
}

function routineInFlightRow(
  routine: RoutineActivityItem,
  now: number,
): InFlightRow {
  const status =
    runOutcomeStatus(listingFromRoutine(routine, now), now) ?? routine.status;
  return {
    key: `routine:${routine.id}`,
    label: routine.name,
    context: "routine",
    createdAt: routine.startedAt,
    statusLabel: runStatusLabel(status),
    statusTone: RUN_STATUS_TONE.running,
    // The routine feed carries no step count — an honest dash, not a guess.
    steps: "—",
  };
}

/** Every routine this bench is actively running right now, newest first. */
export function computeInFlightRows(
  routines: readonly RoutineActivityItem[],
  now: number = Date.now(),
): readonly InFlightRow[] {
  const rows = routines
    .filter(
      (routine) =>
        runOutcomeStatus(listingFromRoutine(routine, now), now) === "running",
    )
    .map((routine) => routineInFlightRow(routine, now));
  return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

type JumpBackRow = {
  readonly key: string;
  readonly icon: "chat" | "agent";
  readonly label: string;
  readonly context: string;
  readonly when: string;
  readonly onSelect?: () => void;
};

/** Recent conversations and agents to jump back into — real bench activity
 * (workbenches, chats, visible agent definitions), sorted by their own
 * recency field. Nothing here is invented: a workbench with no recorded
 * activity timestamp is left out rather than given a fake one. */
export function computeJumpBackRows(
  workbenches: readonly Workbench[],
  chats: readonly Workbench[],
  agents: readonly { id: string; name: string; createdAt: string }[],
  navigate: (to: string) => void,
  limit = 4,
): readonly JumpBackRow[] {
  const conversations = [...workbenches, ...chats]
    .filter(
      (bench): bench is Workbench & { lastActivityAt: string } =>
        bench.lastActivityAt !== undefined,
    )
    .map((bench) => ({
      key: `bench:${bench.id}`,
      icon: "chat" as const,
      label: bench.title,
      context: bench.kind === "chat" ? "chat" : "workbench",
      when: bench.lastActivityAt,
      onSelect: () => navigate(workbenchPath(bench.id)),
    }));
  const agentRows = agents.map((agent) => ({
    key: `agent:${agent.id}`,
    icon: "agent" as const,
    label: agent.name,
    context: "agent",
    when: agent.createdAt,
  }));
  return [...conversations, ...agentRows]
    .sort((a, b) => Date.parse(b.when) - Date.parse(a.when))
    .slice(0, limit);
}

function ApprovalRow({
  item,
  tenantId,
}: {
  readonly item: PendingApproval;
  readonly tenantId: string;
}) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);

  async function resolve(action: "approve" | "deny") {
    setPending(action);
    try {
      if (action === "approve") await approveApproval(tenantId, item.id);
      else await rejectApproval(tenantId, item.id);
      await queryClient.invalidateQueries({
        queryKey: tenantKeys.pendingApprovals(tenantId),
      });
    } catch (cause) {
      toast(
        cause instanceof Error
          ? cause.message
          : `Couldn't ${action === "approve" ? "approve" : "deny"} that request.`,
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <TableRow>
      <TableCell>
        <span className="mission-control-cell-primary">{item.headline}</span>
      </TableCell>
      <TableCell className="mission-control-opt">{item.agentName}</TableCell>
      <TableCell className="mission-control-opt">
        {formatRelativeTime(item.createdAt)}
      </TableCell>
      <TableCell className="mission-control-num">
        <div className="mission-control-row-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending !== null}
            onClick={() => void resolve("deny")}
          >
            {pending === "deny" ? "Denying…" : "Deny"}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={pending !== null}
            onClick={() => void resolve("approve")}
          >
            {pending === "approve" ? "Approving…" : "Approve"}
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export function MissionControlRoute({
  navigate,
}: {
  readonly navigate: (to: string) => void;
}) {
  const { selectedTenantId: tenantId } = useBench();
  const approvalsQuery = usePendingApprovals(tenantId);
  const activity = useBenchActivity(tenantId);
  const activityRange = useMemo(
    () => ({
      from: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      to: new Date().toISOString(),
    }),
    [],
  );
  const insightsActivity = useAPIQuery(
    tenantId === null ? "" : insightsActivityPath(tenantId, activityRange),
    ActivityResponseSchema,
  );

  const pendingApprovals =
    approvalsQuery.kind === "ready" ? approvalsQuery.data : null;
  const oldestWaitingAt =
    pendingApprovals !== null && pendingApprovals.length > 0
      ? pendingApprovals.reduce((oldest, item) =>
          Date.parse(item.createdAt) < Date.parse(oldest.createdAt)
            ? item
            : oldest,
        ).createdAt
      : null;

  const inFlightRows =
    activity.kind === "ready" ? computeInFlightRows(activity.routines) : [];
  const activeRunsCount =
    activity.kind === "ready" ? inFlightRows.length : null;

  const jumpBackRows =
    activity.kind === "ready"
      ? computeJumpBackRows(
          activity.workbenches,
          activity.chats,
          activity.agents,
          navigate,
        )
      : [];

  const days =
    insightsActivity.kind === "ready" ? insightsActivity.data.days : [];
  const insightsReady = insightsActivity.kind === "ready";
  const todayKey = new Date().toISOString().slice(0, 10);
  const today = days.find((day) => day.day === todayKey) ?? null;
  const priorDays = days.filter((day) => day.day !== todayKey);
  const avgTurns =
    priorDays.length > 0
      ? priorDays.reduce((sum, day) => sum + day.turns, 0) / priorDays.length
      : null;
  // Ready but no today row means zero activity today, not "unknown". Dash
  // only while the activity query is still settling (or cost rates unknown).
  const runsToday = insightsReady ? (today?.turns ?? 0) : null;
  const todaySpend = !insightsReady
    ? null
    : today === null
      ? 0
      : today.byModel.some((model) => model.costUsd === null)
        ? null
        : today.byModel.reduce((sum, model) => sum + (model.costUsd ?? 0), 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "Mission Control" }]}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => navigate(NEW_WORKBENCH_PATH)}
          >
            <Plus /> {CHAT_STRINGS.newWorkbenchAction}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <PageShell width="full" className="page-fill">
          <div className="mission-control-layout">
            <StatGrid columns={4} className="mission-control-stats">
              <StatGridItem
                label="Active runs"
                value={dash(activeRunsCount)}
                sub={
                  activeRunsCount !== null && activeRunsCount > 0
                    ? "live now"
                    : "nothing running"
                }
              />
              <StatGridItem
                label="Waiting on you"
                value={dash(pendingApprovals?.length ?? null)}
                danger={
                  pendingApprovals !== null && pendingApprovals.length > 0
                }
                sub={
                  oldestWaitingAt !== null
                    ? `oldest ${formatRelativeTime(oldestWaitingAt)}`
                    : "all caught up"
                }
              />
              <StatGridItem
                label="Runs today"
                value={dash(runsToday)}
                sub={
                  avgTurns !== null
                    ? `avg ${Math.round(avgTurns)}/day`
                    : "quiet so far"
                }
              />
              <StatGridItem
                label="Spend today"
                value={formatUsd(todaySpend)}
                sub="so far today"
              />
            </StatGrid>

            <section className="mission-control-panel">
              <div className="mission-control-panel-header">
                <h2>Needs you</h2>
                <span className="mission-control-hint">
                  approvals block agents until you act
                </span>
              </div>
              {approvalsQuery.kind === "loading" ? (
                <Skeleton className="h-24 w-full" />
              ) : null}
              {approvalsQuery.kind === "error" ? (
                <RichEmptyState
                  title="Couldn't load approvals"
                  description={approvalsQuery.message}
                />
              ) : null}
              {approvalsQuery.kind === "unauthenticated" ? (
                <RichEmptyState
                  title="Sign in to see approvals"
                  description="Your session expired — sign back in to review what's waiting."
                />
              ) : null}
              {pendingApprovals !== null && pendingApprovals.length === 0 ? (
                <RichEmptyState
                  title="Nothing waiting on you"
                  description="Approvals will show up here the moment an agent needs a decision."
                />
              ) : null}
              {pendingApprovals !== null && pendingApprovals.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Request</TableHead>
                      <TableHead className="mission-control-opt">
                        From
                      </TableHead>
                      <TableHead className="mission-control-opt">
                        Waiting
                      </TableHead>
                      <TableHead className="mission-control-num" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tenantId !== null &&
                      pendingApprovals.map((item) => (
                        <ApprovalRow
                          key={item.id}
                          item={item}
                          tenantId={tenantId}
                        />
                      ))}
                  </TableBody>
                </Table>
              ) : null}
            </section>

            <section className="mission-control-panel">
              <div className="mission-control-panel-header">
                <h2>In flight</h2>
                <span className="mission-control-hint">live</span>
              </div>
              {activity.kind === "loading" ? (
                <Skeleton className="h-24 w-full" />
              ) : null}
              {activity.kind === "error" ? (
                <RichEmptyState
                  title="Couldn't load activity"
                  description={activity.message}
                />
              ) : null}
              {activity.kind !== "loading" &&
              activity.kind !== "error" &&
              inFlightRows.length === 0 ? (
                <RichEmptyState
                  title="Nothing running right now"
                  description="Agent runs and routine fires will show up here while they're in progress."
                />
              ) : null}
              {inFlightRows.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Run</TableHead>
                      <TableHead className="mission-control-opt">
                        Elapsed
                      </TableHead>
                      <TableHead className="mission-control-num">
                        Steps
                      </TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inFlightRows.map((row) => (
                      <TableRow key={row.key}>
                        <TableCell>
                          <span className="mission-control-cell-primary">
                            {row.label}
                          </span>
                          <br />
                          <span className="mission-control-cell-context">
                            {row.context}
                          </span>
                        </TableCell>
                        <TableCell className="mission-control-opt">
                          {formatRelativeTime(row.createdAt)}
                        </TableCell>
                        <TableCell className="mission-control-num">
                          {row.steps}
                        </TableCell>
                        <TableCell className="mission-control-num">
                          <Badge tone={row.statusTone}>{row.statusLabel}</Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : null}
            </section>

            <aside className="mission-control-rail">
              <section className="mission-control-panel">
                <div className="mission-control-panel-header">
                  <h2>Jump back in</h2>
                </div>
                {activity.kind === "loading" ? (
                  <Skeleton className="h-24 w-full" />
                ) : null}
                {activity.kind !== "loading" && jumpBackRows.length === 0 ? (
                  <p className="mission-control-empty-note">
                    Nothing recent yet.
                  </p>
                ) : null}
                {jumpBackRows.length > 0 ? (
                  <div className="mission-control-rows">
                    {jumpBackRows.map((row) =>
                      row.onSelect !== undefined ? (
                        <button
                          key={row.key}
                          type="button"
                          className="mission-control-jump-row"
                          onClick={row.onSelect}
                        >
                          {row.icon === "chat" ? <ChatCircleDots /> : <Robot />}
                          <span className="mission-control-jump-body">
                            <span className="mission-control-cell-primary">
                              {row.label}
                            </span>
                            <span className="mission-control-cell-context">
                              {row.context}
                            </span>
                          </span>
                          <span className="mission-control-jump-when">
                            {formatRelativeTime(row.when)}
                          </span>
                        </button>
                      ) : (
                        <div key={row.key} className="mission-control-jump-row">
                          <Robot />
                          <span className="mission-control-jump-body">
                            <span className="mission-control-cell-primary">
                              {row.label}
                            </span>
                            <span className="mission-control-cell-context">
                              {row.context}
                            </span>
                          </span>
                          <span className="mission-control-jump-when">
                            {formatRelativeTime(row.when)}
                          </span>
                        </div>
                      ),
                    )}
                  </div>
                ) : null}
              </section>

              <section className="mission-control-panel">
                <div className="mission-control-panel-header">
                  <h2>This week</h2>
                  <Link to="/insights" className="mission-control-hint-link">
                    Insights →
                  </Link>
                </div>
                {insightsActivity.kind === "loading" ? (
                  <Skeleton className="h-16 w-full" />
                ) : null}
                {insightsActivity.kind === "error" ? (
                  <p className="mission-control-empty-note">
                    Couldn't load this week's activity.
                  </p>
                ) : null}
                {insightsActivity.kind === "ready" ? (
                  <p className="mission-control-week-summary">
                    {days
                      .reduce((sum, day) => sum + day.turns, 0)
                      .toLocaleString()}{" "}
                    runs ·{" "}
                    {formatUsd(
                      days.some((day) =>
                        day.byModel.some((model) => model.costUsd === null),
                      )
                        ? null
                        : days.reduce(
                            (sum, day) =>
                              sum +
                              day.byModel.reduce(
                                (modelSum, model) =>
                                  modelSum + (model.costUsd ?? 0),
                                0,
                              ),
                            0,
                          ),
                    )}{" "}
                    spend
                  </p>
                ) : null}
              </section>
            </aside>
          </div>
        </PageShell>
      </div>
    </div>
  );
}
