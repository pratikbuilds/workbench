// Composition for `@corbits/skills`: the registry itself plus the two
// adapters that only this composition root can supply — "which agent
// definitions pin this skill" (read from `@corbits/agent-directory`'s
// own `definition_skills` table, keyed by each definition's asset id)
// and "what index does a definition's pinned names resolve to" (read
// from the registry, on behalf of the pushing principal).
import { and, eq } from "drizzle-orm";

import type { DB } from "@intx/db";
import { workflowDefinition } from "@intx/db/schema";
import { type AssetService, type RepoStore } from "@intx/hub-sessions";
import {
  createDrizzleDefinitionSkillsStore,
  type PinnedSkillIndexResolver,
} from "@corbits/agent-directory";
import {
  createDrizzleSkillAccessStore,
  createHubSkillAssetStore,
  createSkillRegistry,
  SkillRegistryError,
  type PinnedByResolver,
  type SkillRegistry,
} from "@corbits/skills";

export type SkillsMount = {
  registry: SkillRegistry;
  pinnedBy: PinnedByResolver;
  skillIndex: PinnedSkillIndexResolver;
};

export function mountSkills(deps: {
  db: DB["db"];
  assetService: AssetService;
  repoStore: RepoStore;
}): SkillsMount {
  const registry = createSkillRegistry({
    assets: createHubSkillAssetStore({
      db: deps.db,
      assetService: deps.assetService,
      repoStore: deps.repoStore,
    }),
    access: createDrizzleSkillAccessStore(deps.db),
  });

  const definitionSkills = createDrizzleDefinitionSkillsStore(deps.db);

  const pinnedBy: PinnedByResolver = {
    async resolve(tenantId, skillName) {
      const rows = await deps.db.query.workflowDefinition.findMany({
        where: and(eq(workflowDefinition.tenantId, tenantId)),
      });
      const pinning: { definitionId: string; name: string }[] = [];
      for (const row of rows) {
        if (row.assetId === null) continue;
        const skills = await definitionSkills.getSkills(row.assetId);
        if (skills.includes(skillName)) {
          pinning.push({ definitionId: row.id, name: row.name });
        }
      }
      return pinning;
    },
  };

  const skillIndex: PinnedSkillIndexResolver = {
    async resolve(tenantId, principalId, names) {
      const visible = await registry.list({ tenantId, principalId });
      const byName = new Map(visible.map((skill) => [skill.name, skill]));
      return names.map((name) => {
        const skill = byName.get(name);
        if (skill === undefined) {
          // Pinning a skill the pusher cannot see would advertise a
          // skill `skills_load` will refuse to fetch at run time. Reject
          // the push instead of shipping an index that lies.
          throw new SkillRegistryError(
            "not_found",
            `cannot pin skill "${name}": it is not in this workbench's registry, or not visible to you`,
          );
        }
        return { name: skill.name, description: skill.description };
      });
    },
  };

  return { registry, pinnedBy, skillIndex };
}
