// Shared dependency and result shapes for the folded-run machinery.
// Every side effect that touches a real host — the database, the
// session service, the sidecar router, the event-collector
// registry — arrives as an injected port; this package never imports
// a hub or a host-specific package such as `@corbits/chat`.
import type { DB } from "@intx/db";
import type {
  CredentialBinding,
  CredentialCipher,
  GrantEffect,
} from "@intx/types";
import type { ToolPackagePin } from "@intx/types/tool-packages";
import type {
  AdoptingWorkflowDeployer,
  AssetService,
  EventCollectorRegistry,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";

/**
 * One `tool:<qualifiedId>` / `invoke` grant a pinned tool package
 * contributes to a folded run's deploy-time `config.grants`. `resource`
 * is already prefixed (`tool:<factory.id>:<definition.name>`, the exact
 * shape the workflow child's authz gate matches against — see
 * `@intx/tool-packaging/src/loader.ts`'s `applyNamespacePrefix`
 * and `@intx/inference/src/authz-extension.ts`'s
 * `beforeTool`); `effect` is the tool's static approval floor
 * (`@intx/agent`'s `toolApprovalEffect`: `"ask"` for a tool declared
 * `approval: "ask"`, `"allow"` otherwise).
 */
export type PinnedToolGrantDeclaration = {
  readonly resource: string;
  readonly action: "invoke";
  readonly effect: GrantEffect;
};

/**
 * Derives the `tool:` grant declarations a folded run's pinned tool
 * packages need at deploy time. `deployAtHead` calls this with the
 * launch's `toolPackagePins` and folds the result into
 * `HarnessConfig.grants`, the array the sidecar writes verbatim to
 * `state/grants.json` (the file the spawned child's `authorize` closure
 * actually reads — see `apps/sidecar/src/workflow-host-wiring/index.ts`'s
 * "Grants bridge" write and `vendor/intx/workflow-host/src/supervisor/credentials.ts`'s
 * `assembleCredentialsSnapshot`). Without this, a pinned tool package's
 * calls fail closed with "No matching grants" — the deploy-time
 * capability walk (`vendor/intx/workflow-deploy/src/capability-walk.ts`)
 * only derives `tool:` grants for inline tool factories, never for
 * `toolPackagePins`.
 *
 * The composition root (`apps/hub`) supplies the real implementation,
 * built from `@corbits/tool-registry-publish`'s
 * `describeCorbitsToolPackages()` — `folded-runs` never imports that
 * package itself, so this package stays ignorant of which tool
 * packages exist.
 */
export type ToolGrantsForPins = (
  pins: readonly ToolPackagePin[],
) => readonly PinnedToolGrantDeclaration[];

/**
 * Derives the extra `@corbits/mcp-tools` credential bindings a folded run's
 * launch needs for its tenant's connected MCP servers. `mcp-tools`' handles
 * are dynamic (one `mcp.<slug>` per tenant-connected server, unknown at
 * package-publish time), so its `package.json` declares no static
 * `interchange.credentials` entry the deploy-time capability walk
 * (`vendor/intx/workflow-deploy/src/capability-walk.ts`) could turn into a
 * binding — without this port, `env.credentials.resolve("mcp.<slug>")`
 * always throws "not connected" even when the tenant's credential exists.
 * `deployAtHead` calls this whenever `@corbits/mcp-tools` is among a
 * launch's `toolPackagePins`, mirroring `ToolGrantsForPins`'s reason for
 * living here rather than in the capability walk.
 *
 * The composition root (`apps/hub`) supplies the real implementation, built
 * from `@corbits/connections`' `listMcpServerConnections` — `folded-runs`
 * never imports that package itself.
 */
export type McpCredentialBindingsFor = (
  tenantId: string,
) => Promise<readonly CredentialBinding[]>;

/**
 * Derives extra credential bindings for a folded run's pinned tool packages
 * whose handles are static (known at package-publish time) but whose
 * workflow definition does not require them. A required assistant binding
 * would throw `MissingCredentialError` on signup / first chat when the
 * tenant has not connected the provider; a pin with no matching binding is
 * otherwise inert at tool time (`env.credentials.resolve(handle)` fails
 * "not connected" even when Settings already has the key).
 *
 * `deployAtHead` calls this whenever it is supplied, with the launch's
 * `toolPackagePins`, and concatenates the result onto the definition's own
 * bindings (skipping handles already present). The composition root
 * (`apps/hub`) supplies the real implementation from
 * `CONNECTOR_REGISTRY.feedsTools` plus the tenant's connected providers —
 * `folded-runs` never imports that registry itself. Optional: a caller that
 * never pins a connector-fed package has no need to supply it.
 */
export type PinnedPackageCredentialBindingsFor = (
  tenantId: string,
  pins: readonly ToolPackagePin[],
) => Promise<readonly CredentialBinding[]>;

export type FoldedRunsDeps = {
  db: DB["db"];
  /**
   * The session service, narrowed to include the adopting code-sourced
   * deploy front `deployAtHead` uses: a folded run's anchor row is
   * minted before any deployment attaches to it, which is the one
   * combination the inserting and prepared fronts cannot serve.
   */
  sessionService: SessionService & AdoptingWorkflowDeployer;
  assetService: AssetService;
  sidecarRouter: SidecarRouter;
  eventCollectors: EventCollectorRegistry;
  /**
   * Decrypts credential secrets when a launch resolves inference sources
   * against the tenant catalog (`resolveDefinitionSources`, called from
   * `deployAtHead`). The composition root tags this at hub boot
   * (`hubCredentialCipher`) and again when minting a `FoldedRunsDeps`
   * bag (`tagCredentialCipher`); missing or wrong-shape input fails
   * closed rather than falling through to a noop cipher that would
   * hand ciphertext to the provider as an API key. Optional only for
   * callers that never resolve catalog secrets (a mint-only path, a
   * test double that does not decrypt). Persist paths do not re-assert.
   */
  credentialCipher?: CredentialCipher;
  /** See `ToolGrantsForPins`'s own doc. */
  toolGrantsForPins: ToolGrantsForPins;
  /**
   * See `McpCredentialBindingsFor`'s own doc. Optional: a caller that never
   * pins `@corbits/mcp-tools` (every launcher besides the hub's real chat
   * composition today) has no need to supply it.
   */
  mcpCredentialBindingsFor?: McpCredentialBindingsFor;
  /**
   * See `PinnedPackageCredentialBindingsFor`'s own doc. Optional: a caller
   * that never pins a connector-fed package (granola-tools, manus-tools, …)
   * has no need to supply it.
   */
  pinnedPackageCredentialBindingsFor?: PinnedPackageCredentialBindingsFor;
};

export type SentFoldedMail = {
  readonly id: string;
  readonly createdAt: string;
};

export type ListedFoldedMailItem = {
  readonly id: string;
  readonly createdAt: string;
  readonly mail: unknown;
};

export type ListedFoldedMail = {
  readonly items: readonly ListedFoldedMailItem[];
  readonly nextCursor?: string;
};
