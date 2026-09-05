import { describe, expect, test } from "bun:test";

import { scheduleCronFromProjection } from "./from-projection";

const baseProjection = {
  id: "wf_digest",
  stepOrder: ["digest"],
  steps: { digest: { kind: "step" } },
};

describe("scheduleCronFromProjection", () => {
  test("returns the first schedule cron", () => {
    expect(
      scheduleCronFromProjection({
        ...baseProjection,
        triggers: [
          { type: "mail", to: "digest@example.com" },
          { type: "schedule", cron: "0 9 * * *" },
          { type: "schedule", cron: "0 18 * * *" },
        ],
      }),
    ).toBe("0 9 * * *");
  });

  test("returns undefined when there is no schedule trigger", () => {
    expect(
      scheduleCronFromProjection({
        ...baseProjection,
        triggers: [{ type: "mail", to: "digest@example.com" }],
      }),
    ).toBeUndefined();
  });

  test("returns undefined for an unparseable projection", () => {
    expect(scheduleCronFromProjection({ triggers: [] })).toBeUndefined();
  });

  test("returns undefined when the first schedule cron is invalid", () => {
    expect(
      scheduleCronFromProjection({
        ...baseProjection,
        triggers: [{ type: "schedule", cron: "99 99 99 99 99" }],
      }),
    ).toBeUndefined();
  });
});
