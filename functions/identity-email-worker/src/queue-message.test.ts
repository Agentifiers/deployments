import { expect, test } from "bun:test";
import { identityEmailQueueMessage } from "./queue-message.ts";

test("deduplicates email handoff by delivery ID within its dispatch shard", () => {
  expect(
    identityEmailQueueMessage({
      deliveryId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      dispatchShard: "03",
      queueUrl: "https://sqs.example/identity-email.fifo",
    }),
  ).toEqual({
    MessageBody: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    MessageDeduplicationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    MessageGroupId: "identity-email-03",
    QueueUrl: "https://sqs.example/identity-email.fifo",
  });
});
