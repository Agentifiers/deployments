import { describe, expect, test } from "bun:test";
import {
  describeCadence,
  nextScheduleFires,
  parseScheduleExpression,
  zonedInstant,
  type Cadence,
} from "./cadence.ts";

function schedule(raw: string, timeZone = "UTC"): Extract<Cadence, { kind: "schedule" }> {
  return { kind: "schedule", expression: parseScheduleExpression(raw), raw, timeZone };
}

function fires(raw: string, timeZone: string, after: string, count = 1) {
  return nextScheduleFires(schedule(raw, timeZone), new Date(after), count);
}

describe("parseScheduleExpression", () => {
  test("reads at, rate, and cron into their parts, counting weekdays from 0 = Sunday", () => {
    expect(parseScheduleExpression("at(2026-11-02T09:00:00)")).toEqual({
      kind: "at",
      wallTime: "2026-11-02T09:00:00",
    });
    expect(parseScheduleExpression("rate(2 hours)")).toEqual({
      kind: "rate",
      every: 2,
      unit: "hour",
    });
    expect(parseScheduleExpression("cron(0/10 9-17 ? * MON-FRI *)")).toEqual({
      kind: "cron",
      spec: {
        minute: [{ kind: "range", start: 0, end: 59, step: 10 }],
        hour: [{ kind: "range", start: 9, end: 17, step: 1 }],
        days: { kind: "dayOfWeek", terms: [{ kind: "range", start: 1, end: 5, step: 1 }] },
        month: [{ kind: "range", start: 1, end: 12, step: 1 }],
        year: [{ kind: "range", start: 1970, end: 2199, step: 1 }],
      },
    });
  });

  test("reads the day-of-month and day-of-week specials the API accepts", () => {
    expect(parseScheduleExpression("cron(0 18 L-2,15W,LW * ? *)")).toMatchObject({
      spec: {
        days: {
          kind: "dayOfMonth",
          terms: [
            { kind: "last-day", daysBefore: 2 },
            { kind: "nearest-weekday", day: 15 },
            { kind: "last-weekday" },
          ],
        },
      },
    });
    expect(parseScheduleExpression("cron(0 10 ? * fri#2 *)")).toMatchObject({
      spec: { days: { kind: "dayOfWeek", terms: [{ kind: "nth-in-month", weekday: 5, nth: 2 }] } },
    });
    expect(parseScheduleExpression("cron(0 10 ? * 6L *)")).toMatchObject({
      spec: { days: { kind: "dayOfWeek", terms: [{ kind: "last-in-month", weekday: 5 }] } },
    });
  });

  test("anything outside the API grammar stays unparsed", () => {
    expect(parseScheduleExpression("every day")).toEqual({ kind: "unparsed", raw: "every day" });
    for (const raw of [
      "rate(1 minutes)",
      "rate(2 hour)",
      "cron(0 9 * * MON *)",
      "cron(0 9 ? * ? *)",
      "cron(0 9 ? * 2#1,4 *)",
      "cron(0 24 * * ? *)",
      "cron(0 9 ? * MON)",
      "at(2026-02-30T09:00:00)",
    ]) {
      expect(parseScheduleExpression(raw)).toEqual({ kind: "unparsed", raw });
    }
  });
});

describe("describeCadence", () => {
  test("rates read as one plain interval", () => {
    expect(describeCadence(schedule("rate(15 minutes)"))).toBe("Every 15 minutes");
    expect(describeCadence(schedule("rate(1 day)"))).toBe("Every day");
    expect(describeCadence(schedule("rate(2 hours)"))).toBe("Every 2 hours");
  });

  test("an even cron step that divides the hour and starts on it reads as an interval with no zone", () => {
    expect(describeCadence(schedule("cron(0/10 * * * ? *)", "America/New_York"))).toBe(
      "Every 10 minutes",
    );
    expect(describeCadence(schedule("cron(0 * * * ? *)", "Asia/Kolkata"))).toBe("Every hour");
  });

  test("an even cron step longer than an hour, or off the hour, keeps its times and zone", () => {
    expect(describeCadence(schedule("cron(0 3,15 * * ? *)", "Europe/Berlin"))).toBe(
      "03:00 and 15:00 every day (Europe/Berlin)",
    );
    expect(describeCadence(schedule("cron(0 0/2 * * ? *)", "Asia/Kolkata"))).toBe(
      "Every 2 hours from 00:00 every day (Asia/Kolkata)",
    );
    expect(describeCadence(schedule("cron(5/10 * * * ? *)"))).toBe(
      "Every 10 minutes from 00:05 every day (UTC)",
    );
  });

  test("a time of day or a calendar day names the zone", () => {
    expect(describeCadence(schedule("cron(0 9 ? * MON-FRI *)", "America/New_York"))).toBe(
      "09:00 Monday to Friday (America/New_York)",
    );
    expect(describeCadence(schedule("cron(30 8 1 * ? *)"))).toBe(
      "08:30 on day 1 of every month (UTC)",
    );
    expect(describeCadence(schedule("at(2026-11-02T09:00:00)", "Europe/Berlin"))).toBe(
      "Once at 2026-11-02 09:00 (Europe/Berlin)",
    );
    expect(describeCadence(schedule("cron(0 0 * * ? *)"))).toBe("00:00 every day (UTC)");
    expect(describeCadence(schedule("cron(0/15 * ? * MON-FRI *)"))).toBe(
      "Every 15 minutes Monday to Friday (UTC)",
    );
  });

  test("lists of weekdays and times read as English lists", () => {
    expect(describeCadence(schedule("cron(0 9 ? * MON,WED,FRI *)"))).toBe(
      "09:00 Monday, Wednesday, and Friday (UTC)",
    );
    expect(describeCadence(schedule("cron(0 9,17 ? * MON-FRI *)"))).toBe(
      "09:00 and 17:00 Monday to Friday (UTC)",
    );
  });

  test("a one-time schedule shows its seconds only when it has them", () => {
    expect(describeCadence(schedule("at(2026-10-05T12:03:27)"))).toBe(
      "Once at 2026-10-05 12:03:27 (UTC)",
    );
  });

  test("cron shapes without a plain summary read as a custom calendar", () => {
    expect(describeCadence(schedule("cron(0 12 ? * 2#1 *)"))).toBe("Custom calendar schedule");
    expect(describeCadence(schedule("cron(0 9 1 1 ? *)"))).toBe("Custom calendar schedule");
  });

  test("a heartbeat names its window and its busy rule", () => {
    expect(
      describeCadence({
        kind: "heartbeat",
        intervalMs: 1_800_000,
        window: { startMinuteOfDay: 540, endMinuteOfDay: 1020, daysOfWeek: [1, 2, 3, 4, 5] },
        timeZone: "Europe/Berlin",
        skipWhenBusy: true,
      }),
    ).toBe("Every 30 minutes, 09:00-17:00 Monday to Friday (Europe/Berlin), skipped while busy");
    expect(
      describeCadence({
        kind: "heartbeat",
        intervalMs: 3_600_000,
        timeZone: "Europe/Berlin",
        skipWhenBusy: false,
      }),
    ).toBe("Every hour");
  });
});

describe("nextScheduleFires", () => {
  test("a weekday cron skips the weekend in the schedule's zone", () => {
    expect(
      fires("cron(0 9 ? * MON-FRI *)", "America/New_York", "2026-10-03T12:00:00.000Z", 3),
    ).toEqual(["2026-10-05T13:00:00.000Z", "2026-10-06T13:00:00.000Z", "2026-10-07T13:00:00.000Z"]);
  });

  test("a daily cron keeps its wall time across the DST change", () => {
    expect(fires("cron(0 9 * * ? *)", "America/New_York", "2026-10-31T14:00:00.000Z")).toEqual([
      "2026-11-01T14:00:00.000Z",
    ]);
  });

  test("a one-time schedule fires at its wall time in the zone, strictly after the given instant", () => {
    expect(fires("at(2026-11-02T09:00:00)", "Europe/Berlin", "2026-10-05T00:00:00.000Z")).toEqual([
      "2026-11-02T08:00:00.000Z",
    ]);
    expect(fires("at(2026-11-02T09:00:00)", "UTC", "2026-10-05T00:00:00.000Z")).toEqual([
      "2026-11-02T09:00:00.000Z",
    ]);
    expect(fires("at(2026-11-02T09:00:00)", "UTC", "2026-11-02T09:00:00.000Z")).toEqual([]);
  });

  test("day-of-month and day-of-week specials pick the right calendar day", () => {
    expect(fires("cron(0 18 L * ? *)", "UTC", "2026-02-10T00:00:00.000Z")).toEqual([
      "2026-02-28T18:00:00.000Z",
    ]);
    expect(fires("cron(0 10 ? * 2#1 *)", "UTC", "2026-10-06T00:00:00.000Z")).toEqual([
      "2026-11-02T10:00:00.000Z",
    ]);
    expect(fires("cron(0 9 15W * ? *)", "UTC", "2026-11-01T00:00:00.000Z")).toEqual([
      "2026-11-16T09:00:00.000Z",
    ]);
  });

  test("a cron limited to a past year has no future fire", () => {
    expect(fires("cron(0 0 1 1 ? 2025)", "UTC", "2026-10-05T00:00:00.000Z")).toEqual([]);
    expect(fires("cron(0 0 1 1 ? 2027)", "UTC", "2026-10-05T00:00:00.000Z")).toEqual([
      "2027-01-01T00:00:00.000Z",
    ]);
  });

  test("a rate steps from its anchor and has no fires without one", () => {
    const rate = schedule("rate(10 minutes)");
    const after = new Date("2026-10-05T12:34:00.000Z");
    expect(nextScheduleFires(rate, after, 3, { scheduledFor: "2026-10-05T12:00:00Z" })).toEqual([
      "2026-10-05T12:40:00.000Z",
      "2026-10-05T12:50:00.000Z",
      "2026-10-05T13:00:00.000Z",
    ]);
    expect(nextScheduleFires(rate, after, 3)).toEqual([]);
  });

  test("a cron skips a wall time that springing forward removes and fires once in a repeated hour", () => {
    expect(fires("cron(30 2 * * ? *)", "America/New_York", "2026-03-07T12:00:00.000Z", 2)).toEqual([
      "2026-03-09T06:30:00.000Z",
      "2026-03-10T06:30:00.000Z",
    ]);
    expect(fires("cron(30 1 * * ? *)", "America/New_York", "2026-10-31T12:00:00.000Z", 2)).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);
  });
});

describe("zonedInstant", () => {
  test("a wall time inside a spring-forward gap moves forward by the gap", () => {
    expect(zonedInstant("2026-03-08T02:30:00", "America/New_York")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
  });

  test("a repeated wall time resolves to its first occurrence", () => {
    expect(zonedInstant("2026-11-01T01:30:00", "America/New_York")).toBe(
      "2026-11-01T05:30:00.000Z",
    );
    expect(zonedInstant("2026-10-25T02:30:00", "Europe/Berlin")).toBe("2026-10-25T00:30:00.000Z");
  });
});
