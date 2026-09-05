// Mounts `createChatRoutes` into a bare `Hono` with fake platform/store
// deps, exercising the route surface itself: request parsing, grant
// checks, and HTTP envelope mapping. Settings-vocabulary behavior lives
// in `workbench-settings.test.ts`, fan-out/context/invite behavior in
// `workbench-service.test.ts`, and the SSE registry in
// `workbench-events.test.ts`.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import {
  InferenceResolutionError,
  DefinitionProjectionMissingError,
} from "@corbits/folded-runs";
import { postRoomMessage } from "../src/room-messages";
import type { Part } from "../src/parts";
import { createChatRoutes } from "../src/routes";
import { createInMemoryWorkbenchTenancyStore } from "../src/workbench-tenancy";
import { createInMemoryChatStore } from "../src/store";
import { createInMemoryThreadStore } from "../src/threads";
import {
  buildDeps,
  createWorkbench,
  fakePlatform,
  mountAs,
  principal,
  sendText,
  TENANT,
  timelineEvents,
  timelineOf,
  timelineTexts,
} from "./test-support";

describe("POST /workbenches", () => {
  test("does not expose an agent chat until its agent run is minted", async () => {
    let finishHostLaunch: (() => void) | undefined;
    const hostLaunch = new Promise<void>((resolve) => {
      finishHostLaunch = resolve;
    });
    const deliveries: (() => Promise<void>)[] = [];
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "Echo" }],
        launchInvite: async () => {
          await hostLaunch;
          return {
            instanceId: "ins_invited1",
            address: "ins_invited1@acme.example",
          };
        },
      }),
      runPostMintDelivery: (work) => {
        deliveries.push(work);
      },
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    let answered = false;
    const request = createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    }).then((result) => {
      answered = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(answered).toBe(false);
    expect(deliveries).toHaveLength(0);

    finishHostLaunch?.();
    const { response } = await request;
    expect(response.status).toBe(201);
    expect(deliveries).toHaveLength(1);
  });

  test("launches an instance and seeds workbench_settings with kind defaults", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response, body } = await createWorkbench(app, {
      kind: "workbench",
      name: "General",
    });

    expect(response.status).toBe(201);
    expect(body).toMatchObject({
      title: "General",
      kind: "workbench",
      pinned: true,
      participants: [],
    });
    expect(typeof body.id).toBe("string");

    const stored = await deps.store.getWorkbenchSettings(TENANT.id, body.id);
    expect(stored?.settings["chat/kind"]).toBe("workbench");
    expect(stored?.settings["chat/pinned"]).toBe(true);
  });

  test("an unrecognized kind is accepted as data with chat-like defaults", async () => {
    const app = mountAs(createChatRoutes(buildDeps()), "prn_alice");

    const { response, body } = await createWorkbench(app, { kind: "standup" });

    expect(response.status).toBe(201);
    expect(body.kind).toBe("standup");
    expect(body.pinned).toBe(false);
  });

  test("a malformed body is rejected with the structured error envelope", async () => {
    const app = mountAs(createChatRoutes(buildDeps()), "prn_alice");

    const response = await app.request("/workbenches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "no kind field" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("a denied grant is rejected before any workbench is created", async () => {
    const deps = buildDeps({
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/workbenches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "chat", definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(403);
  });

  test("creating a chat without definitionId is a 400", async () => {
    const app = mountAs(createChatRoutes(buildDeps()), "prn_alice");

    const response = await app.request("/workbenches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "chat" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("creating an unnamed chat titles it by the agent's display name, tenant row included", async () => {
    const deliveries: (() => Promise<void>)[] = [];
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [
          { id: "wfd_assist", name: "assistant", description: "Myra" },
        ],
      }),
      runPostMintDelivery: (work) => {
        deliveries.push(work);
      },
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response, body } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_assist",
    });

    // Both runs are minted before the 201, so the title and participant
    // are durable while timeline delivery and pre-warming remain queued.
    expect(response.status).toBe(201);
    expect(body.title).toBe("Myra");
    expect(body.participants).toEqual([
      { address: "ins_invited1@acme.example", handle: "myra" },
    ]);
    expect(deliveries).toHaveLength(1);
    await deliveries[0]?.();

    const settled = await deps.store.getWorkbenchSettings(TENANT.id, body.id);
    expect(settled?.settings["chat/participants"]).toEqual([
      { address: "ins_invited1@acme.example", handle: "myra" },
    ]);
    const tenancy = deps.tenancy as ReturnType<
      typeof createInMemoryWorkbenchTenancyStore
    >;
    const [minted] = await tenancy.listChildWorkbenchTenancies(TENANT.id);
    expect(minted?.slug.startsWith("myra")).toBe(true);
  });

  test("creating a chat auto-invites its agent and titles it by handle", async () => {
    const deliveries: (() => Promise<void>)[] = [];
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
      runPostMintDelivery: (work) => {
        deliveries.push(work);
      },
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response, body } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    expect(response.status).toBe(201);
    expect(body.kind).toBe("chat");
    expect(body.participants).toEqual([
      { address: "ins_invited1@acme.example", handle: "echo" },
    ]);
    await deliveries[0]?.();

    const settled = await deps.store.getWorkbenchSettings(TENANT.id, body.id);
    expect(settled?.settings["chat/name"]).toBe("echo");
    expect(settled?.settings["chat/participants"]).toEqual([
      { address: "ins_invited1@acme.example", handle: "echo" },
    ]);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.launchInviteCalls).toEqual([
      {
        tenantId: TENANT.id,
        creatorPrincipalId: "prn_alice",
        definitionId: "wfd_echo",
      },
    ]);
    // The mint asks no agent for a turn: everything it says lands on the
    // chat's own timeline, never in an agent's mailbox.
    expect(platform.sentMail).toHaveLength(0);

    const timeline = await timelineOf(deps, body.id);
    expect(timelineEvents(timeline, "workbench.agent-joined")).toHaveLength(1);

    // CL-6126: the agent speaks first on every mint — a canned greeting
    // is posted straight onto the chat's own timeline under the agent's
    // run, so the room opens with a hello without waiting on an
    // inference turn.
    const greeting = timeline.find((message) =>
      message.parts.some((part) => part.kind === "text"),
    );
    expect(greeting?.workbenchId).toBe(body.id);
    expect(greeting?.runId).toBe("ins_invited1");
    expect(greeting?.sender.address).toBe("ins_invited1@acme.example");
    // The greeting names the agent by its real display name (CL-6471) —
    // never its lowercase mention handle.
    expect(timelineTexts(timeline)[0]).toContain("Echo");
    expect(timelineTexts(timeline)[0]).toMatch(/\?$/);
  });

  // CL-6471: the owner's live repro — instantiating the code-review
  // template on a fresh stack, the setup agent's own definition missed
  // the pre-fetched `invitable` snapshot (a just-seeded/just-redeployed
  // row the snapshot predates), and its greeting rendered "I'm
  // run_737a058d…" instead of its real name. The greeting must resolve
  // the real name through a live lookup instead, never the run's own
  // address.
  test("a definition missing from the invitable snapshot still greets with its real name, never its own run address (CL-6471)", async () => {
    const deliveries: (() => Promise<void>)[] = [];
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [], // the stale/pre-fetched snapshot misses it
        resolveDefinitionNameSource: async (definitionId) =>
          definitionId === "wfd_echo"
            ? { name: "echo", description: "Myra" }
            : undefined,
      }),
      runPostMintDelivery: (work) => {
        deliveries.push(work);
      },
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { body } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });
    await deliveries[0]?.();

    const timeline = await timelineOf(deps, body.id);
    expect(timelineTexts(timeline)[0]).toContain("Myra");
    expect(timelineTexts(timeline)[0]).not.toContain("ins_invited1");
  });

  test("creating an untemplated chat mints exactly as it always has", async () => {
    const deliveries: (() => Promise<void>)[] = [];
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
      runPostMintDelivery: (work) => {
        deliveries.push(work);
      },
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response, body } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });
    await deliveries[0]?.();

    expect(response.status).toBe(201);
    const timeline = await timelineOf(deps, body.id);
    expect(timelineTexts(timeline)[0]).toContain("Echo");
  });

  test("creating a chat deploys nothing on the request path — the deploys ride the post-mint delivery", async () => {
    const deliveries: (() => Promise<void>)[] = [];
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
      runPostMintDelivery: (work) => {
        deliveries.push(work);
      },
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response, body } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    // The 201 carries a joined agent, but nothing has been deployed for
    // it yet: host and invite are mints, and the pre-warm is deferred.
    expect(response.status).toBe(201);
    expect(body.participants).toEqual([
      { address: "ins_invited1@acme.example", handle: "echo" },
    ]);
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.ensureAwakeCalls).toEqual([]);

    await deliveries[0]?.();
    expect(platform.ensureAwakeCalls).toEqual(["ins_invited1@acme.example"]);
  });

  test("creating a chat with an explicit name keeps that name as the title", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response, body } = await createWorkbench(app, {
      kind: "chat",
      name: "My Assistant",
      definitionId: "wfd_echo",
    });

    expect(response.status).toBe(201);
    expect(body.title).toBe("My Assistant");
  });

  test("an agent mint failure compensates the workbench before returning", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "Echo" }],
        launchInvite: async () => {
          throw new InferenceResolutionError(
            "the invited agent",
            "This definition declares no model requirements",
          );
        },
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/workbenches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "chat", definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(409);
    const errorBody = (await response.json()) as {
      error: { code: string; userMessage: string };
    };
    expect(errorBody.error.code).toBe("not_launchable");
    expect(errorBody.error.userMessage).toBe(
      "This agent's model isn't available here.",
    );
    expect(errorBody.error.userMessage).not.toMatch(
      /cannot resolve an inference/,
    );
    expect(errorBody.error.userMessage).not.toMatch(/HTTP/);

    const tenancy = deps.tenancy as ReturnType<
      typeof createInMemoryWorkbenchTenancyStore
    >;
    expect(await deps.store.listWorkbenchSettings(TENANT.id)).toHaveLength(0);
    expect(await tenancy.listChildWorkbenchTenancies(TENANT.id)).toHaveLength(
      0,
    );
  });

  // A workbench create must never 500 on a definition row with no
  // frozen wire projection stored on it (a pre-cutover row, or one
  // whose approval never completed) — it answers a named 4xx with
  // consumer-language guidance, and still compensates the orphaned
  // tenant/settings exactly as every other agent-mint failure does.
  test("a definition with no stored launch body answers 409 with recovery guidance, not 500, and still compensates", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "Echo" }],
        launchInvite: async () => {
          throw new DefinitionProjectionMissingError("assistant");
        },
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/workbenches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "chat", definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(409);
    const errorBody = (await response.json()) as {
      error: { code: string; userMessage: string };
    };
    expect(errorBody.error.code).toBe("not_launchable");
    expect(errorBody.error.userMessage).toMatch(/save its instructions/);

    const tenancy = deps.tenancy as ReturnType<
      typeof createInMemoryWorkbenchTenancyStore
    >;
    expect(await deps.store.listWorkbenchSettings(TENANT.id)).toHaveLength(0);
    expect(await tenancy.listChildWorkbenchTenancies(TENANT.id)).toHaveLength(
      0,
    );
  });

  test("a generic agent mint failure compensates the workbench so a retry starts clean", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "Echo" }],
        launchInvite: () =>
          Promise.reject(new Error("blocked: too many @mentions; max 5")),
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/workbenches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "chat", definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(500);

    const tenancy = deps.tenancy as ReturnType<
      typeof createInMemoryWorkbenchTenancyStore
    >;
    expect(await deps.store.listWorkbenchSettings(TENANT.id)).toHaveLength(0);
    expect(await tenancy.listChildWorkbenchTenancies(TENANT.id)).toHaveLength(
      0,
    );
  });

  test("an agent mint failure compensates the workbench", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "Echo" }],
        launchInvite: () => Promise.reject(new Error("database unavailable")),
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/workbenches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "chat", definitionId: "wfd_echo" }),
    });
    expect(response.status).toBe(500);

    const tenancy = deps.tenancy as ReturnType<
      typeof createInMemoryWorkbenchTenancyStore
    >;
    expect(await deps.store.listWorkbenchSettings(TENANT.id)).toHaveLength(0);
    expect(await tenancy.listChildWorkbenchTenancies(TENANT.id)).toHaveLength(
      0,
    );
  });

  test("a failed agent pre-warm leaves the minted chat ready for first-message retry", async () => {
    const deliveries: (() => Promise<void>)[] = [];
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "Echo" }],
        ensureAwake: () => Promise.reject(new Error("sidecar unavailable")),
      }),
      runPostMintDelivery: (work) => {
        deliveries.push(work);
      },
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response, body } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });
    expect(response.status).toBe(201);
    await deliveries[0]?.();

    const tenancy = deps.tenancy as ReturnType<
      typeof createInMemoryWorkbenchTenancyStore
    >;
    expect(await deps.store.listWorkbenchSettings(TENANT.id)).toHaveLength(1);
    expect(await tenancy.listChildWorkbenchTenancies(TENANT.id)).toHaveLength(
      1,
    );
    const settled = await deps.store.getWorkbenchSettings(TENANT.id, body.id);
    expect(settled?.settings["chat/participants"]).toEqual([
      { address: "ins_invited1@acme.example", handle: "echo" },
    ]);
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.ensureAwakeCalls).toEqual(["ins_invited1@acme.example"]);
  });
});

describe("POST /workbenches — kind: chat + definitionId always find-or-reopens (CL-6981)", () => {
  test("creating a chat with the same agent twice, reuseExisting: true both times, reuses the first chat instead of forking a duplicate", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const first = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
      reuseExisting: true,
    });
    expect(first.response.status).toBe(201);

    const second = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
      reuseExisting: true,
    });

    expect(second.response.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.kind).toBe("chat");

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.launchInviteCalls).toHaveLength(1);
    const chats = await deps.store.listWorkbenchSettings(TENANT.id, "chat");
    expect(chats).toHaveLength(1);
  });

  test("reuses the chat when the agent's definition was re-projected under a new id over the same asset", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [
          { id: "wfd_echo_v1", name: "Echo" },
          { id: "wfd_echo_v2", name: "Echo" },
        ],
        resolveDefinitionAssetId: async (definitionId: string) =>
          definitionId.startsWith("wfd_echo") ? "ast_echo" : undefined,
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const first = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo_v1",
      reuseExisting: true,
    });
    expect(first.response.status).toBe(201);

    const second = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo_v2",
      reuseExisting: true,
    });

    expect(second.response.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    const chats = await deps.store.listWorkbenchSettings(TENANT.id, "chat");
    expect(chats).toHaveLength(1);
  });

  test("a new agent chat records its definitionId for future dedup", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { body } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    const stored = await deps.store.getWorkbenchSettings(TENANT.id, body.id);
    expect(stored?.settings["chat/definitionId"]).toBe("wfd_echo");
  });

  test("a chat minted before chat/definitionId existed is still found, by reverse-resolving its agent participant's address", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        resolveDefinitionIdByAddress: async (address) =>
          address === "ins_legacy@acme.example" ? "wfd_echo" : undefined,
      }),
    });
    const legacyWorkbenchId = "run_legacy1";
    const legacyTenant = await deps.tenancy.createWorkbenchTenant({
      parentTenantId: TENANT.id,
      workbenchId: legacyWorkbenchId,
      name: "echo",
      creatorUserId: "prn_alice",
      cookies: ["session=test"],
    });
    await deps.store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: legacyWorkbenchId,
      settings: {
        "chat/kind": "chat",
        "chat/pinned": false,
        "chat/name": "echo",
        "chat/participants": [
          { address: "ins_legacy@acme.example", handle: "echo" },
        ],
      },
      updatedBy: "prn_alice",
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response, body } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
      reuseExisting: true,
    });

    expect(response.status).toBe(200);
    expect(body.id).toBe(legacyWorkbenchId);
    expect(body.tenancy).toEqual({
      tenantId: legacyTenant.tenantId,
      parentTenantId: TENANT.id,
      slug: legacyTenant.slug,
    });
    const chats = await deps.store.listWorkbenchSettings(TENANT.id, "chat");
    expect(chats).toHaveLength(1);
  });

  test("two pre-existing duplicate chats for the same agent resolve to the oldest, not whichever the caller hits first", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const olderWorkbenchId = "run_older1";
    await deps.tenancy.createWorkbenchTenant({
      parentTenantId: TENANT.id,
      workbenchId: olderWorkbenchId,
      name: "echo",
      creatorUserId: "prn_alice",
      cookies: ["session=test"],
    });
    await deps.store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: olderWorkbenchId,
      settings: {
        "chat/kind": "chat",
        "chat/pinned": false,
        "chat/name": "echo",
        "chat/definitionId": "wfd_echo",
        "chat/participants": [],
      },
      updatedBy: "prn_alice",
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const newerWorkbenchId = "run_newer1";
    await deps.tenancy.createWorkbenchTenant({
      parentTenantId: TENANT.id,
      workbenchId: newerWorkbenchId,
      name: "echo",
      creatorUserId: "prn_alice",
      cookies: ["session=test"],
    });
    await deps.store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: newerWorkbenchId,
      settings: {
        "chat/kind": "chat",
        "chat/pinned": false,
        "chat/name": "echo",
        "chat/definitionId": "wfd_echo",
        "chat/participants": [],
      },
      updatedBy: "prn_alice",
    });

    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { response, body } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
      reuseExisting: true,
    });

    expect(response.status).toBe(200);
    expect(body.id).toBe(olderWorkbenchId);
  });

  test("a message sent to the found-or-created chat still auto-responds without a mention", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const first = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
      reuseExisting: true,
    });
    const second = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
      reuseExisting: true,
    });
    expect(second.response.status).toBe(200);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const mailBefore = platform.sentMail.length;
    await sendText(app, second.body.id, "hello");

    expect(platform.sentMail.length).toBeGreaterThan(mailBefore);
    const fanOut = platform.sentMail[platform.sentMail.length - 1];
    expect(fanOut?.workbenchId).toBe("ins_invited1");
    expect(fanOut?.fromWorkbenchId).toBe(first.body.id);
  });
});

describe("POST /workbenches — reuseExisting no longer opts out of find-or-reopen (CL-6981)", () => {
  test("creating a chat with the same agent twice, reuseExisting omitted both times, reopens the first chat", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const first = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });
    expect(first.response.status).toBe(201);

    const second = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    expect(second.response.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.kind).toBe("chat");

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.launchInviteCalls).toHaveLength(1);
    const chats = await deps.store.listWorkbenchSettings(TENANT.id, "chat");
    expect(chats).toHaveLength(1);

    const firstTenancy = await deps.tenancy.getWorkbenchTenancy(first.body.id);
    const secondTenancy = await deps.tenancy.getWorkbenchTenancy(
      second.body.id,
    );
    expect(firstTenancy?.tenantId).toBeDefined();
    expect(secondTenancy?.tenantId).toBe(firstTenancy?.tenantId);
  });

  test("creating a chat with the same agent twice, reuseExisting: false explicitly, still reopens the first chat", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const first = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
      reuseExisting: false,
    });
    const second = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
      reuseExisting: false,
    });

    expect(first.response.status).toBe(201);
    expect(second.response.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  test("a pre-existing chat for the same agent is reopened even when reuseExisting is omitted", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const landHop = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
      reuseExisting: true,
    });
    expect(landHop.response.status).toBe(201);

    const picked = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    expect(picked.response.status).toBe(200);
    expect(picked.body.id).toBe(landHop.body.id);
    const chats = await deps.store.listWorkbenchSettings(TENANT.id, "chat");
    expect(chats).toHaveLength(1);
  });
});

describe("POST /workbenches — chat with a person (DM)", () => {
  function registerBob(deps: ReturnType<typeof buildDeps>) {
    const tenancy = deps.tenancy as ReturnType<
      typeof createInMemoryWorkbenchTenancyStore
    >;
    tenancy.registerPrincipal(TENANT.id, {
      id: "prn_bob",
      kind: "user",
      status: "active",
      refId: "prn_bob",
    });
  }

  test("creates a two-member chat carrying the person as its participant", async () => {
    const deps = buildDeps();
    registerBob(deps);
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response, body } = await createWorkbench(app, {
      kind: "chat",
      principalId: "prn_bob",
      name: "Bob",
    });

    expect(response.status).toBe(201);
    expect(body.kind).toBe("chat");
    expect(body.title).toBe("Bob");
    expect(body.participants).toEqual([{ address: "prn_bob", handle: "bob" }]);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.launchInviteCalls).toHaveLength(0);
    expect(platform.sentMail).toHaveLength(0);

    const timeline = await timelineOf(deps, body.id);
    expect(timelineEvents(timeline, "workbench.member-joined")).toHaveLength(1);
  });

  test("falls back to the bare principal id as both handle and title when no name is given — the defensive edge case a bare API call can hit; chat-ui always sends the member's display name as `name` instead", async () => {
    const deps = buildDeps();
    registerBob(deps);
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { response, body } = await createWorkbench(app, {
      kind: "chat",
      principalId: "prn_bob",
    });

    expect(response.status).toBe(201);
    expect(body.title).toBe("prn_bob");
    expect(body.participants).toEqual([
      { address: "prn_bob", handle: "prn_bob" },
    ]);
  });

  test("rejects a chat with both a definitionId and a principalId", async () => {
    const deps = buildDeps();
    registerBob(deps);
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/workbenches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "chat",
        definitionId: "wfd_echo",
        principalId: "prn_bob",
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("refuses to start a direct chat with yourself — 409", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/workbenches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "chat", principalId: "prn_alice" }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");

    // Nothing was minted for a request refused before creation began.
    const workbenches = await deps.store.listWorkbenchSettings(TENANT.id);
    expect(workbenches).toHaveLength(0);
  });

  test("rejects a principalId naming no active member of this bench — 400", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/workbenches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "chat", principalId: "prn_ghost" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");

    const workbenches = await deps.store.listWorkbenchSettings(TENANT.id);
    expect(workbenches).toHaveLength(0);
  });

  test("rejects a principalId naming a suspended member — 400", async () => {
    const deps = buildDeps();
    const tenancy = deps.tenancy as ReturnType<
      typeof createInMemoryWorkbenchTenancyStore
    >;
    tenancy.registerPrincipal(TENANT.id, {
      id: "prn_bob",
      kind: "user",
      status: "suspended",
      refId: "prn_bob",
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/workbenches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "chat", principalId: "prn_bob" }),
    });

    expect(response.status).toBe(400);
  });
});

describe("POST /workbenches/:id/invite", () => {
  test("an agent with no launchable inference source returns 409, not 500", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        launchInvite: async () => {
          throw new InferenceResolutionError(
            "the invited agent",
            "No launchable inference source for that definition",
          );
        },
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    // Invite is for workbenches only; create one first.
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });
    expect(workbench.id).toBeTruthy();

    const response = await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_new" }),
    });

    expect(response.status).toBe(409);
    const errorBody = (await response.json()) as {
      error: { code: string; userMessage: string };
    };
    expect(errorBody.error.code).toBe("not_launchable");
    expect(errorBody.error.userMessage).toBe(
      "This agent's model isn't available here.",
    );
    expect(errorBody.error.userMessage).not.toMatch(
      /No launchable inference source/,
    );
  });

  test("a definition with no stored launch body returns 409, not 500", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        launchInvite: async () => {
          throw new DefinitionProjectionMissingError("assistant");
        },
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });
    expect(workbench.id).toBeTruthy();

    const response = await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_new" }),
    });

    expect(response.status).toBe(409);
    const errorBody = (await response.json()) as {
      error: { code: string; userMessage: string };
    };
    expect(errorBody.error.code).toBe("not_launchable");
    expect(errorBody.error.userMessage).toMatch(/save its instructions/);
  });
});

describe("POST /workbenches/:id/onboarding", () => {
  const STEP = {
    kind: "connect-github",
    requiredForTemplate: "Code review",
    promise: "Three reviewers read every pull request.",
    steps: [
      { title: "Connect GitHub", why: "So reviewers can read your code." },
      { title: "Pick repositories", why: "So reviews land where you work." },
    ],
  };

  async function postOnboarding(
    app: ReturnType<typeof mountAs>,
    workbenchId: string,
    body: unknown,
  ) {
    return app.request(`/workbenches/${workbenchId}/onboarding`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("posts the walkthrough card into an empty channel from a system sender, launching nobody", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Code review",
    });

    const response = await postOnboarding(app, workbench.id, STEP);

    expect(response.status).toBe(201);
    const posted = (await response.json()) as { id: string };
    expect(typeof posted.id).toBe("string");

    const timeline = await timelineOf(deps, workbench.id);
    expect(timeline).toHaveLength(1);
    const message = timeline[0];
    expect(message?.id).toBe(posted.id);
    expect(message?.sender.address).toBe(`system@${workbench.id}`);
    expect(message?.runId).toBeNull();
    expect(message?.parts).toEqual([
      {
        kind: "block",
        block: {
          type: "connect-github",
          data: {
            requiredForTemplate: "Code review",
            promise: "Three reviewers read every pull request.",
            steps: STEP.steps,
            state: "disconnected",
          },
        },
      },
    ]);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.launchInviteCalls).toEqual([]);
    expect(platform.ensureAwakeCalls).toEqual([]);
    expect(platform.sentMail).toHaveLength(0);
  });

  test("a malformed step is rejected with the structured error envelope", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Code review",
    });

    const response = await postOnboarding(app, workbench.id, {
      kind: "connect-github",
      requiredForTemplate: "Code review",
      promise: "",
      steps: [],
    });

    expect(response.status).toBe(400);
    const errorBody = (await response.json()) as { error: { code: string } };
    expect(errorBody.error.code).toBe("bad_request");
    expect(await timelineOf(deps, workbench.id)).toHaveLength(0);
  });

  test("an undeclared step kind is rejected — the route is not a post-any-block hole", async () => {
    const app = mountAs(createChatRoutes(buildDeps()), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Code review",
    });

    const response = await postOnboarding(app, workbench.id, {
      kind: "approve",
      requiredForTemplate: "Code review",
      promise: "Anything at all.",
      steps: [],
    });

    expect(response.status).toBe(400);
  });

  test("an unknown workbench is a 404", async () => {
    const app = mountAs(createChatRoutes(buildDeps()), "prn_alice");

    const response = await postOnboarding(app, "chan_missing", STEP);

    expect(response.status).toBe(404);
    const errorBody = (await response.json()) as { error: { code: string } };
    expect(errorBody.error.code).toBe("not_found");
  });
});

describe("DELETE /workbenches/:id/participants/:address", () => {
  test("removes a human participant and releases nothing (no instance to release)", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
      participants: ["prn_bob"],
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/participants/prn_bob`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    const settingsResponse = await app.request(
      `/workbenches/${workbench.id}/settings`,
    );
    const settingsBody = (await settingsResponse.json()) as {
      participants: { address: string }[];
    };
    expect(settingsBody.participants).toEqual([]);
  });

  test("removes an invited agent and releases its launched instance", async () => {
    const released: { address: string; reason: string }[] = [];
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
      releaseAgentInstance: async (address, reason) => {
        released.push({ address, reason });
      },
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });
    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/participants/${encodeURIComponent(
        "ins_invited1@acme.example",
      )}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(released).toEqual([
      { address: "ins_invited1@acme.example", reason: "participant-removed" },
    ]);
    const settingsResponse = await app.request(
      `/workbenches/${workbench.id}/settings`,
    );
    const settingsBody = (await settingsResponse.json()) as {
      participants: { address: string }[];
    };
    expect(settingsBody.participants).toEqual([]);
  });

  test("still removes the participant when no releaseAgentInstance is wired", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });
    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/participants/${encodeURIComponent(
        "ins_invited1@acme.example",
      )}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
  });

  test("404s for an unknown workbench", async () => {
    const app = mountAs(createChatRoutes(buildDeps()), "prn_alice");
    const response = await app.request(
      "/workbenches/ins_missing/participants/prn_bob",
      { method: "DELETE" },
    );
    expect(response.status).toBe(404);
  });

  test("400s for a malformed address escape instead of throwing", async () => {
    const app = mountAs(createChatRoutes(buildDeps()), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/participants/%E0%A4%A`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(400);
  });

  test("404s for a participant that isn't in the workbench", async () => {
    const app = mountAs(createChatRoutes(buildDeps()), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/participants/prn_ghost`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(404);
  });

  test("refuses to remove a chat's fixed agent (409)", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: chat } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    const response = await app.request(
      `/workbenches/${chat.id}/participants/${encodeURIComponent(
        "ins_invited1@acme.example",
      )}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");
  });

  test("refuses to remove a chat's person counterpart (409)", async () => {
    const deps = buildDeps();
    (
      deps.tenancy as ReturnType<typeof createInMemoryWorkbenchTenancyStore>
    ).registerPrincipal(TENANT.id, {
      id: "prn_bob",
      kind: "user",
      status: "active",
      refId: "prn_bob",
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: chat } = await createWorkbench(app, {
      kind: "chat",
      principalId: "prn_bob",
    });

    const response = await app.request(
      `/workbenches/${chat.id}/participants/prn_bob`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(409);
  });

  test("a denied grant is rejected before any participant is removed", async () => {
    const deps = buildDeps({
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(
      "/workbenches/ins_whatever/participants/prn_bob",
      { method: "DELETE" },
    );
    expect(response.status).toBe(403);
  });
});

describe("GET /workbenches/:id/agents", () => {
  test("resolves the workbench's agent participant back to its definition id", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "Echo" }],
        resolveDefinitionIdByAddress: async (address) =>
          address === "ins_invited1@acme.example" ? "wfd_echo" : undefined,
        resolveDefinitionAssetId: async (definitionId) => `ast_${definitionId}`,
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });
    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    const response = await app.request(`/workbenches/${workbench.id}/agents`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: {
        address: string;
        handle: string;
        definitionId: string;
        displayName: string;
      }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.address).toBe("ins_invited1@acme.example");
    expect(body.items[0]?.definitionId).toBe("wfd_echo");
    expect(body.items[0]?.displayName).toBe("Echo");
  });

  test("prefers the definition's display name over its slug (CL-6424)", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [
          { id: "wfd_review", name: "code-review", description: "Reviewer" },
        ],
        resolveDefinitionIdByAddress: async (address) =>
          address === "ins_invited1@acme.example" ? "wfd_review" : undefined,
        resolveDefinitionAssetId: async (definitionId) => `ast_${definitionId}`,
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });
    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_review" }),
    });

    const response = await app.request(`/workbenches/${workbench.id}/agents`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { address: string; displayName: string }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.displayName).toBe("Reviewer");
  });

  test("falls back to a live name lookup when the invitable snapshot predates the definition (CL-6424)", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [],
        resolveDefinitionNameSource: async (definitionId) =>
          definitionId === "wfd_echo"
            ? { name: "echo", description: "Myra" }
            : undefined,
        resolveDefinitionIdByAddress: async (address) =>
          address === "ins_invited1@acme.example" ? "wfd_echo" : undefined,
        resolveDefinitionAssetId: async (definitionId) => `ast_${definitionId}`,
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });
    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    const response = await app.request(`/workbenches/${workbench.id}/agents`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { address: string; displayName: string }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.displayName).toBe("Myra");
  });

  test("omits a participant whose definition has no name source left (CL-6424)", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [],
        resolveDefinitionIdByAddress: async (address) =>
          address === "ins_invited1@acme.example" ? "wfd_ghost" : undefined,
        resolveDefinitionAssetId: async (definitionId) => `ast_${definitionId}`,
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });
    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_ghost" }),
    });

    const response = await app.request(`/workbenches/${workbench.id}/agents`);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  test("lists every invited agent when a workbench has more than one", async () => {
    let invited = 0;
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [
          { id: "wfd_echo", name: "Echo" },
          { id: "wfd_other", name: "Other" },
        ],
        launchInvite: async () => {
          invited += 1;
          return {
            instanceId: `ins_invited${invited}`,
            address: `ins_invited${invited}@acme.example`,
          };
        },
        resolveDefinitionIdByAddress: async (address) =>
          address === "ins_invited1@acme.example"
            ? "wfd_echo"
            : address === "ins_invited2@acme.example"
              ? "wfd_other"
              : undefined,
        resolveDefinitionAssetId: async (definitionId) => `ast_${definitionId}`,
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });
    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });
    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_other" }),
    });

    const response = await app.request(`/workbenches/${workbench.id}/agents`);
    const body = (await response.json()) as {
      items: { address: string; definitionId: string }[];
    };
    expect(body.items.map((item) => item.definitionId).sort()).toEqual([
      "wfd_echo",
      "wfd_other",
    ]);
  });

  test("lists no agents (empty items) for a workbench with none", async () => {
    const app = mountAs(createChatRoutes(buildDeps()), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Quiet",
    });

    const response = await app.request(`/workbenches/${workbench.id}/agents`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  test("404s for an unknown workbench", async () => {
    const app = mountAs(createChatRoutes(buildDeps()), "prn_alice");
    const response = await app.request(`/workbenches/ins_missing/agents`);
    expect(response.status).toBe(404);
  });

  test("omits a participant whose address no longer resolves to a definition", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        resolveDefinitionIdByAddress: async () => undefined,
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });
    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    const response = await app.request(`/workbenches/${workbench.id}/agents`);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});

describe("POST /workbenches/:id/agents/refresh", () => {
  test("asks the platform to refresh the given agent's running instance", async () => {
    const platform = fakePlatform();
    const deps = buildDeps({ platform });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });
    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/agents/refresh`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: "ins_invited1@acme.example" }),
      },
    );

    expect(response.status).toBe(200);
    expect(platform.refreshCalls).toEqual([
      {
        tenantId: TENANT.id,
        workbenchId: workbench.id,
        address: "ins_invited1@acme.example",
      },
    ]);
  });

  test("rejects a body with no address", async () => {
    const app = mountAs(createChatRoutes(buildDeps()), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/agents/refresh`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(response.status).toBe(400);
  });
});

describe("GET /workbenches", () => {
  test("filters by kind", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    await createWorkbench(app, { kind: "workbench", name: "Durable" });
    await createWorkbench(app, { kind: "chat", name: "Throwaway" });

    const response = await app.request("/workbenches?kind=workbench");
    const body = (await response.json()) as { items: { title: string }[] };

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.title).toBe("Durable");
  });

  test("a workbench with no messages carries no activity signals at all", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    await createWorkbench(app, { kind: "workbench", name: "Quiet" });

    const response = await app.request("/workbenches?kind=workbench");
    const body = (await response.json()) as {
      items: {
        unreadCount?: number;
        lastActivityAt?: string;
        live?: boolean;
      }[];
    };

    // An empty timeline has nothing to report: no unread badge, no
    // relative time, no live dot — never a fabricated zero date.
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.unreadCount).toBeUndefined();
    expect(body.items[0]?.lastActivityAt).toBeUndefined();
    expect(body.items[0]?.live).toBeUndefined();
  });

  test("counts messages sent since the caller's own read cursor as unread", async () => {
    const deps = buildDeps();
    const app = createChatRoutes(deps);
    const appAlice = mountAs(app, "prn_alice");
    const appBob = mountAs(app, "prn_bob");
    const { body: workbench } = await createWorkbench(appAlice, {
      kind: "workbench",
      name: "General",
    });

    await sendText(appAlice, workbench.id, "hello");
    await sendText(appAlice, workbench.id, "world");

    const bobList = (await (
      await appBob.request("/workbenches?kind=workbench")
    ).json()) as {
      items: {
        id: string;
        unreadCount?: number;
        lastActivityAt?: string;
        live?: boolean;
      }[];
    };
    const bobRow = bobList.items.find((item) => item.id === workbench.id);
    expect(bobRow?.unreadCount).toBe(2);
    expect(bobRow?.lastActivityAt).toBeDefined();
    expect(bobRow?.live).toBe(true);
  });

  test("carries a bounded text preview of the newest message", async () => {
    const deps = buildDeps();
    const app = createChatRoutes(deps);
    const appAlice = mountAs(app, "prn_alice");
    const appBob = mountAs(app, "prn_bob");
    const { body: workbench } = await createWorkbench(appAlice, {
      kind: "workbench",
      name: "General",
    });

    await sendText(appAlice, workbench.id, "See you at the standup");

    const bobList = (await (
      await appBob.request("/workbenches?kind=workbench")
    ).json()) as { items: { id: string; preview?: string }[] };
    const bobRow = bobList.items.find((item) => item.id === workbench.id);
    expect(bobRow?.preview).toBe("See you at the standup");
  });

  test("the unread badge clears once the caller's read cursor catches up", async () => {
    const deps = buildDeps();
    const app = createChatRoutes(deps);
    const appAlice = mountAs(app, "prn_alice");
    const appBob = mountAs(app, "prn_bob");
    const { body: workbench } = await createWorkbench(appAlice, {
      kind: "workbench",
      name: "General",
    });

    await sendText(appAlice, workbench.id, "hello");
    const sent = (await (
      await appAlice.request(`/workbenches/${workbench.id}/messages`)
    ).json()) as { items: { id: string; createdAt: string }[] };
    const last = sent.items.at(-1);
    if (last === undefined) throw new Error("expected at least one message");

    await appBob.request(`/workbenches/${workbench.id}/read-state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lastSeenCreatedAt: last.createdAt,
        lastSeenId: last.id,
      }),
    });

    const bobList = (await (
      await appBob.request("/workbenches?kind=workbench")
    ).json()) as { items: { id: string; unreadCount?: number }[] };
    const bobRow = bobList.items.find((item) => item.id === workbench.id);
    expect(bobRow?.unreadCount).toBe(0);
  });
});

describe("messages", () => {
  test("POST puts the Part[] on the timeline as the calling principal", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const parts: Part[] = [{ kind: "text", text: "hello" }];
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      },
    );

    expect(response.status).toBe(201);
    const timeline = await timelineOf(deps, workbench.id);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.senderPrincipalId).toBe("prn_alice");
    expect(timeline[0]?.sender).toEqual({
      name: null,
      address: `prn_alice@${TENANT.domain}`,
    });
    expect(timeline[0]?.parts).toEqual(parts);
  });

  test("POST rejects a malformed message body with the 400 envelope", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ kind: "not-a-real-part" }] }),
      },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("GET decodes run mail back to Part[]", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "hi there" }] }),
    });

    const response = await app.request(`/workbenches/${workbench.id}/messages`);
    const body = (await response.json()) as {
      items: {
        parts: Part[];
        sender: { name: string | null; address: string };
      }[];
    };

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.parts).toEqual([{ kind: "text", text: "hi there" }]);
    expect(body.items[0]?.sender).toEqual({
      name: null,
      address: "prn_alice@acme.example",
    });
  });
});

describe("POST /workbenches/:id/messages — invite pre-step (CL-5879 mention-pulls-in)", () => {
  test("an agent mention of a non-participant invites the agent, then sends, both persisted", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "@echo welcome!" }],
          invite: [{ kind: "agent", definitionId: "wfd_echo" }],
        }),
      },
    );

    expect(response.status).toBe(201);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.launchInviteCalls).toEqual([
      {
        tenantId: TENANT.id,
        creatorPrincipalId: "prn_alice",
        definitionId: "wfd_echo",
      },
    ]);

    const settingsResponse = await app.request(
      `/workbenches/${workbench.id}/settings`,
    );
    const settingsBody = (await settingsResponse.json()) as {
      participants: { address: string; handle: string }[];
    };
    expect(settingsBody.participants).toEqual([
      { address: "ins_invited1@acme.example", handle: "echo" },
    ]);

    // The message itself lands on the workbench's own timeline...
    const messagesResponse = await app.request(
      `/workbenches/${workbench.id}/messages`,
    );
    const messagesBody = (await messagesResponse.json()) as {
      items: { parts: Part[] }[];
    };
    expect(
      messagesBody.items.some((item) =>
        item.parts.some(
          (part) => part.kind === "text" && part.text === "@echo welcome!",
        ),
      ),
    ).toBe(true);

    // ...and fans out to the newly-invited agent's own mailbox, since the
    // mention names its own freshly-assigned handle.
    expect(
      platform.sentMail.some(
        (mail) =>
          mail.workbenchId === "ins_invited1" &&
          mail.fromWorkbenchId === workbench.id,
      ),
    ).toBe(true);
  });

  test("a person mention of a non-participant bench member invites them, then sends", async () => {
    const deps = buildDeps();
    (
      deps.tenancy as ReturnType<typeof createInMemoryWorkbenchTenancyStore>
    ).registerPrincipal(TENANT.id, {
      id: "prn_bob",
      kind: "user",
      status: "active",
      refId: "prn_bob",
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "@bob welcome!" }],
          invite: [{ kind: "person", principalId: "prn_bob", name: "Bob" }],
        }),
      },
    );

    expect(response.status).toBe(201);

    const settingsResponse = await app.request(
      `/workbenches/${workbench.id}/settings`,
    );
    const settingsBody = (await settingsResponse.json()) as {
      participants: { address: string; handle: string }[];
    };
    expect(settingsBody.participants).toEqual([
      { address: "prn_bob", handle: "bob" },
    ]);

    const messagesResponse = await app.request(
      `/workbenches/${workbench.id}/messages`,
    );
    const messagesBody = (await messagesResponse.json()) as {
      items: { parts: Part[] }[];
    };
    expect(
      messagesBody.items.some((item) =>
        item.parts.some(
          (part) => part.kind === "text" && part.text === "@bob welcome!",
        ),
      ),
    ).toBe(true);
  });

  test("a person invite naming an unknown/inactive principal is a 400, and nothing is sent", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "@ghost welcome!" }],
          invite: [{ kind: "person", principalId: "prn_ghost" }],
        }),
      },
    );

    expect(response.status).toBe(400);
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.sentMail).toHaveLength(0);
  });

  test("a denied invite grant returns a plain 403 and sends nothing", async () => {
    const deps = buildDeps({
      // Denies exactly the workbench-scoped "create" grant the invite
      // pre-step checks — never the tenant-wide "workflow-run:*" create
      // grant `POST /workbenches` itself needs, so workbench setup below
      // still succeeds.
      requireGrant: (resource, action) => async (c, next) => {
        if (action === "create" && resource !== "workflow-run:*") {
          return c.json({ error: { code: "forbidden", message: "no" } }, 403);
        }
        await next();
      },
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "@echo welcome!" }],
          invite: [{ kind: "agent", definitionId: "wfd_echo" }],
        }),
      },
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as {
      error: { code: string; userMessage: string };
    };
    expect(body.error.userMessage).toBe(
      "You can't add people to this workbench",
    );

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.sentMail).toHaveLength(0);
    const settingsResponse = await app.request(
      `/workbenches/${workbench.id}/settings`,
    );
    const settingsBody = (await settingsResponse.json()) as {
      participants: unknown[];
    };
    expect(settingsBody.participants).toEqual([]);
  });

  test("an already-participant person invite entry is a no-op, and the message still sends", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
      participants: ["prn_bob"],
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "@bob still here" }],
          invite: [{ kind: "person", principalId: "prn_bob", name: "Bob" }],
        }),
      },
    );

    expect(response.status).toBe(201);
    const settingsResponse = await app.request(
      `/workbenches/${workbench.id}/settings`,
    );
    const settingsBody = (await settingsResponse.json()) as {
      participants: { address: string }[];
    };
    expect(settingsBody.participants.map((p) => p.address)).toEqual([
      "prn_bob",
    ]);
  });

  // CL-7194: joinHumanParticipant no longer takes a caller-supplied
  // settings snapshot — each invite in this loop now reads and writes
  // its participant record through a single atomic store call. This
  // proves that change didn't regress the loop's own accumulation: two
  // people invited in the same request both survive, not just the last.
  test("inviting multiple people in one request lands every one of them", async () => {
    const deps = buildDeps();
    (
      deps.tenancy as ReturnType<typeof createInMemoryWorkbenchTenancyStore>
    ).registerPrincipal(TENANT.id, {
      id: "prn_bob",
      kind: "user",
      status: "active",
      refId: "prn_bob",
    });
    (
      deps.tenancy as ReturnType<typeof createInMemoryWorkbenchTenancyStore>
    ).registerPrincipal(TENANT.id, {
      id: "prn_carol",
      kind: "user",
      status: "active",
      refId: "prn_carol",
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Test Workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "welcome both!" }],
          invite: [
            { kind: "person", principalId: "prn_bob", name: "Bob" },
            { kind: "person", principalId: "prn_carol", name: "Carol" },
          ],
        }),
      },
    );

    expect(response.status).toBe(201);
    const settingsResponse = await app.request(
      `/workbenches/${workbench.id}/settings`,
    );
    const settingsBody = (await settingsResponse.json()) as {
      participants: { address: string }[];
    };
    expect(settingsBody.participants.map((p) => p.address).sort()).toEqual([
      "prn_bob",
      "prn_carol",
    ]);
  });
});

describe("GET /workbenches/:id/blobs/:blobId", () => {
  test("returns the platform's blob bytes base64-encoded", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        fetchBlob: async () => "hello attachment",
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/blobs/blob_mail1_1`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { contentBase64: string };
    expect(Buffer.from(body.contentBase64, "base64").toString("utf-8")).toBe(
      "hello attachment",
    );
  });

  test("404s for a workbench outside the tenant", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(
      "/workbenches/no-such-workbench/blobs/x",
    );

    expect(response.status).toBe(404);
  });

  test("404s when the platform can't resolve the blob", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        fetchBlob: async () => {
          throw new Error("no such blob");
        },
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/blobs/blob_missing_1`,
    );

    expect(response.status).toBe(404);
  });
});

describe("threads — root feed vs reply membership (4a)", () => {
  test("root-thread messages exclude reply-thread posts; open reply still works", async () => {
    const deps = buildDeps({ threads: createInMemoryThreadStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const rootPost = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ kind: "text", text: "root note" }] }),
      },
    );
    expect(rootPost.status).toBe(201);
    const rootSent = (await rootPost.json()) as {
      id: string;
      threadId: string;
    };

    const replyPost = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "reply note" }],
          inReplyToMessageId: rootSent.id,
        }),
      },
    );
    expect(replyPost.status).toBe(201);
    const replySent = (await replyPost.json()) as {
      id: string;
      threadId: string;
    };
    expect(replySent.threadId).not.toBe(rootSent.threadId);

    // Full mailbox still lists both (platform mail is unfiltered).
    const allMail = await app.request(`/workbenches/${workbench.id}/messages`);
    const allBody = (await allMail.json()) as { items: { id: string }[] };
    expect(allBody.items.map((i) => i.id).sort()).toEqual(
      [rootSent.id, replySent.id].sort(),
    );

    // Root-thread feed is root membership only.
    const rootFeed = await app.request(
      `/workbenches/${workbench.id}/threads/${rootSent.threadId}/messages`,
    );
    expect(rootFeed.status).toBe(200);
    const rootBody = (await rootFeed.json()) as {
      items: { id: string; parts: Part[] }[];
    };
    expect(rootBody.items.map((i) => i.id)).toEqual([rootSent.id]);
    expect(rootBody.items[0]?.parts).toEqual([
      { kind: "text", text: "root note" },
    ]);

    // Open-thread view still returns reply-thread membership.
    const replyFeed = await app.request(
      `/workbenches/${workbench.id}/threads/${replySent.threadId}/messages`,
    );
    expect(replyFeed.status).toBe(200);
    const replyBody = (await replyFeed.json()) as {
      items: { id: string; parts: Part[] }[];
    };
    expect(replyBody.items.map((i) => i.id)).toEqual([replySent.id]);
    expect(replyBody.items[0]?.parts).toEqual([
      { kind: "text", text: "reply note" },
    ]);

    // listThreads exposes rootThreadId for the client root feed.
    const threadsRes = await app.request(
      `/workbenches/${workbench.id}/threads`,
    );
    expect(threadsRes.status).toBe(200);
    const threadsBody = (await threadsRes.json()) as {
      rootThreadId: string;
      items: { id: string; kind: string }[];
    };
    expect(threadsBody.rootThreadId).toBe(rootSent.threadId);
    expect(
      threadsBody.items.some(
        (t) => t.id === replySent.threadId && t.kind === "reply",
      ),
    ).toBe(true);
  });

  // CL-6080: the root thread IS the workbench feed, so a message that
  // carries no thread membership belongs to it — the contract
  // `workbench_thread_messages` states ("root feed by default"). Every
  // agent-originated message reaches the workbench through
  // `postRoomMessage` alone (`chat-orchestrator`'s `postReply` for a
  // `connector.reply` event, its approve-block and
  // finalized-turn-artifact posters, `workbench-service`'s join/leave
  // notices): none of them go through `POST /messages`, the only
  // caller that assigns membership. Listing the root feed by
  // membership rows alone therefore hid every one of them — a fresh
  // chat's very first agent reply included, which is what the browser
  // walkthrough sees as silence after "hi".
  test("a reply posted straight onto the timeline, never through POST /messages, still lands in the root feed", async () => {
    const deps = buildDeps({ threads: createInMemoryThreadStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const asked = await sendText(app, workbench.id, "hi");
    expect(asked.status).toBe(201);
    const askedSent = (await asked.json()) as {
      id: string;
      threadId: string;
    };

    const replied = await postRoomMessage(
      { roomMessages: deps.roomMessages, publish: () => undefined },
      {
        tenantId: TENANT.id,
        workbenchId: workbench.id,
        sender: { name: null, address: "run_agent1@acme.example" },
        runId: "run_agent1",
        parts: [{ kind: "text", text: "hello back" }],
      },
    );

    const rootFeed = await app.request(
      `/workbenches/${workbench.id}/threads/${askedSent.threadId}/messages`,
    );
    expect(rootFeed.status).toBe(200);
    const rootBody = (await rootFeed.json()) as {
      items: { id: string; parts: Part[] }[];
    };
    expect(rootBody.items.map((i) => i.id).sort()).toEqual(
      [askedSent.id, replied.id].sort(),
    );
    expect(rootBody.items.find((i) => i.id === replied.id)?.parts).toEqual([
      { kind: "text", text: "hello back" },
    ]);
  });

  test("an unassigned message stays out of a reply thread's own feed", async () => {
    const deps = buildDeps({ threads: createInMemoryThreadStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const asked = await sendText(app, workbench.id, "hi");
    const askedSent = (await asked.json()) as { id: string };
    const inThread = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "in the thread" }],
          inReplyToMessageId: askedSent.id,
        }),
      },
    );
    const threadSent = (await inThread.json()) as {
      id: string;
      threadId: string;
    };

    await postRoomMessage(
      { roomMessages: deps.roomMessages, publish: () => undefined },
      {
        tenantId: TENANT.id,
        workbenchId: workbench.id,
        sender: { name: null, address: "run_agent1@acme.example" },
        runId: "run_agent1",
        parts: [{ kind: "text", text: "workbench-level reply" }],
      },
    );

    const replyFeed = await app.request(
      `/workbenches/${workbench.id}/threads/${threadSent.threadId}/messages`,
    );
    const replyBody = (await replyFeed.json()) as { items: { id: string }[] };
    expect(replyBody.items.map((i) => i.id)).toEqual([threadSent.id]);
  });
});

describe("POST /workbenches/:id/threads/fork — two-level cap (CL-5908, CL-5948)", () => {
  test("forking a message inside a thread opens a depth-2 sub-thread, carrying the origin message id", async () => {
    const deps = buildDeps({ threads: createInMemoryThreadStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const rootPost = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ kind: "text", text: "root note" }] }),
      },
    );
    const rootSent = (await rootPost.json()) as { id: string };

    const replyPost = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "in the thread" }],
          inReplyToMessageId: rootSent.id,
        }),
      },
    );
    const replySent = (await replyPost.json()) as {
      id: string;
      threadId: string;
    };

    const forkRes = await app.request(
      `/workbenches/${workbench.id}/threads/fork`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentMessageId: replySent.id }),
      },
    );
    expect(forkRes.status).toBe(201);
    const forked = (await forkRes.json()) as {
      id: string;
      kind: string;
      parentMessageId: string;
      parentThreadId: string;
    };
    expect(forked.kind).toBe("reply");
    expect(forked.parentMessageId).toBe(replySent.id);
    expect(forked.parentThreadId).toBe(replySent.threadId);
  });

  test("forking a message already inside a sub-thread creates a sibling under the same parent, never a third level", async () => {
    const deps = buildDeps({ threads: createInMemoryThreadStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const rootSent = (await (
      await app.request(`/workbenches/${workbench.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ kind: "text", text: "root" }] }),
      })
    ).json()) as { id: string };

    const threadSent = (await (
      await app.request(`/workbenches/${workbench.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "in thread" }],
          inReplyToMessageId: rootSent.id,
        }),
      })
    ).json()) as { id: string; threadId: string };

    const subThreadFork = (await (
      await app.request(`/workbenches/${workbench.id}/threads/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentMessageId: threadSent.id }),
      })
    ).json()) as { id: string; parentThreadId: string };

    // Post a message into the sub-thread, then fork *that* message.
    const subMessageSent = (await (
      await app.request(`/workbenches/${workbench.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "inside the sub-thread" }],
          threadId: subThreadFork.id,
        }),
      })
    ).json()) as { id: string };

    const siblingRes = await app.request(
      `/workbenches/${workbench.id}/threads/fork`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentMessageId: subMessageSent.id }),
      },
    );
    expect(siblingRes.status).toBe(201);
    const sibling = (await siblingRes.json()) as {
      id: string;
      parentThreadId: string;
    };
    expect(sibling.id).not.toBe(subThreadFork.id);
    // Sibling hangs off the same depth-1 parent as the sub-thread it was
    // forked from — never a third level.
    expect(sibling.parentThreadId).toBe(subThreadFork.parentThreadId);
    expect(sibling.parentThreadId).toBe(threadSent.threadId);
  });

  test("replying (not forking) to a message already in a sub-thread is an honest 409, not silent third-level nesting", async () => {
    const deps = buildDeps({ threads: createInMemoryThreadStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const rootSent = (await (
      await app.request(`/workbenches/${workbench.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ kind: "text", text: "root" }] }),
      })
    ).json()) as { id: string };

    const threadSent = (await (
      await app.request(`/workbenches/${workbench.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "in thread" }],
          inReplyToMessageId: rootSent.id,
        }),
      })
    ).json()) as { id: string };

    const subThreadFork = (await (
      await app.request(`/workbenches/${workbench.id}/threads/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentMessageId: threadSent.id }),
      })
    ).json()) as { id: string };

    const subMessageSent = (await (
      await app.request(`/workbenches/${workbench.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "inside the sub-thread" }],
          threadId: subThreadFork.id,
        }),
      })
    ).json()) as { id: string };

    const blockedRes = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "trying a third level" }],
          inReplyToMessageId: subMessageSent.id,
        }),
      },
    );
    expect(blockedRes.status).toBe(409);
    const blockedBody = (await blockedRes.json()) as {
      error: { code: string };
    };
    expect(blockedBody.error.code).toBe("conflict");
  });
});

describe("PATCH /workbenches/:id/settings — route surface", () => {
  test("a missing workbench is a 404", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/workbenches/ins_missing/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/pinned": true }),
    });

    expect(response.status).toBe(404);
  });
});

describe("read-state", () => {
  test("is per-caller: two principals see independent cursors", async () => {
    const deps = buildDeps();
    const app = createChatRoutes(deps);
    const appAlice = mountAs(app, "prn_alice");
    const appBob = mountAs(app, "prn_bob");
    const { body: workbench } = await createWorkbench(appAlice, {
      kind: "workbench",
    });

    await appAlice.request(`/workbenches/${workbench.id}/read-state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lastSeenCreatedAt: "2026-01-01T00:00:00.000Z",
        lastSeenId: "mail_alice",
      }),
    });
    await appBob.request(`/workbenches/${workbench.id}/read-state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lastSeenCreatedAt: "2026-02-02T00:00:00.000Z",
        lastSeenId: "mail_bob",
      }),
    });

    const aliceRead = (await (
      await appAlice.request(`/workbenches/${workbench.id}/read-state`)
    ).json()) as { lastSeenId: string };
    const bobRead = (await (
      await appBob.request(`/workbenches/${workbench.id}/read-state`)
    ).json()) as { lastSeenId: string };

    expect(aliceRead.lastSeenId).toBe("mail_alice");
    expect(bobRead.lastSeenId).toBe("mail_bob");
  });
});

describe("GET /workbenches/:id/invitable", () => {
  test("lists the platform's invitable definitions", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "echo" }],
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/invitable`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { id: string; name: string }[];
    };
    expect(body.items).toEqual([{ id: "wfd_echo", name: "echo" }]);
  });

  // CL-6649: a definition already invited into the room isn't invitable
  // again — the dialog must never re-offer someone already present.
  test("excludes a definition whose agent is already a participant", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [
          { id: "wfd_echo", name: "echo" },
          { id: "wfd_myra", name: "assistant", description: "Myra" },
        ],
        resolveDefinitionIdByAddress: async (address) =>
          address === "ins_invited1@acme.example" ? "wfd_echo" : undefined,
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });
    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/invitable`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { id: string; name: string; description?: string }[];
    };
    expect(body.items).toEqual([
      { id: "wfd_myra", name: "assistant", description: "Myra" },
    ]);
  });

  test("a denied grant is rejected", async () => {
    const deps = buildDeps({
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/workbenches/ins_x/invitable`);
    expect(response.status).toBe(403);
  });

  test("a nonexistent workbench 404s", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "echo" }],
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/workbenches/ins_missing/invitable`);
    expect(response.status).toBe(404);
  });
});

describe("GET /invitable-definitions", () => {
  test("lists the tenant's invitable definitions with no workbench required", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "echo" }],
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/invitable-definitions`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { id: string; name: string }[];
    };
    expect(body.items).toEqual([{ id: "wfd_echo", name: "echo" }]);
  });

  test("the host's isInvitableDefinition predicate prunes automations", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [
          { id: "wfd_assistant", name: "assistant", description: "Myra" },
          { id: "wfd_digest", name: "workbench-digest" },
        ],
      }),
      isInvitableDefinition: (definition) =>
        definition.name !== "workbench-digest",
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/invitable-definitions`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { id: string; name: string; description?: string }[];
    };
    expect(body.items).toEqual([
      { id: "wfd_assistant", name: "assistant", description: "Myra" },
    ]);
  });

  test("a denied grant is rejected", async () => {
    const deps = buildDeps({
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/invitable-definitions`);
    expect(response.status).toBe(403);
  });
});

describe("typing", () => {
  test("is never persisted", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(`/workbenches/${workbench.id}/typing`, {
      method: "POST",
    });

    expect(response.status).toBe(202);
    const settingsRow = await deps.store.getWorkbenchSettings(
      TENANT.id,
      workbench.id,
    );
    expect(settingsRow?.settings).not.toHaveProperty("chat/typing");
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.sentMail).toHaveLength(0);
  });
});

describe("workbench tenancy", () => {
  test("creating a workbench mints a child tenant parented under the bench", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const { body } = await createWorkbench(app, {
      kind: "workbench",
      name: "General",
    });

    const view = body as unknown as {
      tenancy: { tenantId: string; parentTenantId: string; slug: string };
      legacy: boolean;
    };
    expect(view.legacy).toBe(false);
    expect(view.tenancy.parentTenantId).toBe(TENANT.id);
    expect(view.tenancy.tenantId).toMatch(/^tnt_/);

    const link = await deps.tenancy.getWorkbenchTenancy(body.id);
    expect(link?.tenantId).toBe(view.tenancy.tenantId);
    expect(link?.parentTenantId).toBe(TENANT.id);
  });

  test("a compensation failure after a launch failure still surfaces the original launch error, never the compensation's", async () => {
    const tenancy = createInMemoryWorkbenchTenancyStore();
    const uncompensatableTenancy = {
      ...tenancy,
      async compensateWorkbenchTenant(): Promise<void> {
        throw new Error("compensation storage unavailable");
      },
    };
    const platform = fakePlatform({
      launchInvite: async () => {
        throw new Error("agent launch failed");
      },
    });
    const deps = buildDeps({ tenancy: uncompensatableTenancy, platform });
    const routes = createChatRoutes(deps);
    // Hono's default error handling swallows a thrown error into a
    // generic 500 body, which is useless for telling "the original
    // error propagated" apart from "the compensation error masked it"
    // — both look identical over HTTP. `onError` intercepts the actual
    // thrown value before Hono discards it, so the assertion below
    // can inspect the real error rather than its flattened response.
    let caught: unknown;
    routes.onError((err) => {
      caught = err;
      return new Response(null, { status: 500 });
    });
    const app = mountAs(routes, "prn_alice");

    // Both the launch and its compensation fail. The double failure
    // must never produce a silently swallowed error: the route
    // re-throws the ORIGINAL launch error, not the compensation
    // failure that masked it in the bug this test guards against.
    const response = await app.request("/workbenches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "chat", definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(500);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("agent launch failed");

    // The tenant this mint created is now an orphan the compensation
    // could not clean up — that is the accepted, loudly-logged
    // consequence of a double failure, not something this test can
    // observe through the in-memory store (which has no "orphaned
    // tenants" ledger), but the workbench itself must never have been
    // recorded as ready to use.
  });

  test("GET /workbenches annotates every created workbench with its tenancy and marks a linkless row legacy", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: created } = await createWorkbench(app, {
      kind: "workbench",
      name: "Tenanted",
    });

    // Simulates a workbench that predates the tenancy rollout: a
    // workbench_settings row with no workbench_tenancy link.
    await deps.store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: "ins_legacy",
      settings: { "chat/kind": "workbench", "chat/name": "Legacy" },
      updatedBy: "prn_alice",
    });

    const response = await app.request("/workbenches");
    const body = (await response.json()) as {
      items: {
        id: string;
        legacy: boolean;
        tenancy: { tenantId: string } | null;
      }[];
    };

    const tenantedRow = body.items.find((item) => item.id === created.id);
    expect(tenantedRow?.legacy).toBe(false);
    expect(tenantedRow?.tenancy).not.toBeNull();

    const legacyRow = body.items.find((item) => item.id === "ins_legacy");
    expect(legacyRow?.legacy).toBe(true);
    expect(legacyRow?.tenancy).toBeNull();
  });

  test("POST /workbenches/:id/move re-parents the workbench's tenancy when the caller manages the destination", async () => {
    const tenancy = createInMemoryWorkbenchTenancyStore();
    tenancy.registerExistingTenant("tnt_new_bench");
    tenancy.grantManageInTenant("prn_alice", "tnt_new_bench");
    const deps = buildDeps({ tenancy });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Movable",
    });

    const response = await app.request(`/workbenches/${workbench.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newParentTenantId: "tnt_new_bench" }),
    });

    expect(response.status).toBe(200);
    const moved = (await response.json()) as {
      tenancy: { parentTenantId: string };
    };
    expect(moved.tenancy.parentTenantId).toBe("tnt_new_bench");

    const link = await deps.tenancy.getWorkbenchTenancy(workbench.id);
    expect(link?.parentTenantId).toBe("tnt_new_bench");
  });

  test("GET /workbenches still reports a moved workbench's current tenancy from the bench it was created in", async () => {
    // A workbench's workbench_settings row stays keyed to the bench it was
    // created in forever — a move only ever changes the tenancy link's
    // parent, never that row. The regression this guards against: GET
    // /workbenches used to look up tenancy links by "children of this
    // bench", which goes stale the moment a workbench moves elsewhere,
    // so the creating bench reported the moved workbench as `legacy`
    // with a null tenancy instead of its real, current parent.
    const tenancy = createInMemoryWorkbenchTenancyStore();
    tenancy.registerExistingTenant("tnt_new_bench");
    tenancy.grantManageInTenant("prn_alice", "tnt_new_bench");
    const deps = buildDeps({ tenancy });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Movable",
    });

    const moveResponse = await app.request(
      `/workbenches/${workbench.id}/move`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newParentTenantId: "tnt_new_bench" }),
      },
    );
    expect(moveResponse.status).toBe(200);

    const listResponse = await app.request("/workbenches");
    const body = (await listResponse.json()) as {
      items: {
        id: string;
        legacy: boolean;
        tenancy: { parentTenantId: string } | null;
      }[];
    };
    const row = body.items.find((item) => item.id === workbench.id);
    expect(row?.legacy).toBe(false);
    expect(row?.tenancy?.parentTenantId).toBe("tnt_new_bench");
  });

  test("POST /workbenches/:id/move is refused when the destination tenant does not exist", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Movable",
    });

    const response = await app.request(`/workbenches/${workbench.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newParentTenantId: "tnt_does_not_exist" }),
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");

    const link = await deps.tenancy.getWorkbenchTenancy(workbench.id);
    expect(link?.parentTenantId).toBe(TENANT.id);
  });

  test("POST /workbenches/:id/move is refused when the caller has no standing in a real destination tenant", async () => {
    const tenancy = createInMemoryWorkbenchTenancyStore();
    tenancy.registerExistingTenant("tnt_someone_elses_bench");
    const deps = buildDeps({ tenancy });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Movable",
    });

    const response = await app.request(`/workbenches/${workbench.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newParentTenantId: "tnt_someone_elses_bench" }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");

    const link = await deps.tenancy.getWorkbenchTenancy(workbench.id);
    expect(link?.parentTenantId).toBe(TENANT.id);
  });

  test("POST /workbenches/:id/move is refused when the destination would make the workbench its own ancestor", async () => {
    const tenancy = createInMemoryWorkbenchTenancyStore();
    const deps = buildDeps({ tenancy });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Movable",
    });
    const link = await deps.tenancy.getWorkbenchTenancy(workbench.id);
    if (link === undefined) throw new Error("expected a tenancy link");
    // The caller manages its own workbench's tenant (seeded as owner at
    // creation) — proving this rejection is structural, not
    // authorization: full grants and it is still refused.
    tenancy.grantManageInTenant("prn_alice", link.tenantId);

    const response = await app.request(`/workbenches/${workbench.id}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newParentTenantId: link.tenantId }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("conflict");

    const unchanged = await deps.tenancy.getWorkbenchTenancy(workbench.id);
    expect(unchanged?.parentTenantId).toBe(TENANT.id);
  });

  test("POST /workbenches/:id/move on a legacy workbench is a loud 409, never a silent no-op", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    await deps.store.createWorkbenchSettings({
      tenantId: TENANT.id,
      workbenchId: "ins_legacy",
      settings: { "chat/kind": "workbench" },
      updatedBy: "prn_alice",
    });

    const response = await app.request(`/workbenches/ins_legacy/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newParentTenantId: "tnt_new_bench" }),
    });

    expect(response.status).toBe(409);
  });

  test("a bench never sees another bench's workbench tenancies", async () => {
    const OTHER_TENANT = { ...TENANT, id: "tnt_2", domain: "other.example" };
    const store = createInMemoryChatStore();
    const tenancy = createInMemoryWorkbenchTenancyStore();
    const deps = buildDeps({ store, tenancy });
    const routes = createChatRoutes(deps);

    const appBenchA = mountAs(routes, "prn_alice");
    await createWorkbench(appBenchA, {
      kind: "workbench",
      name: "Bench A Only",
    });

    const appBenchB = new Hono<TenantEnv>();
    appBenchB.use("*", async (c, next) => {
      c.set("tenant", OTHER_TENANT);
      c.set("principal", principal("prn_bob"));
      await next();
    });
    appBenchB.route("/", routes);
    const { body: benchBWorkbench } = await createWorkbench(appBenchB, {
      kind: "workbench",
      name: "Bench B Only",
    });

    const listA = (await (await appBenchA.request("/workbenches")).json()) as {
      items: { id: string; title: string }[];
    };
    expect(listA.items.map((item) => item.title)).toEqual(["Bench A Only"]);
    expect(listA.items.map((item) => item.id)).not.toContain(
      benchBWorkbench.id,
    );

    const listB = (await (await appBenchB.request("/workbenches")).json()) as {
      items: { id: string; title: string }[];
    };
    expect(listB.items.map((item) => item.title)).toEqual(["Bench B Only"]);

    const tenancyA = await tenancy.listChildWorkbenchTenancies(TENANT.id);
    const tenancyB = await tenancy.listChildWorkbenchTenancies(OTHER_TENANT.id);
    expect(tenancyA).toHaveLength(1);
    expect(tenancyB).toHaveLength(1);
    expect(tenancyA[0]?.tenantId).not.toBe(tenancyB[0]?.tenantId);
  });
});

describe("cross-tenant workbench isolation", () => {
  function mountTenant(
    routes: ReturnType<typeof createChatRoutes>,
    tenant: typeof TENANT,
    principalId: string,
  ) {
    const app = new Hono<TenantEnv>();
    app.use("*", async (c, next) => {
      c.set("tenant", tenant);
      c.set("principal", principal(principalId));
      await next();
    });
    app.route("/", routes);
    return app;
  }

  test("POST/GET messages reject a workbench owned by another tenant", async () => {
    const OTHER_TENANT = { ...TENANT, id: "tnt_2", domain: "other.example" };
    const deps = buildDeps();
    const routes = createChatRoutes(deps);
    const appA = mountTenant(routes, TENANT, "prn_alice");
    const appB = mountTenant(routes, OTHER_TENANT, "prn_bob");

    const { body: workbench } = await createWorkbench(appA, {
      kind: "workbench",
    });

    const postB = await appB.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "cross-tenant write" }],
      }),
    });
    expect(postB.status).toBe(404);
    expect(
      (deps.platform as ReturnType<typeof fakePlatform>).sentMail,
    ).toHaveLength(0);

    const getB = await appB.request(`/workbenches/${workbench.id}/messages`);
    expect(getB.status).toBe(404);
  });

  test("typing and stream reject a workbench owned by another tenant", async () => {
    const OTHER_TENANT = { ...TENANT, id: "tnt_2", domain: "other.example" };
    const deps = buildDeps();
    const routes = createChatRoutes(deps);
    const appA = mountTenant(routes, TENANT, "prn_alice");
    const appB = mountTenant(routes, OTHER_TENANT, "prn_bob");

    const { body: workbench } = await createWorkbench(appA, {
      kind: "workbench",
    });

    const typing = await appB.request(`/workbenches/${workbench.id}/typing`, {
      method: "POST",
    });
    expect(typing.status).toBe(404);

    const stream = await appB.request(`/workbenches/${workbench.id}/stream`);
    expect(stream.status).toBe(404);
  });

  test("read-state and invitable reject a workbench owned by another tenant", async () => {
    const OTHER_TENANT = { ...TENANT, id: "tnt_2", domain: "other.example" };
    const deps = buildDeps();
    const routes = createChatRoutes(deps);
    const appA = mountTenant(routes, TENANT, "prn_alice");
    const appB = mountTenant(routes, OTHER_TENANT, "prn_bob");

    const { body: workbench } = await createWorkbench(appA, {
      kind: "workbench",
    });

    const readGet = await appB.request(
      `/workbenches/${workbench.id}/read-state`,
    );
    expect(readGet.status).toBe(404);

    const readPut = await appB.request(
      `/workbenches/${workbench.id}/read-state`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lastSeenCreatedAt: "2026-01-01T00:00:00.000Z",
          lastSeenId: "mail_x",
        }),
      },
    );
    expect(readPut.status).toBe(404);

    const invitable = await appB.request(
      `/workbenches/${workbench.id}/invitable`,
    );
    expect(invitable.status).toBe(404);
  });

  test("GET messages allows a launched agent instance in the same tenant", async () => {
    // Agent mailboxes are instance ids with a workbench_launch row, not a
    // workbench_settings row. The tenancy gate must accept those so the
    // e2e "invite agent → list its messages" path keeps working.
    const baseStore = createInMemoryChatStore();
    const launchedKeys = new Set<string>();
    const gatedStore = {
      ...baseStore,
      hasLaunchedInstance: async (tenantId: string, instanceId: string) =>
        launchedKeys.has(`${tenantId}:${instanceId}`) ||
        baseStore.hasLaunchedInstance(tenantId, instanceId),
    };
    const deps = buildDeps({ store: gatedStore });
    const routes = createChatRoutes(deps);
    const app = mountTenant(routes, TENANT, "prn_alice");

    launchedKeys.add(`${TENANT.id}:ins_agent_mailbox`);
    const res = await app.request(`/workbenches/ins_agent_mailbox/messages`);
    expect(res.status).toBe(200);

    // Foreign tenant still 404s even with the same instance id shape.
    const other = mountTenant(
      routes,
      { ...TENANT, id: "tnt_2", domain: "other.example" },
      "prn_bob",
    );
    const denied = await other.request(
      `/workbenches/ins_agent_mailbox/messages`,
    );
    expect(denied.status).toBe(404);
  });
});

// CL-6313: thread membership is a property of a message, not a function
// of which endpoint the client called. `GET /messages` already loads the
// whole mailbox and already resolves assignments to filter the per-thread
// feed — stamping the resolved id on every item lets one client query
// serve the root feed, every open thread, and reply counts, instead of a
// refresh fanning out one request per thread.
describe("GET /workbenches/:id/messages — thread membership on every item (CL-6313)", () => {
  test("stamps the resolved threadId on each message, defaulting to the root thread", async () => {
    const deps = buildDeps({ threads: createInMemoryThreadStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const rootPost = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ kind: "text", text: "root note" }] }),
      },
    );
    const rootSent = (await rootPost.json()) as {
      id: string;
      threadId: string;
    };

    const replyPost = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "reply note" }],
          inReplyToMessageId: rootSent.id,
        }),
      },
    );
    const replySent = (await replyPost.json()) as {
      id: string;
      threadId: string;
    };

    // A message posted straight onto the timeline (an agent reply)
    // carries no membership row at all — it belongs to the root feed by
    // default, and must be stamped as such rather than left absent.
    const agentSent = await postRoomMessage(
      { roomMessages: deps.roomMessages, publish: () => undefined },
      {
        tenantId: TENANT.id,
        workbenchId: workbench.id,
        sender: { name: null, address: "run_agent1@acme.example" },
        runId: "run_agent1",
        parts: [{ kind: "text", text: "agent reply" }],
      },
    );

    const res = await app.request(`/workbenches/${workbench.id}/messages`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { id: string; threadId: string }[];
    };
    const threadIdById = new Map(body.items.map((i) => [i.id, i.threadId]));
    expect(threadIdById.get(rootSent.id)).toBe(rootSent.threadId);
    expect(threadIdById.get(replySent.id)).toBe(replySent.threadId);
    expect(threadIdById.get(agentSent.id)).toBe(rootSent.threadId);
  });

  test("threadId is present even when the host mounts no thread store", async () => {
    const deps = buildDeps({});
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });
    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "hi" }] }),
    });

    const res = await app.request(`/workbenches/${workbench.id}/messages`);
    const body = (await res.json()) as {
      items: { threadId?: string }[];
    };
    // No thread store means no threads at all — the field is absent
    // rather than a fabricated id, matching `GET /threads`' own
    // `rootThreadId: ""` shape for that deployment.
    expect(body.items[0]?.threadId).toBeUndefined();
  });
});

describe("GET /workbenches/:id/threads — reply activity on each row (CL-6313)", () => {
  test("carries replyCount and lastActivityAt so the client never fans out per thread", async () => {
    const deps = buildDeps({ threads: createInMemoryThreadStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const rootPost = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ kind: "text", text: "parent" }] }),
      },
    );
    const rootSent = (await rootPost.json()) as {
      id: string;
      threadId: string;
    };

    const firstReply = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "one" }],
          inReplyToMessageId: rootSent.id,
        }),
      },
    );
    const replySent = (await firstReply.json()) as {
      id: string;
      threadId: string;
    };
    const secondReply = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "two" }],
          threadId: replySent.threadId,
        }),
      },
    );
    const lastSent = (await secondReply.json()) as { createdAt: string };

    const res = await app.request(`/workbenches/${workbench.id}/threads`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rootThreadId: string;
      items: {
        id: string;
        replyCount: number;
        lastActivityAt: string | null;
      }[];
    };
    const reply = body.items.find((t) => t.id === replySent.threadId);
    expect(reply?.replyCount).toBe(2);
    expect(reply?.lastActivityAt).toBe(lastSent.createdAt);
  });

  test("a thread with no messages yet reports zero replies and no activity", async () => {
    const deps = buildDeps({ threads: createInMemoryThreadStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });
    const rootPost = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: [{ kind: "text", text: "parent" }] }),
      },
    );
    const rootSent = (await rootPost.json()) as { id: string };

    const forked = await app.request(
      `/workbenches/${workbench.id}/threads/fork`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentMessageId: rootSent.id }),
      },
    );
    const thread = (await forked.json()) as { id: string };

    const res = await app.request(`/workbenches/${workbench.id}/threads`);
    const body = (await res.json()) as {
      items: {
        id: string;
        replyCount: number;
        lastActivityAt: string | null;
      }[];
    };
    const row = body.items.find((t) => t.id === thread.id);
    expect(row?.replyCount).toBe(0);
    expect(row?.lastActivityAt).toBeNull();
  });
});
