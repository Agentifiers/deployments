import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AgentEmailSendQueueMessage } from "@deployments-ai/agent-email";
import { Effect } from "effect";
import { decodePlatformRecord } from "../records/index.ts";

export interface AgentEmailDynamoStreamRecord {
  readonly dynamodb?: {
    readonly NewImage?: Record<string, AttributeValue>;
    readonly SequenceNumber?: string;
  };
  readonly eventID: string;
  readonly eventName?: string;
}

export interface AgentEmailDynamoStreamEvent {
  readonly Records: readonly AgentEmailDynamoStreamRecord[];
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Agent email send event is missing ${name}.`);
  }
  return value;
}

export async function agentEmailSendRequestFromStreamRecord(
  record: AgentEmailDynamoStreamRecord,
): Promise<AgentEmailSendQueueMessage | undefined> {
  if (record.eventName !== "INSERT" || !record.dynamodb?.NewImage) return undefined;

  const persisted = await Effect.runPromise(
    decodePlatformRecord(unmarshall(record.dynamodb.NewImage)),
  );
  if (
    persisted.itemType !== "semantic-event" ||
    persisted.data.eventType !== "agent-email.send-requested"
  ) {
    return undefined;
  }

  const payload = object(persisted.data.payload);
  return {
    environmentId: requiredString(persisted.data.environmentId, "environmentId"),
    inboxId: requiredString(payload?.inboxId, "payload.inboxId"),
    messageId: requiredString(payload?.messageId, "payload.messageId"),
    organizationId: requiredString(persisted.data.organizationId, "organizationId"),
    projectId: requiredString(persisted.data.projectId, "projectId"),
    type: "agent-email-send",
  };
}
