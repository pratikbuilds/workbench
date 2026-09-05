// First `{ type: "schedule", cron }` on a frozen inert projection — the
// hashed cadence the hub poller ticks. Later schedule triggers are ignored
// on purpose: one definition, one cadence. An unparseable projection or an
// invalid cron is not a schedule (fail closed).
import { type } from "arktype";
import { WorkflowProjectionDefinition } from "@intx/types/sidecar";

import { isValidCronExpression } from "./cron";

const ScheduleTrigger = type({
  type: "'schedule'",
  cron: "string",
});

export function scheduleCronFromProjection(
  wireProjection: unknown,
): string | undefined {
  const projection = WorkflowProjectionDefinition(wireProjection);
  if (projection instanceof type.errors) return undefined;
  for (const trigger of projection.triggers) {
    const parsed = ScheduleTrigger(trigger);
    if (parsed instanceof type.errors) continue;
    if (!isValidCronExpression(parsed.cron)) return undefined;
    return parsed.cron;
  }
  return undefined;
}
