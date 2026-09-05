// The connect-github card's one seam to the platform connection it needs
// (CL-6345) — mirroring `ApprovalActions`/`BlockResponseActions`:
// `@corbits/chat-ui` owns no session, no credential, and no query cache,
// so it never resolves a GitHub connection or lists repos itself. The
// host supplies this port, and is expected to bind it against
// `@corbits/connections`' generic `/:connectorId/complete` route
// (`github`'s PAT test-and-store — already fully generic, no bespoke
// GitHub route needed), `@corbits/github-tools`' `listRepos`, and
// `@corbits/connections`'s `startReviewingRepos`.
import type { ConnectGithubRepo } from "./connect-github-block";
export type { ConnectGithubRepo };

export type ConnectGithubQuery =
  | { readonly kind: "loading" }
  | { readonly kind: "disconnected" }
  | {
      readonly kind: "connected";
      readonly orgName: string;
      readonly repos: readonly ConnectGithubRepo[];
      /** Repos already recorded as selected — the room's own
       * `template/selectedRepos` setting, never a client guess. */
      readonly selectedRepoIds: readonly string[];
    }
  | { readonly kind: "error"; readonly message: string };

export type ConnectGithubActions = {
  /** The live read behind the card, resolved against the real
   * connection and the room's own settings — never derived from the
   * message's own `ConnectGithubBlockData`. */
  readonly getConnectState: (messageId: string) => Promise<ConnectGithubQuery>;
  /**
   * Registers for this card's state updates — the host fans an update
   * out to every subscriber after its own actions (`submitAccessToken`,
   * `startReviewing`, `skip`) change something, re-reading
   * `getConnectState`. A credential completed elsewhere (the Plugins
   * page, another tab) settles this connector's entry on
   * `@workbench/templates`'s `template/pendingConnections`
   * (CL-6463's `settleConnectedService`) and publishes `chat.settings`;
   * ChatWorkspace parses that event and calls `notifySettingsChanged`
   * so a card already mounted flips without remounting (CL-6476).
   * Returns an unsubscribe.
   */
  readonly subscribeConnectState: (
    messageId: string,
    onUpdate: (state: ConnectGithubQuery) => void,
  ) => () => void;
  /**
   * Re-reads live connect state and fans it to every
   * `subscribeConnectState` listener. ChatWorkspace calls this when a
   * parsed `chat.settings` event lands — `settleConnectedService`
   * already publishes that event when a credential completes out of
   * band, and a card already mounted must flip without remounting
   * (CL-6476).
   */
  readonly notifySettingsChanged: () => Promise<void>;
  /**
   * Both the card's "Connect GitHub" and "Use an access token instead"
   * actions funnel here — this repo's connect cards are PAT-first
   * today (CL-6345); a GitHub App/OAuth `onConnect` path is CL-6343,
   * explicitly out of scope. The host opens whatever PAT-entry surface
   * it already presents for other connectors; this call itself returns
   * nothing, and a successful connect is expected to arrive back
   * through the same `subscribeConnectState` channel this card already
   * holds open — never a return value the card would have to poll.
   */
  readonly requestConnect: () => void;
  /**
   * Submits a pasted personal access token — the actual PAT-first
   * connect path (CL-6345/CL-6344's follow-up slice): the host tests
   * and stores it through `@corbits/connections`' generic
   * `github/complete` route, then clears this room's own
   * `template/pendingConnections` entry for `"github"` so the same
   * `subscribeConnectState` channel `requestConnect`'s own doc
   * describes reflects the new connected state. Resolves `{ ok: false,
   * message }` on a rejected token rather than throwing, so the card's
   * inline field can show the failure without a modal.
   */
  readonly submitAccessToken: (
    token: string,
  ) => Promise<
    { readonly ok: true } | { readonly ok: false; readonly message: string }
  >;
  /** Mints a grant and a live webhook trigger per repo id, then
   * records the selection — `@workbench/templates`'s
   * `startReviewingRepos`, called through the host's own binding. */
  readonly startReviewing: (
    repoIds: readonly string[],
  ) => Promise<{ readonly startedTriggerCount: number }>;
  readonly skip: () => Promise<void>;
};
