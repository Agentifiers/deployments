import { SendMessageBatchCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { Ulid } from "@deployments-ai/db";
import {
  NetSecurityError,
  NetSecurityRedirectError,
  executePinnedHttpsWithSameOriginRedirects,
  type DnsLookup,
} from "@deployments-ai/net-security";
import { TerminalWebhookSenderError, type WebhookRequestSender } from "@deployments-ai/webhooks";
import { Schema } from "effect";

export const WEBHOOK_DELIVERY_QUEUE_URL_ENV = "DEPLOYMENTS_AI_WEBHOOK_DELIVERY_QUEUE_URL";
const WEBHOOK_DELIVERY_RETENTION_DAYS_ENV = "DEPLOYMENTS_AI_WEBHOOK_DELIVERY_RETENTION_DAYS";
const WEBHOOK_METRICS_NAMESPACE = "DeploymentsAi/Webhooks";

/** One SQS message per delivery; the delivery record carries all state. */
export const WebhookDeliveryMessage = Schema.Struct({
  deliveryId: Ulid,
  environmentId: Ulid,
  organizationId: Ulid,
  version: Schema.Literal(1),
});
export type WebhookDeliveryMessage = typeof WebhookDeliveryMessage.Type;

export interface WebhookDeliveryQueue {
  readonly enqueue: (messages: readonly WebhookDeliveryMessage[]) => Promise<void>;
}

const SQS_BATCH_SIZE = 10;

export function createSqsWebhookDeliveryQueue(
  sqs: SQSClient,
  queueUrl: string,
): WebhookDeliveryQueue {
  return {
    async enqueue(messages) {
      for (let start = 0; start < messages.length; start += SQS_BATCH_SIZE) {
        const batch = messages.slice(start, start + SQS_BATCH_SIZE);
        if (batch.length === 1) {
          await sqs.send(
            new SendMessageCommand({ MessageBody: JSON.stringify(batch[0]), QueueUrl: queueUrl }),
          );
          continue;
        }
        const result = await sqs.send(
          new SendMessageBatchCommand({
            Entries: batch.map((message, index) => ({
              Id: String(index),
              MessageBody: JSON.stringify(message),
            })),
            QueueUrl: queueUrl,
          }),
        );
        if ((result.Failed?.length ?? 0) > 0) {
          throw new Error(`${result.Failed?.length} webhook delivery messages were not enqueued.`);
        }
      }
    },
  };
}

/**
 * Production egress: the URL's host is resolved once, every resolved address must be public
 * (private, loopback, link-local, metadata, and special-purpose ranges are refused), the
 * connection is pinned to those addresses, and redirects are not followed. Policy refusals are
 * terminal; an empty or malformed DNS answer stays retryable because DNS can recover.
 */
export function createPinnedWebhookSender(options: { readonly dnsLookup?: DnsLookup } = {}) {
  return {
    send: async (request) => {
      try {
        return (
          await executePinnedHttpsWithSameOriginRedirects({
            body: request.body,
            ...(options.dnsLookup ? { dnsLookup: options.dnsLookup } : {}),
            headers: { ...request.headers },
            maxRedirects: 0,
            method: "POST",
            signal: AbortSignal.timeout(request.timeoutMs),
            url: request.url,
            verifiedOrigin: new URL(request.url).origin,
          })
        ).response;
      } catch (cause) {
        if (
          cause instanceof NetSecurityRedirectError ||
          (cause instanceof NetSecurityError &&
            cause.code !== "empty-dns" &&
            cause.code !== "invalid-dns")
        ) {
          throw new TerminalWebhookSenderError(`Webhook egress refused: ${cause.message}`, {
            cause,
          });
        }
        throw cause;
      }
    },
  } satisfies WebhookRequestSender;
}

export function webhookDeliveryRetentionDays(env: NodeJS.ProcessEnv) {
  const raw = env[WEBHOOK_DELIVERY_RETENTION_DAYS_ENV]?.trim();
  const days = Number(raw);
  if (!raw || !Number.isSafeInteger(days) || days < 1) {
    throw new Error(
      `${WEBHOOK_DELIVERY_RETENTION_DAYS_ENV} must be a positive whole number of days.`,
    );
  }
  return days;
}

/** CloudWatch embedded metric format line; aggregate dimensions only, never tenant IDs. */
export function emitWebhookMetrics(
  metrics: Readonly<Record<string, number>>,
  dimensions: Readonly<Record<string, string>> = {},
  log: (line: string) => void = console.log,
) {
  const names = Object.keys(metrics);
  if (names.length === 0) return;
  log(
    JSON.stringify({
      _aws: {
        CloudWatchMetrics: [
          {
            Dimensions: [Object.keys(dimensions)],
            Metrics: names.map((name) => ({
              Name: name,
              Unit: name.endsWith("Ms") ? "Milliseconds" : "Count",
            })),
            Namespace: WEBHOOK_METRICS_NAMESPACE,
          },
        ],
        Timestamp: Date.now(),
      },
      ...dimensions,
      ...metrics,
    }),
  );
}
