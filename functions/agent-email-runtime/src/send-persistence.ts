import {
  type AgentEmailAttachmentRecord,
  type AgentEmailMessageRecord,
  type AgentEmailSendQueueMessage,
} from "@deployments-ai/agent-email";
import {
  Keys,
  type DynamoDatabaseService,
  type PlatformRecord,
  agentEmailPersistence,
} from "@deployments-ai/db";
import { createHash } from "node:crypto";
import { definedFields } from "./record-fields.ts";

export function messageModel(
  record: Extract<PlatformRecord, { readonly itemType: "inbox-message" }>,
  attachments: readonly AgentEmailAttachmentRecord[],
  bodies: { readonly htmlBody?: string; readonly textBody?: string },
): AgentEmailMessageRecord {
  return { ...definedFields(record.data), ...bodies, attachments };
}

export async function getRecord(
  database: DynamoDatabaseService,
  table: "control" | "execution",
  key: { readonly pk: string; readonly sk: string },
) {
  return agentEmailPersistence.read(database, table, key, true);
}

export async function queryAll(
  database: DynamoDatabaseService,
  table: "control" | "execution",
  input: {
    readonly ExpressionAttributeNames: Readonly<Record<string, string>>;
    readonly ExpressionAttributeValues: Readonly<Record<string, unknown>>;
    readonly IndexName?: string;
    readonly KeyConditionExpression: string;
  },
) {
  const records: PlatformRecord[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await agentEmailPersistence.find(database, table, {
      ...input,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    });
    records.push(...page.items);
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return records;
}

export function inScope(record: PlatformRecord, command: AgentEmailSendQueueMessage) {
  const data = record.data as Readonly<Record<string, unknown>>;
  if (record.itemType === "environment") {
    return (
      data.organizationId === command.organizationId &&
      data.projectId === command.projectId &&
      data.id === command.environmentId
    );
  }
  return (
    data.organizationId === command.organizationId &&
    data.projectId === command.projectId &&
    data.environmentId === command.environmentId
  );
}

export function suppressionClaimChecks(
  message: AgentEmailMessageRecord,
  command: AgentEmailSendQueueMessage,
) {
  const namespace = `organization:${command.organizationId}:project:${command.projectId}:environment:${command.environmentId}:inbox-suppression`;
  return [
    ...new Set(
      [...message.toAddresses, ...message.ccAddresses, ...message.bccAddresses].map((address) =>
        address.trim().toLowerCase(),
      ),
    ),
  ].map((address) => ({
    conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    key: Keys.control.uniqueClaim(namespace, createHash("sha256").update(address).digest("hex")),
    kind: "condition-check" as const,
    table: "control" as const,
  }));
}

export function policyConditionCheck(
  policy: Extract<PlatformRecord, { readonly itemType: "inbox-policy" }>,
) {
  return {
    conditionExpression: "#data.#version = :version AND #data.#sendingStatus = :active",
    expressionAttributeNames: {
      "#data": "data",
      "#sendingStatus": "sendingStatus",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":active": "active",
      ":version": policy.data.version,
    },
    key: { pk: policy.pk, sk: policy.sk },
    kind: "condition-check" as const,
    table: "control" as const,
  };
}

export function policyVersionConditionCheck(
  policy: Extract<PlatformRecord, { readonly itemType: "inbox-policy" }>,
) {
  return {
    conditionExpression: "#data.#version = :version",
    expressionAttributeNames: {
      "#data": "data",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":version": policy.data.version,
    },
    key: { pk: policy.pk, sk: policy.sk },
    kind: "condition-check" as const,
    table: "control" as const,
  };
}

export function agentEmailSendPrerequisiteConditionCheck(
  record: {
    readonly data: { readonly version: number };
    readonly pk: string;
    readonly sk: string;
  },
  requiredStatus: "active" | "verified",
) {
  return {
    conditionExpression: "#data.#version = :version AND #data.#status = :status",
    expressionAttributeNames: {
      "#data": "data",
      "#status": "status",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":status": requiredStatus,
      ":version": record.data.version,
    },
    key: { pk: record.pk, sk: record.sk },
    kind: "condition-check" as const,
    table: "control" as const,
  };
}

export function recipientInboxConditionCheck(
  recipient: {
    readonly data: { readonly version: number };
    readonly pk: string;
    readonly sk: string;
  },
  sender: { readonly pk: string; readonly sk: string },
) {
  if (recipient.pk === sender.pk && recipient.sk === sender.sk) return undefined;
  return agentEmailSendPrerequisiteConditionCheck(recipient, "active");
}

export function verificationConditionCheck(
  verification: Extract<PlatformRecord, { readonly itemType: "inbox-recipient-verification" }>,
) {
  return {
    conditionExpression: "#data.#version = :version AND #data.#status = :verified",
    expressionAttributeNames: {
      "#data": "data",
      "#status": "status",
      "#version": "version",
    },
    expressionAttributeValues: {
      ":verified": "verified",
      ":version": verification.data.version,
    },
    key: { pk: verification.pk, sk: verification.sk },
    kind: "condition-check" as const,
    table: "control" as const,
  };
}
