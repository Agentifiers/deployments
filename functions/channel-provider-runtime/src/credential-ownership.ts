import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  AuditEventRecord,
  ProviderConnectionRecord,
  UNIQUE_CLAIM_CONDITION,
  decodePlatformRecord,
  key,
  makeUniqueClaimRecord,
  makeDynamoDatabase,
  makeIdGenerator,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type OrganizationAuditActor,
  type PlatformRecord,
  type Ulid,
  channelProviderDocumentPersistence,
} from "@deployments-ai/db";
import type {
  CredentialVaultPreparedMutation,
  CredentialVaultReference,
} from "@deployments-ai/credential-vault";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "@deployments-ai/events";
import { Effect, Schema } from "effect";

import { runtimeScopedDocumentClient, type CredentialVaultScope } from "./runtime.ts";

export type CredentialOwnerType =
  | "channel-binding"
  | "mcp-server"
  | "provider-application"
  | "provider-connection"
  | "webhook-endpoint";
export type CredentialMutationAction = "created" | "revoked" | "rotated";

export interface CredentialOwnershipMutation {
  readonly action: CredentialMutationAction;
  /** Who the audit names; the provider runtime's service account unless a person is named. */
  readonly actor?: OrganizationAuditActor;
  readonly ownerId: string;
  readonly ownerType: CredentialOwnerType;
  readonly prepared: CredentialVaultPreparedMutation;
  readonly providerConnectionUpdate?: {
    readonly authorizationScopes?: readonly string[];
    readonly externalAccountId?: string;
    readonly externalAccountName?: string;
    readonly lastVerifiedAt?: string;
    readonly oauthResource?: string;
    readonly refreshAfter?: string;
    readonly scopes: readonly string[];
    readonly status?: "active" | "reauthorization-required";
  };
  readonly scope: CredentialVaultScope;
}

const ids = makeIdGenerator();

async function id() {
  return ids.generate();
}

function eventType(ownerType: CredentialOwnerType, action: CredentialMutationAction) {
  if (ownerType === "channel-binding") return "channel.binding.updated";
  if (ownerType === "provider-connection") {
    return action === "revoked"
      ? "provider.connection.disconnected"
      : action === "created"
        ? "provider.connection.authorized"
        : "provider.connection.refreshed";
  }
  if (ownerType === "webhook-endpoint") return "webhook.endpoint.updated";
  if (ownerType === "mcp-server") return `mcp-server.credentials.${action}`;
  return `provider.application.credentials.${action}`;
}

function ownerSortKey(ownerType: CredentialOwnerType, ownerId: string) {
  return key(ownerType.toUpperCase(), ownerId);
}

export function updatedOwner(
  owner: PlatformRecord,
  mutation: CredentialOwnershipMutation,
  now: string,
): PlatformRecord {
  if (owner.itemType !== mutation.ownerType)
    throw new Error("Credential owner type does not match.");
  const data = owner.data as Record<string, unknown>;
  const version = data.version;
  if (typeof version !== "number") throw new Error("Credential owner is not versioned.");
  if (mutation.providerConnectionUpdate && owner.itemType !== "provider-connection") {
    throw new Error("Provider connection updates require a provider-connection owner.");
  }
  const referenceField =
    owner.itemType === "provider-application"
      ? "clientSecretRef"
      : owner.itemType === "mcp-server"
        ? "authSecretRef"
        : owner.itemType === "webhook-endpoint"
          ? "signingSecretRef"
          : "credentialRef";
  const credentialRef = data[referenceField] as
    | { credentialId?: string; generation?: number }
    | undefined;
  if (mutation.action === "created" && credentialRef) {
    throw new Error("Credential owner already has a credential reference.");
  }
  const previousCredential = mutation.prepared.operation.previousRecord?.data as
    | { generation?: number; id?: string }
    | undefined;
  if (
    mutation.action !== "created" &&
    (credentialRef?.credentialId !== previousCredential?.id ||
      credentialRef?.generation !== previousCredential?.generation)
  ) {
    throw new Error("Credential owner generation changed.");
  }
  const requiresChannelBindingReverification =
    owner.itemType === "channel-binding" &&
    mutation.action === "rotated" &&
    (owner.data.provider === "slack_edge" || owner.data.provider === "slack_cloudflare_edge") &&
    owner.data.metadata?.slackAgentIdentity !== undefined;
  const retainedData = { ...data };
  if (requiresChannelBindingReverification) {
    delete retainedData.lastVerifiedAt;
  }
  const nextData = {
    ...retainedData,
    [referenceField]: mutation.prepared.reference,
    ...(mutation.action === "revoked"
      ? owner.itemType === "provider-connection"
        ? { status: "disconnected" }
        : ["channel-binding", "mcp-server", "webhook-endpoint"].includes(owner.itemType)
          ? { status: "disabled" }
          : {}
      : owner.itemType === "provider-connection"
        ? { status: "active" }
        : requiresChannelBindingReverification
          ? { status: "disabled" }
          : {}),
    ...mutation.providerConnectionUpdate,
    updatedAt: now,
    version: version + 1,
  };
  return withCanonicalRecordKeys({ itemType: owner.itemType, data: nextData }) as PlatformRecord;
}

async function nextAggregateVersion(
  client: Awaited<ReturnType<typeof runtimeScopedDocumentClient>>,
  scope: CredentialVaultScope,
  aggregateType: string,
  aggregateId: string,
) {
  const result = await channelProviderDocumentPersistence.find(client, {
    ConsistentRead: true,
    ExpressionAttributeValues: {
      ":pk": key("ORG", scope.organizationId, "AGGREGATE", aggregateType, aggregateId),
    },
    KeyConditionExpression: "pk = :pk",
    Limit: 1,
    ScanIndexForward: false,
    TableName: process.env.DEPLOYMENTS_AI_EVENTS_TABLE ?? "events",
  });
  const latest = result.Items?.[0]?.data as { aggregateVersion?: unknown } | undefined;
  return typeof latest?.aggregateVersion === "number" ? latest.aggregateVersion + 1 : 1;
}

async function readOwner(
  client: DynamoDBDocumentClient,
  scope: CredentialVaultScope,
  ownerType: CredentialOwnerType,
  ownerId: string,
) {
  const result = await channelProviderDocumentPersistence.read(client, {
    ConsistentRead: true,
    Key: {
      pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
      sk: ownerSortKey(ownerType, ownerId),
    },
    TableName: process.env.DEPLOYMENTS_AI_CONTROL_TABLE,
  });
  if (!result.Item) throw new Error("Credential owner was not found.");
  const owner = await Effect.runPromise(decodePlatformRecord(result.Item));
  if (!("projectId" in owner.data) || owner.data.projectId !== scope.projectId) {
    throw new Error("Credential owner scope mismatch.");
  }
  return owner;
}

function controlDatabase(client: DynamoDBDocumentClient) {
  return makeDynamoDatabase(client, {
    control: process.env.DEPLOYMENTS_AI_CONTROL_TABLE ?? "control",
    events: process.env.DEPLOYMENTS_AI_EVENTS_TABLE ?? "events",
    execution: process.env.DEPLOYMENTS_AI_EXECUTION_TABLE ?? "execution",
    usage: process.env.DEPLOYMENTS_AI_USAGE_TABLE ?? "usage",
  });
}

export interface ProviderConnectionReauthorizationRequired {
  readonly connectionId: string;
  /** Credential the provider rejected; a connection that already moved past it is left alone. */
  readonly credentialRef: CredentialVaultReference;
  readonly scope: CredentialVaultScope;
}

/**
 * Marks an active OAuth connection `reauthorization-required` after its token endpoint
 * definitively rejected the refresh grant. The credential is retained (no vault mutation).
 */
export async function commitProviderConnectionReauthorizationRequired(
  input: ProviderConnectionReauthorizationRequired,
) {
  const client = await runtimeScopedDocumentClient(input.scope, "writer");
  const owner = await readOwner(client, input.scope, "provider-connection", input.connectionId);
  const connection = Schema.decodeUnknownSync(ProviderConnectionRecord)(owner);
  const current = connection.data.credentialRef;
  if (
    connection.data.status !== "active" ||
    !current ||
    !("credentialId" in current) ||
    current.credentialId !== input.credentialRef.credentialId ||
    current.generation !== input.credentialRef.generation
  ) {
    return;
  }
  const now = new Date().toISOString();
  const replacement = Schema.decodeUnknownSync(ProviderConnectionRecord)(
    withCanonicalRecordKeys({
      itemType: "provider-connection" as const,
      data: {
        ...connection.data,
        status: "reauthorization-required" as const,
        updatedAt: now,
        version: connection.data.version + 1,
      },
    }),
  );
  const audit = Schema.decodeUnknownSync(AuditEventRecord)(
    withCanonicalRecordKeys({
      itemType: "audit-event" as const,
      data: {
        action: "provider.oauth.reauthorization-required",
        actor: { type: "service-account" as const },
        environmentId: input.scope.environmentId,
        eventId: await id(),
        occurredAt: now,
        organizationId: input.scope.organizationId,
        projectId: input.scope.projectId,
        resourceId: input.connectionId,
        resourceType: "provider-connection",
      },
    }),
  );
  await transactWithSemanticEvents(
    controlDatabase(client),
    [
      { kind: "put", previousRecord: connection, record: replacement },
      {
        conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        kind: "put",
        record: audit,
      },
    ],
    [],
  );
}

export async function commitCredentialOwnershipMutation(mutation: CredentialOwnershipMutation) {
  const client = await runtimeScopedDocumentClient(mutation.scope, "writer");
  const owner = await readOwner(client, mutation.scope, mutation.ownerType, mutation.ownerId);
  const now = new Date().toISOString();
  const replacement = await Effect.runPromise(
    decodePlatformRecord(updatedOwner(owner, mutation, now)),
  );
  const retainedClaims = new Set(
    uniqueClaimRequirements(replacement).map((claim) => `${claim.namespace}\u0000${claim.value}`),
  );
  const previousClaims = new Set(
    uniqueClaimRequirements(owner).map((claim) => `${claim.namespace}\u0000${claim.value}`),
  );
  const claimAcquisitions = uniqueClaimRequirements(replacement)
    .filter((claim) => !previousClaims.has(`${claim.namespace}\u0000${claim.value}`))
    .map((claim) => ({
      conditionExpression: UNIQUE_CLAIM_CONDITION,
      kind: "put" as const,
      record: makeUniqueClaimRecord(
        claim,
        typeof (replacement.data as { createdAt?: unknown }).createdAt === "string"
          ? (replacement.data as { createdAt: string }).createdAt
          : now,
      ) as PlatformRecord,
    }));
  const claimReleases = uniqueClaimRequirements(owner)
    .filter((claim) => !retainedClaims.has(`${claim.namespace}\u0000${claim.value}`))
    .map((claim) => ({
      kind: "delete" as const,
      record: makeUniqueClaimRecord(
        claim,
        typeof (owner.data as { createdAt?: unknown }).createdAt === "string"
          ? (owner.data as { createdAt: string }).createdAt
          : now,
      ) as PlatformRecord,
    }));
  const aggregateVersion = await nextAggregateVersion(
    client,
    mutation.scope,
    mutation.ownerType,
    mutation.ownerId,
  );
  const eventId = await id();
  const event = makeSemanticEventRecord({
    aggregateId: mutation.ownerId as Ulid,
    aggregateType: mutation.ownerType,
    aggregateVersion,
    environmentId: mutation.scope.environmentId as Ulid,
    eventId,
    eventType: eventType(mutation.ownerType, mutation.action),
    occurredAt: now,
    organizationId: mutation.scope.organizationId as Ulid,
    payload: {
      action: mutation.action,
      credentialId: mutation.prepared.reference.credentialId,
      generation: mutation.prepared.reference.generation,
      ownerId: mutation.ownerId,
      ownerType: mutation.ownerType,
    },
    projectId: mutation.scope.projectId as Ulid,
  });
  const audit = Schema.decodeUnknownSync(AuditEventRecord)(
    withCanonicalRecordKeys({
      itemType: "audit-event" as const,
      data: {
        action: `credential.${mutation.action}`,
        actor: mutation.actor ?? { type: "service-account" as const },
        environmentId: mutation.scope.environmentId,
        eventId: await id(),
        occurredAt: now,
        organizationId: mutation.scope.organizationId,
        projectId: mutation.scope.projectId,
        resourceId: mutation.ownerId,
        resourceType: mutation.ownerType,
      },
    }),
  );
  const database = controlDatabase(client);
  await transactWithSemanticEvents(
    database,
    [
      mutation.prepared.operation,
      { kind: "put", previousRecord: owner, record: replacement },
      ...claimAcquisitions,
      ...claimReleases,
      {
        conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        kind: "put",
        record: audit,
      },
    ],
    [event],
  );
}
