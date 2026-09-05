import { describe, expect, test } from "bun:test";

import {
  activitySeriesForWindow,
  createInsightsWindow,
  EMPTY_OVERALL_USAGE,
  formatCount,
  formatUsd,
  INSIGHTS_WINDOW_DAYS,
  modelsWithMissingRates,
  modelsWithUnreportedTokens,
  tokensLabel,
  topModelsByCost,
  usageChromeLabel,
} from "./client";

// Fixed clock so range math is deterministic regardless of suite time.
const NOW = new Date("2026-01-15T18:00:00.000Z");

describe("createInsightsWindow", () => {
  test("defaults to a 7-day window ending at now", () => {
    const range = createInsightsWindow(undefined, NOW);
    expect(INSIGHTS_WINDOW_DAYS).toBe(7);
    expect(range.to).toBe("2026-01-15T18:00:00.000Z");
    expect(range.from).toBe("2026-01-08T18:00:00.000Z");
  });

  test("is stable for the same now input", () => {
    expect(createInsightsWindow(7, NOW)).toEqual(createInsightsWindow(7, NOW));
  });
});

describe("empty usage defaults", () => {
  test("EMPTY_OVERALL_USAGE is zero metrics, not null cost", () => {
    expect(EMPTY_OVERALL_USAGE.turns).toBe(0);
    expect(EMPTY_OVERALL_USAGE.costUsd).toBe(0);
    expect(EMPTY_OVERALL_USAGE.byModel).toEqual([]);
    expect(EMPTY_OVERALL_USAGE.tokens).toEqual({
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      thinking: 0,
      total: 0,
    });
    // Formatters must render zeros, never em-dash / NaN for empty spend.
    expect(formatUsd(EMPTY_OVERALL_USAGE.costUsd)).toBe("$0.00");
    expect(formatCount(EMPTY_OVERALL_USAGE.turns)).toBe("0");
    expect(formatCount(EMPTY_OVERALL_USAGE.tokens.total)).toBe("0");
  });

  test("activitySeriesForWindow pads empty sink to zero day series", () => {
    const range = createInsightsWindow(INSIGHTS_WINDOW_DAYS, NOW);
    const series = activitySeriesForWindow([], range);
    expect(series).toHaveLength(INSIGHTS_WINDOW_DAYS);
    expect(series.every((d) => d.turns === 0 && d.tokens === 0)).toBe(true);
    expect(series.map((d) => d.day)).toEqual([
      "2026-01-09",
      "2026-01-10",
      "2026-01-11",
      "2026-01-12",
      "2026-01-13",
      "2026-01-14",
      "2026-01-15",
    ]);
  });

  test("activitySeriesForWindow preserves nonzero day counts", () => {
    const range = createInsightsWindow(INSIGHTS_WINDOW_DAYS, NOW);
    const series = activitySeriesForWindow(
      [
        {
          day: "2026-01-14",
          turns: 3,
          tokens: 900,
          byModel: [{ model: "claude-sonnet", tokens: 900, costUsd: 1.2 }],
        },
        { day: "2026-01-15", turns: 1, tokens: 100, byModel: [] },
      ],
      range,
    );
    expect(series).toHaveLength(7);
    expect(series.find((d) => d.day === "2026-01-14")).toEqual({
      day: "2026-01-14",
      turns: 3,
      tokens: 900,
      byModel: [{ model: "claude-sonnet", tokens: 900, costUsd: 1.2 }],
    });
    expect(series.find((d) => d.day === "2026-01-15")).toEqual({
      day: "2026-01-15",
      turns: 1,
      tokens: 100,
      byModel: [],
    });
    expect(series.find((d) => d.day === "2026-01-10")?.turns).toBe(0);
    expect(series.find((d) => d.day === "2026-01-10")?.byModel).toEqual([]);
  });

  test("topModelsByCost ranks by total cost across the window, capped at the limit", () => {
    const days = [
      {
        day: "2026-01-14",
        turns: 2,
        tokens: 900,
        byModel: [
          { model: "cheap-model", tokens: 500, costUsd: 0.1 },
          { model: "pricey-model", tokens: 400, costUsd: 5 },
        ],
      },
      {
        day: "2026-01-15",
        turns: 1,
        tokens: 100,
        byModel: [{ model: "cheap-model", tokens: 100, costUsd: 0.02 }],
      },
    ];
    expect(topModelsByCost(days, 1)).toEqual(["pricey-model"]);
    expect(topModelsByCost(days)).toEqual(["pricey-model", "cheap-model"]);
  });

  test("formatUsd keeps em-dash for unknown rates, not for zero", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1.5)).toBe("$1.50");
  });
});

// CL-6877: chrome must never invent "0 tok". Zero spend is `$0.00`; zero
// tokens omit the tok segment entirely. tokensLabel and usageChromeLabel
// are the single consumer-safe path sidebar / insights share.
describe("CL-6877 usage chrome labels", () => {
  const zeroTokens = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    thinking: 0,
  };

  const someTokens = {
    input: 1000,
    cacheRead: 200,
    cacheWrite: 0,
    output: 50,
    thinking: 0,
  };

  test("tokensLabel omits null and zero totals — never returns 0 tok", () => {
    expect(tokensLabel(null)).toBeUndefined();
    expect(tokensLabel(zeroTokens)).toBeUndefined();
    expect(tokensLabel(EMPTY_OVERALL_USAGE.tokens)).toBeUndefined();
    expect(tokensLabel(someTokens)).toBe("1,250 tok");
  });

  test("usageChromeLabel is cost-only at zero tokens, cost · tok when nonzero", () => {
    expect(usageChromeLabel({ costUsd: 0, tokens: zeroTokens })).toBe("$0.00");
    expect(
      usageChromeLabel({ costUsd: 0, tokens: EMPTY_OVERALL_USAGE.tokens }),
    ).toBe("$0.00");
    expect(usageChromeLabel({ costUsd: 0, tokens: null })).toBe("$0.00");
    expect(usageChromeLabel({ costUsd: 1.5, tokens: someTokens })).toBe(
      "$1.50 · 1,250 tok",
    );
    expect(usageChromeLabel({ costUsd: null, tokens: someTokens })).toBe(
      "— · 1,250 tok",
    );
    expect(usageChromeLabel(EMPTY_OVERALL_USAGE)).not.toContain("0 tok");
  });
});

describe("CL-6659 unreported tokens vs missing rates", () => {
  const zeroTokens = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    thinking: 0,
    total: 0,
  };

  test("modelsWithUnreportedTokens names models that recorded turns but no token counts", () => {
    expect(
      modelsWithUnreportedTokens({
        turns: 2,
        tokens: zeroTokens,
        costUsd: null,
        byModel: [
          {
            model: "qwen3:latest",
            turns: 2,
            tokens: zeroTokens,
            costUsd: null,
          },
        ],
      }),
    ).toEqual(["qwen3:latest"]);
    expect(modelsWithUnreportedTokens(EMPTY_OVERALL_USAGE)).toEqual([]);
  });

  test("modelsWithMissingRates still requires tokens so unreported turns are not labeled as unknown rates", () => {
    expect(
      modelsWithMissingRates({
        turns: 1,
        tokens: zeroTokens,
        costUsd: null,
        byModel: [
          {
            model: "qwen3:latest",
            turns: 1,
            tokens: zeroTokens,
            costUsd: null,
          },
        ],
      }),
    ).toEqual([]);
  });

  test("usageChromeLabel is an em-dash when cost is unknown and tokens were not reported", () => {
    expect(usageChromeLabel({ costUsd: null, tokens: zeroTokens })).toBe("—");
  });
});
