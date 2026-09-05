// The create-agent-definition surface: a tenant member submits a
// name/handle/description/system-prompt/model, and this route
// materializes it exactly the way the platform's own starter agents
// (`@corbits/assistant-workflow`, `@corbits/chat`'s workbench host) are
// materialized — a `workflow`-kind asset carrying a single-step
// definition as a source codebase (see `./definition-asset.ts`),
// projected onto a first-class `workflow_definition` row. No git subprocess: `AssetService.populateAsset` writes the
// commit in-process, the same seam `createAsset` used to hydrate a
// workbench host's asset lives beside.
//
// The definition lands with the schema's own default status
// ("deployed") and a non-null assetId, which is exactly what
// `ChatPlatform.listInvitableDefinitions`/`launchInvite` require to
// treat it as launchable — a freshly created agent is invitable and
// launchable the moment this route returns, no separate "deploy" step.

import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { DB } from "@intx/db";
import { asset, workflowDefinition } from "@intx/db/schema";
import type { TenantEnv, RequireGrant } from "@intx/hub-api";
import { idResource } from "@intx/hub-api";
import { DEFAULT_ASSET_REF } from "@intx/hub-sessions";
import type { AssetService } from "@intx/hub-sessions";

import {
  SkillRegistryError,
  type PinnedSkillIndexEntry,
} from "@corbits/skills";
import { isWorkbenchHostDefinitionName } from "@corbits/chat/workbench-host-naming";

import {
  createAgentDefinitionCore,
  DuplicateAgentHandleError,
  readAgentCapabilities,
  readAgentSystemPrompt,
  reindexPinnedSkills,
  withAgentSystemPrompt,
  withoutAgentModel,
  type CreateAgentDefinitionCoreDeps,
  type CreateAgentDefinitionCoreInput,
} from "./agent-workflow";
import { commitLatestAgentAssetSnapshot } from "./asset-write";
import { commitAgentCapabilityAdd } from "./capability-add";
import {
  agentDefinitionSourceTree,
  AGENT_DEFINITION_ENTRY_PATH,
  parseAgentDefinitionEntry,
  readAgentDefinitionWorkflowJson,
  RetiredWorkflowEnvelopeError,
  statusForAgentDefinitionDeployError,
  writeAndDeployAgentDefinition,
  WorkflowAuthorError,
  type AgentDefinitionDeployer,
} from "./definition-asset";
import type { DefinitionSkillsStore } from "./skills-store";
import {
  CreateAgentDefinitionInput,
  RestoreDefinitionInput,
  UpdateAgentInstructionsInput,
  UpdateAgentSkillsInput,
  UpdateDefinitionStatusInput,
} from "./validation";
import {
  AddCapabilityInput,
  assertCapabilityInInventory,
  CapabilityOutOfInventoryError,
  type CapabilityInventoryProvider,
} from "./capability-inventory";
import type { DefinitionAssetHistory } from "./definition-history";
import { listVisibleAgentDefinitions } from "./visible-definitions";
import { reportError } from "@corbits/error-sink";
import { makeErrorEnvelope } from "@corbits/error-sink";

/**
 * Resolves the pinned skill names a definition carries into the
 * name-and-description index its system prompt advertises. Required, not
 * optional: a definition pushed without a resolved index would carry
 * pins its agent has no way to discover.
 */
export type PinnedSkillIndexResolver = {
  resolve(
    tenantId: string,
    principalId: string,
    names: readonly string[],
  ): Promise<readonly PinnedSkillIndexEntry[]>;
};

export type CreateAgentDefinitionRoutesDeps = {
  db: DB["db"];
  assetService: AssetService;
  skillIndex: PinnedSkillIndexResolver;
  skillsStore: DefinitionSkillsStore;
  history: DefinitionAssetHistory;
  capabilityInventory: CapabilityInventoryProvider;
  requireGrant: RequireGrant;
  /** Deploys the definition's commit through the native source pipeline
   * on every content write; the composition root injects the SAME
   * `WorkflowDeployer` `@corbits/workflows`'s `./authoring`'s registry
   * calls. */
  deployer: AgentDefinitionDeployer;
  tenantDefaultModel?: CreateAgentDefinitionCoreDeps["tenantDefaultModel"];
};

/** The same 404 shape a missing definition gets — deliberately reused
 * for a workbench host's definition too (see `hostGuardedRow`), so a
 * caller cannot distinguish "no such definition" from "that id names a
 * workbench host" by response shape alone. */
function definitionNotFound(definitionId: string) {
  return makeErrorEnvelope({
    code: "not_found",
    userMessage: `No agent definition "${definitionId}" in this workbench`,
  });
}

/**
 * A workbench host is a single-step workflow definition exactly like a
 * hand-authored agent, but it is the workbench's own silent anchor, never
 * a participant a person edits through this surface — rewriting its
 * system prompt would turn a silent anchor into a responder. Refused
 * the same way a missing definition is: 404, not 403, so the row's
 * existence isn't leaked either.
 */
function hostGuardedRow(
  row: { readonly name: string; readonly assetId: string | null } | undefined,
): row is { readonly name: string; readonly assetId: string } {
  return (
    row !== undefined &&
    row.assetId !== null &&
    !isWorkbenchHostDefinitionName(row.name)
  );
}

export function createAgentDefinitionRoutes({
  db,
  assetService,
  skillIndex,
  skillsStore,
  history,
  capabilityInventory,
  requireGrant,
  deployer,
  tenantDefaultModel,
}: CreateAgentDefinitionRoutesDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  // Pinning a name the registry cannot resolve, or requesting a
  // capability out of the tenant's live inventory, is a bad request from
  // the person editing the agent, not a server fault — surface either as
  // one rather than letting it read as a 500.
  app.onError((err, c) => {
    if (err instanceof SkillRegistryError) {
      return c.json(
        makeErrorEnvelope({ code: "bad_request", userMessage: err.message }),
        400,
      );
    }
    if (err instanceof CapabilityOutOfInventoryError) {
      return c.json(
        makeErrorEnvelope({ code: "bad_request", userMessage: err.message }),
        400,
      );
    }
    if (err instanceof RetiredWorkflowEnvelopeError) {
      return c.json(
        makeErrorEnvelope({ code: "conflict", userMessage: err.message }),
        409,
      );
    }
    if (err instanceof WorkflowAuthorError) {
      return c.json(
        makeErrorEnvelope({ code: err.reason, userMessage: err.message }),
        statusForAgentDefinitionDeployError(err.reason),
      );
    }
    throw err;
  });

  app.post("/", requireGrant("workflow-definition:*", "create"), async (c) => {
    const body = CreateAgentDefinitionInput(
      await c.req.json().catch(() => undefined),
    );
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: `invalid agent definition: ${body.summary}`,
        }),
        400,
      );
    }

    const tenant = c.get("tenant");
    const principal = c.get("principal");

    const skills = body.skills ?? [];
    // `CreateAgentDefinitionCoreInput`'s optional fields are declared
    // under `exactOptionalPropertyTypes`, so an absent `description`/
    // `model` must be an absent key, not a key set to `undefined` —
    // built up mutably rather than as one literal, mirroring
    // `apps/hub`'s own `deployAgentDefinition` caller of this same core.
    const coreInput: {
      -readonly [
        K in keyof CreateAgentDefinitionCoreInput
      ]: CreateAgentDefinitionCoreInput[K];
    } = {
      tenantId: tenant.id,
      principalId: principal.id,
      tenantDomain: tenant.domain,
      handle: body.handle,
      name: body.name,
      systemPrompt: body.systemPrompt,
      skills,
    };
    if (body.description !== undefined)
      coreInput.description = body.description;
    if (body.model !== undefined) coreInput.model = body.model;
    if (body.toolPackagePins !== undefined && body.toolPackagePins.length > 0) {
      coreInput.toolPackagePins = body.toolPackagePins;
    }

    let row: Awaited<ReturnType<typeof createAgentDefinitionCore>>["row"];
    try {
      ({ row } = await createAgentDefinitionCore(
        {
          db,
          assetService,
          skillIndex,
          skillsStore,
          deployer,
          ...(tenantDefaultModel !== undefined ? { tenantDefaultModel } : {}),
        },
        coreInput,
      ));
    } catch (cause) {
      if (cause instanceof DuplicateAgentHandleError) {
        return c.json(
          makeErrorEnvelope({ code: "conflict", userMessage: cause.message }),
          409,
        );
      }
      throw cause;
    }

    return c.json(
      {
        id: row.id,
        tenantId: row.tenantId,
        name: row.name,
        description: row.description ?? null,
        currentVersion: row.currentVersion,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        skills,
      },
      201,
    );
  });

  app.get(
    "/skills",
    requireGrant("workflow-definition:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const idsParam = c.req.query("ids") ?? "";
      const ids = [
        ...new Set(
          idsParam
            .split(",")
            .map((id) => id.trim())
            .filter((id) => id !== ""),
        ),
      ];

      const entries = await Promise.all(
        ids.map(async (definitionId) => {
          const row = await db.query.workflowDefinition.findFirst({
            where: and(
              eq(workflowDefinition.id, definitionId),
              eq(workflowDefinition.tenantId, tenant.id),
            ),
          });
          if (row === undefined || row.assetId === null) return null;
          const skills = await skillsStore.getSkills(row.assetId);
          return [definitionId, skills] as const;
        }),
      );

      const skills: Record<string, readonly string[]> = {};
      for (const entry of entries) {
        if (entry !== null) skills[entry[0]] = entry[1];
      }
      return c.json({ skills });
    },
  );

  // Feeds the settings surface's guided capability-add picker with only
  // what this tenant actually has — the same source `POST
  // /:definitionId/capabilities` re-checks fail-closed on the add itself,
  // so a name this call doesn't list can never be added either.
  app.get(
    "/capabilities/inventory",
    requireGrant("workflow-definition:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const inventory = await capabilityInventory.resolve({
        tenantId: tenant.id,
        principalId: principal.id,
      });
      return c.json(inventory);
    },
  );

  // Every agent this tenant can open a direct chat with — its own agent
  // definitions plus every ancestor's (CL-6253): the sidebar's unified
  // recency-sorted stream reads this list, keyed by `tenantId` per row
  // so a click can mint the DM in the agent's actual owning tenant, not
  // the caller's.
  app.get(
    "/visible",
    requireGrant("workflow-definition:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const definitions = await listVisibleAgentDefinitions(db, tenant.id);
      return c.json({ definitions });
    },
  );

  // A definition's kebab `name` is its immutable, URL-facing slug
  // (CL-6413), so a slug-addressed detail screen resolves through this
  // route rather than scanning a page of the definitions listing — an
  // agent past the listing's pagination ceiling still answers on its own
  // URL. Grant-checked tenant-wide because there is no definition id to
  // scope to until the lookup itself has run.
  app.get(
    "/by-name/:name",
    requireGrant("workflow-definition:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const name = c.req.param("name");
      const row = await db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.name, name),
          eq(workflowDefinition.tenantId, tenant.id),
        ),
      });
      if (!hostGuardedRow(row)) {
        return c.json(definitionNotFound(name), 404);
      }

      return c.json({
        id: row.id,
        tenantId: row.tenantId,
        name: row.name,
        description: row.description ?? null,
        currentVersion: row.currentVersion,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    },
  );

  app.get(
    "/:definitionId",
    requireGrant(idResource("workflow-definition", "definitionId"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const definitionId = c.req.param("definitionId");
      const row = await db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, definitionId),
          eq(workflowDefinition.tenantId, tenant.id),
        ),
      });
      if (!hostGuardedRow(row)) {
        return c.json(definitionNotFound(definitionId), 404);
      }

      const workflowJson = await readAgentDefinitionWorkflowJson(
        assetService,
        row.assetId,
      );
      const capabilities = readAgentCapabilities(workflowJson);
      const skills = await skillsStore.getSkills(row.assetId);

      return c.json({
        id: row.id,
        name: row.description ?? row.name,
        systemPrompt: readAgentSystemPrompt(workflowJson),
        toolPackagePins: capabilities.toolPackagePins,
        skills,
        model: capabilities.model,
      });
    },
  );

  app.get(
    "/:definitionId/versions",
    requireGrant(idResource("workflow-definition", "definitionId"), "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const definitionId = c.req.param("definitionId");
      const row = await db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, definitionId),
          eq(workflowDefinition.tenantId, tenant.id),
        ),
      });
      if (!hostGuardedRow(row)) {
        return c.json(definitionNotFound(definitionId), 404);
      }

      const commits = await history.history(row.assetId);
      const versions = commits.map((commit, index) => ({
        ...commit,
        current: index === 0,
      }));
      return c.json({ versions });
    },
  );

  app.post(
    "/:definitionId/restore",
    requireGrant(idResource("workflow-definition", "definitionId"), "update"),
    async (c) => {
      const body = RestoreDefinitionInput(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid restore: ${body.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const definitionId = c.req.param("definitionId");
      const row = await db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, definitionId),
          eq(workflowDefinition.tenantId, tenant.id),
        ),
      });
      if (!hostGuardedRow(row)) {
        return c.json(definitionNotFound(definitionId), 404);
      }

      const entryBytes = await history.readBlobAtCommit({
        assetId: row.assetId,
        path: AGENT_DEFINITION_ENTRY_PATH,
        commitSha: body.commitSha,
      });
      if (entryBytes === null) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: `agent "${row.name}" has no instructions at that point in its history`,
          }),
          404,
        );
      }
      const restoredWorkflowJson = parseAgentDefinitionEntry(
        entryBytes,
        row.assetId,
      );

      // Pinned skills live outside the asset tree (see
      // `DefinitionSkillsStore`), so restoring a prior commit only ever
      // rewrites the definition's source tree — the definition's
      // currently pinned skills are untouched by restoring an earlier
      // instructions revision.
      await writeAndDeployAgentDefinition({
        assetService,
        deployer,
        tenantId: tenant.id,
        principalId: principal.id,
        assetId: row.assetId,
        handle: row.name,
        workflowJson: restoredWorkflowJson,
        message: `Restore agent ${row.name} to ${body.commitSha.slice(0, 8)}`,
      });

      const capabilities = readAgentCapabilities(restoredWorkflowJson);
      const skills = await skillsStore.getSkills(row.assetId);

      return c.json({
        id: row.id,
        name: row.description ?? row.name,
        systemPrompt: readAgentSystemPrompt(restoredWorkflowJson),
        toolPackagePins: capabilities.toolPackagePins,
        skills,
        model: capabilities.model,
      });
    },
  );

  app.post(
    "/:definitionId/capabilities",
    requireGrant(idResource("workflow-definition", "definitionId"), "update"),
    async (c) => {
      const body = AddCapabilityInput(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid capability: ${body.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const definitionId = c.req.param("definitionId");
      const row = await db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, definitionId),
          eq(workflowDefinition.tenantId, tenant.id),
        ),
      });
      if (!hostGuardedRow(row)) {
        return c.json(definitionNotFound(definitionId), 404);
      }

      const inventory = await capabilityInventory.resolve({
        tenantId: tenant.id,
        principalId: principal.id,
      });
      // Throws `CapabilityOutOfInventoryError`, caught by `app.onError`
      // above — fail closed against exactly the inventory this call just
      // fetched, never a stale or wider one.
      assertCapabilityInInventory(body, inventory);

      const added = await commitAgentCapabilityAdd({
        db,
        assetService,
        deployer,
        skillsStore,
        skillIndex,
        tenantId: tenant.id,
        principalId: principal.id,
        assetId: row.assetId,
        handle: row.name,
        body,
      });
      return c.json(added);
    },
  );

  app.put(
    "/:definitionId",
    requireGrant(idResource("workflow-definition", "definitionId"), "update"),
    async (c) => {
      const body = UpdateAgentInstructionsInput(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid agent instructions: ${body.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const definitionId = c.req.param("definitionId");
      const row = await db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, definitionId),
          eq(workflowDefinition.tenantId, tenant.id),
        ),
      });
      if (!hostGuardedRow(row)) {
        return c.json(definitionNotFound(definitionId), 404);
      }

      const next = await commitLatestAgentAssetSnapshot({
        assetService,
        assetId: row.assetId,
        operation: "update instructions",
        prepare: (snapshot) =>
          Promise.resolve({
            workflowJson: withAgentSystemPrompt(snapshot, body.systemPrompt),
            message: `Update agent instructions for ${row.name}`,
            result: { name: body.name, systemPrompt: body.systemPrompt },
          }),
        write: async ({ workflowJson, message }) => {
          // Git first: the row updates below are what can still be retried
          // safely if they fail after this succeeds (see the catch below) —
          // the reverse order would leave a renamed row pointing at
          // instructions that were never actually written.
          await writeAndDeployAgentDefinition({
            assetService,
            deployer,
            tenantId: tenant.id,
            principalId: principal.id,
            assetId: row.assetId,
            handle: row.name,
            workflowJson,
            message,
          });
        },
      });

      const now = new Date();
      try {
        await db.transaction(async (tx) => {
          await tx
            .update(workflowDefinition)
            .set({ description: body.name, updatedAt: now })
            .where(
              and(
                eq(workflowDefinition.id, definitionId),
                eq(workflowDefinition.tenantId, tenant.id),
              ),
            );
          await tx
            .update(asset)
            .set({ displayName: body.name, updatedAt: now })
            .where(eq(asset.id, row.assetId));
        });
      } catch (err) {
        const refId = reportError(err, {
          operation: "agentDirectory.updateInstructions.rename",
          tenantId: tenant.id,
        });
        return c.json(
          makeErrorEnvelope({
            code: "partial_failure",
            userMessage:
              `The instructions saved, but renaming "${row.name}" to ` +
              `"${body.name}" failed — the agent now answers with the new ` +
              `instructions under its old name. Retry to finish the rename.`,
            refId,
          }),
          500,
        );
      }

      return c.json(next);
    },
  );

  // Un-pinning a model is its own verb, not `POST /capabilities` with an
  // empty name: that route's whole contract is "a name from this tenant's
  // live inventory", and "no model at all" is not a name. Clearing returns
  // the definition to resolving whatever catalog default the tenant has
  // seeded, which is where a definition created without a model already
  // sits — so "Bench default" is a state a person can get back to, not a
  // one-way door.
  app.delete(
    "/:definitionId/capabilities/model",
    requireGrant(idResource("workflow-definition", "definitionId"), "update"),
    async (c) => {
      const tenant = c.get("tenant");
      const definitionId = c.req.param("definitionId");
      const row = await db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, definitionId),
          eq(workflowDefinition.tenantId, tenant.id),
        ),
      });
      if (!hostGuardedRow(row)) {
        return c.json(definitionNotFound(definitionId), 404);
      }

      const cleared = await commitLatestAgentAssetSnapshot({
        assetService,
        assetId: row.assetId,
        operation: "clear model",
        prepare: async (snapshot) => {
          const workflowJson = withoutAgentModel(snapshot);
          const capabilities = readAgentCapabilities(workflowJson);
          const skills = await skillsStore.getSkills(row.assetId);
          return {
            workflowJson,
            message: `Clear ${row.name}'s model`,
            result: {
              toolPackagePins: capabilities.toolPackagePins,
              skills,
              model: capabilities.model,
            },
          };
        },
        write: async ({ workflowJson, message }) => {
          await assetService.populateAsset({
            assetId: row.assetId,
            ref: DEFAULT_ASSET_REF,
            principal: { kind: "hub" },
            tree: {
              files: agentDefinitionSourceTree({
                handle: row.name,
                workflowJson,
              }),
              message,
            },
          });
        },
      });
      return c.json(cleared);
    },
  );

  // Archive and restore: a definition's status is the whole lifecycle a
  // person controls from the agent detail page. `stopped` drops it out of
  // every launchable listing (`listVisibleAgentDefinitions`,
  // `listInvitableDefinitions`) while leaving the row, its asset, and its
  // git history untouched — which is what makes the same route, with
  // `deployed`, a restore rather than a re-create.
  //
  // The invariant this route relies on, and the two other writers of
  // `workflow_definition.status` in this build:
  //
  //   1. Row creation. `@intx/hub-sessions`' `ensureWorkflowDefinitionForAsset`
  //      inserts with the column default (`deployed`) under
  //      `onConflictDoNothing` on `(assetId, wireHash)` — so re-deploying
  //      the same definition body over an archived row is a no-op and can
  //      never silently un-archive it. Editing an agent through this
  //      package's own routes only repopulates the asset and never
  //      re-projects a definition row at all.
  //   2. `apps/hub`'s `undeployAgentDefinition`, which writes `stopped` —
  //      the same direction as archiving, so the two cannot fight.
  //
  // The one way an archived agent reappears as launchable is a deploy of a
  // CHANGED body over the same asset: a new `wireHash` misses the unique
  // constraint and inserts a SECOND definition row, `deployed` by default,
  // beside the archived one. Nothing in this build takes that path for a
  // hand-authored agent (only `createAgentDefinitionCore` and Interchange's
  // own selector deploys call the ensure), but it is a real hole in the
  // status-as-lifecycle model rather than a hypothetical one, and archiving
  // by row status is what makes it reachable.
  app.put(
    "/:definitionId/status",
    requireGrant(idResource("workflow-definition", "definitionId"), "update"),
    async (c) => {
      const body = UpdateDefinitionStatusInput(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid status: ${body.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const definitionId = c.req.param("definitionId");
      const row = await db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, definitionId),
          eq(workflowDefinition.tenantId, tenant.id),
        ),
      });
      if (!hostGuardedRow(row)) {
        return c.json(definitionNotFound(definitionId), 404);
      }

      await db
        .update(workflowDefinition)
        .set({ status: body.status, updatedAt: new Date() })
        .where(
          and(
            eq(workflowDefinition.id, definitionId),
            eq(workflowDefinition.tenantId, tenant.id),
          ),
        );

      return c.json({ id: definitionId, status: body.status });
    },
  );

  app.put(
    "/:definitionId/skills",
    requireGrant(idResource("workflow-definition", "definitionId"), "update"),
    async (c) => {
      const body = UpdateAgentSkillsInput(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          makeErrorEnvelope({
            code: "bad_request",
            userMessage: `invalid skills list: ${body.summary}`,
          }),
          400,
        );
      }

      const tenant = c.get("tenant");
      const definitionId = c.req.param("definitionId");
      const row = await db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, definitionId),
          eq(workflowDefinition.tenantId, tenant.id),
        ),
      });
      if (row === undefined || row.assetId === null) {
        return c.json(
          makeErrorEnvelope({
            code: "not_found",
            userMessage: `No agent definition "${definitionId}" in this workbench`,
          }),
          404,
        );
      }

      const assetId = row.assetId;
      const principal = c.get("principal");
      const updated = await commitLatestAgentAssetSnapshot({
        assetService,
        assetId,
        operation: "update skills",
        prepare: async (snapshot) => {
          const workflowJson = reindexPinnedSkills(
            snapshot,
            await skillIndex.resolve(tenant.id, principal.id, body.skills),
          );
          return {
            workflowJson,
            message: `Update agent skills for ${row.name}`,
            afterWrite: () => skillsStore.setSkills(assetId, body.skills),
            result: { skills: body.skills },
          };
        },
        write: async ({ workflowJson, message }) => {
          await writeAndDeployAgentDefinition({
            assetService,
            deployer,
            tenantId: tenant.id,
            principalId: principal.id,
            assetId,
            handle: row.name,
            workflowJson,
            message,
          });
        },
      });
      return c.json(updated);
    },
  );

  return app;
}
