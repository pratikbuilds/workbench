// The Granola inbound-webhook connector card (CL-6028). Workbench is the
// secret *issuer* here — the reverse of the `granola` api-key connector
// above it in the grid, which stores a key Granola issued. This card
// surfaces `@corbits/webhook-triggers`' existing mint/rotate machinery
// against the tenant's `granola-call` workflow definition and its
// webhook triggers: no new secret code, no new backend route, just the
// Connections-surface view of an existing binding.
//
// "Granola-ish" means bound to the `granola-call` workflow definition
// specifically — the one automatable Granola workflow in
// `@workbench/templates` (`process-granola-call` is a child run,
// never a routine). A routine picker is deliberately not built: with
// exactly one candidate workflow, offering a picker over a list of one
// would be UI theater, not a real choice.

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  formatRelativeTime,
} from "@corbits/react-ui";
import type { ConnectorDescriptor } from "@corbits/connections/registry";
import { useEffect, useRef, useState } from "react";

import type { APIQuery } from "@corbits/api-query";
import {
  QueryView,
  UnauthenticatedError,
  describeQueryError,
} from "@corbits/api-query";
import {
  createGranolaWebhookTrigger,
  listGranolaWebhookTriggers,
  listGranolaWorkflowDefinitions,
  rotateGranolaWebhookTriggerSecret,
  sampleGranolaWebhookPayload,
  webhookTriggerUrl,
  type GranolaWebhookTrigger,
  type WorkflowDefinitionSummary,
} from "./granola-webhook-api";
import { SETTINGS_STRINGS } from "./strings";
import { CopyableCodeRow, WebhookSecretPanel } from "./webhook-secret-panel";

/** The one automatable Granola workflow — see this file's header comment. */
const GRANOLA_WORKFLOW_ASSET_NAME = "granola-call";

type GranolaBinding = {
  readonly definition: WorkflowDefinitionSummary;
  readonly webhookTrigger: GranolaWebhookTrigger | null;
};

type GranolaWebhookData = {
  readonly bindings: readonly GranolaBinding[];
};

function boundTriggers(
  bindings: readonly GranolaBinding[],
): readonly GranolaWebhookTrigger[] {
  return bindings
    .map((binding) => binding.webhookTrigger)
    .filter((trigger): trigger is GranolaWebhookTrigger => trigger !== null);
}

function mostRecentFiredAt(
  triggers: readonly GranolaWebhookTrigger[],
): string | null {
  const fired = triggers
    .map((trigger) => trigger.lastFiredAt)
    .filter((value): value is string => value !== null)
    .sort();
  return fired.length === 0 ? null : (fired[fired.length - 1] ?? null);
}

async function loadGranolaWebhookData(
  tenantId: string,
): Promise<GranolaWebhookData> {
  const [definitions, triggers] = await Promise.all([
    listGranolaWorkflowDefinitions(tenantId),
    listGranolaWebhookTriggers(tenantId),
  ]);
  const granolaDefinitions = definitions.filter(
    (definition) => definition.name === GRANOLA_WORKFLOW_ASSET_NAME,
  );
  const bindings = granolaDefinitions.map((definition) => ({
    definition,
    webhookTrigger:
      triggers.find(
        (trigger) => trigger.workflowDefinitionId === definition.id,
      ) ?? null,
  }));
  return { bindings };
}

export function GranolaWebhookCard({
  tenantId,
  descriptor,
}: {
  readonly tenantId: string;
  readonly descriptor: ConnectorDescriptor;
}) {
  const [query, setQuery] = useState<APIQuery<GranolaWebhookData>>({
    kind: "loading",
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  // A reload after a create/rotate refreshes the card's data in the
  // background — it must never flip the tree back through "loading",
  // which would unmount `GranolaWebhookDialog` and lose the just-revealed
  // secret it's showing.
  const loadedOnceRef = useRef(false);

  useEffect(() => {
    loadedOnceRef.current = false;
  }, [tenantId]);

  function reload() {
    setReloadKey((value) => value + 1);
  }

  useEffect(() => {
    let cancelled = false;
    if (!loadedOnceRef.current) setQuery({ kind: "loading" });
    loadGranolaWebhookData(tenantId)
      .then((data) => {
        if (cancelled) return;
        loadedOnceRef.current = true;
        setQuery({ kind: "ready", data });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof UnauthenticatedError) {
          setQuery({ kind: "unauthenticated" });
          return;
        }
        setQuery({
          kind: "error",
          message: describeQueryError(cause),
          retry: reload,
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, reloadKey]);

  return (
    <QueryView
      query={query}
      label={SETTINGS_STRINGS.connectionsWebhookLoadError}
    >
      {({ bindings }) => {
        const triggers = boundTriggers(bindings);
        const connected = triggers.length > 0;
        const lastFiredAt = mostRecentFiredAt(triggers);
        return (
          <>
            <div className="settings-connection-row">
              <span
                className="settings-connection-row-logo settings-connection-row-logo-initial"
                aria-hidden="true"
              >
                {descriptor.displayName.charAt(0).toUpperCase()}
              </span>
              <div className="settings-connection-row-text">
                <div className="settings-connection-row-name-row">
                  <span className="settings-connection-row-name">
                    {descriptor.displayName}
                  </span>
                  <span className="settings-connection-row-status">
                    {connected
                      ? SETTINGS_STRINGS.connectionsStatusConnected
                      : SETTINGS_STRINGS.connectionsWebhookNotSetUp}
                  </span>
                </div>
                {connected && (
                  <p className="settings-connection-row-caption">
                    {SETTINGS_STRINGS.connectionsWebhookTriggerCount(
                      triggers.length,
                    )}{" "}
                    ·{" "}
                    {lastFiredAt !== null
                      ? SETTINGS_STRINGS.connectionsWebhookLastDelivery(
                          formatRelativeTime(lastFiredAt),
                        )
                      : SETTINGS_STRINGS.connectionsWebhookNoDeliveries}
                  </p>
                )}
                <p className="settings-connection-row-caption">
                  {SETTINGS_STRINGS.connectionsWebhookDirectionNote}
                </p>
              </div>
              <div className="settings-connection-row-action">
                <Button
                  variant="ghost"
                  size="sm"
                  className="settings-connection-row-connect-action"
                  onClick={() => setDialogOpen(true)}
                >
                  {connected
                    ? SETTINGS_STRINGS.connectionsWebhookManageAction
                    : SETTINGS_STRINGS.connectionsWebhookSetUpAction}
                </Button>
              </div>
            </div>
            <GranolaWebhookDialog
              open={dialogOpen}
              tenantId={tenantId}
              bindings={bindings}
              onClose={() => setDialogOpen(false)}
              onChanged={reload}
            />
          </>
        );
      }}
    </QueryView>
  );
}

type RevealedSecret = {
  readonly definitionId: string;
  readonly url: string;
  readonly secret: string;
};

function GranolaWebhookDialog({
  open,
  tenantId,
  bindings,
  onClose,
  onChanged,
}: {
  readonly open: boolean;
  readonly tenantId: string;
  readonly bindings: readonly GranolaBinding[];
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const [revealed, setRevealed] = useState<RevealedSecret | null>(null);
  const [busyDefinitionId, setBusyDefinitionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setRevealed(null);
      setError(null);
      setBusyDefinitionId(null);
    }
  }, [open]);

  function handleCreate(definition: WorkflowDefinitionSummary) {
    setBusyDefinitionId(definition.id);
    setError(null);
    createGranolaWebhookTrigger(tenantId, definition.id, definition.name)
      .then((created) => {
        setRevealed({
          definitionId: definition.id,
          url: webhookTriggerUrl(created.id),
          secret: created.secret,
        });
        onChanged();
      })
      .catch((cause: unknown) => setError(describeQueryError(cause)))
      .finally(() => setBusyDefinitionId(null));
  }

  function handleRotate(binding: GranolaBinding) {
    const webhookTrigger = binding.webhookTrigger;
    if (webhookTrigger === null) return;
    setBusyDefinitionId(binding.definition.id);
    setError(null);
    rotateGranolaWebhookTriggerSecret(tenantId, webhookTrigger.id)
      .then((rotated) => {
        setRevealed({
          definitionId: binding.definition.id,
          url: webhookTriggerUrl(rotated.id),
          secret: rotated.secret,
        });
        onChanged();
      })
      .catch((cause: unknown) => setError(describeQueryError(cause)))
      .finally(() => setBusyDefinitionId(null));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {SETTINGS_STRINGS.connectionsWebhookDialogTitle}
          </DialogTitle>
          <DialogDescription>
            {SETTINGS_STRINGS.connectionsWebhookDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="settings-form-stack">
          {bindings.length === 0 ? (
            <p className="settings-inline-hint">
              {SETTINGS_STRINGS.connectionsWebhookNoRoutine}
            </p>
          ) : (
            bindings.map((binding) => (
              <div
                key={binding.definition.id}
                className="settings-webhook-routine-row"
              >
                <div className="settings-webhook-routine-row-header">
                  <span className="settings-connection-row-name">
                    {binding.definition.name}
                  </span>
                  {binding.webhookTrigger !== null && (
                    <span className="settings-connection-row-caption">
                      {binding.webhookTrigger.lastFiredAt !== null
                        ? SETTINGS_STRINGS.connectionsWebhookLastDelivery(
                            formatRelativeTime(
                              binding.webhookTrigger.lastFiredAt,
                            ),
                          )
                        : SETTINGS_STRINGS.connectionsWebhookNoDeliveries}
                    </span>
                  )}
                </div>
                {revealed?.definitionId === binding.definition.id ? (
                  <WebhookSecretPanel
                    url={revealed.url}
                    secret={revealed.secret}
                    samplePayload={sampleGranolaWebhookPayload()}
                  />
                ) : binding.webhookTrigger === null ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    disabled={busyDefinitionId === binding.definition.id}
                    onClick={() => handleCreate(binding.definition)}
                  >
                    {busyDefinitionId === binding.definition.id
                      ? SETTINGS_STRINGS.connectionsSaving
                      : SETTINGS_STRINGS.connectionsWebhookCreateAction}
                  </Button>
                ) : (
                  <div className="settings-form-stack">
                    <CopyableCodeRow
                      label={SETTINGS_STRINGS.connectionsWebhookHookUrlLabel}
                      value={webhookTriggerUrl(binding.webhookTrigger.id)}
                      copyLabel={SETTINGS_STRINGS.connectionsWebhookCopyHookUrl}
                    />
                    <div className="settings-webhook-field">
                      <span className="settings-webhook-field-label">
                        {SETTINGS_STRINGS.connectionsWebhookSigningSecretLabel}
                      </span>
                      <p className="settings-field-hint" role="status">
                        {SETTINGS_STRINGS.connectionsWebhookHiddenSecretNote}
                      </p>
                    </div>
                    <div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busyDefinitionId === binding.definition.id}
                        onClick={() => handleRotate(binding)}
                      >
                        {busyDefinitionId === binding.definition.id
                          ? SETTINGS_STRINGS.connectionsWebhookRotating
                          : SETTINGS_STRINGS.connectionsWebhookRotateAction}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
          {error !== null && (
            <p className="settings-inline-error" role="alert">
              {error}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {SETTINGS_STRINGS.connectionsCancel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
