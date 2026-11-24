import { expect, test } from "bun:test";
import { observabilityFailedRecordsMetric } from "./observability-failure-metrics.ts";

test("reports partial-batch failures through Embedded Metric Format", () => {
  expect(observabilityFailedRecordsMetric("normalizer-execution", 3, 123)).toEqual({
    _aws: {
      CloudWatchMetrics: [
        {
          Dimensions: [["Pipeline"]],
          Metrics: [{ Name: "FailedRecordCount", Unit: "Count" }],
          Namespace: "DeploymentsAI/AgentObservability",
        },
      ],
      Timestamp: 123,
    },
    FailedRecordCount: 3,
    Pipeline: "normalizer-execution",
  });
});
