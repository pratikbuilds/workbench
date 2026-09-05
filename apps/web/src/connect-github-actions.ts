// Builds the `ConnectGithubActions` port `ChatWorkspace` (`@corbits/chat-ui`)
// calls for its inline GitHub connect card (CL-6344). Mirrors
// `approval-actions.ts`'s shape: chat-ui owns no session, no credential, and
// no query cache, so every live read and side effect is bound here against
// this app's own API clients.
//
// Connecting the PAT reuses the exact generic route the Plugins settings
// page already calls (`completeConnectorCredential`, `@corbits/settings-ui`)
// — never a bespoke GitHub connect route; the card's own inline field
// (`connect-github-block.tsx`'s `DisconnectedBody`) is what actually asks
// for the token, so this binding never needs a prompt or a modal of its
// own. Reading state and starting reviews call the workbench-scoped routes
// `@corbits/connections`'s `createConnectGithubRoutes` exposes.
//
// `subscribeConnectState` is the card's live fold. Actions this host
// itself runs (`submitAccessToken`, `startReviewing`, `skip`) re-read
// `getConnectState` and fan the result out. A credential completed
// elsewhere publishes `chat.settings`; ChatWorkspace parses that event
// and calls `notifySettingsChanged`, which reuses the same refresh so
// a mounted card flips without remounting (CL-6476). Every action that
// can change the card's state still only fires one fetch per real
// change — never a poll loop.
import type {
  ConnectGithubActions,
  ConnectGithubQuery,
} from "@corbits/chat-ui";
import {
  getConnectGithubState,
  getWorkbenchSettings,
  patchWorkbenchSettings,
  startReviewingGithubRepos,
} from "@corbits/chat-ui";
import {
  completeConnectorCredential,
  ConnectionsApiError,
} from "@corbits/settings-ui";

export function createChatConnectGithubActions(
  tenantId: string,
  workbenchId: string,
): ConnectGithubActions {
  const listeners = new Set<(state: ConnectGithubQuery) => void>();

  async function refresh(): Promise<ConnectGithubQuery> {
    const state = await getConnectGithubState(tenantId, workbenchId);
    for (const listener of listeners) listener(state);
    return state;
  }

  return {
    getConnectState() {
      return getConnectGithubState(tenantId, workbenchId);
    },
    subscribeConnectState(_messageId, onUpdate) {
      listeners.add(onUpdate);
      return () => {
        listeners.delete(onUpdate);
      };
    },
    async notifySettingsChanged() {
      await refresh();
    },
    requestConnect() {
      // The card's inline field is what actually collects and submits the
      // token (`submitAccessToken` below); "Connect GitHub" only opens
      // that field locally in chat-ui's own component state, so there is
      // nothing this host needs to do here.
    },
    async submitAccessToken(token) {
      try {
        await completeConnectorCredential(tenantId, "github", token);
      } catch (cause) {
        const message =
          cause instanceof ConnectionsApiError
            ? cause.message
            : "Couldn't connect GitHub. Try again.";
        return { ok: false, message };
      }
      await refresh();
      return { ok: true };
    },
    async startReviewing(repoIds) {
      const result = await startReviewingGithubRepos(
        tenantId,
        workbenchId,
        repoIds,
      );
      await refresh();
      return { startedTriggerCount: result.startedTriggerCount };
    },
    async skip() {
      const current = await getWorkbenchSettings(tenantId, workbenchId);
      const pendingConnections = (
        (current.settings["template/pendingConnections"] as
          string[] | undefined) ?? []
      ).filter((id) => id !== "github");
      await patchWorkbenchSettings(tenantId, workbenchId, {
        "template/pendingConnections": pendingConnections,
      });
      await refresh();
    },
  };
}
