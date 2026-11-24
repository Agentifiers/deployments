export function identityEmailQueueMessage(input: {
  readonly deliveryId: string;
  readonly dispatchShard: string;
  readonly queueUrl: string;
}) {
  return {
    MessageBody: input.deliveryId,
    MessageDeduplicationId: input.deliveryId,
    MessageGroupId: `identity-email-${input.dispatchShard}`,
    QueueUrl: input.queueUrl,
  };
}
