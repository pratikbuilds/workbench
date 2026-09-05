// The live Myra `Target` (CL-6143): boots a real hub + sidecar against
// a real Postgres, signs up a throwaway user, connects an inference
// credential, deploys the "assistant" workflow, mints a chat with it,
// and plays scripted human turns through the real HTTP API — the same
// boot sequence `scripts/e2e/greeting-delivery.test.ts` proves end to
// end, generalized here into something `runEval`/`runMatrix` can drive
// once per matrix config instead of once per test file.
//
// Two modes, chosen by whether `EVAL_PROVIDER_API_KEY` is set:
//   - live:     a real Anthropic key, so replies are genuine model
//               output and tool calls are genuine tool calls.
//   - plumbing: a stub key (never sent anywhere real — the platform's
//               own inference director folds the provider's 401 into a
//               completed turn carrying a credential-error report, the
//               same fixture `greeting-delivery.test.ts` and
//               `local-rip.test.ts` already rely on), so every turn
//               still gets delivered and recorded with zero real
//               inference spend. `bun run eval` uses this mode to keep
//               CI green with no key configured.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { OLLAMA_PLACEHOLDER_SECRET } from "@corbits/connections/credential-test";
import { createGitWorkflowPusher } from "@corbits/seeding";
import { createHubAPI, type ApiCall } from "@corbits/hub-api-client";
import { getLogger } from "@intx/log";
import { completeCredentialSetup } from "@workbench/onboarding";
import {
  instantiateWorkbenchTemplate,
  parseWorkbenchDefinition,
  templateSettingsPatch,
} from "@workbench/templates";
import {
  signPayload,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "@corbits/webhook-triggers";

import type {
  FakeReceipt,
  RunConfig,
  Target,
  Turn,
  WorldSnapshot,
} from "../types.ts";
import type { McpFakeRecording } from "../fakes/recording.ts";
import { startMcpFake } from "../fakes/mcp-fake-server.ts";
import { startGithubRestFake } from "../fakes/github-rest-fake.ts";
import { arrayField, stringField } from "./json-fields.ts";
import {
  newToolCallsSince,
  readAllToolCalls,
  type SqlClientLike,
} from "./trace.ts";

/** One recorded MCP fake (packages/evals/src/fakes) to stand up and
 * connect into the tenant before the target is handed back — connected
 * through the exact same `POST /mcp-servers` route real users use
 * (see mcp-fake-server.ts's module comment), never a second connect
 * mechanism. */
export interface MyraTargetMcpFake {
  readonly server: string;
  readonly recording: McpFakeRecording;
}

export interface EvalSpawnedApp {
  output(): string;
  exited(): boolean;
  stop(): Promise<void>;
}

export interface EvalHubHandle extends EvalSpawnedApp {
  readonly baseUrl: string;
}

export interface EvalApiResult {
  status: number;
  data: unknown;
  cookies: string[];
}

/**
 * The deployment plumbing `bootMyraTarget` runs on, injected by the
 * caller (the repo's own e2e harness in `scripts/e2e/harness.ts` and
 * `scripts/db-setup.ts`) so this package never reaches outside its own
 * pack for repo-level scripts.
 */
export interface MyraTargetInfra {
  e2eDatabaseUrl(): string | undefined;
  resetSchema(databaseUrl: string): Promise<void>;
  setupDatabase(databaseUrl: string): Promise<{ action: string }>;
  provisionSidecar(
    databaseUrl: string,
    sidecarId: string,
    token: string,
  ): Promise<void>;
  startHub(options: {
    databaseUrl: string;
    port: number;
    sessionSecret: string;
    dataDir: string;
    /** Extra hub config env vars — how the boot points the hub's
     * `GITHUB_API_BASE_URL` (CL-6403's seam) at the scratch GitHub REST
     * fake this target starts. */
    extraEnv?: Record<string, string>;
  }): Promise<EvalHubHandle>;
  startSidecar(options: {
    hubPort: number;
    sidecarId: string;
    token: string;
    dataDir: string;
  }): EvalSpawnedApp;
  api(
    base: string,
    method: string,
    route: string,
    body?: unknown,
    cookies?: string[],
  ): Promise<EvalApiResult>;
  expectStatus(what: string, result: EvalApiResult, expected: number): void;
  connectE2eDb(
    databaseUrl: string,
  ): Promise<SqlClientLike & { end(): Promise<void> }>;
  freePort(): number;
  /** Optional world-snapshot capability (targets/world-snapshot.ts):
   * when the caller supplies this, the returned `Target` gains
   * `snapshotWorld`. `hubDataDir` is the booted hub's own data dir, so
   * the caller can stand up a read-equivalent `AssetService` over the
   * same on-disk agent repos (see `apps/hub`'s
   * `createBootAssetWiring`); `fakeReceipts` hands back every call the
   * target's connected MCP fakes received, so the snapshot's
   * `fakeReceipts` come from the fakes this target actually started. */
  captureWorldSnapshot?: (args: {
    tenantId: string;
    hubDataDir: string;
    fakeReceipts: () => readonly FakeReceipt[];
  }) => Promise<WorldSnapshot>;
}

/** Never sent anywhere for real in plumbing mode — see the module
 * comment. Only used when `EVAL_PROVIDER_API_KEY` is unset. */
const log = getLogger(["evals", "real-target"]);

const STUB_API_KEY = "corbits-evals-stub-key-not-real";

// The scratch GitHub REST fixture (CL-6405): what the fake origin
// answers for the connector PAT probe, the connect card's
// authenticated login, and its repo listing. The repo matches the
// factory case's `TARGET_REPO`, so start-reviewing's per-repo mint has
// exactly the repo the case's fired webhook names.
const GITHUB_REST_FAKE_PAT = "evals-fake-github-pat-not-real";
const GITHUB_REST_FAKE_FIXTURE = {
  login: "abklabs",
  repos: [{ id: 101, full_name: "abklabs/workbench" }],
} as const;

interface ChatMessage {
  readonly id: string;
  readonly sender: { readonly address: string };
  readonly parts: readonly { readonly kind: string; readonly text?: string }[];
}

/** Pure: the first message in `items` that (a) wasn't already in
 * `seenIds`, (b) is authored by `agentAddress`, and (c) carries text —
 * the "did Myra reply yet" check, factored out so it's unit-testable
 * without booting anything. */
export function findNewAgentReply(
  items: readonly ChatMessage[],
  agentAddress: string,
  seenIds: ReadonlySet<string>,
): ChatMessage | undefined {
  return items.find(
    (item) =>
      !seenIds.has(item.id) &&
      item.sender.address === agentAddress &&
      item.parts.some(
        (part) => part.kind === "text" && (part.text ?? "") !== "",
      ),
  );
}

function replyTextOf(message: ChatMessage): string {
  return message.parts
    .filter((part) => part.kind === "text")
    .map((part) => part.text ?? "")
    .join("");
}

async function pollUntil<T>(
  what: string,
  deadlineMs: number,
  attempt: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await attempt();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      throw new Error(`${what}: timed out after ${String(deadlineMs)}ms`);
    }
    await Bun.sleep(1000);
  }
}

/**
 * Boots one real Myra deployment and returns a `Target` that plays
 * turns against it over the real HTTP API. The caller owns calling
 * `close()` exactly once — every process, port, and DB connection this
 * opens is released there, in reverse order, even if a later step in
 * this function throws partway through boot.
 */
export async function bootMyraTarget(
  config: RunConfig,
  infra: MyraTargetInfra,
  mcpFakes: readonly MyraTargetMcpFake[] = [],
): Promise<Target> {
  const {
    api,
    connectE2eDb,
    e2eDatabaseUrl,
    expectStatus,
    freePort,
    provisionSidecar,
    resetSchema,
    setupDatabase,
    startHub,
    startSidecar,
  } = infra;
  if (
    config.systemPromptOverride !== undefined ||
    config.toolPins !== undefined
  ) {
    // [Gap worth flagging: the live target has no wiring today to push a
    // matrix entry's systemPromptOverride/toolPins into the deployed
    // "assistant" workflow before minting a chat — `ensureSeeded`
    // deploys the tenant's one stored copy of each default workflow, not
    // a per-run variant. Failing loudly here beats silently ignoring the
    // matrix entry's request.]
    throw new Error(
      `bootMyraTarget("${config.name}"): systemPromptOverride/toolPins are not ` +
        "wired to the live target yet — see the comment above this throw",
    );
  }

  const databaseUrl = e2eDatabaseUrl();
  if (databaseUrl === undefined) {
    throw new Error(
      "bootMyraTarget: DATABASE_URL is not set; the live Myra target needs a " +
        "reachable Postgres (see .env.example)",
    );
  }

  const cleanups: (() => Promise<void>)[] = [];
  async function closeAll(): Promise<void> {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  }

  try {
    await resetSchema(databaseUrl);
    const report = await setupDatabase(databaseUrl);
    if (report.action !== "migrated") {
      throw new Error(`db setup: expected "migrated", got "${report.action}"`);
    }

    const runToken = crypto.randomUUID().slice(0, 8);
    const sidecarId = `evals-${config.name}-${runToken}`;
    const sidecarToken = crypto.randomUUID();
    await provisionSidecar(databaseUrl, sidecarId, sidecarToken);

    // The fake GitHub REST origin starts before the hub so its URL can
    // ride into the hub's own `GITHUB_API_BASE_URL` config (CL-6403):
    // the `github` connector PAT probe, the connect card's repo
    // listing, and the stored provider origin all resolve here instead
    // of `https://api.github.com`.
    const githubRest = startGithubRestFake(freePort(), {
      login: GITHUB_REST_FAKE_FIXTURE.login,
      repos: GITHUB_REST_FAKE_FIXTURE.repos,
    });
    cleanups.push(() => {
      githubRest.stop();
      return Promise.resolve();
    });

    const hubDataDir = await mkdtemp(path.join(tmpdir(), "evals-hub-data-"));
    const hub: EvalHubHandle = await startHub({
      databaseUrl,
      port: freePort(),
      sessionSecret: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("hex"),
      dataDir: hubDataDir,
      extraEnv: { GITHUB_API_BASE_URL: githubRest.url },
    });
    cleanups.push(() => hub.stop());
    cleanups.push(() => rm(hubDataDir, { recursive: true, force: true }));

    const sidecarDataDir = await mkdtemp(
      path.join(tmpdir(), "evals-sidecar-data-"),
    );
    const sidecar: EvalSpawnedApp = startSidecar({
      hubPort: Number(new URL(hub.baseUrl).port || "80"),
      sidecarId,
      token: sidecarToken,
      dataDir: sidecarDataDir,
    });
    cleanups.push(() => sidecar.stop());
    cleanups.push(() => rm(sidecarDataDir, { recursive: true, force: true }));

    const hubApi: ApiCall = createHubAPI(hub.baseUrl);
    const pushWorkflow = createGitWorkflowPusher();

    const email = `evals-${config.name}-${crypto.randomUUID()}@example.invalid`;
    const password = `pw-${crypto.randomUUID()}`;
    const signUpRes = await api(
      hub.baseUrl,
      "POST",
      "/api/auth/sign-up/email",
      {
        name: `Evals ${config.name}`,
        email,
        password,
      },
    );
    expectStatus(`sign-up for ${config.name}`, signUpRes, 200);
    if (signUpRes.cookies.length === 0) {
      throw new Error(`sign-up for ${config.name} returned no session cookie`);
    }
    const userId = stringField(
      (signUpRes.data as { user: unknown }).user,
      "id",
      `sign-up user field for ${config.name}`,
    );
    const cookies = signUpRes.cookies;

    const provisionRes = await api(
      hub.baseUrl,
      "POST",
      "/api/onboarding/provision",
      { name: `Evals ${config.name}'s Bench` },
      cookies,
    );
    expectStatus(
      `provision personal bench for ${config.name}`,
      provisionRes,
      200,
    );

    const startedFakes = mcpFakes.map(({ recording }) =>
      startMcpFake(recording, freePort()),
    );
    for (const fake of startedFakes) {
      cleanups.push(() => {
        fake.stop();
        return Promise.resolve();
      });
    }

    // EVAL_PROVIDER=ollama + OLLAMA_BASE_URL runs against a local Ollama
    // (no key: the fixed placeholder secret); otherwise an Anthropic key.
    const ollamaBaseUrl = process.env["OLLAMA_BASE_URL"];
    const useOllama =
      process.env["EVAL_PROVIDER"] === "ollama" && ollamaBaseUrl !== undefined;
    const provider = useOllama ? ("ollama" as const) : ("anthropic" as const);
    const apiKey = useOllama
      ? OLLAMA_PLACEHOLDER_SECRET
      : (process.env["EVAL_PROVIDER_API_KEY"] ?? STUB_API_KEY);

    const seeded = await pollUntil(
      "connecting the inference credential and deploying default workflows",
      60_000,
      async () => {
        try {
          const outcome = await completeCredentialSetup({
            api: hubApi,
            cookies,
            hubUrl: hub.baseUrl,
            userId,
            userEmail: email,
            provider,
            apiKey,
            pushWorkflow,
            log: () => undefined,
            ...(useOllama && ollamaBaseUrl !== undefined
              ? { baseURLOverride: ollamaBaseUrl }
              : {}),
          });
          if (outcome.kind !== "seeded") {
            throw new Error(
              `expected "seeded", got: ${JSON.stringify(outcome)}`,
            );
          }
          return outcome;
        } catch (cause) {
          if (sidecar.exited()) {
            throw new Error(
              `sidecar exited while seeding; output:\n${sidecar.output()}`,
              { cause },
            );
          }
          if (process.env["EVALS_DEBUG"] === "1") {
            log.error`seeding attempt failed, retrying: ${cause instanceof Error ? cause.message : String(cause)}`;
          }
          return undefined;
        }
      },
    );

    // Connect every started fake through the exact same route Plugins
    // uses for a real MCP server — no eval-only connect mechanism.
    for (const [index, fake] of startedFakes.entries()) {
      const connectRes = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${seeded.tenantId}/mcp-servers`,
        { name: mcpFakes[index]?.server, url: fake.url },
        cookies,
      );
      expectStatus(
        `connect MCP fake "${mcpFakes[index]?.server ?? "?"}"`,
        connectRes,
        200,
      );
    }

    // The Plugins-PAT half of a GitHub connect (CL-6403's seam, closed
    // here for the scratch stack): the same `POST .../connections/github/complete`
    // route Settings > Connections drives, whose probe now lands on the
    // REST fake the hub's `GITHUB_API_BASE_URL` names. This is what
    // makes `githubConnectedViaConnectionsLayer`'s connector-credential
    // half real, and what start-reviewing's repo listing resolves.
    const completeRes = await api(
      hub.baseUrl,
      "POST",
      `/api/tenants/${seeded.tenantId}/connections/github/complete`,
      { apiKey: GITHUB_REST_FAKE_PAT },
      cookies,
    );
    expectStatus(
      "connect the GitHub PAT against the REST fake",
      completeRes,
      200,
    );

    const assistantDefinitionId = await pollUntil(
      '"assistant" becoming invitable',
      60_000,
      async () => {
        const res = await api(
          hub.baseUrl,
          "GET",
          `/api/tenants/${seeded.tenantId}/chat/invitable-definitions`,
          undefined,
          cookies,
        );
        if (res.status !== 200) return undefined;
        const items = arrayField(
          res.data,
          "items",
          "list invitable definitions",
        ) as {
          id: string;
          name: string;
        }[];
        return items.find((item) => item.name === "assistant")?.id;
      },
    );

    const { chatId, agentAddress } = await pollUntil(
      "POST /workbenches kind=chat definitionId=assistant",
      60_000,
      async () => {
        if (sidecar.exited()) {
          throw new Error(
            `sidecar exited before chat creation; output:\n${sidecar.output()}`,
          );
        }
        const res: EvalApiResult = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${seeded.tenantId}/chat/workbenches`,
          { kind: "chat", definitionId: assistantDefinitionId },
          cookies,
        );
        if (res.status === 500) return undefined;
        expectStatus("create chat", res, 201);
        const id = stringField(res.data, "id", "create chat");
        const participants = arrayField(
          res.data,
          "participants",
          "create chat",
        ) as {
          address: string;
          handle: string;
        }[];
        const agent = participants.find(
          (participant) => participant.handle === "myra",
        );
        if (agent === undefined) {
          throw new Error(
            `chat has no "myra" agent participant: ${JSON.stringify(participants)}`,
          );
        }
        return { chatId: id, agentAddress: agent.address };
      },
    );

    const sql = await connectE2eDb(databaseUrl);
    cleanups.push(() => sql.end());
    const sqlClient: SqlClientLike = sql;

    const seenMessageIds = new Set<string>();
    let toolCallsConsumed = 0;

    function bootFailureOutput(): string {
      return (
        `hub output (tail):\n${hub.output().slice(-60_000)}\n` +
        `sidecar output (tail):\n${sidecar.output().slice(-6_000)}`
      );
    }

    // `POST /workbenches` fires `postCannedGreeting` fire-and-forget
    // (see `packages/chat/src/routes.ts`) right after the chat mints —
    // the unprompted canned greeting `greeting-delivery.test.ts` proves
    // lands with zero user messages sent. That test waits for the
    // greeting's own agent-authored message to land *before* sending
    // its first human turn; this target must do the same, or the first
    // scripted turn's human message and mail fan-out race the still
    // in-flight greeting post's own record-mail to the channel host,
    // which is what the "run 'run_<channelId>' is terminal" rejection
    // traces back to. The greeting's message id (and its tool calls) are
    // folded in as already-seen so `sendTurn`'s own reply/tool-call
    // bookkeeping for turn 1 starts clean.
    const greeting = await pollUntil(
      "Myra's unprompted greeting landing with zero user messages sent",
      300_000,
      async () => {
        if (sidecar.exited()) {
          throw new Error(
            `sidecar exited waiting for the greeting; ${bootFailureOutput()}`,
          );
        }
        const res = await api(
          hub.baseUrl,
          "GET",
          `/api/tenants/${seeded.tenantId}/chat/workbenches/${chatId}/messages`,
          undefined,
          cookies,
        );
        expectStatus("list messages while waiting for the greeting", res, 200);
        const items = arrayField(
          res.data,
          "items",
          "list messages while waiting for the greeting",
        ) as ChatMessage[];
        return findNewAgentReply(items, agentAddress, seenMessageIds);
      },
    ).catch((cause) => {
      throw new Error(
        `no unprompted greeting within 300s; ${bootFailureOutput()}`,
        { cause },
      );
    });
    seenMessageIds.add(greeting.id);
    // See the settle-window comment in `sendTurn` below — the greeting's
    // own record-mail into the channel host needs the same room to land
    // before the first scripted turn posts.
    await Bun.sleep(3_000);
    const greetingToolCalls = await readAllToolCalls(
      sqlClient,
      seeded.tenantId,
      chatId,
    );
    toolCallsConsumed = newToolCallsSince(
      greetingToolCalls,
      toolCallsConsumed,
    ).consumed;

    async function sendTurn(human: string): Promise<Turn> {
      const postRes = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${seeded.tenantId}/chat/workbenches/${chatId}/messages`,
        { parts: [{ kind: "text", text: human }] },
        cookies,
      );
      expectStatus(`post message "${human}"`, postRes, 201);

      const beforeRes = await api(
        hub.baseUrl,
        "GET",
        `/api/tenants/${seeded.tenantId}/chat/workbenches/${chatId}/messages`,
        undefined,
        cookies,
      );
      expectStatus("list messages before reply", beforeRes, 200);
      for (const item of arrayField(
        beforeRes.data,
        "items",
        "list messages before reply",
      ) as ChatMessage[]) {
        seenMessageIds.add(item.id);
      }

      // A 27B local Ollama model, with tools, can take well over two
      // minutes for one turn — 300s gives it room without masking a
      // genuine hang (the sidecar-exited check above still fails fast
      // on that).
      let lastItems: ChatMessage[] = [];
      const reply = await pollUntil(
        `Myra's reply to "${human}"`,
        300_000,
        async () => {
          if (sidecar.exited()) {
            throw new Error(
              `sidecar exited waiting for a reply; ${bootFailureOutput()}`,
            );
          }
          const res = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${seeded.tenantId}/chat/workbenches/${chatId}/messages`,
            undefined,
            cookies,
          );
          expectStatus("list messages", res, 200);
          const items = arrayField(
            res.data,
            "items",
            "list messages",
          ) as ChatMessage[];
          lastItems = items;
          return findNewAgentReply(items, agentAddress, seenMessageIds);
        },
      ).catch((cause) => {
        throw new Error(
          `no reply within 300s; last-seen messages: ${JSON.stringify(lastItems)}\n` +
            bootFailureOutput(),
          { cause },
        );
      });
      seenMessageIds.add(reply.id);

      // A landed reply still has its own record-mail settling into the
      // channel host's shared timeline (`sendChannelMessage`'s "for the
      // record" delivery) — posting the next turn's human message before
      // that settles races the host's write with this turn's, which is
      // what a `path_violation` pack rejection and a subsequent
      // "workflow run ... is terminal" (see the module comment) traces
      // back to. A short settle window here is the same fix
      // `greeting-delivery.test.ts` reaches for via `E2E_TURN2_DELAY_MS`.
      await Bun.sleep(3_000);

      const allToolCalls = await readAllToolCalls(
        sqlClient,
        seeded.tenantId,
        chatId,
      );
      const { newCalls, consumed } = newToolCallsSince(
        allToolCalls,
        toolCallsConsumed,
      );
      toolCallsConsumed = consumed;

      return { human, replyText: replyTextOf(reply), toolCalls: newCalls };
    }

    function fakeReceipts(): readonly FakeReceipt[] {
      return [
        ...startedFakes.flatMap((fake) => fake.receipts()),
        ...githubRest.receipts(),
      ];
    }

    // The REAL install path (#140): the exact surfaces
    // `apps/web/src/instant-agent-create.ts`'s
    // `createWorkbenchFromTemplate` drives — seeded-library definition
    // read, workbench mint, `instantiateWorkbenchTemplate` over
    // HTTP-bound ports — never an eval-only instantiation mechanism.
    // The library read is also what seeds this scratch tenant's shelf
    // (CL-6458), so a passing install proves convergence on first read.
    async function installTemplate(templateId: string): Promise<Turn> {
      const entryRes = await api(
        hub.baseUrl,
        "GET",
        `/api/tenants/${seeded.tenantId}/library/templates/${templateId}`,
        undefined,
        cookies,
      );
      expectStatus(`fetch seeded template "${templateId}"`, entryRes, 200);
      const definition = parseWorkbenchDefinition(
        stringField(entryRes.data, "content", `template "${templateId}"`),
      );

      // Hostless, exactly as the web create flow mints it: a template
      // room has no `definitionId` and nobody is hosted in it.
      const createBody: Record<string, unknown> = {
        kind: "workbench",
        name: definition.title,
      };
      const createRes = await api(
        hub.baseUrl,
        "POST",
        `/api/tenants/${seeded.tenantId}/chat/workbenches`,
        createBody,
        cookies,
      );
      expectStatus(`create workbench from "${templateId}"`, createRes, 201);
      const workbenchId = stringField(
        createRes.data,
        "id",
        `create workbench from "${templateId}"`,
      );

      const result = await instantiateWorkbenchTemplate(definition, {
        async listAgentHandles() {
          const res = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${seeded.tenantId}/workflows/definitions?limit=100`,
            undefined,
            cookies,
          );
          expectStatus("list agent definitions", res, 200);
          const rows = arrayField(
            res.data,
            "data",
            "list agent definitions",
          ) as { name: string; id: string }[];
          return rows.map((row) => ({ handle: row.name, id: row.id }));
        },
        async createParticipantAgent(request) {
          const res = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${seeded.tenantId}/agent-definitions`,
            request,
            cookies,
          );
          if (res.status !== 200 && res.status !== 201) {
            throw new Error(
              `create participant agent "${request.handle}" returned ` +
                `${String(res.status)}: ${JSON.stringify(res.data)}`,
            );
          }
          return {
            id: stringField(res.data, "id", `created "${request.handle}"`),
          };
        },
        async inviteParticipantAgent(id) {
          const res = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${seeded.tenantId}/chat/workbenches/${workbenchId}/invite`,
            { definitionId: id },
            cookies,
          );
          if (res.status !== 200 && res.status !== 201) {
            throw new Error(
              `invite participant agent "${id}" returned ` +
                `${String(res.status)}: ${JSON.stringify(res.data)}`,
            );
          }
        },
        async deployBlockWorkflow(block) {
          const res = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${seeded.tenantId}/template-blocks/${block.assetName}/deploy`,
            undefined,
            cookies,
          );
          if (res.status !== 200 && res.status !== 201) {
            throw new Error(
              `deploy template block "${block.assetName}" returned ` +
                `${String(res.status)}: ${JSON.stringify(res.data)}`,
            );
          }
          return { created: res.status === 201 };
        },
        async recordPendingConnections(pendingConnections) {
          const res = await api(
            hub.baseUrl,
            "PATCH",
            `/api/tenants/${seeded.tenantId}/chat/workbenches/${workbenchId}/settings`,
            templateSettingsPatch(definition.id, pendingConnections),
            cookies,
          );
          expectStatus("record pending connections", res, 200);
        },
        async beginOnboarding(steps) {
          for (const step of steps) {
            if (step.kind !== "connect-plugin") continue;
            const res = await api(
              hub.baseUrl,
              "POST",
              `/api/tenants/${seeded.tenantId}/chat/workbenches/${workbenchId}/onboarding`,
              {
                kind: "connect-github",
                requiredForTemplate: definition.title,
                promise: definition.promise,
                steps: steps.map(({ title, why }) => ({ title, why })),
              },
              cookies,
            );
            expectStatus("post the onboarding walkthrough card", res, 201);
          }
        },
      });

      // The rest of the definition's onboarding walkthrough, driven
      // here rather than by a person clicking the in-room card: read the
      // connect card's live state, then start reviewing every listed repo —
      // which mints the per-repo grant and `webhook_trigger` row the
      // fire-webhook step needs.
      let startedTriggerCount = 0;
      if (definition.plugins.required.includes("github")) {
        const stateRes = await api(
          hub.baseUrl,
          "GET",
          `/api/tenants/${seeded.tenantId}/workbenches/${workbenchId}/github/state`,
          undefined,
          cookies,
        );
        expectStatus("read the connect card's GitHub state", stateRes, 200);
        const state = stateRes.data as {
          kind: string;
          repos?: { id: string }[];
        };
        if (state.kind !== "connected") {
          throw new Error(
            `installTemplate("${templateId}"): expected the GitHub connect ` +
              `card to read connected, got: ${JSON.stringify(stateRes.data)}`,
          );
        }
        const repoIds = (state.repos ?? []).map((repo) => repo.id);
        const startRes = await api(
          hub.baseUrl,
          "POST",
          `/api/tenants/${seeded.tenantId}/workbenches/${workbenchId}/github/start-reviewing`,
          { repoIds },
          cookies,
        );
        expectStatus("start reviewing the listed repos", startRes, 200);
        const started = (startRes.data as { startedTriggerCount?: unknown })
          .startedTriggerCount;
        if (typeof started !== "number") {
          throw new Error(
            `start-reviewing answered without a startedTriggerCount: ${JSON.stringify(startRes.data)}`,
          );
        }
        startedTriggerCount = started;
      }

      return {
        human: `(harness) install template "${templateId}"`,
        replyText:
          `template "${templateId}" installed into workbench ${workbenchId}: ` +
          `created [${result.createdHandles.join(", ")}], ` +
          `skipped [${result.skippedHandles.join(", ")}], ` +
          `deployed blocks [${result.deployedBlockAssetNames.join(", ")}], ` +
          `pending connections [${result.pendingConnections.join(", ")}], ` +
          `webhook triggers started: ${String(startedTriggerCount)}`,
        toolCalls: [],
      };
    }

    // Fires a trigger through the REAL ingress route
    // (`POST /api/webhooks/:triggerId`), HMAC-signed the way any
    // external sender signs. The signing secret is read off the
    // platform's own table (the trace.ts convention) — the eval hub
    // boots with ALLOW_PLAINTEXT_SECRETS, so the scratch row carries it
    // readable; the route itself still verifies the signature for real.
    async function fireWebhook(
      triggerId: string,
      payload: unknown,
    ): Promise<Turn> {
      const rows = await sqlClient.unsafe(
        "select secret from webhook_triggers.webhook_trigger where id = $1",
        [triggerId],
      );
      const secret = rows[0]?.["secret"];
      if (typeof secret !== "string" || secret === "") {
        throw new Error(
          `fireWebhook("${triggerId}"): no readable signing secret on the trigger row`,
        );
      }
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const response = await fetch(
        new URL(`/api/webhooks/${triggerId}`, hub.baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
            [WEBHOOK_SIGNATURE_HEADER]: signPayload(secret, timestamp, rawBody),
          },
          body: rawBody,
        },
      );
      // Read as text first: a failed launch surfaces as the hub's own
      // non-JSON 500 body, which must land in the recorded turn rather
      // than die as a JSON parse crash that hides the status. A non-202
      // is recorded honestly (the same convention as the runner's
      // no-trigger miss) so the step's scorers grade red with the real
      // failure instead of the whole run crashing.
      const rawResponse = await response.text();
      if (response.status !== 202) {
        return {
          human: `(harness) fire webhook trigger ${triggerId}`,
          replyText:
            `webhook delivery failed: ingress returned ` +
            `${String(response.status)}: ${rawResponse.slice(0, 2_000)}\n` +
            `hub output (tail):\n${hub.output().slice(-4_000)}`,
          toolCalls: [],
        };
      }
      const data: unknown = JSON.parse(rawResponse);
      return {
        human: `(harness) fire webhook trigger ${triggerId}`,
        replyText:
          `webhook delivery accepted: instance ` +
          `${stringField(data, "instanceId", "webhook fire")} at ` +
          `${stringField(data, "address", "webhook fire")}`,
        toolCalls: [],
      };
    }

    const captureWorldSnapshot = infra.captureWorldSnapshot;
    return {
      configName: config.name,
      sendTurn,
      installTemplate,
      fireWebhook,
      close: closeAll,
      ...(captureWorldSnapshot === undefined
        ? {}
        : {
            snapshotWorld: (): Promise<WorldSnapshot> =>
              captureWorldSnapshot({
                tenantId: seeded.tenantId,
                hubDataDir,
                fakeReceipts,
              }),
          }),
    };
  } catch (cause) {
    await closeAll();
    throw cause;
  }
}
