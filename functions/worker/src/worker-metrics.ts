import { PutMetricDataCommand, type CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { failureChain } from "./failure-log.ts";

/** ECS target tracking scales the agent-worker service on this metric's average. */
const RUN_SLOT_UTILIZATION_METRIC = "RunSlotUtilization";
const RUN_SLOT_UTILIZATION_INTERVAL_MS = 60_000;

export interface RunSlotUtilizationMetricsOptions {
  readonly client: Pick<CloudWatchClient, "send">;
  /** Received runs not yet acknowledged or handed back to the queue. */
  readonly inFlightRuns: () => number;
  readonly maxConcurrentRuns: number;
  readonly namespace: string;
  readonly now?: () => Date;
  /** Starts the publication interval; returns its cancel function. Test seam for a fake clock. */
  readonly repeat?: (callback: () => void, intervalMs: number) => () => void;
  readonly serviceName: string;
}

export interface RunSlotUtilizationMetrics {
  /** Publishes now and then every 60 s. */
  readonly start: () => void;
  /** Stops the interval and publishes one final sample. */
  readonly stop: () => Promise<void>;
}

/** Publishes `inFlightRuns / maxConcurrentRuns × 100` as a Percent metric; failures are logged. */
export function createRunSlotUtilizationMetrics(
  options: RunSlotUtilizationMetricsOptions,
): RunSlotUtilizationMetrics {
  const repeat =
    options.repeat ??
    ((callback: () => void, intervalMs: number) => {
      const timer = setInterval(callback, intervalMs);
      return () => clearInterval(timer);
    });
  const publish = async () => {
    try {
      await options.client.send(
        new PutMetricDataCommand({
          MetricData: [
            {
              Dimensions: [{ Name: "ServiceName", Value: options.serviceName }],
              MetricName: RUN_SLOT_UTILIZATION_METRIC,
              Timestamp: options.now?.() ?? new Date(),
              Unit: "Percent",
              Value: (options.inFlightRuns() / options.maxConcurrentRuns) * 100,
            },
          ],
          Namespace: options.namespace,
        }),
      );
    } catch (cause) {
      console.error("Agent worker run slot utilization could not be published.", {
        failure: failureChain(cause),
      });
    }
  };
  let cancel: (() => void) | undefined;
  return {
    start: () => {
      if (cancel) return;
      void publish();
      cancel = repeat(() => void publish(), RUN_SLOT_UTILIZATION_INTERVAL_MS);
    },
    stop: async () => {
      cancel?.();
      cancel = undefined;
      await publish();
    },
  };
}
