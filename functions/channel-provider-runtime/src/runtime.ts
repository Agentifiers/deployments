import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { STSClient } from "@aws-sdk/client-sts";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  CredentialVaultError,
  makeTenantRoleSessions,
  type CredentialVaultReference,
  type CredentialVaultSecretDocument,
  type CredentialVaultService,
  type TenantRoleCredentials,
  type TenantRoleSessions,
} from "@deployments-ai/credential-vault";
import {
  AuditEventRecord,
  CredentialVaultEntryRecord,
  key,
  makeCredentialVault,
  makeIdGenerator,
  governanceInventoryLayout,
  governanceTenantDirectoryPutItem,
  organizationWriteFenceCondition,
  type PlatformRecord,
  withCanonicalRecordKeys,
  channelProviderDocumentPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";

const CONTROL_TABLE_ENV = "DEPLOYMENTS_AI_CONTROL_TABLE";
const CREDENTIAL_KMS_KEY_ARN_ENV = "DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN";
const CREDENTIAL_VAULT_READER_ROLE_ARN_ENV = "DEPLOYMENTS_AI_CREDENTIAL_VAULT_READER_ROLE_ARN";
const CREDENTIAL_VAULT_WRITER_ROLE_ARN_ENV = "DEPLOYMENTS_AI_CREDENTIAL_VAULT_WRITER_ROLE_ARN";

export interface CredentialVaultScope {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

export type CredentialVaultAccess = "reader" | "writer";

interface ScopedVaultSession {
  readonly documentClient: DynamoDBDocumentClient;
  readonly vault: CredentialVaultService;
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

let stsClient: STSClient | undefined;
const vaultSessions: Partial<
  Record<CredentialVaultAccess, TenantRoleSessions<ScopedVaultSession>>
> = {};
const auditIds = makeIdGenerator();

function openVaultSession(credentials: TenantRoleCredentials): ScopedVaultSession {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({ credentials }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return {
    documentClient,
    vault: makeCredentialVault({
      documentClient,
      kmsClient: new KMSClient({ credentials }),
      kmsKeyArn: requiredEnv(CREDENTIAL_KMS_KEY_ARN_ENV),
      tableName: requiredEnv(CONTROL_TABLE_ENV),
    }),
  };
}

function scopedSession(scope: CredentialVaultScope, access: CredentialVaultAccess) {
  const sessions = (vaultSessions[access] ??= makeTenantRoleSessions({
    open: openVaultSession,
    roleArn: requiredEnv(
      access === "writer"
        ? CREDENTIAL_VAULT_WRITER_ROLE_ARN_ENV
        : CREDENTIAL_VAULT_READER_ROLE_ARN_ENV,
    ),
    sessionName: `credential-vault-${access}`,
    sts: (stsClient ??= new STSClient({})),
    tags: [{ Key: "accessMode", Value: access }],
  }));
  return sessions(scope);
}

export async function runtimeScopedDocumentClient(
  scope: CredentialVaultScope,
  access: CredentialVaultAccess = "reader",
) {
  return (await scopedSession(scope, access)).documentClient;
}

export function assertCredentialDocumentCurrent(
  document: CredentialVaultSecretDocument,
  now = Date.now(),
) {
  if (document.expiresAt === undefined) return;
  const expiresAt = Date.parse(document.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new CredentialVaultError("revoked", "Credential has expired.");
  }
}

export async function putFencedTenantRecord(
  documentClient: DynamoDBDocumentClient,
  scope: CredentialVaultScope,
  item: PlatformRecord,
  tableName: string,
) {
  const fenceCondition = organizationWriteFenceCondition();
  const controlTable = process.env[CONTROL_TABLE_ENV] ?? "control";
  const directoryPut = governanceTenantDirectoryPutItem(
    item,
    controlTable,
    await governanceInventoryLayout(documentClient, controlTable),
  );
  if (!directoryPut) throw new Error("Tenant write is missing its governance inventory scope.");
  await channelProviderDocumentPersistence.commit(documentClient, {
    TransactItems: [
      {
        ConditionCheck: {
          ConditionExpression: fenceCondition.conditionExpression,
          ExpressionAttributeNames: fenceCondition.expressionAttributeNames,
          ExpressionAttributeValues: fenceCondition.expressionAttributeValues,
          Key: {
            pk: key("ORG", scope.organizationId),
            sk: key("ERASURE-FENCE", scope.organizationId),
          },
          TableName: controlTable,
        },
      },
      {
        ConditionCheck: {
          ConditionExpression: "attribute_exists(pk)",
          Key: {
            pk: key("ORG", scope.organizationId),
            sk: key("ORG", scope.organizationId),
          },
          TableName: controlTable,
        },
      },
      {
        Put: {
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          Item: item,
          TableName: tableName,
        },
      },
      directoryPut,
    ],
  });
}

export async function runtimeCredentialVault(
  scope: CredentialVaultScope,
  access: CredentialVaultAccess = "reader",
) {
  const session = await scopedSession(scope, access);
  const base = session.vault;
  return {
    ...base,
    async read(request: Parameters<CredentialVaultService["read"]>[0]) {
      const document = await base.read(request);
      if (access === "reader") assertCredentialDocumentCurrent(document);
      const occurredAt = new Date().toISOString();
      const audit = Schema.decodeUnknownSync(AuditEventRecord)(
        withCanonicalRecordKeys({
          itemType: "audit-event" as const,
          data: {
            action: "credential.read",
            actor: { type: "worker" as const },
            environmentId: scope.environmentId,
            eventId: auditIds.generate(),
            occurredAt,
            organizationId: scope.organizationId,
            projectId: scope.projectId,
            resourceId: request.reference.credentialId,
            resourceType: "credential-vault-entry",
          },
        }),
      );
      await putFencedTenantRecord(
        session.documentClient,
        scope,
        audit,
        process.env.DEPLOYMENTS_AI_EVENTS_TABLE ?? "events",
      );
      return document;
    },
  } satisfies CredentialVaultService;
}

export function vaultReference(value: unknown): CredentialVaultReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Credential vault reference is required.");
  }
  const reference = value as Partial<CredentialVaultReference>;
  if (
    reference.store !== "dynamodb-kms" ||
    typeof reference.credentialId !== "string" ||
    !Number.isSafeInteger(reference.generation) ||
    Number(reference.generation) < 0
  ) {
    throw new Error("Credential vault reference is invalid.");
  }
  return reference as CredentialVaultReference;
}

export async function credentialIdentityForReference(
  scope: CredentialVaultScope,
  value: unknown,
  expectedOwnerType: "channel-binding" | "provider-connection",
  expectedPurposes: readonly string[],
) {
  const reference = vaultReference(value);
  const client = await runtimeScopedDocumentClient(scope);
  const response = await channelProviderDocumentPersistence.read(client, {
    ConsistentRead: true,
    Key: {
      pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
      sk: key("CREDENTIAL-VAULT-ENTRY", reference.credentialId),
    },
    TableName: requiredEnv(CONTROL_TABLE_ENV),
  });
  const entry = Schema.decodeUnknownSync(CredentialVaultEntryRecord)(response.Item);
  if (
    entry.data.organizationId !== scope.organizationId ||
    entry.data.environmentId !== scope.environmentId ||
    entry.data.projectId !== scope.projectId ||
    entry.data.generation !== reference.generation ||
    entry.data.status !== "active" ||
    entry.data.ownerType !== expectedOwnerType ||
    !expectedPurposes.includes(entry.data.purpose)
  ) {
    throw new Error("Credential vault reference identity does not match the runtime request.");
  }
  return {
    ownerId: entry.data.ownerId,
    purpose: entry.data.purpose,
    reference,
  };
}

export function stringField(values: Readonly<Record<string, string>>, ...names: string[]) {
  for (const name of names) {
    const value = values[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Credential is missing ${names[0]}.`);
}

interface QueueRecordLike {
  readonly attributes?: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  readonly messageId: string;
}

export interface QueueEventLike {
  readonly Records: readonly QueueRecordLike[];
}

export interface PartialBatchFailureResponse {
  readonly batchItemFailures: readonly { readonly itemIdentifier: string }[];
}

export function queueMessagePayload(body: string) {
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const root = parsed as Record<string, unknown>;
  const detail = root.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return parsed;
  const detailRecord = detail as Record<string, unknown>;
  const payload = detailRecord.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload ?? detail;
  return {
    ...(payload as Record<string, unknown>),
    ...(typeof detailRecord.environmentId === "string"
      ? { environmentId: detailRecord.environmentId }
      : {}),
    ...(typeof detailRecord.organizationId === "string"
      ? { organizationId: detailRecord.organizationId }
      : {}),
    ...(typeof detailRecord.projectId === "string" ? { projectId: detailRecord.projectId } : {}),
  };
}
