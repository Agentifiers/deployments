import { TOKEN_PARTS, type LedgerSeries, type TokenPart } from "./ledger.ts";

/**
 * How a ledger quantity reads on screen. Exact tables and the CSV keep the ledger's own unit;
 * tiles and chart axes use these friendlier scales.
 */
export type UsageFormat = "bytes" | "count" | "duration" | "gib-hours" | "usd" | "vcpu-hours";

interface MetricInfo {
  readonly format: UsageFormat;
  readonly label: string;
}

/**
 * Metrics the platform writes (model gateway and runtime, sandbox hosts, agent email, Brain
 * runtime), in display order. Anything else the ledger holds is shown under its raw name.
 */
const KNOWN_METRICS: Readonly<Record<string, MetricInfo>> = {
  model_tokens: { format: "count", label: "Model tokens" },
  sandbox_ms: { format: "duration", label: "Sandbox time" },
  sandbox_vcpu_ms: { format: "vcpu-hours", label: "Sandbox vCPU time" },
  sandbox_memory_mib_ms: { format: "gib-hours", label: "Sandbox memory" },
  worker_ms: { format: "duration", label: "Worker time" },
  "agent_email.inbound_message": { format: "count", label: "Inbound email messages" },
  "agent_email.outbound_message": { format: "count", label: "Outbound email messages" },
  "agent_email.recipients": { format: "count", label: "Email recipients" },
  "agent_email.attachment_bytes": { format: "bytes", label: "Email attachment bytes" },
  "agent_email.stored_bytes": { format: "bytes", label: "Email stored bytes" },
  "brain.retrieval": { format: "count", label: "Brain retrievals" },
};
const KNOWN_ORDER = Object.keys(KNOWN_METRICS);

const PART_LABELS: Readonly<Record<TokenPart, string>> = {
  "cache-write": "Cache-write tokens",
  cached: "Cached input tokens",
  input: "Input tokens",
  output: "Output tokens",
};

/** Cost series named after the metric they price; others name their raw metric or source. */
const COST_LABELS: Readonly<Record<string, string>> = {
  model_tokens: "Model cost",
  sandbox_memory_mib_ms: "Sandbox memory cost",
  sandbox_ms: "Sandbox time cost",
  sandbox_vcpu_ms: "Sandbox vCPU cost",
};

/** Ledger unit spellings for table and CSV headers. */
const UNIT_LABELS: Readonly<Record<string, string>> = {
  "MiB-ms": "MiB-ms",
  "byte-hours": "byte-hours",
  bytes: "bytes",
  count: "count",
  ms: "ms",
  request: "requests",
  tokens: "tokens",
  usd_nanodollars: "USD",
  "vcpu-ms": "vCPU-ms",
};

type SeriesName = Pick<LedgerSeries, "kind" | "metric" | "part" | "unit">;

export function seriesLabel(series: SeriesName) {
  if (series.kind === "cost") return COST_LABELS[series.metric] ?? `${series.metric} cost`;
  if (series.part) return PART_LABELS[series.part];
  if (series.metric.startsWith("storage.")) {
    return `Storage (${series.metric.slice("storage.".length)})`;
  }
  return KNOWN_METRICS[series.metric]?.label ?? series.metric;
}

export function seriesUnitLabel(series: SeriesName) {
  return UNIT_LABELS[series.unit] ?? series.unit;
}

export function seriesFormat(series: SeriesName): UsageFormat {
  if (series.kind === "cost") return "usd";
  if (series.unit === "bytes") return "bytes";
  return KNOWN_METRICS[series.metric]?.format ?? "count";
}

/** Known metrics first in catalog order, totals before their splits, costs after quantities. */
export function seriesOrder(left: SeriesName, right: SeriesName) {
  const rank = (series: SeriesName) => {
    const index = KNOWN_ORDER.indexOf(series.metric);
    return [
      series.kind === "cost" ? 1 : 0,
      index === -1 ? KNOWN_ORDER.length : index,
      series.part ? TOKEN_PARTS.indexOf(series.part) + 1 : 0,
    ];
  };
  const [leftRank, rightRank] = [rank(left), rank(right)];
  for (let index = 0; index < leftRank.length; index += 1) {
    const difference = leftRank[index]! - rightRank[index]!;
    if (difference !== 0) return difference;
  }
  return left.metric.localeCompare(right.metric) || left.unit.localeCompare(right.unit);
}
