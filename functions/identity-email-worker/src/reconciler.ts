import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { queueIdentityEmailDelivery } from "./queue-delivery.ts";
import { identityEmailQueueMessage } from "./queue-message.ts";
import {
  RECONCILIATION_LIMIT,
  RECONCILIATION_PER_SHARD_LIMIT,
  reconciliationShardOrder,
} from "./reconciliation-order.ts";
import { repository, required } from "./runtime.ts";

const sqs = new SQSClient({});
const queueUrl = required("DEPLOYMENTS_AI_IDENTITY_EMAIL_QUEUE_URL");

export async function handler(event?: { readonly time?: string }) {
  const timestamp = event?.time ? new Date(event.time) : new Date();
  const dueThrough = timestamp.toISOString();
  const deadline = Date.now() + 20_000;
  let sent = 0;
  for (const shard of reconciliationShardOrder(timestamp)) {
    if (sent >= RECONCILIATION_LIMIT || Date.now() >= deadline) break;
    let shardSent = 0;
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await repository.listPendingDeliveries(
        String(shard).padStart(2, "0"),
        dueThrough,
        Math.min(25, RECONCILIATION_LIMIT - sent, RECONCILIATION_PER_SHARD_LIMIT - shardSent),
        cursor,
      );
      for (const record of page.items) {
        if (record.itemType !== "identity-email-delivery" || record.data.status !== "pending") {
          continue;
        }
        await queueIdentityEmailDelivery({
          record,
          repository,
          send: async (deliveryId, dispatchShard) => {
            await sqs.send(
              new SendMessageCommand(
                identityEmailQueueMessage({ deliveryId, dispatchShard, queueUrl }),
              ),
            );
          },
        });
        sent += 1;
        shardSent += 1;
      }
      cursor = page.lastEvaluatedKey;
    } while (
      cursor &&
      sent < RECONCILIATION_LIMIT &&
      shardSent < RECONCILIATION_PER_SHARD_LIMIT &&
      Date.now() < deadline
    );
  }
  return { sent };
}
