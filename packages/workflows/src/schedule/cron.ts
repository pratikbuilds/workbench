// The single 5-field cron grammar `@corbits/workflows` speaks: one parser
// shared by validation (does this expression make sense at save time?)
// and execution (does this expression match this minute?). Before this
// module existed, `trigger.ts` and the hub's scheduler each hand-rolled
// their own field parser — format-only, no range checking, incompatible
// clause orderings — so an expression could validate as saveable and
// then never fire, or fire on one parser's reading and not the other's.
// One parser closes that gap: whatever validates here is exactly what
// matches here.
//
// Semantics match Vixie/POSIX cron on the cases that matter:
// - `*/N` steps from the field minimum (so `*/2` on day-of-month is
//   1,3,5… not 2,4,6…).
// - When both day-of-month and day-of-week are restricted, they OR
//   (`0 0 13 * 5` = the 13th or any Friday).
// - Day-of-week accepts both 0 and 7 as Sunday.
// - Matching can be evaluated in an IANA timezone; `nextFireAt` is still
//   stored as a UTC instant.
export type CronField =
  "minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek";

/** Field order in a 5-field cron expression, paired with its valid range. */
export const CRON_FIELD_RANGES: Readonly<
  Record<CronField, readonly [number, number]>
> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  // 0 and 7 are both Sunday (POSIX); validation accepts either, matching
  // normalises 7 → 0 so a Date's getUTCDay() of 0 still matches `7`.
  dayOfWeek: [0, 7],
};

const CRON_FIELD_ORDER: readonly CronField[] = [
  "minute",
  "hour",
  "dayOfMonth",
  "month",
  "dayOfWeek",
];

type CronClause = {
  readonly base: "*" | number;
  readonly rangeEnd?: number;
  readonly step?: number;
};

// Standard cron clause order is base, then an optional range, then an
// optional step: `5`, `5-10`, `*/2`, `5-10/2`. Only this order is
// accepted — the reversed `5/2-10` idiom neither cron nor either of
// this repo's previous hand-rolled parsers meaningfully supported.
const CLAUSE_PATTERN = /^(\*|[0-9]+)(?:-([0-9]+))?(?:\/([0-9]+))?$/;

function parseCronClause(raw: string): CronClause | undefined {
  const match = CLAUSE_PATTERN.exec(raw);
  if (match === null) return undefined;
  const [, base, rangeEnd, step] = match;
  const clauseBase: CronClause = { base: base === "*" ? "*" : Number(base) };
  const withRangeEnd =
    rangeEnd !== undefined
      ? { ...clauseBase, rangeEnd: Number(rangeEnd) }
      : clauseBase;
  return step !== undefined
    ? { ...withRangeEnd, step: Number(step) }
    : withRangeEnd;
}

/**
 * True when `clause` is meaningful for a field whose valid values span
 * `[min, max]`: every literal value in range, and — the case the old
 * format-only validators missed — a reversed range (`10-5`) rejected
 * rather than accepted as an expression that is syntactically fine and
 * unconditionally never true.
 */
function clauseInRange(
  clause: CronClause,
  [min, max]: readonly [number, number],
): boolean {
  if (clause.step !== undefined && clause.step <= 0) return false;
  if (clause.base === "*") return true;
  if (clause.base < min || clause.base > max) return false;
  if (clause.rangeEnd === undefined) return true;
  if (clause.rangeEnd < min || clause.rangeEnd > max) return false;
  return clause.rangeEnd >= clause.base;
}

/**
 * Does `clause` match `value` for a field whose minimum is `min`?
 * Star-with-step (asterisk-slash-N) steps from `min`, not from zero — so on a
 * 1-based day-of-month, that pattern yields 1,3,5… rather than 2,4,6….
 */
function clauseMatches(
  clause: CronClause,
  value: number,
  min: number,
): boolean {
  if (clause.base === "*") {
    return clause.step === undefined ? true : (value - min) % clause.step === 0;
  }
  if (clause.rangeEnd === undefined && clause.step === undefined) {
    return value === clause.base;
  }
  const upper = clause.rangeEnd ?? clause.base;
  if (value < clause.base || value > upper) return false;
  if (clause.step === undefined) return true;
  return (value - clause.base) % clause.step === 0;
}

function everyClause(
  field: string,
  test: (clause: CronClause) => boolean,
): boolean {
  const clauses = field.split(",").map(parseCronClause);
  if (clauses.length === 0) return false;
  return clauses.every((clause) => clause !== undefined && test(clause));
}

function someClause(
  field: string,
  test: (clause: CronClause) => boolean,
): boolean {
  return field.split(",").some((raw) => {
    const clause = parseCronClause(raw);
    return clause !== undefined && test(clause);
  });
}

/**
 * Loud, eager validation for a raw 5-field cron expression
 * (minute hour day-of-month month day-of-week): every field's syntax
 * AND every field's values must be sane for that position — a minute
 * of 60, a month of 13, or a reversed range all fail here, never
 * silently accepted only to fail at fire-time.
 *
 * This is syntactic + range only. Whether the expression can ever
 * actually fire (e.g. `0 0 31 2 *` — Feb 31) is `cronExpressionCanFire`.
 */
export function isValidCronExpression(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => {
    const cronField = CRON_FIELD_ORDER[index];
    if (cronField === undefined) return false;
    return everyClause(field, (clause) =>
      clauseInRange(clause, CRON_FIELD_RANGES[cronField]),
    );
  });
}

function fieldMatches(field: string, value: number, min: number): boolean {
  return someClause(field, (clause) => clauseMatches(clause, value, min));
}

/**
 * Day-of-week match with 0/7 both meaning Sunday. A clause of `7` matches
 * a Date whose day is 0, and a clause of `0` matches the same.
 */
function dayOfWeekMatches(field: string, dayOfWeek: number): boolean {
  const [min] = CRON_FIELD_RANGES.dayOfWeek;
  if (fieldMatches(field, dayOfWeek, min)) return true;
  // Date APIs report Sunday as 0; expressions may say 7.
  if (dayOfWeek === 0 && fieldMatches(field, 7, min)) return true;
  return false;
}

/**
 * True when the day-of-month field is restricted (not a bare `*`, and not
 * only `*` with a step that still covers every day). Vixie OR-semantics
 * for DOM/DOW only apply when *both* fields are restricted.
 */
function isDayFieldRestricted(field: string): boolean {
  const trimmed = field.trim();
  if (trimmed === "*") return false;
  // `*/1` is every day — unrestricted in effect — but any other form
  // (including `*/2`, `1-5`, `1,15`) is a restriction.
  if (trimmed === "*/1") return false;
  return true;
}

export type ZonedParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly dayOfWeek: number;
};

/**
 * Wall-clock parts of `at` in `timeZone` (IANA). Falls back to UTC when
 * `timeZone` is omitted or `"UTC"`. Throws if `timeZone` is not a valid
 * IANA name — call sites that accept user input must validate first via
 * `isValidTimeZone`.
 */
export function zonedParts(at: Date, timeZone: string = "UTC"): ZonedParts {
  if (timeZone === "UTC") {
    return {
      year: at.getUTCFullYear(),
      month: at.getUTCMonth() + 1,
      day: at.getUTCDate(),
      hour: at.getUTCHours(),
      minute: at.getUTCMinutes(),
      dayOfWeek: at.getUTCDay(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(at);

  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let weekday = "";
  for (const part of parts) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
    else if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") minute = Number(part.value);
    else if (part.type === "weekday") weekday = part.value;
  }
  // en-US short weekday → 0=Sun … 6=Sat
  const dowMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dayOfWeek = dowMap[weekday];
  if (dayOfWeek === undefined) {
    throw new Error(
      `zonedParts: could not resolve weekday "${weekday}" in ${timeZone}`,
    );
  }
  return { year, month, day, hour, minute, dayOfWeek };
}

/** True when `timeZone` is a recognised IANA name (or `"UTC"`). */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone === "UTC") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    // report-error-ignore: Intl rejects unknown IANA names; that is the
    // false signal, not an operational failure.
    return false;
  }
}

/**
 * True when `expression`'s fields match the wall-clock minute of `at`
 * in `timeZone` (default UTC). DOM and DOW OR when both are restricted
 * (Vixie/POSIX); otherwise AND.
 */
export function cronMatchesMinute(
  expression: string,
  at: Date,
  timeZone: string = "UTC",
): boolean {
  const fields = expression.trim().split(/\s+/);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  if (
    minute === undefined ||
    hour === undefined ||
    dayOfMonth === undefined ||
    month === undefined ||
    dayOfWeek === undefined
  ) {
    throw new Error(`"${expression}" is not a 5-field cron expression`);
  }

  const parts = zonedParts(at, timeZone);
  const timeAndMonth =
    fieldMatches(minute, parts.minute, CRON_FIELD_RANGES.minute[0]) &&
    fieldMatches(hour, parts.hour, CRON_FIELD_RANGES.hour[0]) &&
    fieldMatches(month, parts.month, CRON_FIELD_RANGES.month[0]);
  if (!timeAndMonth) return false;

  const domOk = fieldMatches(
    dayOfMonth,
    parts.day,
    CRON_FIELD_RANGES.dayOfMonth[0],
  );
  const dowOk = dayOfWeekMatches(dayOfWeek, parts.dayOfWeek);

  if (isDayFieldRestricted(dayOfMonth) && isDayFieldRestricted(dayOfWeek)) {
    // Vixie: either day-of-month or day-of-week may match.
    return domOk || dowOk;
  }
  return domOk && dowOk;
}

/** The UTC minute `at` falls in, as a stable, comparable integer key. */
export function minuteKey(at: Date): number {
  return Math.floor(at.getTime() / 60_000);
}

/**
 * Bounds how far ahead `nextCronFireAfter` will search before giving up.
 * One leap year of minutes is enough for any expression that fires at
 * least annually; impossible expressions (Feb 31, etc.) fail here — and
 * at save time via `cronExpressionCanFire` — never inside a claim
 * transaction that would otherwise spin for millions of iterations.
 */
export const MAX_LOOKAHEAD_MINUTES = 366 * 24 * 60;

/**
 * The next minute at or after `after` (exclusive) that `expression`
 * matches in `timeZone` — the closed-form "when does this actually fire
 * next" calculation, used both to persist a routine's `nextFireAt` and
 * to render a UI's next-run estimate against the exact semantics that
 * fire it. `nextFireAt` is always a UTC instant even when matching is
 * zoned.
 */
export function nextCronFireAfter(
  expression: string,
  after: Date,
  timeZone: string = "UTC",
): Date {
  const start = minuteKey(after) + 1;
  for (let minute = start; minute - start <= MAX_LOOKAHEAD_MINUTES; minute++) {
    const candidate = new Date(minute * 60_000);
    if (cronMatchesMinute(expression, candidate, timeZone)) return candidate;
  }
  throw new Error(
    `"${expression}" has no fire time within the lookahead window` +
      (timeZone === "UTC" ? "" : ` in ${timeZone}`),
  );
}

/**
 * True when `expression` has at least one fire inside the lookahead
 * window from `from` (default: Unix epoch). Used at save time so an
 * impossible expression (`0 0 31 2 *`) is rejected before it can ever
 * reach the scheduler's claim path.
 */
export function cronExpressionCanFire(
  expression: string,
  timeZone: string = "UTC",
  from: Date = new Date(0),
): boolean {
  if (!isValidCronExpression(expression)) return false;
  if (!isValidTimeZone(timeZone)) return false;
  try {
    nextCronFireAfter(expression, from, timeZone);
    return true;
  } catch {
    // report-error-ignore: next-fire throws on impossible expressions;
    // that is the false signal, not an operational failure.
    return false;
  }
}
