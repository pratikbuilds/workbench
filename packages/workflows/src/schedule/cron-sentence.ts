// Every schedule a person reads, as a sentence — DESIGN.md Copy: "cron
// expressions render as human sentences ('every weekday at 9am'), never as
// the raw expression, in any surface a person reads them".
//
// `cronstrue` (MIT, zero runtime dependencies, browser-safe) covers the
// same 5-field grammar `./cron.ts` validates. The timezone is named only
// when the schedule has a wall clock to read in that zone.
import { toString as describeCronExpression } from "cronstrue";

/** A cron field is unpinned when it matches every value in its range —
 * a bare star, or a star with a step (which pins a cadence, not a clock
 * reading). */
function fieldIsUnpinned(field: string): boolean {
  return /^\*(\/\d+)?$/.test(field);
}

/**
 * True when the expression names a time of day — an hour or a minute
 * someone could point at on a clock. A step-every-15-minutes expression
 * does not; `0 9 * * *` does, and only then does the zone it is read in
 * mean anything.
 */
export function cronHasWallClock(expression: string): boolean {
  const [minute, hour] = expression.trim().split(/\s+/);
  if (minute === undefined || hour === undefined) return false;
  return !fieldIsUnpinned(minute) || !fieldIsUnpinned(hour);
}

/**
 * A raw 5-field cron expression as an English sentence, naming its
 * timezone when the schedule has a wall clock to read in it — `null` when
 * the expression is not describable, so a caller can show the person
 * their own invalid input instead of a confident sentence about a
 * schedule that will never fire.
 */
export function cronSentence(
  expression: string,
  timezone: string = "UTC",
): string | null {
  let described: string;
  try {
    described = describeCronExpression(expression, {
      verbose: false,
      use24HourTimeFormat: true,
      throwExceptionOnParseError: true,
    });
  } catch {
    // report-error-ignore: cronstrue parse failure is the invalid-input
    // signal; the caller shows the raw expression instead.
    return null;
  }
  if (described === "") return null;
  return cronHasWallClock(expression)
    ? `${described} (${timezone})`
    : described;
}
