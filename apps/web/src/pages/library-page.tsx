import {
  BulkActionBar,
  Button,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  PageShell,
  RichEmptyState,
  SelectionCheckbox,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ViewToggle,
  artifactKindLabel,
  formatRelativeTime,
  toast,
  useListSelection,
} from "@corbits/react-ui";
import type {
  SelectionCheckboxState,
  UseListSelectionResult,
  ViewMode,
} from "@corbits/react-ui";
import {
  ArtifactCard,
  ArtifactRenderer,
  artifactMatchesLibraryKindSegment,
  filterArtifacts,
  isTextDecodableMediaType,
  libraryArtifactIdFromPath,
  libraryKindSegmentFromPath,
  resolveArtifactRendererKind,
  sortArtifacts,
  workflowRunIdFromSource,
} from "@corbits/artifact-ui";
import type { ArtifactSort, ArtifactSummary } from "@corbits/artifact-ui";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowsDownUp,
  ArrowSquareOut,
  LinkSimple as LinkIcon,
  Stack,
  X,
} from "@corbits/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  describeApiError,
  ListSkeleton,
  QueryView,
  SignedOutNotice,
} from "@corbits/api-query";

import {
  artifactPreviewPath,
  ArtifactDetailSchema,
  ArtifactListPageSchema,
  useAPIQuery,
  type ArtifactDetail,
} from "../api";
import { isAdditiveSelectClick, isRowActivationKey } from "../activatable-row";
import { useBench } from "../bench-context";
import { readLastWorkbenchId } from "../last-workbench";
import {
  consumePendingLibraryUpload,
  LIBRARY_UPLOAD_EVENT,
} from "../library-upload";
import { resolveLibraryWorkbenchScope } from "../library-workbench-scope";
import { Link } from "../navigation";
import { FILES_PATH_PREFIX } from "../path-ids";
import { tenantKeys } from "../query-client";
import { useBenchActivity } from "../shell/bench-activity";
import {
  artifactUploadToast,
  copyArtifactLinks,
  copyArtifactLinksActionLabel,
  copyArtifactLinksToastLabel,
  isArtifactsUnavailableStatus,
  LIBRARY_BULK_OPERATION_IDS,
  mapArtifactListToSummaries,
  uploadArtifactFiles,
  uploadMimeTypeFromSource,
} from "../shell/library-artifacts";
import { StageTopBar } from "../shell/stage-top-bar";

const SORT_LABEL: Record<ArtifactSort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
};

function ArtifactRows({
  artifacts,
  now,
  selectedId,
  onSelect,
  selection,
}: {
  readonly artifacts: readonly ArtifactSummary[];
  readonly now: number | undefined;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly selection: UseListSelectionResult<string>;
}) {
  const allSelected =
    artifacts.length > 0 && selection.selectedCount === artifacts.length;
  const headerChecked: SelectionCheckboxState =
    selection.selectedCount === 0
      ? false
      : allSelected
        ? true
        : "indeterminate";
  // `useListSelection` hands back ids in toggle/insertion order, not row
  // order — a bottom-up shift-select would otherwise join/copy links out of
  // visible order. Sort against this row order before handing ids to any
  // bulk operation (copy links here, the context menu's `ids` below).
  const visibleOrder = useMemo(
    () => new Map(artifacts.map((artifact, index) => [artifact.id, index])),
    [artifacts],
  );

  return (
    <Table aria-label="Files">
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">
            <SelectionCheckbox
              checked={headerChecked}
              onToggle={() =>
                allSelected ? selection.clear() : selection.selectAll()
              }
              rowLabel="all files"
              ariaLabel="Select all files"
              className="opacity-100"
            />
          </TableHead>
          <TableHead>Title</TableHead>
          <TableHead>Kind</TableHead>
          <TableHead>Owner</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {artifacts.map((artifact) => {
          const isSelected = selection.isSelected(artifact.id);
          const selectionIds =
            isSelected && selection.selectedCount > 1
              ? [...selection.selectedIds].sort(
                  (a, b) =>
                    (visibleOrder.get(a) ?? 0) - (visibleOrder.get(b) ?? 0),
                )
              : [artifact.id];
          return (
            <TableRow
              key={artifact.id}
              data-state={selectedId === artifact.id ? "selected" : undefined}
              data-ctx-artifact={artifact.id}
              data-ctx-artifact-selected-ids={selectionIds.join(",")}
              className="group cursor-pointer"
              role="button"
              tabIndex={0}
              onClick={(event: ReactMouseEvent) => {
                if (event.shiftKey || isAdditiveSelectClick(event)) {
                  selection.toggle(artifact.id, { shiftKey: event.shiftKey });
                  return;
                }
                onSelect(artifact.id);
              }}
              onKeyDown={(event) => {
                if (!isRowActivationKey(event.key)) return;
                event.preventDefault();
                onSelect(artifact.id);
              }}
            >
              <TableCell onClick={(event) => event.stopPropagation()}>
                <SelectionCheckbox
                  checked={isSelected}
                  onToggle={(modifiers) =>
                    selection.toggle(artifact.id, modifiers)
                  }
                  rowLabel={artifact.title}
                />
              </TableCell>
              <TableCell className="font-medium">{artifact.title}</TableCell>
              <TableCell className="text-muted-foreground">
                {artifactKindLabel(artifact.kind)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {artifact.ownerName ?? "—"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatRelativeTime(
                  artifact.updatedAt ?? artifact.createdAt,
                  now,
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * The one cheap provenance fact worth surfacing (CL-6015): a link to the
 * workflow run that produced this artifact, when `source` says so
 * (`workflowRunIdFromSource`). Not a lineage system — every other origin
 * (manual, agent, imported, unknown) renders nothing here rather than
 * guessing.
 */
function ProvenanceLine({
  source,
}: {
  readonly source: Record<string, unknown>;
}) {
  const runId = workflowRunIdFromSource(source);
  if (runId === null) return null;
  return (
    <p className="mt-0.5 truncate text-xs">
      <Link
        to={`/insights/runs/${encodeURIComponent(runId)}`}
        className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Produced by workflow run
      </Link>
    </p>
  );
}

function PreviewPane({
  tenantId,
  detail,
  loading,
  error,
  onClose,
}: {
  readonly tenantId: string | null;
  readonly detail: ArtifactDetail | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly onClose: () => void;
}) {
  const rendererKind =
    detail !== null ? resolveArtifactRendererKind(detail) : null;
  const previewSrc =
    detail !== null && rendererKind === "html" && tenantId !== null
      ? artifactPreviewPath(tenantId, detail.id)
      : undefined;
  // Empty `content` on a file artifact is ambiguous on its own: it's the
  // honest "nothing here" for an inline-content artifact, but it's also
  // what a real upload's row carries when its bytes live out-of-band and
  // aren't text-decodable (an image, a real PDF, a legacy `.docx`/`.xlsx`).
  // `source.upload.mimeType` disambiguates — present only when this
  // artifact really does have stored bytes behind it.
  const uploadMimeType =
    detail !== null ? uploadMimeTypeFromSource(detail.source) : null;
  const contentUnavailable =
    detail !== null &&
    detail.content === "" &&
    uploadMimeType !== null &&
    !isTextDecodableMediaType(uploadMimeType);
  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {detail?.title ?? "Preview"}
          </p>
          {detail !== null ? (
            <p className="truncate text-xs text-muted-foreground">
              {artifactKindLabel(detail.kind)}
              {detail.ownerName !== null ? ` · ${detail.ownerName}` : ""}
              {` · Version ${detail.version}`}
            </p>
          ) : null}
          {detail !== null ? <ProvenanceLine source={detail.source} /> : null}
        </div>
        <div className="flex items-center gap-1">
          {previewSrc !== undefined ? (
            <Button variant="ghost" size="sm" asChild>
              <a href={previewSrc} target="_blank" rel="noreferrer">
                <ArrowSquareOut aria-hidden="true" />
                Open in new tab
              </a>
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label="Close preview"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {loading ? <Skeleton className="h-40 w-full" /> : null}
        {error !== null ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {!loading &&
        error === null &&
        detail !== null &&
        rendererKind !== null ? (
          <ArtifactRenderer
            rendererKind={rendererKind}
            title={detail.title}
            content={detail.content}
            contentUnavailable={contentUnavailable}
            {...(previewSrc !== undefined ? { previewSrc } : {})}
          />
        ) : null}
      </div>
    </aside>
  );
}

/**
 * The Files stage: a row list of everything this workbench owns, with an
 * in-stage preview when a row is selected. Real data only.
 *
 * Every control the page owns — the workbench lens, the name filter, sort,
 * the rows/grid toggle, Upload — lives in `StageTopBar`'s action slot
 * (DESIGN.md → Pages & Routing: the top nav owns the page's actions, and a
 * page body never floats its own). The name filter drives the stage top
 * bar's own magnifier (`filter` prop) rather than a second input — the
 * magnifier IS this page's filter, never the global palette (DECISIONS.md
 * → Search).
 */
export function LibraryPage({
  artifacts,
  now,
  onUpload,
  uploading,
  uploadError,
  query,
  onQueryChange,
  selectedId = null,
  onSelect,
  preview = null,
  previewLoading = false,
  previewError = null,
  tenantId = null,
  workbenchScope = null,
  scope = "all",
  onScopeChange,
}: {
  readonly artifacts: readonly ArtifactSummary[];
  readonly now?: number;
  readonly onUpload?: (files: readonly File[]) => void;
  readonly uploading?: boolean;
  readonly uploadError?: string | null;
  readonly query?: string;
  readonly onQueryChange?: (value: string) => void;
  readonly selectedId?: string | null;
  readonly onSelect?: (id: string | null) => void;
  readonly preview?: ArtifactDetail | null;
  readonly previewLoading?: boolean;
  readonly previewError?: string | null;
  /** Needed to build the HTML preview route's URL (CL-5879); the "Open in
   * new tab" / iframe affordance is simply absent without one (a
   * standalone render with no bench tenant, e.g. these page tests). */
  readonly tenantId?: string | null;
  /** The workbench the person just came from (CL-6353), if any — drives the
   * "This workbench" pill. `null` when Files was reached with no workbench
   * in view, in which case the lens has nothing to offer and stays hidden. */
  readonly workbenchScope?: { readonly title: string } | null;
  /** Which lens is active: this one workbench's files, or every workbench
   * this bench owns. Uncontrolled callers (tests, standalone renders) get
   * "all" and no toggle, same as every other optional-controlled prop here. */
  readonly scope?: "workbench" | "all";
  readonly onScopeChange?: (scope: "workbench" | "all") => void;
}) {
  const [localQuery, setLocalQuery] = useState("");
  const [sort, setSort] = useState<ArtifactSort>("newest");
  const [viewMode, setViewMode] = useState<ViewMode>("rows");
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeQuery = query ?? localQuery;
  const setActiveQuery = onQueryChange ?? setLocalQuery;
  const activeSelected = onSelect !== undefined ? selectedId : localSelected;
  const select = onSelect ?? setLocalSelected;

  const visible = useMemo(
    () =>
      sortArtifacts(
        onQueryChange === undefined
          ? filterArtifacts(artifacts, activeQuery)
          : artifacts,
        sort,
      ),
    [artifacts, activeQuery, sort, onQueryChange],
  );

  const visibleIds = useMemo(
    () => visible.map((artifact) => artifact.id),
    [visible],
  );
  // A row filtered out of `visibleIds` drops out of `selection.selectedIds`
  // immediately (the hook reconciles against `ids` on every read) but
  // `useListSelection` keeps it in its own internal state, so the row comes
  // back selected if the filter that hid it is cleared. Deliberate: it
  // matches Finder/Sheets ("clearing a filter doesn't lose your picks") and
  // needs no bookkeeping here.
  const selection = useListSelection({ ids: visibleIds });

  // Rows and cards render selection differently — only rows has checkboxes
  // — so a selection made in one view has nothing to anchor to in the
  // other. Clearing on view change is simpler than teaching the card view
  // its own checkboxes for a selection UI it doesn't otherwise need.
  useEffect(() => {
    selection.clear();
  }, [viewMode, selection.clear]);

  const openPicker = useCallback(() => {
    if (uploading === true) return;
    fileInputRef.current?.click();
  }, [uploading]);

  useEffect(() => {
    if (onUpload === undefined) return;
    // Off-route Upload navigates first and leaves a pending flag; open now.
    if (consumePendingLibraryUpload()) openPicker();
    window.addEventListener(LIBRARY_UPLOAD_EVENT, openPicker);
    return () => window.removeEventListener(LIBRARY_UPLOAD_EVENT, openPicker);
  }, [onUpload, openPicker]);

  const selectedSummary =
    activeSelected === null
      ? null
      : (artifacts.find((artifact) => artifact.id === activeSelected) ?? null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={
          selectedSummary === null
            ? [{ label: "Files" }]
            : [
                { label: "Files", href: FILES_PATH_PREFIX },
                { label: selectedSummary.title },
              ]
        }
        subtitle={
          selectedSummary === null
            ? // Empty Files already has a poster invitation — a "0 files"
              // count beside it is a second empty announcement (CL-6750).
              artifacts.length === 0
              ? undefined
              : `${artifacts.length} files`
            : artifactKindLabel(selectedSummary.kind)
        }
        filter={{
          label: "Filter files",
          placeholder: "Filter by name",
          value: activeQuery,
          onChange: setActiveQuery,
        }}
        actions={
          <>
            {selectedSummary !== null ? (
              // This clears the open file and returns to the list — an
              // action, not a filter. It used to say bare "All", which read
              // as a third option in the scope group right beside it ("All"
              // vs. "All workbenches"); this label can't be mistaken for
              // that.
              <Button variant="ghost" size="sm" onClick={() => select(null)}>
                Back to files
              </Button>
            ) : null}
            {workbenchScope !== null && onScopeChange !== undefined ? (
              // One control, two states — answers exactly one question
              // ("whose files"). At lg the bordered segmented group matches
              // `ViewToggle` in this bar; below lg that group is hidden and
              // the overflow menu in this same slot is the way to reach
              // All workbenches.
              <>
                <div
                  role="group"
                  aria-label="Files scope"
                  className="hidden items-center gap-0.5 rounded-md border border-border p-0.5 lg:flex"
                >
                  <Button
                    type="button"
                    size="sm"
                    variant={scope === "workbench" ? "outline" : "ghost"}
                    aria-pressed={scope === "workbench"}
                    onClick={() => onScopeChange("workbench")}
                  >
                    {workbenchScope.title}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={scope === "all" ? "outline" : "ghost"}
                    aria-pressed={scope === "all"}
                    onClick={() => onScopeChange("all")}
                  >
                    All workbenches
                  </Button>
                </div>
                <div className="lg:hidden">
                  <Menu>
                    <MenuTrigger asChild>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-label="Files scope"
                      >
                        {scope === "all"
                          ? "All workbenches"
                          : workbenchScope.title}
                      </Button>
                    </MenuTrigger>
                    <MenuContent align="end">
                      <MenuItem onSelect={() => onScopeChange("workbench")}>
                        {workbenchScope.title}
                      </MenuItem>
                      <MenuItem onSelect={() => onScopeChange("all")}>
                        All workbenches
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                </div>
              </>
            ) : null}
            <Menu>
              <MenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={SORT_LABEL[sort]}
                  title={SORT_LABEL[sort]}
                >
                  <ArrowsDownUp />
                </Button>
              </MenuTrigger>
              <MenuContent align="end">
                {(Object.keys(SORT_LABEL) as ArtifactSort[]).map((option) => (
                  <MenuItem key={option} onSelect={() => setSort(option)}>
                    {SORT_LABEL[option]}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
            <ViewToggle mode={viewMode} onChange={setViewMode} />
            {onUpload !== undefined ? (
              <Button
                size="sm"
                disabled={uploading === true}
                onClick={openPicker}
              >
                {uploading === true ? "Uploading…" : "Upload"}
              </Button>
            ) : null}
          </>
        }
      />
      {onUpload !== undefined ? (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const list = event.target.files;
            if (list !== null && list.length > 0) {
              onUpload(Array.from(list));
            }
            event.target.value = "";
          }}
        />
      ) : null}
      {uploadError !== undefined && uploadError !== null ? (
        <p className="px-4 pt-2 text-sm text-destructive sm:px-7" role="alert">
          {uploadError}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          <PageShell width="full" className="page-fill">
            {artifacts.length === 0 ? (
              <RichEmptyState
                icon={<Stack />}
                title="No files yet"
                description="Upload a file, or let your agents drop their work here — it lands the moment it exists."
              />
            ) : visible.length === 0 ? (
              <RichEmptyState
                icon={<Stack />}
                title="Nothing matches"
                description={`No file matches "${activeQuery}".`}
              />
            ) : viewMode === "rows" ? (
              <div className="px-4 pb-5 sm:px-7">
                <ArtifactRows
                  artifacts={visible}
                  now={now}
                  selectedId={activeSelected}
                  onSelect={(id) => select(id)}
                  selection={selection}
                />
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3 px-4 pb-5 sm:px-7">
                {visible.map((artifact) => (
                  <ArtifactCard
                    key={artifact.id}
                    artifact={artifact}
                    selected={activeSelected === artifact.id}
                    now={now}
                    onSelect={() => select(artifact.id)}
                    meta={{
                      snippet: null,
                    }}
                  />
                ))}
              </div>
            )}
          </PageShell>
        </div>
        {activeSelected !== null ? (
          <div className="hidden w-[min(28rem,40%)] shrink-0 md:flex md:flex-col">
            <PreviewPane
              tenantId={tenantId}
              detail={preview}
              loading={previewLoading}
              error={previewError}
              onClose={() => select(null)}
            />
          </div>
        ) : null}
      </div>
      <BulkActionBar count={selection.selectedCount} onClear={selection.clear}>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-bulk-action={LIBRARY_BULK_OPERATION_IDS[0]}
          onClick={() => {
            const ids = [...selection.selectedIds].sort(
              (a, b) => visibleIds.indexOf(a) - visibleIds.indexOf(b),
            );
            void copyArtifactLinks(ids).then(
              () => toast(copyArtifactLinksToastLabel(ids.length)),
              () => toast("Couldn't copy the link"),
            );
          }}
        >
          <LinkIcon aria-hidden="true" />
          {copyArtifactLinksActionLabel(selection.selectedCount)}
        </Button>
      </BulkActionBar>
    </div>
  );
}

export function LibraryRoute({ path }: { readonly path: string }) {
  const { selectedTenantId } = useBench();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // `/files/a/:id` (CL-6015) — a chat artifact chip's "Open in Files"
  // deep link, distinct from the kind-nav segments below. It only ever
  // sets the initial selection; the user's own clicks stay local state,
  // the same way kind-nav selection already worked before this route
  // existed.
  const deepLinkedArtifactId = libraryArtifactIdFromPath(path);
  const [selectedId, setSelectedId] = useState<string | null>(
    deepLinkedArtifactId,
  );
  useEffect(() => {
    if (deepLinkedArtifactId !== null) setSelectedId(deepLinkedArtifactId);
  }, [deepLinkedArtifactId]);
  const kindSegment =
    deepLinkedArtifactId === null ? libraryKindSegmentFromPath(path) : "";

  // Files' workbench-first lens (CL-6353): the workbench the person just
  // came from, if `last-workbench.ts` recorded one for this bench, resolved
  // to its own tenant via the same sidebar-backed activity listing every
  // other bench-scoped surface already fetches.
  const activity = useBenchActivity(selectedTenantId);
  const lastWorkbenchId =
    selectedTenantId === null ? null : readLastWorkbenchId(selectedTenantId);
  const workbenchScope =
    activity.kind === "ready"
      ? resolveLibraryWorkbenchScope(
          [...activity.workbenches, ...activity.chats],
          lastWorkbenchId,
        )
      : null;
  const [scopeOverride, setScopeOverride] = useState<
    "workbench" | "all" | null
  >(null);
  const scope =
    scopeOverride ?? (workbenchScope !== null ? "workbench" : "all");
  const scopeTenantId =
    scope === "workbench" && workbenchScope !== null
      ? workbenchScope.tenantId
      : selectedTenantId;

  const listPath =
    scopeTenantId === null
      ? ""
      : `/api/tenants/${scopeTenantId}/artifacts${
          searchQuery.trim() === ""
            ? ""
            : `?q=${encodeURIComponent(searchQuery.trim())}`
        }`;
  const page = useAPIQuery(listPath, ArtifactListPageSchema);

  const detailPath =
    scopeTenantId === null || selectedId === null
      ? ""
      : `/api/tenants/${scopeTenantId}/artifacts/${encodeURIComponent(selectedId)}`;
  const detail = useAPIQuery(detailPath, ArtifactDetailSchema);

  // Drop selection when the filtered list no longer contains the id.
  useEffect(() => {
    if (selectedId === null || page.kind !== "ready") return;
    const stillThere = mapArtifactListToSummaries(page.data.data)
      .filter((row) => artifactMatchesLibraryKindSegment(row, kindSegment))
      .some((row) => row.id === selectedId);
    if (!stillThere) setSelectedId(null);
  }, [page, selectedId, kindSegment]);

  if (selectedTenantId === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Files" }]} />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<Stack />}
            title="Select a workbench"
            description="Open a workbench to browse the files it owns."
          />
        </PageShell>
      </div>
    );
  }

  if (page.kind === "error" && isArtifactsUnavailableStatus(page.status)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Files" }]} />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<Stack />}
            title="Files not configured"
            description="Files isn't set up yet. Ask your workbench admin to finish setup."
          />
        </PageShell>
      </div>
    );
  }

  if (page.kind !== "ready") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Files" }]} />
        <PageShell width="full" className="page-fill">
          {page.kind === "loading" ? (
            <ListSkeleton />
          ) : page.kind === "unauthenticated" ? (
            <SignedOutNotice />
          ) : (
            <RichEmptyState
              icon={<Stack />}
              title="Couldn't load your files"
              description={describeApiError(
                { status: page.status },
                "loading your files",
              )}
            />
          )}
        </PageShell>
      </div>
    );
  }

  return (
    <QueryView query={page} label="your files" skeleton="rows">
      {(rows) => {
        const artifacts = mapArtifactListToSummaries(rows.data).filter((row) =>
          artifactMatchesLibraryKindSegment(row, kindSegment),
        );
        return (
          <LibraryPage
            artifacts={artifacts}
            tenantId={scopeTenantId}
            workbenchScope={workbenchScope}
            scope={scope}
            onScopeChange={setScopeOverride}
            uploading={uploading}
            uploadError={uploadError}
            query={searchQuery}
            onQueryChange={setSearchQuery}
            selectedId={selectedId}
            onSelect={setSelectedId}
            preview={detail.kind === "ready" ? detail.data : null}
            previewLoading={detail.kind === "loading" && selectedId !== null}
            previewError={
              detail.kind === "error" && selectedId !== null
                ? describeApiError(
                    { status: detail.status },
                    "loading this file",
                  )
                : null
            }
            onUpload={(files) => {
              void (async () => {
                setUploading(true);
                setUploadError(null);
                try {
                  const uploaded = await uploadArtifactFiles(
                    selectedTenantId,
                    files,
                  );
                  await queryClient.invalidateQueries({
                    queryKey: tenantKeys.artifacts(selectedTenantId),
                  });
                  // The confirmation names what the server actually stored
                  // (its own titles), never the local `File` picked — the
                  // two can differ (e.g. a collision rename), and a sibling
                  // fix for empty content read-back means this toast must
                  // only ever repeat the upload response, not assume it.
                  toast(
                    artifactUploadToast(
                      uploaded.map((artifact) => artifact.title),
                    ),
                  );
                } catch (err) {
                  setUploadError(
                    describeApiError(err, "uploading those files"),
                  );
                } finally {
                  setUploading(false);
                }
              })();
            }}
          />
        );
      }}
    </QueryView>
  );
}
