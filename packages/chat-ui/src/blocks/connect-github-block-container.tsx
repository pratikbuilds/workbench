// Wires the presentational `ConnectGithubBlockView` to a live
// `ConnectGithubActions` port (CL-6345) — mirroring `PollBlockView`'s
// own container shape: an initial `getConnectState` read on mount, plus
// a live `subscribeConnectState` fold for every update after. With no
// port at all, the card renders the same fixed-disabled disconnected
// framing every other block's "no port, no feature" fallback uses.
//
// CL-6463: a card's own successful PAT submit is the one change this
// container never waits on the host to fan out on its own — a credential
// saved through *this* card's field gets its own explicit `getConnectState`
// refetch below, run once as the direct consequence of that one submit
// (not a poll). A credential saved anywhere else (the Plugins page,
// another tab) settles through `packages/chat/src/connect-pending.ts`'s
// `settleConnectedService`, which publishes `chat.settings`; ChatWorkspace
// parses that event and calls `notifySettingsChanged` so a card already
// mounted flips without remounting (CL-6476).
//
// CL-6741: once a card has read connected, a later loading/error fold
// (or a remount that starts on loading) must keep the last connected
// snapshot — never flash DisconnectedBody / "Connect" again over a
// known-good connection. An explicit `disconnected` result clears the
// snapshot so a real disconnect still shows Connect.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectGithubBlockData } from "@corbits/chat/blocks";
import { reportError } from "@corbits/error-sink";

import { CHAT_STRINGS } from "../strings";
import type {
  ConnectGithubActions,
  ConnectGithubQuery,
} from "./connect-github-actions";
import type { OnboardingScene } from "./connect-github-block";
import { ConnectGithubBlockView } from "./connect-github-block";

/** Positions in the room's three-step walkthrough. Which one is current
 * is read off the live connect state, never off the card's own data:
 * disconnected means connect, connected with nothing recorded (or a
 * person who pressed "change repos") means pick, and repos the server
 * actually recorded means reviewing. */
const STEP_CONNECT = 0;
const STEP_PICK = 1;
const STEP_REVIEWING = 2;

type ConnectedGithubQuery = Extract<ConnectGithubQuery, { kind: "connected" }>;

/** Survives container remounts so a post-connect loading flash never
 * resets the card to Connect (CL-6741). Cleared only on an explicit
 * disconnected result. */
const lastConnectedByMessageId = new Map<string, ConnectedGithubQuery>();

function rememberConnected(messageId: string, query: ConnectedGithubQuery) {
  lastConnectedByMessageId.set(messageId, query);
}

function forgetConnected(messageId: string) {
  lastConnectedByMessageId.delete(messageId);
}

function lastConnectedOf(messageId: string): ConnectedGithubQuery | undefined {
  return lastConnectedByMessageId.get(messageId);
}

/** A state read that fails is an error the card says out loud, never a
 * silent fall-through to "Connect GitHub" over a connection that
 * exists (CL-7189): an unhandled rejection used to leave the query on
 * `loading`, which renders the disconnected body. */
async function readConnectState(
  actions: ConnectGithubActions,
  messageId: string,
): Promise<ConnectGithubQuery> {
  try {
    return await actions.getConnectState(messageId);
  } catch (cause) {
    reportError(cause, { operation: "connect-github.getConnectState" });
    return {
      kind: "error",
      message: CHAT_STRINGS.blockConnectGithubStateUnreadable,
    };
  }
}

function displayQueryOf(
  messageId: string,
  query: ConnectGithubQuery,
): ConnectGithubQuery {
  if (query.kind === "connected" || query.kind === "disconnected") {
    return query;
  }
  const prior = lastConnectedOf(messageId);
  return prior ?? query;
}

export function ConnectGithubBlockContainer({
  data,
  messageId,
  actions,
}: {
  readonly data: ConnectGithubBlockData;
  readonly messageId: string;
  readonly actions?: ConnectGithubActions;
}) {
  const [query, setQuery] = useState<ConnectGithubQuery>(() => {
    return lastConnectedOf(messageId) ?? { kind: "loading" };
  });
  const [selectedRepoIds, setSelectedRepoIds] = useState<readonly string[]>(
    () => lastConnectedOf(messageId)?.selectedRepoIds ?? [],
  );
  /** A person who pressed "change repos" on the done state gets the
   * picker back without the server's recorded selection changing — only
   * pressing "Start reviewing" again writes anything. */
  const [repickRequested, setRepickRequested] = useState(false);
  const [startReviewingError, setStartReviewingError] = useState<
    string | undefined
  >(undefined);
  const mountedRef = useRef(true);
  const hadPickerRef = useRef(false);
  const hadConnectRef = useRef(false);

  const applyQuery = useCallback(
    (result: ConnectGithubQuery) => {
      if (!mountedRef.current) return;
      if (result.kind === "connected") {
        rememberConnected(messageId, result);
        setSelectedRepoIds(result.selectedRepoIds);
      } else if (result.kind === "disconnected") {
        forgetConnected(messageId);
      }
      setQuery(result);
    },
    [messageId],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (actions === undefined) return;
    void readConnectState(actions, messageId).then(applyQuery);
    const unsubscribe = actions.subscribeConnectState(messageId, applyQuery);
    return unsubscribe;
  }, [actions, messageId, applyQuery]);

  // The one refetch this container ever runs outside its mount effect:
  // a submit this card itself just made succeeded, so re-reading the
  // card's own state is a direct consequence of that submit — never a
  // poll, and it runs whether or not the host's `subscribeConnectState`
  // happens to fan the change out on its own.
  const submitAccessTokenAndRefresh = useCallback(
    async (token: string) => {
      if (actions === undefined) {
        return { ok: false as const, message: "Not available." };
      }
      const result = await actions.submitAccessToken(token);
      if (result.ok) {
        applyQuery(await readConnectState(actions, messageId));
      }
      return result;
    },
    [actions, messageId, applyQuery],
  );

  const displayQuery = displayQueryOf(messageId, query);
  const recordedRepoIds =
    displayQuery.kind === "connected" ? displayQuery.selectedRepoIds : [];
  const currentStepIndex =
    displayQuery.kind !== "connected"
      ? STEP_CONNECT
      : recordedRepoIds.length === 0 || repickRequested
        ? STEP_PICK
        : STEP_REVIEWING;
  if (currentStepIndex === STEP_CONNECT) hadConnectRef.current = true;
  if (currentStepIndex === STEP_PICK) hadPickerRef.current = true;
  const scene: OnboardingScene = {
    title: data.requiredForTemplate,
    currentStepIndex,
    ...(data.promise !== undefined ? { promise: data.promise } : {}),
    ...(data.steps !== undefined ? { steps: data.steps } : {}),
  };

  if (displayQuery.kind === "error") {
    return (
      <ConnectGithubBlockView
        scene={scene}
        kind="error"
        message={displayQuery.message}
        onConnect={() => actions?.requestConnect()}
        onSubmitAccessToken={submitAccessTokenAndRefresh}
      />
    );
  }

  if (actions === undefined || displayQuery.kind !== "connected") {
    return (
      <ConnectGithubBlockView
        scene={scene}
        kind="disconnected"
        onConnect={() => actions?.requestConnect()}
        onSubmitAccessToken={submitAccessTokenAndRefresh}
      />
    );
  }

  if (currentStepIndex === STEP_REVIEWING) {
    return (
      <ConnectGithubBlockView
        scene={scene}
        kind="reviewing"
        repoNames={displayQuery.repos
          .filter((repo) => recordedRepoIds.includes(repo.id))
          .map((repo) => repo.name)}
        onChangeRepos={() => setRepickRequested(true)}
        {...(hadPickerRef.current ? { autoFocus: true } : {})}
      />
    );
  }

  const connectedActions = actions;

  function toggleRepo(repoId: string) {
    setSelectedRepoIds((current) =>
      current.includes(repoId)
        ? current.filter((id) => id !== repoId)
        : [...current, repoId],
    );
  }

  async function startReviewing(repoIds: readonly string[]) {
    try {
      setStartReviewingError(undefined);
      await connectedActions.startReviewing(repoIds);
      if (mountedRef.current) setRepickRequested(false);
    } catch (cause) {
      reportError(cause, { operation: "connect-github.startReviewing" });
      if (mountedRef.current) {
        setStartReviewingError(
          CHAT_STRINGS.blockConnectGithubStartReviewingError,
        );
      }
    }
  }

  return (
    <ConnectGithubBlockView
      scene={scene}
      kind="connected"
      orgName={displayQuery.orgName}
      repos={displayQuery.repos}
      selectedRepoIds={selectedRepoIds}
      onToggleRepo={toggleRepo}
      onSelectAll={() =>
        setSelectedRepoIds(displayQuery.repos.map((repo) => repo.id))
      }
      onChangeConnection={connectedActions.requestConnect}
      onStartReviewing={(repoIds) => {
        void startReviewing(repoIds);
      }}
      onSkip={() => {
        void connectedActions.skip();
      }}
      {...(startReviewingError !== undefined
        ? { error: startReviewingError }
        : {})}
      {...(hadConnectRef.current ? { autoFocus: true } : {})}
    />
  );
}
