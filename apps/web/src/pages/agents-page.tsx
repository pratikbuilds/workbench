// Agents: the global roster (CL-6354) — every agent definition this bench
// has, one row per definition (name, description, workbenches currently
// using it), with a detail panel that fetches the definition's model on
// demand (`getAgentCapabilities`, the same route the per-workbench
// Assistant editor reads). Create runs through `CreateAgentPanel`, the
// same `createAgentDefinition` (`@corbits/agent-directory`) call the old
// pre-CL-5990 Agents page used. Editing instructions/capabilities stays
// where CL-6215 put it — the per-workbench Assistant tab
// (`@corbits/chat-ui`'s `AgentsSection`) — this page is roster-only, never
// a second instructions editor.

import {
  Badge,
  BulkActionBar,
  Button,
  PageShell,
  RichEmptyState,
  SelectionCheckbox,
  Skeleton,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
  useListSelection,
} from "@corbits/react-ui";
import type { BadgeTone, SelectionCheckboxState } from "@corbits/react-ui";
import { Archive, ArrowSquareOut, Plus, Robot } from "@corbits/icons";
import { detailPath } from "@corbits/command-palette";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { describeApiError, QueryView } from "@corbits/api-query";

import {
  getAgentCapabilities,
  listTopLevelRuns,
  setAgentDefinitionStatus,
  useAgentDirectory,
  type AgentCapabilities,
  type AgentDefinition,
  type AgentInstance,
  type CatalogModel,
} from "../agents-api";
import {
  purposeAgentDefinitions,
  type AgentDefinitionWithDisplayName,
} from "../agents-directory";
import { useBench } from "../bench-context";
import { isAdditiveSelectClick } from "../activatable-row";
import { Link } from "../navigation";
import { useBenchActivity } from "../shell/bench-activity";
import { AGENTS_PATH_PREFIX, agentIdFromPath } from "../path-ids";
import { tenantKeys } from "../query-client";
import { StageTopBar } from "../shell/stage-top-bar";
import { workbenchSettingsPath } from "../workbench-path";
import { CreateAgentPanel } from "./create-agent-panel";

const DEFINITION_STATUS_TONE: Record<AgentDefinition["status"], BadgeTone> = {
  deployed: "success",
  stopped: "neutral",
};

const DEFINITION_STATUS_LABEL: Record<AgentDefinition["status"], string> = {
  deployed: "Deployed",
  stopped: "Stopped",
};

/** The roster's Status column folds a definition's own deployed/stopped
 * state together with its live instances' statuses — a stopped definition
 * always reads Archived; a deployed one reads Live while any instance
 * is actively running, Blocked while any instance is erroring, otherwise
 * Idle. `instances` is expected to already be a tenant's top-level runs
 * (`listTopLevelRuns`), never the folded per-workbench-host noise. */
export type AgentRosterStatus = "running" | "idle" | "blocked" | "archived";

const AGENT_ROSTER_STATUS_LABEL: Record<AgentRosterStatus, string> = {
  running: "Live",
  idle: "Idle",
  blocked: "Blocked",
  archived: "Archived",
};

// Adopts `@corbits/react-ui`'s own run-status convention
// (`RUN_STATUS_TONE`/`workflow-run.ts`) rather than inventing a mapping:
// running is the blue "live/streaming" tone (with a pulsing `StatusDot`,
// the same liveness marker that vocabulary already carries); idle is the
// green "healthy, nothing wrong" tone (`pill-ok` in the spec); blocked and
// archived were already right.
export const AGENT_ROSTER_STATUS_TONE: Record<AgentRosterStatus, BadgeTone> = {
  running: "info",
  idle: "success",
  blocked: "danger",
  archived: "neutral",
};

export function agentRosterStatus(
  definition: AgentDefinition,
  instances: readonly AgentInstance[],
): AgentRosterStatus {
  if (definition.status === "stopped") return "archived";
  const own = instances.filter(
    (instance) => instance.definitionId === definition.id,
  );
  if (own.some((instance) => instance.status === "running")) return "running";
  if (own.some((instance) => instance.status === "error")) return "blocked";
  return "idle";
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** How many of a definition's instances were created in the trailing 7
 * days — the roster's "Runs · 7d" column. */
export function runsInLast7Days(
  definitionId: string,
  instances: readonly AgentInstance[],
  now: number,
): number {
  return instances.filter(
    (instance) =>
      instance.definitionId === definitionId &&
      now - new Date(instance.createdAt).getTime() <= SEVEN_DAYS_MS,
  ).length;
}

export type ArchiveDefinitionsResult = {
  readonly succeededIds: readonly string[];
  readonly failedIds: readonly string[];
};

/**
 * Archives every selected id independently — `Promise.allSettled`, never
 * `Promise.all`, so one id failing server-side can't hide (or roll back)
 * the ids that already succeeded. The caller invalidates its queries and
 * toasts off the returned counts regardless of whether anything failed.
 */
export async function archiveDefinitions(
  ids: readonly string[],
  archive: (id: string) => Promise<unknown>,
): Promise<ArchiveDefinitionsResult> {
  const results = await Promise.allSettled(ids.map((id) => archive(id)));
  const succeededIds: string[] = [];
  const failedIds: string[] = [];
  results.forEach((result, index) => {
    const id = ids[index];
    if (id === undefined) return;
    if (result.status === "fulfilled") succeededIds.push(id);
    else failedIds.push(id);
  });
  return { succeededIds, failedIds };
}

/** The toast copy for a bulk archive — an honest count either way, never
 * a blanket success/failure message that could describe a partial run. */
export function archiveResultToast({
  succeededIds,
  failedIds,
}: ArchiveDefinitionsResult): string {
  const total = succeededIds.length + failedIds.length;
  if (failedIds.length === 0) {
    return succeededIds.length === 1
      ? "Archived 1 agent"
      : `Archived ${succeededIds.length} agents`;
  }
  if (succeededIds.length === 0) {
    return failedIds.length === 1
      ? "Couldn't archive that agent"
      : "Couldn't archive those agents";
  }
  return `Archived ${succeededIds.length} of ${total} — the rest failed`;
}

/** The short model name for a definition's capabilities — fetched lazily,
 * per row, the same route (and the same plain fetch-effect, no react-query
 * client required) `AgentDetailPanel` below already uses. A fetch failure
 * must not reuse the muted em-dash empty fields use (CL-6848). */
export type AgentModelCellState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: AgentCapabilities }
  | { readonly status: "error"; readonly message: string };

function catalogModelLabel(
  canonical: string,
  catalog: readonly {
    readonly canonicalName: string;
    readonly displayName?: string | null;
  }[],
): string {
  const match = catalog.find((model) => model.canonicalName === canonical);
  return match?.displayName ?? canonical;
}

/** Settled Model-column content — an unset model reads as "Default"; a
 * fetch failure is a distinct error, never the same label. A set model
 * maps through the tenant catalog's displayName (CL-6748), the same
 * `displayName ?? canonicalName` reading settings already uses — never
 * an invented label, and never a rewrite of an unset model to the
 * tenant default (CL-6782). */
export function agentModelSettledContent(
  state:
    | { readonly status: "ready"; readonly data: AgentCapabilities }
    | { readonly status: "error"; readonly message: string },
  catalog: readonly {
    readonly canonicalName: string;
    readonly displayName?: string | null;
  }[],
):
  | { readonly kind: "model"; readonly label: string }
  | { readonly kind: "error"; readonly message: string } {
  if (state.status === "error") {
    return { kind: "error", message: state.message };
  }
  const canonical = state.data.model;
  if (canonical === undefined) {
    return { kind: "model", label: "Default" };
  }
  return { kind: "model", label: catalogModelLabel(canonical, catalog) };
}

/** Presentational half of the Model column — exported so tests can assert
 * the failure glyph without waiting on the per-row fetch effect. */
export function AgentModelCellView({
  state,
  catalog,
}: {
  readonly state: AgentModelCellState;
  readonly catalog: readonly {
    readonly canonicalName: string;
    readonly displayName?: string | null;
  }[];
}) {
  if (state.status === "loading") {
    return <Skeleton className="h-4 w-14" />;
  }
  const settled = agentModelSettledContent(state, catalog);
  if (settled.kind === "error") {
    return (
      <span className="text-xs text-destructive" role="alert">
        {settled.message}
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">{settled.label}</span>;
}

function AgentModelCell({
  tenantId,
  definitionId,
  catalog,
}: {
  readonly tenantId: string;
  readonly definitionId: string;
  readonly catalog: readonly CatalogModel[];
}) {
  const [capabilities, setCapabilities] = useState<AgentModelCellState>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    setCapabilities({ status: "loading" });
    getAgentCapabilities(tenantId, definitionId)
      .then((data) => {
        if (!cancelled) setCapabilities({ status: "ready", data });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setCapabilities({
            status: "error",
            message: describeApiError(cause, "loading this agent's model"),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, definitionId]);

  return <AgentModelCellView state={capabilities} catalog={catalog} />;
}

/** Settled Runs · 7d content — a failed top-level-runs fetch is never the
 * same as an honest count of zero (CL-6842). */
export function agentRunsSettledContent(
  definitionId: string,
  instances: readonly AgentInstance[],
  now: number,
  instancesError: string | null,
):
  | { readonly kind: "count"; readonly value: number }
  | { readonly kind: "error"; readonly message: string } {
  if (instancesError !== null) {
    return { kind: "error", message: instancesError };
  }
  return {
    kind: "count",
    value: runsInLast7Days(definitionId, instances, now),
  };
}

/** A workbench instance running a given agent definition — just enough to
 * link to its own settings Agents tab (`workbenchSettingsPath`), which
 * takes the workbench's own id directly, never a tenant id. */
export type DefinitionWorkbenchInstance = {
  readonly id: string;
  readonly title: string;
};

/** Definitions this bench's chats are launched against, grouped by
 * definition id — the roster's "Workbenches" column and detail panel.
 * `chats` comes from `useBenchActivity`, the same agent-DM listing the
 * sidebar itself reads; the list here is exactly which rows the sidebar
 * would show for a definition before CL-6271's dedupe-by-title collapses
 * same-named DMs across ancestor tenants. */
export function workbenchesByDefinition(
  chats: readonly {
    readonly id: string;
    readonly title: string;
    readonly definitionId?: string | null;
  }[],
): ReadonlyMap<string, readonly DefinitionWorkbenchInstance[]> {
  const byDefinition = new Map<string, DefinitionWorkbenchInstance[]>();
  for (const chat of chats) {
    if (chat.definitionId === null || chat.definitionId === undefined) {
      continue;
    }
    const list = byDefinition.get(chat.definitionId) ?? [];
    list.push({ id: chat.id, title: chat.title });
    byDefinition.set(chat.definitionId, list);
  }
  return byDefinition;
}

function AgentDetailPanel({
  tenantId,
  definition,
  workbenches,
  catalog,
}: {
  readonly tenantId: string;
  readonly definition: AgentDefinitionWithDisplayName;
  readonly workbenches: readonly DefinitionWorkbenchInstance[];
  readonly catalog: readonly CatalogModel[];
}) {
  const [capabilities, setCapabilities] = useState<
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly data: AgentCapabilities }
    | { readonly status: "error"; readonly message: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setCapabilities({ status: "loading" });
    getAgentCapabilities(tenantId, definition.id)
      .then((data) => {
        if (!cancelled) setCapabilities({ status: "ready", data });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setCapabilities({
            status: "error",
            message: describeApiError(cause, "loading this agent's model"),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, definition.id]);

  return (
    <aside className="flex min-h-0 min-w-0 flex-col gap-4 border-l border-border bg-card p-4">
      <div>
        <p className="truncate text-sm font-semibold">
          {definition.displayName}
        </p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {definition.name}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {definition.description !== null &&
          definition.description !== undefined
            ? definition.description
            : "No description"}
        </p>
      </div>
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <Badge
              tone={DEFINITION_STATUS_TONE[definition.status]}
              className="normal-case"
            >
              {DEFINITION_STATUS_LABEL[definition.status]}
            </Badge>
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Model</dt>
          <dd>
            {capabilities.status === "loading" ? (
              <Skeleton className="h-4 w-16" />
            ) : null}
            {capabilities.status === "error" ? (
              <span className="text-destructive">{capabilities.message}</span>
            ) : null}
            {capabilities.status === "ready"
              ? capabilities.data.model === undefined
                ? "Default"
                : catalogModelLabel(capabilities.data.model, catalog)
              : null}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">Workbenches</dt>
          <dd>
            {workbenches.length === 0 ? (
              <span className="text-muted-foreground">0</span>
            ) : (
              <ul className="flex flex-col gap-1">
                {workbenches.map((workbench) => (
                  <li key={workbench.id} className="truncate">
                    <Link
                      to={workbenchSettingsPath(workbench.id, "agents")}
                      className="text-foreground underline underline-offset-2 hover:text-muted-foreground"
                    >
                      {workbench.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
      <Button asChild variant="outline" size="sm" className="w-full">
        <Link
          to={detailPath(AGENTS_PATH_PREFIX, {
            slug: definition.name,
            id: definition.id,
          })}
        >
          <ArrowSquareOut aria-hidden="true" />
          Open
        </Link>
      </Button>
    </aside>
  );
}

/**
 * The roster stage: a flat table of every definition this bench owns —
 * name, status, model, and how often it has run in the last week — rows,
 * never cards, per the owner's "rows over grids" rule for this slice.
 * Selecting a row opens its detail alongside the table; the panel's Open
 * control hops to `/agents/<slug>` for the full page. "New agent" opens
 * `CreateAgentPanel`. Rows are also bulk-selectable (checkbox + shift/cmd
 * range select, `useListSelection`) with a floating `BulkActionBar` for
 * Archive — the only bulk action with a real backend primitive
 * (`setAgentDefinitionStatus`, the same PUT the single-agent Archive
 * button on the detail page already uses). Duplicate/Move/Delete are not
 * offered here: batch duplication needs slug-collision handling the detail
 * page's single-agent duplicate never had to solve, and Move/Delete have
 * no backend primitive at all — a button that cannot do what it says is
 * worse than no button.
 */
export function AgentsPage({
  tenantId,
  definitions,
  workbenches,
  instances,
  instancesError = null,
  models = [],
  now = Date.now(),
  selectedId,
  onSelect,
  createOpen,
  onCreateOpenChange,
  onCreated,
  onArchiveSelected,
  skillsError,
}: {
  readonly tenantId: string | null;
  readonly definitions: readonly AgentDefinitionWithDisplayName[];
  readonly workbenches: ReadonlyMap<
    string,
    readonly DefinitionWorkbenchInstance[]
  >;
  readonly instances: readonly AgentInstance[];
  /** When the top-level-runs fetch failed — Status/Runs · 7d must not pretend
   * the history is empty (CL-6842). */
  readonly instancesError?: string | null;
  /** Tenant catalog used to map a stored canonical model id to its
   * person-readable displayName. Empty when the catalog failed independently
   * — the column then shows the canonical, never an invented name. */
  readonly models?: readonly CatalogModel[];
  readonly now?: number;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly createOpen: boolean;
  readonly onCreateOpenChange: (open: boolean) => void;
  readonly onCreated: (definition: AgentDefinition) => void;
  readonly onArchiveSelected: (ids: readonly string[]) => void;
  /** Set when the directory's attached-skills batch failed; distinct from
   * agents that simply have no skills pinned. */
  readonly skillsError?: string;
}) {
  const selected = definitions.find((d) => d.id === selectedId) ?? null;
  const definitionIds = useMemo(
    () => definitions.map((definition) => definition.id),
    [definitions],
  );
  const selection = useListSelection({ ids: definitionIds });
  const allSelected =
    definitions.length > 0 && selection.selectedCount === definitions.length;
  const headerChecked: SelectionCheckboxState =
    selection.selectedCount === 0
      ? false
      : allSelected
        ? true
        : "indeterminate";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "Agents" }]}
        subtitle={`${definitions.length} agents`}
        actions={
          tenantId !== null ? (
            <Button
              size="sm"
              onClick={() => onCreateOpenChange(true)}
              aria-label="Create an agent"
            >
              <Plus /> New agent
            </Button>
          ) : null
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          <PageShell width="full" className="page-fill">
            {skillsError !== undefined ? (
              <p
                className="px-4 pb-3 text-sm text-destructive sm:px-7"
                role="alert"
              >
                Could not load agent skills: {skillsError}
              </p>
            ) : null}
            {definitions.length === 0 ? (
              <RichEmptyState
                icon={<Robot />}
                title="No agents yet"
                description="Create an agent — a name, a system prompt, and optionally a model — and it appears here and in the sidebar, ready to start a workbench."
              />
            ) : (
              <div className="px-4 pb-5 sm:px-7">
                {instancesError !== null ? (
                  <p className="mb-3 text-sm text-destructive" role="alert">
                    {instancesError}
                  </p>
                ) : null}
                <Table aria-label="Agents">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <SelectionCheckbox
                          checked={headerChecked}
                          onToggle={() =>
                            allSelected
                              ? selection.clear()
                              : selection.selectAll()
                          }
                          rowLabel="all agents"
                          ariaLabel="Select all agents"
                          className="opacity-100"
                        />
                      </TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead className="hidden lg:table-cell">
                        Description
                      </TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden lg:table-cell">
                        Model
                      </TableHead>
                      <TableHead className="hidden text-right lg:table-cell">
                        Runs · 7d
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {definitions.map((definition) => {
                      const isSelected = selection.isSelected(definition.id);
                      const runs = agentRunsSettledContent(
                        definition.id,
                        instances,
                        now,
                        instancesError,
                      );
                      const status =
                        runs.kind === "error"
                          ? null
                          : agentRosterStatus(definition, instances);
                      return (
                        <TableRow
                          key={definition.id}
                          data-state={
                            selectedId === definition.id
                              ? "selected"
                              : undefined
                          }
                          className="group cursor-pointer"
                          role="button"
                          tabIndex={0}
                          onClick={(event) => {
                            if (
                              event.shiftKey ||
                              isAdditiveSelectClick(event)
                            ) {
                              selection.toggle(definition.id, {
                                shiftKey: event.shiftKey,
                              });
                              return;
                            }
                            onSelect(
                              selectedId === definition.id
                                ? null
                                : definition.id,
                            );
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") {
                              return;
                            }
                            event.preventDefault();
                            onSelect(
                              selectedId === definition.id
                                ? null
                                : definition.id,
                            );
                          }}
                        >
                          <TableCell
                            onClick={(event) => event.stopPropagation()}
                          >
                            <SelectionCheckbox
                              checked={isSelected}
                              onToggle={(modifiers) =>
                                selection.toggle(definition.id, modifiers)
                              }
                              rowLabel={definition.displayName}
                            />
                          </TableCell>
                          <TableCell className="font-medium">
                            <span className="text-[13.5px] font-bold">
                              {definition.displayName}
                            </span>
                          </TableCell>
                          <TableCell className="hidden text-muted-foreground lg:table-cell">
                            {definition.description !== null &&
                            definition.description !== undefined &&
                            definition.description !== ""
                              ? definition.description
                              : "—"}
                          </TableCell>
                          <TableCell>
                            {status === null ? (
                              <span className="text-destructive">—</span>
                            ) : (
                              <span className="inline-flex items-center gap-1.5">
                                {status === "running" ? (
                                  <StatusDot
                                    label="Live"
                                    live
                                    tone="emphasis"
                                    size="xs"
                                  />
                                ) : null}
                                <Badge
                                  tone={AGENT_ROSTER_STATUS_TONE[status]}
                                  className="normal-case"
                                >
                                  {AGENT_ROSTER_STATUS_LABEL[status]}
                                </Badge>
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="hidden lg:table-cell">
                            {tenantId !== null ? (
                              <AgentModelCell
                                tenantId={tenantId}
                                definitionId={definition.id}
                                catalog={models}
                              />
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="hidden text-right tabular-nums text-muted-foreground lg:table-cell">
                            {runs.kind === "error" ? (
                              <span className="text-destructive">—</span>
                            ) : (
                              runs.value
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </PageShell>
        </div>
        {selected !== null && tenantId !== null ? (
          <div className="hidden w-[min(24rem,40%)] shrink-0 md:flex md:flex-col">
            <AgentDetailPanel
              tenantId={tenantId}
              definition={selected}
              workbenches={workbenches.get(selected.id) ?? []}
              catalog={models}
            />
          </div>
        ) : null}
      </div>
      {tenantId !== null ? (
        <CreateAgentPanel
          open={createOpen}
          onOpenChange={onCreateOpenChange}
          tenantId={tenantId}
          onCreated={(definition) => {
            onCreateOpenChange(false);
            onSelect(definition.id);
            onCreated(definition);
          }}
        />
      ) : null}
      <BulkActionBar count={selection.selectedCount} onClear={selection.clear}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-bulk-action="archive"
          onClick={() => {
            const ids = [...selection.selectedIds];
            selection.clear();
            onArchiveSelected(ids);
          }}
        >
          <Archive aria-hidden="true" />
          Archive
        </Button>
      </BulkActionBar>
    </div>
  );
}

export function AgentsRoute({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const queryClient = useQueryClient();
  const directory = useAgentDirectory(selectedTenantId ?? undefined);
  const activity = useBenchActivity(selectedTenantId);
  // Powers the roster's Status and "Runs · 7d" columns. A failed fetch must
  // not degrade those columns to Idle/0 (CL-6842) — the definitions listing
  // still makes the page usable, but Status/Runs admit the load failed.
  const runsQuery = useQuery({
    queryKey: ["agent-top-level-runs", selectedTenantId],
    queryFn: () => listTopLevelRuns(selectedTenantId as string),
    enabled: selectedTenantId !== null,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const selectedId = agentIdFromPath(path);

  if (selectedTenantId === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Agents" }]} />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<Robot />}
            title="Select a workbench"
            description="Pick a workbench from the switcher to see the agents it can start."
          />
        </PageShell>
      </div>
    );
  }

  if (directory.kind !== "ready") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Agents" }]} />
        <PageShell width="full" className="page-fill">
          <QueryView query={directory} label="your agents" skeleton="rows">
            {() => null}
          </QueryView>
        </PageShell>
      </div>
    );
  }

  const definitions = purposeAgentDefinitions(directory.data.definitions);
  const workbenches = workbenchesByDefinition(
    activity.kind === "ready" ? activity.chats : [],
  );

  return (
    <AgentsPage
      tenantId={selectedTenantId}
      definitions={definitions}
      workbenches={workbenches}
      instances={runsQuery.data ?? []}
      instancesError={
        runsQuery.isError
          ? describeApiError(runsQuery.error, "loading run history")
          : null
      }
      models={directory.data.models}
      selectedId={selectedId}
      onSelect={(id) =>
        navigate(
          id === null
            ? AGENTS_PATH_PREFIX
            : `${AGENTS_PATH_PREFIX}/${encodeURIComponent(id)}`,
        )
      }
      createOpen={createOpen}
      onCreateOpenChange={setCreateOpen}
      onCreated={() => {
        void queryClient.invalidateQueries({
          queryKey: tenantKeys.agentDirectory(selectedTenantId),
        });
      }}
      onArchiveSelected={(ids) => {
        if (ids.length === 0) return;
        void archiveDefinitions(ids, (id) =>
          setAgentDefinitionStatus(selectedTenantId, id, "stopped"),
        ).then((result) => {
          // Invalidate regardless of outcome: a partial failure still
          // archived some ids server-side, so the roster must not keep
          // showing them as active.
          void queryClient.invalidateQueries({
            queryKey: tenantKeys.agentDirectory(selectedTenantId),
          });
          void queryClient.invalidateQueries({
            queryKey: ["agent-top-level-runs", selectedTenantId],
          });
          toast(archiveResultToast(result));
        });
      }}
      {...(directory.data.skillsError !== undefined
        ? { skillsError: directory.data.skillsError }
        : {})}
    />
  );
}
