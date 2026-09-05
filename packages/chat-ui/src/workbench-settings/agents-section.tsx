// Agents: master-detail over every agent participant this workbench has
// (CL-6215). The list (every invited agent, Invite agent, the autonomy
// callout) is the whole surface until one is picked; clicking a row opens
// that agent's detail — the editor the old, separate "Myra" tab rendered,
// generalized to any agent: name/instructions (`getAgentInstructions`/
// `updateAgentInstructions`, `@corbits/agent-directory`'s own routes, a
// different backend than every other section here, which all PATCH
// through the workbench settings surface's top-bar Save), Capabilities
// (tools/skills, plus a model picker fed from this tenant's resolved,
// workspace-wide inference catalog — see `CapabilitiesBlock` below), and
// History (every commit to the agent's instructions/capabilities, with
// restore). A load failure renders as an inline reason, never a fake save.
// Selection is host-owned when `onEntityIdChange` is passed (workbench URL
// `/settings/agents/:definitionId`); otherwise the section keeps a local
// selection for standalone mounts.

import { useEffect, useState } from "react";
import {
  Button,
  EmptyState,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  formatRelativeTime,
  toast,
} from "@corbits/react-ui";
import {
  chatCapableModels,
  getResolvedCatalog,
  providerDisplayName,
} from "@corbits/inference-settings";
import type { ModelInfo } from "@corbits/inference-settings";
import { ArrowLeft, CaretRight, UserPlus, WarningCircle } from "@corbits/icons";
import { CorbitAvatar } from "../avatar";

import {
  addAgentCapability,
  describeChatError,
  getAgentInstructions,
  listAgentVersions,
  listCapabilityInventory,
  listWorkbenchAgents,
  refreshWorkbenchAgent,
  restoreAgentVersion,
  updateAgentInstructions,
} from "../api";
import type {
  AgentDetail,
  AgentVersion,
  CapabilityAddition,
  CapabilityInventory,
  WorkbenchAgent,
} from "../api";
import { CHAT_STRINGS } from "../strings";

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly agents: readonly WorkbenchAgent[] };

export function AgentsSection({
  tenantId,
  workbenchId,
  onInvite,
  entityId = null,
  onEntityIdChange,
}: {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly onInvite: () => void;
  /** Host-controlled selection (`definitionId`) — driven from the URL when
   * the workbench settings surface is deep-linked. Only honored when
   * `onEntityIdChange` is also passed (that callback is the controlled-mode
   * gate). */
  readonly entityId?: string | null;
  /** Fired when the user opens or closes an agent detail so the host can
   * reflect it in the URL. Passing this opts into host-owned selection;
   * omitting it keeps selection local to this section. */
  readonly onEntityIdChange?: (definitionId: string | null) => void;
}) {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [localEntityId, setLocalEntityId] = useState<string | null>(null);
  const selectedId =
    onEntityIdChange !== undefined ? (entityId ?? null) : localEntityId;

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    listWorkbenchAgents(tenantId, workbenchId)
      .then((agents) => {
        if (!cancelled) setState({ kind: "ready", agents });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: describeChatError(cause, "Couldn't load the agents."),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, workbenchId]);

  useEffect(() => {
    if (state.kind !== "ready") return;
    if (selectedId === null) return;
    if (state.agents.some((agent) => agent.definitionId === selectedId)) {
      return;
    }
    if (onEntityIdChange !== undefined) {
      onEntityIdChange(null);
      return;
    }
    setLocalEntityId(null);
  }, [state, selectedId, onEntityIdChange]);

  function select(definitionId: string | null) {
    if (onEntityIdChange !== undefined) {
      onEntityIdChange(definitionId);
      return;
    }
    setLocalEntityId(definitionId);
  }

  if (state.kind === "loading") {
    return <Skeleton className="query-skeleton" />;
  }

  if (state.kind === "error") {
    return (
      <EmptyState
        icon={<WarningCircle />}
        title="Couldn't load agents"
        description={state.message}
      />
    );
  }

  const selected =
    selectedId === null
      ? null
      : (state.agents.find((agent) => agent.definitionId === selectedId) ??
        null);

  if (selected !== null) {
    return (
      <div className="workbench-settings-pane">
        <button
          type="button"
          className="chat-settings-agent-back"
          onClick={() => select(null)}
        >
          <ArrowLeft aria-hidden="true" />
          {CHAT_STRINGS.workbenchSettingsAgentsBackAction}
        </button>
        <AgentDetailEditor
          tenantId={tenantId}
          workbenchId={workbenchId}
          agent={selected}
        />
      </div>
    );
  }

  return (
    <div className="workbench-settings-pane">
      <div className="chat-settings-field">
        <span>{CHAT_STRINGS.workbenchSettingsAgentsLabel}</span>
        <p className="chat-settings-field-hint">
          {CHAT_STRINGS.workbenchSettingsAgentsInviteHint}
        </p>
        {state.agents.length === 0 ? (
          <p className="chat-settings-field-hint">
            {CHAT_STRINGS.workbenchSettingsNoAgents}
          </p>
        ) : (
          <ul className="chat-settings-participants-list">
            {state.agents.map((agent) => (
              <li key={agent.address}>
                <button
                  type="button"
                  className="chat-settings-agent-picker-row"
                  onClick={() => select(agent.definitionId)}
                >
                  @{agent.handle}
                  <CaretRight
                    aria-hidden="true"
                    className="chat-settings-agent-picker-row-chevron"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="chat-settings-invite-agent-action"
          onClick={onInvite}
        >
          <UserPlus aria-hidden="true" />
          {CHAT_STRINGS.inviteAgentAction}
        </button>
      </div>
      <div className="chat-settings-callout">
        <span className="chat-settings-callout-label">
          {CHAT_STRINGS.workbenchSettingsAutonomyTitle}
        </span>
        <p>{CHAT_STRINGS.workbenchSettingsAutonomyBody}</p>
      </div>
    </div>
  );
}

type EditorState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly detail: AgentDetail };

function AgentDetailEditor({
  tenantId,
  workbenchId,
  agent,
}: {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly agent: WorkbenchAgent;
}) {
  const [state, setState] = useState<EditorState>({ kind: "loading" });
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [catalogState, setCatalogState] = useState<CatalogState>({
    kind: "loading",
  });
  const [catalogReloadKey, setCatalogReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCatalogState({ kind: "loading" });
    getResolvedCatalog(tenantId)
      .then((models) => {
        if (!cancelled) setCatalogState({ kind: "ready", models });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setCatalogState({
          kind: "error",
          message: describeChatError(
            cause,
            CHAT_STRINGS.workbenchSettingsAgentDetailCatalogError,
          ),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, catalogReloadKey]);

  useEffect(() => {
    let cancelled = false;
    getAgentInstructions(tenantId, agent.definitionId)
      .then((detail) => {
        if (cancelled) return;
        setName(detail.name);
        setInstructions(detail.systemPrompt);
        setState({ kind: "ready", detail });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          kind: "error",
          message: describeChatError(cause, "Couldn't load the agent."),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, agent.definitionId]);

  const label =
    state.kind === "ready" && state.detail.name.trim() !== ""
      ? state.detail.name
      : `@${agent.handle}`;

  if (state.kind === "loading") {
    return <Skeleton className="query-skeleton" />;
  }

  // No backing route succeeded for this agent's definition — render the
  // reason, not a form with nothing behind it. Never a fake save.
  if (state.kind === "error") {
    return (
      <EmptyState
        icon={<WarningCircle />}
        title={CHAT_STRINGS.workbenchSettingsAgentDetailLoadError}
        description={state.message}
      />
    );
  }

  const dirty =
    name !== state.detail.name || instructions !== state.detail.systemPrompt;

  function handleCancel() {
    if (state.kind !== "ready") return;
    setName(state.detail.name);
    setInstructions(state.detail.systemPrompt);
    setSaveError(null);
  }

  function handleSave() {
    if (state.kind !== "ready" || !dirty) return;
    setSaving(true);
    setSaveError(null);
    updateAgentInstructions(tenantId, agent.definitionId, {
      name,
      systemPrompt: instructions,
    })
      .then((saved) =>
        refreshWorkbenchAgent(tenantId, workbenchId, agent.address).then(
          () => saved,
        ),
      )
      .then((saved) => {
        toast(CHAT_STRINGS.workbenchSettingsAgentDetailSavedToast);
        setState((prev) =>
          prev.kind === "ready"
            ? {
                kind: "ready",
                detail: { ...prev.detail, ...saved },
              }
            : prev,
        );
      })
      .catch(() =>
        setSaveError(CHAT_STRINGS.workbenchSettingsAgentDetailSaveError),
      )
      .finally(() => setSaving(false));
  }

  return (
    <div className="chat-settings-agent-block">
      <div className="flex items-center gap-3">
        <CorbitAvatar size="lg" ariaLabel={label} />
        <h3 className="chat-settings-agent-block-title">{label}</h3>
      </div>

      <ModelSelect
        tenantId={tenantId}
        workbenchId={workbenchId}
        agent={agent}
        detail={state.detail}
        catalogState={catalogState}
        onRetryCatalog={() => setCatalogReloadKey((value) => value + 1)}
        onChanged={(detail) => setState({ kind: "ready", detail })}
      />

      <label className="chat-settings-field">
        <span>{CHAT_STRINGS.workbenchSettingsAgentDetailNameLabel}</span>
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="chat-settings-field">
        <span>
          {CHAT_STRINGS.workbenchSettingsAgentDetailInstructionsLabel}
        </span>
        <textarea
          className="chat-textarea"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          rows={10}
        />
      </label>
      <p className="chat-settings-field-hint">
        {CHAT_STRINGS.workbenchSettingsAgentDetailInstructionsHint}
      </p>
      {saveError !== null ? (
        <p className="chat-dialog-error" role="alert">
          {saveError}
        </p>
      ) : null}
      <div className="chat-settings-field-actions">
        <Button
          type="button"
          variant="outline"
          onClick={handleCancel}
          disabled={!dirty || saving}
        >
          {CHAT_STRINGS.workbenchSettingsAgentDetailCancel}
        </Button>
        <Button
          type="button"
          variant="primary"
          onClick={handleSave}
          disabled={!dirty || saving}
        >
          {saving
            ? CHAT_STRINGS.workbenchSettingsAgentDetailSaving
            : CHAT_STRINGS.workbenchSettingsAgentDetailSave}
        </Button>
      </div>

      <CapabilitiesBlock
        tenantId={tenantId}
        workbenchId={workbenchId}
        agent={agent}
        detail={state.detail}
        catalogState={catalogState}
        onChanged={(detail) => setState({ kind: "ready", detail })}
      />

      <HistoryBlock
        tenantId={tenantId}
        workbenchId={workbenchId}
        agent={agent}
        onRestored={(detail) => {
          setName(detail.name);
          setInstructions(detail.systemPrompt);
          setState({ kind: "ready", detail });
        }}
      />
    </div>
  );
}

// --- Capabilities (tools, skills, and — the per-agent inference picker —
// model, fed from this tenant's resolved catalog: the workspace-wide pool
// of providers actually connected, the same read the Models settings
// section itself resolves from, never a second store of "what's
// available") ---

type InventoryState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly inventory: CapabilityInventory };

type ModelOption = { readonly canonicalName: string; readonly label: string };

type CatalogState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly models: readonly ModelInfo[] };

/** Only a model with at least one offering is actually launchable for this
 * tenant — an entry with none has no provider connected anywhere up the
 * ancestor chain, so it is left off the picker rather than offered to fail
 * at launch. Embedding / Hugging Face / GGUF path names are also omitted
 * (CL-6744) via `chatCapableModels`. Labeled by its top (highest-priority)
 * offering's provider — the same one `getResolvedCatalog`'s resolution
 * would pick. */
function connectedModelOptions(
  models: readonly ModelInfo[],
  alreadySet: string | undefined,
): readonly ModelOption[] {
  return chatCapableModels(models)
    .filter(
      (model) =>
        model.offerings.length > 0 && model.canonicalName !== alreadySet,
    )
    .map((model) => {
      const topOffering = model.offerings[0];
      return {
        canonicalName: model.canonicalName,
        label: CHAT_STRINGS.workbenchSettingsAgentDetailModelOption(
          model.displayName ?? model.canonicalName,
          topOffering === undefined
            ? ""
            : providerDisplayName(topOffering.providerName),
        ),
      };
    });
}

/**
 * The obvious, top-of-detail way to change an agent's model (CL-6272.3) —
 * the "Add a capability" flow below stays for tools/skills/models added
 * one at a time, but a model is a property every agent already has one
 * of, not an optional add-on, so it gets its own labeled control that
 * shows the current model and saves the moment a different one is
 * chosen. Saves through the exact same `addAgentCapability({ kind:
 * "model" })` path the Add-a-capability flow already uses — one write
 * path, two entry points.
 */
function ModelSelect({
  tenantId,
  workbenchId,
  agent,
  detail,
  catalogState,
  onRetryCatalog,
  onChanged,
}: {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly agent: WorkbenchAgent;
  readonly detail: AgentDetail;
  readonly catalogState: CatalogState;
  readonly onRetryCatalog: () => void;
  readonly onChanged: (detail: AgentDetail) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const options =
    catalogState.kind === "ready"
      ? connectedModelOptions(catalogState.models, undefined)
      : [];

  // The currently-set model may no longer carry a connected offering
  // (its provider was disconnected) — still list it, disabled, rather
  // than silently drop the value the select is showing.
  const currentOptions =
    detail.model !== undefined &&
    !options.some((option) => option.canonicalName === detail.model)
      ? [{ canonicalName: detail.model, label: detail.model }, ...options]
      : options;

  function handleChange(canonicalName: string) {
    if (canonicalName === "" || canonicalName === detail.model) return;
    setSaving(true);
    setError(null);
    addAgentCapability(tenantId, agent.definitionId, {
      kind: "model",
      canonicalName,
    })
      .then((capabilities) =>
        refreshWorkbenchAgent(tenantId, workbenchId, agent.address).then(
          () => capabilities,
        ),
      )
      .then((capabilities) => {
        toast(CHAT_STRINGS.workbenchSettingsAgentDetailSavedToast);
        onChanged({ ...detail, ...capabilities });
      })
      .catch(() =>
        setError(CHAT_STRINGS.workbenchSettingsAgentDetailAddCapabilityError),
      )
      .finally(() => setSaving(false));
  }

  return (
    <label className="chat-settings-field chat-settings-agent-model-select">
      <span>{CHAT_STRINGS.workbenchSettingsAgentDetailModelLabel}</span>
      <select
        value={detail.model ?? ""}
        onChange={(event) => handleChange(event.target.value)}
        disabled={
          saving ||
          catalogState.kind === "loading" ||
          catalogState.kind === "error"
        }
      >
        {detail.model === undefined ? (
          <option value="">
            {CHAT_STRINGS.workbenchSettingsAgentDetailModelUnset}
          </option>
        ) : null}
        {currentOptions.map((option) => (
          <option key={option.canonicalName} value={option.canonicalName}>
            {option.label}
          </option>
        ))}
      </select>
      {saving ? (
        <p className="chat-settings-field-hint">
          {CHAT_STRINGS.workbenchSettingsAgentDetailSaving}
        </p>
      ) : null}
      {catalogState.kind === "ready" && options.length === 0 ? (
        <p className="chat-settings-field-hint">
          {CHAT_STRINGS.workbenchSettingsAgentDetailNoConnectedModels}
        </p>
      ) : null}
      {catalogState.kind === "error" ? (
        <>
          <p className="chat-dialog-error" role="alert">
            {catalogState.message}
          </p>
          <div className="chat-settings-field-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRetryCatalog}
            >
              {CHAT_STRINGS.workbenchSettingsAgentDetailCatalogRetryAction}
            </Button>
            <a href="/settings/connections">
              {CHAT_STRINGS.workbenchSettingsAgentDetailCatalogSettingsAction}
            </a>
          </div>
        </>
      ) : null}
      {error !== null ? (
        <p className="chat-dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </label>
  );
}

function CapabilitiesBlock({
  tenantId,
  workbenchId,
  agent,
  detail,
  catalogState,
  onChanged,
}: {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly agent: WorkbenchAgent;
  readonly detail: AgentDetail;
  readonly catalogState: CatalogState;
  readonly onChanged: (detail: AgentDetail) => void;
}) {
  const [inventoryState, setInventoryState] = useState<InventoryState>({
    kind: "loading",
  });
  const [kind, setKind] = useState<CapabilityAddition["kind"]>("toolPackage");
  const [choice, setChoice] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listCapabilityInventory(tenantId)
      .then((inventory) => {
        if (!cancelled) setInventoryState({ kind: "ready", inventory });
      })
      .catch(() => {
        if (!cancelled) setInventoryState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const modelOptions =
    catalogState.kind === "ready"
      ? connectedModelOptions(catalogState.models, detail.model)
      : [];

  const options =
    kind === "toolPackage"
      ? inventoryState.kind === "ready"
        ? inventoryState.inventory.toolPackages
            .map((entry) => entry.name)
            .filter(
              (name) =>
                !detail.toolPackagePins.some((pin) => pin.name === name),
            )
        : []
      : kind === "skill"
        ? inventoryState.kind === "ready"
          ? inventoryState.inventory.skills
              .map((entry) => entry.name)
              .filter((name) => !detail.skills.includes(name))
          : []
        : modelOptions.map((option) => option.canonicalName);

  const optionsLoading =
    kind === "model"
      ? catalogState.kind === "loading"
      : inventoryState.kind === "loading";

  function addition(): CapabilityAddition | undefined {
    if (choice === "") return undefined;
    if (kind === "model") return { kind: "model", canonicalName: choice };
    return { kind, name: choice };
  }

  function handleAdd() {
    const next = addition();
    if (next === undefined) return;
    setAdding(true);
    setAddError(null);
    addAgentCapability(tenantId, agent.definitionId, next)
      .then((capabilities) =>
        refreshWorkbenchAgent(tenantId, workbenchId, agent.address).then(
          () => capabilities,
        ),
      )
      .then((capabilities) => {
        toast(CHAT_STRINGS.workbenchSettingsAgentDetailSavedToast);
        onChanged({ ...detail, ...capabilities });
        setChoice("");
      })
      .catch(() =>
        setAddError(
          CHAT_STRINGS.workbenchSettingsAgentDetailAddCapabilityError,
        ),
      )
      .finally(() => setAdding(false));
  }

  const hasCapabilities =
    detail.toolPackagePins.length > 0 ||
    detail.skills.length > 0 ||
    detail.model !== undefined;

  return (
    <div className="chat-settings-agent-block-section">
      <h4>{CHAT_STRINGS.workbenchSettingsAgentDetailCapabilitiesTitle}</h4>
      <p className="chat-settings-field-hint">
        {CHAT_STRINGS.workbenchSettingsAgentDetailCapabilitiesHint}
      </p>

      {hasCapabilities ? (
        <ul className="chat-settings-capability-list">
          {detail.toolPackagePins.map((pin) => (
            <li key={`tool-${pin.name}`}>
              <span className="chat-settings-capability-chip">{pin.name}</span>
            </li>
          ))}
          {detail.skills.map((skillName) => (
            <li key={`skill-${skillName}`}>
              <span className="chat-settings-capability-chip">{skillName}</span>
            </li>
          ))}
          {detail.model !== undefined ? (
            <li key="model">
              <span className="chat-settings-capability-chip">
                {CHAT_STRINGS.workbenchSettingsAgentDetailModelLabel}:{" "}
                {detail.model}
              </span>
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="chat-settings-field-hint">
          {CHAT_STRINGS.workbenchSettingsAgentDetailNoCapabilities}
        </p>
      )}

      {inventoryState.kind === "error" ? (
        <p className="chat-dialog-error" role="alert">
          {CHAT_STRINGS.workbenchSettingsAgentDetailCapabilityInventoryError}
        </p>
      ) : (
        <div className="chat-settings-capability-add">
          <label className="chat-settings-field">
            <span>
              {CHAT_STRINGS.workbenchSettingsAgentDetailAddCapabilityLabel}
            </span>
            <select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as CapabilityAddition["kind"]);
                setChoice("");
              }}
            >
              <option value="toolPackage">
                {CHAT_STRINGS.workbenchSettingsAgentDetailAddCapabilityKindTool}
              </option>
              <option value="skill">
                {
                  CHAT_STRINGS.workbenchSettingsAgentDetailAddCapabilityKindSkill
                }
              </option>
              <option value="model">
                {
                  CHAT_STRINGS.workbenchSettingsAgentDetailAddCapabilityKindModel
                }
              </option>
            </select>
          </label>
          <label className="chat-settings-field">
            <span>
              {
                CHAT_STRINGS.workbenchSettingsAgentDetailAddCapabilityChoiceLabel
              }
            </span>
            <select
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
              disabled={optionsLoading || options.length === 0}
            >
              <option value="">
                {CHAT_STRINGS.workbenchSettingsAgentDetailAddCapabilityChoicePlaceholder(
                  kind,
                )}
              </option>
              {kind === "model"
                ? modelOptions.map((option) => (
                    <option
                      key={option.canonicalName}
                      value={option.canonicalName}
                    >
                      {option.label}
                    </option>
                  ))
                : options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            onClick={handleAdd}
            disabled={choice === "" || adding}
          >
            {adding
              ? CHAT_STRINGS.workbenchSettingsAgentDetailAddCapabilityAdding
              : CHAT_STRINGS.workbenchSettingsAgentDetailAddCapabilityButton}
          </Button>
        </div>
      )}
      {kind === "model" &&
      catalogState.kind === "ready" &&
      modelOptions.length === 0 ? (
        <p className="chat-settings-field-hint">
          {CHAT_STRINGS.workbenchSettingsAgentDetailNoConnectedModels}
        </p>
      ) : null}
      {addError !== null ? (
        <p className="chat-dialog-error" role="alert">
          {addError}
        </p>
      ) : null}
    </div>
  );
}

// --- History ---

/** The backend's own commit message already names the kind of change
 * (`packages/agent-directory/src/routes.ts` and its sibling capability/
 * skill-pin route files), but it's written as a full sentence naming the
 * agent — redundant on a page that's already scoped to this one agent, and
 * repetitive across rows. This turns it into the short change summary the
 * history table actually shows (CL-6215 EMIL #8), falling back to the raw
 * message for anything this doesn't recognize rather than hiding it. */
export function summarizeHistoryMessage(message: string): string {
  if (/^Update agent instructions for /.test(message)) {
    return "Instructions updated";
  }
  if (/^Update agent skills for /.test(message)) {
    return "Skills updated";
  }
  const skillMatch = /^Add (.+) skill to /.exec(message);
  if (skillMatch !== null) {
    return `Added skill: ${skillMatch[1]}`;
  }
  const toolMatch = /^Add (.+) to /.exec(message);
  if (toolMatch !== null) {
    return `Added tool: ${toolMatch[1]}`;
  }
  const modelMatch = /^Set .+'s model to (.+)$/.exec(message);
  if (modelMatch !== null) {
    return `Model set to ${modelMatch[1]}`;
  }
  if (/^Restore agent .+ to /.test(message)) {
    return "Restored from history";
  }
  if (/^Define agent /.test(message)) {
    return "Agent created";
  }
  return message;
}

export type HistoryDisplayRow = {
  readonly commitSha: string;
  readonly summary: string;
  readonly author: string;
  readonly committedAtIso: string;
  readonly current: boolean;
  readonly repeatCount: number;
};

/** Softens a run of consecutive, identically-summarized rows (seed data's
 * repeated "Update agent instructions for X" is the case that prompted
 * this) into one row with a repeat count, rather than a wall of visually
 * identical entries — restoring that row still targets its newest
 * commit. Never collapses across the current version, so "current" always
 * stays its own row. */
export function collapseHistoryVersions(
  versions: readonly AgentVersion[],
): readonly HistoryDisplayRow[] {
  const rows: HistoryDisplayRow[] = [];
  for (const version of versions) {
    const summary = summarizeHistoryMessage(version.message);
    const last = rows[rows.length - 1];
    if (
      last !== undefined &&
      !last.current &&
      !version.current &&
      last.summary === summary &&
      last.author === version.author
    ) {
      rows[rows.length - 1] = { ...last, repeatCount: last.repeatCount + 1 };
      continue;
    }
    rows.push({
      commitSha: version.commitSha,
      summary,
      author: version.author,
      committedAtIso: version.committedAtIso,
      current: version.current,
      repeatCount: 1,
    });
  }
  return rows;
}

type HistoryState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly versions: readonly AgentVersion[] };

function HistoryBlock({
  tenantId,
  workbenchId,
  agent,
  onRestored,
}: {
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly agent: WorkbenchAgent;
  readonly onRestored: (detail: AgentDetail) => void;
}) {
  const [state, setState] = useState<HistoryState>({ kind: "loading" });
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  function reload() {
    setState({ kind: "loading" });
    listAgentVersions(tenantId, agent.definitionId)
      .then((versions) => setState({ kind: "ready", versions }))
      .catch((cause: unknown) =>
        setState({
          kind: "error",
          message: describeChatError(
            cause,
            CHAT_STRINGS.workbenchSettingsAgentDetailHistoryLoadError,
          ),
        }),
      );
  }

  useEffect(reload, [tenantId, agent.definitionId]);

  function handleRestore(commitSha: string) {
    setRestoring(commitSha);
    setRestoreError(null);
    restoreAgentVersion(tenantId, agent.definitionId, commitSha)
      .then((detail) =>
        refreshWorkbenchAgent(tenantId, workbenchId, agent.address).then(
          () => detail,
        ),
      )
      .then((detail) => {
        toast(CHAT_STRINGS.workbenchSettingsAgentDetailSavedToast);
        onRestored(detail);
        reload();
      })
      .catch(() =>
        setRestoreError(
          CHAT_STRINGS.workbenchSettingsAgentDetailHistoryRestoreError,
        ),
      )
      .finally(() => setRestoring(null));
  }

  return (
    <div className="chat-settings-agent-block-section">
      <h4>{CHAT_STRINGS.workbenchSettingsAgentDetailHistoryTitle}</h4>
      <p className="chat-settings-field-hint">
        {CHAT_STRINGS.workbenchSettingsAgentDetailHistoryHint}
      </p>

      {state.kind === "loading" ? (
        <Skeleton className="query-skeleton" />
      ) : state.kind === "error" ? (
        <p className="chat-dialog-error" role="alert">
          {state.message}
        </p>
      ) : state.versions.length === 0 ? (
        <p className="chat-settings-field-hint">
          {CHAT_STRINGS.workbenchSettingsAgentDetailHistoryEmpty}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Change</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>When</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {collapseHistoryVersions(state.versions).map((row) => (
              <TableRow
                key={row.commitSha}
                className={
                  row.current ? "chat-settings-history-row-current" : undefined
                }
              >
                <TableCell className="text-sm" title={row.commitSha}>
                  {row.summary}
                  {row.repeatCount > 1 ? (
                    <span className="chat-settings-history-repeat-count">
                      ×{row.repeatCount}
                    </span>
                  ) : null}
                  {row.current ? (
                    <span className="chat-settings-history-current-label">
                      {CHAT_STRINGS.workbenchSettingsAgentDetailHistoryCurrent}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {row.author}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatRelativeTime(row.committedAtIso, Date.now())}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={row.current || restoring !== null}
                    onClick={() => handleRestore(row.commitSha)}
                  >
                    {restoring === row.commitSha
                      ? CHAT_STRINGS.workbenchSettingsAgentDetailHistoryRestoring
                      : CHAT_STRINGS.workbenchSettingsAgentDetailHistoryRestore}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {restoreError !== null ? (
        <p className="chat-dialog-error" role="alert">
          {restoreError}
        </p>
      ) : null}
    </div>
  );
}
