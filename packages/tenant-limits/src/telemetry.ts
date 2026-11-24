export const TENANT_LIMITS_METRIC_NAMESPACE = "DeploymentsAi/TenantLimits";

export type RequestLimiterMetric = "ApiRequestsLimited" | "LimiterUnavailable";

/** The empty dimension set publishes the dimensionless aggregate that alarms read. */
export function requestLimiterMetricLine(input: {
  readonly metric: RequestLimiterMetric;
  readonly organizationId: string;
  readonly properties?: Readonly<Record<string, number | string>>;
  readonly service: string;
  readonly timestamp: number;
}) {
  return JSON.stringify({
    _aws: {
      CloudWatchMetrics: [
        {
          Dimensions: [["Service"], []],
          Metrics: [{ Name: input.metric, Unit: "Count" }],
          Namespace: TENANT_LIMITS_METRIC_NAMESPACE,
        },
      ],
      Timestamp: input.timestamp,
    },
    Service: input.service,
    [input.metric]: 1,
    organizationId: input.organizationId,
    ...input.properties,
  });
}
