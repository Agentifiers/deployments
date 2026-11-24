import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { createHash } from "node:crypto";

export interface MemoryIndexEvent {
  readonly detail?: {
    readonly environmentId?: string;
    readonly organizationId?: string;
    readonly payload?: {
      readonly idempotencyKey?: string;
      readonly memoryId?: string;
      readonly targetId?: string;
    };
    readonly projectId?: string;
    readonly workspaceId?: string;
  };
}

const sqs = new SQSClient({});

function required(value: string | undefined, label: string) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

export function memoryIndexMessageGroup(event: MemoryIndexEvent) {
  const organizationId = required(event.detail?.organizationId, "organizationId");
  const targetId = required(event.detail?.payload?.targetId, "targetId");
  const memoryId = required(event.detail?.payload?.memoryId, "memoryId");
  return createHash("sha256").update(`${organizationId}\0${targetId}\0${memoryId}`).digest("hex");
}

export async function handler(event: MemoryIndexEvent) {
  await sqs.send(
    new SendMessageCommand({
      MessageBody: JSON.stringify(event),
      MessageGroupId: memoryIndexMessageGroup(event),
      QueueUrl: required(process.env.DEPLOYMENTS_AI_MEMORY_INDEX_QUEUE_URL, "index queue URL"),
    }),
  );
}
