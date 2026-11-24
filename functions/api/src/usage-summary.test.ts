import { describe, expect, test } from "bun:test";
import {
  reconcileLedger as reconcileCells,
  tallyLedger,
  type LedgerRecord,
  type LedgerSummary,
  type SummarySeries,
  type SummaryWindow,
} from "./usage-summary.ts";

/** One read: tally every record, then reconcile. */
const reconcileLedger = (records: readonly LedgerRecord[], window: SummaryWindow) =>
  reconcileCells(tallyLedger(records), window);

const HOURLY: SummaryWindow = {
  interval: "hour",
  since: "2026-10-01T00:00:00.000Z",
  until: "2026-10-01T03:00:00.000Z",
};

function event(
  id: string,
  occurredAt: string,
  quantity: number,
  metric = "model_tokens",
  dimensions: Record<string, unknown> = {},
): LedgerRecord {
  const unit = metric === "model_tokens" ? "tokens" : "count";
  return { data: { dimensions, id, metric, occurredAt, quantity, unit }, type: "meter-event" };
}

function shard(
  metric: string,
  bucket: string,
  shardIndex: number,
  quantity: number,
  version = 0,
  unit = "tokens",
): LedgerRecord {
  return {
    data: { bucket, metric, quantity, shard: shardIndex, unit, version },
    type: "usage-counter-shard",
  };
}

function series(
  usage: LedgerSummary,
  match: { readonly [Key in keyof SummarySeries]?: SummarySeries[Key] | undefined },
) {
  return usage.series.find((entry) =>
    Object.entries(match).every(([key, value]) => entry[key as keyof SummarySeries] === value),
  );
}

describe("tallyLedger", () => {
  test("tallies of disjoint reads concatenate to the tally of the whole read", () => {
    const records = [
      event("01A", "2026-10-01T00:10:00.000Z", 100, "model_tokens", { inputTokens: 90 }),
      shard("model_tokens", "2026-10-01T00:00:00.000Z", 3, 60),
      event("01B", "2026-10-01T00:50:00.000Z", 50, "model_tokens", { inputTokens: 40 }),
      shard("model_tokens", "2026-10-01T00:00:00.000Z", 9, 90),
      shard("model_tokens.cost_usd_micros", "2026-10-01T01:00:00.000Z", 0, 7, 0, "usd_micros"),
    ];
    const whole = reconcileLedger(records, HOURLY);
    const paged = reconcileCells(
      [...tallyLedger(records.slice(0, 2)), ...tallyLedger(records.slice(2))],
      HOURLY,
    );
    expect(paged).toEqual(whole);
    expect(series(paged, { metric: "model_tokens", part: undefined })?.values).toEqual([150, 0, 0]);
    expect(series(paged, { part: "input" })?.total).toBe(130);
  });
});
describe("reconcileLedger", () => {
  test("events and the counter shards built from them count once per hour", () => {
    const usage = reconcileLedger(
      [
        event("01A", "2026-10-01T00:10:00.000Z", 100),
        event("01B", "2026-10-01T00:50:00.000Z", 50),
        // The same 150 tokens, materialized across two shards.
        shard("model_tokens", "2026-10-01T00:00:00.000Z", 3, 100),
        shard("model_tokens", "2026-10-01T00:00:00.000Z", 9, 50),
      ],
      HOURLY,
    );
    expect(series(usage, { kind: "quantity", metric: "model_tokens", part: undefined })).toEqual(
      expect.objectContaining({ total: 150, values: [150, 0, 0] }),
    );
  });

  test("the larger of events and shards wins an hour: lagging shards or missing events", () => {
    const usage = reconcileLedger(
      [
        // Hour 0: the materializer has not caught up with the second event.
        event("01A", "2026-10-01T00:10:00.000Z", 100),
        event("01B", "2026-10-01T00:20:00.000Z", 40),
        shard("model_tokens", "2026-10-01T00:00:00.000Z", 1, 100),
        // Hour 1: counters only (events outside this read).
        shard("model_tokens", "2026-10-01T01:00:00.000Z", 1, 70),
        shard("model_tokens", "2026-10-01T01:00:00.000Z", 2, 5),
      ],
      HOURLY,
    );
    expect(series(usage, { metric: "model_tokens", part: undefined })?.values).toEqual([
      140, 75, 0,
    ]);
  });

  test("a shard read at two versions or twice counts once, at its latest version", () => {
    const usage = reconcileLedger(
      [
        shard("sandbox_ms", "2026-10-01T02:00:00.000Z", 4, 1_000, 3, "ms"),
        shard("sandbox_ms", "2026-10-01T02:00:00.000Z", 4, 1_500, 4, "ms"),
        shard("sandbox_ms", "2026-10-01T02:00:00.000Z", 4, 1_000, 3, "ms"),
        event("01C", "2026-10-01T02:30:00.000Z", 9, "brain.retrieval"),
        event("01C", "2026-10-01T02:30:00.000Z", 9, "brain.retrieval"),
      ],
      HOURLY,
    );
    expect(series(usage, { metric: "sandbox_ms" })?.values).toEqual([0, 0, 1_500]);
    expect(series(usage, { metric: "brain.retrieval" })?.total).toBe(9);
  });

  test("token splits come from event dimensions and never inflate the total", () => {
    const usage = reconcileLedger(
      [
        event("01A", "2026-10-01T00:05:00.000Z", 120, "model_tokens", {
          cacheWriteInputTokens: 5,
          cachedInputTokens: 30,
          inputTokens: 100,
          outputTokens: 20,
        }),
        event("01B", "2026-10-01T00:06:00.000Z", 10, "model_tokens", { inputTokens: 10 }),
        shard("model_tokens", "2026-10-01T00:00:00.000Z", 0, 130),
      ],
      HOURLY,
    );
    expect(series(usage, { metric: "model_tokens", part: undefined })?.total).toBe(130);
    expect(series(usage, { part: "input" })?.total).toBe(110);
    expect(series(usage, { part: "output" })?.total).toBe(20);
    expect(series(usage, { part: "cached" })?.total).toBe(30);
    expect(series(usage, { part: "cache-write" })?.total).toBe(5);
  });

  test("usage-aggregate rollups count only for metrics without events or shards", () => {
    const aggregate = (metric: string, quantity: number): LedgerRecord => ({
      data: { bucket: "2026-10-01T00:00:00.000Z", metric, quantity, unit: "tokens", version: 1 },
      type: "usage-aggregate",
    });
    const usage = reconcileLedger(
      [
        shard("model_tokens", "2026-10-01T01:00:00.000Z", 0, 10),
        aggregate("model_tokens", 999),
        aggregate("worker_ms", 60),
      ],
      HOURLY,
    );
    expect(series(usage, { metric: "model_tokens", part: undefined })?.values).toEqual([0, 10, 0]);
    expect(series(usage, { metric: "worker_ms" })?.total).toBe(60);
  });

  test("inbox-usage stands in for agent email meters only when they are absent", () => {
    const inbox: LedgerRecord = {
      data: {
        attachmentBytes: 2_048,
        bucket: "2026-10-01T00:00:00.000Z",
        inboundMessages: 7,
        inboxId: "01INBOX",
        outboundMessages: 3,
        recipients: 4,
        version: 2,
      },
      type: "inbox-usage",
    };
    const meters = reconcileLedger(
      [event("01E", "2026-10-01T00:01:00.000Z", 1, "agent_email.inbound_message"), inbox],
      HOURLY,
    );
    expect(series(meters, { metric: "agent_email.inbound_message" })?.total).toBe(1);
    // Outbound has no meter of its own in this read, so the rollup supplies it.
    expect(series(meters, { metric: "agent_email.outbound_message" })?.total).toBe(3);
    const rollupOnly = reconcileLedger([inbox], HOURLY);
    expect(series(rollupOnly, { metric: "agent_email.inbound_message" })?.total).toBe(7);
    expect(series(rollupOnly, { metric: "agent_email.attachment_bytes" })?.unit).toBe("bytes");
  });

  test("costs: micro and nanodollar counters are alternatives; the larger sum wins", () => {
    const usage = reconcileLedger(
      [
        // Every event carried micros; one also carried exact nanodollars.
        shard("model_tokens.cost_usd_micros", "2026-10-01T00:00:00.000Z", 0, 12, 0, "usd_micros"),
        shard("model_tokens.cost_usd_micros", "2026-10-01T00:00:00.000Z", 1, 3, 0, "usd_micros"),
        shard(
          "model_tokens.cost_usd_nanodollars",
          "2026-10-01T00:00:00.000Z",
          0,
          2_600,
          0,
          "usd_nanodollars",
        ),
        // Hour 1: catalog-priced events carry both; nanodollars are exact.
        shard("model_tokens.cost_usd_micros", "2026-10-01T01:00:00.000Z", 0, 2, 0, "usd_micros"),
        shard(
          "model_tokens.cost_usd_nanodollars",
          "2026-10-01T01:00:00.000Z",
          0,
          2_400,
          0,
          "usd_nanodollars",
        ),
      ],
      HOURLY,
    );
    expect(series(usage, { kind: "cost", metric: "model_tokens" })).toEqual(
      expect.objectContaining({ unit: "usd_nanodollars", values: [15_000, 2_400, 0] }),
    );
  });

  test("cost-aggregate (USD cents) stands beside other metrics' cost counters", () => {
    const costAggregate = (source: string): LedgerRecord => ({
      data: {
        bucket: "2026-10-01T00:00:00.000Z",
        costs: { [source]: 7 },
        currency: "USD",
        source,
        totalMinor: 7,
        version: 1,
      },
      type: "cost-aggregate",
    });
    const usage = reconcileLedger(
      [
        costAggregate("model"),
        costAggregate("sandbox_ms"),
        shard("sandbox_ms.cost_usd_micros", "2026-10-01T00:00:00.000Z", 0, 5, 0, "usd_micros"),
      ],
      HOURLY,
    );
    // An unrelated source is not dropped; a source named like a costed metric yields to it.
    expect(usage.series.filter((entry) => entry.kind === "cost")).toEqual([
      expect.objectContaining({ metric: "model", total: 70_000_000 }),
      expect.objectContaining({ metric: "sandbox_ms", total: 5_000 }),
    ]);
  });

  test("daily buckets sum their hours; hours outside the window are dropped", () => {
    const daily: SummaryWindow = {
      interval: "day",
      since: "2026-09-30T00:00:00.000Z",
      until: "2026-10-02T00:00:00.000Z",
    };
    const usage = reconcileLedger(
      [
        shard("sandbox_ms", "2026-09-30T05:00:00.000Z", 0, 10, 0, "ms"),
        shard("sandbox_ms", "2026-09-30T23:00:00.000Z", 0, 20, 0, "ms"),
        shard("sandbox_ms", "2026-10-01T00:00:00.000Z", 0, 30, 0, "ms"),
        shard("sandbox_ms", "2026-10-02T00:00:00.000Z", 0, 99, 0, "ms"),
        shard("sandbox_ms", "2026-09-29T23:00:00.000Z", 0, 99, 0, "ms"),
      ],
      daily,
    );
    expect(usage.buckets).toEqual(["2026-09-30T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
    expect(series(usage, { metric: "sandbox_ms" })).toEqual(
      expect.objectContaining({ total: 60, values: [30, 30] }),
    );
  });

  test("records without a usable time or quantity, and unknown types, are ignored", () => {
    const usage = reconcileLedger(
      [
        {
          data: { bucket: "not a time", metric: "x", quantity: 1, shard: 0 },
          type: "usage-counter-shard",
        },
        {
          data: { id: "01Z", metric: "x", occurredAt: "2026-10-01T00:00:00.000Z" },
          type: "meter-event",
        },
        { data: { amount: { amountMinor: 1 } }, type: "spend-ledger" },
      ],
      HOURLY,
    );
    expect(usage.series).toEqual([]);
    expect(usage.buckets).toHaveLength(3);
  });
});
