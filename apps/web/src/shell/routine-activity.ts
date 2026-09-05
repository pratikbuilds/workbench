// The second column's "Running" section and Mission Control's active-run
// count (CL-6595) both depend only on `RoutineActivityItem` and
// `listRoutineActivity`, never on where the data actually comes from.
// Filled from `./agents-api.ts`'s `listRoutineRunFires` — the `feed=fires`
// listing, the one top-level-runs view that keeps a routine's fire despite
// it being a folded run (see that function's own comment). The plain
// `listTopLevelRuns` feed looks tempting here but is wrong: its
// `notExists(folded_run)` filter drops every routine fire by construction,
// so a routine genuinely running would never show up in this band or count
// toward Mission Control's "Active runs" — exactly CL-6595's desync
// between the Routines page's own "Running now" pill and Mission Control's
// "0 / nothing running".
import {
  runOutcomeStatus,
  withListingAbandoned,
} from "@corbits/workflows/client";
import type { ListingTurn } from "@corbits/workflows/client";

import { listRoutineRunFires } from "../agents-api";
import type { RunFire } from "../agents-api";

export type RoutineActivityItem = {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly startedAt: string;
  readonly endedAt?: string | null;
  readonly hasInFlightTurn?: boolean;
  readonly turns?: readonly ListingTurn[];
};

function toRoutineActivityItem(run: RunFire, now: number): RoutineActivityItem {
  const listing = withListingAbandoned(
    {
      createdAt: run.createdAt,
      status: run.status,
      ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
      ...(run.hasInFlightTurn !== undefined
        ? { hasInFlightTurn: run.hasInFlightTurn }
        : {}),
      ...(run.turns !== undefined ? { turns: run.turns } : {}),
    },
    now,
  );
  return {
    id: run.id,
    name: run.routineName ?? run.definitionName,
    status: runOutcomeStatus(listing, now) ?? run.status,
    startedAt: run.createdAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(run.hasInFlightTurn !== undefined
      ? { hasInFlightTurn: run.hasInFlightTurn }
      : {}),
    ...(run.turns !== undefined ? { turns: run.turns } : {}),
  };
}

export function listRoutineActivity(
  tenantId: string,
  now: number = Date.now(),
): Promise<readonly RoutineActivityItem[]> {
  return listRoutineRunFires(tenantId).then((runs) =>
    runs
      .filter((run) => run.routineId !== null)
      .map((run) => toRoutineActivityItem(run, now)),
  );
}
