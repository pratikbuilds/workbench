// Boots one real workbench stack (hub + sidecar + Postgres) for a
// longevity campaign: ~10 signed-up humans in one tenant, real
// Ollama-backed inference targets only (no Anthropic, no stub/noop
// model), one multi-participant workbench, real agent definitions
// invited into it, one skill, and interval routines bound to a
// deployed heartbeat definition pinned at a real target. Mirrors the
// proven e2e boots (`scripts/e2e/chat.test.ts` for tenancy/workbench
// mechanics, `scripts/e2e/workbench-digest.test.ts` for the catalog-seed
// + heartbeat-deploy shape) without reinventing any of it — only the
// inference source differs: every catalog provider here rides the
// `openai-compatible` adapter against an Ollama origin, matching how
// `packages/connections/src/credential-test.ts` documents Ollama's own
// `/v1` wire shape.

import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resetSchema, setupDatabase } from "../../../scripts/db-setup.ts";
import {
  api,
  connectE2eDb,
  expectStatus,
  freePort,
  provisionSidecar,
  pushWorkflowSource,
  runCleanups,
  startHub,
  startSidecar,
  workflowDeployBody,
  type ApiResult,
  type HubHandle,
  type SpawnedApp,
} from "../../../scripts/e2e/harness.ts";
import {
  buildHeartbeatWorkflow,
  serializeHeartbeatWorkflow,
} from "../../../workflows/heartbeat/src/index.ts";

import {
  buildCampaignAgentWorkflow,
  serializeCampaignAgentWorkflow,
} from "./agent-workflow";
import type { Persona } from "./personas";

export function stringField(
  data: unknown,
  field: string,
  what: string,
): string {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value !== "") return value;
  }
  throw new Error(
    `${what}: missing string field "${field}": ${JSON.stringify(data)}`,
  );
}

export function arrayField(
  data: unknown,
  field: string,
  what: string,
): unknown[] {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (Array.isArray(value)) return value;
  }
  throw new Error(
    `${what}: missing array field "${field}": ${JSON.stringify(data)}`,
  );
}

export interface SqlClient {
  unsafe(query: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  end(): Promise<void>;
}

export type InferenceTarget = {
  label: string;
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
};

/** One agent definition to seed. Every agent is real inference now —
 * `targetLabel` must name a `realTargets` entry, whose catalog model
 * the definition is pinned at. `real` stays on the type (and stays
 * `true` for every spec) only so `StackAgent`/`engine.ts` keep one
 * shared shape rather than growing a second, noop-only one. */
export interface AgentDefinitionSpec {
  key: string;
  handle: string;
  name: string;
  systemPrompt: string;
  real: true;
  targetLabel: string;
  /** Skill names (already registered via `skillSpecs`) this agent pins
   * at creation. */
  skills?: readonly string[];
}

/** What one agent deploy (or redeploy) is built from — the workflow
 * JSON pushed to the agent's asset is a pure function of this plus the
 * current bodies of its pinned skills. */
export interface AgentDeploySpec {
  key: string;
  handle: string;
  name: string;
  systemPrompt: string;
  targetLabel: string;
  skills?: readonly string[];
}

/** One skill to seed into the tenant's registry before agent
 * definitions are created, so a `skills` pin above can resolve it. */
export interface SkillSpec {
  name: string;
  description: string;
  body: string;
}

export interface RoutineSpec {
  key: string;
  name: string;
}

export interface StackOptions {
  databaseUrl: string;
  realTargets: readonly InferenceTarget[];
  skills?: readonly SkillSpec[];
}

export interface StackActor {
  key: string;
  cookies: string[];
}

export interface StackAgent {
  key: string;
  handle: string;
  definitionId: string;
  real: boolean;
}

export interface StackRoutine {
  key: string;
  id: string;
}

export interface LongevityStack {
  baseUrl: string;
  tenantId: string;
  workbenchId: string;
  actors: ReadonlyMap<string, StackActor>;
  agents: ReadonlyMap<string, StackAgent>;
  routines: ReadonlyMap<string, StackRoutine>;
  ownerCookies: string[];
  hubLogPath: string;
  restartHub(): Promise<void>;
  sql: SqlClient;
  hubPid(): number | undefined;
  sidecarPid(): number | undefined;
  close(): Promise<void>;
  /** Every real inference target this stack seeded into the catalog,
   * in the order given — `engine.ts`'s `providerSwitch` step cycles a
   * real agent's model through this list. Empty when the campaign ran
   * with no `realTargets`. */
  realTargets: readonly InferenceTarget[];
  /** `(skill name) -> (agent key)` for every seeded skill that was
   * attached to an agent at creation — `engine.ts`'s `skillEdit`/
   * `skillProbe` steps use this to find the skill and agent a marker
   * edit targets. */
  skillOwners: ReadonlyMap<string, string>;
  /** Deploys a fresh agent through the working freeze path (asset ->
   * source push -> deployment -> invite) — the only path whose
   * definitions are launchable (known blocker D1: bare
   * `POST /agent-definitions` rows carry no frozen projection). */
  deployAgent(spec: AgentDeploySpec): Promise<StackAgent>;
  /** Pushes a new commit to an existing agent's asset and redeploys it
   * — how a mid-campaign skill edit or provider switch actually
   * reaches later launches. */
  redeployAgent(
    agentKey: string,
    changes: {
      targetLabel?: string;
      skillBody?: { name: string; body: string };
    },
  ): Promise<StackAgent>;
}

async function signUp(
  baseUrl: string,
  name: string,
): Promise<{ userId: string; email: string; cookies: string[] }> {
  const email = `longevity-${crypto.randomUUID()}@example.invalid`;
  // better-auth rate-limits the sign-up route per IP; ten cast members
  // signing up back-to-back trips it, so 429s get a bounded backoff.
  const deadline = Date.now() + 180_000;
  let res = await api(baseUrl, "POST", "/api/auth/sign-up/email", {
    name,
    email,
    password: `pw-${crypto.randomUUID()}`,
  });
  while (res.status === 429 && Date.now() < deadline) {
    await Bun.sleep(15_000);
    res = await api(baseUrl, "POST", "/api/auth/sign-up/email", {
      name,
      email,
      password: `pw-${crypto.randomUUID()}`,
    });
  }
  expectStatus(`sign-up for ${name}`, res, 200);
  if (res.cookies.length === 0) {
    throw new Error(`sign-up for ${name} returned no session cookie`);
  }
  const userId = stringField(
    (res.data as { user: unknown }).user,
    "id",
    `sign-up user field for ${name}`,
  );
  return { userId, email, cookies: res.cookies };
}

/**
 * Resolves the OS pid of whichever local process holds a socket naming
 * `port` — the hub's own listening pid (`LISTEN`) and, once the
 * sidecar's WebSocket dial-in has completed, the sidecar's pid too
 * (`ESTABLISHED`, its remote port equal to the hub's). Both processes
 * are loopback-local, so `lsof -iTCP:<port>` sees both ends of the
 * connection without needing either process's own pid handed to us —
 * `startHub`/`startSidecar` (scripts/e2e/harness.ts) expose no pid of
 * their own, and this package must never fork that shared harness to
 * add one.
 */
async function resolvePortPids(
  port: number,
): Promise<{ hubPid: number | undefined; sidecarPid: number | undefined }> {
  const proc = Bun.spawn(["lsof", "-nP", `-iTCP:${port}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;

  let hubPid: number | undefined;
  let sidecarPid: number | undefined;
  for (const line of output.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const pidField = fields[1];
    const state = fields[fields.length - 1];
    if (pidField === undefined || state === undefined) continue;
    const pid = Number(pidField);
    if (!Number.isFinite(pid)) continue;
    if (state.includes("LISTEN")) hubPid = pid;
    else if (state.includes("ESTABLISHED") && pid !== hubPid) sidecarPid = pid;
  }
  return { hubPid, sidecarPid };
}

export async function bootLongevityStack(
  personas: readonly Persona[],
  agentSpecs: readonly AgentDefinitionSpec[],
  routineSpecs: readonly RoutineSpec[],
  options: StackOptions,
): Promise<LongevityStack> {
  const cleanups: (() => Promise<void> | void)[] = [];
  const close = () => runCleanups(cleanups);

  try {
    await resetSchema(options.databaseUrl);
    await setupDatabase(options.databaseUrl);

    const sidecarId = `longevity-${crypto.randomUUID().slice(0, 8)}`;
    const sidecarToken = crypto.randomUUID();
    process.stderr.write("boot: sidecar row\n");
    await provisionSidecar(options.databaseUrl, sidecarId, sidecarToken);
    process.stderr.write("boot: sidecar row done\n");

    const hubDataDir = await mkdtemp(
      path.join(tmpdir(), "longevity-hub-data-"),
    );
    cleanups.push(() => rm(hubDataDir, { recursive: true, force: true }));
    const sidecarDataDir = await mkdtemp(
      path.join(tmpdir(), "longevity-sidecar-data-"),
    );
    cleanups.push(() => rm(sidecarDataDir, { recursive: true, force: true }));

    const hubLogDir = await mkdtemp(path.join(tmpdir(), "longevity-hub-log-"));
    cleanups.push(() => rm(hubLogDir, { recursive: true, force: true }));
    const hubLogPath = path.join(hubLogDir, "hub.log");
    await Bun.write(hubLogPath, "");

    const port = freePort();
    const sessionSecret = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("hex");

    // No inference API key ever reaches either child process: `startHub`/
    // `startSidecar` (scripts/e2e/harness.ts) build each child's env from
    // an explicit whitelist (`osEnv()`: PATH/HOME/TMPDIR/USER) plus this
    // call's own `extraEnv`, never a spread of this process's full
    // `process.env` — so a shell-inherited ANTHROPIC_API_KEY/
    // OPENAI_API_KEY can never leak in, and this stack passes no
    // `extraEnv` of its own that could reintroduce one. Verified by
    // reading `spawnApp`/`startHub` directly rather than assumed.
    process.stderr.write("boot: starting hub\n");
    let hub: HubHandle = await startHub({
      databaseUrl: options.databaseUrl,
      port,
      sessionSecret,
      dataDir: hubDataDir,
    });
    cleanups.push(() => hub.stop());

    let flushedLength = 0;
    async function flushHubLog(): Promise<void> {
      const full = hub.output();
      if (full.length > flushedLength) {
        await appendFile(hubLogPath, full.slice(flushedLength));
        flushedLength = full.length;
      }
    }

    const flushTimer = setInterval(() => {
      void flushHubLog();
    }, 2000);
    cleanups.push(async () => {
      clearInterval(flushTimer);
      await flushHubLog();
    });

    process.stderr.write("boot: hub up, starting sidecar\n");
    const sidecar: SpawnedApp = startSidecar({
      hubPort: port,
      sidecarId,
      token: sidecarToken,
      dataDir: sidecarDataDir,
    });
    cleanups.push(() => sidecar.stop());

    let hubPid: number | undefined;
    let sidecarPid: number | undefined;
    const pidDeadline = Date.now() + 30_000;
    while (sidecarPid === undefined && Date.now() < pidDeadline) {
      const resolved = await resolvePortPids(port);
      hubPid = resolved.hubPid ?? hubPid;
      sidecarPid = resolved.sidecarPid ?? sidecarPid;
      if (sidecarPid === undefined) await Bun.sleep(500);
    }

    const humanEntries = personas;
    const first = humanEntries[0];
    if (first === undefined)
      throw new Error("bootLongevityStack: no personas given");

    process.stderr.write("boot: signup owner\n");
    const owner = await signUp(hub.baseUrl, first.name);
    const slug = `longevity${crypto.randomUUID().slice(0, 8)}`;
    const tenantRes = await api(
      hub.baseUrl,
      "POST",
      "/api/tenants",
      { name: `Longevity: ${first.name}'s team`, slug },
      owner.cookies,
    );
    expectStatus("create tenant", tenantRes, 201);
    const tenantId = stringField(tenantRes.data, "id", "create tenant");

    const actors = new Map<string, StackActor>();
    actors.set(first.key, { key: first.key, cookies: owner.cookies });

    async function plantGrant(
      principalId: string,
      resource: string,
      action: string,
    ): Promise<void> {
      const res = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/grants`,
        { principalId, resource, action, effect: "allow", origin: "creator" },
        owner.cookies,
      );
      expectStatus(`grant ${resource}/${action} to ${principalId}`, res, 201);
    }

    for (const persona of humanEntries.slice(1)) {
      const member = await signUp(hub.baseUrl, persona.name);
      const invited = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/members/invite`,
        { email: member.email },
        owner.cookies,
      );
      expectStatus(`invite ${persona.name}`, invited, 201);
      const principalId = stringField(
        invited.data,
        "id",
        `invite ${persona.name}`,
      );
      const activated = await api(
        hub.baseUrl,
        "PATCH",
        `/api/tenants/${tenantId}/principals/${principalId}`,
        { status: "active" },
        owner.cookies,
      );
      expectStatus(`activate ${persona.name}`, activated, 200);

      for (const [resource, action] of [
        ["workflow-run:*", "read"],
        ["workflow-run:*", "write"],
        ["workflow-run:*", "create"],
        ["room:*", "read"],
        ["room:*", "write"],
      ] as const) {
        await plantGrant(principalId, resource, action);
      }
      actors.set(persona.key, { key: persona.key, cookies: member.cookies });
    }

    if (options.realTargets.length === 0) {
      throw new Error(
        "bootLongevityStack: no realTargets given — this stack seeds no " +
          "Anthropic/noop fallback catalog chain, so at least one real " +
          "(Ollama, openai-compatible) target is required",
      );
    }

    // Every catalog provider rides the `openai-compatible` adapter
    // against an Ollama origin — never `anthropic`, never the hub's
    // noop-inference endpoint. Ollama needs no real secret
    // (`credential-test.ts`'s `OLLAMA_PLACEHOLDER_SECRET`), but the
    // credential row still requires some string, so each target's own
    // `apiKey` (expected to be the same placeholder) is threaded through
    // unchanged rather than this package inventing its own convention.
    async function seedCatalogChain(target: InferenceTarget): Promise<void> {
      const model = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/catalog/models`,
        { canonicalName: target.model },
        owner.cookies,
      );
      expectStatus(`create catalog model ${target.model}`, model, 201);
      const modelId = stringField(model.data, "id", "create catalog model");

      const providerName = `ollama-${target.label}`;
      const provider = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/providers`,
        { name: providerName, plugin: "openai-compatible" },
        owner.cookies,
      );
      expectStatus(`create provider ${providerName}`, provider, 201);
      const providerId = stringField(provider.data, "id", "create provider");

      const credential = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/credentials`,
        {
          providerId,
          name: `${providerName}-default`,
          type: "api_key",
          secret: target.apiKey,
        },
        owner.cookies,
      );
      expectStatus(`create credential ${providerName}`, credential, 201);
      const credentialId = stringField(
        credential.data,
        "id",
        "create credential",
      );

      const catalogProvider = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/catalog/providers`,
        {
          name: providerName,
          plugin: "openai-compatible",
          baseURL: target.baseURL,
          credentialId,
        },
        owner.cookies,
      );
      expectStatus(
        `create catalog provider ${providerName}`,
        catalogProvider,
        201,
      );
      const catalogProviderId = stringField(
        catalogProvider.data,
        "id",
        "create catalog provider",
      );

      const offering = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/catalog/offerings`,
        { modelId, providerId: catalogProviderId },
        owner.cookies,
      );
      expectStatus(`create catalog offering ${target.model}`, offering, 201);
    }

    for (const target of options.realTargets) {
      await seedCatalogChain(target);
    }

    for (const skill of options.skills ?? []) {
      const created = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/skills`,
        {
          name: skill.name,
          description: skill.description,
          body: skill.body,
          scope: "tenant",
        },
        owner.cookies,
      );
      expectStatus(`create skill ${skill.name}`, created, 201);
    }

    // The delivery/gathering room: one multi-participant workbench every
    // human and every agent below is invited into (`chat.test.ts`'s
    // "workbench" kind, not the 1:1 "chat" kind — this stack needs one
    // shared room, not a per-agent DM).
    let workbenchRes: ApiResult;
    const workbenchDeadline = Date.now() + 60_000;
    for (;;) {
      if (sidecar.exited()) {
        throw new Error(
          `sidecar exited before workbench creation; output:\n${sidecar.output()}`,
        );
      }
      workbenchRes = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/chat/workbenches`,
        { kind: "workbench", name: "Longevity campaign" },
        owner.cookies,
      );
      if (workbenchRes.status !== 500) break;
      if (Date.now() > workbenchDeadline) {
        throw new Error(
          `workbench never became launchable: ${JSON.stringify(workbenchRes.data)}\n` +
            `sidecar output:\n${sidecar.output()}`,
        );
      }
      await Bun.sleep(1000);
    }
    expectStatus("create workbench", workbenchRes, 201);
    const workbenchId = stringField(
      workbenchRes.data,
      "id",
      "create workbench",
    );

    const domain = stringField(tenantRes.data, "domain", "create tenant");
    const agents = new Map<string, StackAgent>();
    const skillOwners = new Map<string, string>();
    const skillBodies = new Map<string, string>();
    for (const skill of options.skills ?? []) {
      skillBodies.set(skill.name, skill.body);
    }
    // Per-agent deploy state `redeployAgent` rebuilds from: the base
    // prompt/target plus the asset the first deploy claimed, so a
    // redeploy pushes a new commit to the SAME asset and the launch
    // path's newest-projection resolution picks it up.
    const agentDeployState = new Map<
      string,
      {
        spec: AgentDeploySpec;
        assetId: string;
        skills: Map<string, string>;
      }
    >();

    function agentSystemPrompt(
      spec: AgentDeploySpec,
      skills: ReadonlyMap<string, string>,
    ): string {
      // D2/D3 (tools+history dropped on the openai-compatible path)
      // means skill delivery via tool/memory machinery never reaches
      // the model — inlining the pinned skill bodies into the system
      // prompt is the one channel a skill edit can honestly reach a
      // turn through, exercised end-to-end by redeploying the asset.
      let prompt = spec.systemPrompt;
      for (const [name, body] of skills) {
        prompt += `\n\nSkill "${name}": ${body}`;
      }
      return prompt;
    }

    async function deployAgentAsset(input: {
      spec: AgentDeploySpec;
      assetId: string | undefined;
      skills: ReadonlyMap<string, string>;
    }): Promise<{ assetId: string; definitionId: string }> {
      const { spec } = input;
      const target = options.realTargets.find(
        (t) => t.label === spec.targetLabel,
      );
      if (target === undefined) {
        throw new Error(
          `agent ${spec.key}: no realTarget labeled "${spec.targetLabel}"`,
        );
      }
      let assetId = input.assetId;
      if (assetId === undefined) {
        const assetCreated = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/assets`,
          { kind: "workflow", name: spec.handle },
          owner.cookies,
        );
        expectStatus(`create agent asset ${spec.handle}`, assetCreated, 201);
        assetId = stringField(
          assetCreated.data,
          "id",
          `create agent asset ${spec.handle}`,
        );
      }

      const minted = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/git-tokens`,
        {
          name: `longevity-agent-push-${spec.handle}-${crypto.randomUUID().slice(0, 8)}`,
          resource: "asset:*",
          refPattern: "**",
          actions: ["can_read", "can_push"],
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
        owner.cookies,
      );
      expectStatus(`mint git token for agent ${spec.handle}`, minted, 201);

      const workflowJson = serializeCampaignAgentWorkflow(
        buildCampaignAgentWorkflow({
          handle: spec.handle,
          tenantDomain: domain,
          description: spec.name,
          systemPrompt: agentSystemPrompt(spec, input.skills),
          inferencePreferences: [
            { provider: target.provider, model: target.model },
          ],
          turnTimeoutMs: 240_000,
        }),
      );
      const pushed = await pushWorkflowSource({
        baseUrl: hub.baseUrl,
        tenantId,
        assetName: spec.handle,
        tokenSecret: stringField(minted.data, "secret", "mint git token"),
        workflowJson,
      });

      const deployDeadline = Date.now() + 90_000;
      for (;;) {
        if (sidecar.exited()) {
          throw new Error(
            `sidecar exited before agent ${spec.handle} deploy; output:\n${sidecar.output()}`,
          );
        }
        const deployed = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${tenantId}/workflows/deployments`,
          workflowDeployBody({
            assetId,
            commitSha: pushed.commitSha,
            sourceId: `src-agent-${spec.handle}`,
            provider: target.provider,
            baseURL: target.baseURL,
            apiKey: target.apiKey,
            model: target.model,
          }),
          owner.cookies,
        );
        if (deployed.status !== 502) {
          expectStatus(`deploy agent ${spec.handle}`, deployed, 201);
          break;
        }
        if (Date.now() > deployDeadline) {
          throw new Error(
            `agent ${spec.handle} never became deployable (502): ` +
              `last body: ${JSON.stringify(deployed.data)}\n` +
              `sidecar output:\n${sidecar.output()}`,
          );
        }
        await Bun.sleep(1000);
      }

      const listed = await api(
        hub.baseUrl,
        "GET",
        `/api/tenants/${tenantId}/workflows/definitions`,
        undefined,
        owner.cookies,
      );
      expectStatus(`list definitions for agent ${spec.handle}`, listed, 200);
      const rows =
        typeof listed.data === "object" &&
        listed.data !== null &&
        "data" in listed.data
          ? ((listed.data as { data: unknown[] }).data as {
              id: string;
              name?: string;
            }[])
          : (listed.data as { id: string; name?: string }[]);
      const found = rows.find((row) => row.name === spec.handle);
      if (found === undefined) {
        throw new Error(
          `no workflow definition named "${spec.handle}" after deploy`,
        );
      }
      return { assetId, definitionId: found.id };
    }

    async function deployAgent(spec: AgentDeploySpec): Promise<StackAgent> {
      const pinned = new Map<string, string>();
      for (const skillName of spec.skills ?? []) {
        const body = skillBodies.get(skillName);
        if (body === undefined) {
          throw new Error(
            `agent ${spec.key} pins unknown skill "${skillName}"`,
          );
        }
        pinned.set(skillName, body);
        skillOwners.set(skillName, spec.key);
      }
      const { assetId, definitionId } = await deployAgentAsset({
        spec,
        assetId: undefined,
        skills: pinned,
      });
      agentDeployState.set(spec.key, { spec, assetId, skills: pinned });

      const invited = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/invite`,
        { definitionId },
        owner.cookies,
      );
      expectStatus(`invite agent ${spec.key}`, invited, 201);
      const address = stringField(
        invited.data,
        "address",
        `invite agent ${spec.key}`,
      );

      const settings = await api(
        hub.baseUrl,
        "GET",
        `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/settings`,
        undefined,
        owner.cookies,
      );
      expectStatus(`read settings after inviting ${spec.key}`, settings, 200);
      const participants = arrayField(
        settings.data,
        "participants",
        `settings after inviting ${spec.key}`,
      ) as { address: string; handle: string }[];
      const participant = participants.find((p) => p.address === address);
      if (participant === undefined) {
        throw new Error(
          `agent ${spec.key} invited but missing from participants: ` +
            JSON.stringify(participants),
        );
      }

      const agent: StackAgent = {
        key: spec.key,
        handle: participant.handle,
        definitionId,
        real: true,
      };
      agents.set(spec.key, agent);
      return agent;
    }

    async function redeployAgent(
      agentKey: string,
      changes: {
        targetLabel?: string;
        skillBody?: { name: string; body: string };
      },
    ): Promise<StackAgent> {
      const state = agentDeployState.get(agentKey);
      const existing = agents.get(agentKey);
      if (state === undefined || existing === undefined) {
        throw new Error(`redeployAgent: no deployed agent "${agentKey}"`);
      }
      if (changes.targetLabel !== undefined) {
        state.spec.targetLabel = changes.targetLabel;
      }
      if (changes.skillBody !== undefined) {
        state.skills.set(changes.skillBody.name, changes.skillBody.body);
        skillBodies.set(changes.skillBody.name, changes.skillBody.body);
      }
      const { definitionId } = await deployAgentAsset({
        spec: state.spec,
        assetId: state.assetId,
        skills: state.skills,
      });
      const updated: StackAgent = {
        key: existing.key,
        handle: existing.handle,
        definitionId,
        real: true,
      };
      agents.set(agentKey, updated);
      return updated;
    }

    for (const spec of agentSpecs) {
      await deployAgent({
        key: spec.key,
        handle: spec.handle,
        name: spec.name,
        systemPrompt: spec.systemPrompt,
        targetLabel: spec.targetLabel,
        skills: spec.skills ?? [],
      });
    }

    // Routines: one heartbeat-workflow deployment per campaign, pinned at
    // the first real target (never noop/anthropic), reused by every
    // routine spec — each routine is its own row, but they all fire the
    // same deployed definition.
    const routineTarget = options.realTargets[0];
    if (routineTarget === undefined) {
      throw new Error("unreachable: realTargets checked non-empty above");
    }
    const assetName = "longevity-heartbeat";
    const heartbeatAssetCreated = await api(
      hub.baseUrl,
      "POST",
      `/api/tenants/${tenantId}/assets`,
      { kind: "workflow", name: assetName },
      owner.cookies,
    );
    expectStatus("create heartbeat asset", heartbeatAssetCreated, 201);
    const heartbeatAssetId = stringField(
      heartbeatAssetCreated.data,
      "id",
      "create heartbeat asset",
    );

    const heartbeatGitToken = await api(
      hub.baseUrl,
      "POST",
      `/api/tenants/${tenantId}/git-tokens`,
      {
        name: "longevity-heartbeat-push",
        resource: "asset:*",
        refPattern: "**",
        actions: ["can_read", "can_push"],
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
      owner.cookies,
    );
    expectStatus("mint heartbeat git token", heartbeatGitToken, 201);

    const heartbeatPushed = await pushWorkflowSource({
      baseUrl: hub.baseUrl,
      tenantId,
      assetName,
      tokenSecret: stringField(
        heartbeatGitToken.data,
        "secret",
        "mint git token",
      ),
      workflowJson: serializeHeartbeatWorkflow(
        buildHeartbeatWorkflow({
          triggerAddress: `${assetName}@${domain}`,
          inferencePreferences: [
            { provider: "openai-compatible", model: routineTarget.model },
          ],
          turnTimeoutMs: 240_000,
        }),
      ),
    });

    const heartbeatDeployDeadline = Date.now() + 60_000;
    let heartbeatDeployed: ApiResult;
    for (;;) {
      if (sidecar.exited()) {
        throw new Error(
          `sidecar exited before heartbeat deploy; output:\n${sidecar.output()}`,
        );
      }
      heartbeatDeployed = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/workflows/deployments`,
        workflowDeployBody({
          assetId: heartbeatAssetId,
          commitSha: heartbeatPushed.commitSha,
          sourceId: "src-longevity-heartbeat",
          provider: "openai-compatible",
          baseURL: routineTarget.baseURL,
          apiKey: routineTarget.apiKey,
          model: routineTarget.model,
        }),
        owner.cookies,
      );
      if (heartbeatDeployed.status !== 502) break;
      if (Date.now() > heartbeatDeployDeadline) {
        throw new Error(
          `heartbeat never became deployable (502): ` +
            `${JSON.stringify(heartbeatDeployed.data)}\nsidecar output:\n${sidecar.output()}`,
        );
      }
      await Bun.sleep(1000);
    }
    expectStatus("deploy heartbeat workflow", heartbeatDeployed, 201);

    const listedDefinitions = await api(
      hub.baseUrl,
      "GET",
      `/api/tenants/${tenantId}/workflows/definitions`,
      undefined,
      owner.cookies,
    );
    expectStatus("list workflow definitions", listedDefinitions, 200);
    const definitionRows =
      typeof listedDefinitions.data === "object" &&
      listedDefinitions.data !== null &&
      "data" in listedDefinitions.data
        ? (listedDefinitions.data as { data: unknown[] }).data
        : (listedDefinitions.data as unknown[]);
    const heartbeatDefinition = (
      definitionRows as { id: string; name?: string }[]
    ).find((row) => row.name === assetName);
    if (heartbeatDefinition === undefined) {
      throw new Error(
        `no workflow definition named "${assetName}": ${JSON.stringify(listedDefinitions.data)}`,
      );
    }
    const heartbeatDefinitionId = heartbeatDefinition.id;

    const routines = new Map<string, StackRoutine>();
    for (const spec of routineSpecs) {
      const created = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${tenantId}/routines`,
        {
          name: spec.name,
          definitionId: heartbeatDefinitionId,
          trigger: { kind: "interval", unit: "hours", every: 1 },
          scope: "bench",
          deliveryWorkbenchId: workbenchId,
        },
        owner.cookies,
      );
      expectStatus(`create routine ${spec.key}`, created, 201);
      routines.set(spec.key, {
        key: spec.key,
        id: stringField(created.data, "id", `create routine ${spec.key}`),
      });
    }

    const sql = await connectE2eDb(options.databaseUrl);
    cleanups.push(() => sql.end());

    async function restartHub(): Promise<void> {
      await flushHubLog();
      await hub.stop();
      flushedLength = 0;
      hub = await startHub({
        databaseUrl: options.databaseUrl,
        port,
        sessionSecret,
        dataDir: hubDataDir,
      });
      const resolved = await resolvePortPids(port);
      hubPid = resolved.hubPid ?? hubPid;
    }

    return {
      baseUrl: hub.baseUrl,
      tenantId,
      workbenchId,
      actors,
      agents,
      routines,
      ownerCookies: owner.cookies,
      hubLogPath,
      restartHub,
      sql,
      hubPid: () => hubPid,
      sidecarPid: () => sidecarPid,
      close,
      realTargets: options.realTargets,
      skillOwners,
      deployAgent,
      redeployAgent,
    };
  } catch (cause) {
    await close();
    throw cause;
  }
}
