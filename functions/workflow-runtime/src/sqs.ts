import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { WorkflowQueueCommand } from "./types.ts";

export interface WorkflowQueueSender {
  readonly send: (command: SendMessageCommand) => Promise<unknown>;
}

export function workflowQueueMessageGroupId(command: WorkflowQueueCommand) {
  return `${command.organizationId}:${command.projectId}:${command.environmentId}:${command.executionId}`;
}

export function createSqsWorkflowQueueEnqueue(options: {
  readonly client?: WorkflowQueueSender;
  readonly queueUrl: string;
}) {
  const client = options.client ?? new SQSClient({});
  return async (command: WorkflowQueueCommand, deduplicationId: string) => {
    await client.send(
      new SendMessageCommand({
        MessageBody: JSON.stringify(command),
        MessageDeduplicationId: deduplicationId,
        MessageGroupId: workflowQueueMessageGroupId(command),
        QueueUrl: options.queueUrl,
      }),
    );
  };
}
