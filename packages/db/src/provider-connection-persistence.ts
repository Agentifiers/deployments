import { Schema } from "effect";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DynamoDatabaseService, TransactionOperation } from "./client-types.ts";
import type { Ulid } from "./ids.ts";
import { key } from "./keys.ts";
import { ConnectionCapabilityRecord, ProviderConnectionRecord } from "./records/control.ts";
import type { PlatformRecord } from "./records/index.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "./semantic-event-storage.ts";
import {
  acquireUniqueClaim,
  makeUniqueClaimRecord,
  releaseUniqueClaim,
  uniqueClaimRequirements,
} from "./unique-claims.ts";

type ProviderConnection = Extract<PlatformRecord, { readonly itemType: "provider-connection" }>;
type ConnectionCapability = Extract<PlatformRecord, { readonly itemType: "connection-capability" }>;

interface ProviderConnectionIdempotency {
  readonly environmentId: Ulid;
  readonly key: string;
  readonly operation: string;
  readonly principalId: string;
}

export interface CredentiallessProviderConnectionCreateInput {
  readonly capability: ConnectionCapability;
  readonly connection: ProviderConnection;
  readonly eventId: Ulid;
  readonly idempotency?: ProviderConnectionIdempotency;
  readonly occurredAt: string;
}

export interface ProviderConnectionDisconnectInput {
  readonly additionalOperations?: readonly TransactionOperation[];
  readonly connection: ProviderConnection;
  readonly eventId: Ulid;
  readonly idempotency?: ProviderConnectionIdempotency;
  readonly occurredAt: string;
  readonly previousConnection: ProviderConnection;
}

function createOperations(record: PlatformRecord, occurredAt: string): TransactionOperation[] {
  return [
    { kind: "put", record },
    ...uniqueClaimRequirements(record).map((requirement) =>
      acquireUniqueClaim(
        makeUniqueClaimRecord(requirement, occurredAt) as Extract<
          PlatformRecord,
          { readonly itemType: "unique-claim" }
        >,
      ),
    ),
  ];
}

function credentiallessConnectionOperations(
  input: CredentiallessProviderConnectionCreateInput,
): readonly TransactionOperation[] {
  const connection = Schema.decodeUnknownSync(ProviderConnectionRecord)(input.connection);
  const capability = Schema.decodeUnknownSync(ConnectionCapabilityRecord)(input.capability);
  if (
    connection.data.authMethod !== "none" ||
    connection.data.status !== "active" ||
    connection.data.version !== 0 ||
    capability.data.connectionId !== connection.data.id ||
    capability.data.environmentId !== connection.data.environmentId ||
    capability.data.organizationId !== connection.data.organizationId ||
    capability.data.projectId !== connection.data.projectId ||
    capability.data.providerKey !== connection.data.providerKey ||
    capability.data.status !== "active" ||
    capability.data.verificationVersion !== 0 ||
    capability.data.version !== 0 ||
    !isDeepStrictEqual(capability.data.scopes, connection.data.scopes)
  ) {
    throw new TypeError("Credentialless provider connection capability does not match its owner.");
  }
  return [
    ...createOperations(connection, input.occurredAt),
    ...createOperations(capability, input.occurredAt),
  ];
}

function claimKey(requirement: ReturnType<typeof uniqueClaimRequirements>[number]) {
  return `${requirement.namespace}\u0000${requirement.value}`;
}

function disconnectOperations(input: ProviderConnectionDisconnectInput) {
  const previous = Schema.decodeUnknownSync(ProviderConnectionRecord)(input.previousConnection);
  const connection = Schema.decodeUnknownSync(ProviderConnectionRecord)(input.connection);
  if (
    previous.data.status === "disconnected" ||
    !isDeepStrictEqual(connection.data, {
      ...previous.data,
      status: "disconnected",
      updatedAt: input.occurredAt,
      version: previous.data.version + 1,
    })
  ) {
    throw new TypeError("Provider connection disconnection is not a canonical status change.");
  }
  const before = uniqueClaimRequirements(previous);
  const after = uniqueClaimRequirements(connection);
  const beforeKeys = new Set(before.map(claimKey));
  const afterKeys = new Set(after.map(claimKey));
  return [
    ...(input.additionalOperations ?? []),
    { kind: "put" as const, previousRecord: previous, record: connection },
    ...after
      .filter((requirement) => !beforeKeys.has(claimKey(requirement)))
      .map((requirement) =>
        acquireUniqueClaim(
          makeUniqueClaimRecord(requirement, input.occurredAt) as Extract<
            PlatformRecord,
            { readonly itemType: "unique-claim" }
          >,
        ),
      ),
    ...before
      .filter((requirement) => !afterKeys.has(claimKey(requirement)))
      .map((requirement) =>
        releaseUniqueClaim(
          makeUniqueClaimRecord(requirement, previous.data.createdAt) as Extract<
            PlatformRecord,
            { readonly itemType: "unique-claim" }
          >,
        ),
      ),
  ];
}

function transactionToken(
  input: { readonly idempotency?: ProviderConnectionIdempotency },
  operations: readonly TransactionOperation[],
) {
  if (!input.idempotency) return undefined;
  return createHash("sha256")
    .update(
      [
        input.idempotency.principalId,
        input.idempotency.environmentId,
        input.idempotency.operation,
        input.idempotency.key,
        createHash("sha256").update(JSON.stringify(operations)).digest("hex"),
      ].join("\u0000"),
    )
    .digest("hex")
    .slice(0, 36);
}

export function makeProviderConnectionPersistence(database: DynamoDatabaseService) {
  return {
    async createCredentialless(input: CredentiallessProviderConnectionCreateInput) {
      const operations = credentiallessConnectionOperations(input);
      const event = makeSemanticEventRecord({
        aggregateId: input.connection.data.id,
        aggregateType: "provider-connection",
        aggregateVersion: 1,
        environmentId: input.connection.data.environmentId,
        eventId: input.eventId,
        eventType: "provider.connection.authorized",
        occurredAt: input.occurredAt,
        organizationId: input.connection.data.organizationId,
        payload: {
          connectionId: input.connection.data.id,
          providerKey: input.connection.data.providerKey,
        },
        projectId: input.connection.data.projectId,
      });
      const tokenOperations: TransactionOperation[] = [
        ...operations,
        { kind: "put", record: event },
      ];
      await transactWithSemanticEvents(
        database,
        operations,
        [event],
        transactionToken(input, tokenOperations),
      );
    },
    async disconnect(input: ProviderConnectionDisconnectInput) {
      const operations = disconnectOperations(input);
      const result = await database.queryRecords("events", {
        ConsistentRead: true,
        ExpressionAttributeValues: {
          ":pk": key(
            "ORG",
            input.connection.data.organizationId,
            "AGGREGATE",
            "provider-connection",
            input.connection.data.id,
          ),
        },
        KeyConditionExpression: "pk = :pk",
        Limit: 1,
        ScanIndexForward: false,
      });
      const latest = result.items.find((record) => record.itemType === "semantic-event");
      const event = makeSemanticEventRecord({
        aggregateId: input.connection.data.id,
        aggregateType: "provider-connection",
        aggregateVersion:
          latest?.itemType === "semantic-event" ? latest.data.aggregateVersion + 1 : 1,
        environmentId: input.connection.data.environmentId,
        eventId: input.eventId,
        eventType: "provider.connection.disconnected",
        occurredAt: input.occurredAt,
        organizationId: input.connection.data.organizationId,
        payload: {
          connectionId: input.connection.data.id,
          providerKey: input.connection.data.providerKey,
        },
        projectId: input.connection.data.projectId,
      });
      const tokenOperations: TransactionOperation[] = [
        ...operations,
        { kind: "put", record: event },
      ];
      await transactWithSemanticEvents(
        database,
        operations,
        [event],
        transactionToken(input, tokenOperations),
      );
    },
  };
}
