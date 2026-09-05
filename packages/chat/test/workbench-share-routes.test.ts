// HTTP-level tests for shared-workbench projection (CL-5882): a workbench
// owned by one tenant projected into another, gated by bilateral
// federation trust and per-tenant explicit membership. Built the same
// way `workbench-subscribers-wiring.test.ts` and `routes.test.ts` build a
// real `createChatRoutes` app over in-memory deps — `mountAsTenant`
// below is `test-support.ts`'s `mountAs` generalized to more than one
// fixed tenant, since this feature is inherently multi-tenant.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { TenantEnv } from "@intx/hub-api";

import { createChatRoutes } from "../src/routes";
import { createInMemoryWorkbenchShareStore } from "../src/workbench-share";
import { createInMemoryFederationTrustStore } from "../src/federation-trust";
import { createWorkbenchSubscriberRegistry } from "../src/workbench-events";
import { createInMemoryBlockResponseStore } from "../src/block-responses";
import { createInMemoryReactionStore } from "../src/reactions";
import { createInMemoryPinStore } from "../src/pins";
import {
  buildDeps,
  createWorkbench,
  principal,
  sendText,
  TENANT,
} from "./test-support";

const TENANT_B = {
  id: "tnt_2",
  name: "Beta Co",
  slug: "beta",
  domain: "beta.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const TENANT_C = {
  id: "tnt_3",
  name: "Charlie Co",
  slug: "charlie",
  domain: "charlie.example",
  parentId: null,
  config: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function mountAsTenant(
  routes: Hono<TenantEnv>,
  tenant: typeof TENANT,
  principalId: string,
): Hono<TenantEnv> {
  const asPrincipal: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", tenant);
    c.set("principal", principal(principalId));
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asPrincipal);
  app.route("/", routes);
  return app;
}

describe("shared workbench projection", () => {
  test("creating a share without bilateral trust is a 403 and inserts no row", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    const shares = createInMemoryWorkbenchShareStore({ trust });
    const deps = buildDeps({ shares, trust });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");

    const { body: workbench } = await createWorkbench(owner, {
      kind: "workbench",
    });

    const response = await owner.request(
      `/workbenches/${workbench.id}/shares`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
      },
    );

    expect(response.status).toBe(403);
    expect(await shares.getShare(workbench.id, TENANT_B.id)).toBeUndefined();
  });

  test("bilateral trust then create is 201; one-directional trust still 403s", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    trust.registerTenant(TENANT_C.id, TENANT_C.name);
    const shares = createInMemoryWorkbenchShareStore({ trust });
    const deps = buildDeps({ shares, trust });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");

    const { body: workbench } = await createWorkbench(owner, {
      kind: "workbench",
    });

    await trust.establishBilateralTrust(TENANT.id, TENANT_B.id);
    trust.seedDirectionalTrust(TENANT.id, TENANT_C.id, "outbound");

    const okResponse = await owner.request(
      `/workbenches/${workbench.id}/shares`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
      },
    );
    expect(okResponse.status).toBe(201);

    const oneWayResponse = await owner.request(
      `/workbenches/${workbench.id}/shares`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectedTenantId: TENANT_C.id }),
      },
    );
    expect(oneWayResponse.status).toBe(403);
  });

  test("the projected tenant's workbench list is empty until a member row exists, then shows a sharedLabel", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    const shares = createInMemoryWorkbenchShareStore({ trust });
    const deps = buildDeps({ shares, trust });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");
    const memberSide = mountAsTenant(routes, TENANT_B, "prn_bob");

    const { body: workbench } = await createWorkbench(owner, {
      kind: "workbench",
    });
    await trust.establishBilateralTrust(TENANT.id, TENANT_B.id);
    await owner.request(`/workbenches/${workbench.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
    });

    const beforeMember = await (
      await memberSide.request("/workbenches?kind=workbench")
    ).json();
    expect(
      (beforeMember as { items: unknown[] }).items.some(
        (item) => (item as { id: string }).id === workbench.id,
      ),
    ).toBe(false);

    const addMemberResponse = await memberSide.request(
      `/workbenches/${workbench.id}/share-members`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ principalId: "prn_bob" }),
      },
    );
    expect(addMemberResponse.status).toBe(200);

    const afterMember = (await (
      await memberSide.request("/workbenches?kind=workbench")
    ).json()) as { items: { id: string; sharedLabel?: string }[] };
    const row = afterMember.items.find((item) => item.id === workbench.id);
    expect(row).toBeDefined();
    expect(row?.sharedLabel).toContain("shared");
  });

  test("a third tenant with no share never sees the workbench and 404s on direct message access", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    trust.registerTenant(TENANT_C.id, TENANT_C.name);
    const shares = createInMemoryWorkbenchShareStore({ trust });
    const deps = buildDeps({ shares, trust });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");
    const outsider = mountAsTenant(routes, TENANT_C, "prn_carol");

    const { body: workbench } = await createWorkbench(owner, {
      kind: "workbench",
    });
    await trust.establishBilateralTrust(TENANT.id, TENANT_B.id);
    await owner.request(`/workbenches/${workbench.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
    });

    const list = (await (
      await outsider.request("/workbenches?kind=workbench")
    ).json()) as { items: { id: string }[] };
    expect(list.items.some((item) => item.id === workbench.id)).toBe(false);

    const direct = await outsider.request(
      `/workbenches/${workbench.id}/messages`,
    );
    expect(direct.status).toBe(404);
  });

  test("SSE fan-out reaches both the owning tenant and the projected member tenant", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    const shares = createInMemoryWorkbenchShareStore({ trust });
    const workbenchSubscribers = createWorkbenchSubscriberRegistry();
    const deps = buildDeps({ shares, trust, workbenchSubscribers });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");
    const memberSide = mountAsTenant(routes, TENANT_B, "prn_bob");

    const { body: workbench } = await createWorkbench(owner, {
      kind: "workbench",
    });
    await trust.establishBilateralTrust(TENANT.id, TENANT_B.id);
    await owner.request(`/workbenches/${workbench.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
    });
    await memberSide.request(`/workbenches/${workbench.id}/share-members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "prn_bob" }),
    });

    const received: unknown[] = [];
    workbenchSubscribers.subscribe(workbench.id, (event) =>
      received.push(event),
    );

    // Both an owning-tenant caller and a projected-member-tenant caller
    // can reach the same workbench's typing route (fan-out is keyed by
    // workbenchId only — see workbench-events.ts) once resolveWorkbenchAccess
    // lets the member-tenant request past the gate at all.
    const ownerTyping = await owner.request(
      `/workbenches/${workbench.id}/typing`,
      {
        method: "POST",
      },
    );
    expect(ownerTyping.status).toBe(202);
    const memberTyping = await memberSide.request(
      `/workbenches/${workbench.id}/typing`,
      { method: "POST" },
    );
    expect(memberTyping.status).toBe(202);

    expect(received).toHaveLength(2);
  });

  test("posting from the projected tenant lands on the owning tenant's timeline with the correct sender", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    const shares = createInMemoryWorkbenchShareStore({ trust });
    const deps = buildDeps({ shares, trust });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");
    const memberSide = mountAsTenant(routes, TENANT_B, "prn_bob");

    const { body: workbench } = await createWorkbench(owner, {
      kind: "workbench",
    });
    await trust.establishBilateralTrust(TENANT.id, TENANT_B.id);
    await owner.request(`/workbenches/${workbench.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
    });
    await memberSide.request(`/workbenches/${workbench.id}/share-members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "prn_bob" }),
    });

    const sendResponse = await sendText(
      memberSide,
      workbench.id,
      "hi from beta",
    );
    expect(sendResponse.status).toBe(201);
    // The row is written under the OWNING tenant, never a copy
    // materialized under the projected one.
    const owned = await deps.roomMessages.listMessages({
      tenantId: TENANT.id,
      workbenchId: workbench.id,
    });
    expect(owned.items[0]?.senderPrincipalId).toBe("prn_bob");
    const projected = await deps.roomMessages.listMessages({
      tenantId: TENANT_B.id,
      workbenchId: workbench.id,
    });
    expect(projected.items).toEqual([]);

    const ownerMessages = (await (
      await owner.request(`/workbenches/${workbench.id}/messages`)
    ).json()) as { items: { sender: { address: string } }[] };
    expect(
      ownerMessages.items.some((item) =>
        item.sender.address.startsWith("prn_bob@"),
      ),
    ).toBe(true);
  });

  test("per-tenant membership isolation over HTTP: removing tenant B's member does not affect tenant C's", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    trust.registerTenant(TENANT_C.id, TENANT_C.name);
    const shares = createInMemoryWorkbenchShareStore({ trust });
    const deps = buildDeps({ shares, trust });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");
    const bSide = mountAsTenant(routes, TENANT_B, "prn_bob");
    const cSide = mountAsTenant(routes, TENANT_C, "prn_carol");

    const { body: workbench } = await createWorkbench(owner, {
      kind: "workbench",
    });
    await trust.establishBilateralTrust(TENANT.id, TENANT_B.id);
    await trust.establishBilateralTrust(TENANT.id, TENANT_C.id);
    await owner.request(`/workbenches/${workbench.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
    });
    await owner.request(`/workbenches/${workbench.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_C.id }),
    });
    await bSide.request(`/workbenches/${workbench.id}/share-members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "prn_bob" }),
    });
    await cSide.request(`/workbenches/${workbench.id}/share-members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "prn_carol" }),
    });

    await bSide.request(`/workbenches/${workbench.id}/share-members/prn_bob`, {
      method: "DELETE",
    });

    expect(
      await shares.isShareMember(TENANT_B.id, workbench.id, "prn_bob"),
    ).toBe(false);
    expect(
      await shares.isShareMember(TENANT_C.id, workbench.id, "prn_carol"),
    ).toBe(true);
  });

  test("revoking a share member's row is live on the real SSE stream: the next published event never reaches them", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    const shares = createInMemoryWorkbenchShareStore({ trust });
    const workbenchSubscribers = createWorkbenchSubscriberRegistry();
    const deps = buildDeps({ shares, trust, workbenchSubscribers });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");
    const memberSide = mountAsTenant(routes, TENANT_B, "prn_bob");

    const { body: workbench } = await createWorkbench(owner, {
      kind: "workbench",
    });
    await trust.establishBilateralTrust(TENANT.id, TENANT_B.id);
    await owner.request(`/workbenches/${workbench.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
    });
    await memberSide.request(`/workbenches/${workbench.id}/share-members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "prn_bob" }),
    });

    const streamResponse = await memberSide.request(
      `/workbenches/${workbench.id}/stream`,
    );
    expect(streamResponse.status).toBe(200);
    const body = streamResponse.body;
    if (body === null) throw new Error("stream has no body");
    const reader = body.getReader();
    const decoder = new TextDecoder();

    async function readChunk(timeoutMs: number): Promise<string | undefined> {
      return Promise.race([
        reader
          .read()
          .then((result) =>
            result.done ? undefined : decoder.decode(result.value),
          )
          .catch(() => undefined),
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), timeoutMs),
        ),
      ]);
    }

    // Connecting hands this stream a presence snapshot (and an "online"
    // presence delta) before anything else — see `bridgeWorkbenchStream`'s
    // `presence` option — so this reads past those rather than assuming
    // `chat.typing` is the very first chunk.
    async function readUntilContains(
      needle: string,
    ): Promise<string | undefined> {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const chunk = await readChunk(2_000);
        if (chunk === undefined) return undefined;
        if (chunk.includes(needle)) return chunk;
      }
      return undefined;
    }

    workbenchSubscribers.publish(workbench.id, {
      type: "chat.typing",
      data: { principalId: "prn_alice" },
    });
    const beforeRevocation = await readUntilContains("chat.typing");
    expect(beforeRevocation).toContain("chat.typing");

    const revoked = await memberSide.request(
      `/workbenches/${workbench.id}/share-members/prn_bob`,
      { method: "DELETE" },
    );
    expect(revoked.status).toBe(204);
    expect(
      await shares.isShareMember(TENANT_B.id, workbench.id, "prn_bob"),
    ).toBe(false);

    workbenchSubscribers.publish(workbench.id, {
      type: "chat.typing",
      data: { principalId: "prn_alice" },
    });
    const afterRevocation = await readChunk(300);
    expect(afterRevocation).toBeUndefined();

    await reader.cancel().catch(() => undefined);
  });
});

describe("shared workbench projection — block responses", () => {
  function responsesUrl(
    workbenchId: string,
    messageId: string,
    blockId: string,
  ) {
    return `/workbenches/${workbenchId}/messages/${messageId}/blocks/${blockId}/responses`;
  }

  test("a projected-tenant share member can submit a poll response and read the tally without a 404", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    const shares = createInMemoryWorkbenchShareStore({ trust });
    const blockResponses = createInMemoryBlockResponseStore();
    const deps = buildDeps({ shares, trust, blockResponses });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");
    const memberSide = mountAsTenant(routes, TENANT_B, "prn_bob");

    const { body: workbench } = await createWorkbench(owner, {
      kind: "workbench",
    });
    await trust.establishBilateralTrust(TENANT.id, TENANT_B.id);
    await owner.request(`/workbenches/${workbench.id}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
    });
    await memberSide.request(`/workbenches/${workbench.id}/share-members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "prn_bob" }),
    });

    const post = await memberSide.request(
      responsesUrl(workbench.id, "m1", "blk_poll1"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "poll", choiceIds: ["tue"] }),
      },
    );
    expect(post.status).toBe(200);

    const get = await memberSide.request(
      responsesUrl(workbench.id, "m1", "blk_poll1"),
    );
    expect(get.status).toBe(200);
    const body = (await get.json()) as {
      tally: Record<string, number>;
      total: number;
      own: unknown;
    };
    expect(body.tally).toEqual({ tue: 1 });
    expect(body.own).toEqual({ kind: "poll", choiceIds: ["tue"] });

    // The response is stored under the OWNING tenant, not the acting
    // (projected) tenant — the owner can read the very same tally back.
    const ownerGet = await owner.request(
      responsesUrl(workbench.id, "m1", "blk_poll1"),
    );
    const ownerBody = (await ownerGet.json()) as {
      tally: Record<string, number>;
    };
    expect(ownerBody.tally).toEqual({ tue: 1 });
    expect(
      await blockResponses.listBlockResponses(
        TENANT.id,
        workbench.id,
        "m1",
        "blk_poll1",
      ),
    ).toHaveLength(1);
  });

  test("a tenant with no share still 404s on both block-response routes", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_C.id, TENANT_C.name);
    const shares = createInMemoryWorkbenchShareStore({ trust });
    const blockResponses = createInMemoryBlockResponseStore();
    const deps = buildDeps({ shares, trust, blockResponses });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");
    const outsider = mountAsTenant(routes, TENANT_C, "prn_carol");

    const { body: workbench } = await createWorkbench(owner, {
      kind: "workbench",
    });

    const post = await outsider.request(
      responsesUrl(workbench.id, "m1", "blk_poll1"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "poll", choiceIds: ["tue"] }),
      },
    );
    expect(post.status).toBe(404);

    const get = await outsider.request(
      responsesUrl(workbench.id, "m1", "blk_poll1"),
    );
    expect(get.status).toBe(404);
  });
});

describe("shared workbench projection — reactions and pins", () => {
  function toggleUrl(workbenchId: string, messageId: string) {
    return `/workbenches/${workbenchId}/messages/${messageId}/reactions/toggle`;
  }

  function pinUrl(workbenchId: string, messageId: string) {
    return `/workbenches/${workbenchId}/messages/${messageId}/pin`;
  }

  async function establishShare(
    trust: ReturnType<typeof createInMemoryFederationTrustStore>,
    owner: Hono<TenantEnv>,
    memberSide: Hono<TenantEnv>,
    workbenchId: string,
    memberPrincipalId: string,
  ) {
    await trust.establishBilateralTrust(TENANT.id, TENANT_B.id);
    await owner.request(`/workbenches/${workbenchId}/shares`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectedTenantId: TENANT_B.id }),
    });
    await memberSide.request(`/workbenches/${workbenchId}/share-members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: memberPrincipalId }),
    });
  }

  test("a projected-tenant share member can toggle a reaction and pin a message without a 404", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_B.id, TENANT_B.name);
    const shares = createInMemoryWorkbenchShareStore({ trust });
    const reactions = createInMemoryReactionStore();
    const pins = createInMemoryPinStore();
    const deps = buildDeps({ shares, trust, reactions, pins });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");
    const memberSide = mountAsTenant(routes, TENANT_B, "prn_bob");

    const { body: workbench } = await createWorkbench(owner, {
      kind: "workbench",
    });
    await establishShare(trust, owner, memberSide, workbench.id, "prn_bob");

    await sendText(owner, workbench.id, "hello from the owner");
    const list = (await (
      await owner.request(`/workbenches/${workbench.id}/messages`)
    ).json()) as { items: { id: string }[] };
    const messageId = list.items[0]?.id;
    if (messageId === undefined) throw new Error("no message id");

    const toggle = await memberSide.request(
      toggleUrl(workbench.id, messageId),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emoji: "👍" }),
      },
    );
    expect(toggle.status).toBe(200);
    const toggleBody = (await toggle.json()) as {
      emoji: string;
      count: number;
      reactedByMe: boolean;
    };
    expect(toggleBody).toEqual({ emoji: "👍", count: 1, reactedByMe: true });

    // Stored under the OWNING tenant, not the acting (projected) tenant.
    expect(
      await reactions.listReactionsForMessages(TENANT.id, workbench.id, [
        messageId,
      ]),
    ).toHaveLength(1);

    const pin = await memberSide.request(pinUrl(workbench.id, messageId), {
      method: "POST",
    });
    expect(pin.status).toBe(200);
    expect(await pins.listPins(TENANT.id, workbench.id)).toHaveLength(1);

    // Both land on subsequent reads back from either side.
    const ownerMessages = (await (
      await owner.request(`/workbenches/${workbench.id}/messages`)
    ).json()) as {
      items: { id: string; reactions?: unknown[]; pinned?: boolean }[];
    };
    const ownerItem = ownerMessages.items.find((item) => item.id === messageId);
    expect(ownerItem?.pinned).toBe(true);
    expect(ownerItem?.reactions).toHaveLength(1);

    const memberPins = (await (
      await memberSide.request(`/workbenches/${workbench.id}/pins`)
    ).json()) as { items: { id: string }[] };
    expect(memberPins.items.map((item) => item.id)).toContain(messageId);
  });

  test("a tenant with no share still 404s on reaction-toggle and pin routes", async () => {
    const trust = createInMemoryFederationTrustStore();
    trust.registerTenant(TENANT.id, TENANT.name);
    trust.registerTenant(TENANT_C.id, TENANT_C.name);
    const shares = createInMemoryWorkbenchShareStore({ trust });
    const reactions = createInMemoryReactionStore();
    const pins = createInMemoryPinStore();
    const deps = buildDeps({ shares, trust, reactions, pins });
    const routes = createChatRoutes(deps);
    const owner = mountAsTenant(routes, TENANT, "prn_alice");
    const outsider = mountAsTenant(routes, TENANT_C, "prn_carol");

    const { body: workbench } = await createWorkbench(owner, {
      kind: "workbench",
    });
    await sendText(owner, workbench.id, "hello from the owner");
    const list = (await (
      await owner.request(`/workbenches/${workbench.id}/messages`)
    ).json()) as { items: { id: string }[] };
    const messageId = list.items[0]?.id;
    if (messageId === undefined) throw new Error("no message id");

    const toggle = await outsider.request(toggleUrl(workbench.id, messageId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji: "👍" }),
    });
    expect(toggle.status).toBe(404);

    const pin = await outsider.request(pinUrl(workbench.id, messageId), {
      method: "POST",
    });
    expect(pin.status).toBe(404);

    expect(
      await reactions.listReactionsForMessages(TENANT.id, workbench.id, [
        messageId,
      ]),
    ).toHaveLength(0);
    expect(await pins.listPins(TENANT.id, workbench.id)).toHaveLength(0);
  });
});
