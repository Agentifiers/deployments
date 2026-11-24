import { describe, expect, test } from "bun:test";
import { hotPlaneConfiguration } from "./config.ts";

const taskEnvironment = {
  CLICKHOUSE_CA_CERTIFICATE: "-----BEGIN CERTIFICATE-----",
  CLICKHOUSE_HOST: "clickhouse.internal",
  CLICKHOUSE_INGEST_PASSWORD: "ingest-secret",
  CLICKHOUSE_QUERY_PASSWORD: "query-secret",
  DEPLOYMENTS_AI_CONTROL_TABLE: "control",
  OBSERVABILITY_CHECKPOINT_TABLE: "observability-hot-checkpoints",
  OBSERVABILITY_KINESIS_STREAM_ARN: "arn:aws:kinesis:us-east-2:123456789012:stream/observability",
  OBSERVABILITY_QUARANTINE_BUCKET: "observability-quarantine",
  OBSERVABILITY_SERVICE_TOKEN: "service-token",
};

describe("hot plane configuration", () => {
  test("starts in any install, whatever its environment name", () => {
    for (const name of [undefined, "dev", "prod", "acme"]) {
      expect(
        hotPlaneConfiguration({ ...taskEnvironment, DEPLOYMENTS_AI_ENVIRONMENT: name }),
      ).toEqual({
        checkpointTable: "observability-hot-checkpoints",
        clickhouseCa: "-----BEGIN CERTIFICATE-----",
        clickhouseHost: "clickhouse.internal",
        clickhouseIngestPassword: "ingest-secret",
        clickhouseIngestUser: "observability_ingest",
        clickhouseQueryPassword: "query-secret",
        clickhouseQueryUser: "observability_query",
        controlTable: "control",
        kinesisStreamArn: "arn:aws:kinesis:us-east-2:123456789012:stream/observability",
        kinesisStreamName: "observability",
        port: 3000,
        quarantineBucket: "observability-quarantine",
        serviceToken: "service-token",
      });
    }
  });
});
