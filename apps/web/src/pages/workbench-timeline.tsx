// Per-workbench Insights view (CL-6224): one wall-clock spine merging chat
// messages, thread forks, and approvals for a single workbench
// (== workbench, per docs/GLOSSARY.md), oldest to newest with day dividers.
// No new backend — every fetch here is an existing route this app already
// reads elsewhere (chat-ui, api.ts); the new work is
// `../workbench-timeline-merge.ts`'s pure merge, plus this render.

import { Badge, RichEmptyState, Skeleton } from "@corbits/react-ui";
import { listMessages, listThreads } from "@corbits/chat-ui";
import { Clock } from "@corbits/icons";
import { useMemo, useState } from "react";

import { usePendingApprovals } from "../pending-approvals";
import { useTenantQuery } from "../routines-api";
import { tenantKeys } from "../query-client";
import {
  computeTimelineDayKpis,
  filterTimelineEvents,
  groupTimelineByDay,
  mergeTimelineEvents,
  toApprovalEvents,
  toMessageEvents,
  toThreadForkEvents,
  type TimelineEvent,
  type TimelineFilter,
} from "../workbench-timeline-merge";

const FILTERS: readonly {
  readonly id: TimelineFilter;
  readonly label: string;
}[] = [
  { id: "all", label: "All" },
  { id: "messages", label: "Messages" },
  { id: "approvals", label: "Approvals" },
];

function timeOfDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function markerClass(event: TimelineEvent): string {
  switch (event.kind) {
    case "message":
      return event.isAgent
        ? "workbench-timeline-marker-primary"
        : "workbench-timeline-marker-neutral";
    case "thread-fork":
      return "workbench-timeline-marker-neutral";
    case "approval":
      return "workbench-timeline-marker-warn";
  }
}

function TimelineRowBody({ event }: { readonly event: TimelineEvent }) {
  switch (event.kind) {
    case "message":
      return (
        <div className="workbench-timeline-entry-body">
          <strong>{event.senderName}</strong>
          <span className="workbench-timeline-entry-excerpt">
            {event.excerpt}
          </span>
        </div>
      );
    case "thread-fork":
      return (
        <div className="workbench-timeline-entry-body">
          <span>
            Forked {event.threadKind === "delivery" ? "delivery" : "reply"}{" "}
            thread · {event.title}
          </span>
        </div>
      );
    case "approval":
      return (
        <div className="workbench-timeline-entry-body">
          <span>
            {event.agentName} needs your approval · {event.headline}
          </span>
          <Badge tone="warning">pending</Badge>
        </div>
      );
  }
}

function TimelineRow({ event }: { readonly event: TimelineEvent }) {
  const indented = event.kind === "thread-fork";
  return (
    <li
      className="workbench-timeline-entry"
      data-indented={indented}
      data-ctx-timeline-event={event.id}
    >
      <span
        className={`workbench-timeline-marker ${markerClass(event)}`}
        aria-hidden="true"
      />
      <span className="workbench-timeline-entry-time">
        {timeOfDay(event.at)}
      </span>
      <TimelineRowBody event={event} />
    </li>
  );
}

function DayKpiRow({
  kpi,
}: {
  readonly kpi: ReturnType<typeof computeTimelineDayKpis>[number];
}) {
  return (
    <div className="workbench-timeline-kpi-day">
      <h4>{kpi.label}</h4>
      <dl>
        <div>
          <dt>Messages</dt>
          <dd>{kpi.messages}</dd>
        </div>
        <div>
          <dt>Agent turns</dt>
          <dd>{kpi.agentTurns}</dd>
        </div>
        <div>
          <dt>Approvals</dt>
          <dd>{kpi.approvals}</dd>
        </div>
      </dl>
    </div>
  );
}

export function WorkbenchTimelineView({
  events,
  loading,
}: {
  readonly events: readonly TimelineEvent[];
  readonly loading: boolean;
}) {
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const filtered = useMemo(
    () => filterTimelineEvents(events, filter),
    [events, filter],
  );
  const dayGroups = useMemo(() => groupTimelineByDay(filtered), [filtered]);
  const kpis = useMemo(() => computeTimelineDayKpis(events), [events]);

  if (loading) {
    return <Skeleton className="h-48 w-full" />;
  }

  if (events.length === 0) {
    return (
      <RichEmptyState
        icon={<Clock />}
        title="Nothing on this workbench's timeline yet"
        description="Messages and approvals will show up here as they happen."
      />
    );
  }

  return (
    <div className="workbench-timeline">
      <div
        className="workbench-timeline-filters"
        role="group"
        aria-label="Timeline filter"
      >
        {FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={filter === option.id}
            data-active={filter === option.id}
            className="workbench-timeline-filter-option"
            onClick={() => setFilter(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="workbench-timeline-body">
        <div className="workbench-timeline-spine">
          {dayGroups.length === 0 ? (
            <p className="insights-note">No events match this filter.</p>
          ) : (
            dayGroups.map((day) => (
              <section key={day.day} className="workbench-timeline-day">
                <div className="workbench-timeline-day-divider">
                  <span>{day.label}</span>
                </div>
                <ol className="workbench-timeline-rail">
                  {day.events.map((event) => (
                    <TimelineRow
                      key={`${event.kind}-${event.id}`}
                      event={event}
                    />
                  ))}
                </ol>
              </section>
            ))
          )}
        </div>
        <aside className="workbench-timeline-kpis">
          <h3>Daily activity</h3>
          {kpis.map((kpi) => (
            <DayKpiRow key={kpi.day} kpi={kpi} />
          ))}
        </aside>
      </div>
    </div>
  );
}

/**
 * Fetch composition for one workbench's Timeline. `benchTenantId` is the
 * owning bench — chat's own workbench-tenancy keeps messages/threads
 * addressed at the parent bench's tenant id even though the workbench also
 * mints its own workbench tenant (see docs/workbench-tenancy.md) — while
 * `workbenchId` is the workbench's own id, resolved to that workbench tenant
 * one level up in `InsightsWorkbenchPage` (`../insights-workbench-scope.ts`)
 * for the tenant-scoped Insights endpoints; this component only ever reads
 * messages/threads/approvals off the owning bench.
 */
export function WorkbenchTimelineRoute({
  benchTenantId,
  workbenchId,
}: {
  readonly benchTenantId: string | null;
  readonly workbenchId: string;
  readonly onOpenRun: (runId: string) => void;
}) {
  const messagesQuery = useTenantQuery(
    benchTenantId === null
      ? ["tenant", "none", "chat", "workbenches", workbenchId, "messages"]
      : tenantKeys.workbenchMessages(benchTenantId, workbenchId),
    benchTenantId !== null,
    () =>
      listMessages(benchTenantId as string, workbenchId).then(
        (page) => page.items,
      ),
  );
  const threadsQuery = useTenantQuery(
    benchTenantId === null
      ? ["tenant", "none", "chat", "workbenches", workbenchId, "threads"]
      : tenantKeys.workbenchThreads(benchTenantId, workbenchId),
    benchTenantId !== null,
    () =>
      listThreads(benchTenantId as string, workbenchId).then(
        (page) => page.items,
      ),
  );
  const approvalsQuery = usePendingApprovals(benchTenantId);

  const loading =
    messagesQuery.kind === "loading" ||
    threadsQuery.kind === "loading" ||
    approvalsQuery.kind === "loading";

  const messages = messagesQuery.kind === "ready" ? messagesQuery.data : [];
  const threads = threadsQuery.kind === "ready" ? threadsQuery.data : [];
  // An approval carries no workbench id (a known v1 gap — see
  // workbench-timeline-merge.ts's toApprovalEvents), so this is every
  // pending approval on the owning bench, not just this workbench's own.
  const approvals = approvalsQuery.kind === "ready" ? approvalsQuery.data : [];

  const events = mergeTimelineEvents({
    messages: toMessageEvents(messages),
    threadForks: toThreadForkEvents(threads),
    approvals: toApprovalEvents(approvals),
  });

  return <WorkbenchTimelineView events={events} loading={loading} />;
}
