import "@tanstack/react-start/server-only";
import { agentLabels, groupLabel, UNATTRIBUTED } from "../observability/agent-labels.ts";
import { bucketStarts, metricWindow, type MetricWindow } from "../observability/range.ts";
import { groupedMetrics, type GroupedMetrics } from "../observability/series.ts";
import type { EnvironmentScope } from "../scope.ts";
import {
  agentSeries,
  bucketTraces,
  deploymentSeries,
  type AgentUsage,
} from "../usage/agent-usage.ts";
import { seriesOrder } from "../usage/catalog.ts";
import type { LedgerSeries, LedgerView } from "../usage/ledger.ts";
import type { UsagePeriod, UsageSelection } from "../usage/selection.ts";
import { loadAgentDirectory } from "./agent-directory.ts";
import { readTraces, summarizeTraces } from "./agent-metrics.ts";
import { requirePublicIds } from "./console-data.ts";
import { createHotPlaneQueue } from "./hot-plane-queue.ts";
import { callRoute } from "./platform-api.ts";

export interface UsageBreakdown {
  readonly grouped: GroupedMetrics;
  readonly window: MetricWindow;
}

/**
 * The period's ledger: `GET /v1/usage/summary` and, with `includeCosts`, `GET /v1/costs/summary`
 * over the period's bucket-aligned window, one request each, of the environment or (with
 * `definitionId`) of that agent's runs. The API reconciles the ledger's representations (meter
 * events, hourly counters, rollups) into one series per metric.
 */
export async function loadLedger(
  accessToken: string,
  scope: EnvironmentScope,
  period: UsagePeriod,
  includeCosts: boolean,
  definitionId?: string,
): Promise<LedgerView> {
  requirePublicIds({ ...scope, ...(definitionId ? { definitionId } : {}) });
  const window = metricWindow(period, new Date());
  const query = {
    ...(definitionId ? { agentDefinitionId: definitionId } : {}),
    interval: window.interval,
    since: window.from,
    until: window.to,
  };
  const [usage, costs] = await Promise.all([
    callRoute("getUsageSummary", { query, scope }, accessToken),
    includeCosts ? callRoute("getCostSummary", { query, scope }, accessToken) : undefined,
  ]);
  const series: LedgerSeries[] = [...usage.series, ...(costs?.series ?? [])].map((entry) => ({
    ...entry,
    id: [entry.kind, entry.metric, entry.part ?? "", entry.unit].join("/"),
  }));
  return {
    costs: includeCosts,
    usage: { buckets: usage.buckets, series: series.toSorted(seriesOrder) },
    window,
  };
}

/** Tokens and cost by agent, model, or provider from the observability hot plane. */
export async function loadUsageBreakdown(
  accessToken: string,
  scope: EnvironmentScope,
  selection: UsageSelection,
): Promise<UsageBreakdown> {
  requirePublicIds({ ...scope });
  const window = metricWindow(selection, new Date());
  const hotPlane = createHotPlaneQueue(accessToken);
  const { groupBy } = selection;
  const [series, directory] = await Promise.all([
    hotPlane("getObservabilityMetrics", {
      query: { from: window.from, groupBy, interval: window.interval, to: window.to },
      scope,
    }),
    groupBy === "agentDefinitionId" ? loadAgentDirectory(accessToken, scope) : undefined,
  ]);
  return {
    grouped: groupedMetrics(
      series,
      bucketStarts(window),
      groupLabel(groupBy, directory ? agentLabels(directory) : undefined),
    ),
    window,
  };
}

/**
 * One agent's tokens and cost over the period. When the agent ranks among the hot plane's
 * busiest agents, its group of the per-definition series and the environment's per-deployment
 * series answer (the client keeps the deployments that belong to the agent, since it already holds
 * them and the API has no per-definition deployment filter). Otherwise the agent's own traces are
 * totalled and bucketed (`readTraces`, `summarizeTraces`), split by their deployment.
 */
export async function loadAgentUsage(
  accessToken: string,
  scope: EnvironmentScope,
  definitionId: string,
  period: UsagePeriod,
): Promise<AgentUsage> {
  requirePublicIds({ ...scope, definitionId });
  const window = metricWindow(period, new Date());
  const query = { from: window.from, interval: window.interval, to: window.to };
  const hotPlane = createHotPlaneQueue(accessToken);
  const [byDefinition, byDeployment] = await Promise.all([
    hotPlane("getObservabilityMetrics", {
      query: { ...query, groupBy: "agentDefinitionId" },
      scope,
    }),
    hotPlane("getObservabilityMetrics", {
      query: { ...query, groupBy: "agentDeploymentId" },
      scope,
    }),
  ]);
  const buckets = bucketStarts(window);
  const label = (groupValue: string | null) => groupValue ?? UNATTRIBUTED;
  const ranked = agentSeries(groupedMetrics(byDefinition, buckets, label), definitionId);
  if (ranked.status !== "unranked") {
    return {
      ...ranked,
      basis: "metrics",
      deployments: deploymentSeries(groupedMetrics(byDeployment, buckets, label)),
      status: ranked.status,
      window,
    };
  }
  const traces = await readTraces(hotPlane, scope, window, { agentDefinitionId: definitionId });
  if (!traces) {
    const empty = { complete: true, costUsdMicros: [], groups: [], tokens: [] };
    return { ...ranked, basis: "traces", deployments: empty, status: "truncated", window };
  }
  const { [definitionId]: totals } = summarizeTraces(traces, () => definitionId);
  const rows = bucketTraces(traces, window, buckets, () => definitionId).get(definitionId);
  const perDeployment = bucketTraces(traces, window, buckets, (trace) => trace.agent_deployment_id);
  const deploymentTotals = summarizeTraces(traces, (trace) => trace.agent_deployment_id);
  const deployments = [...perDeployment].toSorted(
    ([left], [right]) => deploymentTotals[right]!.traces - deploymentTotals[left]!.traces,
  );
  return {
    basis: "traces",
    deployments: {
      complete: true,
      costUsdMicros: deployments.map(([, series]) => series.map((row) => row.costUsdMicros)),
      groups: deployments.map(([id], index) => {
        const { costUsdMicros, errors, tokens, traces: count } = deploymentTotals[id]!;
        return {
          groupValue: id,
          key: `s${index}`,
          label: id,
          totals: { costUsdMicros, errors, source: "traces", tokens, traces: count },
        };
      }),
      tokens: deployments.map(([, series]) => series.map((row) => row.tokens)),
    },
    rows: rows ?? ranked.rows,
    status: totals ? "found" : "absent",
    totals: totals
      ? {
          costUsdMicros: totals.costUsdMicros,
          errors: totals.errors,
          tokens: totals.tokens,
          traces: totals.traces,
        }
      : ranked.totals,
    window,
  };
}
