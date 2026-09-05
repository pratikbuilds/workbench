// Durable conversation state for the warm single-step agent.
//
// A long-lived single-step agent holds its multi-turn conversation in
// the reactor's in-memory turn buffer, backed by a per-step isogit
// `ContextStore`. That store is rooted per run/attempt, so it is lost
// the moment the warm agent's child is killed and respawned: the
// rebuilt agent loads a fresh, empty per-run store and the conversation
// continuity is gone.
//
// This module makes the warm agent's conversation DURABLE in the
// workflow-run substrate (the single-writer proxy `RepoStore`, written
// through the supervisor). The durable copy lives under the workflow-run
// repo at a per-agent, per-originating-workbench path
// (`agent-state/<agentKey>/<workbenchId>/...`), sibling to the per-run
// event log under `runs/<runId>/...` and NOT confused with it. `agentKey`
// stays the warm stepId; `workbenchId` is the inbound mail From local-part
// so two rooms sharing one principal do not share turns. On a new run (and
// after a child respawn, once the warm agent is rebuilt lazily) the
// conversation is restored from the substrate into
// the agent's local store BEFORE the agent's reactor loads, so multi-turn
// continuity holds across runs and across respawn.
//
// Two-tier on-disk layout. The prior design wrote
// the WHOLE conversation as a single `conversation.json` blob on every
// message. That re-serialized and re-hashed every prior turn per message,
// so the per-message durable cost grew O(N) in the turn count -- O(N^2)
// over a conversation. It is replaced here with an append-only,
// bucket-sharded write-ahead log plus a periodic compacted checkpoint:
//
//   agent-state/<agentKey>/<workbenchId>/
//     checkpoint.json        compacted full snapshot (turns + metadata)
//     checkpoint.meta.json   { checkpointSeq: <boundary>, turnCount,
//                              tokenUsage, pendingOperations,
//                              connectorState }
//     wal/<bucket>/<seq>.json  one per-boundary delta blob keyed by mirror
//                              BOUNDARY seq, carrying that boundary's
//                              0-or-more new turns plus the freshest metadata
//
// The WAL is keyed by mirror BOUNDARY, not by turn: each `mirrorToSubstrate`
// writes exactly one entry, even when the boundary added no new turns. That
// makes metadata (pendingOperations, tokenUsage, connectorState) persist on
// EVERY boundary -- a turnless-but-metadata-mutating boundary still commits
// a zero-turn entry, so restore never reconstructs stale metadata. (Keying
// the entry by turn dropped metadata on turnless boundaries, which regressed
// the byte-for-byte metadata-equivalence invariant; per-boundary keying is
// the fix.)
//
// `bucket = floor(boundarySeq / WAL_BUCKET_SIZE)` (B = 128) bounds any
// single directory's tree-object size so no commit re-hashes a tree that
// grows with N (a flat `wal/<seq>.json` directory would itself be O(N) per
// commit). Compaction every CHECKPOINT_INTERVAL boundaries (K = 64, i.e.
// once the live WAL reaches K entries) folds the WAL into a fresh
// `checkpoint.json` (capturing the freshest metadata in checkpoint.meta) and
// truncates the WAL, so between checkpoints the WAL holds at most K entries
// and per-boundary durable cost is ~O(1) amortized. K and B are constants
// here, flagged as measurement-tunable.
//
// Restore = load `checkpoint.json` (folded turns + its metadata) then replay
// the WAL tail in boundary-seq order, concatenating each boundary's turns
// and taking the LATEST entry's metadata (the last WAL entry wins; the
// checkpoint's metadata is the base when the WAL is empty). This is pure
// state reconstruction from recorded outputs -- never re-inference. It
// rebuilds the EXACT turn list + metadata the old whole-blob mirror would
// have restored.
//
// Substrate-merge constraint (load-bearing).
// `writeTreePreservingPrefix`'s `merge` callback receives only
// the DIRECT CHILDREN of `preservePrefix`, and the substrate's
// `clearPrefix` step recursively removes the whole `preservePrefix`
// subtree before writing the merge's returned set (paths outside the
// prefix pass through untouched). A WAL blob is two levels below
// `agent-state/<key>/`, so:
//
//   - WAL append uses `preservePrefix = agent-state/<key>/<workbenchId>/wal/<bucket>/`.
//     The bucket's existing blobs ARE direct children, so the merge
//     pre-image is exactly that bucket and the append adds one entry --
//     no isogit side-read, and the checkpoint / other buckets / sibling
//     rooms are untouched (outside the prefix).
//   - Checkpoint write + WAL truncate uses `preservePrefix =
//     agent-state/<key>/<workbenchId>/`. The top-level checkpoint files are
//     direct children; the merge returns ONLY those files and NO `wal/...`
//     paths, so the recursive `clearPrefix` at the workbench dir drops
//     that room's WAL subtree in the same atomic commit without touching
//     sibling rooms. The truncate needs no nested read: omitting the WAL
//     paths from the returned set IS the truncate.
//
// Persistence sink (the riskiest part). The connector router's
// `snapshot()` / `restore()` surface and the harness's
// `createWrappedStorageOverrides` are reused, but the persistence sink is
// repointed from the agent's local isogit store to the workflow-run
// substrate. Both the WAL append and the checkpoint write route through
// the proxy `writeTreePreservingPrefix`; because the supervisor is the
// single writer and serializes every write to the workflow-run ref under
// a per-repo lock, and the `agent-state/<key>/...` prefix is disjoint from
// the run-event prefix (`runs/<runId>/events/`), the conversation write
// never races nor clobbers the run-event log -- both pass through the same
// single writer, and the preserve-prefix merge leaves every other subtree
// byte-for-byte intact.
//
// Timing. This is a STRUCTURE-only
// change. The mirror is still `await`ed synchronously at the same run
// boundary (`onRunBoundary` -> `mirrorToSubstrate`), so every turn is
// still durably committed before the next message is processed. The
// change alters WHAT the write does (O(1) append instead of O(N)
// whole-blob), not WHEN it happens. The run log is NOT yet a durable
// backstop for the turn (it carries a constant ref), so the
// conversation copy here remains the sole durable copy of the agent's
// per-turn output -- which is exactly why the write stays synchronous.
// The async flusher, run-log enrichment, and crash reconciliation are
// later, conditional work, not done here.
//
// Commit granularity. The design calls for connector-state-change-driven
// commits via the router's
// `onStateChanged` hook. The warm-agent path drives the connector router
// through `seedInbound`: each mail-derived inbound message routes and
// commits its thread state before the agent's send, so `onStateChanged`
// fires and enqueues a change-driven mirror. The run-boundary mirror (per
// message) still runs unconditionally, so the two triggers are
// complementary -- the seed persists the connector state promptly, the
// boundary persists the turn delta.
//
// Defensive: a restore that finds a checkpoint or WAL but cannot
// parse/replay it THROWS (a lost or corrupt conversation on respawn is a
// correctness failure, not a silently-fresh start). A mirror write failure
// surfaces so a dropped durability write is visible rather than leaving
// the next respawn to read a stale snapshot.

import fs from "node:fs";
import path from "node:path";

import { type } from "arktype";

import { getLogger } from "@intx/log";
import { reportError } from "@corbits/error-sink";
import { createConnectorRouter } from "@intx/harness";
import type { ConnectorReplyParts, RouteDecision } from "@intx/harness";
import {
  createIsogitStorage,
  createNodeIsogitRuntime,
} from "@intx/storage-isogit/node";
import type {
  Principal,
  RepoId,
  RepoStore,
} from "@intx/hub-sessions/substrate";
import { WORKFLOW_RUN_AGENT_STATE_PREFIX } from "@intx/hub-sessions/substrate";
import { SignalKind } from "@intx/types";

import { UNSCOPED_ORIGINATING_WORKBENCH_ID } from "./originating-workbench";
import {
  ConnectorThreadState,
  TokenUsage,
  type AuditStore,
  type ContextStore,
  type ConversationTurn,
  type InboundMessage,
  type PendingOperation,
  type SendReceipt,
} from "@intx/types/runtime";

const logger = getLogger(["sidecar", "workflow-child", "conversation-state"]);

const isogitStorage = createIsogitStorage(createNodeIsogitRuntime());

const CHECKPOINT_FILE = "checkpoint.json";
const CHECKPOINT_META_FILE = "checkpoint.meta.json";
const WAL_DIR = "wal";

const EMPTY_TOKEN_USAGE: TokenUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  thinking: 0,
};

/**
 * Substrate prefix for one agent's conversation in one originating
 * workbench. Nested under `agent-state/<agentKey>/` so two agents in the
 * same room cannot collide, and two rooms of one agent cannot share turns.
 */
export function durableConversationAgentStatePrefix(
  agentKey: string,
  originatingWorkbenchId: string,
): string {
  return `${WORKFLOW_RUN_AGENT_STATE_PREFIX}/${encodeURIComponent(agentKey)}/${encodeURIComponent(originatingWorkbenchId)}/`;
}

export function durableConversationAgentStateDir(
  repoDir: string,
  agentKey: string,
  originatingWorkbenchId: string,
): string {
  return path.join(
    repoDir,
    WORKFLOW_RUN_AGENT_STATE_PREFIX,
    encodeURIComponent(agentKey),
    encodeURIComponent(originatingWorkbenchId),
  );
}

/**
 * Compaction interval: fold the WAL into a fresh checkpoint once it holds
 * this many turns since the last checkpoint. Bounds the WAL tail (and so
 * the restore-replay length) between checkpoints. Measurement-tunable;
 * fixed here at 64.
 */
const CHECKPOINT_INTERVAL = 64;

/**
 * WAL directory fan-out bound: turn `seq` lives in bucket
 * `floor(seq / WAL_BUCKET_SIZE)`. Caps any single `wal/<bucket>/` tree at
 * this many entries so no commit re-hashes a tree that grows with the
 * conversation length. Measurement-tunable; fixed here at 128.
 */
const WAL_BUCKET_SIZE = 128;

/**
 * Metadata carried alongside the checkpoint and stamped onto every WAL
 * entry. Small and bounded -- it is NOT the O(N) cost; the turn array is.
 * Stamping the latest metadata on each WAL entry lets the restore replay
 * recover the exact non-turn reactor state without a separate metadata
 * log: the last replayed entry's metadata wins. Because every mirror
 * boundary writes exactly one WAL entry (even a turnless one), the latest
 * metadata is ALWAYS captured durably -- a turnless boundary still commits
 * its advanced metadata as a zero-turn entry.
 */
const SnapshotMetadata = type({
  pendingOperations: "unknown[]",
  tokenUsage: TokenUsage,
  connectorState: ConnectorThreadState.or("null"),
});

/**
 * On-disk shape of the compacted checkpoint blob committed at
 * `agent-state/<agentKey>/<workbenchId>/checkpoint.json`. Carries the folded
 * turn history (turns 0..checkpointSeq-1) plus the non-turn reactor metadata.
 * Validated on read because it crosses back into the program from the
 * substrate working tree -- a corrupt or partially-written checkpoint must
 * surface at the boundary, never be half-applied into the agent.
 */
const CheckpointSnapshot = type({
  turns: "unknown[]",
  pendingOperations: "unknown[]",
  tokenUsage: TokenUsage,
  connectorState: ConnectorThreadState.or("null"),
});

/**
 * On-disk shape of
 * `agent-state/<agentKey>/<workbenchId>/checkpoint.meta.json`. The checkpoint
 * pointer the restore path reads first to learn the boundary seq
 * the checkpoint folded to (`checkpointSeq`) -- and therefore which WAL
 * boundary seqs remain to replay -- plus the folded turn count
 * (`turnCount`, = `checkpoint.json`'s turn array length) and the freshest
 * metadata at fold time. `checkpointSeq` counts MIRROR BOUNDARIES, not
 * turns: a boundary may carry zero or many turns, so the boundary count and
 * the turn count diverge in general (they coincide only when every boundary
 * adds exactly one turn).
 */
const CheckpointMeta = type({
  checkpointSeq: "number",
  turnCount: "number",
  pendingOperations: "unknown[]",
  tokenUsage: TokenUsage,
  connectorState: ConnectorThreadState.or("null"),
});

/**
 * On-disk shape of one WAL entry blob at
 * `agent-state/<agentKey>/<workbenchId>/wal/<bucket>/<seq>.json`. One entry
 * per MIRROR BOUNDARY (keyed by boundary `seq`, not turn index). Records the 0-or-more
 * new turns that boundary added (the O(1) append payload -- it never
 * carries prior turns) plus the latest non-turn metadata snapshot. The
 * append is UNCONDITIONAL: a turnless boundary still writes one entry with
 * `turns: []` so its advanced metadata is durably committed (the invariant
 * the per-turn keying broke -- metadata must persist on EVERY boundary).
 */
const WalEntry = type({
  seq: "number",
  turns: "unknown[]",
  metadata: SnapshotMetadata,
});

/**
 * Loaded conversation snapshot the restore path applies into the warm
 * agent's local store before its reactor loads.
 */
interface LoadedSnapshot {
  turns: ConversationTurn[];
  pendingOperations: PendingOperation[];
  tokenUsage: TokenUsage;
  connectorState: ConnectorThreadState | null;
}

export interface DurableConversationStoreOpts {
  /**
   * Local per-agent isogit store root. Stable across runs (NOT keyed by
   * runId) so a warm agent's reactor loads the same on-disk store on
   * every message; the substrate is the cross-respawn durable mirror of
   * this store's conversation content.
   */
  localStoreDir: string;
  /** Commit signer for the local isogit store. */
  signer: (payload: string) => Promise<string>;
  /** Proxy workflow-run substrate (single-writer via the supervisor). */
  substrate: RepoStore;
  /** Workflow-run repo identity for the deployment. */
  workflowRunRepoId: RepoId;
  /** Workflow-run repo ref the conversation snapshot is committed to. */
  workflowRunRef: string;
  /** Principal the substrate write is authored under. */
  principal: Principal;
  /**
   * Stable per-agent key the snapshot is filed under
   * (`agent-state/<agentKey>/<workbenchId>/`). The warm single-step agent's
   * stepId is the natural agentKey: it is stable across that agent's whole
   * lifetime and disjoint from any runId. Originating workbench is bound
   * separately so one warm agent can swap rooms without cloning.
   */
  agentKey: string;
}

/**
 * A `ContextStore` for the warm agent whose conversation content is
 * durably mirrored to the workflow-run substrate. The reactor sees a
 * normal `ContextStore` (its per-cycle commits land in the fast local
 * isogit store); `restoreFromSubstrate` and `mirrorToSubstrate` move the
 * conversation between the local store and the durable substrate layout.
 */
export interface DurableConversationStore {
  /**
   * The store the warm agent's env binds as `storage` and `audit`. It is
   * both `ContextStore` (conversation + connector state) and
   * `AuditStore` (tool-authorization records), matching the per-run
   * isogit store the non-warm path uses.
   */
  readonly storage: ContextStore & AuditStore;
  /**
   * Pull the prior conversation from the substrate (checkpoint + WAL-tail
   * replay) into the local store so the agent's reactor `load()` sees it.
   * Called before the warm agent is built (lazy first build and respawn
   * rebuild). Returns `true` when prior state was found and applied,
   * `false` when none exists yet (the genuine first-ever run). A read that
   * finds a checkpoint or WAL but cannot parse/replay it throws -- a
   * corrupt durable copy is a correctness failure that must not silently
   * start the agent fresh.
   */
  restoreFromSubstrate(): Promise<boolean>;
  /**
   * Commit the local store's new turn(s) to the substrate as O(1) WAL
   * appends, folding into a fresh checkpoint when the WAL reaches the
   * compaction interval. Called synchronously at the run boundary (after
   * the agent's send settles). A write failure surfaces. Flushes the
   * currently bound originating-workbench prefix (the composite key).
   */
  mirrorToSubstrate(): Promise<void>;
  /**
   * Advance the connector router from a received inbound message so the
   * warm agent's reply path has thread state. Runs the router's pure
   * `route()` then `commit()`: a `start` seeds threadRoot / lastMessageId /
   * replyTo from the message; a `continue` advances lastMessageId / replyTo
   * and carries prior speakers into `cc`. The advanced connector state is
   * flushed into the local store's metadata so the run-boundary mirror
   * persists it and a respawn restore re-seeds the router. A `passthrough`
   * decision -- no active-thread match, or an unparseable sender -- advances
   * nothing. Called before the warm agent's send so `composeReply()` can
   * compose a threaded reply. A metadata write failure surfaces.
   */
  seedInbound(message: InboundMessage): Promise<void>;
  /**
   * Produce the threading headers for a reply on the active connector
   * thread (the router's `composeReply`). Throws
   * `NoActiveConnectorThreadError` when no thread has been seeded. The warm
   * mail loop's reply drain reads this to address its outbound reply.
   */
  composeReply(): ConnectorReplyParts;
  /**
   * Advance the connector thread after a reply was sent. Forwards to the
   * router's `onReplySent` (which moves `lastMessageId` to the sent reply's
   * Message-ID so the next inbound continuation matches) and flushes the
   * advanced connector state into the local store's metadata the same way
   * `seedInbound` does, so `lastMessageId` persists across turns and across a
   * child respawn. Called by the warm mail loop's reply drain after its
   * outbound send settles. Throws `NoActiveConnectorThreadError` when no
   * thread is active -- advancing outbound state has no meaning without a
   * seeded thread. A metadata write failure surfaces.
   */
  onReplySent(receipt: SendReceipt): Promise<void>;
  /**
   * Point this store at `originatingWorkbenchId`'s nested substrate
   * snapshot. Same room is a no-op. On a change: mirror the current room,
   * retarget `agent-state/<agentKey>/<workbenchId>/`, restore that
   * snapshot. Missing snapshot starts empty -- the prior mixed
   * `agent-state/<agentKey>/` blob is never migrated. Returns true when
   * the bound room changed (caller must rebuild the warm agent so
   * `reactor.start()` loads the restored turns).
   */
  bindOriginatingWorkbench(originatingWorkbenchId: string): Promise<boolean>;
  /** Room this store is bound to, or null before the first bind. */
  boundOriginatingWorkbenchId(): string | null;
}

export async function createDurableConversationStore(
  opts: DurableConversationStoreOpts,
): Promise<DurableConversationStore> {
  await fs.promises.mkdir(opts.localStoreDir, { recursive: true });
  const baseStorage = await isogitStorage.createIsogitStore(
    opts.localStoreDir,
    opts.signer,
  );

  // Reuse the connector router + the harness storage-override seam. The
  // router's `onStateChanged` is the change-driven commit hook the design
  // names. `seedInbound` drives the router (route + commit) on each inbound
  // mail, so `onStateChanged` fires and enqueues a change-driven mirror
  // behind the seed on the shared serialization tail; the run-boundary
  // mirror still commits every boundary. Both triggers persist state, so a
  // dropped change-driven mirror is recoverable at the next boundary.
  const connectorRouter = createConnectorRouter({
    onStateChanged: () => {
      void mirrorToSubstrate().catch((cause) => {
        logger.error`connector-state-change conversation mirror failed for ${opts.agentKey}: ${cause instanceof Error ? cause.message : String(cause)}`;
      });
    },
  });

  // Nested substrate prefix is retargeted by bindOriginatingWorkbench.
  // Unbound until the first inbound origin is known -- mirror/restore
  // require a bound room so they cannot write the mixed agent-state/<key>/
  // blob.
  let originatingWorkbenchId: string | null = null;

  function requireBoundWorkbenchId(): string {
    if (originatingWorkbenchId === null) {
      throw new Error(
        `sidecar conversation-state: originating workbench is not bound for ${opts.agentKey}; bindOriginatingWorkbench must run before restore or mirror`,
      );
    }
    return originatingWorkbenchId;
  }

  function agentStatePrefix(): string {
    return durableConversationAgentStatePrefix(
      opts.agentKey,
      requireBoundWorkbenchId(),
    );
  }
  // The number of mirror boundaries already durably committed (the
  // checkpoint's folded boundaries plus every appended WAL entry). It is
  // the seq of the NEXT WAL entry. `null` until learned -- lazily from the
  // substrate on the first mirror so a respawn-rebuilt store that did NOT
  // restore never re-commits boundaries the substrate already holds.
  let mirroredBoundaryCount: number | null = null;
  // The number of turns already durably committed (checkpoint folded turns
  // plus every turn carried by an appended WAL entry). The next mirror
  // appends only `turns.slice(mirroredTurnCount)`, which is what keeps each
  // append O(1) in the turn count.
  let mirroredTurnCount = 0;
  // The boundary seq the current checkpoint folded to: WAL boundary seqs
  // [checkpointBoundarySeq, mirroredBoundaryCount) are live. Tracked so a
  // mirror knows the live WAL length (mirroredBoundaryCount -
  // checkpointBoundarySeq) and when to compact.
  let checkpointBoundarySeq = 0;

  // Serialize the shared-counter critical section. Both `mirrorToSubstrate`
  // and `restoreFromSubstrate` read and advance the three counts above, and
  // either can re-enter the other: `connectorRouter.restore()` can fire
  // `onStateChanged` synchronously, which enqueues a mirror. A single
  // per-instance tail runs every such op one-at-a-time regardless of entry
  // point, so two overlapping runs cannot read the same boundary seq and
  // emit two WAL entries at it. Modeled on `runRepoOp` in the hub-agent
  // session manager: the stored tail swallows rejections so one failed op
  // does not poison the chain, while each caller still observes its own op's
  // result (or rejection) through the returned promise.
  //
  // This serializes mirror-vs-mirror and mirror-vs-restore only. It does NOT
  // address the reactor-vs-mirror peek-snapshot window documented on
  // `runMirror` below (nothing must append to the reactor's turn array
  // between its last writeTurns and the mirror's peekTurns) -- that is a
  // different concurrency axis and is out of scope here.
  let stateOpTail: Promise<unknown> = Promise.resolve();
  function serializeStateOp<T>(op: () => Promise<T>): Promise<T> {
    const result = stateOpTail.then(op, op);
    stateOpTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function restoreFromSubstrate(): Promise<boolean> {
    return serializeStateOp(runRestore);
  }

  function mirrorToSubstrate(): Promise<void> {
    return serializeStateOp(runMirror);
  }

  function seedInbound(message: InboundMessage): Promise<void> {
    return serializeStateOp(() => runSeed(message));
  }

  function composeReply(): ConnectorReplyParts {
    return connectorRouter.composeReply();
  }

  function onReplySent(receipt: SendReceipt): Promise<void> {
    return serializeStateOp(() => runReplySent(receipt));
  }

  function substrateAgentStateFsDir(): string {
    return durableConversationAgentStateDir(
      opts.substrate.getRepoDir(opts.workflowRunRepoId),
      opts.agentKey,
      requireBoundWorkbenchId(),
    );
  }

  function bucketOf(seq: number): number {
    return Math.floor(seq / WAL_BUCKET_SIZE);
  }

  function walBucketPrefix(bucket: number): string {
    return `${agentStatePrefix()}${WAL_DIR}/${String(bucket)}/`;
  }

  function walEntryPath(seq: number): string {
    return `${walBucketPrefix(bucketOf(seq))}${String(seq)}.json`;
  }

  function checkpointPath(): string {
    return `${agentStatePrefix()}${CHECKPOINT_FILE}`;
  }

  function checkpointMetaPath(): string {
    return `${agentStatePrefix()}${CHECKPOINT_META_FILE}`;
  }

  async function applyEmptyLocalConversation(reason: string): Promise<void> {
    await baseStorage.writeTurns([]);
    baseStorage.setConnectorState(null);
    connectorRouter.restore(null);
    await baseStorage.writeMetadata({
      pendingOperations: [],
      tokenUsage: EMPTY_TOKEN_USAGE,
    });
    await baseStorage.commit({ message: reason });
    mirroredBoundaryCount = 0;
    mirroredTurnCount = 0;
    checkpointBoundarySeq = 0;
  }

  async function runRestore(): Promise<boolean> {
    const reconstructed = await reconstructDurableConversation(
      substrateAgentStateFsDir(),
      `${opts.agentKey}/${requireBoundWorkbenchId()}`,
    );
    if (reconstructed === null) {
      // No snapshot for this room: start empty. Do not migrate a mixed
      // agent-state/<agentKey>/ blob from before per-room nesting.
      await applyEmptyLocalConversation(
        `reset conversation for ${opts.agentKey} workbench ${requireBoundWorkbenchId()} (no prior snapshot)`,
      );
      return false;
    }
    // Write the reconstructed turns + metadata into the local store's
    // working tree and commit, so the agent's reactor `load()` reads the
    // restored conversation. `setConnectorState` buffers the connector
    // state for the metadata write; `restore()` mirrors it into the router
    // so a future change-driven mirror carries the right base.
    await baseStorage.writeTurns(reconstructed.turns);
    baseStorage.setConnectorState(reconstructed.connectorState);
    // Establish the committed counts BEFORE restoring the connector state.
    // `connectorRouter.restore()` can fire `onStateChanged` synchronously
    // (when the restored state differs from current), which enqueues a
    // mirror. Serialization already chains that mirror behind this restore,
    // but setting the counts first keeps them correct even if that ordering
    // guarantee is ever weakened. The counts reflect the substrate state
    // `reconstructed` was read from, which is durable independent of the
    // local-store commit below.
    mirroredBoundaryCount = reconstructed.boundaryCount;
    mirroredTurnCount = reconstructed.totalTurns;
    checkpointBoundarySeq = reconstructed.checkpointBoundarySeq;
    connectorRouter.restore(reconstructed.connectorState);
    await baseStorage.writeMetadata({
      pendingOperations: reconstructed.pendingOperations,
      tokenUsage: reconstructed.tokenUsage,
    });
    await baseStorage.commit({
      message: `restore conversation for ${opts.agentKey} from substrate`,
    });
    return true;
  }

  /**
   * Append one WAL entry for a mirror boundary (its 0-or-more new turns +
   * the current metadata) to its bucket. The merge pre-image is exactly
   * that bucket's existing blobs (direct children of `wal/<bucket>/`), so
   * the append is the bucket's blobs plus the one new entry -- O(bucket
   * size), independent of N. The append is the SINGLE synchronous write per
   * boundary; the entry is keyed by boundary `seq` so a turnless boundary
   * still commits its metadata as a zero-turn entry.
   */
  async function appendWalEntry(
    boundarySeq: number,
    turns: unknown[],
    metadata: {
      pendingOperations: unknown[];
      tokenUsage: TokenUsage;
      connectorState: ConnectorThreadState | null;
    },
  ): Promise<void> {
    const entry = { seq: boundarySeq, turns, metadata };
    const serialized = JSON.stringify(entry);
    const newPath = walEntryPath(boundarySeq);
    await opts.substrate.writeTreePreservingPrefix(
      opts.principal,
      opts.workflowRunRepoId,
      opts.workflowRunRef,
      {
        preservePrefix: walBucketPrefix(bucketOf(boundarySeq)),
        merge: async (existing) => {
          const files: Record<string, string | Uint8Array> = {};
          for (const [blobPath, bytes] of existing) {
            files[blobPath] = bytes;
          }
          files[newPath] = serialized;
          return files;
        },
        message: `append conversation WAL boundary ${String(boundarySeq)} (${String(turns.length)} turn(s)) for ${opts.agentKey}`,
      },
    );
  }

  /**
   * Fold the full conversation into a fresh checkpoint and truncate the WAL in
   * one atomic commit at `preservePrefix = agent-state/<key>/<workbenchId>/`.
   * The merge returns ONLY the two checkpoint files and NO `wal/...` paths;
   * because the substrate's `clearPrefix` recursively removes the whole room
   * subtree before writing the returned set, omitting the WAL paths IS the
   * truncate.
   */
  async function writeCheckpoint(
    boundarySeq: number,
    turns: unknown[],
    metadata: {
      pendingOperations: unknown[];
      tokenUsage: TokenUsage;
      connectorState: ConnectorThreadState | null;
    },
  ): Promise<void> {
    const snapshot = {
      turns,
      pendingOperations: metadata.pendingOperations,
      tokenUsage: metadata.tokenUsage,
      connectorState: metadata.connectorState,
    };
    // `metadata` is the freshest snapshot (the current local-store
    // metadata, identical to the last appended WAL entry's metadata), so
    // the fold captures the latest metadata into checkpoint.meta -- a
    // restore from the post-fold checkpoint sees the same metadata the
    // pre-fold WAL tail would have yielded.
    const meta = {
      checkpointSeq: boundarySeq,
      turnCount: turns.length,
      pendingOperations: metadata.pendingOperations,
      tokenUsage: metadata.tokenUsage,
      connectorState: metadata.connectorState,
    };
    await opts.substrate.writeTreePreservingPrefix(
      opts.principal,
      opts.workflowRunRepoId,
      opts.workflowRunRef,
      {
        preservePrefix: agentStatePrefix(),
        merge: async () => ({
          [checkpointPath()]: JSON.stringify(snapshot),
          [checkpointMetaPath()]: JSON.stringify(meta),
        }),
        message: `compact conversation checkpoint at boundary ${String(boundarySeq)} (${String(turns.length)} turns) for ${opts.agentKey}`,
      },
    );
  }

  async function runMirror(): Promise<void> {
    // Slice the new turns from the reactor's in-memory array (retained
    // by the local single-writer store at the last writeTurns) instead
    // of re-reading and re-parsing the whole turns.jsonl every
    // boundary; only the bounded metadata.json is read from disk. This
    // rests on a sequencing invariant the store cannot enforce: nothing
    // mutates the reactor's turn array between its last writeTurns and
    // this read. The mirror runs at onRunBoundary after send() settles,
    // and the reactor only appends inside a cycle (each ending in
    // writeTurns), so peekTurns() equals the on-disk state here.
    // Serializing the mirror entry points keeps two mirrors from
    // overlapping this read, but the reactor must still not append
    // between its writeTurns and this peek -- that axis is not serialized.
    const turns = baseStorage.peekTurns();
    const metadata = await baseStorage.loadMetadata();

    // First mirror in this store's lifetime that did not run through
    // `restoreFromSubstrate` (which sets the counts): learn the durable
    // counts from the substrate so the append starts at the right boundary
    // seq and never re-commits boundaries the substrate already holds.
    if (mirroredBoundaryCount === null) {
      const reconstructed = await reconstructDurableConversation(
        substrateAgentStateFsDir(),
        `${opts.agentKey}/${requireBoundWorkbenchId()}`,
      );
      checkpointBoundarySeq = reconstructed?.checkpointBoundarySeq ?? 0;
      mirroredBoundaryCount = reconstructed?.boundaryCount ?? 0;
      mirroredTurnCount = reconstructed?.totalTurns ?? 0;
    }

    // ONE WAL entry per mirror boundary, UNCONDITIONALLY -- even when no new
    // turns were added since the last mirror. The entry carries the
    // 0-or-more new turns plus the freshest metadata snapshot, so a
    // turnless-but-metadata-mutating boundary (e.g. a throwing send that
    // still advanced tokenUsage/pendingOperations, since onRunBoundary runs
    // in a finally) still durably commits its metadata. The payload is the
    // turn DELTA plus bounded metadata -- never the whole conversation, so
    // the O(N^2) growth stays gone. This is the single synchronous write
    // per boundary on the reply path.
    const newTurns = turns.slice(mirroredTurnCount);
    const boundarySeq = mirroredBoundaryCount;
    await appendWalEntry(boundarySeq, newTurns, metadata);
    mirroredBoundaryCount = boundarySeq + 1;
    // Advance by the count actually persisted -- newTurns is a pre-await
    // snapshot -- not by turns.length. `turns` is the reactor's live array
    // by reference; reading its length after the await would count any turn
    // appended during appendWalEntry as mirrored, so the next mirror would
    // slice past it and drop it from the WAL permanently.
    mirroredTurnCount = mirroredTurnCount + newTurns.length;

    // Compact once the live WAL reaches the interval (measured in mirror
    // boundaries = WAL entries, which bounds both the bucket fan-out and the
    // replay length): fold the full conversation into a fresh checkpoint
    // with the freshest metadata and truncate the WAL. Amortizes the
    // unavoidable O(N) full rewrite to O(N/K) per boundary.
    if (mirroredBoundaryCount - checkpointBoundarySeq >= CHECKPOINT_INTERVAL) {
      await writeCheckpoint(
        mirroredBoundaryCount,
        turns.slice(0, mirroredTurnCount),
        metadata,
      );
      checkpointBoundarySeq = mirroredBoundaryCount;
    }
  }

  // Classify an inbound message, treating a `route()` throw as passthrough.
  // The router throws when `message.headers.from` is not a parseable bare
  // addr-spec; per the router contract that is a passthrough (deliver the
  // message to the agent -- the caller's send is separate -- but do not
  // advance the thread), not a programmer error, so it must not fail the
  // seed. A synthesized passthrough decision commits as a no-op.
  function routeOrPassthrough(message: InboundMessage): RouteDecision {
    try {
      return connectorRouter.route(message);
    } catch (cause) {
      logger.warn`connector route for ${opts.agentKey} could not parse the inbound sender; leaving the thread unadvanced: ${cause instanceof Error ? cause.message : String(cause)}`;
      return { kind: "passthrough" };
    }
  }

  // Advance the connector router from a received inbound message and flush
  // the resulting connector state into the local store's metadata. `commit`
  // fires the router's `onStateChanged`, which enqueues a change-driven
  // mirror behind this op on the shared serialization tail; because that
  // mirror reads the connector state from the local store's metadata (not
  // from the router), the metadata write below is what makes the seeded
  // state reach the substrate. The write preserves the reactor's staged
  // pendingOperations / tokenUsage -- a seed advances only connectorState.
  // A passthrough decision advances nothing and writes nothing.
  async function runSeed(message: InboundMessage): Promise<void> {
    const decision = routeOrPassthrough(message);
    connectorRouter.commit(decision);
    if (decision.kind === "passthrough") return;

    const metadata = await baseStorage.loadMetadata();
    baseStorage.setConnectorState(connectorRouter.snapshot());
    await baseStorage.writeMetadata({
      pendingOperations: metadata.pendingOperations,
      tokenUsage: metadata.tokenUsage,
    });
    await baseStorage.commit({
      message: `seed connector thread for ${opts.agentKey}`,
    });
  }

  // Advance the connector thread after a reply was sent and flush the
  // resulting connector state into the local store's metadata. `onReplySent`
  // moves `lastMessageId` to the reply's Message-ID and fires the router's
  // `onStateChanged`, which enqueues a change-driven mirror behind this op on
  // the shared serialization tail; because that mirror reads the connector
  // state from the local store's metadata (not from the router), the metadata
  // write below is what makes the advanced state reach the substrate. The
  // write preserves the reactor's staged pendingOperations / tokenUsage -- an
  // outbound advance touches only connectorState. `onReplySent` throws when no
  // thread is active, which surfaces to the reply drain's failure callback
  // rather than persisting a phantom advance.
  async function runReplySent(receipt: SendReceipt): Promise<void> {
    connectorRouter.onReplySent(receipt);

    const metadata = await baseStorage.loadMetadata();
    baseStorage.setConnectorState(connectorRouter.snapshot());
    await baseStorage.writeMetadata({
      pendingOperations: metadata.pendingOperations,
      tokenUsage: metadata.tokenUsage,
    });
    await baseStorage.commit({
      message: `advance connector thread after reply for ${opts.agentKey}`,
    });
  }

  function bindOriginatingWorkbench(nextWorkbenchId: string): Promise<boolean> {
    return serializeStateOp(async () => {
      if (nextWorkbenchId.length === 0) {
        throw new Error(
          `sidecar conversation-state: originating workbench id must be non-empty for ${opts.agentKey}`,
        );
      }
      if (originatingWorkbenchId === nextWorkbenchId) return false;
      if (originatingWorkbenchId !== null) {
        await runMirror();
      }
      originatingWorkbenchId = nextWorkbenchId;
      await runRestore();
      return true;
    });
  }

  return {
    storage: baseStorage,
    restoreFromSubstrate,
    mirrorToSubstrate,
    seedInbound,
    composeReply,
    onReplySent,
    bindOriginatingWorkbench,
    boundOriginatingWorkbenchId: () => originatingWorkbenchId,
  };
}

export interface DurableConversationRegistryOpts {
  /** Sidecar data dir; per-agent local stores root under it. */
  dataDir: string;
  /** Workflow-run repo identity for the deployment. */
  workflowRunRepoId: RepoId;
  /** Workflow-run repo ref. */
  workflowRunRef: string;
  /** Proxy workflow-run substrate (single-writer via the supervisor). */
  substrate: RepoStore;
  /** Principal the substrate write is authored under. */
  principal: Principal;
  /** Commit signer for the per-agent local isogit stores. */
  signer: (payload: string) => Promise<string>;
}

/**
 * Per-agent durable-conversation store registry. One store
 * per warm agent key (stepId), built lazily and reused across runs in the
 * same child. Originating-workbench snapshots nest under that key; bind
 * retargets the live store before each send. The registry is empty
 * after a respawn (it lives in the child's address space); the substrate
 * is the durable mirror that survives.
 */
export interface DurableConversationRegistry {
  acquire(key: string): Promise<DurableConversationStore>;
  get(key: string): DurableConversationStore;
  /**
   * The store for `key` if one has been acquired, else `undefined`.
   * The body-turn mirror (CL-6448) runs in a `finally` that must not
   * mask a build failure with `get`'s throw when the env builder never
   * reached its acquire.
   */
  peek(key: string): DurableConversationStore | undefined;
}

export function createDurableConversationRegistry(
  opts: DurableConversationRegistryOpts,
): DurableConversationRegistry {
  const stores = new Map<string, DurableConversationStore>();
  // De-dup concurrent first-acquires for the same key so two in-flight
  // step invocations for one warm agent never build two stores (which
  // would double-restore and split the durable mirror).
  const building = new Map<string, Promise<DurableConversationStore>>();

  function localStoreDir(key: string): string {
    return path.join(
      opts.dataDir,
      "agent-conversation-state",
      opts.workflowRunRepoId.id,
      encodeURIComponent(key),
    );
  }

  async function acquire(key: string): Promise<DurableConversationStore> {
    const existing = stores.get(key);
    if (existing !== undefined) return existing;
    const inFlight = building.get(key);
    if (inFlight !== undefined) return inFlight;
    const promise = (async () => {
      const store = await createDurableConversationStore({
        localStoreDir: localStoreDir(key),
        signer: opts.signer,
        substrate: opts.substrate,
        workflowRunRepoId: opts.workflowRunRepoId,
        workflowRunRef: opts.workflowRunRef,
        principal: opts.principal,
        agentKey: key,
      });
      // Restore happens in bindOriginatingWorkbench once the inbound
      // From local-part is known. Restoring here would load a mixed
      // agent-state/<key>/ blob (or throw unbound).
      stores.set(key, store);
      building.delete(key);
      return store;
    })().catch((cause) => {
      building.delete(key);
      throw cause;
    });
    building.set(key, promise);
    return promise;
  }

  function peek(key: string): DurableConversationStore | undefined {
    return stores.get(key);
  }

  function get(key: string): DurableConversationStore {
    const store = stores.get(key);
    if (store === undefined) {
      throw new Error(
        `sidecar conversation-state: no durable conversation store for ${JSON.stringify(key)}; the run-boundary mirror ran before the warm agent's env was built`,
      );
    }
    return store;
  }

  return { acquire, get, peek };
}

/**
 * Bind the warm agent's live store to the originating workbench and, when
 * the room changed, evict the cached agent so the next send rebuilds
 * against the restored snapshot. The cache stays keyed by stepId -- one
 * warm agent, not one per room.
 */
export async function prepareConversationForOriginatingWorkbench(args: {
  registry: DurableConversationRegistry;
  agentKey: string;
  /** Room named by this request's mail; undefined keeps the current binding. */
  originatingWorkbenchId: string | undefined;
  warmCache?: { evictAll: (reason: string) => Promise<void> };
}): Promise<boolean> {
  const store = await args.registry.acquire(args.agentKey);
  const requested = args.originatingWorkbenchId;
  const current = store.boundOriginatingWorkbenchId();
  const target = requested ?? current ?? UNSCOPED_ORIGINATING_WORKBENCH_ID;
  const swapped = await store.bindOriginatingWorkbench(target);
  if (swapped && args.warmCache !== undefined) {
    await args.warmCache.evictAll(`originating workbench changed to ${target}`);
  }
  return swapped;
}

interface SnapshotMetadataValue {
  pendingOperations: unknown[];
  tokenUsage: TokenUsage;
  connectorState: ConnectorThreadState | null;
}

/**
 * The reconstructed conversation plus the bookkeeping the mirror path needs
 * to resume appending. `totalTurns` is the full turn count (checkpoint +
 * WAL). `boundaryCount` is the number of mirror boundaries durably
 * committed (checkpoint's folded boundaries + replayed WAL entries) -- the
 * next WAL entry uses this as its boundary seq. `checkpointBoundarySeq` is
 * the boundary seq the checkpoint folded to (the first WAL boundary seq to
 * expect), so the mirror knows the live WAL length and when to compact.
 */
export interface ReconstructedConversation extends LoadedSnapshot {
  totalTurns: number;
  boundaryCount: number;
  checkpointBoundarySeq: number;
}

/**
 * The reactor re-narrows turn/operation elements on load; the read helpers
 * enforce only the structural envelope, matching the boundary the
 * whole-blob mirror used. This is the single boundary cast for that
 * element-level narrowing -- it cannot be replaced by a runtime check here
 * because the element validators live in the reactor, not this module.
 */
function castValidatedEnvelope<T>(items: unknown[]): T[] {
  return items as T[];
}

/**
 * A pending operation's `kind` envelope: just enough structure to read
 * `kind` back off an otherwise-unvalidated `PendingOperation` (the element
 * validator itself lives in the reactor, per `castValidatedEnvelope`'s
 * doc comment above). Used only to detect a `kind` the running build's
 * `SignalKind` no longer recognizes -- e.g. CL-7443 retired
 * `message_response` -- before the reactor's `rehydrateGates` reaches it,
 * since an unclassified kind there throws and blocks every future respawn.
 */
const PendingOperationKindEnvelope = type({ kind: "unknown" });

/**
 * Drop any restored pending operation whose `kind` is not a `SignalKind`
 * this build still classifies, reporting each drop through `reportError`
 * rather than letting the reactor's `rehydrateGates` throw on it. A retired
 * signal kind (CL-7443's `message_response`) can still be sitting in a warm
 * agent's on-disk checkpoint/WAL from before the retirement; without this
 * filter, every respawn of that agent would throw
 * "Unclassified signal kind" and never start. The person's in-flight
 * question is simply lost here -- their eventual reply just becomes the
 * next ordinary turn (docs/CHAT.md).
 */
function dropUnclassifiedPendingOperations(
  items: unknown[],
  agentKey: string,
): unknown[] {
  return items.filter((item) => {
    const envelope = PendingOperationKindEnvelope(item);
    const kind = envelope instanceof type.errors ? undefined : envelope.kind;
    if (SignalKind(kind) instanceof type.errors) {
      reportError(
        new Error(
          `pending operation with unclassified signal kind ${JSON.stringify(kind)} dropped on restore for agent ${agentKey}`,
        ),
        {
          operation: "pending_op_dropped_unknown_kind",
          agentId: agentKey,
        },
      );
      return false;
    }
    return true;
  });
}

/**
 * Reconstruct the warm agent's conversation from the two-tier on-disk
 * layout under `agentStateDir`
 * (`<repoDir>/agent-state/<agentKey>/<workbenchId>/`): the compacted
 * `checkpoint.json` turns followed by the replayed WAL tail.
 * Pure read against the substrate working tree -- no inference, no commit.
 * Returns `null` when neither a checkpoint nor any WAL exists (the genuine
 * first-ever run). The latest metadata source wins (the last replayed WAL
 * entry, or the checkpoint when the WAL is empty), mirroring how each
 * mirror stamps the current metadata. Throws on any corrupt/unparseable
 * blob or a WAL seq gap -- a damaged durable copy must surface, never
 * silently start the agent fresh or drop a turn.
 *
 * Exported so a reader (durability test, recovery audit) reconstructs the
 * conversation through the SAME code path the warm agent's restore uses,
 * rather than re-deriving the WAL/checkpoint fold independently.
 */
export async function reconstructDurableConversation(
  agentStateDir: string,
  agentKey: string,
): Promise<ReconstructedConversation | null> {
  const checkpoint = await readCheckpointFromDir(agentStateDir, agentKey);
  const baseBoundarySeq = checkpoint?.checkpointSeq ?? 0;
  const wal = await readWalTailFromDir(
    agentStateDir,
    agentKey,
    baseBoundarySeq,
  );
  if (checkpoint === null && wal.length === 0) return null;

  const turns: unknown[] = [...(checkpoint?.turns ?? [])];
  // The freshest metadata wins: the last WAL entry, or the checkpoint when
  // the WAL is empty. Because every boundary writes a WAL entry, the last
  // entry always carries the latest metadata -- including a turnless
  // boundary that advanced only metadata.
  let metadata: SnapshotMetadataValue = checkpoint?.metadata ?? {
    pendingOperations: [],
    tokenUsage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      thinking: 0,
    },
    connectorState: null,
  };
  for (const entry of wal) {
    for (const turn of entry.turns) {
      turns.push(turn);
    }
    metadata = entry.metadata;
  }
  return {
    turns: castValidatedEnvelope<ConversationTurn>(turns),
    pendingOperations: castValidatedEnvelope<PendingOperation>(
      dropUnclassifiedPendingOperations(metadata.pendingOperations, agentKey),
    ),
    tokenUsage: metadata.tokenUsage,
    connectorState: metadata.connectorState,
    totalTurns: turns.length,
    boundaryCount: baseBoundarySeq + wal.length,
    checkpointBoundarySeq: baseBoundarySeq,
  };
}

/**
 * Read the checkpoint pair from `agentStateDir`. Returns `null` only when
 * no checkpoint exists yet -- which the reconstruction treats as "no
 * folded turns" (any conversation lives entirely in the WAL). A
 * present-but-corrupt or inconsistent checkpoint throws.
 */
async function readCheckpointFromDir(
  agentStateDir: string,
  agentKey: string,
): Promise<{
  turns: unknown[];
  checkpointSeq: number;
  metadata: SnapshotMetadataValue;
} | null> {
  let metaRaw: string;
  try {
    metaRaw = await fs.promises.readFile(
      path.join(agentStateDir, CHECKPOINT_META_FILE),
      "utf8",
    );
  } catch (cause) {
    if (isErrnoNotFound(cause)) return null;
    throw cause;
  }
  const meta = parseJsonOrThrow(metaRaw, `${agentKey} ${CHECKPOINT_META_FILE}`);
  const validatedMeta = CheckpointMeta(meta);
  if (validatedMeta instanceof type.errors) {
    throw new Error(
      `sidecar conversation-state: ${CHECKPOINT_META_FILE} for ${agentKey} failed validation: ${validatedMeta.summary}; refusing to start the warm agent fresh on a corrupt checkpoint`,
    );
  }
  const snapshotRaw = await fs.promises.readFile(
    path.join(agentStateDir, CHECKPOINT_FILE),
    "utf8",
  );
  const snapshot = parseJsonOrThrow(
    snapshotRaw,
    `${agentKey} ${CHECKPOINT_FILE}`,
  );
  const validatedSnapshot = CheckpointSnapshot(snapshot);
  if (validatedSnapshot instanceof type.errors) {
    throw new Error(
      `sidecar conversation-state: ${CHECKPOINT_FILE} for ${agentKey} failed validation: ${validatedSnapshot.summary}; refusing to start the warm agent fresh on a corrupt checkpoint`,
    );
  }
  if (validatedSnapshot.turns.length !== validatedMeta.turnCount) {
    throw new Error(
      `sidecar conversation-state: ${CHECKPOINT_FILE} for ${agentKey} carries ${String(validatedSnapshot.turns.length)} turns but ${CHECKPOINT_META_FILE} reports turnCount ${String(validatedMeta.turnCount)}; the checkpoint pair is inconsistent`,
    );
  }
  return {
    turns: validatedSnapshot.turns,
    checkpointSeq: validatedMeta.checkpointSeq,
    metadata: {
      pendingOperations: validatedSnapshot.pendingOperations,
      tokenUsage: validatedSnapshot.tokenUsage,
      connectorState: validatedSnapshot.connectorState,
    },
  };
}

/**
 * Read and seq-order the per-boundary WAL entries for boundary seqs >=
 * `fromSeq` from `<agentStateDir>/wal/<bucket>/`. Throws on any unparseable
 * or out-of-shape WAL blob -- a corrupt WAL must surface, never be skipped.
 * Throws on a gap in the boundary seq sequence: a missing seq means a lost
 * append, which would silently drop a boundary's turns + metadata from the
 * reconstruction.
 */
async function readWalTailFromDir(
  agentStateDir: string,
  agentKey: string,
  fromSeq: number,
): Promise<
  { seq: number; turns: unknown[]; metadata: SnapshotMetadataValue }[]
> {
  const walDir = path.join(agentStateDir, WAL_DIR);
  let buckets: string[];
  try {
    buckets = await fs.promises.readdir(walDir);
  } catch (cause) {
    if (isErrnoNotFound(cause)) return [];
    throw cause;
  }
  const entries: {
    seq: number;
    turns: unknown[];
    metadata: SnapshotMetadataValue;
  }[] = [];
  for (const bucket of buckets) {
    const bucketDir = path.join(walDir, bucket);
    const files = await fs.promises.readdir(bucketDir);
    for (const file of files) {
      if (!file.endsWith(".json")) {
        throw new Error(
          `sidecar conversation-state: unexpected non-JSON WAL entry ${WAL_DIR}/${bucket}/${file} for ${agentKey}`,
        );
      }
      const raw = await fs.promises.readFile(
        path.join(bucketDir, file),
        "utf8",
      );
      const parsed = parseJsonOrThrow(
        raw,
        `${agentKey} ${WAL_DIR}/${bucket}/${file}`,
      );
      const validated = WalEntry(parsed);
      if (validated instanceof type.errors) {
        throw new Error(
          `sidecar conversation-state: WAL entry ${WAL_DIR}/${bucket}/${file} for ${agentKey} failed validation: ${validated.summary}; refusing to start the warm agent fresh on a corrupt WAL`,
        );
      }
      if (validated.seq < fromSeq) continue;
      entries.push({
        seq: validated.seq,
        turns: validated.turns,
        metadata: {
          pendingOperations: validated.metadata.pendingOperations,
          tokenUsage: validated.metadata.tokenUsage,
          connectorState: validated.metadata.connectorState,
        },
      });
    }
  }
  entries.sort((a, b) => a.seq - b.seq);
  for (let i = 0; i < entries.length; i += 1) {
    const expected = fromSeq + i;
    const entry = entries[i];
    if (entry === undefined || entry.seq !== expected) {
      throw new Error(
        `sidecar conversation-state: WAL for ${agentKey} has a seq gap (expected ${String(expected)}, found ${String(entry?.seq)}); a lost append would silently drop a boundary's turns and metadata`,
      );
    }
  }
  return entries;
}

function parseJsonOrThrow(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `sidecar conversation-state: ${label} is not valid JSON; refusing to start the warm agent fresh on a corrupt durable copy`,
      { cause },
    );
  }
}

export function isErrnoNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ENOENT"
  );
}
