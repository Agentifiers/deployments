import { describe, expect, test } from "bun:test";
import type { GroupedMetrics, TraceMetric } from "../observability/series.ts";
import type { TraceSummary } from "../observability/traces.ts";
import {
  agentDeploymentSplit,
  agentSeries,
  bucketTraces,
  deploymentSeries,
  METRIC_GROUP_LIMIT,
} from "./agent-usage.ts";

const BUCKETS = ["2026-10-01T00:00:00.000Z", "2026-10-01T01:00:00.000Z"];

/** A traces-sourced grouped series; each group gives tokens and cost per bucket. */
function grouped(
  groups: readonly {
    readonly cost: number[];
    readonly id: string | null;
    readonly tokens: number[];
  }[],
): GroupedMetrics {
  const column = (read: (group: (typeof groups)[number]) => (number | null)[]) => groups.map(read);
  const values: Record<TraceMetric, (number | null)[][]> = {
    costUsdMicros: column((group) => group.cost),
    errors: column(() => [0, 0]),
    p95: column(() => [null, null]),
    tokens: column((group) => group.tokens),
    traces: column((group) => group.tokens.map((value) => (value > 0 ? 1 : 0))),
  };
  return {
    buckets: BUCKETS,
    groups: groups.map((group, index) => ({
      groupValue: group.id,
      key: `s${index}`,
      label: group.id ?? "Unattributed",
      totals: {
        costUsdMicros: group.cost.reduce((sum, value) => sum + value, 0),
        errors: 0,
        source: "traces",
        tokens: group.tokens.reduce((sum, value) => sum + value, 0),
        traces: group.tokens.filter((value) => value > 0).length,
      },
    })),
    source: "traces",
    values,
  };
}

describe("agentSeries", () => {
  test("picks the definition's group as zero-filled trace buckets", () => {
    const result = agentSeries(
      grouped([
        { cost: [5, 0], id: "OTHER", tokens: [9, 0] },
        { cost: [1, 2], id: "AGENT", tokens: [10, 20] },
      ]),
      "AGENT",
    );
    expect(result.status).toBe("found");
    expect(result.totals).toEqual({ costUsdMicros: 3, errors: 0, tokens: 30, traces: 2 });
    expect(result.rows.map((row) => row.tokens)).toEqual([10, 20]);
  });

  test("a missing agent is absent below the group limit and unranked at it", () => {
    const few = grouped([{ cost: [0, 0], id: "OTHER", tokens: [1, 0] }]);
    expect(agentSeries(few, "AGENT").status).toBe("absent");
    const full = grouped(
      Array.from({ length: METRIC_GROUP_LIMIT }, (_, index) => ({
        cost: [0, 0],
        id: `D${index}`,
        tokens: [1, 0],
      })),
    );
    expect(agentSeries(full, "AGENT")).toEqual(
      expect.objectContaining({
        status: "unranked",
        totals: expect.objectContaining({ tokens: 0 }),
      }),
    );
  });
});

describe("agentDeploymentSplit", () => {
  const agent = agentSeries(grouped([{ cost: [10, 10], id: "AGENT", tokens: [100, 50] }]), "AGENT");

  test("keeps the agent's deployments and groups the residual as Other, never negative", () => {
    const deployments = deploymentSeries(
      grouped([
        { cost: [6, 10], id: "MINE", tokens: [60, 50] },
        { cost: [99, 99], id: "SOMEONE_ELSE", tokens: [999, 999] },
        { cost: [1, 1], id: null, tokens: [1, 1] },
      ]),
    );
    const split = agentDeploymentSplit({ ...agent, deployments }, new Set(["MINE"]), "Other");
    expect(split.groups.map((group) => [group.groupValue, group.label])).toEqual([
      ["MINE", "MINE"],
      [null, "Other"],
    ]);
    expect(split.tokens).toEqual([
      [60, 50],
      [40, 0],
    ]);
    expect(split.costUsdMicros[1]).toEqual([4, 0]);
    expect(split.groups[1]!.totals).toEqual({ costUsdMicros: 4, tokens: 40, traces: 0 });
  });

  test("no Other group when the deployments account for everything", () => {
    const deployments = deploymentSeries(
      grouped([
        { cost: [4, 10], id: "A", tokens: [40, 50] },
        { cost: [6, 0], id: "B", tokens: [60, 0] },
      ]),
    );
    const split = agentDeploymentSplit({ ...agent, deployments }, new Set(["A", "B"]), "Other");
    expect(split.groups.map((group) => group.groupValue)).toEqual(["A", "B"]);
  });
});

describe("bucketTraces", () => {
  test("buckets traces by start per group, skipping ungrouped and out-of-window traces", () => {
    const trace = (occurred_at: string, deployment: string | undefined, tokens: number) =>
      ({
        agent_deployment_id: deployment,
        environment_id: "ENV",
        fact_id: occurred_at,
        occurred_at,
        status: tokens > 50 ? "error" : "ok",
        total_cost_usd_micros: tokens / 10,
        total_tokens: tokens,
      }) as unknown as TraceSummary;
    const window = {
      from: "2026-10-01T00:00:00.000Z",
      interval: "hour",
      to: "2026-10-01T02:00:00.000Z",
    } as const;
    const groups = bucketTraces(
      [
        trace("2026-10-01T00:10:00.000Z", "A", 10),
        trace("2026-10-01T01:59:59.000Z", "A", 60),
        trace("2026-10-01T00:30:00.000Z", undefined, 5),
        trace("2026-10-01T02:00:00.000Z", "A", 99),
        trace("2026-09-30T23:59:00.000Z", "B", 7),
      ],
      window,
      BUCKETS,
      (entry) => entry.agent_deployment_id,
    );
    expect([...groups.keys()]).toEqual(["A"]);
    expect(groups.get("A")).toEqual([
      { bucket: BUCKETS[0]!, costUsdMicros: 1, errors: 0, tokens: 10, traces: 1 },
      { bucket: BUCKETS[1]!, costUsdMicros: 6, errors: 1, tokens: 60, traces: 1 },
    ]);
  });
});
