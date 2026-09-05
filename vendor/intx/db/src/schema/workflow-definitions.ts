import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { asset } from "./assets";
import { principal } from "./principals";
import { tenant } from "./tenants";

// workflow_definition is the first-class definition entity for the workflow
// model: one row per deployable definition, with a version table alongside it.
//
// The definition body (system prompt, context/model config, tool packages) is
// not stored on this row -- it lives in the `workflow`-kind asset the row
// points at, and the run reads it back from there. `asset_id` is nullable at
// the schema level, but a runnable definition points at a materialized asset.
//
// Identity is selector-keyed on the wire-projection hash, not one definition
// per asset: a single asset (e.g. a monorepo package) backs many definitions
// distinguished by the content hash of their wire projection. `wire_hash` is
// that content handle; the unique index over `(asset_id, wire_hash)` keys
// identity so definitions sharing an asset but carrying different wire hashes
// resolve independently. `wire_hash` is nullable so definitions predating this
// key carry none; Postgres treats those NULLs as distinct.
export const workflowDefinition = pgTable(
  "workflow_definition",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    // Nullable to match the weaker of the two definition sources: `asset`'s
    // creator principal is `onDelete: "set null"`, so a workflow asset whose
    // creator principal was removed carries no creator onto the definition.
    creatorPrincipalId: text("creator_principal_id").references(
      () => principal.id,
    ),
    // The asset holding this definition's body. `restrict`: the definition is
    // the first-class entity, so deleting the asset must not cascade into
    // deleting it.
    assetId: text("asset_id").references(() => asset.id, {
      onDelete: "restrict",
    }),
    // Content hash of this definition's wire projection: the selector that
    // keys identity within an asset. Nullable so definitions predating the
    // selector-keyed key carry none.
    wireHash: text("wire_hash"),
    name: text("name").notNull(),
    description: text("description"),
    // WORKBENCH DELTA (see VENDORED.md): whether this row is a
    // definition in its own right or the per-run record of one deploy.
    // "authored" (the default: a definition someone deployed or the hub
    // froze) is launch-authoritative — the row an agent's edits refreeze
    // in place. "run" is the sibling a folded run's deploy ensures over
    // that same asset under the wire hash of its per-run rendered bytes:
    // a frozen deploy record, never a launch candidate. Without the
    // distinction, resolution fell back to matching on `name` and every
    // run's clone shadowed the agent's own definition (CL-6452).
    origin: text("origin", { enum: ["authored", "run"] })
      .notNull()
      .default("authored"),
    // WORKBENCH DELTA (see VENDORED.md, CL-4455): last UTC minuteKey this
    // definition's native ScheduleTrigger already claimed. Null means never.
    // Not part of wire_hash.
    scheduleClaimedMinute: text("schedule_claimed_minute"),
    // Grant requirements manifest, resolved at launch into materialized grants.
    // Validated as GrantRequirement[] at parse time.
    grantRequirements: jsonb("grant_requirements"),
    // Model requirements manifest: the canonical model names + provider
    // preferences a definition launched as a single interactive run resolves
    // against the live tenant catalog into credential-bearing inference
    // sources, fresh each launch. Non-null marks such a definition and gates
    // the interactive-launch path; null for a definition deployed as a workflow,
    // which supplies its sources at deploy time. Validated as ModelRequirements
    // at parse time.
    modelRequirements: jsonb("model_requirements"),
    // Credential bindings manifest: maps a tool package's declared credential
    // handle (package, handle) to a concrete credential resolved fresh at
    // launch (by locator + provider + name against the tenant walk-up).
    // Validated as CredentialBinding[] at parse time. A binding is a request
    // the launch-time grant gate authorizes; it consents to nothing on its own.
    credentialBindings: jsonb("credential_bindings"),
    currentVersion: text("current_version").notNull().default("1"),
    status: text("status", {
      enum: ["deployed", "stopped"],
    })
      .notNull()
      .default("deployed"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("workflow_definition_tenant_idx").on(t.tenantId, t.createdAt),
    uniqueIndex("workflow_definition_asset_wire_hash_idx").on(
      t.assetId,
      t.wireHash,
    ),
  ],
);

export const workflowDefinitionVersion = pgTable(
  "workflow_definition_version",
  {
    id: text("id").primaryKey(),
    definitionId: text("definition_id")
      .notNull()
      .references(() => workflowDefinition.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    status: text("status", {
      enum: ["active", "inactive", "failed"],
    })
      .notNull()
      .default("active"),
    // Hash of the wire bytes approved for this version, recorded at approval
    // and read back during re-verify to detect drift. Null before approval is
    // a legitimate state, so the column takes no NOT NULL constraint.
    approvedWireHash: text("approved_wire_hash"),
    // Serializable projection of the deploy-time capability walk, recorded
    // at approval so a run materializes grants from it instead of re-reading
    // and re-walking a workflow.json blob. Validated as GrantWalkSnapshot at
    // parse time. Null before approval is a legitimate state, so the column
    // takes no NOT NULL constraint.
    grantSnapshot: jsonb("grant_snapshot"),
    // WORKBENCH DELTA (see VENDORED.md): the inert wire projection the freeze
    // hashed, stored beside the hash it is keyed to. Under the workflow.json
    // retirement a definition's body is whatever its source closure evaluates
    // to, and a source-format asset carries no envelope to read it back from --
    // so a launch that needs the body (a folded run reading its system prompt,
    // tool pins, model, and credential bindings) has nowhere hub-side to get
    // it. This column is that place: written in the same transaction as
    // `approvedWireHash`, so a projection is never present without the hash
    // that addresses it. Validated as `WorkflowProjectionDefinition` at read.
    // Null before approval is a legitimate state, matching the two columns
    // above.
    wireProjection: jsonb("wire_projection"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Unique per definition so rollback-by-version resolves to one row. The
    // mirror source `agent_version` omits this; the fresh table constrains it.
    unique("workflow_definition_version_definition_version").on(
      t.definitionId,
      t.version,
    ),
    index("workflow_definition_version_definition_idx").on(t.definitionId),
  ],
);
