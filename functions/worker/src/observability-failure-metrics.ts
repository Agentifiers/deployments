export type ObservabilityPipeline = "normalizer-execution" | "normalizer-usage" | "projector";

type ObservabilityCountMetric = "ErasedOrganizationFactCount" | "FailedRecordCount";

function observabilityCountMetric(
  pipeline: ObservabilityPipeline,
  name: ObservabilityCountMetric,
  count: number,
  timestamp: number,
) {
  return {
    _aws: {
      CloudWatchMetrics: [
        {
          Dimensions: [["Pipeline"]],
          Metrics: [{ Name: name, Unit: "Count" }],
          Namespace: "DeploymentsAI/AgentObservability",
        },
      ],
      Timestamp: timestamp,
    },
    [name]: count,
    Pipeline: pipeline,
  };
}

function emitObservabilityCountMetric(
  pipeline: ObservabilityPipeline,
  name: ObservabilityCountMetric,
  count: number,
) {
  if (count === 0) return;
  process.stderr.write(
    `${JSON.stringify(observabilityCountMetric(pipeline, name, count, Date.now()))}\n`,
  );
}

export function observabilityFailedRecordsMetric(
  pipeline: ObservabilityPipeline,
  failedRecordCount: number,
  timestamp = Date.now(),
) {
  return observabilityCountMetric(pipeline, "FailedRecordCount", failedRecordCount, timestamp);
}

export function emitObservabilityFailedRecordsMetric(
  pipeline: ObservabilityPipeline,
  failedRecordCount: number,
) {
  emitObservabilityCountMetric(pipeline, "FailedRecordCount", failedRecordCount);
}

/** Counts facts dropped because their organization was erased before normalization. */
export function emitObservabilityErasedOrganizationFactsMetric(
  pipeline: ObservabilityPipeline,
  discardedFactCount: number,
) {
  emitObservabilityCountMetric(pipeline, "ErasedOrganizationFactCount", discardedFactCount);
}
