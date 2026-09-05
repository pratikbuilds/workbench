// The "invite agent" affordance: a small dialog listing the tenant's
// deployed, launchable workflow definitions (never the workbench's own
// host — the server-side list already excludes it), each with an
// "Invite" action that launches it into the current workbench. The list
// itself carries its own loading/empty/error states since it is fetched
// fresh every time the dialog opens. When Jimmy has never been created
// in this tenant, an extra "Add Jimmy" row offers to create and invite
// him in one click — see `quickCreateJimmy` in `./api`.

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Skeleton,
} from "@corbits/react-ui";
import { Users, WarningCircle } from "@corbits/icons";
import { useEffect, useState } from "react";

import { deriveDisplayName } from "@corbits/chat/display-name";
import {
  ChatApiError,
  describeChatError,
  JIMMY_QUICK_CREATE,
  listInvitableDefinitions,
  quickCreateJimmy,
} from "./api";
import type { InvitableDefinition } from "./api";
import { CHAT_STRINGS } from "./strings";

// A sentinel `invitingId` distinct from any real definition id — lets the
// "Add Jimmy" row show its own "Adding…" state while `quickCreateJimmy`
// runs, before a real definition id exists to key off of.
const JIMMY_QUICK_CREATE_MARKER = "jimmy-quick-create";

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly InvitableDefinition[] };

export function InviteAgentDialog({
  open,
  onOpenChange,
  tenantId,
  workbenchId,
  onInvite,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly onInvite: (definitionId: string) => Promise<void>;
}) {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [invitingId, setInvitingId] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ kind: "loading" });
    setInviteError(null);
    listInvitableDefinitions(tenantId, workbenchId)
      .then((items) => {
        if (!cancelled) setState({ kind: "ready", items });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: describeChatError(cause, "Couldn't load agents."),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, tenantId, workbenchId]);

  async function handleInvite(definitionId: string) {
    setInvitingId(definitionId);
    setInviteError(null);
    try {
      await onInvite(definitionId);
      onOpenChange(false);
    } catch (cause) {
      setInviteError(
        cause instanceof ChatApiError && cause.status === 409
          ? CHAT_STRINGS.inviteAgentConflictError
          : CHAT_STRINGS.inviteAgentInviteError,
      );
    } finally {
      setInvitingId(null);
    }
  }

  /**
   * Jimmy is no longer seeded by a workbench template (CL-6499: he is not
   * a "kind of workbench") — this row is his one remaining create path.
   * Creating him mints a real, tenant-wide agent-directory definition,
   * exactly like a template's participant create did; inviting him into
   * this workbench reuses `handleInvite`'s own state and error handling.
   */
  async function handleQuickCreateJimmy() {
    setInvitingId(JIMMY_QUICK_CREATE_MARKER);
    setInviteError(null);
    try {
      const created = await quickCreateJimmy(tenantId);
      await handleInvite(created.id);
    } catch {
      setInviteError(CHAT_STRINGS.inviteAgentQuickCreateError);
      setInvitingId(null);
    }
  }

  const jimmyMissing =
    state.kind === "ready" &&
    !state.items.some((item) => item.name === JIMMY_QUICK_CREATE.handle);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent side="right">
        <DialogHeader>
          <DialogTitle>{CHAT_STRINGS.inviteAgentDialogTitle}</DialogTitle>
          <DialogDescription>
            {CHAT_STRINGS.inviteAgentDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {inviteError !== null && (
            <p className="chat-dialog-error" role="alert">
              {inviteError}
            </p>
          )}
          {state.kind === "loading" ? (
            <Skeleton className="query-skeleton" />
          ) : state.kind === "error" ? (
            <EmptyState
              icon={<WarningCircle />}
              title={CHAT_STRINGS.inviteAgentLoadError}
              description={state.message}
            />
          ) : state.items.length === 0 && !jimmyMissing ? (
            <EmptyState
              icon={<Users />}
              title={CHAT_STRINGS.inviteAgentEmptyTitle}
              description={CHAT_STRINGS.inviteAgentEmptyDescription}
            />
          ) : (
            <ul className="chat-invitable-list">
              {state.items.map((definition) => {
                // One canonical rule for "what does this agent look like
                // to a person" (CL-6424) — the description when one was
                // set at creation, else a humanized reading of the
                // immutable slug — never a scattered reimplementation
                // that could drift (or leak an internal id as a fake
                // name) beside `@corbits/chat/display-name`.
                const displayName = deriveDisplayName({
                  name: definition.name,
                  ...(definition.description !== undefined
                    ? { description: definition.description }
                    : {}),
                });
                return (
                  <li
                    key={definition.id}
                    className="chat-invitable-item"
                    data-testid="invitable-definition"
                  >
                    <span className="chat-invitable-item-name">
                      {displayName}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={invitingId !== null}
                      onClick={() => void handleInvite(definition.id)}
                    >
                      {invitingId === definition.id
                        ? CHAT_STRINGS.inviteAgentInviting
                        : CHAT_STRINGS.inviteAgentAction}
                    </Button>
                  </li>
                );
              })}
              {jimmyMissing && (
                <li
                  className="chat-invitable-item"
                  data-testid="quick-create-jimmy"
                >
                  <span className="chat-invitable-item-info">
                    <span className="chat-invitable-item-name">
                      {JIMMY_QUICK_CREATE.name}
                      <span className="chat-invitable-item-attribution">
                        {CHAT_STRINGS.inviteAgentFirstPartyAttribution}
                      </span>
                    </span>
                    <span className="chat-invitable-item-description">
                      {JIMMY_QUICK_CREATE.description}
                    </span>
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={invitingId !== null}
                    onClick={() => void handleQuickCreateJimmy()}
                  >
                    {invitingId === JIMMY_QUICK_CREATE_MARKER
                      ? CHAT_STRINGS.inviteAgentQuickCreating
                      : CHAT_STRINGS.inviteAgentQuickCreateAction}
                  </Button>
                </li>
              )}
            </ul>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
