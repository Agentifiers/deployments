import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { STSClient } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { type AgentEmailBlobStore, type AgentEmailInboxRecord } from "@deployments-ai/agent-email";
import {
  AgentEmailRejectedReceiptError,
  parseSesReceiptObjectKey,
  processAgentEmailInboundReceipt,
  type AgentEmailInboundPersistInput,
} from "@deployments-ai/agent-email/aws";
import { createConversationService, endUserKeyDeriver } from "@deployments-ai/conversations";
import { makeTenantRoleSessions } from "@deployments-ai/credential-vault";
import {
  InboxMailErasedError,
  inboxThreadForThreadKey,
  Keys,
  makeAgentEmailDynamoRepository,
  makeDynamoDatabase,
  makeIdGenerator,
  makeInboundPersistence,
  tableNamesFromEnvironment,
  type PlatformRecord,
} from "@deployments-ai/db";
import { makeLambdaFileTextExtractor } from "@deployments-ai/file-text";
import { makeS3IngressAttachmentObjectStore } from "@deployments-ai/ingress-media";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import { makeEmailIngressAttachments } from "./inbound-attachments.ts";
import {
  decodeAgentEmailInboundWorkflowMessage,
  processAgentEmailInboundWorkflow,
  serializeAgentEmailInboundWorkflowMessage,
} from "./inbound-consumer.ts";
import {
  agentEmailInboundErrorDiagnostic,
  withAgentEmailInboundOperation,
} from "./inbound-error-diagnostics.ts";
import { legacyAgentEmailBuckets } from "./legacy-buckets.ts";

const AGENT_EMAIL_BUCKET_ENV = "DEPLOYMENTS_AI_AGENT_EMAIL_BUCKET";
const AGENT_EMAIL_INBOUND_QUEUE_URL_ENV = "DEPLOYMENTS_AI_AGENT_EMAIL_INBOUND_QUEUE_URL";
const AGENT_EMAIL_RAW_PREFIX_ENV = "DEPLOYMENTS_AI_AGENT_EMAIL_RAW_PREFIX";
const AGENT_RUN_QUEUE_URL_ENV = "DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL";
const ARTIFACT_BUCKET_ENV = "DEPLOYMENTS_AI_ARTIFACT_BUCKET";
const ARTIFACT_KMS_KEY_ARN_ENV = "DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN";
const INGRESS_ATTACHMENT_CAPTURE_ROLE_ARN_ENV =
  "DEPLOYMENTS_AI_INGRESS_ATTACHMENT_CAPTURE_ROLE_ARN";
const DOCUMENT_EXTRACTION_FUNCTION_NAME_ENV = "DEPLOYMENTS_AI_DOCUMENT_EXTRACTION_FUNCTION_NAME";
const END_USER_SUBJECT_KEY_ARN_ENV = "DEPLOYMENTS_AI_END_USER_SUBJECT_KEY_ARN";
const DEFAULT_RAW_PREFIX = "raw/";

export async function headAgentEmailInboundObject(
  s3: Pick<S3Client, "send">,
  bucket: string,
  key: string,
) {
  const listed = await s3.send(
    new ListObjectVersionsCommand({
      Bucket: bucket,
      MaxKeys: 2,
      Prefix: key,
    }),
  );
  if (listed.DeleteMarkers?.some((marker) => marker.IsLatest && marker.Key === key)) {
    return undefined;
  }
  const current = listed.Versions?.find((version) => version.IsLatest && version.Key === key);
  return current ? (current.VersionId ? { versionId: current.VersionId } : {}) : undefined;
}

interface AgentEmailInboundQueueRecord {
  readonly body: string;
  readonly messageId: string;
}

export interface AgentEmailInboundQueueEvent {
  readonly Records?: readonly AgentEmailInboundQueueRecord[];
}

export interface AgentEmailInboundMainDependencies {
  readonly processReceipt: (record: AgentEmailInboundQueueRecord) => Promise<unknown>;
  readonly processReprocess: (value: unknown) => Promise<unknown>;
  readonly processWorkflow: (value: unknown) => Promise<unknown>;
}

import {
  agentEmailInboundReceiptCompletionKey,
  agentEmailInboundRouteIsActive,
  agentEmailWorkflowMessageSource,
  commandEnvelope,
  databaseRecord,
  discardRejectedAgentEmailReceipt,
  environmentPolicies,
  inboxModel,
  loadAgentEmailInboundReceiptSource,
  required,
  resolveAgentEmailRawRetentionDays,
  resolveInboundThreadReservation,
  ulid,
} from "./inbound-receipt-routing.ts";
export * from "./inbound-receipt-routing.ts";
export * from "./inbound-reprocessing.ts";
export * from "./inbound-error-diagnostics.ts";

function makeInboundBlobStore(
  s3: S3Client,
  bucket: string,
  legacyBuckets: readonly string[],
): AgentEmailBlobStore {
  const objectBucket = (targetBucket?: string) => {
    const candidate = targetBucket ?? bucket;
    if (candidate !== bucket && !legacyBuckets.includes(candidate)) {
      throw new Error("Agent email object points outside the approved storage buckets.");
    }
    return candidate;
  };
  return {
    delete: async (key, targetBucket, versionId) => {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: objectBucket(targetBucket),
          Key: key,
          ...(versionId ? { VersionId: versionId } : {}),
        }),
      );
    },
    get: async (key, versionId, targetBucket) => {
      const result = await s3.send(
        new GetObjectCommand({
          Bucket: objectBucket(targetBucket),
          Key: key,
          ...(versionId ? { VersionId: versionId } : {}),
        }),
      );
      if (!result.Body) throw new Error(`S3 object ${key} has no body.`);
      return result.Body.transformToByteArray();
    },
    put: async ({ body, contentType, ifAbsent, key, metadata }) => {
      try {
        const result = await s3.send(
          new PutObjectCommand({
            Body: body,
            Bucket: bucket,
            ContentType: contentType,
            ...(ifAbsent ? { IfNoneMatch: "*" } : {}),
            Key: key,
            Metadata: metadata,
          }),
        );
        return {
          created: true,
          ...(result.ETag ? { etag: result.ETag } : {}),
          ...(result.VersionId ? { versionId: result.VersionId } : {}),
        };
      } catch (cause) {
        const status =
          cause && typeof cause === "object" && "$metadata" in cause
            ? (cause.$metadata as { readonly httpStatusCode?: number }).httpStatusCode
            : undefined;
        if (
          !ifAbsent ||
          !(status === 412 || (cause instanceof Error && cause.name === "PreconditionFailed"))
        ) {
          throw cause;
        }
        const existing = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        const storedMetadata = new Map(
          Object.entries(existing.Metadata ?? {}).map(([name, value]) => [
            name.toLowerCase(),
            value,
          ]),
        );
        if (
          existing.ContentLength !== body.byteLength ||
          existing.ContentType !== contentType ||
          Object.entries(metadata ?? {}).some(
            ([name, value]) => storedMetadata.get(name.toLowerCase()) !== value,
          )
        ) {
          throw new Error(`S3 object ${key} already exists with different content.`, {
            cause,
          });
        }
        return {
          created: false,
          ...(existing.ETag ? { etag: existing.ETag } : {}),
          ...(existing.VersionId ? { versionId: existing.VersionId } : {}),
        };
      }
    },
    signedGetUrl: async () => {
      throw new Error("Signed blob access is not available in the inbound email worker.");
    },
  };
}

import { reprocessAgentEmailMessage } from "./inbound-reprocessing.ts";

async function createAwsAgentEmailInboundDependencies(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentEmailInboundMainDependencies> {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const database = makeDynamoDatabase(documentClient, tableNamesFromEnvironment(env));
  const persistence = makeInboundPersistence({ database });
  const endUserKeys = endUserKeyDeriver(
    await loadAwsSecretString(required(END_USER_SUBJECT_KEY_ARN_ENV, env)),
  );
  const bucket = required(AGENT_EMAIL_BUCKET_ENV, env);
  const inboundQueueUrl = required(AGENT_EMAIL_INBOUND_QUEUE_URL_ENV, env);
  const runQueueUrl = required(AGENT_RUN_QUEUE_URL_ENV, env);
  const artifactBucket = required(ARTIFACT_BUCKET_ENV, env);
  const kmsKeyArn = required(ARTIFACT_KMS_KEY_ARN_ENV, env);
  const region = required("AWS_REGION", env);
  const rawPrefix = env[AGENT_EMAIL_RAW_PREFIX_ENV]?.trim() || DEFAULT_RAW_PREFIX;
  const legacyBuckets = legacyAgentEmailBuckets(env);
  if (!rawPrefix.endsWith("/")) {
    throw new Error(`${AGENT_EMAIL_RAW_PREFIX_ENV} must end with a slash.`);
  }
  const s3 = new S3Client({ region });
  const sqs = new SQSClient({ region });
  const openArtifactObjects = makeTenantRoleSessions({
    open: (credentials) =>
      makeS3IngressAttachmentObjectStore({
        kmsKeyArn,
        s3: new S3Client({ credentials, region }),
      }),
    roleArn: required(INGRESS_ATTACHMENT_CAPTURE_ROLE_ARN_ENV, env),
    sessionName: "email-attachment-capture",
    sts: new STSClient({ region }),
  });
  const extractor = makeLambdaFileTextExtractor({
    functionName: required(DOCUMENT_EXTRACTION_FUNCTION_NAME_ENV, env),
    lambda: new LambdaClient({ region }),
  });
  const blobs = makeInboundBlobStore(s3, bucket, legacyBuckets);
  const approvedReceiptBucket = (candidate?: string) => {
    const resolved = candidate ?? bucket;
    if (resolved !== bucket && !legacyBuckets.includes(resolved)) {
      throw new Error("SES receipt points outside the approved agent email buckets.");
    }
    return resolved;
  };
  const idGenerator = makeIdGenerator();
  const submitTurn = createConversationService({
    database,
    enqueueRun: async ({ deduplicationId, message, messageGroupId }, signal) => {
      await sqs.send(
        new SendMessageCommand({
          MessageBody: JSON.stringify(message),
          MessageDeduplicationId: deduplicationId,
          MessageGroupId: messageGroupId,
          QueueUrl: runQueueUrl,
        }),
        signal ? { abortSignal: signal } : undefined,
      );
    },
    generateId: async () => idGenerator.generate(),
  }).submitTurn;

  return {
    processReceipt: async (record) => {
      let receipt: ReturnType<typeof parseSesReceiptObjectKey>;
      try {
        // Parsing fails closed unless both SES spam and virus verdicts are PASS, before S3 access.
        receipt = parseSesReceiptObjectKey(record);
      } catch (cause) {
        if (!(cause instanceof AgentEmailRejectedReceiptError)) throw cause;
        const receiptBucket = approvedReceiptBucket(cause.bucket);
        return discardRejectedAgentEmailReceipt(cause, {
          deleteRaw: async (key, versionId) => {
            await s3.send(
              new DeleteObjectCommand({
                Bucket: receiptBucket,
                Key: key,
                ...(versionId ? { VersionId: versionId } : {}),
              }),
            );
          },
          loadRaw: async (key) => headAgentEmailInboundObject(s3, receiptBucket, key),
          rawPrefix,
        });
      }
      const receiptBucket = approvedReceiptBucket(receipt.bucket);
      if (!receipt.objectKey.startsWith(rawPrefix)) {
        throw new Error("SES receipt object key is outside the configured raw prefix.");
      }
      const completionKey = agentEmailInboundReceiptCompletionKey(rawPrefix, receipt);
      const object = await withAgentEmailInboundOperation("load-receipt-source", () =>
        loadAgentEmailInboundReceiptSource(
          {
            completionKey,
            objectKey: receipt.objectKey,
          },
          {
            deleteRaw: async (key, versionId) => {
              await s3.send(
                new DeleteObjectCommand({
                  Bucket: receiptBucket,
                  Key: key,
                  ...(versionId ? { VersionId: versionId } : {}),
                }),
              );
            },
            head: async (key) => headAgentEmailInboundObject(s3, receiptBucket, key),
            load: async (key, versionId) => {
              const result = await s3.send(
                new GetObjectCommand({
                  Bucket: receiptBucket,
                  Key: key,
                  ...(versionId ? { VersionId: versionId } : {}),
                }),
              );
              if (!result.Body) throw new Error(`S3 object ${key} has no body.`);
              return {
                ...(result.ETag ? { etag: result.ETag } : {}),
                raw: await result.Body.transformToByteArray(),
                ...(result.VersionId ? { versionId: result.VersionId } : {}),
              };
            },
          },
        ),
      );
      if (!object) return { disposition: "already-completed" as const };
      const policyCache = new Map<
        string,
        Promise<readonly Extract<PlatformRecord, { readonly itemType: "inbox-policy" }>[]>
      >();

      return withAgentEmailInboundOperation("process-receipt", () =>
        processAgentEmailInboundReceipt(
          {
            completionKey,
            objectKey: receipt.objectKey,
            providerMessageId: receipt.messageId,
            providerRegion: region,
            raw: object.raw,
            rawReference: {
              bucket: receiptBucket,
              ...(object.etag ? { etag: object.etag } : {}),
              key: receipt.objectKey,
              ...(object.versionId ? { versionId: object.versionId } : {}),
            },
            receivedAt: receipt.receivedAt,
            recipients: receipt.recipients,
          },
          {
            blobs,
            bucket,
            dispatch: ({ bodySummary, inbox, message, route }) =>
              withAgentEmailInboundOperation("dispatch-workflow", async () => {
                const command = decodeAgentEmailInboundWorkflowMessage({
                  attachments: message.attachments.map((attachment) => ({
                    byteSize: attachment.byteSize,
                    contentType: attachment.contentType,
                    disposition: attachment.disposition,
                    fileName: attachment.fileName,
                    id: attachment.id,
                  })),
                  bodySummary,
                  ccAddresses: message.ccAddresses,
                  environmentId: route.environmentId,
                  fromAddress: message.fromAddress,
                  inboxId: inbox.id,
                  ...(message.internetMessageId
                    ? { internetMessageId: message.internetMessageId }
                    : {}),
                  messageId: message.id,
                  organizationId: inbox.organizationId,
                  projectId: route.projectId,
                  provider: "ses",
                  providerMessageId: receipt.messageId,
                  receivedAt: receipt.receivedAt,
                  receiptRegion: region,
                  subject: message.subject,
                  threadKey: message.threadKey,
                  toAddresses: message.toAddresses,
                  type: "agent-email.inbound-workflow",
                  version: 1,
                });
                await sqs.send(
                  new SendMessageCommand({
                    MessageBody: serializeAgentEmailInboundWorkflowMessage(command),
                    QueueUrl: inboundQueueUrl,
                  }),
                );
              }),
            isPersisted: (message, route) =>
              withAgentEmailInboundOperation("reconcile-message", async () => {
                const repository = makeAgentEmailDynamoRepository(database, {
                  environmentId: ulid(route.environmentId),
                  organizationId: ulid(message.organizationId),
                  projectId: ulid(route.projectId),
                });
                const durable = await repository.getMessage(message.inboxId, message.id);
                return (
                  durable?.data.id === message.id &&
                  durable.data.inboxId === message.inboxId &&
                  durable.data.organizationId === message.organizationId &&
                  durable.data.environmentId === route.environmentId &&
                  durable.data.projectId === route.projectId &&
                  durable.data.providerMessageId === message.providerMessageId
                );
              }),
            persist: (input: AgentEmailInboundPersistInput, route) =>
              withAgentEmailInboundOperation("persist-message", async () => {
                const scope = {
                  environmentId: ulid(route.environmentId),
                  organizationId: ulid(input.message.organizationId),
                  projectId: ulid(route.projectId),
                };
                const repository = makeAgentEmailDynamoRepository(database, scope, endUserKeys);
                try {
                  await repository.persistMessage({
                    ...input,
                    attachments: input.attachments.map((attachment) => ({
                      ...attachment,
                      id: ulid(attachment.id),
                    })),
                  });
                  return "persisted" as const;
                } catch (cause) {
                  if (cause instanceof InboxMailErasedError) return "erased" as const;
                  throw cause;
                }
              }),
            reserve: async (input) =>
              withAgentEmailInboundOperation("reserve-thread", () =>
                resolveInboundThreadReservation(
                  {
                    providerMessageId: receipt.messageId,
                    providerRegion: region,
                    receivedAt: receipt.receivedAt,
                  },
                  input,
                  (organizationId, inboxId, threadKey) =>
                    inboxThreadForThreadKey(database, { inboxId, organizationId, threadKey }),
                ),
              ),
            resolveRecipients: (recipients) =>
              withAgentEmailInboundOperation("resolve-recipients", async () => {
                const routes = new Map<
                  string,
                  {
                    readonly environmentId: string;
                    readonly inbox: AgentEmailInboxRecord;
                    readonly projectId: string;
                    readonly rawRetentionDays: number;
                  }
                >();
                for (const recipient of recipients) {
                  const address = recipient.trim().toLowerCase();
                  if (!address) continue;
                  const claim = await databaseRecord(
                    database,
                    "control",
                    Keys.control.uniqueClaim("inbox-address", address),
                  );
                  if (!claim) continue;
                  if (
                    claim.itemType !== "unique-claim" ||
                    claim.data.ownerItemType !== "inbox" ||
                    claim.data.value.toLowerCase() !== address
                  ) {
                    throw new Error(`Agent email recipient claim for ${address} is invalid.`);
                  }
                  const owner = await databaseRecord(database, claim.data.ownerTable, {
                    pk: claim.data.ownerPk,
                    sk: claim.data.ownerSk,
                  });
                  if (owner?.itemType !== "inbox" || owner.data.address.toLowerCase() !== address) {
                    throw new Error(`Agent email recipient owner for ${address} is invalid.`);
                  }
                  if (routes.has(owner.data.id)) continue;
                  const scope = {
                    environmentId: owner.data.environmentId,
                    organizationId: owner.data.organizationId,
                    projectId: owner.data.projectId,
                  };
                  const environmentRecord = await persistence.loadEnvironment(scope);
                  const domainRecord = await databaseRecord(database, "control", {
                    pk: `ORG#${owner.data.organizationId}#ENV#${owner.data.environmentId}`,
                    sk: `INBOX-DOMAIN#${owner.data.domainId}`,
                  });
                  if (!agentEmailInboundRouteIsActive(owner, environmentRecord, domainRecord)) {
                    continue;
                  }
                  const cacheKey = JSON.stringify(scope);
                  const policies = await (policyCache.get(cacheKey) ??
                    (() => {
                      const pending = environmentPolicies(database, scope);
                      policyCache.set(cacheKey, pending);
                      return pending;
                    })());
                  routes.set(owner.data.id, {
                    environmentId: owner.data.environmentId,
                    inbox: inboxModel(owner),
                    projectId: owner.data.projectId,
                    rawRetentionDays: resolveAgentEmailRawRetentionDays(policies, owner.data.id),
                  });
                }
                return [...routes.values()];
              }),
          },
        ),
      );
    },
    processReprocess: (value) =>
      reprocessAgentEmailMessage(value, { blobs, bucket, database, endUserKeys, legacyBuckets }),
    processWorkflow: (value) =>
      processAgentEmailInboundWorkflow(value, {
        loadBindings: async (message) => {
          const repository = makeAgentEmailDynamoRepository(database, {
            environmentId: message.environmentId,
            organizationId: message.organizationId,
            projectId: message.projectId,
          });
          return repository.listActivePlatformBindingsForInbox(message.inboxId);
        },
        loadDeployment: async (message, deploymentId) => {
          const environmentRecord = await persistence.loadEnvironment(message);
          return environmentRecord?.data.status === "active"
            ? persistence.loadAgentDeployment(message, deploymentId)
            : undefined;
        },
        loadMessageSource: (message) => agentEmailWorkflowMessageSource(database, message),
        loadRelease: (message, releaseId) => persistence.loadAgentRelease(message, releaseId),
        openIngressAttachments: () =>
          makeEmailIngressAttachments({
            artifactBucket,
            database,
            emailBuckets: [bucket, ...legacyBuckets],
            emailObjects: s3,
            extractor,
            openArtifactObjects,
          }),
        reserveThreadRoute: (input) => persistence.reserveThreadRoute(input),
        submitTurn: (input) => submitTurn(input),
      }),
  };
}

let dependencies: Promise<AgentEmailInboundMainDependencies> | undefined;

export async function handleAgentEmailInboundQueue(
  event: AgentEmailInboundQueueEvent,
  runtime?: AgentEmailInboundMainDependencies,
) {
  const resolved =
    runtime ??
    (await (dependencies ??= createAwsAgentEmailInboundDependencies().catch((cause: unknown) => {
      dependencies = undefined;
      throw cause;
    })));
  const batchItemFailures: { readonly itemIdentifier: string }[] = [];
  for (const record of event.Records ?? []) {
    try {
      const command = commandEnvelope(record.body);
      if (command?.type === "agent-email.inbound-workflow") {
        await resolved.processWorkflow(command.value);
      } else if (command?.type === "agent-email.reprocess") {
        await resolved.processReprocess(command.value);
      } else await resolved.processReceipt(record);
    } catch (cause) {
      console.error("Agent email inbound queue record failed.", {
        ...agentEmailInboundErrorDiagnostic(cause),
        messageId: record.messageId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

export const handler = (event: AgentEmailInboundQueueEvent) => handleAgentEmailInboundQueue(event);
