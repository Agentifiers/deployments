import {
  MONITOR_EVENT_TYPES,
  SemanticEventData,
  evaluateMonitor,
  evaluateMonitorsForEvent,
  type MonitorEvaluationDependencies,
} from "@deployments-ai/db";
import { semanticEventIsInternal } from "@deployments-ai/events";
import { Schema } from "effect";

const decodeEvent = Schema.decodeUnknownSync(SemanticEventData);
/** Monitors one shard evaluates at a time, so a slow hot-plane read holds up only its own slot. */
const SWEEP_CONCURRENCY = 8;
/**
 * No new evaluation starts with less time than this left, which covers one evaluation's commit
 * retries and hot-plane read, so the invocation returns before Lambda times it out and retries.
 */
const SWEEP_DEADLINE_MARGIN_MS = 30_000;
const ALERT_METRICS_NAMESPACE = "DeploymentsAI/Alerts";

/**
 * CloudWatch embedded metric line for monitors the sweep could not evaluate. The sweep logs
 * and goes on instead of failing, so the alerts error alarm reads this alongside Lambda errors.
 */
export function monitorEvaluationFailuresMetric(failed: number, timestamp = Date.now()) {
  return JSON.stringify({
    _aws: {
      CloudWatchMetrics: [
        {
          Dimensions: [[]],
          Metrics: [{ Name: "MonitorEvaluationFailures", Unit: "Count" }],
          Namespace: ALERT_METRICS_NAMESPACE,
        },
      ],
      Timestamp: timestamp,
    },
    MonitorEvaluationFailures: failed,
  });
}

/**
 * EventBridge target: routes a platform event to every monitor of its tenancy that listens for
 * it. Internal events (preview runs on execution bindings) never alert customers.
 */
export async function evaluateMonitorEvent(
  input: { readonly detail: unknown; readonly source?: string },
  dependencies: MonitorEvaluationDependencies,
) {
  if (input.source !== undefined && input.source !== "deployments-ai.platform") return;
  const event = decodeEvent(input.detail);
  if (!MONITOR_EVENT_TYPES.includes(event.eventType) || semanticEventIsInternal(event)) return;
  await evaluateMonitorsForEvent(dependencies, event);
}

export interface MonitorSweepResult {
  readonly evaluated: number;
  readonly failed: number;
  readonly shard: number;
  /** The deadline came first; the shard's remaining monitors wait for the next sweep. */
  readonly truncated: boolean;
}

/**
 * Scheduled evaluator for one sweep shard: each shard has its own schedule and invocation. It
 * evaluates every live monitor of the shard, which resolves windows that emptied, one-shot
 * incidents that reached their end, current-state conditions, and hot-plane metrics, and repeats
 * notifications that are due. Evaluation is idempotent, so overlapping or retried sweeps
 * converge. One monitor that fails does not stop the sweep.
 */
export async function sweepMonitorShard(
  dependencies: MonitorEvaluationDependencies,
  input: { readonly remainingTimeMs: () => number; readonly shard: number },
): Promise<MonitorSweepResult> {
  let evaluated = 0;
  let failed = 0;
  let truncated = false;
  let cursor: Readonly<Record<string, unknown>> | undefined;
  do {
    const page = await dependencies.monitors.sweepPage({
      ...(cursor ? { cursor } : {}),
      shard: input.shard,
    });
    const queue = [...page.monitors];
    await Promise.all(
      Array.from({ length: Math.min(SWEEP_CONCURRENCY, queue.length) }, async () => {
        for (let target = queue.shift(); target; target = queue.shift()) {
          if (input.remainingTimeMs() < SWEEP_DEADLINE_MARGIN_MS) {
            truncated = true;
            return;
          }
          try {
            await evaluateMonitor(dependencies, target);
            evaluated += 1;
          } catch (cause) {
            failed += 1;
            console.error("Monitor evaluation failed.", {
              error: cause instanceof Error ? cause.message : "Unknown error.",
              monitorId: target.monitorId,
              organizationId: target.organizationId,
            });
          }
        }
      }),
    );
    cursor = truncated ? undefined : page.cursor;
  } while (cursor);
  if (failed > 0) console.log(monitorEvaluationFailuresMetric(failed));
  return { evaluated, failed, shard: input.shard, truncated };
}
