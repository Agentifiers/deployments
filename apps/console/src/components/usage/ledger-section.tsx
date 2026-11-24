import { Download04Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ledgerUsageQuery } from "../../data/usage-queries.ts";
import { formatExact } from "../../observability/format.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Subheading } from "@/components/ui/heading";
import { Skeleton } from "@/components/ui/skeleton";
import { Code, Text } from "@/components/ui/text";
import { seriesLabel, type UsageFormat } from "../../usage/catalog.ts";
import { formatUsage, ledgerCsv, ledgerCsvFilename } from "../../usage/export.ts";
import type { LedgerSeries, LedgerUsage } from "../../usage/ledger.ts";
import type { UsagePeriod } from "../../usage/selection.ts";
import { downloadText } from "../download.ts";
import { Icon } from "../icon.tsx";
import { SourceNote, StatTile } from "../observability/panels.tsx";
import { LedgerPanel, LedgerSeriesChart } from "./ledger-charts.tsx";
import { LedgerTable } from "./ledger-table.tsx";

type SeriesFilter = (series: LedgerSeries) => boolean;

const quantityOf =
  (metric: string): SeriesFilter =>
  (series) =>
    series.kind === "quantity" && series.metric === metric && !series.part;

const MODEL_TOKENS = quantityOf("model_tokens");
const MODEL_COST: SeriesFilter = (series) =>
  series.kind === "cost" && series.metric === "model_tokens";
const SANDBOX_TIME = quantityOf("sandbox_ms");
const SANDBOX_COST: SeriesFilter = (series) =>
  series.kind === "cost" && series.metric.startsWith("sandbox_");
const EMAIL_MESSAGES: SeriesFilter = (series) =>
  series.kind === "quantity" &&
  (series.metric === "agent_email.inbound_message" ||
    series.metric === "agent_email.outbound_message");
const BRAIN_RETRIEVALS = quantityOf("brain.retrieval");

/**
 * The plan's ledger panels (§5.8), shown even when the period recorded nothing so an absent
 * metric reads as empty rather than missing. Metrics outside these panels get one each.
 */
const PANELS: readonly {
  readonly description: string;
  readonly kind: "area" | "bars" | "lines";
  readonly select: SeriesFilter;
  readonly title: string;
}[] = [
  {
    description: "Model tokens metered per bucket",
    kind: "area",
    select: MODEL_TOKENS,
    title: "Model tokens",
  },
  {
    description: "Input, output, cached input, and cache-write tokens from model meter events",
    kind: "lines",
    select: (series) => series.metric === "model_tokens" && series.part !== undefined,
    title: "Token types",
  },
  {
    description: "Model and sandbox cost per bucket",
    kind: "bars",
    select: (series) => series.kind === "cost",
    title: "Cost",
  },
  { description: "Sandbox lease time", kind: "area", select: SANDBOX_TIME, title: "Sandbox time" },
  {
    description: "Reserved vCPUs × sandbox time",
    kind: "area",
    select: quantityOf("sandbox_vcpu_ms"),
    title: "Sandbox vCPU",
  },
  {
    description: "Reserved memory × sandbox time",
    kind: "area",
    select: quantityOf("sandbox_memory_mib_ms"),
    title: "Sandbox memory",
  },
  {
    description: "Messages received and sent by agent inboxes",
    kind: "bars",
    select: EMAIL_MESSAGES,
    title: "Email messages",
  },
  {
    description: "Brain retrieval requests",
    kind: "area",
    select: BRAIN_RETRIEVALS,
    title: "Brain retrievals",
  },
];

/** Prose for metrics outside the plan's panels; any other metric shows its raw name. */
const METRIC_DESCRIPTIONS: Readonly<Record<string, string>> = {
  worker_ms: "Time agent runs spent executing on platform workers",
};

function total(usage: LedgerUsage, select: SeriesFilter) {
  return usage.series.filter(select).reduce((sum, series) => sum + series.total, 0);
}

/** While the ledger summary loads. */
export function LedgerLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Subheading>Metered usage</Subheading>
        <SourceNote source="ledger" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton className="h-24 rounded-xl" key={index} />
        ))}
      </div>
    </div>
  );
}

/**
 * Ledger totals, a series per metric, and the aggregated rows with CSV export (plan §5.8), all
 * from `GET /v1/usage/summary` and `GET /v1/costs/summary`. With `definitionId`, the series are
 * that agent's runs' own counters; inbox traffic belongs to no agent, so its panels are omitted.
 */
export function LedgerSection({
  definitionId,
  includeCosts,
  period,
  scope,
}: Readonly<{
  definitionId?: string;
  includeCosts: boolean;
  period: UsagePeriod;
  scope: EnvironmentScope;
}>) {
  const { data } = useSuspenseQuery(ledgerUsageQuery(scope, period, includeCosts, definitionId));
  const { usage, window } = data;
  const panels = definitionId ? PANELS.filter((panel) => panel.select !== EMAIL_MESSAGES) : PANELS;
  const costTile = (label: string, select: SeriesFilter) => (
    <StatTile
      detail={data.costs ? undefined : "Requires the spend:read scope"}
      label={label}
      value={data.costs ? formatUsage(total(usage, select), "usd") : "—"}
    />
  );
  const quantityTile = (label: string, select: SeriesFilter, format: UsageFormat) => {
    const value = total(usage, select);
    return <StatTile label={label} title={formatExact(value)} value={formatUsage(value, format)} />;
  };
  const others = usage.series.filter((series) => !PANELS.some((panel) => panel.select(series)));

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col gap-1">
          <Subheading>Metered usage</Subheading>
          <SourceNote source="ledger" />
        </div>
        <div className="ml-auto">
          <Button
            disabled={usage.series.length === 0}
            onClick={() =>
              downloadText(
                ledgerCsv(usage),
                ledgerCsvFilename(period.range, window.from, window.to),
                "text/csv;charset=utf-8",
              )
            }
            variant="outline"
          >
            <Icon icon={Download04Icon} />
            Export CSV
          </Button>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {quantityTile("Model tokens", MODEL_TOKENS, "count")}
        {costTile("Model cost", MODEL_COST)}
        {quantityTile("Sandbox time", SANDBOX_TIME, "duration")}
        {costTile("Sandbox cost", SANDBOX_COST)}
        {definitionId ? null : quantityTile("Email messages", EMAIL_MESSAGES, "count")}
        {quantityTile("Brain retrievals", BRAIN_RETRIEVALS, "count")}
      </div>
      {usage.series.length === 0 ? (
        <Text>
          The ledger recorded no usage {definitionId ? "of this agent's runs " : ""}in this period.
        </Text>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {panels.map((panel) => {
          const series = usage.series.filter(panel.select);
          return (
            <LedgerPanel description={panel.description} key={panel.title} title={panel.title}>
              {series.length === 0 ? (
                <Text>
                  {panel.title === "Cost" && !data.costs
                    ? "Cost records need the spend:read scope."
                    : "Nothing metered in this period."}
                </Text>
              ) : (
                <LedgerSeriesChart
                  buckets={usage.buckets}
                  interval={window.interval}
                  kind={series.length === 1 ? "area" : panel.kind}
                  series={series}
                />
              )}
            </LedgerPanel>
          );
        })}
        {others.map((series) => (
          <LedgerPanel
            description={METRIC_DESCRIPTIONS[series.metric] ?? <Code>{series.metric}</Code>}
            key={series.id}
            title={seriesLabel(series)}
          >
            <LedgerSeriesChart
              buckets={usage.buckets}
              interval={window.interval}
              kind="area"
              series={[series]}
            />
          </LedgerPanel>
        ))}
      </div>
      {usage.series.length === 0 ? null : <LedgerTable interval={window.interval} usage={usage} />}
    </section>
  );
}
