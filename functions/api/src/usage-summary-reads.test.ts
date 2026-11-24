import { describe, expect, test } from "bun:test";
import {
  attributedCounterShard,
  counterShard,
  database,
  fixtureRecords,
  invocation,
  meterEvent,
  operationalService,
} from "./operational-reads.fixture.ts";

const DAY = { since: "2026-07-25T00:00:00.000Z", until: "2026-07-26T00:00:00.000Z" };

function ledger() {
  return [
    ...fixtureRecords(),
    // Two model calls at 10:00 and their materialized counter; their costs as counters.
    meterEvent(1, "model_tokens", "2026-07-25T10:05:00.000Z", 120, "tokens", {
      inputTokens: 100,
      outputTokens: 20,
    }),
    meterEvent(2, "model_tokens", "2026-07-25T10:40:00.000Z", 30, "tokens", { inputTokens: 30 }),
    counterShard("model_tokens", "2026-07-25T10:00:00.000Z", 4, 150, "tokens"),
    counterShard("model_tokens.cost_usd_micros", "2026-07-25T10:00:00.000Z", 4, 9, "usd_micros"),
    // Worker time on the next day is outside a one-day window.
    counterShard("worker_ms", "2026-07-25T23:00:00.000Z", 1, 500, "ms"),
    counterShard("worker_ms", "2026-07-26T00:00:00.000Z", 1, 700, "ms"),
  ];
}

function series(
  summary: { readonly series: readonly Readonly<Record<string, unknown>>[] },
  metric: string,
  part?: string,
) {
  return summary.series.find((entry) => entry.metric === metric && entry.part === part);
}

describe("usage and cost summaries", () => {
  test("hourly usage: counter totals, token splits from events, and no cost series", async () => {
    const service = operationalService(database(ledger()));
    const summary = await service.getUsageSummary({ ...invocation, query: DAY });

    expect(summary.buckets).toHaveLength(24);
    expect(summary.interval).toBe("hour");
    expect(series(summary, "model_tokens")).toMatchObject({ kind: "quantity", total: 150 });
    expect((series(summary, "model_tokens")!.values as number[])[10]).toBe(150);
    expect(series(summary, "model_tokens", "input")).toMatchObject({ total: 130 });
    expect(series(summary, "model_tokens", "output")).toMatchObject({ total: 20 });
    expect(series(summary, "worker_ms")).toMatchObject({ total: 500, unit: "ms" });
    expect(summary.series.some((entry) => entry.kind === "cost")).toBe(false);
  });

  test("costs: nanodollar series per costed metric and cost source", async () => {
    const service = operationalService(database(ledger()));
    const summary = await service.getCostSummary({
      ...invocation,
      query: { ...DAY, interval: "day" },
    });

    expect(summary.buckets).toEqual([DAY.since]);
    expect(summary.series).toEqual([
      // The fixture's `model` cost-aggregate: 7 USD cents.
      expect.objectContaining({ kind: "cost", metric: "model", total: 70_000_000 }),
      expect.objectContaining({
        kind: "cost",
        metric: "model_tokens",
        total: 9_000,
        unit: "usd_nanodollars",
        values: [9_000],
      }),
    ]);
  });

  test("daily buckets span the window's day slices; midnight activity counts once", async () => {
    const midnight = "2026-07-26T00:00:00.000Z";
    const records = [
      ...ledger(),
      meterEvent(3, "model_tokens", midnight, 40, "tokens", { inputTokens: 40 }),
      counterShard("model_tokens", midnight, 2, 40, "tokens"),
    ];
    const summary = await operationalService(database(records)).getUsageSummary({
      ...invocation,
      query: { interval: "day", since: DAY.since, until: "2026-07-27T00:00:00.000Z" },
    });

    expect(series(summary, "model_tokens")?.values).toEqual([150, 40]);
    expect(series(summary, "model_tokens", "input")?.values).toEqual([130, 40]);
    expect(series(summary, "worker_ms")?.values).toEqual([500, 700]);
  });

  test("an agent's summary holds only its runs' counters, with token splits", async () => {
    const agent = { attribution: "agent", attributionId: "01ARZ3NDEKTSV4RRFFQ69G5FC1" } as const;
    const other = { attribution: "agent", attributionId: "01ARZ3NDEKTSV4RRFFQ69G5FC2" } as const;
    const hour = "2026-07-25T10:00:00.000Z";
    const records = [
      ...ledger(),
      attributedCounterShard(agent, "model_tokens", hour, 120, "tokens", {
        input: 100,
        output: 20,
      }),
      attributedCounterShard(agent, "model_tokens.cost_usd_micros", hour, 6, "usd_micros"),
      attributedCounterShard(agent, "worker_ms", hour, 40, "ms"),
      // Outside the window, and another agent's runs.
      attributedCounterShard(agent, "worker_ms", "2026-07-26T00:00:00.000Z", 9, "ms"),
      attributedCounterShard(other, "model_tokens", hour, 30, "tokens", { input: 30 }),
    ];
    const service = operationalService(database(records));
    const query = { ...DAY, agentDefinitionId: agent.attributionId, interval: "day" };
    const usage = await service.getUsageSummary({ ...invocation, query });
    const costs = await service.getCostSummary({ ...invocation, query });

    expect(usage.series).toEqual([
      expect.objectContaining({ metric: "model_tokens", total: 120, values: [120] }),
      expect.objectContaining({ metric: "model_tokens", part: "input", total: 100 }),
      expect.objectContaining({ metric: "model_tokens", part: "output", total: 20 }),
      expect.objectContaining({ metric: "worker_ms", total: 40, unit: "ms" }),
    ]);
    expect(costs.series).toEqual([
      expect.objectContaining({ kind: "cost", metric: "model_tokens", total: 6_000 }),
    ]);
  });

  test("a workspace's summary holds only the usage that names it, with token splits", async () => {
    const workspace = "01ARZ3NDEKTSV4RRFFQ69G5FD1";
    const sibling = "01ARZ3NDEKTSV4RRFFQ69G5FD2";
    const hour = "2026-07-25T10:00:00.000Z";
    const of = (attributionId: string) => ({ attribution: "workspace", attributionId }) as const;
    const records = [
      // The environment ledger holds 150 model tokens and 500 ms of worker time.
      ...ledger(),
      attributedCounterShard(of(workspace), "model_tokens", hour, 110, "tokens", {
        cached: 4,
        input: 90,
        output: 20,
      }),
      attributedCounterShard(of(workspace), "model_tokens.cost_usd_micros", hour, 7, "usd_micros"),
      attributedCounterShard(of(workspace), "worker_ms", hour, 300, "ms"),
      attributedCounterShard(of(sibling), "model_tokens", hour, 40, "tokens", {
        input: 40,
      }),
      attributedCounterShard(of(sibling), "model_tokens.cost_usd_micros", hour, 2, "usd_micros"),
      attributedCounterShard(of(sibling), "worker_ms", hour, 200, "ms"),
    ];
    const service = operationalService(database(records));
    const query = (id: string) => ({ ...DAY, interval: "day", workspaceId: id });

    expect(
      (await service.getUsageSummary({ ...invocation, query: query(workspace) })).series,
    ).toEqual([
      expect.objectContaining({ metric: "model_tokens", total: 110, values: [110] }),
      expect.objectContaining({ metric: "model_tokens", part: "cached", total: 4 }),
      expect.objectContaining({ metric: "model_tokens", part: "input", total: 90 }),
      expect.objectContaining({ metric: "model_tokens", part: "output", total: 20 }),
      expect.objectContaining({ metric: "worker_ms", total: 300, unit: "ms" }),
    ]);
    expect(
      (await service.getCostSummary({ ...invocation, query: query(workspace) })).series,
    ).toEqual([expect.objectContaining({ kind: "cost", metric: "model_tokens", total: 7_000 })]);
    expect(
      (await service.getUsageSummary({ ...invocation, query: query(sibling) })).series,
    ).toEqual([
      expect.objectContaining({ metric: "model_tokens", total: 40 }),
      expect.objectContaining({ metric: "model_tokens", part: "input", total: 40 }),
      expect.objectContaining({ metric: "worker_ms", total: 200 }),
    ]);
    expect(
      series(await service.getUsageSummary({ ...invocation, query: DAY }), "model_tokens"),
    ).toMatchObject({ total: 150 });
    // Like an agent, a workspace with no counters in the environment has no series.
    expect(
      (await service.getUsageSummary({ ...invocation, query: query("01ARZ3NDEKTSV4RRFFQ69G5FD3") }))
        .series,
    ).toEqual([]);
  });

  test.each([
    [{ since: DAY.since }, "since and until are required."],
    [{ ...DAY, since: "2026-07-25T00:30:00.000Z" }, "since and until must fall on UTC hour"],
    [{ ...DAY, interval: "week" }, "interval must be hour or day."],
    [{ since: DAY.since, until: "2026-09-01T00:00:00.000Z" }, "at most 744 hour buckets"],
    [{ interval: "day", since: DAY.until, until: DAY.since }, "since must be earlier"],
    [{ ...DAY, agentDefinitionId: "agent-1" }, "agentDefinitionId must be a ULID."],
    [{ ...DAY, workspaceId: "workspace-1" }, "workspaceId must be a ULID."],
    [
      {
        ...DAY,
        agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
        workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FD1",
      },
      "Name at most one of agentDefinitionId, workspaceId.",
    ],
  ])("rejects window %j", async (query, message) => {
    const service = operationalService(database(ledger()));
    const failure = await service.getUsageSummary({ ...invocation, query }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ status: 400 });
    expect(String((failure as Error).message)).toContain(message);
  });
});
