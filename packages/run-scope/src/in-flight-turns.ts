// In-flight inference turns for a batch of workflow runs. Listing
// surfaces (Insights `feed=fires`, routine run summaries) attach these
// so a live tool-loop older than the abandoned-fire window still reads
// as running, without adding a field to Interchange's WorkflowRunResponse.
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "@intx/db";
import { inferenceTurn } from "@intx/db/schema";

export type InFlightListingTurn = {
  readonly status: "running";
  readonly endedAt: null;
};

/**
 * Run ids in `runIds` that currently have at least one `inference_turn`
 * still `running`. Every requested id is present after the query — an
 * empty array means queried, none in flight, not "turns omitted". Empty
 * input is an empty map — no round trip.
 */
export async function listingTurnsByRunId(
  db: DB["db"],
  runIds: readonly string[],
): Promise<ReadonlyMap<string, readonly InFlightListingTurn[]>> {
  if (runIds.length === 0) return new Map();
  const byRun = new Map<string, InFlightListingTurn[]>();
  for (const id of runIds) byRun.set(id, []);
  const rows = await db
    .select({ runId: inferenceTurn.runId })
    .from(inferenceTurn)
    .where(
      and(
        inArray(inferenceTurn.runId, [...runIds]),
        eq(inferenceTurn.status, "running"),
      ),
    );
  const turn: InFlightListingTurn = { status: "running", endedAt: null };
  for (const row of rows) {
    const existing = byRun.get(row.runId);
    if (existing === undefined) byRun.set(row.runId, [turn]);
    else existing.push(turn);
  }
  return byRun;
}
