import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
  type GetSecretValueCommandOutput,
} from "@aws-sdk/client-secrets-manager";
import { ChangeMessageVisibilityCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  makeCredentialVault,
  makeDynamoDatabase,
  makeIdGenerator,
  makeOrganizationHoldReader,
  makeWebhookPersistence,
  tableNamesFromEnvironment,
} from "@deployments-ai/db";
import {
  handleWebhookDeliveryMessages,
  type WebhookDeliveryQueueEvent,
  type WebhookDeliveryWorkerDependencies,
} from "./webhook-delivery-worker.ts";
import { required } from "./required-environment.ts";
import {
  fanOutWebhookSemanticEvent,
  type SemanticEventBridgeInput,
  type WebhookFanoutDependencies,
} from "./webhook-fanout.ts";
import {
  WEBHOOK_DELIVERY_QUEUE_URL_ENV,
  createPinnedWebhookSender,
  createSqsWebhookDeliveryQueue,
  emitWebhookMetrics,
  webhookDeliveryRetentionDays,
} from "./webhook-runtime.ts";

const CREDENTIAL_KMS_KEY_ENV = "DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN";
const CONTROL_TABLE_ENV = "DEPLOYMENTS_AI_CONTROL_TABLE";

export type WebhookRuntimeDependencies = WebhookDeliveryWorkerDependencies &
  WebhookFanoutDependencies;

function secretsManagerSigningSecret(result: GetSecretValueCommandOutput) {
  const raw =
    result.SecretString ??
    (result.SecretBinary
      ? new TextDecoder("utf-8", { fatal: true }).decode(result.SecretBinary)
      : "");
  const normalized = raw.trim();
  if (!normalized) throw new Error("Webhook signing secret is unavailable.");
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const values = parsed as Readonly<Record<string, unknown>>;
      const direct = values.signingSecret;
      const nested =
        values.values && typeof values.values === "object" && !Array.isArray(values.values)
          ? (values.values as Readonly<Record<string, unknown>>).signingSecret
          : undefined;
      const candidate = typeof direct === "string" ? direct : nested;
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  } catch {
    // Externally managed secrets may be stored as a raw string rather than JSON.
  }
  return normalized;
}

function createAwsWebhookRuntimeDependencies(
  env: NodeJS.ProcessEnv = process.env,
): WebhookRuntimeDependencies {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const database = makeDynamoDatabase(documentClient, tableNamesFromEnvironment(env));
  const generator = makeIdGenerator();
  const queueUrl = required(WEBHOOK_DELIVERY_QUEUE_URL_ENV, env);
  const sqs = new SQSClient({});
  const secretsManager = new SecretsManagerClient({});
  return {
    changeVisibility: async (receiptHandle, visibilitySeconds) => {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: visibilitySeconds,
        }),
      );
    },
    credentialVault: makeCredentialVault({
      documentClient,
      kmsClient: new KMSClient({}),
      kmsKeyArn: required(CREDENTIAL_KMS_KEY_ENV, env),
      tableName: required(CONTROL_TABLE_ENV, env),
    }),
    emitMetrics: emitWebhookMetrics,
    generateId: async () => generator.generate(),
    now: () => new Date(),
    persistence: makeWebhookPersistence(database),
    queue: createSqsWebhookDeliveryQueue(sqs, queueUrl),
    readSecretsManagerSigningSecret: async (reference) =>
      secretsManagerSigningSecret(
        await secretsManager.send(
          new GetSecretValueCommand({
            SecretId: reference.arn,
            ...(reference.versionId ? { VersionId: reference.versionId } : {}),
            ...(reference.versionStage ? { VersionStage: reference.versionStage } : {}),
          }),
        ),
      ),
    retentionDays: webhookDeliveryRetentionDays(env),
    sender: createPinnedWebhookSender(),
    standing: makeOrganizationHoldReader(database),
  };
}

/**
 * One artifact serves both webhook functions: the EventBridge target fans each semantic event
 * out to delivery records and queue messages, and the SQS event source runs one attempt per
 * message.
 */
export function createWebhookEventHandler(
  dependencies: () => WebhookRuntimeDependencies = createAwsWebhookRuntimeDependencies,
) {
  let resolved: WebhookRuntimeDependencies | undefined;
  return (input: SemanticEventBridgeInput | WebhookDeliveryQueueEvent, _context?: unknown) => {
    resolved ??= dependencies();
    return "Records" in input
      ? handleWebhookDeliveryMessages(input, resolved)
      : fanOutWebhookSemanticEvent(input, resolved);
  };
}

export const handler = createWebhookEventHandler();
