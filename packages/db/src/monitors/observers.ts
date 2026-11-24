import type { DynamoDatabaseService } from "../client-types.ts";
import type { TableName } from "../records/index.ts";
import { key } from "../keys.ts";
import type { PlatformRecord } from "../records/index.ts";
import type { MonitorCondition, MonitorRecord } from "../records/monitors.ts";
import type { MonitorObserver } from "./evaluation.ts";
import type { MonitorObservation } from "./state-machine.ts";

/** Pages of an environment's records of one type, from the environment resource index. */
async function* environmentRecords<Type extends PlatformRecord["itemType"]>(
  database: DynamoDatabaseService,
  table: TableName,
  environmentId: string,
  sortPrefix: string,
  itemType: Type,
): AsyncGenerator<Extract<PlatformRecord, { readonly itemType: Type }>> {
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await database.queryRecords(table, {
      ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
      ExpressionAttributeValues: { ":pk": key("ENV", environmentId), ":prefix": sortPrefix },
      IndexName: "gsi2",
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      Limit: 100,
    });
    for (const item of page.items) {
      if (item.itemType === itemType) {
        yield item as Extract<PlatformRecord, { readonly itemType: Type }>;
      }
    }
    cursor = page.lastEvaluatedKey;
  } while (cursor);
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

type ConditionOf<Kind extends MonitorCondition["kind"]> = Extract<
  MonitorCondition,
  { readonly kind: Kind }
>;

/**
 * Approvals in the environment still pending after the monitor's wait. Requested-at is the
 * approval's creation time; an approval that is resolved or expired stops counting at once.
 */
export function approvalWaitObserver(database: DynamoDatabaseService): MonitorObserver {
  return async (monitor, now) => {
    const condition = monitor.data.condition as ConditionOf<"approval-wait">;
    if (!monitor.data.environmentId) return { firing: false };
    const cutoff = now.getTime() - condition.waitMinutes * 60_000;
    let waiting = 0;
    let oldest: number | undefined;
    for await (const approval of environmentRecords(
      database,
      "execution",
      monitor.data.environmentId,
      `${key("APPROVAL", "pending")}#`,
      "approval",
    )) {
      if (approval.data.organizationId !== monitor.data.organizationId) continue;
      const requestedAt = Date.parse(approval.data.createdAt);
      if (approval.data.status !== "pending" || requestedAt > cutoff) continue;
      waiting += 1;
      oldest = oldest === undefined ? requestedAt : Math.min(oldest, requestedAt);
    }
    if (waiting === 0 || oldest === undefined) return { firing: false };
    const minutes = Math.floor((now.getTime() - oldest) / 60_000);
    return {
      firing: true,
      summary: `${plural(waiting, "approval")} waiting longer than ${plural(
        condition.waitMinutes,
        "minute",
      )}; the oldest has waited ${plural(minutes, "minute")}.`,
      value: waiting,
    };
  };
}

/**
 * Webhook endpoints in the environment that stopped receiving events: disabled after repeated
 * failures, or, when the monitor names a count, active with that many exhausted deliveries in a
 * row. Endpoints an operator disabled by hand are not failures.
 */
export function webhookEndpointHealthObserver(database: DynamoDatabaseService): MonitorObserver {
  return async (monitor) => {
    const condition = monitor.data.condition as ConditionOf<"webhook-endpoint-health">;
    if (!monitor.data.environmentId) return { firing: false };
    const failing: string[] = [];
    for await (const endpoint of environmentRecords(
      database,
      "control",
      monitor.data.environmentId,
      `${key("WEBHOOK-ENDPOINT")}#`,
      "webhook-endpoint",
    )) {
      if (endpoint.data.organizationId !== monitor.data.organizationId) continue;
      if (condition.webhookEndpointId && endpoint.data.id !== condition.webhookEndpointId) continue;
      const disabled =
        endpoint.data.status === "disabled" &&
        endpoint.data.disabledReason === "consecutive-failures";
      const degraded =
        endpoint.data.status === "active" &&
        condition.consecutiveFailures !== undefined &&
        (endpoint.data.consecutiveFailures ?? 0) >= condition.consecutiveFailures;
      if (disabled || degraded) failing.push(endpoint.data.name || endpoint.data.id);
    }
    if (failing.length === 0) return { firing: false };
    const names = failing.slice(0, 3).join(", ");
    return {
      firing: true,
      summary: `${plural(failing.length, "webhook endpoint")} failing: ${names}${
        failing.length > 3 ? ", and more" : ""
      }.`,
      value: failing.length,
    };
  };
}

/** One hour bucket of finalized-trace metrics, as the observability hot plane reports it. */
export interface TraceMetricBucket {
  readonly error_count: number;
  readonly p95_duration_ms?: number;
  readonly trace_count: number;
}

/**
 * Reads hourly trace metrics for one environment over the last hours. Returns undefined when the
 * install has no observability hot plane, so the monitor stays quiet instead of firing on silence.
 */
export type TraceMetricsReader = (input: {
  readonly agentDeploymentId?: string;
  readonly environmentId: string;
  readonly from: Date;
  readonly organizationId: string;
  readonly projectId: string;
  readonly to: Date;
}) => Promise<readonly TraceMetricBucket[] | undefined>;

async function traceWindow(read: TraceMetricsReader, monitor: MonitorRecord, now: Date) {
  const condition = monitor.data.condition as ConditionOf<"trace-error-rate" | "trace-latency">;
  if (!monitor.data.environmentId || !monitor.data.projectId) return undefined;
  return read({
    ...(condition.agentDeploymentId ? { agentDeploymentId: condition.agentDeploymentId } : {}),
    environmentId: monitor.data.environmentId,
    from: new Date(now.getTime() - condition.windowHours * 3_600_000),
    organizationId: monitor.data.organizationId,
    projectId: monitor.data.projectId,
    to: now,
  });
}

/** Share of finalized traces that ended in error over the window, once enough traces exist. */
export function traceErrorRateObserver(read: TraceMetricsReader): MonitorObserver {
  return async (monitor, now): Promise<MonitorObservation> => {
    const condition = monitor.data.condition as ConditionOf<"trace-error-rate">;
    const buckets = await traceWindow(read, monitor, now);
    if (!buckets) return { firing: false };
    const traces = buckets.reduce((sum, bucket) => sum + bucket.trace_count, 0);
    const errors = buckets.reduce((sum, bucket) => sum + bucket.error_count, 0);
    if (traces < condition.minimumTraces) return { firing: false };
    const percent = (errors / traces) * 100;
    return percent >= condition.thresholdPercent
      ? {
          firing: true,
          summary: `${percent.toFixed(1)}% of ${plural(traces, "trace")} failed in the last ${plural(
            condition.windowHours,
            "hour",
          )} (threshold ${condition.thresholdPercent}%).`,
          value: Number(percent.toFixed(2)),
        }
      : { firing: false };
  };
}

/**
 * The worst hourly p95 trace duration over the window, among hours with traces. Hot-plane
 * percentiles are per bucket, so the slowest bucket stands in for the window's p95.
 */
export function traceLatencyObserver(read: TraceMetricsReader): MonitorObserver {
  return async (monitor, now): Promise<MonitorObservation> => {
    const condition = monitor.data.condition as ConditionOf<"trace-latency">;
    const buckets = await traceWindow(read, monitor, now);
    if (!buckets) return { firing: false };
    const traces = buckets.reduce((sum, bucket) => sum + bucket.trace_count, 0);
    if (traces < condition.minimumTraces) return { firing: false };
    const p95 = Math.max(
      0,
      ...buckets.flatMap((bucket) =>
        bucket.trace_count > 0 && bucket.p95_duration_ms !== undefined
          ? [bucket.p95_duration_ms]
          : [],
      ),
    );
    return p95 >= condition.p95Milliseconds
      ? {
          firing: true,
          summary: `p95 trace duration reached ${Math.round(p95).toLocaleString("en-US")} ms in the last ${plural(
            condition.windowHours,
            "hour",
          )} (threshold ${condition.p95Milliseconds.toLocaleString("en-US")} ms).`,
          value: Math.round(p95),
        }
      : { firing: false };
  };
}

/** Observers for every current-state and hot-plane kind. */
export function monitorObservers(dependencies: {
  readonly database: DynamoDatabaseService;
  readonly traceMetrics: TraceMetricsReader;
}) {
  return {
    "approval-wait": approvalWaitObserver(dependencies.database),
    "trace-error-rate": traceErrorRateObserver(dependencies.traceMetrics),
    "trace-latency": traceLatencyObserver(dependencies.traceMetrics),
    "webhook-endpoint-health": webhookEndpointHealthObserver(dependencies.database),
  } satisfies Partial<Record<MonitorCondition["kind"], MonitorObserver>>;
}
