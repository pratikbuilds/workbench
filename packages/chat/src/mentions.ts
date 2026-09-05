// The "@ + handle" mention rule: the single wire-level contract between
// the composer (`@corbits/chat-ui`'s `mentions.ts`, which derives
// candidates from a workbench's participant records and splices the
// picked handle into the draft) and this package's own fan-out
// (`routes.ts`'s `POST /workbenches/:id/messages`). Both sides work off
// the same `ParticipantRecord[]` (see `participants.ts`), so a message
// the composer thinks mentions a participant is always exactly the set
// the server fans a copy to — the handle is the friendly, settings-held
// mention name, never the instance-id local part.

import type { Part as PartType } from "./parts";
import type { ParticipantRecord } from "./participants";

/**
 * A participant is an agent address (mention-fannable) when it has the
 * `local@domain` shape every agent address has and is not a principal.
 * Humans are `prn_…` — bare or `prn_…@tenant.domain` — and read the
 * workbench's own timeline directly, so they are never fanned a copy.
 */
export function isAgentAddress(participant: string): boolean {
  return participant.includes("@") && !participant.startsWith("prn_");
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The participants an ordinary message @mentions, restricted to agent
 * addresses: the fan-out set for `POST /workbenches/:id/messages`. A
 * mention is structural — `@` followed by the participant's own handle
 * at a word boundary, appearing in any `TextPart` of the message — not
 * a full parse of mention syntax; kept minimal per the anchor-mailbox
 * rework's scope.
 */
export function mentionedParticipants(
  parts: readonly PartType[],
  participants: readonly ParticipantRecord[],
): string[] {
  const texts = parts
    .filter(
      (part): part is Extract<PartType, { kind: "text" }> =>
        part.kind === "text",
    )
    .map((part) => part.text);
  if (texts.length === 0) return [];
  return participants
    .filter((participant) => isAgentAddress(participant.address))
    .filter((participant) => {
      const mentionPattern = new RegExp(
        `@${escapeForRegExp(participant.handle)}\\b`,
      );
      return texts.some((text) => mentionPattern.test(text));
    })
    .map((participant) => participant.address);
}
