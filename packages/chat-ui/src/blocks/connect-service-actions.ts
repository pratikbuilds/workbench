// The host port behind the generic service connect card (CL-6393) —
// the `ConnectGithubActions` shape generalized to any connector or MCP
// preset. The block's data carries only agent-authored framing; every
// live fact — connected or not, and which connect affordance the
// deployment actually supports (hosted OAuth, one-click keyless, or a
// pasted key) — is resolved here by the host against the tenant's real
// connections, so an agent can never author a verdict or steer the
// auth mode.

export type ConnectAffordance = "oauth" | "keyless" | "api-key";

export type ConnectServiceQuery =
  | { readonly kind: "loading" }
  | {
      readonly kind: "disconnected";
      readonly affordance: ConnectAffordance;
      /** Where the key on the key-paste arm comes from, when the host
       * knows — the descriptor's docs page. */
      readonly docsUrl?: string;
    }
  | { readonly kind: "connected" }
  | { readonly kind: "error"; readonly message: string };

export type ConnectServiceResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface ConnectServiceActions {
  getConnectState(connectorId: string): Promise<ConnectServiceQuery>;
  subscribeConnectState(
    connectorId: string,
    listener: (query: ConnectServiceQuery) => void,
  ): () => void;
  /**
   * Re-reads live connect state for every subscribed connector and fans
   * it to those listeners. ChatWorkspace calls this when a parsed
   * `chat.settings` event lands so a mounted card flips without
   * remounting (CL-6476).
   */
  notifySettingsChanged(): Promise<void>;
  /** One-click connect: starts the hosted OAuth hand-off (navigating
   * away and back) or completes a keyless preset in place. */
  connect(connectorId: string): Promise<ConnectServiceResult>;
  submitKey(connectorId: string, key: string): Promise<ConnectServiceResult>;
}
