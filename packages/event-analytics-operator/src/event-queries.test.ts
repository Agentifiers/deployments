import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  eventTypeCountsQuery,
  InvalidRequestError,
  recentEventsQuery,
  SEMANTIC_EVENT_COLUMNS,
  timeWindow,
} from "./event-queries.ts";
import { fixedNow, testCoordinates } from "./fake-athena.fixture.ts";

const table = '"s3tablescatalog/semantic-events"."semantic_events"."events"';

describe("recent events query", () => {
  it("keeps one delivery per event ID over the last 24 hours by default", () => {
    const query = recentEventsQuery({ coordinates: testCoordinates, now: fixedNow, request: {} });
    expect(query.maxRows).toBe(50);
    expect(query.sql).toContain(`FROM ${table}`);
    expect(query.sql).toContain(
      "PARTITION BY event_id\n      ORDER BY ingested_at DESC, eventbridge_event_id DESC",
    );
    expect(query.sql).toContain("WHERE delivery_rank = 1");
    expect(query.sql).toContain(
      "from_iso8601_timestamp(occurred_at) >= from_iso8601_timestamp('2026-10-15T12:00:00.000Z')",
    );
    expect(query.sql).toContain(
      "from_iso8601_timestamp(occurred_at) < from_iso8601_timestamp('2026-10-16T12:00:00.000Z')",
    );
    expect(query.sql).not.toContain("payload_json");
    expect(query.sql.endsWith("LIMIT 51")).toBe(true);
  });

  it("filters by organization, exact or prefixed event type, and an explicit window", () => {
    const exact = recentEventsQuery({
      coordinates: testCoordinates,
      now: fixedNow,
      request: {
        event_type: "agent.created",
        include_payload: true,
        limit: 5,
        organization_id: "01JA0000000000000000000001",
        since: "2026-10-01",
        until: "2026-10-02T06:30:00Z",
      },
    });
    expect(exact.sql).toContain("AND organization_id = '01JA0000000000000000000001'");
    expect(exact.sql).toContain("AND event_type = 'agent.created'");
    expect(exact.sql).toContain("from_iso8601_timestamp('2026-10-01T00:00:00.000Z')");
    expect(exact.sql).toContain("from_iso8601_timestamp('2026-10-02T06:30:00.000Z')");
    expect(exact.sql).toContain("trace_id, payload_json");
    expect(exact.sql.endsWith("LIMIT 6")).toBe(true);

    const prefixed = recentEventsQuery({
      coordinates: testCoordinates,
      now: fixedNow,
      request: { event_type: "agent.*" },
    });
    expect(prefixed.sql).toContain("AND starts_with(event_type, 'agent.')");
  });
});

describe("event type counts query", () => {
  it("counts distinct event IDs per type, busiest first", () => {
    const query = eventTypeCountsQuery({
      coordinates: testCoordinates,
      now: fixedNow,
      request: { since: "7d" },
    });
    expect(query.maxRows).toBe(100);
    expect(query.sql).toBe(`SELECT event_type, count(DISTINCT event_id) AS event_count
FROM ${table}
WHERE from_iso8601_timestamp(occurred_at) >= from_iso8601_timestamp('2026-10-09T12:00:00.000Z')
    AND from_iso8601_timestamp(occurred_at) < from_iso8601_timestamp('2026-10-16T12:00:00.000Z')
GROUP BY event_type
ORDER BY event_count DESC, event_type ASC
LIMIT 101`);
  });
});

describe("time windows", () => {
  it("resolves relative ages against now", () => {
    expect(
      timeWindow({ defaultSince: "24h", now: fixedNow, since: "30m", until: undefined }),
    ).toEqual({
      since: new Date("2026-10-16T11:30:00.000Z"),
      until: fixedNow,
    });
  });

  it("rejects an empty or inverted window and an impossible date", () => {
    expect(() =>
      timeWindow({ defaultSince: "24h", now: fixedNow, since: "1h", until: "2h" }),
    ).toThrow(InvalidRequestError);
    expect(() =>
      timeWindow({ defaultSince: "24h", now: fixedNow, since: "2026-13-45", until: undefined }),
    ).toThrow("not a valid time");
  });
});

describe("semantic event columns", () => {
  it("match the Iceberg table platform-data creates", async () => {
    const source = await readFile(
      path.resolve(import.meta.dir, "../../../infrastructure/modules/platform-data/main.tf"),
      "utf8",
    );
    const block = /semantic_event_columns = \[([\s\S]*?)\n {2}\]/u.exec(source)?.[1] ?? "";
    const columns = [...block.matchAll(/\{ name = "([a-z_]+)", type = "([a-z]+)" \}/gu)].map(
      ([, name = "", type = ""]) => `${name}:${type}`,
    );
    expect(columns.length).toBeGreaterThan(0);
    expect(SEMANTIC_EVENT_COLUMNS.map(({ name, type }) => `${name}:${type}`)).toEqual(columns);
  });
});
