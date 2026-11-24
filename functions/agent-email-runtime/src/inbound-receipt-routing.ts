import { type AgentEmailInboxRecord } from "@deployments-ai/agent-email";
import {
  AgentEmailRejectedReceiptError,
  deterministicAgentEmailUlid,
  type AgentEmailInboundReservation,
} from "@deployments-ai/agent-email/aws";
import {
  Ulid,
  type DynamoDatabaseService,
  type InboxThreadForThreadKey,
  type PlatformRecord,
  type TableName,
  type Ulid as UlidValue,
  agentEmailPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import type { StoredInboundMessageSource } from "./inbound-consumer.ts";

const DEFAULT_RAW_RETENTION_DAYS = 30;
const STABLE_THREAD_EPOCH = "1970-01-01T00:00:00.000Z";

interface AgentEmailInboundQueueRecord {
  readonly body: string;
  readonly messageId: string;
}

export interface AgentEmailInboundMainDependencies {
  readonly processReceipt: (record: AgentEmailInboundQueueRecord) => Promise<unknown>;
  readonly processReprocess: (value: unknown) => Promise<unknown>;
  readonly processWorkflow: (value: unknown) => Promise<unknown>;
}

export async function discardRejectedAgentEmailReceipt(
  error: AgentEmailRejectedReceiptError,
  input: {
    readonly deleteRaw: (key: string, versionId?: string) => Promise<void>;
    readonly loadRaw: (key: string) => Promise<{ readonly versionId?: string } | undefined>;
    readonly rawPrefix: string;
  },
) {
  if (!error.objectKey.startsWith(input.rawPrefix)) {
    throw new Error("Rejected SES receipt object key is outside the configured raw prefix.");
  }
  const raw = await input.loadRaw(error.objectKey);
  if (raw) await input.deleteRaw(error.objectKey, raw.versionId);
  return { disposition: "rejected" as const };
}

export function agentEmailInboundReceiptCompletionKey(
  rawPrefix: string,
  receipt: {
    readonly messageId: string;
    readonly objectKey: string;
    readonly receivedAt: string;
  },
) {
  const identity = createHash("sha256")
    .update(JSON.stringify([receipt.messageId, receipt.objectKey, receipt.receivedAt]))
    .digest("hex");
  return `${rawPrefix}completed/${identity}`;
}

export async function loadAgentEmailInboundReceiptSource(
  input: {
    readonly completionKey: string;
    readonly objectKey: string;
  },
  dependencies: {
    readonly deleteRaw: (key: string, versionId?: string) => Promise<void>;
    readonly head: (key: string) => Promise<{ readonly versionId?: string } | undefined>;
    readonly load: (
      key: string,
      versionId?: string,
    ) => Promise<{
      readonly etag?: string;
      readonly raw: Uint8Array;
      readonly versionId?: string;
    }>;
  },
) {
  const completed = await dependencies.head(input.completionKey);
  const source = await dependencies.head(input.objectKey);
  if (completed) {
    if (source) await dependencies.deleteRaw(input.objectKey, source.versionId);
    return undefined;
  }
  if (!source) {
    if (await dependencies.head(input.completionKey)) return undefined;
    throw new Error("SES receipt source is missing without a durable completion marker.");
  }
  try {
    return await dependencies.load(input.objectKey, source.versionId);
  } catch (cause) {
    if (await dependencies.head(input.completionKey)) return undefined;
    throw cause;
  }
}

export function required(name: string, env: NodeJS.ProcessEnv) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function ulid(value: string): UlidValue {
  return Schema.decodeUnknownSync(Ulid)(value);
}

export function commandEnvelope(body: string) {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const type = (parsed as Readonly<Record<string, unknown>>).type;
    return type === "agent-email.inbound-workflow" || type === "agent-email.reprocess"
      ? { type, value: parsed }
      : undefined;
  } catch {
    return undefined;
  }
}

export function reprocessCommand(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent email reprocess command must be an object.");
  }
  const input = value as Readonly<Record<string, unknown>>;
  if (input.type !== "agent-email.reprocess" || input.version !== 1) {
    throw new Error("Agent email reprocess command version is unsupported.");
  }
  const required = (
    name:
      | "environmentId"
      | "inboxId"
      | "messageId"
      | "organizationId"
      | "projectId"
      | "reprocessId",
  ) => {
    const candidate = input[name];
    if (
      typeof candidate !== "string" ||
      !candidate.trim() ||
      Buffer.byteLength(candidate.trim(), "utf8") > 512
    ) {
      throw new Error(`Agent email reprocess command ${name} is invalid.`);
    }
    return candidate.trim();
  };
  return {
    environmentId: ulid(required("environmentId")),
    inboxId: ulid(required("inboxId")),
    messageId: ulid(required("messageId")),
    organizationId: ulid(required("organizationId")),
    projectId: ulid(required("projectId")),
    reprocessId: required("reprocessId"),
  };
}

export function deterministicInboundReservation(
  receipt: {
    readonly providerMessageId: string;
    readonly providerRegion: string;
    readonly receivedAt: string;
  },
  input: {
    readonly attachmentCount: number;
    readonly inboxId: string;
    readonly threadKey: string;
  },
): AgentEmailInboundReservation {
  const identity = [receipt.providerRegion, receipt.providerMessageId, input.inboxId] as const;
  const messageId = deterministicAgentEmailUlid(receipt.receivedAt, ...identity, "message");
  const attachmentIds = Array.from({ length: input.attachmentCount }, (_, index) =>
    deterministicAgentEmailUlid(receipt.receivedAt, ...identity, "attachment", String(index)),
  );
  return {
    attachmentIds,
    eventId: deterministicAgentEmailUlid(receipt.receivedAt, ...identity, "received-event"),
    messageId,
    threadId: deterministicAgentEmailUlid(
      STABLE_THREAD_EPOCH,
      "thread-v1",
      input.inboxId,
      input.threadKey,
    ),
    usageIds: {
      ...(input.attachmentCount > 0
        ? {
            attachmentBytes: deterministicAgentEmailUlid(
              receipt.receivedAt,
              ...identity,
              "usage-attachment-bytes",
            ),
          }
        : {}),
      inboundMessage: deterministicAgentEmailUlid(
        receipt.receivedAt,
        ...identity,
        "usage-inbound-message",
      ),
      storedBytes: deterministicAgentEmailUlid(
        receipt.receivedAt,
        ...identity,
        "usage-stored-bytes",
      ),
    },
  };
}

export async function resolveInboundThreadReservation(
  receipt: {
    readonly providerMessageId: string;
    readonly providerRegion: string;
    readonly receivedAt: string;
  },
  input: {
    readonly attachmentCount: number;
    readonly inboxId: string;
    readonly organizationId: string;
    readonly threadKey: string;
  },
  loadThread: (
    organizationId: string,
    inboxId: string,
    threadKey: string,
  ) => Promise<InboxThreadForThreadKey>,
) {
  const reservation = deterministicInboundReservation(receipt, input);
  const thread = await loadThread(input.organizationId, input.inboxId, input.threadKey);
  return thread.kind === "absent"
    ? reservation
    : { ...reservation, threadId: thread.inboxThreadId };
}

export async function databaseRecord(
  database: DynamoDatabaseService,
  table: TableName,
  recordKey: { readonly pk: string; readonly sk: string },
) {
  return agentEmailPersistence.read(database, table, recordKey, true);
}

export async function agentEmailWorkflowMessageSource(
  database: DynamoDatabaseService,
  message: {
    readonly inboxId: UlidValue;
    readonly messageId: UlidValue;
    readonly organizationId: UlidValue;
  },
): Promise<StoredInboundMessageSource> {
  const stored = await databaseRecord(database, "execution", {
    pk: `ORG#${message.organizationId}#INBOX#${message.inboxId}`,
    sk: `INBOX-MESSAGE#${message.messageId}`,
  });
  if (stored?.itemType !== "inbox-message") return { kind: "erased" };
  if (!stored.data.threadId) {
    throw new Error("Agent email inbound message is not assigned to an inbox thread.");
  }
  return {
    kind: "found",
    source: {
      inboxId: stored.data.inboxId,
      inboxMessageCreatedAt: stored.data.createdAt,
      inboxMessageId: stored.data.id,
      inboxThreadId: stored.data.threadId,
      kind: "agent-email",
    },
  };
}

export async function messageAttachmentRecords(
  database: DynamoDatabaseService,
  command: {
    readonly environmentId: UlidValue;
    readonly inboxId: UlidValue;
    readonly messageId: UlidValue;
    readonly organizationId: UlidValue;
    readonly projectId: UlidValue;
  },
) {
  const attachments: Extract<PlatformRecord, { readonly itemType: "inbox-attachment" }>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await agentEmailPersistence.find(database, "execution", {
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": `ORG#${command.organizationId}#INBOX-MESSAGE#${command.messageId}`,
        ":sk": "INBOX-ATTACHMENT#",
      },
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
    });
    attachments.push(
      ...page.items.filter(
        (record): record is Extract<PlatformRecord, { readonly itemType: "inbox-attachment" }> =>
          record.itemType === "inbox-attachment" &&
          record.data.organizationId === command.organizationId &&
          record.data.projectId === command.projectId &&
          record.data.environmentId === command.environmentId &&
          record.data.inboxMessageId === command.messageId,
      ),
    );
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return attachments;
}

export async function environmentPolicies(
  database: DynamoDatabaseService,
  scope: {
    readonly environmentId: UlidValue;
    readonly organizationId: UlidValue;
    readonly projectId: UlidValue;
  },
) {
  const policies: Extract<PlatformRecord, { readonly itemType: "inbox-policy" }>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await agentEmailPersistence.find(database, "control", {
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
      ExpressionAttributeValues: {
        ":pk": `ENV#${scope.environmentId}`,
        ":sk": "INBOX-POLICY#",
      },
      IndexName: "gsi2",
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
    });
    policies.push(
      ...page.items.filter(
        (record): record is Extract<PlatformRecord, { readonly itemType: "inbox-policy" }> =>
          record.itemType === "inbox-policy" &&
          record.data.organizationId === scope.organizationId &&
          record.data.projectId === scope.projectId &&
          record.data.environmentId === scope.environmentId,
      ),
    );
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return policies;
}

export function resolveAgentEmailRawRetentionDays(
  policies: readonly Extract<PlatformRecord, { readonly itemType: "inbox-policy" }>[],
  inboxId: UlidValue,
) {
  const inboxPolicies = policies.filter((policy) => policy.data.inboxId === inboxId);
  const environmentPolicies = policies.filter((policy) => policy.data.inboxId === undefined);
  const candidates = inboxPolicies.length > 0 ? inboxPolicies : environmentPolicies;
  if (candidates.length === 0) return DEFAULT_RAW_RETENTION_DAYS;
  if (candidates.length > 1) {
    throw new Error(
      `Agent email inbox ${inboxId} must resolve exactly one inbound retention policy.`,
    );
  }
  const days = candidates[0]!.data.rawRetentionDays;
  if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new Error(`Agent email inbox ${inboxId} has an invalid raw retention policy.`);
  }
  return days;
}

export function inboxModel(
  record: Extract<PlatformRecord, { readonly itemType: "inbox" }>,
): AgentEmailInboxRecord {
  return {
    address: record.data.address,
    ...(record.data.clientId ? { clientId: record.data.clientId } : {}),
    createdAt: record.data.createdAt,
    domainId: record.data.domainId,
    id: record.data.id,
    localPart: record.data.localPart,
    metadata: record.data.metadata,
    ...(record.data.name ? { name: record.data.name } : {}),
    organizationId: record.data.organizationId,
    status: record.data.status,
    updatedAt: record.data.updatedAt,
  };
}

export function agentEmailInboundRouteIsActive(
  inbox: PlatformRecord | undefined,
  environment: PlatformRecord | undefined,
  domain: PlatformRecord | undefined,
) {
  return (
    inbox?.itemType === "inbox" &&
    inbox.data.status === "active" &&
    environment?.itemType === "environment" &&
    environment.data.id === inbox.data.environmentId &&
    environment.data.organizationId === inbox.data.organizationId &&
    environment.data.projectId === inbox.data.projectId &&
    environment.data.status === "active" &&
    domain?.itemType === "inbox-domain" &&
    domain.data.id === inbox.data.domainId &&
    domain.data.environmentId === inbox.data.environmentId &&
    domain.data.organizationId === inbox.data.organizationId &&
    domain.data.projectId === inbox.data.projectId &&
    domain.data.status === "verified"
  );
}
