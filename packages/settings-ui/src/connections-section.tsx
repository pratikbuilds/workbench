// The "Connections" settings section: a status grid over every connector
// this bench can talk to (inference providers, tool-package api keys, and
// the two existing OAuth connectors), plus the raw credentials table as an
// "Advanced" escape hatch for credential types no connector card covers
// (a certificate, an `other`-typed row).

import {
  Button,
  ConfirmButton,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  InfoTooltip,
  Input,
  SettingsPanel,
  toast,
} from "@corbits/react-ui";
import {
  connectorDescriptors,
  type ConnectorDescriptor,
} from "@corbits/connections/registry";
import { workflowDisplayName } from "@workbench/templates";
import {
  CONNECTOR_REGISTRY,
  MCP_PRESET_CONNECTOR_IDS,
} from "@workbench/templates/connectors";
import {
  buildEffectiveInferenceRows,
  computeGlobalRoutePatches,
  computeMakeDefaultPatches,
  getResolvedCatalog,
  listOwnOfferings,
  orderedGlobalInferenceRows,
  providerDisplayName,
  updateOwnOffering,
  type EffectiveInferenceRow,
} from "@corbits/inference-settings";
import type { ModelInfo } from "@intx/types";
import { ArrowDown, ArrowUp, Cpu, Plugs, Robot } from "@corbits/icons";
import { useEffect, useState } from "react";

import type { APIQuery } from "@corbits/api-query";
import {
  QueryView,
  UnauthenticatedError,
  describeQueryError,
} from "@corbits/api-query";
import {
  ConnectionsApiError,
  completeConnectorCredential,
  disconnectConnector,
  fetchOAuthConfigured,
} from "./connections-api";
import { CONNECTOR_PINNED_WORKFLOWS } from "./connections-pinned-by";
import {
  connectorStatus,
  type ConnectorStatusResult,
} from "./connections-status";
import {
  listCredentials,
  listProviders,
  type Credential,
  type Provider,
} from "./credentials-api";
import { SETTINGS_STRINGS } from "./strings";

// `@corbits/connections/registry` is the only subpath this browser
// bundle may import — its main export pulls in server-only hono routing.

type OAuthConnectorCard = {
  readonly id: "openrouter" | "huggingface";
  readonly displayName: string;
};

const OAUTH_CARDS: readonly OAuthConnectorCard[] = [
  { id: "openrouter", displayName: "OpenRouter" },
  { id: "huggingface", displayName: "Hugging Face" },
];

/**
 * Exported so other surfaces (the plugins gallery's connect panel) can
 * send every OAuth-capable connector through the same tenant-scoped
 * `connections/oauth` mount instead of re-deriving this URL. Onboarding's
 * own `/api/onboarding/oauth/...` mount serves only its first-login
 * OpenRouter/Hugging Face flow and is never a connect surface's target
 * (CL-6394).
 */
export function oauthStartHref(
  tenantId: string,
  connectorId: string,
  returnPath = "/settings/connections",
): string {
  return `/api/tenants/${tenantId}/connections/oauth/${connectorId}/start?return=${encodeURIComponent(returnPath)}`;
}

type ConnectionsData = {
  readonly credentials: readonly Credential[];
  readonly providers: readonly Provider[];
  readonly oauthConfigured: Readonly<Record<string, boolean>>;
  /** The resolved model catalog — read only to derive each connected
   * inference provider's one default model (CL-6258's replacement for
   * the removed Models settings page; see `defaultModelForProvider`'s
   * own header for why this is never a second, hand-maintained notion of
   * "the" model). */
  readonly models: readonly ModelInfo[];
  /** This tenant's own offering ids — the provenance source for which of
   * `models`' offerings a default-model pick can actually PATCH (only a
   * "set-here" offering; see `computeMakeDefaultPatches`). */
  readonly ownOfferingIds: ReadonlySet<string>;
};

/**
 * The api-key connector row list, on its own: every credentials/providers
 * fetch, the connect/reconnect dialog, and disconnect all owned here so
 * a caller only supplies the data it already has and a place to send a
 * reload/error signal. `ConnectionsSection` composes this with the OAuth
 * row pair and the advanced credentials table for the full Settings >
 * Connections page — its one consumer today. The onboarding wizard's own
 * "Connect your tools" step (CL-6028), which once rendered this alone
 * filtered to `feedsTools`-bearing connectors, was dropped in CL-6104:
 * connecting tools now lives only in Settings and the Plugins gallery,
 * never in onboarding. Renders bare `ConnectorRow`s — not wrapped in
 * `.settings-connections-list` itself — so a caller controls the list
 * container (and can put other rows, like the OAuth pair, in the same
 * list alongside these).
 */
export function ConnectorRowList({
  tenantId,
  credentials,
  providers,
  models,
  ownOfferingIds,
  filter,
  onReload,
  onError,
  onConnected,
}: {
  readonly tenantId: string;
  readonly credentials: readonly Credential[];
  readonly providers: readonly Provider[];
  readonly models: readonly ModelInfo[];
  readonly ownOfferingIds: ReadonlySet<string>;
  /** Narrows which registry entries render a row. Defaults to every
   * api-key connector (every entry with a `probe`) — OAuth connectors
   * are never included here regardless of filter, since this list has
   * no OAuth flow of its own. */
  readonly filter?: (descriptor: ConnectorDescriptor) => boolean;
  readonly onReload: () => void;
  readonly onError?: (message: string | null) => void;
  /** Fires only on a successful connect — never on disconnect/revoke —
   * for callers that need to distinguish "something got connected this
   * session" from "the list changed." */
  readonly onConnected?: () => void;
}) {
  const [dialogDescriptor, setDialogDescriptor] =
    useState<ConnectorDescriptor | null>(null);
  const [dialogMode, setDialogMode] = useState<"connect" | "reconnect">(
    "connect",
  );

  function handleDisconnect(connectorId: string) {
    onError?.(null);
    disconnectConnector(tenantId, connectorId)
      .then(() => {
        onReload();
        toast(SETTINGS_STRINGS.credentialRevokedToast);
      })
      .catch(() => onError?.(SETTINGS_STRINGS.connectionsDisconnectError));
  }

  const descriptors = connectorDescriptors(CONNECTOR_REGISTRY)
    .filter((descriptor) => descriptor.probe !== undefined)
    .filter((descriptor) => !MCP_PRESET_CONNECTOR_IDS.includes(descriptor.id))
    .filter(filter ?? (() => true));

  const effectiveRows = buildEffectiveInferenceRows(models, ownOfferingIds);

  return (
    <>
      {descriptors.map((descriptor) => (
        <ConnectorRow
          key={descriptor.id}
          descriptor={descriptor}
          statusResult={connectorStatus(descriptor.id, credentials, providers)}
          modelCount={
            new Set(
              effectiveRows
                .filter((row) => row.providerName === descriptor.id)
                .map((row) => row.canonicalName),
            ).size
          }
          onConnect={() => {
            setDialogMode("connect");
            setDialogDescriptor(descriptor);
          }}
          onReconnect={() => {
            setDialogMode("reconnect");
            setDialogDescriptor(descriptor);
          }}
          onDisconnect={() => handleDisconnect(descriptor.id)}
        />
      ))}
      <ConnectorCredentialDialog
        descriptor={dialogDescriptor}
        mode={dialogMode}
        tenantId={tenantId}
        onClose={() => setDialogDescriptor(null)}
        onConnected={() => {
          setDialogDescriptor(null);
          onReload();
          onConnected?.();
        }}
      />
    </>
  );
}

export function ConnectionsSection({
  tenantId,
}: {
  readonly tenantId: string | null;
}) {
  const [query, setQuery] = useState<APIQuery<ConnectionsData>>({
    kind: "loading",
  });
  const [reloadKey, setReloadKey] = useState(0);
  const [rowError, setRowError] = useState<string | null>(null);

  function reload() {
    setReloadKey((value) => value + 1);
  }

  useEffect(() => {
    if (tenantId === null) return;
    let cancelled = false;
    setQuery({ kind: "loading" });
    Promise.all([
      listCredentials(tenantId),
      listProviders(tenantId),
      fetchOAuthConfigured(tenantId),
      getResolvedCatalog(tenantId),
      listOwnOfferings(tenantId),
    ])
      .then(
        ([credentials, providers, oauthConfigured, models, ownOfferings]) => {
          if (!cancelled)
            setQuery({
              kind: "ready",
              data: {
                credentials,
                providers,
                oauthConfigured,
                models,
                ownOfferingIds: new Set(
                  ownOfferings.map((offering) => offering.id),
                ),
              },
            });
        },
      )
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

  // Connections can change elsewhere (another tab, the Plugins gallery's
  // connect panel, or a credential expiring during a long agent run).
  // Re-read on visibility/focus and poll while the page sits open so a
  // "Connected" pill never lies silently — the same live-surface concern
  // that `ConnectServiceBlockContainer` and `ConnectGithubBlockContainer`
  // solve via `subscribeConnectState`.
  useEffect(() => {
    if (tenantId === null) return;
    // `visibilitychange` and `focus` both fire in the same tick when a tab
    // regains focus; the microtask guard collapses that pair into one
    // scheduled bump instead of two back-to-back reloads.
    let bumpScheduled = false;
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (bumpScheduled) return;
      bumpScheduled = true;
      queueMicrotask(() => {
        bumpScheduled = false;
        setReloadKey((value) => value + 1);
      });
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    const interval = setInterval(refreshWhenVisible, 30_000);
    return () => {
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
      clearInterval(interval);
    };
  }, [tenantId]);

  if (tenantId === null) {
    return (
      <EmptyState
        title={SETTINGS_STRINGS.benchNoneSelectedTitle}
        description={SETTINGS_STRINGS.benchNoneSelectedDescription}
      />
    );
  }

  const currentTenantId = tenantId;

  // The row list's and OAuth pair's disconnect action — a connector, not
  // a raw credential, so it goes through `disconnectConnector`'s
  // orchestrated cleanup (catalog provider, then credential provider —
  // see that function's own header for why a direct credential delete
  // 500s for an inference provider, CL-6258).
  function handleDisconnectConnector(connectorId: string) {
    setRowError(null);
    disconnectConnector(currentTenantId, connectorId)
      .then(() => {
        reload();
        toast(SETTINGS_STRINGS.credentialRevokedToast);
      })
      .catch(() => setRowError(SETTINGS_STRINGS.connectionsDisconnectError));
  }

  return (
    <QueryView query={query} label={SETTINGS_STRINGS.connectionsLoadError}>
      {({
        credentials,
        providers,
        oauthConfigured,
        models,
        ownOfferingIds,
      }) => {
        const effectiveRows = buildEffectiveInferenceRows(
          models,
          ownOfferingIds,
        );
        return (
          <SettingsPanel
            title={SETTINGS_STRINGS.connectionsSectionTitle}
            description={SETTINGS_STRINGS.connectionsSectionDescription}
          >
            {rowError !== null && (
              <p className="settings-inline-error" role="alert">
                {rowError}
              </p>
            )}
            <ModelRoutePanel
              tenantId={currentTenantId}
              rows={effectiveRows}
              onReload={reload}
              onError={setRowError}
            />
            <section className="settings-provider-section">
              <div className="settings-provider-section-heading">
                <span className="settings-provider-section-icon" aria-hidden>
                  <Plugs />
                </span>
                <div>
                  <h3>AI providers</h3>
                  <p>Connect the services that can run your models.</p>
                </div>
              </div>
              <div className="settings-connections-list">
                <ConnectorRowList
                  tenantId={currentTenantId}
                  credentials={credentials}
                  providers={providers}
                  models={models}
                  ownOfferingIds={ownOfferingIds}
                  filter={(descriptor) => descriptor.feedsTools.length === 0}
                  onReload={reload}
                  onError={setRowError}
                />
                {OAUTH_CARDS.map((card) => (
                  <OAuthConnectorRow
                    key={card.id}
                    tenantId={currentTenantId}
                    card={card}
                    statusResult={connectorStatus(
                      card.id,
                      credentials,
                      providers,
                    )}
                    modelCount={
                      new Set(
                        effectiveRows
                          .filter((row) => row.providerName === card.id)
                          .map((row) => row.canonicalName),
                      ).size
                    }
                    configured={oauthConfigured[card.id] ?? false}
                    onDisconnect={() => handleDisconnectConnector(card.id)}
                  />
                ))}
              </div>
            </section>
          </SettingsPanel>
        );
      }}
    </QueryView>
  );
}

function modelLabel(row: EffectiveInferenceRow): string {
  return row.modelDisplayName ?? row.canonicalName;
}

function ModelRoutePanel({
  tenantId,
  rows,
  onReload,
  onError,
}: {
  readonly tenantId: string;
  readonly rows: readonly EffectiveInferenceRow[];
  readonly onReload: () => void;
  readonly onError: (message: string | null) => void;
}) {
  const ordered = orderedGlobalInferenceRows(rows);
  const currentModel = ordered[0]?.canonicalName ?? "";
  const models = ordered.filter(
    (row, index, all) =>
      all.findIndex(
        (candidate) => candidate.canonicalName === row.canonicalName,
      ) === index,
  );
  const route = ordered.filter((row) => row.canonicalName === currentModel);

  function applyPatches(
    patches:
      | readonly { readonly offeringId: string; readonly priority: number }[]
      | null,
  ) {
    if (patches === null) {
      onError(SETTINGS_STRINGS.connectionsSetDefaultModelError);
      return;
    }
    onError(null);
    Promise.all(
      patches.map((patch) =>
        updateOwnOffering(tenantId, patch.offeringId, {
          priority: patch.priority,
        }),
      ),
    )
      .then(onReload)
      .catch(() => onError(SETTINGS_STRINGS.connectionsSetDefaultModelError));
  }

  function chooseModel(canonicalName: string) {
    // Tenant default is an offering-priority write only (CL-6782). Existing
    // agents keep whatever `capabilities.model` they already store; new
    // agents may still pick up the default at create. Never PATCH
    // `/agent-definitions`.
    const target = ordered.find((row) => row.canonicalName === canonicalName);
    applyPatches(
      target === undefined
        ? null
        : computeMakeDefaultPatches(rows, target.offeringId),
    );
  }

  return (
    <section
      className="settings-model-route"
      aria-labelledby="model-route-title"
    >
      <div className="settings-model-route-heading">
        <span className="settings-model-route-icon" aria-hidden>
          <Cpu />
        </span>
        <div>
          <h3 id="model-route-title">Default model & fallbacks</h3>
          <p>
            Used by Myra and new agents. Changing the default does not rewrite
            models already stored on existing agents.
          </p>
        </div>
      </div>
      {ordered.length === 0 ? (
        <div className="settings-model-route-empty">
          <Robot aria-hidden />
          <span>Connect an AI provider to choose a default model.</span>
        </div>
      ) : (
        <>
          <label className="settings-model-default-field">
            <span>Default model</span>
            <select
              aria-label="Default model"
              value={currentModel}
              onChange={(event) => chooseModel(event.target.value)}
            >
              {models.map((row) => (
                <option key={row.canonicalName} value={row.canonicalName}>
                  {modelLabel(row)}
                </option>
              ))}
            </select>
          </label>
          <div
            className="settings-model-route-list"
            aria-label="Fallback order"
          >
            <p className="settings-model-route-list-label">Fallback order</p>
            {route.map((row, index) => (
              <div className="settings-model-route-row" key={row.offeringId}>
                <span className="settings-model-route-position">
                  {index === 0 ? "Primary" : `Fallback ${index}`}
                </span>
                <span className="settings-model-route-provider">
                  {providerDisplayName(row.providerName)}
                </span>
                <span className="settings-model-route-provenance">
                  {row.provenance === "set-here" ? "Set here" : "Inherited"}
                </span>
                <div className="settings-model-route-actions">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Move ${providerDisplayName(row.providerName)} up`}
                    disabled={index === 0 || row.provenance === "inherited"}
                    onClick={() =>
                      applyPatches(
                        computeGlobalRoutePatches(route, row.offeringId, "up"),
                      )
                    }
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Move ${providerDisplayName(row.providerName)} down`}
                    disabled={
                      index === route.length - 1 ||
                      row.provenance === "inherited"
                    }
                    onClick={() =>
                      applyPatches(
                        computeGlobalRoutePatches(
                          route,
                          row.offeringId,
                          "down",
                        ),
                      )
                    }
                  >
                    <ArrowDown />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function pinnedByLine(connectorId: string): string {
  const assetNames = CONNECTOR_PINNED_WORKFLOWS[connectorId] ?? [];
  if (assetNames.length === 0) return SETTINGS_STRINGS.connectionsPinnedByNone;
  const names = assetNames.map((assetName) => workflowDisplayName(assetName));
  return `${SETTINGS_STRINGS.connectionsPinnedByPrefix}${names.join(", ")}`;
}

/** Plain, uppercase status text — never a colored pill. Needs-attention is
 * the one accent-colored state on this row (the owner's brand rule: grey
 * for text/structure, the accent color only ever marks something to act
 * on), matching the plugins directory's own `plugins-directory-needs-
 * attention` convention. */
function StatusCaption({
  statusResult,
}: {
  readonly statusResult: ConnectorStatusResult;
}) {
  if (statusResult.status === "connected") {
    return (
      <span className="settings-connection-row-status">
        {SETTINGS_STRINGS.connectionsStatusConnected}
      </span>
    );
  }
  if (statusResult.status === "needs_attention") {
    return (
      <span className="settings-connection-row-status settings-connection-row-status-attention">
        {SETTINGS_STRINGS.connectionsStatusNeedsAttention}
      </span>
    );
  }
  return (
    <span className="settings-connection-row-status">
      {SETTINGS_STRINGS.connectionsStatusNotConnected}
    </span>
  );
}

/** The row's brand mark: a connector's `simple-icons` path where the
 * registry has one, a monochrome initial tile otherwise — the same tile
 * pattern (zero radius, hairline border) the plugins directory's own
 * `PluginLogo` uses (`packages/chat-ui/src/workbench-settings/plugins-
 * section.tsx`), reused here rather than re-derived (CL-6258). */
function ConnectorLogo({
  displayName,
  icon,
}: {
  readonly displayName: string;
  readonly icon?: {
    readonly path: string;
    readonly hex: string;
    readonly viewBox?: string;
  };
}) {
  if (icon !== undefined) {
    return (
      <span className="settings-connection-row-logo" aria-hidden="true">
        <svg
          viewBox={icon.viewBox ?? "0 0 24 24"}
          width="16"
          height="16"
          fill={`#${icon.hex}`}
        >
          <path d={icon.path} />
        </svg>
      </span>
    );
  }
  return (
    <span
      className="settings-connection-row-logo settings-connection-row-logo-initial"
      aria-hidden="true"
    >
      {displayName.charAt(0).toUpperCase()}
    </span>
  );
}

function ConnectorRow({
  descriptor,
  statusResult,
  modelCount,
  onConnect,
  onReconnect,
  onDisconnect,
}: {
  readonly descriptor: ConnectorDescriptor;
  readonly statusResult: ConnectorStatusResult;
  readonly modelCount: number;
  readonly onConnect: () => void;
  readonly onReconnect: () => void;
  readonly onDisconnect: () => void;
}) {
  return (
    <div className="settings-connection-row">
      <ConnectorLogo
        displayName={descriptor.displayName}
        {...(descriptor.icon !== undefined ? { icon: descriptor.icon } : {})}
      />
      <div className="settings-connection-row-text">
        <div className="settings-connection-row-name-row">
          <span className="settings-connection-row-name">
            {descriptor.displayName}
          </span>
          <StatusCaption statusResult={statusResult} />
        </div>
        {statusResult.status === "connected" && modelCount > 0 ? (
          <p className="settings-connection-row-caption">
            {modelCount} model{modelCount === 1 ? "" : "s"} available
          </p>
        ) : null}
        {descriptor.feedsTools.length > 0 && (
          <span className="settings-connection-row-pinned-row">
            <span className="settings-connection-row-caption">
              {pinnedByLine(descriptor.id)}
            </span>
            {(CONNECTOR_PINNED_WORKFLOWS[descriptor.id]?.length ?? 0) > 0 && (
              <InfoTooltip
                label={SETTINGS_STRINGS.connectionsPinnedByApproximationNote}
                triggerLabel={`How "${pinnedByLine(descriptor.id)}" is determined`}
              />
            )}
          </span>
        )}
      </div>
      <div className="settings-connection-row-action">
        {statusResult.status === "connected" && (
          <ConfirmButton
            variant="ghost"
            size="sm"
            className="settings-connection-row-disconnect-action"
            confirmLabel={SETTINGS_STRINGS.connectionsDisconnectConfirm}
            onConfirm={onDisconnect}
          >
            {SETTINGS_STRINGS.connectionsDisconnectAction}
          </ConfirmButton>
        )}
        {statusResult.status === "not_connected" && (
          <Button
            variant="ghost"
            size="sm"
            className="settings-connection-row-connect-action"
            onClick={onConnect}
          >
            {SETTINGS_STRINGS.connectionsConnectAction}
          </Button>
        )}
        {statusResult.status === "needs_attention" && (
          <Button
            variant="ghost"
            size="sm"
            className="settings-connection-row-connect-action"
            onClick={onReconnect}
          >
            {SETTINGS_STRINGS.connectionsReconnectAction}
          </Button>
        )}
      </div>
    </div>
  );
}

function OAuthConnectorRow({
  tenantId,
  card,
  statusResult,
  modelCount,
  configured,
  onDisconnect,
}: {
  readonly tenantId: string;
  readonly card: OAuthConnectorCard;
  readonly statusResult: ConnectorStatusResult;
  readonly modelCount: number;
  /** Whether an operator has registered this connector's OAuth app
   * (a client id present server-side) — distinct from `statusResult`,
   * which is about whether *this tenant* has connected, not whether
   * connecting is even possible yet. */
  readonly configured: boolean;
  readonly onDisconnect: () => void;
}) {
  const icon = CONNECTOR_REGISTRY[card.id]?.icon;

  // An unconfigured connector never gets a live Connect button, even
  // when this tenant already holds a (now-orphaned) credential for it —
  // there is no OAuth app to round-trip through until an operator
  // registers one, so the muted state wins regardless of `statusResult`.
  if (!configured) {
    return (
      <div className="settings-connection-row settings-connection-row-muted">
        <ConnectorLogo
          displayName={card.displayName}
          {...(icon !== undefined ? { icon } : {})}
        />
        <div className="settings-connection-row-text">
          <div className="settings-connection-row-name-row">
            <span className="settings-connection-row-name">
              {card.displayName}
            </span>
            <span className="settings-connection-row-status">
              {SETTINGS_STRINGS.connectionsStatusNotConfigured}
            </span>
          </div>
          <p className="settings-connection-row-caption">
            {SETTINGS_STRINGS.connectionsNotConfiguredHint}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-connection-row">
      <ConnectorLogo
        displayName={card.displayName}
        {...(icon !== undefined ? { icon } : {})}
      />
      <div className="settings-connection-row-text">
        <div className="settings-connection-row-name-row">
          <span className="settings-connection-row-name">
            {card.displayName}
          </span>
          <StatusCaption statusResult={statusResult} />
        </div>
        {statusResult.status === "connected" && modelCount > 0 ? (
          <p className="settings-connection-row-caption">
            {modelCount} model{modelCount === 1 ? "" : "s"} available
          </p>
        ) : null}
      </div>
      <div className="settings-connection-row-action">
        {statusResult.status === "connected" ? (
          <ConfirmButton
            variant="ghost"
            size="sm"
            className="settings-connection-row-disconnect-action"
            confirmLabel={SETTINGS_STRINGS.connectionsDisconnectConfirm}
            onConfirm={onDisconnect}
          >
            {SETTINGS_STRINGS.connectionsDisconnectAction}
          </ConfirmButton>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="settings-connection-row-connect-action"
            asChild
          >
            <a href={oauthStartHref(tenantId, card.id)}>
              {statusResult.status === "needs_attention"
                ? SETTINGS_STRINGS.connectionsReconnectAction
                : SETTINGS_STRINGS.connectionsConnectAction}
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}

export function ConnectorCredentialDialog({
  descriptor,
  mode,
  tenantId,
  onClose,
  onConnected,
}: {
  readonly descriptor: ConnectorDescriptor | null;
  readonly mode: "connect" | "reconnect";
  readonly tenantId: string;
  readonly onClose: () => void;
  readonly onConnected: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const isUrlField = descriptor?.credentialInputKind === "url";

  useEffect(() => {
    setApiKey(
      descriptor?.credentialInputKind === "url"
        ? (descriptor.credentialPlaceholder ?? "")
        : "",
    );
    setShowKey(false);
    setSubmitting(false);
    setSubmitError(null);
  }, [descriptor]);

  const open = descriptor !== null;
  const canSubmit = apiKey.trim() !== "" && !submitting;

  // One action, not test-then-save (CL-6377): the server proves the key
  // with a real call before ever storing it, so a rejected key never gets
  // sealed — this call is the only round-trip, and its 422 rejection
  // renders inline the same as any other connect failure.
  function handleSubmit() {
    if (descriptor === null) return;
    setSubmitting(true);
    setSubmitError(null);
    completeConnectorCredential(tenantId, descriptor.id, apiKey)
      .then((completed) => {
        // CL-6351: a fresh Ollama connect with only an embedding model
        // pulled still succeeds — `modelGuidance` says so in the same
        // consumer language the "connected" toast normally would,
        // instead of the generic success line.
        toast(
          completed.modelGuidance ??
            SETTINGS_STRINGS.connectionsConnectedToast(descriptor.displayName),
        );
        onConnected();
      })
      .catch((cause: unknown) => {
        setSubmitError(
          cause instanceof ConnectionsApiError && cause.status === 422
            ? cause.message
            : describeQueryError(cause),
        );
      })
      .finally(() => setSubmitting(false));
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
            {descriptor === null
              ? ""
              : mode === "reconnect"
                ? SETTINGS_STRINGS.connectionsDialogReconnectTitle(
                    descriptor.displayName,
                  )
                : SETTINGS_STRINGS.connectionsDialogConnectTitle(
                    descriptor.displayName,
                  )}
          </DialogTitle>
          <DialogDescription>
            {isUrlField
              ? SETTINGS_STRINGS.connectionsDialogUrlDescription
              : SETTINGS_STRINGS.connectionsDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="settings-form-stack">
          <div className="settings-form-field">
            <span>
              {isUrlField
                ? SETTINGS_STRINGS.connectionsUrlLabel
                : SETTINGS_STRINGS.connectionsKeyLabel}
            </span>
            {isUrlField ? (
              <Input
                type="text"
                placeholder={descriptor?.credentialPlaceholder}
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setSubmitError(null);
                }}
                autoComplete="off"
              />
            ) : (
              <div className="settings-secret-row">
                <Input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setSubmitError(null);
                  }}
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowKey((value) => !value)}
                >
                  {showKey ? "Hide" : "Show"}
                </Button>
              </div>
            )}
          </div>
          {submitError !== null && (
            <p className="settings-inline-error" role="alert">
              {submitError}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {SETTINGS_STRINGS.connectionsCancel}
          </Button>
          <Button
            variant="primary"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {submitting
              ? SETTINGS_STRINGS.connectionsConnecting
              : SETTINGS_STRINGS.connectionsConnectDialogAction}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
