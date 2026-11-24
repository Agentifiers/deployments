export type RateUnit = "day" | "hour" | "minute";

export type ScheduleExpression =
  | { readonly kind: "at"; readonly wallTime: string }
  | { readonly kind: "rate"; readonly every: number; readonly unit: RateUnit }
  | { readonly kind: "cron"; readonly spec: CronSpec }
  | { readonly kind: "unparsed"; readonly raw: string };

/** Values from `start` to `end` every `step`: a single value has `start === end`, and `*` spans the field. */
export interface CronRange {
  readonly kind: "range";
  readonly start: number;
  readonly end: number;
  readonly step: number;
}

export type CronField = readonly CronRange[];

export type DayOfMonthTerm =
  | CronRange
  | { readonly kind: "last-day"; readonly daysBefore: number }
  | { readonly kind: "nearest-weekday"; readonly day: number }
  | { readonly kind: "last-weekday" };

/** Weekdays count from 0 = Sunday, as in `ActiveWindow`; the expression's 1 = SUN is shifted at parse. */
export type DayOfWeekTerm =
  | CronRange
  | { readonly kind: "last-in-month"; readonly weekday: number }
  | { readonly kind: "nth-in-month"; readonly weekday: number; readonly nth: number };

/** EventBridge requires `?` in exactly one of day-of-month and day-of-week, so the spec keeps only the other. */
export type CronDays =
  | { readonly kind: "dayOfMonth"; readonly terms: readonly DayOfMonthTerm[] }
  | { readonly kind: "dayOfWeek"; readonly terms: readonly DayOfWeekTerm[] };

export interface CronSpec {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly days: CronDays;
  readonly month: CronField;
  readonly year: CronField;
}

export interface ActiveWindow {
  readonly startMinuteOfDay: number;
  readonly endMinuteOfDay: number;
  /** 0 = Sunday. */
  readonly daysOfWeek?: readonly number[];
}

export type Cadence =
  | {
      readonly kind: "schedule";
      readonly expression: ScheduleExpression;
      readonly raw: string;
      readonly timeZone: string;
    }
  | {
      readonly kind: "heartbeat";
      readonly intervalMs: number;
      readonly window?: ActiveWindow;
      readonly timeZone: string;
      readonly skipWhenBusy: boolean;
    };

interface FieldDomain {
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
}

interface CalendarDay {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekday: number;
  readonly lastDay: number;
}

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 1_440;
const DAY_MS = MINUTES_PER_DAY * MINUTE_MS;
const HORIZON_YEARS = 5;
const MAX_LISTED_TIMES = 4;
const EVERY_DAY = "every day";
const CUSTOM_CALENDAR = "Custom calendar schedule";

const MINUTES: FieldDomain = { min: 0, max: 59 };
const HOURS: FieldDomain = { min: 0, max: 23 };
const MONTH_DAYS: FieldDomain = { min: 1, max: 31 };
const MONTHS: FieldDomain = {
  min: 1,
  max: 12,
  names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
};
const EXPRESSION_WEEKDAYS: FieldDomain = {
  min: 1,
  max: 7,
  names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
};
const WEEKDAYS: FieldDomain = { min: 0, max: 6 };
const YEARS: FieldDomain = { min: 1970, max: 2199 };
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const RATE_UNIT_MINUTES: Readonly<Record<RateUnit, number>> = {
  day: MINUTES_PER_DAY,
  hour: 60,
  minute: 1,
};
const RATE_UNIT_WORDS: Readonly<Record<string, RateUnit>> = {
  day: "day",
  days: "day",
  hour: "hour",
  hours: "hour",
  minute: "minute",
  minutes: "minute",
};
const DURATION_UNITS = ["day", "hour", "minute"] as const;

const EXPRESSION_PARSERS: Readonly<
  Record<string, (body: string) => ScheduleExpression | undefined>
> = { at: parseAt, cron: parseCron, rate: parseRate };

const LIST = new Intl.ListFormat("en", { type: "conjunction" });
const WALL_CLOCK_FORMATS = new Map<string, Intl.DateTimeFormat>();

export function parseScheduleExpression(raw: string): ScheduleExpression {
  const match = /^(at|cron|rate)\((.*)\)$/u.exec(raw.trim());
  const parse = EXPRESSION_PARSERS[match?.[1] ?? ""];
  return parse?.(match?.[2]?.trim() ?? "") ?? { kind: "unparsed", raw };
}

function parseAt(body: string): ScheduleExpression | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(body)) return undefined;
  const wall = Date.parse(`${body}Z`);
  return Number.isFinite(wall) && new Date(wall).toISOString().slice(0, 19) === body
    ? { kind: "at", wallTime: body }
    : undefined;
}

function parseRate(body: string): ScheduleExpression | undefined {
  const rate = /^([1-9]\d*)\s+(minute|minutes|hour|hours|day|days)$/u.exec(body);
  const word = rate?.[2] ?? "";
  const unit = RATE_UNIT_WORDS[word];
  const every = Number(rate?.[1]);
  return unit && Number.isSafeInteger(every) && (every === 1) === !word.endsWith("s")
    ? { kind: "rate", every, unit }
    : undefined;
}

function parseCron(body: string): ScheduleExpression | undefined {
  const fields = body.split(/\s+/u);
  if (fields.length !== 6) return undefined;
  const [minute = "", hour = "", dayOfMonth = "", month = "", dayOfWeek = "", year = ""] = fields;
  const minuteField = parseList(minute, (segment) => parseRange(segment, MINUTES));
  const hourField = parseList(hour, (segment) => parseRange(segment, HOURS));
  const days = parseDays(dayOfMonth, dayOfWeek);
  const monthField = parseList(month, (segment) => parseRange(segment, MONTHS));
  const yearField = parseList(year, (segment) => parseRange(segment, YEARS));
  if (!minuteField || !hourField || !days || !monthField || !yearField) return undefined;
  return {
    kind: "cron",
    spec: { minute: minuteField, hour: hourField, days, month: monthField, year: yearField },
  };
}

function parseDays(dayOfMonth: string, dayOfWeek: string): CronDays | undefined {
  if (dayOfMonth !== "?" && dayOfWeek === "?") {
    const terms = parseList(dayOfMonth, parseDayOfMonthTerm);
    return terms ? { kind: "dayOfMonth", terms } : undefined;
  }
  if (
    dayOfMonth === "?" &&
    dayOfWeek !== "?" &&
    !(dayOfWeek.includes("#") && dayOfWeek.includes(","))
  ) {
    const terms = parseList(dayOfWeek, parseDayOfWeekTerm);
    return terms ? { kind: "dayOfWeek", terms } : undefined;
  }
  return undefined;
}

function parseList<Term>(
  field: string,
  parseTerm: (segment: string) => Term | undefined,
): readonly Term[] | undefined {
  const terms: Term[] = [];
  for (const segment of field.split(",")) {
    const term = parseTerm(segment);
    if (term === undefined) return undefined;
    terms.push(term);
  }
  return terms;
}

function parseDayOfMonthTerm(segment: string): DayOfMonthTerm | undefined {
  if (segment === "L") return { kind: "last-day", daysBefore: 0 };
  if (segment === "LW") return { kind: "last-weekday" };
  const daysBefore = Number(/^L-(\d+)$/u.exec(segment)?.[1]);
  if (daysBefore >= 1 && daysBefore <= 30) return { kind: "last-day", daysBefore };
  const day = cronValue(/^(\d+)W$/u.exec(segment)?.[1], MONTH_DAYS);
  if (day !== undefined) return { kind: "nearest-weekday", day };
  return parseRange(segment, MONTH_DAYS);
}

function parseDayOfWeekTerm(segment: string): DayOfWeekTerm | undefined {
  const special = /^([A-Z]+|\d+)(?:L|#([1-5]))$/iu.exec(segment);
  const weekday = cronValue(special?.[1], EXPRESSION_WEEKDAYS);
  if (weekday !== undefined) {
    const nth = special?.[2];
    return nth === undefined
      ? { kind: "last-in-month", weekday: weekday - 1 }
      : { kind: "nth-in-month", weekday: weekday - 1, nth: Number(nth) };
  }
  const range = parseRange(segment, EXPRESSION_WEEKDAYS);
  return range ? { ...range, start: range.start - 1, end: range.end - 1 } : undefined;
}

function parseRange(segment: string, domain: FieldDomain): CronRange | undefined {
  const increment = /^(.+)\/(\d+)$/u.exec(segment);
  const base = increment?.[1] ?? segment;
  const step = increment ? Number(increment[2]) : 1;
  if (!Number.isSafeInteger(step) || step < 1 || step > domain.max) return undefined;
  if (base === "*") return { kind: "range", start: domain.min, end: domain.max, step };
  const bounds = /^([A-Z]+|\d+)-([A-Z]+|\d+)$/iu.exec(base);
  const start = cronValue(bounds ? bounds[1] : base, domain);
  const end = bounds ? cronValue(bounds[2], domain) : increment ? domain.max : start;
  return start !== undefined && end !== undefined && start <= end
    ? { kind: "range", start, end, step }
    : undefined;
}

function cronValue(text: string | undefined, { min, max, names }: FieldDomain): number | undefined {
  const token = (text ?? "").toUpperCase();
  const index = names?.indexOf(token) ?? -1;
  const value = index >= 0 ? index + 1 : /^\d+$/u.test(token) ? Number(token) : Number.NaN;
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

export function describeCadence(cadence: Cadence): string {
  if (cadence.kind === "heartbeat") {
    const { window } = cadence;
    return [
      `Every ${durationText(cadence.intervalMs / MINUTE_MS)}`,
      ...(window
        ? [
            `${clockText(window.startMinuteOfDay)}-${clockText(window.endMinuteOfDay)} ${weekdaysText(window.daysOfWeek)} (${cadence.timeZone})`,
          ]
        : []),
      ...(cadence.skipWhenBusy ? ["skipped while busy"] : []),
    ].join(", ");
  }
  const { expression, timeZone } = cadence;
  switch (expression.kind) {
    case "at": {
      const { wallTime } = expression;
      const time = wallTime.endsWith(":00") ? wallTime.slice(11, 16) : wallTime.slice(11, 19);
      return `Once at ${wallTime.slice(0, 10)} ${time} (${timeZone})`;
    }
    case "rate":
      return `Every ${durationText(expression.every * RATE_UNIT_MINUTES[expression.unit])}`;
    case "cron":
      return describeCron(expression.spec, timeZone);
    case "unparsed":
      return cadence.raw;
  }
}

function describeCron(spec: CronSpec, timeZone: string): string {
  const days = cronDaysText(spec);
  if (days === undefined) return CUSTOM_CALENDAR;
  const minutes = expand(spec.minute, MINUTES);
  const times = expand(spec.hour, HOURS).flatMap((hour) =>
    minutes.map((minute) => hour * 60 + minute),
  );
  const interval = evenInterval(times);
  const [first = 0] = times;
  // Only an interval that divides the hour and starts on it reads the same in every time zone.
  if (interval !== undefined && 60 % interval === 0 && first % interval === 0) {
    const every = `Every ${durationText(interval)}`;
    return days === EVERY_DAY ? every : `${every} ${days} (${timeZone})`;
  }
  if (times.length <= MAX_LISTED_TIMES) {
    return `${LIST.format(times.map(clockText))} ${days} (${timeZone})`;
  }
  return interval === undefined
    ? CUSTOM_CALENDAR
    : `Every ${durationText(interval)} from ${clockText(first)} ${days} (${timeZone})`;
}

function cronDaysText({ days, month, year }: CronSpec): string | undefined {
  const everyMonthAndYear = [
    { field: month, domain: MONTHS },
    { field: year, domain: YEARS },
  ].every(({ field, domain }) => expand(field, domain).length === domain.max - domain.min + 1);
  if (!everyMonthAndYear) return undefined;
  switch (days.kind) {
    case "dayOfWeek":
      return days.terms.every(isRange) ? weekdaysText(expand(days.terms, WEEKDAYS)) : undefined;
    case "dayOfMonth": {
      if (!days.terms.every(isRange)) return undefined;
      const dates = expand(days.terms, MONTH_DAYS);
      if (dates.length === MONTH_DAYS.max) return EVERY_DAY;
      return `on ${dates.length === 1 ? "day" : "days"} ${runsText(dates, String)} of every month`;
    }
  }
}

/** The spacing when fires repeat evenly around the clock, so `0/10 *` reads as every 10 minutes. */
function evenInterval(times: readonly number[]): number | undefined {
  const [first] = times;
  if (first === undefined || times.length < 2) return undefined;
  const gaps = times.map((time, index) => (times[index + 1] ?? first + MINUTES_PER_DAY) - time);
  return gaps.every((gap) => gap === gaps[0]) ? gaps[0] : undefined;
}

function weekdaysText(days: readonly number[] | undefined): string {
  return days === undefined || days.length === WEEKDAY_NAMES.length
    ? EVERY_DAY
    : runsText(
        days.toSorted((left, right) => left - right),
        (day) => WEEKDAY_NAMES[day] ?? String(day),
      );
}

function runsText(values: readonly number[], label: (value: number) => string): string {
  const runs: { first: number; last: number }[] = [];
  for (const value of values) {
    const run = runs.at(-1);
    if (run?.last === value - 1) run.last = value;
    else runs.push({ first: value, last: value });
  }
  return LIST.format(
    runs.flatMap(({ first, last }) =>
      last - first >= 2
        ? [`${label(first)} to ${label(last)}`]
        : Array.from({ length: last - first + 1 }, (_, offset) => label(first + offset)),
    ),
  );
}

function durationText(minutes: number): string {
  const unit =
    DURATION_UNITS.find((candidate) => minutes % RATE_UNIT_MINUTES[candidate] === 0) ?? "minute";
  const size = minutes / RATE_UNIT_MINUTES[unit];
  return size === 1 ? unit : `${size} ${unit}s`;
}

function clockText(minuteOfDay: number): string {
  const hour = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  return `${hour}:${String(minuteOfDay % 60).padStart(2, "0")}`;
}

export function nextScheduleFires(
  cadence: Extract<Cadence, { kind: "schedule" }>,
  after: Date,
  count: number,
  anchor?: { readonly scheduledFor: string },
): readonly string[] {
  const { expression, timeZone } = cadence;
  switch (expression.kind) {
    case "at": {
      const instant = zonedInstant(expression.wallTime, timeZone);
      return count > 0 && Date.parse(instant) > after.getTime() ? [instant] : [];
    }
    case "rate": {
      const from = Date.parse(anchor?.scheduledFor ?? "");
      return Number.isNaN(from) ? [] : rateFires(expression, from, after.getTime(), count);
    }
    case "cron":
      return cronFires(expression.spec, timeZone, after.getTime(), count);
    case "unparsed":
      return [];
  }
}

function rateFires(
  { every, unit }: Extract<ScheduleExpression, { kind: "rate" }>,
  from: number,
  after: number,
  count: number,
): string[] {
  const step = every * RATE_UNIT_MINUTES[unit] * MINUTE_MS;
  const first = Math.max(1, Math.floor((after - from) / step) + 1);
  return Array.from({ length: Math.max(count, 0) }, (_, index) =>
    new Date(from + (first + index) * step).toISOString(),
  );
}

function cronFires(spec: CronSpec, timeZone: string, after: number, count: number): string[] {
  const fires: string[] = [];
  const hours = expand(spec.hour, HOURS);
  const minutes = expand(spec.minute, MINUTES);
  const firstDay = Math.floor(wallClock(after, timeZone) / DAY_MS) * DAY_MS;
  const start = new Date(firstDay);
  const lastDay = Date.UTC(
    start.getUTCFullYear() + HORIZON_YEARS,
    start.getUTCMonth(),
    start.getUTCDate(),
  );
  for (let day = firstDay; day <= lastDay && fires.length < count; day += DAY_MS) {
    if (!onCalendarDay(spec, calendarDay(day))) continue;
    for (const hour of hours) {
      for (const minute of minutes) {
        // EventBridge skips a wall time that springing forward removes and fires once in a repeated hour.
        const [instant] = wallTimeInstants(day + (hour * 60 + minute) * MINUTE_MS, timeZone);
        if (instant === undefined || instant <= after) continue;
        fires.push(new Date(instant).toISOString());
        if (fires.length === count) return fires;
      }
    }
  }
  return fires;
}

function calendarDay(midnight: number): CalendarDay {
  const date = new Date(midnight);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return {
    year,
    month,
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
    lastDay: new Date(Date.UTC(year, month, 0)).getUTCDate(),
  };
}

function onCalendarDay({ days, month, year }: CronSpec, date: CalendarDay): boolean {
  if (!inField(year, date.year) || !inField(month, date.month)) return false;
  return days.kind === "dayOfMonth"
    ? days.terms.some((term) => onMonthDay(term, date))
    : days.terms.some((term) => onWeekday(term, date));
}

function onMonthDay(term: DayOfMonthTerm, date: CalendarDay): boolean {
  switch (term.kind) {
    case "range":
      return inRange(term, date.day);
    case "last-day":
      return date.day === date.lastDay - term.daysBefore;
    case "nearest-weekday":
      return date.day === nearestWeekday(term.day, date);
    case "last-weekday":
      return date.day === nearestWeekday(date.lastDay, date);
  }
}

function onWeekday(term: DayOfWeekTerm, date: CalendarDay): boolean {
  switch (term.kind) {
    case "range":
      return inRange(term, date.weekday);
    case "last-in-month":
      return date.weekday === term.weekday && date.day + 7 > date.lastDay;
    case "nth-in-month":
      return date.weekday === term.weekday && Math.ceil(date.day / 7) === term.nth;
  }
}

/** A Saturday moves back and a Sunday forward, without leaving the month (Quartz `W` semantics). */
function nearestWeekday(
  target: number,
  { day, weekday, lastDay }: CalendarDay,
): number | undefined {
  if (target > lastDay) return undefined;
  const targetWeekday = (((weekday + target - day) % 7) + 7) % 7;
  if (targetWeekday === 6) return target === 1 ? 3 : target - 1;
  if (targetWeekday === 0) return target === lastDay ? target - 2 : target + 1;
  return target;
}

function isRange(term: DayOfMonthTerm | DayOfWeekTerm): term is CronRange {
  return term.kind === "range";
}

function inRange({ start, end, step }: CronRange, value: number): boolean {
  return value >= start && value <= end && (value - start) % step === 0;
}

function inField(field: CronField, value: number): boolean {
  return field.some((range) => inRange(range, value));
}

function expand(field: CronField, { min, max }: FieldDomain): number[] {
  return Array.from({ length: max - min + 1 }, (_, index) => min + index).filter((value) =>
    inField(field, value),
  );
}

export function zonedInstant(wallTime: string, timeZone: string): string {
  const wall = Date.parse(`${wallTime}Z`);
  const [earliest] = wallTimeInstants(wall, timeZone);
  return new Date(earliest ?? wall - zoneOffset(wall - DAY_MS, timeZone)).toISOString();
}

/**
 * Every instant the zone shows `wall` (wall time written as UTC milliseconds): none inside a
 * spring-forward gap, two inside a repeated hour. The offsets a day either side bracket any
 * transition near it.
 */
function wallTimeInstants(wall: number, timeZone: string): number[] {
  const offsets = new Set([
    zoneOffset(wall - DAY_MS, timeZone),
    zoneOffset(wall + DAY_MS, timeZone),
  ]);
  return [...offsets]
    .map((offset) => wall - offset)
    .filter((instant) => wallClock(instant, timeZone) === wall)
    .toSorted((left, right) => left - right);
}

function zoneOffset(instant: number, timeZone: string): number {
  return wallClock(instant, timeZone) - instant;
}

function wallClock(instant: number, timeZone: string): number {
  const parts = wallClockFormat(timeZone).formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second"),
  );
}

function wallClockFormat(timeZone: string): Intl.DateTimeFormat {
  const cached = WALL_CLOCK_FORMATS.get(timeZone);
  if (cached) return cached;
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  WALL_CLOCK_FORMATS.set(timeZone, format);
  return format;
}
