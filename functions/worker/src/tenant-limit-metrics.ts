import { PutMetricDataCommand, type CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { failureChain } from "./failure-log.ts";

export const TENANT_LIMITS_METRIC_NAMESPACE = "DeploymentsAi/TenantLimits";

export type TenantLimitWorkerMetric =
  | "RunConcurrencyWaitExpired"
  | "RunsDeferred"
  | "SandboxCapacityRejected"
  | "StaleCapacityRecovered";

export interface TenantLimitHit {
  readonly metric: TenantLimitWorkerMetric;
  readonly organizationId: string;
  readonly limit: number;
  readonly inUse: number;
  readonly runId?: string;
}

export interface TenantLimitMetrics {
  readonly record: (hit: TenantLimitHit) => void;
}

export function createTenantLimitMetrics(options: {
  readonly client: Pick<CloudWatchClient, "send">;
  readonly now?: () => Date;
}): TenantLimitMetrics {
  return {
    record: (hit) => {
      console.info("tenant_limit.hit", hit);
      options.client
        .send(
          new PutMetricDataCommand({
            MetricData: [
              {
                MetricName: hit.metric,
                Timestamp: options.now?.() ?? new Date(),
                Unit: "Count",
                Value: 1,
              },
            ],
            Namespace: TENANT_LIMITS_METRIC_NAMESPACE,
          }),
        )
        .catch((cause: unknown) => {
          console.error("Tenant limit metric could not be published.", {
            failure: failureChain(cause),
            metric: hit.metric,
          });
        });
    },
  };
}
