import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { decodePlatformRecord } from "@deployments-ai/db";
import { Effect } from "effect";
import { queueIdentityEmailDelivery } from "./queue-delivery.ts";
import { identityEmailQueueMessage } from "./queue-message.ts";
import { repository, required } from "./runtime.ts";

interface StreamRecord {
  readonly dynamodb?: {
    readonly NewImage?: Record<string, unknown>;
    readonly SequenceNumber?: string;
  };
  readonly eventID?: string;
}

const sqs = new SQSClient({});
const queueUrl = required("DEPLOYMENTS_AI_IDENTITY_EMAIL_QUEUE_URL");

export async function handler(event: { readonly Records?: readonly StreamRecord[] }) {
  const failures: { itemIdentifier: string }[] = [];
  for (const streamRecord of event.Records ?? []) {
    try {
      if (!streamRecord.dynamodb?.NewImage) continue;
      const decoded = await Effect.runPromise(
        decodePlatformRecord(unmarshall(streamRecord.dynamodb.NewImage as never)),
      );
      if (decoded.itemType !== "identity-email-delivery" || decoded.data.status !== "pending") {
        continue;
      }
      await queueIdentityEmailDelivery({
        record: decoded,
        repository,
        send: async (deliveryId, dispatchShard) => {
          await sqs.send(
            new SendMessageCommand(
              identityEmailQueueMessage({ deliveryId, dispatchShard, queueUrl }),
            ),
          );
        },
      });
    } catch {
      const sequenceNumber = streamRecord.dynamodb?.SequenceNumber;
      if (sequenceNumber) failures.push({ itemIdentifier: sequenceNumber });
    }
  }
  return { batchItemFailures: failures };
}
