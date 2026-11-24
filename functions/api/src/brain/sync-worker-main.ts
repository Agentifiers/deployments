import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  makeCredentialVault,
  makeBrainDynamoRepository,
  makeDynamoDatabase,
  makeIdGenerator,
  parseBrainUploadQuotas,
  tableNamesFromEnvironment,
  type CredentialVaultReference,
} from "@deployments-ai/db";
import { createHash, randomUUID } from "node:crypto";
import { requiredEnvironment } from "../lambda-environment.ts";
import { makeGitHubBrainConnector } from "./github-connector.ts";
import {
  processBrainSyncMessage,
  type BrainSyncQueueMessage,
  type BrainSyncRuntimeDependencies,
} from "./sync-runtime.ts";

interface QueueRecord {
  readonly body: string;
  readonly messageId: string;
}

export interface BrainSyncQueueEvent {
  readonly Records: readonly QueueRecord[];
}

function parseMessage(body: string): BrainSyncQueueMessage {
  const value = JSON.parse(body) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Brain sync queue body must be an object.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const requiredField = (field: keyof BrainSyncQueueMessage) => {
    const fieldValue = record[field];
    if (typeof fieldValue !== "string" || !fieldValue.trim()) {
      throw new TypeError(`Brain sync queue ${field} is required.`);
    }
    return fieldValue;
  };
  return {
    brainId: requiredField("brainId"),
    idempotencyKey: requiredField("idempotencyKey"),
    organizationId: requiredField("organizationId"),
  };
}

export async function handleBrainSyncQueue(
  event: BrainSyncQueueEvent,
  dependencies: BrainSyncRuntimeDependencies,
) {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      await processBrainSyncMessage(parseMessage(record.body), dependencies);
    } catch (cause) {
      console.error("Brain sync queue record failed.", {
        errorType: cause instanceof Error ? cause.name : "UnknownError",
        messageId: record.messageId,
      });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}

let runtimePromise: Promise<BrainSyncRuntimeDependencies> | undefined;

async function createRuntime(environment: NodeJS.ProcessEnv = process.env) {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const tables = tableNamesFromEnvironment(environment);
  const database = makeDynamoDatabase(documentClient, tables);
  const ids = makeIdGenerator();
  const s3 = new S3Client({});
  const bucket = requiredEnvironment(environment, "DEPLOYMENTS_AI_ARTIFACT_BUCKET");
  const kmsKeyArn = requiredEnvironment(environment, "DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN");
  const vault = makeCredentialVault({
    documentClient,
    kmsClient: new KMSClient({}),
    kmsKeyArn: requiredEnvironment(environment, "DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN"),
    tableName: tables.control,
  });
  return {
    database,
    generateId: async () => ids.generate(),
    loadGitHubSnapshot: makeGitHubBrainConnector(),
    readGitHubAccessToken: async ({ connection, expectedGeneration }) => {
      const reference = connection.data.credentialRef as CredentialVaultReference;
      if (reference.store !== "dynamodb-kms" || reference.generation !== expectedGeneration) {
        throw new Error("Brain GitHub credential reference changed before use.");
      }
      // githubConnectionAuthorization admits only OAuth vendor_mcp connections; the vault entry
      // holds GitHub's OAuth access token, used directly against the GitHub REST API.
      const secret = await vault.read({
        environmentId: connection.data.environmentId,
        expectedIdentity: {
          ownerId: connection.data.id,
          ownerType: "provider-connection",
          projectId: connection.data.projectId,
          purpose: "provider-oauth-token",
        },
        organizationId: connection.data.organizationId,
        reference,
      });
      if (secret.generation !== expectedGeneration) {
        throw new Error("Brain GitHub credential generation changed during decryption.");
      }
      const token = secret.values.accessToken;
      if (!token?.trim()) throw new Error("Brain GitHub credential has no access token.");
      return token.trim();
    },
    repository: makeBrainDynamoRepository(database, parseBrainUploadQuotas(environment)),
    upload: async ({
      brainId,
      bytes,
      contentHash,
      contentType,
      objectKey,
      organizationId,
      signal,
    }) => {
      const checksum = createHash("sha256").update(bytes).digest();
      const response = await s3.send(
        new PutObjectCommand({
          Body: bytes,
          Bucket: bucket,
          ChecksumSHA256: checksum.toString("base64"),
          ContentLength: bytes.byteLength,
          ContentType: contentType,
          IfNoneMatch: "*",
          Key: objectKey,
          Metadata: { brainId, organizationId },
          ServerSideEncryption: "aws:kms",
          SSEKMSKeyId: kmsKeyArn,
        }),
        signal ? { abortSignal: signal } : undefined,
      );
      if (!response.VersionId) throw new Error("Brain GitHub upload has no immutable S3 version.");
      return {
        bucket,
        byteSize: bytes.byteLength,
        contentType,
        ...(response.ETag ? { etag: response.ETag } : {}),
        key: objectKey,
        sha256: contentHash,
        versionId: response.VersionId,
      };
    },
    workerId:
      environment.AWS_LAMBDA_LOG_STREAM_NAME?.trim() ||
      environment.AWS_LAMBDA_FUNCTION_NAME?.trim() ||
      randomUUID(),
  } satisfies BrainSyncRuntimeDependencies;
}

export async function handler(event: BrainSyncQueueEvent) {
  runtimePromise ??= createRuntime().catch((cause) => {
    runtimePromise = undefined;
    throw cause;
  });
  return handleBrainSyncQueue(event, await runtimePromise);
}
