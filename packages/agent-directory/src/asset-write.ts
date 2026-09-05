// Same-asset definition edits are read-modify-write: two concurrent
// routes that snapshot the same workflow.json and then each write their
// own field would last-write-wins clobber the other (CL-7216). This
// module serializes those writers and retries the loser against the
// latest snapshot.
//
// The lock is an in-process promise chain keyed by asset id. Hub is a
// single replica, so that chain is the lock — not a Redis or Postgres
// advisory lock, and not safe across multiple hub replicas.

import type { AssetService } from "@intx/hub-sessions";

import { readAgentDefinitionWorkflowJson } from "./definition-asset";

const MAX_STALE_SNAPSHOT_RETRIES = 8;

const writeChains = new Map<string, Promise<void>>();

async function withAssetWriteLock<T>(
  assetId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = writeChains.get(assetId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeChains.set(
    assetId,
    previous.then(() => held),
  );
  try {
    await previous;
    return await fn();
  } finally {
    release();
  }
}

export type PreparedAgentAssetWrite<T> = {
  workflowJson: string;
  message: string;
  result: T;
  afterWrite?: () => Promise<void>;
};

export type CommitLatestAgentAssetSnapshotArgs<T> = {
  assetService: AssetService;
  assetId: string;
  operation: string;
  prepare: (snapshot: string) => Promise<PreparedAgentAssetWrite<T>>;
  write: (prepared: { workflowJson: string; message: string }) => Promise<void>;
};

/**
 * Applies one mutation against the definition's current asset, retrying
 * when a concurrent writer moved the snapshot between this call's read
 * and its write. The per-asset lock makes that stale check atomic so
 * the loser reapplies on the winner's tree instead of clobbering it.
 */
export async function commitLatestAgentAssetSnapshot<T>(
  args: CommitLatestAgentAssetSnapshotArgs<T>,
): Promise<T> {
  for (
    let remaining = MAX_STALE_SNAPSHOT_RETRIES;
    remaining > 0;
    remaining -= 1
  ) {
    const snapshot = await readAgentDefinitionWorkflowJson(
      args.assetService,
      args.assetId,
    );
    const prepared = await args.prepare(snapshot);
    const wrote = await withAssetWriteLock(args.assetId, async () => {
      const latest = await readAgentDefinitionWorkflowJson(
        args.assetService,
        args.assetId,
      );
      if (latest !== snapshot) return false;
      await args.write({
        workflowJson: prepared.workflowJson,
        message: prepared.message,
      });
      if (prepared.afterWrite !== undefined) {
        await prepared.afterWrite();
      }
      return true;
    });
    if (wrote) return prepared.result;
  }
  throw new Error(
    `${args.operation} for asset ${args.assetId} conflicted after ${String(MAX_STALE_SNAPSHOT_RETRIES)} retries`,
  );
}
