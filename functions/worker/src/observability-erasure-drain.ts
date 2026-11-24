/* eslint-disable no-await-in-loop -- GetMetricData pagination is sequential by NextToken. */

import {
  GetMetricDataCommand,
  type CloudWatchClient,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";

export interface ObservabilityDrainConfig {
  /** Minimum quiet period after the drain anchor before purging (seconds). */
  readonly drainSeconds: number;
  readonly firehoseFreshnessSeconds: number;
  readonly firehoseStreams: readonly string[];
  readonly lambdaIteratorAgeSeconds: number;
  /** Both normalizer functions and the projector. */
  readonly pipelineFunctions: readonly string[];
}

interface GateMetric {
  readonly query: MetricDataQuery;
  /** Threshold in the metric's native unit. */
  readonly threshold: number;
}

const MAX_POINTS_PER_METRIC = 1_440;

function metricQuery(
  id: string,
  namespace: string,
  metricName: string,
  dimension: { readonly Name: string; readonly Value: string },
  period: number,
): MetricDataQuery {
  return {
    Id: id,
    MetricStat: {
      Metric: { Dimensions: [dimension], MetricName: metricName, Namespace: namespace },
      Period: period,
      Stat: "Maximum",
    },
    ReturnData: true,
  };
}

function gateMetrics(config: ObservabilityDrainConfig, period: number): readonly GateMetric[] {
  return [
    ...config.pipelineFunctions.map((functionName, index) => ({
      query: metricQuery(
        `lambda${index}`,
        "AWS/Lambda",
        "IteratorAge",
        { Name: "FunctionName", Value: functionName },
        period,
      ),
      threshold: config.lambdaIteratorAgeSeconds * 1_000,
    })),
    ...config.firehoseStreams.map((streamName, index) => ({
      query: metricQuery(
        `firehose${index}`,
        "AWS/Firehose",
        "DeliveryToIceberg.DataFreshness",
        { Name: "DeliveryStreamName", Value: streamName },
        period,
      ),
      threshold: config.firehoseFreshnessSeconds,
    })),
  ];
}

/**
 * Returns whether the Lambda and Firehose observability stages have drained
 * past the anchor. All lag metrics must stay within their thresholds for at
 * least `drainSeconds` after the anchor; missing datapoints count as 0 (an
 * idle stage emits nothing). An over-threshold datapoint restarts the quiet
 * period from the end of that datapoint so a transient lag spike delays the
 * purge instead of blocking it forever.
 *
 * The facts stream's `GetRecords.IteratorAgeMilliseconds` is deliberately not
 * gated: on an idle stream it reports the age of the last record and grows
 * without bound. The hot plane instead proves its own writer caught up before
 * it purges ClickHouse.
 */
export async function observabilityPipelineDrained(input: {
  readonly anchor: Date;
  readonly cloudwatch: Pick<CloudWatchClient, "send">;
  readonly config: ObservabilityDrainConfig;
  readonly now: Date;
}) {
  const { anchor, config, now } = input;
  const elapsedSeconds = (now.getTime() - anchor.getTime()) / 1_000;
  if (elapsedSeconds < config.drainSeconds) return false;
  const period = 60 * Math.max(1, Math.ceil(elapsedSeconds / 60 / MAX_POINTS_PER_METRIC));
  const metrics = gateMetrics(config, period);
  const thresholds = new Map(metrics.map((metric) => [metric.query.Id!, metric.threshold]));
  const start = new Date(Math.floor(anchor.getTime() / (period * 1_000)) * period * 1_000);
  let quietSince = anchor.getTime();
  let nextToken: string | undefined;
  do {
    const output = await input.cloudwatch.send(
      new GetMetricDataCommand({
        EndTime: now,
        MetricDataQueries: metrics.map((metric) => metric.query),
        StartTime: start,
        ...(nextToken ? { NextToken: nextToken } : {}),
      }),
    );
    for (const result of output.MetricDataResults ?? []) {
      const threshold = thresholds.get(result.Id ?? "");
      if (threshold === undefined) throw new Error(`Unexpected metric result ${result.Id}.`);
      if (result.StatusCode === "InternalError" || result.StatusCode === "Forbidden") {
        throw new Error(`CloudWatch returned ${result.StatusCode} for drain metric ${result.Id}.`);
      }
      const values = result.Values ?? [];
      const timestamps = result.Timestamps ?? [];
      values.forEach((value, index) => {
        const timestamp = timestamps[index];
        if (value > threshold && timestamp) {
          quietSince = Math.max(quietSince, timestamp.getTime() + period * 1_000);
        }
      });
    }
    nextToken = output.NextToken;
  } while (nextToken);
  return (now.getTime() - quietSince) / 1_000 >= config.drainSeconds;
}
