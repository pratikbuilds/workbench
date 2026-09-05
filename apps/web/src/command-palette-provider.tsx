import {
  artifactKindLabel,
  CommandPalette,
  useCommandShortcut,
  useTheme,
} from "@corbits/react-ui";
import type { CommandPaletteGroup } from "@corbits/react-ui";
import { listWorkbenches } from "@corbits/chat-ui";
import { libraryArtifactPath } from "@corbits/artifact-ui";
import {
  filterBenchMemberships,
  listWorkbenchTenantIds,
} from "@corbits/bench-ui";
import { reportError } from "@corbits/error-sink";
import { useQuery } from "@tanstack/react-query";
import {
  buildCommandPaletteGroups,
  buildStaticCommands,
  detailPath,
  isBareScopeQuery,
  parsePaletteQuery,
  useEntitySearch,
  type PaletteResultItem,
  type PaletteSource,
  type RecentEntry,
} from "@corbits/command-palette";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { listAgentDefinitions } from "./agents-api";
import {
  ACTION_COMMANDS,
  runActionCommand,
  type ActionCommandId,
} from "./command-palette-actions";
import {
  openCommandPalette,
  setCommandPaletteOpen,
  setCommandPaletteQuery,
  useCommandPaletteOpen,
  useCommandPaletteQuery,
} from "./command-palette-open-store";
import { WORKBENCH_NOT_FOUND_EVENT } from "./workbench-not-found-event";
import { recentsStoreForBench } from "./command-palette-recents";
import { NAV_ROUTES } from "./routes";
import { ArtifactListPageSchema, useAPIQuery } from "./api";
import { useBench } from "./bench-context";
import { useCloseCanvas } from "./shell/canvas-availability";
import { listMcpServers } from "@corbits/plugins-ui";
import {
  AGENTS_PATH_PREFIX,
  PLUGINS_PATH_PREFIX,
  SKILLS_PATH_PREFIX,
} from "./path-ids";
import {
  listScheduledWorkflows,
  runScheduledWorkflowNow,
  useTenantQuery,
} from "./routines-api";
import { listSkills } from "./skills-api";
import { meKeys, tenantKeys } from "./query-client";
import type { Navigate } from "./navigation";

const STATIC_COMMANDS = buildStaticCommands(
  NAV_ROUTES.map((route) => ({ path: route.path, label: route.label })),
);

/**
 * Wires the data-driven react-ui command palette into the app shell, and
 * renders it — the global surface `Cmd+K` (and a context-menu item) opens,
 * as its own modal dialog (`CommandPalette`), never anchored to the stage
 * top bar's per-page filter magnifier. Mounted once in `app.tsx`'s `Shell`,
 * above `AppShell`, so it works from every route — including one that
 * matches no page and renders no stage top bar of its own.
 *
 * Grouping, `#`/`@`/`>`/`/` scope parsing, and the Recents rule live in
 * `@corbits/command-palette` (`buildCommandPaletteGroups`) — this file only
 * assembles the app's own sources (routes, workbenches, agents, routines,
 * skills, library artifacts) and maps a selection back to a real route or
 * action. Entity results for workbenches/runs/agents still come off the same
 * `useEntitySearch` paging this provider already used; routines, skills and
 * library artifacts are small per-bench catalogs fetched once and filtered
 * client-side, the same way the static route list already is.
 */
export function CommandPaletteProvider({
  path,
  navigate,
  children,
}: {
  readonly path: string;
  readonly navigate: Navigate;
  readonly children: ReactNode;
}) {
  const { memberships, selectedTenantId, selectTenant } = useBench();
  const queryClient = useQueryClient();
  // Open state and query live in the shared store, not in this component:
  // Cmd+K and a context-menu item both open this surface from outside the
  // React tree (`command-palette-open-store`).
  const open = useCommandPaletteOpen();
  const query = useCommandPaletteQuery();
  const [recents, setRecents] = useState<readonly RecentEntry[]>([]);
  const { cycleMode } = useTheme();
  const closeCanvas = useCloseCanvas();

  const recentsStore = useMemo(
    () =>
      selectedTenantId === null ? null : recentsStoreForBench(selectedTenantId),
    [selectedTenantId],
  );

  useEffect(() => {
    setRecents(recentsStore?.load() ?? []);
  }, [recentsStore]);

  const pushRecent = useCallback(
    (entry: RecentEntry) => {
      if (recentsStore === null) return;
      setRecents(recentsStore.push(entry));
    },
    [recentsStore],
  );

  const removeRecent = useCallback(
    (entry: Pick<RecentEntry, "kind" | "id">) => {
      if (recentsStore === null) return;
      setRecents(recentsStore.remove(entry));
    },
    [recentsStore],
  );

  // A workbench-level 404 (`chat-page.tsx`, via `ChatWorkspace`'s
  // `onWorkbenchNotFound`) means a Recents entry outlived the workbench it
  // points at — drop it so re-opening the palette never offers a dead end
  // again. See `workbench-not-found-event.ts` for why this is an event
  // rather than a prop: the chat route and this provider are siblings.
  useEffect(() => {
    function onWorkbenchNotFound(event: Event) {
      const workbenchId = (event as CustomEvent<string>).detail;
      removeRecent({
        kind: "workbenches",
        id: `entity:workbenches:${workbenchId}`,
      });
    }
    window.addEventListener(WORKBENCH_NOT_FOUND_EVENT, onWorkbenchNotFound);
    return () => {
      window.removeEventListener(
        WORKBENCH_NOT_FOUND_EVENT,
        onWorkbenchNotFound,
      );
    };
  }, [removeRecent]);

  // Reads through `queryClient` at the shared `tenantKeys.workbenches` key
  // (rather than calling `listWorkbenches` directly) so a re-search — every
  // debounced keystroke re-invokes this — and the bare `#` scope view below
  // both reuse one cached fetch with every other workbench-listing surface in
  // the shell, instead of each one issuing its own request.
  const listWorkbenchesForSearch = useCallback(async () => {
    if (selectedTenantId === null) return [];
    const result = await queryClient.ensureQueryData({
      queryKey: tenantKeys.workbenches(selectedTenantId, "workbench"),
      queryFn: () => listWorkbenches(selectedTenantId, "workbench"),
    });
    return result.map((workbench) => ({
      id: workbench.id,
      name: workbench.title,
    }));
  }, [selectedTenantId, queryClient]);

  // `useEntitySearch` carries an id and a title per result and nothing else,
  // but `/agents/<slug>` needs the definition's own minted handle — which is
  // exactly what the fetch just read. Recorded here as the list arrives so a
  // selection resolves the real slug instead of guessing one back out of a
  // display title.
  const agentHandleById = useRef(new Map<string, string>());

  const listAgentsForSearch = useCallback(async () => {
    if (selectedTenantId === null) return [];
    const definitions = await listAgentDefinitions(selectedTenantId);
    for (const definition of definitions) {
      agentHandleById.current.set(definition.id, definition.name);
    }
    return definitions.map((definition) => ({
      id: definition.id,
      name: definition.name,
    }));
  }, [selectedTenantId]);

  const entitySearchSources = useMemo(
    () => [
      { category: "workbenches", fetch: listWorkbenchesForSearch },
      { category: "agents", fetch: listAgentsForSearch },
    ],
    [listWorkbenchesForSearch, listAgentsForSearch],
  );

  const strippedQuery = useMemo(() => parsePaletteQuery(query).query, [query]);
  const bareScopeKind = useMemo(() => {
    if (!isBareScopeQuery(query)) return null;
    return parsePaletteQuery(query).scope?.kind ?? null;
  }, [query]);

  const { results, loading, error, hasMore, loadMore } = useEntitySearch({
    query: strippedQuery,
    enabled: open,
    sources: entitySearchSources,
  });

  // A bare `#` or `@` strips to an empty query, which useEntitySearch never
  // fetches for (by design — the unscoped default view should not dump
  // every entity on open). The mock shows every item in an active scope for
  // this input, so fetch that scope's raw list directly instead.
  const [bareWorkbenches, setBareWorkbenches] = useState<
    readonly PaletteResultItem[]
  >([]);
  const [bareAgents, setBareAgents] = useState<readonly PaletteResultItem[]>(
    [],
  );

  useEffect(() => {
    if (bareScopeKind !== "workbenches" || !open) {
      setBareWorkbenches([]);
      return;
    }
    let cancelled = false;
    void listWorkbenchesForSearch().then((rows) => {
      if (cancelled) return;
      setBareWorkbenches(
        rows.map((row) => ({
          id: `entity:workbenches:${row.id}`,
          title: row.name,
        })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [bareScopeKind, open, listWorkbenchesForSearch]);

  useEffect(() => {
    if (bareScopeKind !== "people" || !open) {
      setBareAgents([]);
      return;
    }
    let cancelled = false;
    void listAgentsForSearch().then((rows) => {
      if (cancelled) return;
      setBareAgents(
        rows.map((row) => ({
          id: `entity:agents:${row.id}`,
          title: row.name,
          subtitle: "Agent",
        })),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [bareScopeKind, open, listAgentsForSearch]);

  const routinesQuery = useTenantQuery(
    tenantKeys.routines(selectedTenantId ?? ""),
    open && selectedTenantId !== null,
    () => listScheduledWorkflows(selectedTenantId ?? ""),
  );
  const skillsQuery = useTenantQuery(
    tenantKeys.skills(selectedTenantId ?? ""),
    open && selectedTenantId !== null,
    () => listSkills(selectedTenantId ?? ""),
  );
  // Connected MCP servers for this bench. Until CL-6417 lands a real
  // `/plugins/<slug>` page, selecting one opens the Plugins gallery
  // (CL-6817) rather than a "still being built" stub.
  const mcpServersQuery = useTenantQuery(
    tenantKeys.mcpServers(selectedTenantId ?? ""),
    open && selectedTenantId !== null,
    () => listMcpServers(selectedTenantId ?? ""),
  );
  const artifactsQuery = useAPIQuery(
    selectedTenantId === null || !open
      ? ""
      : `/api/tenants/${selectedTenantId}/artifacts`,
    ArtifactListPageSchema,
  );

  // CL-6089's hidden escape hatch: the sidebar dropped its bench switcher
  // (a workbench IS a conversation now, one per account in the common
  // case), but a multi-bench install still needs a way in. Plainly
  // labeled, cycling to the next workbench in membership order — the
  // simplest honest thing a single command-palette entry can do without
  // reinventing a picker. Absent entirely for the common one-workbench
  // account, same principle the old dock used to hide itself by.
  const workbenchMembershipTenantIds =
    memberships.kind === "ready"
      ? memberships.data.data.map((membership) => membership.tenantId)
      : [];
  const workbenchTenancyKinds = useQuery({
    queryKey: meKeys.workbenchTenancyKinds(workbenchMembershipTenantIds),
    queryFn: () => listWorkbenchTenantIds(workbenchMembershipTenantIds),
    enabled: workbenchMembershipTenantIds.length > 0,
  });
  const workbenchMemberships =
    memberships.kind === "ready"
      ? filterBenchMemberships(
          memberships.data.data,
          workbenchTenancyKinds.data ?? new Set(),
        )
      : [];
  const nextWorkbench =
    workbenchMemberships.length > 1
      ? workbenchMemberships[
          (workbenchMemberships.findIndex(
            (membership) => membership.tenantId === selectedTenantId,
          ) +
            1) %
            workbenchMemberships.length
        ]
      : undefined;

  // cmd+K opens; it cannot also close, because react-ui's shortcut yields to
  // text fields and an open palette holds focus in its own input. Escape and
  // the overlay are the ways back out.
  useCommandShortcut(openCommandPalette);

  // Search is scoped to where it was opened from. A route change (including
  // browser Back out of a result) closes it, so the overlay never stands over
  // content it was not opened from; a bench switch closes it too, dropping a
  // query whose results belonged to the bench being left. A tenant resolving
  // for the first time (null → a real bench, at boot) is not a switch.
  const searchScope = useRef({ path, tenantId: selectedTenantId });
  useEffect(() => {
    const previous = searchScope.current;
    const routeChanged = previous.path !== path;
    const benchSwitched =
      previous.tenantId !== null && previous.tenantId !== selectedTenantId;
    searchScope.current = { path, tenantId: selectedTenantId };
    if (routeChanged || benchSwitched) setCommandPaletteOpen(false);
  }, [path, selectedTenantId]);

  const pageItems = useMemo<readonly PaletteResultItem[]>(
    () =>
      STATIC_COMMANDS.map((command) => ({
        id: command.id,
        title: command.title,
      })),
    [],
  );

  const actionItems = useMemo<readonly PaletteResultItem[]>(() => {
    const commands = ACTION_COMMANDS.map((command) => ({
      id: `action:${command.id}`,
      title: command.title,
      subtitle: command.subtitle,
    }));
    const runNow =
      routinesQuery.kind === "ready"
        ? routinesQuery.data.map((routine) => ({
            id: `action:run-routine:${routine.definitionId}`,
            title: `Run · ${routine.name}`,
            subtitle: "Run this routine now",
          }))
        : [];
    const switchWorkbench =
      nextWorkbench !== undefined
        ? [
            {
              id: "action:switch-workbench",
              title: "Switch workbench",
              subtitle: `Next: ${nextWorkbench.tenantName}`,
            },
          ]
        : [];
    return [...commands, ...runNow, ...switchWorkbench];
  }, [routinesQuery, nextWorkbench]);

  const workbenchItems = useMemo<readonly PaletteResultItem[]>(() => {
    if (bareScopeKind === "workbenches") return bareWorkbenches;
    return results
      .filter((result) => result.category === "workbenches")
      .map((workbench) => ({
        id: `entity:workbenches:${workbench.id}`,
        title: workbench.title,
      }));
  }, [results, bareScopeKind, bareWorkbenches]);

  const agentItems = useMemo<readonly PaletteResultItem[]>(() => {
    if (bareScopeKind === "people") return bareAgents;
    return results
      .filter((result) => result.category === "agents")
      .map((agent) => ({
        id: `entity:agents:${agent.id}`,
        title: agent.title,
        subtitle: "Agent",
      }));
  }, [results, bareScopeKind, bareAgents]);

  const routineItems = useMemo<readonly PaletteResultItem[]>(
    () =>
      routinesQuery.kind === "ready"
        ? routinesQuery.data.map((routine) => ({
            id: `entity:routines:${routine.definitionId}`,
            title: routine.name,
            subtitle: "Scheduled workflow",
          }))
        : [],
    [routinesQuery],
  );

  const skillItems = useMemo<readonly PaletteResultItem[]>(
    () =>
      skillsQuery.kind === "ready"
        ? skillsQuery.data.map((skill) => ({
            id: `entity:skills:${skill.name}`,
            title: skill.name,
            subtitle: skill.description,
          }))
        : [],
    [skillsQuery],
  );

  const pluginItems = useMemo<readonly PaletteResultItem[]>(
    () =>
      mcpServersQuery.kind === "ready"
        ? mcpServersQuery.data.map((server) => ({
            id: `entity:plugins:${server.slug}`,
            title: server.name,
            subtitle: "Connected plugin",
          }))
        : [],
    [mcpServersQuery],
  );

  const libraryItems = useMemo<readonly PaletteResultItem[]>(
    () =>
      artifactsQuery.kind === "ready"
        ? artifactsQuery.data.data.map((artifact) => ({
            id: `entity:library:${artifact.id}`,
            title: artifact.title,
            subtitle: artifactKindLabel(artifact.kind),
          }))
        : [],
    [artifactsQuery],
  );

  // Order matches the mock's buildCmdkEntries: Commands, Agents &
  // Channels, Pages, then the unscoped catalogs (Runs, Routines,
  // Skills, Library), with People & agents last among the palette's
  // groups.
  const sources = useMemo<readonly PaletteSource[]>(
    () => [
      {
        id: "actions",
        heading: "Commands",
        kind: "actions",
        items: actionItems,
      },
      {
        id: "workbenches",
        heading: "Agents & Channels",
        kind: "workbenches",
        items: workbenchItems,
      },
      { id: "pages", heading: "Pages", kind: "pages", items: pageItems },
      { id: "routines", heading: "Routines", items: routineItems },
      { id: "skills", heading: "Skills", items: skillItems },
      { id: "plugins", heading: "Plugins", items: pluginItems },
      { id: "library", heading: "Files", items: libraryItems },
      {
        id: "people",
        heading: "People & agents",
        kind: "people",
        items: agentItems,
      },
    ],
    [
      actionItems,
      workbenchItems,
      pageItems,
      routineItems,
      skillItems,
      pluginItems,
      libraryItems,
      agentItems,
    ],
  );

  const recentItems = useMemo<readonly PaletteResultItem[]>(
    () =>
      recents.map((entry) =>
        entry.subtitle === undefined
          ? { id: entry.id, title: entry.title }
          : { id: entry.id, title: entry.title, subtitle: entry.subtitle },
      ),
    [recents],
  );

  const groups = useMemo<readonly CommandPaletteGroup[]>(() => {
    const built = buildCommandPaletteGroups({
      query,
      recents: recentItems,
      sources,
    });
    return built.map((group) => ({
      id: group.id,
      heading: group.heading,
      items: group.items,
    }));
  }, [query, recentItems, sources]);

  const handleSelect = useCallback(
    (id: string) => {
      if (id === "action:switch-workbench") {
        if (nextWorkbench !== undefined) selectTenant(nextWorkbench.tenantId);
      } else if (id.startsWith("action:run-routine:")) {
        const routineId = id.slice("action:run-routine:".length);
        if (selectedTenantId !== null) {
          void (async () => {
            try {
              await runScheduledWorkflowNow(selectedTenantId, routineId);
            } catch (cause) {
              reportError(cause, {
                operation: "scheduled_workflow_run_now",
                tenantId: selectedTenantId,
              });
            }
          })();
        }
        navigate(`/routines/${encodeURIComponent(routineId)}`);
      } else if (id.startsWith("action:")) {
        void runActionCommand(id.slice("action:".length) as ActionCommandId, {
          path,
          navigate,
          tenantId: selectedTenantId,
          cycleTheme: cycleMode,
          closeCanvas,
        });
      } else if (id.startsWith("route:")) {
        const routePath = id.slice("route:".length);
        const label =
          STATIC_COMMANDS.find((command) => command.id === id)?.title ??
          routePath;
        navigate(routePath);
        pushRecent({ kind: "route", id, title: label });
      } else if (id.startsWith("entity:workbenches:")) {
        const workbenchId = id.slice("entity:workbenches:".length);
        const title =
          workbenchItems.find((item) => item.id === id)?.title ?? workbenchId;
        navigate(`/w/${workbenchId}`);
        pushRecent({ kind: "workbenches", id, title, subtitle: "Workbench" });
      } else if (id.startsWith("entity:agents:")) {
        const agentId = id.slice("entity:agents:".length);
        const title =
          agentItems.find((item) => item.id === id)?.title ?? agentId;
        navigate(
          detailPath(AGENTS_PATH_PREFIX, {
            slug: agentHandleById.current.get(agentId) ?? "",
            id: agentId,
          }),
        );
        pushRecent({ kind: "agents", id, title, subtitle: "Agent" });
      } else if (id.startsWith("entity:routines:")) {
        const routineId = id.slice("entity:routines:".length);
        const title =
          routineItems.find((item) => item.id === id)?.title ?? routineId;
        navigate(`/routines/${encodeURIComponent(routineId)}`);
        pushRecent({ kind: "routines", id, title, subtitle: "Routine" });
      } else if (id.startsWith("entity:skills:")) {
        const skillId = id.slice("entity:skills:".length);
        const title =
          skillItems.find((item) => item.id === id)?.title ?? skillId;
        // A skill's name is its slug: the Skills API keys every route on it.
        navigate(
          detailPath(SKILLS_PATH_PREFIX, { slug: skillId, id: skillId }),
        );
        pushRecent({ kind: "skills", id, title, subtitle: "Skill" });
      } else if (id.startsWith("entity:plugins:")) {
        const slug = id.slice("entity:plugins:".length);
        const title = pluginItems.find((item) => item.id === id)?.title ?? slug;
        // No plugin detail page yet (CL-6417 parked). Land on the gallery
        // instead of the removed stub (CL-6817).
        navigate(PLUGINS_PATH_PREFIX);
        pushRecent({ kind: "plugins", id, title, subtitle: "Plugin" });
      } else if (id.startsWith("entity:library:")) {
        const artifactId = id.slice("entity:library:".length);
        const title =
          libraryItems.find((item) => item.id === id)?.title ?? "Files";
        navigate(libraryArtifactPath(artifactId));
        pushRecent({ kind: "library", id, title, subtitle: "Files" });
      }
      setCommandPaletteOpen(false);
    },
    [
      navigate,
      path,
      selectedTenantId,
      cycleMode,
      closeCanvas,
      pushRecent,
      workbenchItems,
      agentItems,
      routineItems,
      skillItems,
      pluginItems,
      libraryItems,
      nextWorkbench,
      selectTenant,
    ],
  );

  return (
    <>
      {children}
      <CommandPalette
        open={open}
        onOpenChange={setCommandPaletteOpen}
        query={query}
        onQueryChange={setCommandPaletteQuery}
        groups={groups}
        onSelect={handleSelect}
        loading={loading}
        {...(error ? { error: "Search failed. Try again." } : {})}
        hasMore={hasMore}
        onLoadMore={loadMore}
        placeholder="Search or jump to…"
        footer="# workbenches · @ people · > actions · / pages"
      />
    </>
  );
}
