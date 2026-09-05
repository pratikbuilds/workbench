// `/routines/<definitionId>` — a scheduled definition's own page: name,
// cron sentence, pause, run now. The id is the definition id.
import { Button, PageShell, RunNowButton } from "@corbits/react-ui";
import type { ReactNode } from "react";

import { useGlobalRoutines, useRoutineActions } from "../global-routines";
import type { GlobalRoutineRow } from "../global-routines";
import { Link } from "../navigation";
import { ROUTINES_PATH_PREFIX } from "../path-ids";
import { StageTopBar } from "../shell/stage-top-bar";
import { scheduleSentence } from "./routines-page";

function RoutineNotice({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[
          { label: "Routines", href: ROUTINES_PATH_PREFIX },
          { label: title },
        ]}
      />
      <PageShell>
        <p className="m-0 text-sm text-[var(--ui-fg-muted)]">{description}</p>
        {children ?? (
          <p className="mt-4">
            <Link to={ROUTINES_PATH_PREFIX}>Back to Routines</Link>
          </p>
        )}
      </PageShell>
    </div>
  );
}

export function RoutineDetailPage({
  row,
  onToggleEnabled,
  onRunNow,
}: {
  readonly row: GlobalRoutineRow;
  readonly onToggleEnabled: (enabled: boolean) => void;
  readonly onRunNow: () => Promise<void>;
}) {
  const enabled = row.definition.status === "deployed";
  const sentence = scheduleSentence(row.definition.cron);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[
          { label: "Routines", href: ROUTINES_PATH_PREFIX },
          { label: row.definition.name },
        ]}
        subtitle={sentence}
        actions={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onToggleEnabled(!enabled)}
            >
              {enabled ? "Pause" : "Resume"}
            </Button>
            <RunNowButton variant="outline" size="sm" onRun={onRunNow} />
          </div>
        }
      />
      <PageShell>
        <h1 className="m-0 text-xl font-semibold">{row.definition.name}</h1>
        <p className="mt-2 text-sm text-[var(--ui-fg-muted)]">
          {row.tenantName}
        </p>
        <p className="mt-4 text-lg">{sentence}</p>
      </PageShell>
    </div>
  );
}

export function resolveRoutineSegment(
  rows: readonly GlobalRoutineRow[],
  segment: string,
): GlobalRoutineRow | undefined {
  return rows.find((row) => row.definition.definitionId === segment);
}

export function RoutineDetailRoute({ segment }: { readonly segment: string }) {
  const routinesQuery = useGlobalRoutines();
  const actions = useRoutineActions();
  const rows = routinesQuery.kind === "ready" ? routinesQuery.data : [];
  const resolved =
    routinesQuery.kind === "ready"
      ? resolveRoutineSegment(rows, segment)
      : undefined;

  if (routinesQuery.kind === "loading") {
    return <RoutineNotice title="Routine" description="Loading…" />;
  }
  if (routinesQuery.kind === "error") {
    return (
      <RoutineNotice title={segment} description={routinesQuery.message} />
    );
  }
  if (resolved === undefined) {
    return (
      <RoutineNotice
        title={segment}
        description="No scheduled workflow matches this address."
      />
    );
  }

  return (
    <RoutineDetailPage
      row={resolved}
      onToggleEnabled={(enabled) => {
        void actions.setEnabled(resolved, enabled);
      }}
      onRunNow={() => actions.runNow(resolved)}
    />
  );
}
