export interface HotPlaneConfiguration {
  readonly clickhouseCa: string;
  readonly clickhouseHost: string;
  readonly clickhouseIngestPassword: string;
  readonly clickhouseIngestUser: string;
  readonly clickhouseQueryPassword: string;
  readonly clickhouseQueryUser: string;
  readonly checkpointTable: string;
  readonly controlTable: string;
  readonly kinesisStreamArn: string;
  readonly kinesisStreamName: string;
  readonly port: number;
  readonly quarantineBucket: string;
  readonly serviceToken: string;
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${name} must be a positive TCP port.`);
  }
  return parsed;
}

export function hotPlaneConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): HotPlaneConfiguration {
  const streamArn = required(environment, "OBSERVABILITY_KINESIS_STREAM_ARN");
  const streamName = streamArn.match(/:stream\/(.+)$/u)?.[1];
  if (!streamName)
    throw new Error("OBSERVABILITY_KINESIS_STREAM_ARN must be a Kinesis stream ARN.");
  return {
    clickhouseCa: required(environment, "CLICKHOUSE_CA_CERTIFICATE"),
    clickhouseHost: required(environment, "CLICKHOUSE_HOST"),
    clickhouseIngestPassword: required(environment, "CLICKHOUSE_INGEST_PASSWORD"),
    clickhouseIngestUser: environment.CLICKHOUSE_INGEST_USER?.trim() || "observability_ingest",
    clickhouseQueryPassword: required(environment, "CLICKHOUSE_QUERY_PASSWORD"),
    clickhouseQueryUser: environment.CLICKHOUSE_QUERY_USER?.trim() || "observability_query",
    checkpointTable: required(environment, "OBSERVABILITY_CHECKPOINT_TABLE"),
    controlTable: required(environment, "DEPLOYMENTS_AI_CONTROL_TABLE"),
    kinesisStreamArn: streamArn,
    kinesisStreamName: streamName,
    port: positiveInteger(environment.PORT, 3000, "PORT"),
    quarantineBucket: required(environment, "OBSERVABILITY_QUARANTINE_BUCKET"),
    serviceToken: required(environment, "OBSERVABILITY_SERVICE_TOKEN"),
  };
}
