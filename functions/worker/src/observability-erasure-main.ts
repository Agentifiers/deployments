import { setTimeout as delay } from "node:timers/promises";
import { AthenaClient } from "@aws-sdk/client-athena";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import {
  runObservabilityErasure,
  type ObservabilityErasureConfig,
} from "./observability-erasure.ts";
import { makeHotPlaneErasureClient } from "./observability-erasure-hot-plane.ts";
import { icebergErasureTables } from "./observability-erasure-iceberg.ts";

const ENV = {
  athenaWorkgroup: "DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_ATHENA_WORKGROUP",
  clickhouseNativeBackupDays: "DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_CLICKHOUSE_NATIVE_BACKUP_DAYS",
  clickhouseSnapshotDays: "DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_CLICKHOUSE_SNAPSHOT_DAYS",
  controlTable: "DEPLOYMENTS_AI_CONTROL_TABLE",
  drainSeconds: "DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_DRAIN_SECONDS",
  firehoseFreshnessSeconds: "DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_MAX_FIREHOSE_FRESHNESS_SECONDS",
  firehoseStreams: "DEPLOYMENTS_AI_OBSERVABILITY_FIREHOSE_STREAMS",
  hotPlaneBaseUrl: "DEPLOYMENTS_AI_OBSERVABILITY_BASE_URL",
  hotPlaneSecretArn: "DEPLOYMENTS_AI_OBSERVABILITY_SECRET_ARN",
  icebergNoncurrentFileDays: "DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_ICEBERG_NONCURRENT_FILE_DAYS",
  icebergSnapshotMaxAgeHours: "DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_ICEBERG_SNAPSHOT_MAX_AGE_HOURS",
  icebergTables: "DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_ICEBERG_TABLES",
  icebergUnreferencedFileDays:
    "DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_ICEBERG_UNREFERENCED_FILE_DAYS",
  lambdaIteratorAgeSeconds: "DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_MAX_LAMBDA_ITERATOR_AGE_SECONDS",
  pipelineFunctions: "DEPLOYMENTS_AI_OBSERVABILITY_ERASURE_PIPELINE_FUNCTIONS",
} as const;

export interface LambdaInvocationContext {
  readonly getRemainingTimeInMillis: () => number;
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function wholeNumber(environment: NodeJS.ProcessEnv, name: string, fallback?: number) {
  const raw = environment[name]?.trim();
  if (!raw && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!raw || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative whole number.`);
  }
  return value;
}

function stringList(raw: string, name: string, values: (parsed: unknown) => unknown[]) {
  const list = values(JSON.parse(raw));
  if (list.length === 0 || list.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${name} must list non-empty names.`);
  }
  return list as string[];
}

export function observabilityErasureConfigFromEnvironment(
  environment: NodeJS.ProcessEnv,
): ObservabilityErasureConfig {
  return {
    controlTable: required(environment, ENV.controlTable),
    drain: {
      drainSeconds: wholeNumber(environment, ENV.drainSeconds, 600),
      firehoseFreshnessSeconds: wholeNumber(environment, ENV.firehoseFreshnessSeconds, 180),
      firehoseStreams: stringList(
        required(environment, ENV.firehoseStreams),
        ENV.firehoseStreams,
        (parsed) => (parsed && typeof parsed === "object" ? Object.values(parsed) : []),
      ),
      lambdaIteratorAgeSeconds: wholeNumber(environment, ENV.lambdaIteratorAgeSeconds, 120),
      pipelineFunctions: stringList(
        required(environment, ENV.pipelineFunctions),
        ENV.pipelineFunctions,
        (parsed) => (Array.isArray(parsed) ? parsed : []),
      ),
    },
    hotPlanePollIntervalMs: 5_000,
    // The hot plane bounds its own mutation wait well under this.
    hotPlaneRequestTimeoutMs: 45_000,
    iceberg: {
      maxCommitRetries: 8,
      pollIntervalMs: 2_000,
      tables: icebergErasureTables(required(environment, ENV.icebergTables)),
      workgroup: required(environment, ENV.athenaWorkgroup),
    },
    removal: {
      clickhouseNativeBackupDays: wholeNumber(environment, ENV.clickhouseNativeBackupDays),
      clickhouseSnapshotDays: wholeNumber(environment, ENV.clickhouseSnapshotDays),
      icebergNoncurrentFileDays: wholeNumber(environment, ENV.icebergNoncurrentFileDays),
      icebergSnapshotMaxAgeHours: wholeNumber(environment, ENV.icebergSnapshotMaxAgeHours),
      icebergUnreferencedFileDays: wholeNumber(environment, ENV.icebergUnreferencedFileDays),
    },
    safetyMarginMs: 60_000,
  };
}

const athena = new AthenaClient({});
const cloudwatch = new CloudWatchClient({});
const dynamodb = new DynamoDBClient({});
let serviceToken: Promise<string> | undefined;

function hotPlaneClient(environment: NodeJS.ProcessEnv) {
  const baseUrl = environment[ENV.hotPlaneBaseUrl]?.trim();
  const secretArn = environment[ENV.hotPlaneSecretArn]?.trim();
  if (Boolean(baseUrl) !== Boolean(secretArn)) {
    throw new Error(
      `${ENV.hotPlaneBaseUrl} and ${ENV.hotPlaneSecretArn} must be configured together.`,
    );
  }
  if (!baseUrl || !secretArn) return undefined;
  return makeHotPlaneErasureClient({
    baseUrl,
    serviceToken: async () => {
      const pending = (serviceToken ??= loadAwsSecretString(secretArn).then((value: string) =>
        value.trim(),
      ));
      try {
        return await pending;
      } catch (error) {
        serviceToken = undefined;
        throw error;
      }
    },
  });
}

export const handler = async (event: unknown, context: LambdaInvocationContext) => {
  const config = observabilityErasureConfigFromEnvironment(process.env);
  const hotPlane = hotPlaneClient(process.env);
  return runObservabilityErasure(event, config, {
    athena,
    cloudwatch,
    dynamodb,
    ...(hotPlane ? { hotPlane } : {}),
    now: () => new Date(),
    remainingTimeMs: () => context.getRemainingTimeInMillis(),
    sleep: (milliseconds) => delay(milliseconds),
  });
};
