/**
 * Usage and cost summaries: the usage ledger's records reduced to one zero-filled series per
 * metric over a window of UTC hour or day buckets. Pure; `usage-summary-reads.ts` reads the
 * records.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const SUMMARY_INTERVALS = ["hour", "day"] as const;
export type SummaryInterval = (typeof SUMMARY_INTERVALS)[number];

/** `[since, until)` on bucket boundaries of `interval`. */
export interface SummaryWindow {
  readonly interval: SummaryInterval;
  readonly since: string;
  readonly until: string;
}

/** One ledger record as the operational lists return it: its type and its data. */
export interface LedgerRecord {
  readonly data: Readonly<Record<string, unknown>>;
  readonly type: string;
}

/** Token splits that model meter events carry as dimensions; counters only hold the total. */
const TOKEN_PARTS = ["input", "output", "cached", "cache-write"] as const;
type TokenPart = (typeof TOKEN_PARTS)[number];

const TOKEN_PART_DIMENSIONS: Readonly<Record<TokenPart, string>> = {
  "cache-write": "cacheWriteInputTokens",
  cached: "cachedInputTokens",
  input: "inputTokens",
  output: "outputTokens",
};

/** Cost series are kept in nanodollars, the finest unit the ledger records. */
const COST_UNIT = "usd_nanodollars";
const NANODOLLARS_PER_MICRO = 1_000;
/** ISO 4217 minor units of USD (cents) in nanodollars, for `cost-aggregate.totalMinor`. */
const NANODOLLARS_PER_CENT = 10_000_000;
const COST_SUFFIXES = [
  { scale: NANODOLLARS_PER_MICRO, suffix: ".cost_usd_micros" },
  { scale: 1, suffix: ".cost_usd_nanodollars" },
] as const;

/**
 * One reconciled series. `kind: "cost"` series are in nanodollars and keyed by the metric whose
 * cost they are (`model_tokens`, `sandbox_ms`, …, or a `cost-aggregate` source); `part` marks a
 * token split of `metric`.
 */
export interface SummarySeries {
  readonly kind: "cost" | "quantity";
  readonly metric: string;
  readonly part?: TokenPart;
  readonly total: number;
  readonly unit: string;
  /** One value per bucket of the window, zero-filled. */
  readonly values: readonly number[];
}

export interface LedgerSummary {
  readonly buckets: readonly string[];
  readonly series: readonly SummarySeries[];
}

export function intervalMilliseconds(interval: SummaryInterval) {
  return interval === "day" ? DAY_MS : HOUR_MS;
}

/** Start of every bucket in `[since, until)`. */
function summaryBuckets(window: SummaryWindow): string[] {
  const width = intervalMilliseconds(window.interval);
  const buckets: string[] = [];
  for (let time = Date.parse(window.since); time < Date.parse(window.until); time += width) {
    buckets.push(new Date(time).toISOString());
  }
  return buckets;
}

/**
 * Representation tiers, finest first. Tier 1 is the raw meter events and the hourly counter
 * shards the usage materializer builds from them; tier 2 is `usage-aggregate` rollups; tier 3 is
 * typed rollups (`inbox-usage`, `storage-usage`, `cost-aggregate`).
 */
type Tier = 1 | 2 | 3;

interface SeriesKey {
  readonly kind: SummarySeries["kind"];
  readonly metric: string;
  readonly part?: TokenPart;
  readonly unit: string;
}

interface Observation {
  readonly hour: string;
  /** Dedupe key: a record read twice, or at two versions, counts once at its latest version. */
  readonly identity: string;
  readonly quantity: number;
  /** Alternatives within a tier: their per-hour sums are compared, never added. */
  readonly representation: string;
  readonly series: SeriesKey;
  readonly tier: Tier;
  readonly version: number;
}

function seriesId({ kind, metric, part, unit }: SeriesKey) {
  return [kind, metric, part ?? "", unit].join("/");
}

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The UTC hour containing `value`, as a canonical ISO timestamp. */
function hourOf(value: unknown) {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) return undefined;
  return new Date(time - (time % HOUR_MS)).toISOString();
}

/**
 * Observations of a counter shard or `usage-aggregate`, as a quantity or (suffixed) a cost. An
 * attributed counter also carries the token splits of the events it folded.
 */
function counterObservations(record: LedgerRecord, tier: 1 | 2): Observation[] {
  const { data } = record;
  const metric = text(data.metric);
  const hour = hourOf(data.bucket);
  const quantity = finite(data.quantity);
  if (!metric || !hour || quantity === undefined) return [];
  const version = finite(data.version) ?? 0;
  const attribution = `${text(data.attribution) ?? ""}/${text(data.attributionId) ?? ""}`;
  const identity = `${record.type}/${attribution}/${metric}/${String(data.bucket)}/${finite(data.shard) ?? ""}`;
  const cost = COST_SUFFIXES.find(({ suffix }) => metric.endsWith(suffix));
  if (cost) {
    return [
      {
        hour,
        identity,
        quantity: quantity * cost.scale,
        representation: cost.suffix,
        series: { kind: "cost", metric: metric.slice(0, -cost.suffix.length), unit: COST_UNIT },
        tier,
        version,
      },
    ];
  }
  const unit = text(data.unit) ?? "";
  const counter = { hour, representation: "counters", tier, version } as const;
  const observations: Observation[] = [
    { ...counter, identity, quantity, series: { kind: "quantity", metric, unit } },
  ];
  const parts =
    typeof data.parts === "object" && data.parts !== null
      ? (data.parts as Readonly<Record<string, unknown>>)
      : {};
  for (const part of TOKEN_PARTS) {
    const tokens = finite(parts[part]);
    if (tokens === undefined) continue;
    observations.push({
      ...counter,
      identity: `${identity}/${part}`,
      quantity: tokens,
      series: { kind: "quantity", metric, part, unit },
    });
  }
  return observations;
}

function meterEventObservations(data: LedgerRecord["data"]): Observation[] {
  const metric = text(data.metric);
  const hour = hourOf(data.occurredAt);
  const quantity = finite(data.quantity);
  const id = text(data.id) ?? text(data.idempotencyKey);
  const cost = metric && COST_SUFFIXES.some(({ suffix }) => metric.endsWith(suffix));
  if (!metric || !hour || quantity === undefined || !id || cost) return [];
  const unit = text(data.unit) ?? "";
  const event = { hour, representation: "events", tier: 1, version: 0 } as const;
  const observations: Observation[] = [
    { ...event, identity: `event/${id}`, quantity, series: { kind: "quantity", metric, unit } },
  ];
  if (unit !== "tokens") return observations;
  const dimensions =
    typeof data.dimensions === "object" && data.dimensions !== null
      ? (data.dimensions as Readonly<Record<string, unknown>>)
      : {};
  for (const part of TOKEN_PARTS) {
    const tokens = finite(dimensions[TOKEN_PART_DIMENSIONS[part]]);
    if (tokens === undefined) continue;
    observations.push({
      ...event,
      identity: `event/${id}/${part}`,
      quantity: tokens,
      series: { kind: "quantity", metric, part, unit },
    });
  }
  return observations;
}

/** `inbox-usage` counts the same email traffic that `agent_email.*` meter events record. */
const INBOX_USAGE_METRICS = [
  { field: "inboundMessages", metric: "agent_email.inbound_message", unit: "count" },
  { field: "outboundMessages", metric: "agent_email.outbound_message", unit: "count" },
  { field: "attachmentBytes", metric: "agent_email.attachment_bytes", unit: "bytes" },
  { field: "recipients", metric: "agent_email.recipients", unit: "count" },
] as const;

function rollupObservations(record: LedgerRecord): Observation[] {
  const { data } = record;
  const hour = hourOf(data.bucket);
  if (!hour) return [];
  const version = finite(data.version) ?? 0;
  const rollup = { hour, representation: "rollup", tier: 3, version } as const;
  if (record.type === "inbox-usage") {
    const where = `inbox-usage/${String(data.inboxId)}/${String(data.bucket)}`;
    return INBOX_USAGE_METRICS.flatMap(({ field, metric, unit }) => {
      const quantity = finite(data[field]);
      return quantity === undefined
        ? []
        : [
            {
              ...rollup,
              identity: `${where}/${field}`,
              quantity,
              series: { kind: "quantity", metric, unit },
            },
          ];
    });
  }
  if (record.type === "storage-usage") {
    const quantity = finite(data.byteHours);
    if (quantity === undefined) return [];
    const metric = `storage.${text(data.storageClass) ?? "unknown"}`;
    return [
      {
        ...rollup,
        identity: `storage-usage/${metric}/${String(data.bucket)}`,
        quantity,
        series: { kind: "quantity", metric, unit: "byte-hours" },
      },
    ];
  }
  // `cost-aggregate`: whole-currency totals per source; only USD converts to nanodollars.
  const total = finite(data.totalMinor);
  const source = text(data.source);
  if (data.currency !== "USD" || total === undefined || !source) return [];
  return [
    {
      ...rollup,
      identity: `cost-aggregate/${source}/${String(data.bucket)}`,
      quantity: total * NANODOLLARS_PER_CENT,
      series: { kind: "cost", metric: source, unit: COST_UNIT },
    },
  ];
}

function observations(record: LedgerRecord): Observation[] {
  switch (record.type) {
    case "meter-event":
      return meterEventObservations(record.data);
    case "attributed-usage-counter-shard":
    case "usage-counter-shard":
      return counterObservations(record, 1);
    case "usage-aggregate":
      return counterObservations(record, 2);
    case "inbox-usage":
    case "storage-usage":
    case "cost-aggregate":
      return rollupObservations(record);
    default:
      return [];
  }
}

/**
 * One additive cell of a ledger read: the summed quantity of one series' representation in one
 * tier and UTC hour. Cells from disjoint reads (time slices, or the usage and cost partitions)
 * concatenate; `reconcileLedger` sums equal cells before comparing them.
 */
export interface TallyCell {
  readonly hour: string;
  readonly kind: SummarySeries["kind"];
  readonly metric: string;
  readonly part?: TokenPart;
  readonly quantity: number;
  readonly representation: string;
  readonly tier: Tier;
  readonly unit: string;
}

/**
 * Reduces ledger records to tally cells. Each record counts once, at its highest `version`
 * (counter shards and aggregates are rewritten in place).
 */
export function tallyLedger(records: Iterable<LedgerRecord>): TallyCell[] {
  const latest = new Map<string, Observation>();
  for (const record of records) {
    for (const observation of observations(record)) {
      const previous = latest.get(observation.identity);
      if (!previous || observation.version > previous.version) {
        latest.set(observation.identity, observation);
      }
    }
  }
  const cells = new Map<string, TallyCell>();
  for (const { hour, quantity, representation, series, tier } of latest.values()) {
    const key = [seriesId(series), tier, hour, representation].join("|");
    const previous = cells.get(key);
    cells.set(key, {
      hour,
      kind: series.kind,
      metric: series.metric,
      ...(series.part ? { part: series.part } : {}),
      quantity: (previous?.quantity ?? 0) + quantity,
      representation,
      tier,
      unit: series.unit,
    });
  }
  return [...cells.values()];
}

/**
 * Reconciles tally cells into one zero-filled series per metric over the window.
 *
 * The ledger holds several representations of the same quantity: meter events, the hourly counter
 * shards materialized from them, `usage-aggregate` rollups, and typed rollups (`inbox-usage`,
 * `storage-usage`, `cost-aggregate`). They are alternatives, never addends:
 *
 * 1. Each record counts once (`tallyLedger`).
 * 2. Per series, only the finest tier present anywhere in the window counts: events and shards,
 *    else `usage-aggregate`, else typed rollups. A rollup's bucket width is unknown, so tiers are
 *    never mixed hour by hour. A `cost-aggregate` series is keyed by its source, which names no
 *    metric, so it is reported beside the cost counters rather than reconciled against them; a
 *    source that equals a costed metric's name is the same series and yields to its counters.
 * 3. Within the tier, per UTC hour, each representation is summed on its own (events; counter
 *    shards; for costs the micro-dollar and nanodollar counters) and the largest sum wins. The
 *    materializer lags its events and meter events are not all retained, and only catalog-priced
 *    events carry nanodollars (every costed event carries micros), so the largest sum is the most
 *    complete one. Micros are rounded per event, so where every event also carried nanodollars
 *    the figure can exceed the exact one by at most half a micro-dollar per event.
 *
 * Token splits (input, output, cached, cache write) exist only on meter events; counters carry
 * the total alone, so a split can fall short of its total when events are missing.
 */
export function reconcileLedger(cells: Iterable<TallyCell>, window: SummaryWindow): LedgerSummary {
  const all = [...cells];
  const finest = new Map<string, Tier>();
  for (const cell of all) {
    const id = seriesId(cell);
    finest.set(id, Math.min(finest.get(id) ?? 3, cell.tier) as Tier);
  }

  // series → hour → representation → sum
  const series = new Map<string, { hours: Map<string, Map<string, number>>; key: SeriesKey }>();
  for (const cell of all) {
    const id = seriesId(cell);
    if (cell.tier !== finest.get(id)) continue;
    let entry = series.get(id);
    if (!entry) {
      const { kind, metric, part, unit } = cell;
      entry = { hours: new Map(), key: { kind, metric, unit, ...(part ? { part } : {}) } };
      series.set(id, entry);
    }
    let hour = entry.hours.get(cell.hour);
    if (!hour) {
      hour = new Map();
      entry.hours.set(cell.hour, hour);
    }
    hour.set(cell.representation, (hour.get(cell.representation) ?? 0) + cell.quantity);
  }
  const buckets = summaryBuckets(window);
  const start = Date.parse(window.since);
  const end = Date.parse(window.until);
  const width = intervalMilliseconds(window.interval);
  const result: SummarySeries[] = [];
  for (const { hours, key } of series.values()) {
    const values = buckets.map(() => 0);
    for (const [hour, representations] of hours) {
      const time = Date.parse(hour);
      if (time < start || time >= end) continue;
      values[Math.floor((time - start) / width)]! += Math.max(...representations.values());
    }
    result.push({
      kind: key.kind,
      metric: key.metric,
      ...(key.part ? { part: key.part } : {}),
      total: values.reduce((sum, value) => sum + value, 0),
      unit: key.unit,
      values,
    });
  }
  return {
    buckets,
    series: result.toSorted(
      (left, right) =>
        left.metric.localeCompare(right.metric) ||
        (left.part ?? "").localeCompare(right.part ?? ""),
    ),
  };
}
