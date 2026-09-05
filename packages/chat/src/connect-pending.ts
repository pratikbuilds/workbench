// The room-side ledger behind the in-room connect flow. A
// `connect-service` card posted into a room registers the connector on
// the room's own settings under `connections/pending`; when the
// connection completes in the browser, `settleConnectedService` finds
// every room in the tenant still waiting on that connector, clears the
// entry (publishing `chat.settings` so the open card flips), posts an
// event-only system notice onto the room timeline, and wakes the room's
// host agent via `dispatchTurn` — never by posting a human text bubble
// as the connecting person.
//
// The code-review template's own GitHub connect card registers
// under a second, template-owned key (`@workbench/templates`'s
// `template/pendingConnections`) instead of `connections/pending` — a
// credential completed anywhere other than that card's own submit (the
// Plugins page, another tab) never reached it. Rather than stand up a
// second settle path for that one key, this module settles both: a
// connector becoming connected is one event, and every room's settling
// belongs to one mechanism, not two parallel key conventions. A
// template-key-only match settles and notices without waking anyone —
// only a room whose own `connections/pending` named the connector had an
// agent waiting on it.
import { type } from "arktype";

import { localPartOf } from "./agent-address";
import { ConnectServiceBlockData } from "./blocks";
import { isAgentAddress } from "./mentions";
import type { Part as PartType } from "./parts";
import {
  postRoomMessage,
  type RoomMessage,
  type RoomMessageStore,
} from "./room-messages";
import type { ChatStore } from "./store";
import {
  dispatchTurn,
  type SendWorkbenchMessageDeps,
} from "./workbench-service";
import { participantsOf } from "./workbench-settings";

export const CONNECTIONS_PENDING_KEY = "connections/pending";

/** Timeline event name for the settle notice `settleConnectedService`
 * posts (CL-6741) — event-only, never a human text bubble. */
export const CONNECTION_CONNECTED_EVENT = "connection.connected";

/** The code-review template's own pending-connections key
 * (`@workbench/templates`'s `templateSettingsPatch`/
 * `templateReposSettingsPatch`) — a room minted from that template
 * tracks its GitHub card's pending state here instead of under
 * `CONNECTIONS_PENDING_KEY`. `settleConnectedService` knows this one
 * literal key so a credential settling still reaches that card, without
 * standing up a second, template-scoped settle function. */
const TEMPLATE_PENDING_CONNECTIONS_KEY = "template/pendingConnections";

const PendingConnections = type("string[]");

function pendingConnectionsAt(
  settings: Record<string, unknown>,
  key: string,
): readonly string[] {
  const parsed = PendingConnections(settings[key]);
  if (parsed instanceof type.errors) return [];
  return parsed;
}

export function pendingConnectionsOf(
  settings: Record<string, unknown>,
): readonly string[] {
  return pendingConnectionsAt(settings, CONNECTIONS_PENDING_KEY);
}

/** Connector ids named by `connect-service` block parts in a message —
 * parsed through the block's own schema so a malformed block registers
 * nothing. */
export function connectServiceConnectorIds(
  parts: readonly PartType[],
): readonly string[] {
  const ids: string[] = [];
  for (const part of parts) {
    if (part.kind !== "block" || part.block.type !== "connect-service") {
      continue;
    }
    const data = ConnectServiceBlockData(part.block.data);
    if (data instanceof type.errors) continue;
    if (!ids.includes(data.connectorId)) ids.push(data.connectorId);
  }
  return ids;
}

/** A curated MCP preset is pending as either its bare slug or the
 * `mcp:`-prefixed connector id its connection is minted under —
 * matching strips the prefix from both sides so the card settles
 * whichever spelling registered it. */
function bareConnectorId(connectorId: string): string {
  return connectorId.startsWith("mcp:")
    ? connectorId.slice("mcp:".length)
    : connectorId;
}

export type SettleConnectedServiceDeps = Pick<
  SendWorkbenchMessageDeps,
  "platform" | "agentTurns" | "roomMessages" | "publish"
> & {
  readonly store: Pick<
    ChatStore,
    "listWorkbenchSettings" | "updateWorkbenchSettings"
  >;
};

export type SettleConnectedServiceInput = {
  readonly tenantId: string;
  /** The person whose browser completed the connection. */
  readonly principalId: string;
  readonly connectorId: string;
  readonly displayName: string;
};

function hostAgentAddress(
  settings: Record<string, unknown>,
  principalId: string,
): string | undefined {
  return participantsOf(settings).find(
    (participant) =>
      isAgentAddress(participant.address) &&
      localPartOf(participant.address) !== principalId,
  )?.address;
}

function arrivalOrder(left: RoomMessage, right: RoomMessage): number {
  return left.createdAt === right.createdAt
    ? left.id.localeCompare(right.id)
    : left.createdAt.localeCompare(right.createdAt);
}

async function existingRequestMessageIds(
  roomMessages: Pick<RoomMessageStore, "listMessages">,
  input: { readonly tenantId: string; readonly workbenchId: string },
): Promise<readonly string[]> {
  const listed = await roomMessages.listMessages(input);
  const lastUser = listed.items.find(
    (message) => message.senderPrincipalId !== null,
  );
  const lastAgent = listed.items.find((message) => message.runId !== null);
  return [lastUser, lastAgent]
    .filter((message): message is RoomMessage => message !== undefined)
    .sort(arrivalOrder)
    .filter(
      (message, index, messages) =>
        messages.findIndex((other) => other.id === message.id) === index,
    )
    .map((message) => message.id);
}

export async function settleConnectedService(
  deps: SettleConnectedServiceDeps,
  input: SettleConnectedServiceInput,
): Promise<void> {
  const rows = await deps.store.listWorkbenchSettings(input.tenantId);
  const connected = bareConnectorId(input.connectorId);
  const isSettled = (entry: string) => bareConnectorId(entry) === connected;
  for (const row of rows) {
    const pending = pendingConnectionsOf(row.settings);
    const templatePending = pendingConnectionsAt(
      row.settings,
      TEMPLATE_PENDING_CONNECTIONS_KEY,
    );
    const matchedPending = pending.some(isSettled);
    const matchedTemplatePending = templatePending.some(isSettled);
    if (!matchedPending && !matchedTemplatePending) continue;

    const settingsPatch: Record<string, unknown> = { ...row.settings };
    if (matchedPending) {
      settingsPatch[CONNECTIONS_PENDING_KEY] = pending.filter(
        (entry) => !isSettled(entry),
      );
    }
    if (matchedTemplatePending) {
      settingsPatch[TEMPLATE_PENDING_CONNECTIONS_KEY] = templatePending.filter(
        (entry) => !isSettled(entry),
      );
    }
    const updated = await deps.store.updateWorkbenchSettings({
      tenantId: input.tenantId,
      workbenchId: row.workbenchId,
      settings: settingsPatch,
      updatedBy: input.principalId,
    });
    deps.publish(row.workbenchId, {
      type: "chat.settings",
      data: { updatedBy: input.principalId, settings: updated.settings },
    });

    // A room matched only through the template key never wakes an agent:
    // its walkthrough was posted by the product, not asked for by an
    // agent mid-turn, and the room's first agent participant may be a
    // reviewer whose prompt only speaks JSON. A code-review template
    // room never wakes on GitHub settle even when `connections/pending`
    // also names it (CL-6764): reviewers introduce themselves from
    // canned copy after start-reviewing, and dispatching the first
    // participant here is a credential-error bubble after a successful
    // Connect. A non-template room whose own `connections/pending`
    // names the connector did have an agent ask for it, so that agent
    // still gets woken.
    const agentAddress =
      matchedPending && row.settings["template/id"] !== "code-review"
        ? hostAgentAddress(updated.settings, input.principalId)
        : undefined;
    // CL-6741: event-only system row — never a signed-in user text bubble.
    // Sender is the woken agent when there is one; otherwise a synthetic
    // system address so the row never attributes to the connecting person.
    await postRoomMessage(deps, {
      tenantId: input.tenantId,
      workbenchId: row.workbenchId,
      sender: {
        name: null,
        address: agentAddress ?? `system@${row.workbenchId}`,
      },
      parts: [
        {
          kind: "event",
          event: CONNECTION_CONNECTED_EVENT,
          data: {
            connectorId: input.connectorId,
            displayName: input.displayName,
          },
        },
      ],
    });

    if (agentAddress === undefined) continue;

    const requestMessageIds = await existingRequestMessageIds(
      deps.roomMessages,
      { tenantId: input.tenantId, workbenchId: row.workbenchId },
    );
    await dispatchTurn(deps, {
      tenantId: input.tenantId,
      workbenchId: row.workbenchId,
      principalId: input.principalId,
      agentAddress,
      parts: [
        {
          kind: "text",
          text: `${input.displayName} is connected now — go ahead.`,
        },
      ],
      requestMessageIds,
    });
  }
}
