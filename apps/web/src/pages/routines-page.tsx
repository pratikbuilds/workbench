// Routines: an ops table of authored workflow definitions that carry a
// ScheduleTrigger, including paused (`stopped`) ones. Pause/resume and
// run-now are the only writes; schedules are authored on the definition.
// The "Available" section (CL-7073) is scoped to the current bench only
// — adding a catalog workflow is a single-tenant write, unlike the
// scheduled roster above, which aggregates every bench the account
// belongs to.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  EmptyState,
  RichEmptyState,
  RunNowButton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@corbits/react-ui";
import { Clock } from "@corbits/icons";
import { cronSentence } from "@corbits/workflows/client";
import { reportError } from "@corbits/error-sink";
import { describeApiError, ApiQueryError } from "@corbits/api-query";

import { useGlobalRoutines, useRoutineActions } from "../global-routines";
import type { GlobalRoutineRow } from "../global-routines";
import { routineDetailPath } from "../global-routines";
import { useBench } from "../bench-context";
import { tenantKeys } from "../query-client";
import {
  listAvailableCatalogWorkflows,
  type AvailableCatalogWorkflow,
} from "../routines-api";
import { deployWorkbenchTemplateBlock } from "../workbench-templates-api";
import { Link } from "../navigation";
import { PLUGINS_PATH_PREFIX } from "../path-ids";
import { StageTopBar } from "../shell/stage-top-bar";
import {
  ADD_BUTTON_BUSY_LABEL,
  ADD_BUTTON_LABEL,
  AVAILABLE_SECTION_SUBTITLE,
  AVAILABLE_SECTION_TITLE,
  CONNECT_LINK_LABEL,
  NOT_DEPLOYABLE_YET_REASON,
  addFailureMessage,
  addSuccessMessage,
  missingConnectionsReason,
} from "./routines-available-strings";

export type { GlobalRoutineRow } from "../global-routines";

export function AvailableCatalogWorkflowsSection({
  tenantId,
}: {
  readonly tenantId: string;
}) {
  const queryClient = useQueryClient();
  const [pendingAssetName, setPendingAssetName] = useState<string | null>(null);
  const query = useQuery({
    queryKey: tenantKeys.availableCatalogWorkflows(tenantId),
    queryFn: () => listAvailableCatalogWorkflows(tenantId),
  });

  if (query.isLoading) return null;
  const items: readonly AvailableCatalogWorkflow[] = query.data ?? [];
  if (items.length === 0) return null;

  async function handleAdd(entry: AvailableCatalogWorkflow) {
    setPendingAssetName(entry.assetName);
    try {
      await deployWorkbenchTemplateBlock(tenantId, entry.assetName);
      await queryClient.invalidateQueries({
        queryKey: tenantKeys.availableCatalogWorkflows(tenantId),
      });
      await queryClient.invalidateQueries({
        queryKey: tenantKeys.routines(tenantId),
      });
      toast(addSuccessMessage(entry.displayName));
    } catch (cause) {
      reportError(cause, {
        operation: "catalog_workflow_add",
        tenantId,
      });
      const detail = describeApiError(cause, "adding this");
      const refId = cause instanceof ApiQueryError ? cause.refId : undefined;
      toast(
        addFailureMessage(
          entry.displayName,
          refId !== undefined ? `${detail} (Reference: ${refId})` : detail,
        ),
      );
    } finally {
      setPendingAssetName(null);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-b border-[var(--ui-border)] p-4">
      <div className="flex flex-col">
        <h2 className="text-sm font-medium">{AVAILABLE_SECTION_TITLE}</h2>
        <p className="text-xs text-[var(--ui-fg-muted)]">
          {AVAILABLE_SECTION_SUBTITLE}
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {items.map((entry) => {
          const notDeployableYet = !entry.deployable;
          const disabled = notDeployableYet || !entry.connectionsSatisfied;
          const busy = pendingAssetName === entry.assetName;
          return (
            <li
              key={entry.assetName}
              data-ctx-available-workflow={entry.assetName}
              className="flex items-center justify-between gap-3 rounded-md border border-[var(--ui-border)] p-3"
            >
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">{entry.displayName}</span>
                <span className="text-xs text-[var(--ui-fg-muted)]">
                  {entry.description}
                </span>
                {notDeployableYet ? (
                  <span className="text-xs text-[var(--ui-fg-muted)]">
                    {NOT_DEPLOYABLE_YET_REASON}
                  </span>
                ) : !entry.connectionsSatisfied ? (
                  <span className="flex items-center gap-2 text-xs text-[var(--ui-fg-muted)]">
                    {missingConnectionsReason(entry.missingConnections)}
                    <Link to={PLUGINS_PATH_PREFIX} className="underline">
                      {CONNECT_LINK_LABEL}
                    </Link>
                  </span>
                ) : null}
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled || busy}
                onClick={() => void handleAdd(entry)}
              >
                {busy ? ADD_BUTTON_BUSY_LABEL : ADD_BUTTON_LABEL}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function scheduleSentence(cron: string): string {
  return cronSentence(cron) ?? cron;
}

export function GlobalRoutinesList({
  rows,
  onToggleEnabled,
  onRunNow,
}: {
  readonly rows: readonly GlobalRoutineRow[];
  readonly onToggleEnabled: (row: GlobalRoutineRow, enabled: boolean) => void;
  readonly onRunNow: (row: GlobalRoutineRow) => Promise<void>;
}) {
  if (rows.length === 0) {
    return (
      <RichEmptyState
        icon={<Clock />}
        title="No scheduled workflows yet"
        description="A workflow with a schedule shows up here. Pause, resume, or run it now."
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Routine</TableHead>
          <TableHead>Schedule</TableHead>
          <TableHead>On</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const enabled = row.definition.status === "deployed";
          return (
            <TableRow
              key={row.definition.definitionId}
              data-ctx-routine={row.definition.definitionId}
              data-ctx-routine-name={row.definition.name}
            >
              <TableCell>
                <span className="flex flex-col">
                  <Link
                    to={routineDetailPath(row.definition.definitionId)}
                    className="text-sm font-medium"
                  >
                    {row.definition.name}
                  </Link>
                  <span className="text-xs text-[var(--ui-fg-muted)]">
                    {row.tenantName}
                  </span>
                </span>
              </TableCell>
              <TableCell>
                <span className="text-sm">
                  {scheduleSentence(row.definition.cron)}
                </span>
              </TableCell>
              <TableCell>
                <Switch
                  checked={enabled}
                  label={`${enabled ? "On" : "Off"} ${row.definition.name}`}
                  onCheckedChange={(next) => onToggleEnabled(row, next)}
                />
              </TableCell>
              <TableCell>
                <RunNowButton
                  variant="outline"
                  size="sm"
                  onRun={() => onRunNow(row)}
                />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function RoutinesRoute() {
  const routinesQuery = useGlobalRoutines();
  const actions = useRoutineActions();
  const rows = routinesQuery.kind === "ready" ? routinesQuery.data : [];
  const { selectedTenantId } = useBench();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "Routines" }]}
        subtitle="Scheduled workflows. Pause, resume, or run now."
      />
      <div className="stage-content flex min-h-0 flex-1 flex-col overflow-y-auto">
        {selectedTenantId !== null ? (
          <AvailableCatalogWorkflowsSection tenantId={selectedTenantId} />
        ) : null}
        {routinesQuery.kind === "loading" ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <EmptyState icon={<Clock />} title="Loading routines…" />
          </div>
        ) : routinesQuery.kind === "error" ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <RichEmptyState
              icon={<Clock />}
              title="Couldn't load routines"
              description={routinesQuery.message}
            />
          </div>
        ) : (
          <GlobalRoutinesList
            rows={rows}
            onToggleEnabled={(row, enabled) => {
              void actions.setEnabled(row, enabled);
            }}
            onRunNow={(row) => actions.runNow(row)}
          />
        )}
      </div>
    </div>
  );
}
