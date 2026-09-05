// The platform call surface `@corbits/chat` needs from its host:
// launching an interactive workbench instance, dispatching mail to an
// agent, fetching attachment blobs, and subscribing to its live event
// stream. The hub builds this from the same `SessionService`/db calls
// `createRunRoutes` uses (see `vendor/intx/hub-api/src/routes/runs.ts`),
// but that machinery — grant materialization, credential resolution,
// model-source resolution, multi-table transactions — is internal
// wiring specific to the hub, not a single callable service. Rather
// than duplicating it inside this package (which would violate "apps
// stay generic; packages own the domain" the other way around), this
// package depends on this narrow port, injected by the hub exactly as
// `@workbench/onboarding` injects `pushWorkflow` instead of
// reimplementing workflow push.
//
// Split into its three real seams — launching, mail, and the live
// event stream — rather than one flat interface, so a call site that
// only ever dispatches mail (the fan-out service, say) can depend on
// `WorkbenchMail` alone. `ChatPlatform` remains the composed
// convenience type the hub actually implements and injects.
import type { MailContent } from "./codec";

export interface LaunchedInvite {
  readonly instanceId: string;
  readonly address: string;
}

export interface InvitableDefinition {
  readonly id: string;
  readonly name: string;
  /** The definition's human display name (e.g. "Myra" for the
   * `assistant` asset); absent when the deploy carried none. */
  readonly description?: string;
}

export interface SentMail {
  readonly id: string;
  readonly createdAt: string;
}

export interface ChatWorkbenchEvent {
  readonly type: string;
  readonly data: unknown;
}

/** Inviting an already-deployed agent into a workbench. A workbench
 * itself is data (settings, tenancy, timeline rows) — nothing launches
 * when one is created. */
export interface WorkbenchLauncher {
  /**
   * Mints an interactive instance of an already-deployed workflow
   * definition — the invited agent's own run — and returns its mail
   * address. This writes DB rows only; the instance deploys on its
   * first inbound mail or an explicit `ensureAwake` pre-warm.
   */
  launchInvite(input: {
    readonly tenantId: string;
    readonly creatorPrincipalId: string;
    readonly definitionId: string;
  }): Promise<LaunchedInvite>;

  /**
   * Deploys the run behind `address` if it is not currently routable —
   * the same wake `sendMail` performs implicitly before delivering.
   * Used to pre-warm a freshly minted (or slept) instance ahead of the
   * traffic that would otherwise pay the deploy inline. Concurrent
   * calls for one address coalesce onto a single deploy.
   */
  ensureAwake(address: string): Promise<void>;

  /**
   * Lists the tenant's deployed, launchable workflow definitions an
   * "invite agent" affordance can offer — never including a workbench's
   * own host definition.
   */
  listInvitableDefinitions(
    tenantId: string,
  ): Promise<readonly InvitableDefinition[]>;

  /**
   * Resolves an already-joined participant's address back to the
   * definition id it was launched from — the reverse of `launchInvite`.
   * Returns undefined for an address this platform has no folded run
   * for (a human participant, or a stale/removed agent).
   */
  resolveDefinitionIdByAddress(address: string): Promise<string | undefined>;

  /**
   * Resolves a definition id to the workflow asset it projects over —
   * the agent's stable identity. A code-sourced deploy projects a fresh
   * `workflow_definition` row per frozen wire projection, so one agent
   * accumulates many definition ids over its life while its asset stays
   * the same; anything asking "is this the same agent?" compares assets,
   * never rows. Returns undefined for a definition this tenant has no
   * row for.
   */
  resolveDefinitionAssetId(definitionId: string): Promise<string | undefined>;

  /**
   * Resolves a definition id directly to the name/description pair
   * `@corbits/chat/display-name`'s `deriveDisplayName` reads — the
   * authoritative source a caller falls back to when a definition it
   * needs to name isn't present in an already-fetched
   * `listInvitableDefinitions` snapshot (a just-created or just-redeployed
   * definition the snapshot predates). Never used as the primary lookup —
   * an `invitable` hit is cheaper and already in hand — only as the seam
   * that keeps a stale-snapshot miss from ever degrading to a raw address
   * or run id (CL-6471). Returns undefined only when the tenant truly has
   * no such definition.
   */
  resolveDefinitionNameSource(
    definitionId: string,
  ): Promise<
    { readonly name: string; readonly description?: string } | undefined
  >;

  /**
   * Recomputes an already-invited instance's folded launch body from
   * its definition's CURRENT asset content, and persists it so the
   * instance's next wake uses it. A wake replays whatever the launch
   * store holds verbatim — it never re-reads the definition's asset
   * itself — so an edited system prompt only reaches a running
   * instance through this seam. A no-op, never throwing, for an
   * address with no running instance behind it.
   */
  refreshAgentInstanceFromDefinition(
    tenantId: string,
    workbenchId: string,
    address: string,
  ): Promise<void>;
}

/**
 * Thrown by `WorkbenchMail.sendMail` when the target agent's address
 * never became routable — the sidecar-side agent is (or remains)
 * unreachable even after the adapter's own reclaim-settle retries and
 * redeploy fallback. Callers distinguish this from every other
 * `sendMail` failure (bad input, definition errors, …) to answer with
 * a clean, retriable "come back in a moment" response instead of an
 * unhandled 500.
 */
export class AgentUnreachableError extends Error {
  constructor(address: string, options?: { cause?: unknown }) {
    super(`Agent at "${address}" is unreachable`, options);
    this.name = "AgentUnreachableError";
  }
}

/**
 * Dispatching a message into an agent's own mailbox — the hop that asks
 * an agent for a turn, and the hop that carries a message from one
 * workbench to another — plus reading the attachment blobs those mails
 * carry. A room's timeline is not mail: it lives in
 * `chat.workbench_messages` and is read and written through
 * `./room-messages.ts`, never through this port.
 */
export interface WorkbenchMail {
  sendMail(input: {
    readonly tenantId: string;
    readonly workbenchId: string;
    /**
     * The sending principal, when the send is a human/participant
     * message — the address it sends from is derived as
     * `${principalId}@<workbench's domain>`. Omit when `fromWorkbenchId`
     * is given instead; exactly one of the two must be present, and
     * the adapter throws loud if neither is.
     */
    readonly principalId?: string;
    readonly content: MailContent;
    /**
     * Send the mail from another workbench's address instead of the
     * principal's — the origin of a cross-workbench delivery, and of a
     * dispatch an agent's own reply must be able to answer. An agent's
     * reply router answers the From address of the mail it received, and
     * a principal address has no mailbox: a reply to it vanishes.
     */
    readonly fromWorkbenchId?: string;
  }): Promise<SentMail>;

  fetchBlob(workbenchId: string, blobId: string): Promise<string | Uint8Array>;
}

/** Subscribing to a workbench's live event stream. */
export interface WorkbenchEvents {
  subscribeToWorkbench(
    workbenchId: string,
    onEvent: (event: ChatWorkbenchEvent) => void,
  ): () => void;
}

/**
 * The composed port the hub actually implements and injects. Handlers
 * and services that only need one seam should depend on that
 * interface directly (`WorkbenchMail`, say) rather than the full
 * composition — this type exists for the hub's own implementation and
 * for wiring that genuinely spans all three.
 */
export type ChatPlatform = WorkbenchLauncher & WorkbenchMail & WorkbenchEvents;
