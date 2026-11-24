import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ChangeMessageVisibilityCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  makeBrainIndexEmbeddingPort,
  makeBrainSearchProviderRegistry,
  type BrainSearchProviderRuntimeConfig,
} from "@deployments-ai/brain-runtime";
import {
  DatabaseError,
  makeBrainDynamoRepository,
  makeBrainGraphRepository,
  makeDynamoDatabase,
  tableNamesFromEnvironment,
} from "@deployments-ai/db";
import { makeLambdaFileTextExtractor } from "@deployments-ai/file-text";
import { requiredEnvironment } from "../lambda-environment.ts";
import { BRAIN_MODEL_GATEWAY_ENV, makeBrainModelGateway } from "./model-gateway.ts";
import { makeS3BrainTextRenditionStore } from "./text-rendition-store.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  processBrainIndexMessage,
  type BrainIndexQueueMessage,
  type BrainIndexRuntimeDependencies,
} from "./index-runtime.ts";
import { dueDeliveryDelaySeconds, failedDeliveryDelaySeconds } from "./index-redelivery.ts";

interface QueueRecord {
  readonly attributes: { readonly ApproximateReceiveCount: string };
  readonly body: string;
  readonly messageId: string;
  readonly receiptHandle: string;
}

interface BrainIndexQueueEvent {
  readonly Records: readonly QueueRecord[];
}

export interface BrainIndexQueueRedelivery {
  /** Hides the message until its next attempt is due; the queue's redrive policy is a backstop. */
  readonly changeVisibility: (receiptHandle: string, visibilitySeconds: number) => Promise<void>;
  readonly random: () => number;
}

function parseMessage(body: string): BrainIndexQueueMessage {
  const value = JSON.parse(body) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Brain index queue body must be an object.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const requiredField = (field: keyof BrainIndexQueueMessage) => {
    const fieldValue = record[field];
    if (typeof fieldValue !== "string" || !fieldValue.trim()) {
      throw new TypeError(`Brain index queue ${field} is required.`);
    }
    return fieldValue;
  };
  return {
    documentId: requiredField("documentId"),
    idempotencyKey: requiredField("idempotencyKey"),
    organizationId: requiredField("organizationId"),
  };
}

function objectRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

export function brainIndexFailureLogContext(cause: unknown) {
  const nestedCause = cause instanceof DatabaseError ? cause.cause : undefined;
  const nestedRecord = objectRecord(nestedCause);
  const cancellationReasons = Array.isArray(nestedRecord?.CancellationReasons)
    ? nestedRecord.CancellationReasons.flatMap((reason) => {
        const value = objectRecord(reason);
        const code = value?.Code ?? value?.code ?? value?.name;
        return typeof code === "string" ? [code] : [];
      })
    : [];
  const causeName =
    nestedCause instanceof Error
      ? nestedCause.name
      : typeof nestedRecord?.name === "string"
        ? nestedRecord.name
        : undefined;
  const causeMessage =
    nestedCause instanceof Error
      ? nestedCause.message
      : typeof nestedRecord?.message === "string"
        ? nestedRecord.message
        : undefined;
  return {
    ...(cause instanceof DatabaseError
      ? {
          databaseOperation: cause.operation,
          ...(cause.reason ? { databaseReason: cause.reason } : {}),
          databaseTable: cause.table,
        }
      : {}),
    ...(cancellationReasons.length > 0 ? { databaseCancellationCodes: cancellationReasons } : {}),
    ...(causeMessage ? { innerCauseMessage: causeMessage } : {}),
    ...(causeName ? { innerCauseType: causeName } : {}),
    message: cause instanceof Error ? cause.message : "Unknown failure.",
  };
}

/**
 * Runs one job per record. A record whose job failed or can next run within five minutes stays on
 * the queue and returns when the job can next run, instead of after the queue's visibility timeout
 * or the dispatcher's next sweep. A job that can run only later is left to the dispatcher sweep.
 */
export async function handleBrainIndexQueue(
  event: BrainIndexQueueEvent,
  dependencies: BrainIndexRuntimeDependencies,
  redelivery: BrainIndexQueueRedelivery,
) {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    let visibilitySeconds: number | undefined;
    try {
      const result = await processBrainIndexMessage(parseMessage(record.body), dependencies);
      if (result.outcome !== "deferred" || !("retryAt" in result)) continue;
      visibilitySeconds = dueDeliveryDelaySeconds(
        result.retryAt,
        (dependencies.now ?? (() => new Date()))(),
      );
    } catch (cause) {
      console.error("Brain index queue record failed.", {
        ...brainIndexFailureLogContext(cause),
        errorType: cause instanceof Error ? cause.name : "UnknownError",
        messageId: record.messageId,
      });
      visibilitySeconds = failedDeliveryDelaySeconds(
        Number(record.attributes.ApproximateReceiveCount),
        redelivery.random,
      );
    }
    if (visibilitySeconds === undefined) continue;
    await redelivery.changeVisibility(record.receiptHandle, visibilitySeconds).catch((cause) => {
      console.error("Brain index redelivery delay was not applied.", {
        errorType: cause instanceof Error ? cause.name : "UnknownError",
        messageId: record.messageId,
      });
    });
    failures.push({ itemIdentifier: record.messageId });
  }
  return { batchItemFailures: failures };
}

let runtimePromise: Promise<BrainIndexRuntimeDependencies> | undefined;

async function createRuntime(environment: NodeJS.ProcessEnv = process.env) {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const database = makeDynamoDatabase(documentClient, tableNamesFromEnvironment(environment));
  const s3 = new S3Client({});
  const contentBucket = requiredEnvironment(environment, "DEPLOYMENTS_AI_ARTIFACT_BUCKET");
  const legacyBucketValue = environment.DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON?.trim();
  const legacyContentBuckets: readonly string[] = legacyBucketValue
    ? (() => {
        const decoded: unknown = JSON.parse(legacyBucketValue);
        if (
          !Array.isArray(decoded) ||
          decoded.some((entry) => typeof entry !== "string" || entry.trim() === "")
        ) {
          throw new TypeError(
            "DEPLOYMENTS_AI_LEGACY_ARTIFACT_BUCKETS_JSON must be a JSON array of non-empty strings.",
          );
        }
        return [...new Set(decoded.map((entry) => entry.trim()))];
      })()
    : [];
  const gateway = makeBrainModelGateway({
    baseUrl: requiredEnvironment(environment, BRAIN_MODEL_GATEWAY_ENV.baseUrl),
    environment,
    tokenIssuer: requiredEnvironment(environment, BRAIN_MODEL_GATEWAY_ENV.tokenIssuer),
  });
  const openSearchEndpoint = environment.DEPLOYMENTS_AI_BRAIN_OPENSEARCH_ENDPOINT?.trim();
  const config: BrainSearchProviderRuntimeConfig = openSearchEndpoint
    ? { aws: { openSearchEndpoint } }
    : {};
  const repository = makeBrainDynamoRepository(database);
  const dependencies: BrainIndexRuntimeDependencies = {
    database,
    embeddings: (job) =>
      makeBrainIndexEmbeddingPort({
        database,
        gateway,
        organizationId: job.data.organizationId,
        profileId: job.data.embeddingProfileId,
      }),
    extractor: makeLambdaFileTextExtractor({
      functionName: requiredEnvironment(
        environment,
        "DEPLOYMENTS_AI_DOCUMENT_EXTRACTION_FUNCTION_NAME",
      ),
      lambda: new LambdaClient({}),
    }),
    graph: makeBrainGraphRepository(database),
    loadRendition: async (snapshot, signal) => {
      const reference = snapshot.rendition.bodyRef;
      if (
        (reference.bucket !== contentBucket && !legacyContentBuckets.includes(reference.bucket)) ||
        !reference.key.startsWith(`organizations/${snapshot.brain.organizationId}/brains/`) ||
        !reference.versionId
      ) {
        throw new TypeError("Brain rendition points outside its immutable content boundary.");
      }
      const response = await s3.send(
        new GetObjectCommand({
          Bucket: reference.bucket,
          Key: reference.key,
          VersionId: reference.versionId,
        }),
        signal ? { abortSignal: signal } : undefined,
      );
      if (!response.Body) throw new TypeError("Brain rendition body is unavailable.");
      const bytes = await response.Body.transformToByteArray();
      const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (bytes.byteLength !== reference.byteSize || hash !== reference.sha256) {
        throw new TypeError("Brain rendition bytes do not match canonical evidence metadata.");
      }
      return bytes;
    },
    providers: makeBrainSearchProviderRegistry({ config, database }),
    repository,
    textRenditionStore: makeS3BrainTextRenditionStore({
      bucket: contentBucket,
      kmsKeyArn: requiredEnvironment(environment, "DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN"),
      s3,
    }),
    workerId:
      environment.AWS_LAMBDA_LOG_STREAM_NAME?.trim() ||
      environment.AWS_LAMBDA_FUNCTION_NAME?.trim() ||
      randomUUID(),
  };
  return dependencies;
}

let redelivery: BrainIndexQueueRedelivery | undefined;

function createRedelivery(environment: NodeJS.ProcessEnv = process.env) {
  const queueUrl = requiredEnvironment(environment, "DEPLOYMENTS_AI_BRAIN_INDEX_QUEUE_URL");
  const sqs = new SQSClient({});
  return {
    changeVisibility: async (receiptHandle: string, visibilitySeconds: number) => {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: visibilitySeconds,
        }),
      );
    },
    random: Math.random,
  };
}

export async function handler(event: BrainIndexQueueEvent) {
  runtimePromise ??= createRuntime().catch((cause) => {
    runtimePromise = undefined;
    throw cause;
  });
  redelivery ??= createRedelivery();
  return handleBrainIndexQueue(event, await runtimePromise, redelivery);
}
