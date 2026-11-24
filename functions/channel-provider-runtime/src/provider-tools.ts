import { createHash } from "node:crypto";
import { providerOAuthMaterialFromCredentialValues } from "@deployments-ai/credential-vault";
import {
  executeProviderNativeHttpTool,
  ProviderNativeExecutionOutcomeUnknownError,
  providerNativeHttpToolDefinitions,
} from "@deployments-ai/tools";
import {
  AuditEventRecord,
  ProviderConnectionRecord,
  Ulid,
  key,
  withCanonicalRecordKeys,
  type Ulid as UlidValue,
  channelProviderDocumentPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";

import {
  credentialIdentityForReference,
  putFencedTenantRecord,
  runtimeCredentialVault,
  runtimeScopedDocumentClient,
  queueMessagePayload,
  vaultReference,
  type PartialBatchFailureResponse,
  type QueueEventLike,
} from "./runtime.ts";

const PROVIDER_TOOL_OUTCOME_UNKNOWN_ACTION = "provider.tool.outcome-unknown";
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface ProviderToolMessage {
  readonly connectionId?: string;
  readonly credentialPurpose?: "provider-api" | "provider-oauth-token";
  readonly environmentId: string;
  readonly externalAccountId: string;
  readonly idempotencyKey: string;
  readonly input: Record<string, unknown>;
  readonly organizationId: string;
  readonly provider: string;
  readonly projectId: string;
  readonly reference: unknown;
  readonly toolName: string;
}

interface ProviderToolUnknownOutcomeContext {
  readonly cause: ProviderNativeExecutionOutcomeUnknownError;
  readonly message: ProviderToolMessage;
  readonly messageId: string;
}

export interface ProviderToolRecordProcessorOptions {
  readonly executeMessage: (message: ProviderToolMessage) => Promise<unknown>;
  readonly isOutcomeQuarantined?: (message: ProviderToolMessage) => Promise<boolean>;
  readonly normalizeMessage?: (message: ProviderToolMessage) => Promise<ProviderToolMessage>;
  readonly quarantineOutcome?: (context: ProviderToolUnknownOutcomeContext) => Promise<void>;
}

function requiredMessageText(value: string | undefined, field: keyof ProviderToolMessage): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 2_048) {
    throw new Error(`Provider tool message ${field} is invalid.`);
  }
  return normalized;
}

function stableUlid(seed: string): UlidValue {
  const entropy = createHash("sha256").update(seed).digest().subarray(0, 10);
  let value = 0n;
  for (const byte of entropy) value = (value << 8n) | BigInt(byte);
  let encodedEntropy = "";
  for (let index = 0; index < 16; index += 1) {
    encodedEntropy = CROCKFORD_BASE32[Number(value & 31n)]! + encodedEntropy;
    value >>= 5n;
  }
  return Schema.decodeUnknownSync(Ulid)(`0000000000${encodedEntropy}`);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, child]) => [name, stableValue(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  const serialized = JSON.stringify(stableValue(value));
  if (serialized === undefined) throw new Error("Provider tool credential reference is invalid.");
  return serialized;
}

function credentialReferenceHash(message: ProviderToolMessage): string {
  return digest(stableJson(message.reference));
}

function providerToolInputHash(message: ProviderToolMessage): string {
  return digest(stableJson(message.input));
}

function providerCredentialPurpose(connection: typeof ProviderConnectionRecord.Type) {
  const method = connection.data.authMethod.trim().toLowerCase();
  return method === "oauth" || method === "oauth2"
    ? ("provider-oauth-token" as const)
    : ("provider-api" as const);
}

export function bindProviderToolMessageToConnection(
  message: ProviderToolMessage,
  connection: typeof ProviderConnectionRecord.Type,
): ProviderToolMessage {
  const connectionId = requiredMessageText(message.connectionId, "connectionId");
  if (
    connection.data.organizationId !==
      requiredMessageText(message.organizationId, "organizationId") ||
    connection.data.projectId !== requiredMessageText(message.projectId, "projectId") ||
    connection.data.environmentId !== requiredMessageText(message.environmentId, "environmentId") ||
    connection.data.id !== connectionId
  ) {
    throw new Error("Provider connection does not match the runtime request scope.");
  }
  if (connection.data.status !== "active" || !connection.data.credentialRef) {
    throw new Error("Provider connection is not active or complete.");
  }
  const credentialPurpose = providerCredentialPurpose(connection);
  const messageExternalAccountId = requiredMessageText(
    message.externalAccountId,
    "externalAccountId",
  );
  const externalAccountId =
    connection.data.externalAccountId ??
    (credentialPurpose === "provider-oauth-token" ? messageExternalAccountId : undefined);
  if (!externalAccountId) throw new Error("Provider connection is not active or complete.");
  if (
    requiredMessageText(message.provider, "provider") !== connection.data.providerKey ||
    messageExternalAccountId !== externalAccountId ||
    stableJson(message.reference) !== stableJson(connection.data.credentialRef) ||
    (message.credentialPurpose !== undefined && message.credentialPurpose !== credentialPurpose)
  ) {
    throw new Error("Provider tool message does not match the persisted provider connection.");
  }
  return {
    ...message,
    connectionId: connection.data.id,
    credentialPurpose,
    externalAccountId,
    provider: connection.data.providerKey,
    reference: connection.data.credentialRef,
  };
}

export function providerToolUnknownOutcomeAuditId(message: ProviderToolMessage) {
  return stableUlid(
    [
      "provider-tool-outcome-unknown",
      requiredMessageText(message.organizationId, "organizationId"),
      requiredMessageText(message.projectId, "projectId"),
      requiredMessageText(message.environmentId, "environmentId"),
      requiredMessageText(message.connectionId, "connectionId"),
      requiredMessageText(message.credentialPurpose, "credentialPurpose"),
      requiredMessageText(message.provider, "provider"),
      requiredMessageText(message.toolName, "toolName"),
      requiredMessageText(message.idempotencyKey, "idempotencyKey"),
      requiredMessageText(message.externalAccountId, "externalAccountId"),
      credentialReferenceHash(message),
      providerToolInputHash(message),
    ].join("\u0000"),
  );
}

function unknownOutcomeAuditKey(message: ProviderToolMessage) {
  const eventId = providerToolUnknownOutcomeAuditId(message);
  return {
    eventId,
    pk: key(
      "ORG",
      requiredMessageText(message.organizationId, "organizationId"),
      "ENV",
      requiredMessageText(message.environmentId, "environmentId"),
    ),
    sk: key("AUDIT-EVENT", eventId),
  };
}

function assertMatchingUnknownOutcomeAudit(value: unknown, message: ProviderToolMessage): void {
  const audit = Schema.decodeUnknownSync(AuditEventRecord)(value);
  const expected = unknownOutcomeAuditKey(message);
  const changes = audit.data.changes;
  if (
    audit.data.action !== PROVIDER_TOOL_OUTCOME_UNKNOWN_ACTION ||
    audit.data.eventId !== expected.eventId ||
    changes?.provider !== requiredMessageText(message.provider, "provider") ||
    changes?.toolName !== requiredMessageText(message.toolName, "toolName") ||
    changes?.idempotencyKeyHash !== digest(message.idempotencyKey) ||
    changes?.externalAccountIdHash !== digest(message.externalAccountId) ||
    changes?.credentialReferenceHash !== credentialReferenceHash(message) ||
    changes?.inputHash !== providerToolInputHash(message)
  ) {
    throw new Error("Provider tool unknown-outcome quarantine record does not match the request.");
  }
}

function conditionalCheckFailed(cause: unknown): boolean {
  return Boolean(
    cause &&
    typeof cause === "object" &&
    "name" in cause &&
    (cause.name === "ConditionalCheckFailedException" ||
      cause.name === "TransactionCanceledException"),
  );
}

async function loadUnknownOutcomeAudit(message: ProviderToolMessage): Promise<boolean> {
  const scope = {
    environmentId: requiredMessageText(message.environmentId, "environmentId"),
    organizationId: requiredMessageText(message.organizationId, "organizationId"),
    projectId: requiredMessageText(message.projectId, "projectId"),
  };
  const client = await runtimeScopedDocumentClient(scope);
  const auditKey = unknownOutcomeAuditKey(message);
  const response = await channelProviderDocumentPersistence.read(client, {
    ConsistentRead: true,
    Key: { pk: auditKey.pk, sk: auditKey.sk },
    TableName: process.env.DEPLOYMENTS_AI_EVENTS_TABLE ?? "events",
  });
  if (!response.Item) return false;
  assertMatchingUnknownOutcomeAudit(response.Item, message);
  return true;
}

async function quarantineUnknownOutcome(context: ProviderToolUnknownOutcomeContext): Promise<void> {
  const { message, messageId } = context;
  const scope = {
    environmentId: requiredMessageText(message.environmentId, "environmentId"),
    organizationId: requiredMessageText(message.organizationId, "organizationId"),
    projectId: requiredMessageText(message.projectId, "projectId"),
  };
  const occurredAt = new Date().toISOString();
  const auditKey = unknownOutcomeAuditKey(message);
  const audit = Schema.decodeUnknownSync(AuditEventRecord)(
    withCanonicalRecordKeys({
      itemType: "audit-event" as const,
      data: {
        action: PROVIDER_TOOL_OUTCOME_UNKNOWN_ACTION,
        actor: { type: "worker" as const },
        changes: {
          automaticRetrySuppressed: true,
          credentialReferenceHash: credentialReferenceHash(message),
          errorType: context.cause.name,
          externalAccountIdHash: digest(message.externalAccountId),
          idempotencyKeyHash: digest(message.idempotencyKey),
          inputHash: providerToolInputHash(message),
          messageId,
          provider: requiredMessageText(message.provider, "provider"),
          toolName: requiredMessageText(message.toolName, "toolName"),
        },
        environmentId: scope.environmentId,
        eventId: auditKey.eventId,
        occurredAt,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        resourceType: "provider-tool-execution",
      },
    }),
  );
  const client = await runtimeScopedDocumentClient(scope);
  try {
    await putFencedTenantRecord(
      client,
      scope,
      audit,
      process.env.DEPLOYMENTS_AI_EVENTS_TABLE ?? "events",
    );
  } catch (cause) {
    if (!conditionalCheckFailed(cause) || !(await loadUnknownOutcomeAudit(message))) {
      throw cause;
    }
  }
}

async function execute(message: ProviderToolMessage) {
  const definition = providerNativeHttpToolDefinitions.find(
    (item) => item.toolName === message.toolName,
  );
  if (
    !definition ||
    !(definition.acceptedProviders ?? [definition.provider]).includes(message.provider)
  ) {
    throw new Error("Provider tool is not registered for this provider.");
  }
  const connectionId = requiredMessageText(message.connectionId, "connectionId");
  const credentialPurpose = requiredMessageText(message.credentialPurpose, "credentialPurpose");
  if (credentialPurpose !== "provider-api" && credentialPurpose !== "provider-oauth-token") {
    throw new Error("Provider tool message credentialPurpose is invalid.");
  }
  const secret = await (
    await runtimeCredentialVault({
      environmentId: message.environmentId,
      organizationId: message.organizationId,
      projectId: message.projectId,
    })
  ).read({
    environmentId: message.environmentId as never,
    expectedIdentity: {
      ownerId: connectionId as never,
      ownerType: "provider-connection",
      projectId: message.projectId as never,
      purpose: credentialPurpose,
    },
    organizationId: message.organizationId as never,
    reference: vaultReference(message.reference),
  });
  const credential = providerOAuthMaterialFromCredentialValues(secret.values);
  return executeProviderNativeHttpTool({
    credential: {
      externalAccountId: message.externalAccountId,
      fields: credential.fields,
      provider: message.provider,
      ...(credential.requestHeaders ? { requestHeaders: credential.requestHeaders } : {}),
      ...(credential.resource ? { resourceDefaults: { oauthResource: credential.resource } } : {}),
    },
    definition,
    input: message.input,
    request: {
      idempotencyKey: message.idempotencyKey,
      toolName: message.toolName,
    },
  });
}

async function normalizeProviderToolMessage(
  message: ProviderToolMessage,
): Promise<ProviderToolMessage> {
  const scope = {
    environmentId: requiredMessageText(message.environmentId, "environmentId"),
    organizationId: requiredMessageText(message.organizationId, "organizationId"),
    projectId: requiredMessageText(message.projectId, "projectId"),
  };
  let connectionId = message.connectionId?.trim();
  if (!connectionId) {
    const identity = await credentialIdentityForReference(
      scope,
      message.reference,
      "provider-connection",
      ["provider-api", "provider-oauth-token"],
    );
    connectionId = identity.ownerId;
  }
  const client = await runtimeScopedDocumentClient(scope);
  const response = await channelProviderDocumentPersistence.read(client, {
    ConsistentRead: true,
    Key: {
      pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
      sk: key("PROVIDER-CONNECTION", connectionId),
    },
    TableName: process.env.DEPLOYMENTS_AI_CONTROL_TABLE ?? "control",
  });
  if (!response.Item) throw new Error("Provider connection was not found.");
  const connection = Schema.decodeUnknownSync(ProviderConnectionRecord)(response.Item);
  return bindProviderToolMessageToConnection({ ...message, connectionId }, connection);
}

export async function processProviderToolRecords(
  event: QueueEventLike,
  options: ProviderToolRecordProcessorOptions,
): Promise<PartialBatchFailureResponse> {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    let message: ProviderToolMessage | undefined;
    try {
      message = queueMessagePayload(record.body) as ProviderToolMessage;
      message = (await options.normalizeMessage?.(message)) ?? message;
      if (await options.isOutcomeQuarantined?.(message)) continue;
      await options.executeMessage(message);
    } catch (cause) {
      const ambiguousMutation = cause instanceof ProviderNativeExecutionOutcomeUnknownError;
      let quarantined = false;
      if (ambiguousMutation && options.quarantineOutcome) {
        try {
          if (!message) throw new Error("Provider tool message was not parsed.");
          await options.quarantineOutcome({ cause, message, messageId: record.messageId });
          quarantined = true;
        } catch (quarantineCause) {
          console.error("Provider tool unknown outcome could not be quarantined.", {
            errorType: quarantineCause instanceof Error ? quarantineCause.name : "UnknownError",
            messageId: record.messageId,
          });
        }
      }
      console.error("Provider tool execution failed.", {
        automaticRetrySuppressed: ambiguousMutation && quarantined,
        errorType: cause instanceof Error ? cause.name : "UnknownError",
        messageId: record.messageId,
      });
      if (!ambiguousMutation || !quarantined) failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}

export async function handleProviderTools(
  event: QueueEventLike,
): Promise<PartialBatchFailureResponse> {
  return processProviderToolRecords(event, {
    executeMessage: execute,
    isOutcomeQuarantined: loadUnknownOutcomeAudit,
    normalizeMessage: normalizeProviderToolMessage,
    quarantineOutcome: quarantineUnknownOutcome,
  });
}

export const handler = handleProviderTools;
