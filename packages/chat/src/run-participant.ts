// Adds an already-launched run's address to a workbench's participant list.
// Membership is the one thing the chat orchestrator keys on to post a
// run's `connector.reply` into a workbench (see `chat-orchestrator.ts`'s
// `resolveMemberWorkbenches`), so a scheduled fire delivering into its
// workbench is exactly this join — no second posting path. Unlike
// `launchAndJoinAgent`, the run is launched elsewhere (the hub's native
// schedule poller or webhook ingress) and no join event is posted: a
// scheduled run's arrival in the workbench is its first reply, not a
// "joined" announcement.
import { addParticipant } from "./participants";
import type { ChatStore } from "./store";

export type JoinRunParticipantDeps = {
  readonly store: Pick<ChatStore, "mutateWorkbenchParticipants">;
};

export type JoinRunParticipantInput = {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly principalId: string;
  readonly address: string;
  readonly handle: string;
};

export async function joinRunParticipant(
  deps: JoinRunParticipantDeps,
  input: JoinRunParticipantInput,
): Promise<void> {
  // No pre-check read: `mutateWorkbenchParticipants` takes its own
  // locked read and throws (naming the workbench) if the row doesn't
  // exist, so a separate unlocked existence check here would only add
  // a second, redundant place for the same failure to surface.
  await deps.store.mutateWorkbenchParticipants({
    tenantId: input.tenantId,
    workbenchId: input.workbenchId,
    updatedBy: input.principalId,
    mutate: (participants) =>
      addParticipant(participants, input.address, input.handle),
  });
}
