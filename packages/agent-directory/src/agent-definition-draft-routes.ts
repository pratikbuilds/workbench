// The HTTP surface for Myra-backed agent-definition drafting
// (CL-6074): tenant-scoped, `requireGrant`-gated, personal to the
// requesting principal, request parsing via arktype at the boundary,
// route registration only. Error copy at this boundary is plain
// language for the person who typed the description; the technical
// detail every fail-closed error class carries goes to the server log
// instead.
//
// Relocated out of `@corbits/task-planner` (deleted along with the
// rest of the tasks primitive) because this drafting flow was never a
// task concept — it backs the "Describe" step of agent creation
// (`CreateAgentPanel` and onboarding), which stays.
import { type } from "arktype";
import { Hono } from "hono";

import type { TenantEnv, RequireGrant } from "@intx/hub-api";
import {
  FoldedRunFailedError,
  FoldedRunTimedOutError,
} from "@corbits/folded-run-one-shot";
import { makeErrorEnvelope, reportError } from "@corbits/error-sink";
import {
  AgentDefinitionDraftReferenceOutOfInventoryError,
  AgentDefinitionDraftReplyUnparseableError,
  MyraAgentDefinitionDraftingUnavailableError,
  type AgentDefinitionDraft,
} from "./agent-definition-drafting";

const DRAFT_FAILED_MESSAGE =
  "Myra couldn't draft a starting prompt for that. Write one yourself, or try again.";

const CreateAgentDefinitionDraftBody = type({
  name: "string > 0",
  "purpose?": "string > 0",
});

export type CreateAgentDefinitionDraftRoutesDeps = {
  requireGrant: RequireGrant;
  /**
   * The agent-definition drafting port (CL-6074) — omitted entirely on
   * a host that hasn't wired Myra drafting up yet, in which case this
   * route 404s rather than pretending to draft and always failing.
   * The route never touches `./agent-definition-drafting.ts`'s
   * runner/inventory machinery directly, so it stays testable with a
   * plain stub — no database, no folded-run machinery.
   */
  draftAgentDefinition?(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly name: string;
    readonly purpose?: string;
  }): Promise<AgentDefinitionDraft>;
};

/** Every fail-closed error the agent-definition drafting path can throw
 * — Myra unresolvable, the run timing out or failing, an unparseable
 * reply, or an out-of-inventory model/tool package/skill reference —
 * reads as the same honest "couldn't draft" 422 to the person who typed
 * the description: from their point of view it is still "Myra's draft
 * didn't work out," never a REST-shaped bad request they authored
 * themselves. */
function isDraftingFailure(err: unknown): boolean {
  return (
    err instanceof MyraAgentDefinitionDraftingUnavailableError ||
    err instanceof FoldedRunTimedOutError ||
    err instanceof FoldedRunFailedError ||
    err instanceof AgentDefinitionDraftReplyUnparseableError ||
    err instanceof AgentDefinitionDraftReferenceOutOfInventoryError
  );
}

export function createAgentDefinitionDraftRoutes(
  deps: CreateAgentDefinitionDraftRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  // A person can't have two "draft this agent" runs racing at once — a
  // plain-language 409-ish rejection of a same-principal concurrent
  // second request, released in a `finally` once the first settles.
  // In-memory only: a process restart or a second replica resets/
  // bypasses this guard.
  const inFlightDraftingPrincipals = new Set<string>();

  // Always mounted: a host without a drafting port answers an honest 503
  // instead of the route silently not existing (a 404 the client cannot
  // tell apart from a renamed path).
  app.post(
    "/agent-definitions/draft",
    deps.requireGrant("workflow-definition:*", "create"),
    async (c) => {
      const draftAgentDefinition = deps.draftAgentDefinition;
      if (draftAgentDefinition === undefined) {
        return c.json(
          makeErrorEnvelope({
            code: "unavailable",
            userMessage: "Agent drafting is not configured on this hub.",
          }),
          503,
        );
      }
      const body = CreateAgentDefinitionDraftBody(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `This couldn't be read: ${body.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");

      if (inFlightDraftingPrincipals.has(principal.id)) {
        return c.json(
          makeErrorEnvelope({
            code: "dispatch_in_progress",
            userMessage: "Myra is already drafting your last agent.",
          }),
          409,
        );
      }
      inFlightDraftingPrincipals.add(principal.id);

      try {
        const draft = await draftAgentDefinition({
          tenantId: tenant.id,
          principalId: principal.id,
          name: body.name,
          ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
        });
        return c.json({ draft }, 201);
      } catch (err) {
        if (isDraftingFailure(err)) {
          const refId = reportError(err, {
            operation: "agentDirectory.draftAgentDefinition",
            tenantId: tenant.id,
            extra: { principalId: principal.id },
          });
          return c.json(
            makeErrorEnvelope({
              code: "drafting_failed",
              userMessage: DRAFT_FAILED_MESSAGE,
              refId,
            }),
            422,
          );
        }
        throw err;
      } finally {
        inFlightDraftingPrincipals.delete(principal.id);
      }
    },
  );

  return app;
}
