import { describe, expect, test } from "bun:test";

import { createMemoryUsageStore } from "./store";
import {
  activityByDay,
  emptyOverallUsageSummary,
  summarizeUsage,
  summarizeUsageByTenant,
  teamSpaceWorkbenchRows,
} from "./queries";

describe("summarizeUsage", () => {
  test("empty sink returns zero metrics, not null cost or NaN", async () => {
    const store = createMemoryUsageStore();
    const summary = await summarizeUsage(store, ["tenant-acme"]);
    expect(summary).toEqual(emptyOverallUsageSummary());
    expect(summary.turns).toBe(0);
    expect(summary.costUsd).toBe(0);
    expect(summary.tokens.total).toBe(0);
    expect(summary.byModel).toEqual([]);
    expect(Number.isNaN(summary.costUsd)).toBe(false);
  });

  test("aggregates by model and overall with known rates", async () => {
    const store = createMemoryUsageStore();

    await store.insertUsage({
      id: "u1",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t1",
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: {
        input: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
      },
      recordedAt: new Date("2026-08-01T12:00:00Z"),
    });
    await store.insertUsage({
      id: "u2",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t2",
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: {
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 1_000_000,
        thinking: 0,
      },
      recordedAt: new Date("2026-08-01T13:00:00Z"),
    });

    const summary = await summarizeUsage(store, ["tenant-acme"]);
    expect(summary.turns).toBe(2);
    expect(summary.tokens.input).toBe(1_000_000);
    expect(summary.tokens.output).toBe(1_000_000);
    expect(summary.costUsd).toBe(2 + 10);
    expect(summary.byModel).toHaveLength(1);
    expect(summary.byModel[0]?.model).toBe("claude-sonnet-5");
  });

  test("uses a provider-reported cost instead of the static rate", async () => {
    const store = createMemoryUsageStore();
    await store.insertUsage({
      id: "u1",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t1",
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: {
        input: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
      },
      reportedCostUsd: 1.25,
    });

    const summary = await summarizeUsage(store, ["tenant-acme"]);
    expect(summary.costUsd).toBe(1.25);
  });

  test("unknown model rate yields null cost, not zero", async () => {
    const store = createMemoryUsageStore();
    await store.insertUsage({
      id: "u1",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t1",
      model: "mystery-model",
      tokens: {
        input: 100,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
      },
    });

    const summary = await summarizeUsage(store, ["tenant-acme"]);
    expect(summary.costUsd).toBeNull();
    expect(summary.byModel[0]?.costUsd).toBeNull();
    expect(summary.tokens.input).toBe(100);
  });

  test("tenant isolation — other tenants do not appear", async () => {
    const store = createMemoryUsageStore();
    await store.insertUsage({
      id: "u1",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t1",
      model: "m",
      tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 },
    });
    await store.insertUsage({
      id: "u2",
      tenantId: "tenant-other",
      sessionId: "s2",
      turnId: "t2",
      model: "m",
      tokens: {
        input: 99,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
      },
    });

    const summary = await summarizeUsage(store, ["tenant-acme"]);
    expect(summary.turns).toBe(1);
    expect(summary.tokens.input).toBe(1);
  });

  test("multi-tenant scope aggregates equal the sum of each tenant alone", async () => {
    const store = createMemoryUsageStore();
    await store.insertUsage({
      id: "u1",
      tenantId: "workbench-a",
      sessionId: "s1",
      turnId: "t1",
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: {
        input: 100,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
      },
    });
    await store.insertUsage({
      id: "u2",
      tenantId: "workbench-b",
      sessionId: "s2",
      turnId: "t2",
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: {
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 200,
        thinking: 0,
      },
    });
    await store.insertUsage({
      id: "u3",
      tenantId: "workbench-unrelated",
      sessionId: "s3",
      turnId: "t3",
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: {
        input: 9999,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
      },
    });

    const aggregate = await summarizeUsage(store, [
      "workbench-a",
      "workbench-b",
    ]);
    const a = await summarizeUsage(store, ["workbench-a"]);
    const b = await summarizeUsage(store, ["workbench-b"]);

    expect(aggregate.turns).toBe(a.turns + b.turns);
    expect(aggregate.tokens.input).toBe(a.tokens.input + b.tokens.input);
    expect(aggregate.tokens.output).toBe(a.tokens.output + b.tokens.output);
    expect(aggregate.costUsd).toBe((a.costUsd ?? 0) + (b.costUsd ?? 0));
    // The unrelated third tenant never leaks into a two-tenant scope.
    expect(aggregate.tokens.input).toBe(100);
  });
});

describe("activityByDay", () => {
  test("empty sink returns empty series (no fabricated peaks)", async () => {
    const store = createMemoryUsageStore();
    const days = await activityByDay(store, ["tenant-acme"]);
    expect(days).toEqual([]);
  });

  test("buckets by UTC day", async () => {
    const store = createMemoryUsageStore();
    await store.insertUsage({
      id: "u1",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t1",
      model: "m",
      tokens: {
        input: 10,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
      },
      recordedAt: new Date("2026-08-01T23:00:00Z"),
    });
    await store.insertUsage({
      id: "u2",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t2",
      model: "m",
      tokens: { input: 5, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 },
      recordedAt: new Date("2026-08-02T01:00:00Z"),
    });

    const days = await activityByDay(store, ["tenant-acme"]);
    expect(days).toEqual([
      {
        day: "2026-08-01",
        turns: 1,
        tokens: 10,
        byModel: [{ model: "m", tokens: 10, costUsd: null }],
      },
      {
        day: "2026-08-02",
        turns: 1,
        tokens: 5,
        byModel: [{ model: "m", tokens: 5, costUsd: null }],
      },
    ]);
  });

  test("splits each day's tokens/cost by model for a stacked chart", async () => {
    const store = createMemoryUsageStore();
    await store.insertUsage({
      id: "u1",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t1",
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: {
        input: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
      },
      recordedAt: new Date("2026-08-01T10:00:00Z"),
    });
    await store.insertUsage({
      id: "u2",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t2",
      model: "gpt-unpriced",
      tokens: {
        input: 100,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
      },
      recordedAt: new Date("2026-08-01T11:00:00Z"),
    });

    const [day] = await activityByDay(store, ["tenant-acme"]);
    expect(day?.byModel).toEqual([
      { model: "claude-sonnet-5", tokens: 1_000_000, costUsd: 2 },
      { model: "gpt-unpriced", tokens: 100, costUsd: null },
    ]);
  });

  test("multi-tenant scope buckets across all tenants in scope", async () => {
    const store = createMemoryUsageStore();
    await store.insertUsage({
      id: "u1",
      tenantId: "workbench-a",
      sessionId: "s1",
      turnId: "t1",
      model: "m",
      tokens: {
        input: 10,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
      },
      recordedAt: new Date("2026-08-01T10:00:00Z"),
    });
    await store.insertUsage({
      id: "u2",
      tenantId: "workbench-b",
      sessionId: "s2",
      turnId: "t2",
      model: "m",
      tokens: { input: 5, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0 },
      recordedAt: new Date("2026-08-01T11:00:00Z"),
    });

    const days = await activityByDay(store, ["workbench-a", "workbench-b"]);
    expect(days).toEqual([
      {
        day: "2026-08-01",
        turns: 2,
        tokens: 15,
        byModel: [{ model: "m", tokens: 15, costUsd: null }],
      },
    ]);
  });
});

describe("summarizeUsageByTenant", () => {
  test("every requested tenant id gets an entry, zeroed when it recorded nothing", async () => {
    const store = createMemoryUsageStore();
    await store.insertUsage({
      id: "u1",
      tenantId: "workbench-a",
      sessionId: "s1",
      turnId: "t1",
      model: "m",
      tokens: {
        input: 100,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
      },
    });

    const rows = await summarizeUsageByTenant(store, [
      "workbench-a",
      "workbench-b",
    ]);
    expect(rows).toEqual([
      {
        tenantId: "workbench-a",
        turns: 1,
        tokens: {
          input: 100,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          thinking: 0,
          total: 100,
        },
        costUsd: null,
      },
      {
        tenantId: "workbench-b",
        turns: 0,
        tokens: {
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          thinking: 0,
          total: 0,
        },
        costUsd: 0,
      },
    ]);
  });

  test("per-tenant totals sum to the same aggregate summarizeUsage reports for that scope", async () => {
    const store = createMemoryUsageStore();
    await store.insertUsage({
      id: "u1",
      tenantId: "workbench-a",
      sessionId: "s1",
      turnId: "t1",
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: {
        input: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        thinking: 0,
      },
    });
    await store.insertUsage({
      id: "u2",
      tenantId: "workbench-b",
      sessionId: "s2",
      turnId: "t2",
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: {
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 1_000_000,
        thinking: 0,
      },
    });

    const scope = ["workbench-a", "workbench-b"];
    const perTenant = await summarizeUsageByTenant(store, scope);
    const aggregate = await summarizeUsage(store, scope);

    const summedTurns = perTenant.reduce((sum, w) => sum + w.turns, 0);
    const summedCost = perTenant.reduce((sum, w) => sum + (w.costUsd ?? 0), 0);
    expect(summedTurns).toBe(aggregate.turns);
    expect(aggregate.costUsd).not.toBeNull();
    expect(summedCost).toBe(aggregate.costUsd ?? 0);
  });
});

describe("CL-6659 unreported tokens and team-space breakdowns", () => {
  const zeroTokens = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    thinking: 0,
  };

  test("a recorded turn with no token counts is null cost, not $0.00", async () => {
    const store = createMemoryUsageStore();
    await store.insertUsage({
      id: "u1",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t1",
      provider: "ollama",
      model: "qwen3:latest",
      tokens: zeroTokens,
    });

    const summary = await summarizeUsage(store, ["tenant-acme"]);
    expect(summary.turns).toBe(1);
    expect(summary.tokens.total).toBe(0);
    expect(summary.costUsd).toBeNull();
    expect(summary.byModel[0]?.costUsd).toBeNull();
  });

  test("ollama turns with real tokens and a FREE catalog row cost $0, not null", async () => {
    const store = createMemoryUsageStore();
    await store.insertUsage({
      id: "u1",
      tenantId: "tenant-acme",
      sessionId: "s1",
      turnId: "t1",
      provider: "ollama",
      model: "qwen3.8:27b",
      tokens: {
        input: 100,
        cacheRead: 0,
        cacheWrite: 0,
        output: 50,
        thinking: 0,
      },
    });

    const summary = await summarizeUsage(store, ["tenant-acme"]);
    expect(summary.turns).toBe(1);
    expect(summary.tokens.total).toBe(150);
    expect(summary.costUsd).toBe(0);
  });

  test("team-space parent with recorded turns stays in the workbench breakdown", () => {
    const rows = [
      {
        tenantId: "team-root",
        turns: 3,
        tokens: {
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          thinking: 0,
          total: 0,
        },
        costUsd: null,
      },
      {
        tenantId: "workbench-a",
        turns: 0,
        tokens: {
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          thinking: 0,
          total: 0,
        },
        costUsd: 0,
      },
    ];
    const kept = teamSpaceWorkbenchRows(rows, {
      tenantId: "team-root",
      isTeamSpace: true,
    });
    expect(kept.map((r) => r.tenantId)).toEqual(["team-root", "workbench-a"]);
  });

  test("empty team-space parent is still dropped as a duplicate of All workbenches", () => {
    const rows = [
      {
        tenantId: "team-root",
        turns: 0,
        tokens: {
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          thinking: 0,
          total: 0,
        },
        costUsd: 0,
      },
      {
        tenantId: "workbench-a",
        turns: 2,
        tokens: {
          input: 10,
          cacheRead: 0,
          cacheWrite: 0,
          output: 5,
          thinking: 0,
          total: 15,
        },
        costUsd: null,
      },
    ];
    const kept = teamSpaceWorkbenchRows(rows, {
      tenantId: "team-root",
      isTeamSpace: true,
    });
    expect(kept.map((r) => r.tenantId)).toEqual(["workbench-a"]);
  });
});
