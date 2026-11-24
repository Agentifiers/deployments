import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { STSClient } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { makeTenantRoleSessions } from "@deployments-ai/credential-vault";
import {
  createConversationService,
  endUserKeyDeriver,
  type ConversationServiceOptions,
  type EndUserKeyDeriver,
} from "@deployments-ai/conversations";
import {
  channelIngressBurstRouteId,
  makeDynamoDatabase,
  makeChannelIngressBurstPersistence,
  makeIdGenerator,
  makeInboundPersistence,
  tableNamesFromEnvironment,
  type DynamoDatabaseService,
  type Ulid,
} from "@deployments-ai/db";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import { makeS3IngressAttachmentObjectStore } from "@deployments-ai/ingress-media";
import { readChannelCredentialValues } from "./channel-credentials.ts";
import { flushDocumentExtractor } from "./flush-document-extractor.ts";
import {
  makeChannelIngressAttachments,
  type ChannelIngressAttachmentsPorts,
} from "./ingress-attachments.ts";
import {
  processChannelIngressQueueCommand,
  type ChannelIngressQueueConsumerDependencies,
} from "./ingress-consumer.ts";
import { channelIngressFlushQueueMessage, channelIngressQueueRoute } from "./ingress-message.ts";

const RUN_QUEUE_URL_ENV = "DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL";
const INGRESS_FLUSH_QUEUE_URL_ENV = "DEPLOYMENTS_AI_CHANNEL_INGRESS_FLUSH_QUEUE_URL";
const ARTIFACT_BUCKET_ENV = "DEPLOYMENTS_AI_ARTIFACT_BUCKET";
const ARTIFACT_KMS_KEY_ARN_ENV = "DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN";
const END_USER_SUBJECT_KEY_ARN_ENV = "DEPLOYMENTS_AI_END_USER_SUBJECT_KEY_ARN";
const INGRESS_ATTACHMENT_CAPTURE_ROLE_ARN_ENV =
  "DEPLOYMENTS_AI_INGRESS_ATTACHMENT_CAPTURE_ROLE_ARN";

export interface SqsEventLike {
  readonly Records?: readonly {
    readonly body: string;
    readonly messageId: string;
  }[];
}

function required(name: string, env: NodeJS.ProcessEnv) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function isChannelIngressQueueRuntime(
  value: unknown,
): value is ChannelIngressQueueConsumerDependencies {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ChannelIngressQueueConsumerDependencies).loadBinding === "function"
  );
}

export interface ChannelIngressQueuePorts {
  readonly attachments: ChannelIngressAttachmentsPorts;
  readonly database: DynamoDatabaseService;
  readonly endUserSubjects: EndUserKeyDeriver;
  readonly enqueueFlush: ChannelIngressQueueConsumerDependencies["enqueueFlush"];
  readonly enqueueRun: ConversationServiceOptions["enqueueRun"];
  readonly generateId: () => Promise<Ulid>;
  readonly now?: () => Date;
}

export function channelIngressQueueDependencies(
  ports: ChannelIngressQueuePorts,
): ChannelIngressQueueConsumerDependencies {
  const persistence = makeInboundPersistence({
    database: ports.database,
    generateId: ports.generateId,
  });
  return {
    burstPersistence: makeChannelIngressBurstPersistence({
      database: ports.database,
      ...(ports.now ? { now: ports.now } : {}),
    }),
    endUserSubjects: ports.endUserSubjects,
    enqueueFlush: ports.enqueueFlush,
    ingressAttachments: makeChannelIngressAttachments({
      ...ports.attachments,
      database: ports.database,
      loadBinding: (scope, bindingId) => persistence.loadChannelBinding(scope, bindingId),
    }),
    loadBinding: (message) => persistence.loadChannelBinding(message, message.bindingId),
    loadDeployment: (message, deploymentId) =>
      persistence.loadAgentDeployment(message, deploymentId),
    loadRelease: (message, releaseId) => persistence.loadAgentRelease(message, releaseId),
    resolveThreadId: (input) =>
      persistence.reserveThreadRoute({
        agentDeploymentId: input.agentDeploymentId,
        channel: input.message.ingress.channel,
        createdAt: input.message.receivedAt,
        environmentId: input.message.environmentId,
        ...(input.message.ingress.externalAccountId
          ? { externalAccountId: input.message.ingress.externalAccountId }
          : {}),
        externalChannelId: input.message.ingress.externalChannelId,
        externalThreadKey: input.externalThreadKey,
        ...(input.message.ingress.externalWorkspaceId
          ? { externalWorkspaceId: input.message.ingress.externalWorkspaceId }
          : {}),
        ingressRouteId: channelIngressBurstRouteId(channelIngressQueueRoute(input.message)),
        organizationId: input.message.organizationId,
        projectId: input.message.projectId,
        provider: input.message.ingress.provider,
        sourceId: input.sourceId,
        sourceKind: "channel-binding",
      }),
    submitTurn: createConversationService({
      database: ports.database,
      enqueueRun: ports.enqueueRun,
      generateId: ports.generateId,
      ...(ports.now ? { now: ports.now } : {}),
    }).submitTurn,
  };
}

async function createAwsChannelIngressConsumerDependencies(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChannelIngressQueueConsumerDependencies> {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const idGenerator = makeIdGenerator();
  const sqs = new SQSClient({});
  const runQueueUrl = required(RUN_QUEUE_URL_ENV, env);
  const ingressFlushQueueUrl = required(INGRESS_FLUSH_QUEUE_URL_ENV, env);
  const endUserSubjectKeyArn = required(END_USER_SUBJECT_KEY_ARN_ENV, env);
  const kmsKeyArn = required(ARTIFACT_KMS_KEY_ARN_ENV, env);
  return channelIngressQueueDependencies({
    attachments: {
      artifactBucket: required(ARTIFACT_BUCKET_ENV, env),
      extractor: flushDocumentExtractor,
      openObjectStore: makeTenantRoleSessions({
        open: (credentials) =>
          makeS3IngressAttachmentObjectStore({ kmsKeyArn, s3: new S3Client({ credentials }) }),
        roleArn: required(INGRESS_ATTACHMENT_CAPTURE_ROLE_ARN_ENV, env),
        sessionName: "channel-attachment-capture",
        sts: new STSClient({}),
      }),
      readCredentialValues: readChannelCredentialValues,
      transport: {},
    },
    database: makeDynamoDatabase(documentClient, tableNamesFromEnvironment(env)),
    endUserSubjects: endUserKeyDeriver(await loadAwsSecretString(endUserSubjectKeyArn)),
    enqueueFlush: async (flush) => {
      await sqs.send(
        new SendMessageCommand({
          DelaySeconds: Math.max(
            0,
            Math.min(900, Math.ceil((Date.parse(flush.dueAt) - Date.now()) / 1_000)),
          ),
          MessageBody: JSON.stringify(channelIngressFlushQueueMessage(flush)),
          QueueUrl: ingressFlushQueueUrl,
        }),
      );
    },
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
  });
}

let dependencies: Promise<ChannelIngressQueueConsumerDependencies> | undefined;

export async function handleChannelIngressQueue(event: SqsEventLike, runtime?: unknown) {
  const resolved = isChannelIngressQueueRuntime(runtime)
    ? runtime
    : await (dependencies ??= createAwsChannelIngressConsumerDependencies().catch(
        (cause: unknown) => {
          dependencies = undefined;
          throw cause;
        },
      ));
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records ?? []) {
    try {
      const outcome = await processChannelIngressQueueCommand(
        JSON.parse(record.body) as unknown,
        resolved,
      );
      if (outcome.kind === "refused") {
        console.warn("Channel ingress burst refused.", {
          code: outcome.code,
          detail: outcome.detail,
          messageId: record.messageId,
        });
      }
      if (outcome.kind === "submitted") {
        const admission = outcome.result.created ? outcome.result.omittedInputArtifacts : [];
        const { omittedAttachments, skippedAttachments } = outcome;
        if (
          admission.length > 0 ||
          omittedAttachments.length > 0 ||
          skippedAttachments.length > 0
        ) {
          console.warn("Channel ingress attachments left out.", {
            admission,
            capture: omittedAttachments,
            messageId: record.messageId,
            runId: outcome.result.run.data.id,
            skipped: skippedAttachments,
          });
        }
      }
    } catch (cause) {
      console.error("Channel ingress command failed.", {
        errorType: cause instanceof Error ? cause.name : "UnknownError",
        message: cause instanceof Error ? cause.message : undefined,
        messageId: record.messageId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

export const handler = handleChannelIngressQueue;
