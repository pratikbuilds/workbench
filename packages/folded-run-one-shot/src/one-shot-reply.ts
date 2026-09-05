// A synchronous wrapper around one folded run's opening turn: launch,
// send the prompt, wait for exactly one reply, tear down the
// subscription AND the launched run itself. Other run launchers return
// as soon as the run starts, with the reply landing asynchronously via
// a subscription to the run's own event stream and a later delivery
// (an Inbox item, say); this module is the one place that turns that
// same event stream into an awaitable promise, for a caller — a
// drafting or planning prompt, e.g. — that has no such later-delivery
// surface to hang a reply on and must resolve in the same
// request/response cycle that asked for it.
import { and, eq } from "drizzle-orm";
import { tenant as tenantTable, workflowDefinition } from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import type { SidecarEventEmitter } from "@intx/hub-sessions";
import { formatRunAddress } from "@intx/types";
import type { FoldedBody } from "@intx/workflow-deploy";
import type { AgentLifecycle } from "@corbits/agent-lifecycle";
import { connectorReplyContent, messageRunEnded } from "@corbits/agent-events";
import {
  readDefinitionProjection,
  readFoldedBody,
  launchFoldedRun as launchFoldedRunDefault,
  sendFoldedMailWithRetry as sendFoldedMailWithRetryDefault,
  type CryptoProviderCache,
  type FoldedRunsDeps,
} from "@corbits/folded-runs";

const log = getLogger(["folded-runs", "one-shot-reply"]);

export type OneShotReply = {
  readonly content: string;
  readonly runId: string;
};

export type OneShotRunnerDeps = {
  readonly foldedRuns: FoldedRunsDeps;
  readonly events: SidecarEventEmitter;
  readonly cryptoProviders: CryptoProviderCache;
  /** Same optional idle-sleep lifecycle tracking a longer-lived
   * launched run takes — optional, since a caller that hasn't wired
   * lifecycle tracking yet still gets a working call, just without
   * idle-sleep bookkeeping. */
  readonly lifecycle?: Pick<
    AgentLifecycle,
    "track" | "recordActivity" | "untrack"
  >;
  /**
   * Tears the launched run's address down on the host. REQUIRED,
   * unlike `lifecycle`: a longer-lived launched run lives on after
   * it launches, tracked by idle-sleep until it goes quiet — but a
   * one-shot run has no further purpose once it settles, so it must be
   * torn down immediately on every settle path (success, failure,
   * timeout, or a send-path throw), never left for an idle sweep. The
   * same raw port a host's own `AgentLifecycle`'s `undeploy` option
   * already is — e.g. `apps/hub`'s `sidecarRouter.sendAgentUndeploy`.
   */
  readonly undeploy: (address: string, reason: string) => Promise<void>;
  /**
   * Test seam only — no production caller ever sets these. Defaults to
   * the real `@corbits/folded-runs` `launchFoldedRun`/
   * `sendFoldedMailWithRetry`. Exists because a whole-repo `bun test`
   * run shares one process-wide module registry across every package —
   * `@corbits/folded-runs`' own `test/launch.test.ts` and
   * `test/mail.test.ts` dynamically import the exact modules a
   * `mock.module("@corbits/folded-runs", ...)` here would replace — a
   * plain injected override sidesteps that shared-registry collision
   * entirely rather than racing it.
   */
  readonly launchFoldedRun?: typeof launchFoldedRunDefault;
  readonly sendFoldedMailWithRetry?: typeof sendFoldedMailWithRetryDefault;
};

export type OneShotPromptInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly definitionId: string;
  readonly prompt: string;
  readonly timeoutMs: number;
};

export class OneShotDefinitionNotFoundError extends Error {
  constructor(definitionId: string) {
    super(`No definition "${definitionId}" for this tenant`);
    this.name = "OneShotDefinitionNotFoundError";
  }
}

export class FoldedRunTimedOutError extends Error {
  constructor(timeoutMs: number) {
    super(`the folded run did not reply within ${String(timeoutMs)}ms`);
    this.name = "FoldedRunTimedOutError";
  }
}

export class FoldedRunFailedError extends Error {
  constructor(errorMessage: string | undefined) {
    super(
      errorMessage !== undefined
        ? `the folded run failed: ${errorMessage}`
        : "the folded run failed",
    );
    this.name = "FoldedRunFailedError";
  }
}

/**
 * Launches a folded run against `input.definitionId`, sends
 * `input.prompt` as its opening mail, and resolves with the run's
 * accumulated `connector.reply` content once its opening turn's
 * `message.run.ended` bracket closes — or rejects with
 * `FoldedRunFailedError` (the run itself ended `"failed"`) or
 * `FoldedRunTimedOutError` (`input.timeoutMs` elapsed first).
 *
 * Deliberately bypasses any task/Inbox-delivery launcher: this run
 * gets no owning row and no Inbox delivery — `launchFoldedRun` is
 * called directly with no `persistExtra`. The event subscription always
 * unsubscribes exactly once, and `deps.undeploy` always tears the
 * launched run down exactly once, on every exit path (success, run
 * failure, timeout, or a send-path throw) — a caller that runs many
 * one-shot prompts in one process never leaks listeners OR live run
 * instances.
 */
export async function runOneShotFoldedPrompt(
  deps: OneShotRunnerDeps,
  input: OneShotPromptInput,
): Promise<OneShotReply> {
  const definitionRow =
    await deps.foldedRuns.db.query.workflowDefinition.findFirst({
      where: and(
        eq(workflowDefinition.id, input.definitionId),
        eq(workflowDefinition.tenantId, input.tenantId),
      ),
    });
  if (definitionRow === undefined || definitionRow.assetId === null) {
    throw new OneShotDefinitionNotFoundError(input.definitionId);
  }

  const tenantRow = await deps.foldedRuns.db.query.tenant.findFirst({
    where: eq(tenantTable.id, input.tenantId),
  });
  if (tenantRow === undefined) {
    throw new Error(`No tenant "${input.tenantId}"`);
  }

  const projection = await readDefinitionProjection(
    deps.foldedRuns.db,
    definitionRow,
  );
  const definitionBody = readFoldedBody(
    projection,
    definitionRow.grantRequirements,
  );
  const foldedBody: FoldedBody = {
    systemPrompt: definitionBody.systemPrompt,
    toolPackagePins: definitionBody.toolPackagePins,
    grantRequirements: definitionBody.grantRequirements,
    credentialBindings: definitionBody.credentialBindings,
    model: definitionBody.model,
  };

  const instanceId = generateId("workflowRun");
  const triggerAddress = formatRunAddress(instanceId, tenantRow.domain);

  const launchRun = deps.launchFoldedRun ?? launchFoldedRunDefault;
  const sendMail =
    deps.sendFoldedMailWithRetry ?? sendFoldedMailWithRetryDefault;

  const launched = await launchRun(deps.foldedRuns, {
    tenantId: input.tenantId,
    instanceId,
    triggerAddress,
    definitionId: input.definitionId,
    foldedBody,
    launchLabel: "the planning run",
  });

  deps.lifecycle?.track(triggerAddress);
  deps.lifecycle?.recordActivity(triggerAddress);

  return new Promise<OneShotReply>((resolve, reject) => {
    let settled = false;
    let accumulated = "";

    const unsubscribe = deps.events.on(
      "agent.event",
      ({ agentAddress, event }) => {
        if (agentAddress !== triggerAddress || settled) return;

        const content = connectorReplyContent(event);
        if (content !== undefined) {
          accumulated += content;
          return;
        }

        const ended = messageRunEnded(event);
        if (ended === undefined) return;

        if (ended.status === "failed") {
          void settle("planning-run-failed", () => {
            reject(new FoldedRunFailedError(ended.errorMessage));
          });
          return;
        }
        void settle("planning-run-complete", () => {
          resolve({ content: accumulated, runId: instanceId });
        });
      },
    );

    // Tears the run down exactly once, on whichever exit path calls it
    // first — success, failure, timeout, or a send-path throw. `finish`
    // (the caller's own resolve/reject) only runs once teardown has
    // settled, so a failed `undeploy` never masks the real outcome and
    // never leaves the outer promise hanging: it's logged and teardown
    // proceeds to `untrack` regardless.
    async function settle(reason: string, finish: () => void): Promise<void> {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      try {
        await deps.undeploy(triggerAddress, reason);
      } catch (err) {
        log.error`one-shot run ${triggerAddress}: undeploy failed during teardown (${reason}): ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
      deps.lifecycle?.untrack(triggerAddress);
      finish();
    }

    const timer = setTimeout(() => {
      void settle("planning-run-timed-out", () => {
        reject(new FoldedRunTimedOutError(input.timeoutMs));
      });
    }, input.timeoutMs);

    void (async () => {
      try {
        // Keyed by the launched run's instance id (`generateId("workflowRun")`),
        // the same string shape chat uses for workbench ids — the host
        // injects its process-wide cache rather than this runner minting
        // one of its own.
        const cryptoProvider = await deps.cryptoProviders.get(instanceId);
        const sent = await sendMail(deps.foldedRuns, {
          tenantId: input.tenantId,
          sessionId: launched.sessionId,
          agentAddress: triggerAddress,
          from: `${input.principalId}@${tenantRow.domain}`,
          domain: tenantRow.domain,
          content: input.prompt,
          cryptoProvider,
        });
        if (!sent.ok) {
          void settle("planning-run-send-failed", () => {
            reject(
              sent.error instanceof Error
                ? sent.error
                : new Error(String(sent.error)),
            );
          });
        }
      } catch (cause) {
        void settle("planning-run-send-failed", () => {
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        });
      }
    })();
  });
}
