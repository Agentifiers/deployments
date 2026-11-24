import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  brainUlid,
  makeBrainDynamoRepository,
  makeDynamoDatabase,
  makeDynamoGovernanceStore,
  tableNamesFromEnvironment,
} from "@deployments-ai/db";
import { makeS3GovernanceObjectStore } from "@deployments-ai/governance/aws";
import { Schema } from "effect";
import { optionalStringArray, requiredEnvironment } from "../lambda-environment.ts";
import { runBrainErasureTick } from "./erasure-tick.ts";
import {
  brainSearchProviderRegistry,
  eraseBrainSearchOrganization,
} from "./search-erasure-main.ts";

const lambda = new LambdaClient({});
const s3 = new S3Client({});
const tables = tableNamesFromEnvironment(process.env);
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const database = makeDynamoDatabase(documentClient, tables);
const repository = makeBrainDynamoRepository(database);
const governanceStore = makeDynamoGovernanceStore(documentClient, tables, {
  requireTenantInventoryReady: true,
});

const MemoryPurgeReceipt = Schema.Struct({
  brainId: Schema.String,
  operationId: Schema.String,
  targets: Schema.Array(
    Schema.Struct({
      contentPurged: Schema.Literal(true),
      memoryCount: Schema.Number,
      providerId: Schema.String,
      targetId: Schema.String,
    }),
  ),
});

async function purgeDerivedMemories(input: {
  readonly brainId: string;
  readonly memories: readonly { readonly pk: string; readonly sk: string }[];
  readonly operationId: string;
  readonly organizationId: string;
}) {
  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: requiredEnvironment(process.env, "DEPLOYMENTS_AI_MEMORY_ERASURE_FUNCTION_NAME"),
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(input)),
    }),
  );
  const payload = response.Payload
    ? JSON.parse(Buffer.from(response.Payload).toString("utf8"))
    : undefined;
  if (response.FunctionError) {
    throw new Error(
      payload && typeof payload === "object" && "errorMessage" in payload
        ? String(payload.errorMessage)
        : "Brain-derived memory purge failed.",
    );
  }
  const receipt = Schema.decodeUnknownSync(MemoryPurgeReceipt)(payload);
  if (receipt.brainId !== input.brainId || receipt.operationId !== input.operationId) {
    throw new Error("Brain-derived memory purge returned a mismatched receipt.");
  }
  return receipt;
}

export async function handler(_event: unknown, context?: { readonly awsRequestId?: string }) {
  const bucket = requiredEnvironment(process.env, "DEPLOYMENTS_AI_ARTIFACT_BUCKET");
  const legacyBuckets = optionalStringArray(
    process.env,
    "DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON",
  );
  const kmsKeyArn = requiredEnvironment(process.env, "DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN");
  const objectStore = makeS3GovernanceObjectStore({ bucket, client: s3, kmsKeyArn });
  const tick = await runBrainErasureTick({
    bucket,
    database,
    governanceStore,
    legacyBuckets,
    objectStore,
    purgeDerivedMemories,
    purgeSearch: (input) =>
      eraseBrainSearchOrganization(
        {
          ...input,
          brainId: brainUlid(input.brainId),
          operationId: brainUlid(input.operationId),
          organizationId: brainUlid(input.organizationId),
        },
        database,
        brainSearchProviderRegistry(database),
      ),
    repository,
    s3,
    workerId: context?.awsRequestId ?? randomUUID(),
  });
  console.info(
    JSON.stringify({
      _aws: {
        CloudWatchMetrics: [
          {
            Dimensions: [[]],
            Metrics: [{ Name: "FailedErasureJobs", Unit: "Count" }],
            Namespace: "DeploymentsAI/Brain",
          },
        ],
        Timestamp: Date.now(),
      },
      FailedErasureJobs: tick.failedJobs,
    }),
  );
  return tick;
}
