import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KinesisClient } from "@aws-sdk/client-kinesis";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { observabilityErasureFence } from "@deployments-ai/db/observability-erasure-fence";
import { observabilityOrganizationPresence } from "@deployments-ai/db/observability-organization-presence";
import { createHotPlaneApi } from "./api.ts";
import { createClickHouseExecutor } from "./clickhouse.ts";
import { hotPlaneConfiguration } from "./config.ts";
import { createOrganizationErasure } from "./organization-erasure.ts";
import { cachedOrganizationPresence } from "./organization-presence.ts";
import { ensureObservabilitySchemaWithRetry } from "./schema.ts";
import { createWriterCatchUp } from "./writer-catch-up.ts";
import { runHotWriter } from "./writer.ts";

export async function startHotPlane(environment: NodeJS.ProcessEnv = process.env) {
  const configuration = hotPlaneConfiguration(environment);
  const query = createClickHouseExecutor({
    ca: configuration.clickhouseCa,
    host: configuration.clickhouseHost,
    password: configuration.clickhouseQueryPassword,
    username: configuration.clickhouseQueryUser,
  });
  const ingest = createClickHouseExecutor({
    ca: configuration.clickhouseCa,
    host: configuration.clickhouseHost,
    password: configuration.clickhouseIngestPassword,
    username: configuration.clickhouseIngestUser,
  });
  const controller = new AbortController();
  const dynamodb = new DynamoDBClient({});
  const s3 = new S3Client({});
  let ready = false;
  const writerCatchUp = createWriterCatchUp();
  const server = Bun.serve({
    fetch: createHotPlaneApi({
      clickhouse: query,
      // Purges run as the ingest user, the only role granted ALTER DELETE.
      organizationErasure: createOrganizationErasure({
        clickhouse: ingest,
        conversationErasureRunning: (organizationId, operationId) =>
          observabilityErasureFence.conversationErasureRunning(
            dynamodb,
            configuration.controlTable,
            organizationId,
            operationId,
          ),
        readErasureFence: (organizationId) =>
          observabilityErasureFence.read(dynamodb, configuration.controlTable, organizationId),
        writerCatchUp,
      }),
      ready: () => ready,
      serviceToken: configuration.serviceToken,
    }).fetch,
    hostname: "0.0.0.0",
    // Erasure holds the response while `mutations_sync` waits (bounded at 20 s).
    idleTimeout: 60,
    port: configuration.port,
  });
  const stop = () => {
    controller.abort();
    void server.stop(true);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const initialization = (async () => {
    await ensureObservabilitySchemaWithRetry(ingest, {
      signal: controller.signal,
    });
    await runHotWriter({
      catchUp: writerCatchUp,
      checkpointTable: configuration.checkpointTable,
      clickhouse: ingest,
      dynamodb,
      existingOrganizations: cachedOrganizationPresence((organizationIds) =>
        observabilityOrganizationPresence.existing(
          dynamodb,
          configuration.controlTable,
          organizationIds,
        ),
      ),
      kinesis: new KinesisClient({}),
      onInitialReplayComplete: () => {
        ready = true;
      },
      quarantine: {
        put: async (record) => {
          await s3.send(
            new PutObjectCommand({
              Body: JSON.stringify(record),
              Bucket: configuration.quarantineBucket,
              ContentType: "application/json",
              Key: `hot-writer/${record.shardId}/${record.sequenceNumber}.json`,
            }),
          );
        },
      },
      requireCanonicalSeed: true,
      signal: controller.signal,
      streamArn: configuration.kinesisStreamArn,
      streamName: configuration.kinesisStreamName,
    });
  })();
  void initialization.catch((cause: unknown) => {
    console.error("Observability hot writer stopped.", cause);
    stop();
    process.exitCode = 1;
  });
  return { controller, initialization, server };
}

if (import.meta.main) {
  startHotPlane().catch((cause: unknown) => {
    console.error(cause);
    process.exitCode = 1;
  });
}
