import { organizationAuditOperationForEvent } from "../audit/organization-audit-log.ts";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import type { DynamoValue } from "../record-schema.ts";
import type { PlatformRecord } from "../records/index.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import {
  claimRecord,
  databaseValue,
  decodeCursor,
  encodeCursor,
  sameClaim,
} from "../tenancy-record-mapping.ts";
import {
  acquireUniqueClaim,
  releaseUniqueClaim,
  uniqueClaimRequirements,
} from "../unique-claims.ts";
import { makeFederationReads, type FederationReads } from "./reads.ts";

export interface FederationAdministrator {
  /** Set when a platform administrator acts under this operator access grant. */
  readonly operatorAccessGrantId?: Ulid;
  readonly organizationId: Ulid;
  readonly principalId: Ulid;
  readonly tokenSessionId?: Ulid;
}

export interface FederationAdministrationDependencies {
  readonly database: DynamoDatabaseService;
  readonly generateId?: () => Ulid;
  readonly now?: () => Date;
}

export interface FederationPageQuery {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface FederationPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
}

export type RecordOf<ItemType extends PlatformRecord["itemType"]> = Extract<
  PlatformRecord,
  { readonly itemType: ItemType }
>;

export interface AdministrationEvent {
  readonly aggregateId: Ulid;
  readonly aggregateType: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, DynamoValue>>;
}

export interface FailureDescription {
  readonly code: string;
  readonly message: string;
}

export interface AdministrationContext {
  readonly commit: (
    administrator: FederationAdministrator,
    operations: readonly TransactionOperation[],
    event: AdministrationEvent,
    conflict: FailureDescription,
  ) => Promise<void>;
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Ulid;
  readonly nextAggregateVersion: (
    organizationId: Ulid,
    aggregateType: string,
    aggregateId: Ulid,
  ) => Promise<number>;
  readonly now: () => Date;
  readonly organizationRecord: <ItemType extends PlatformRecord["itemType"]>(
    organizationId: Ulid,
    itemType: ItemType,
    id: string,
    missing: FailureDescription,
  ) => Promise<RecordOf<ItemType>>;
  readonly page: <ItemType extends PlatformRecord["itemType"]>(
    organizationId: Ulid,
    itemType: ItemType,
    query: FederationPageQuery,
  ) => Promise<FederationPage<RecordOf<ItemType>>>;
  readonly reads: FederationReads;
}

export function replaceWithClaims<
  Replaced extends PlatformRecord & { readonly data: { readonly createdAt: string } },
>(previous: Replaced, next: Replaced, at: string): TransactionOperation[] {
  const before = uniqueClaimRequirements(previous);
  const after = uniqueClaimRequirements(next);
  return [
    { kind: "put", previousRecord: previous, record: next },
    ...after
      .filter((claim) => !before.some((held) => sameClaim(held, claim)))
      .map((claim) => acquireUniqueClaim(claimRecord(claim, at))),
    ...before
      .filter((claim) => !after.some((kept) => sameClaim(kept, claim)))
      .map((claim) => releaseUniqueClaim(claimRecord(claim, previous.data.createdAt))),
  ];
}

function administratorActor(administrator: FederationAdministrator) {
  return {
    id: administrator.principalId,
    ...(administrator.operatorAccessGrantId
      ? { operatorAccessGrantId: administrator.operatorAccessGrantId }
      : {}),
    type: "principal" as const,
  };
}

export function makeAdministrationContext(
  dependencies: FederationAdministrationDependencies,
): AdministrationContext {
  const { database } = dependencies;
  const ids = makeIdGenerator();
  const generateId = dependencies.generateId ?? (() => ids.generate());

  return {
    commit: async (administrator, operations, event, conflict) => {
      const semanticEvent = makeSemanticEventRecord({
        ...event,
        actor: administratorActor(administrator),
        eventId: generateId(),
        organizationId: administrator.organizationId,
      });
      await databaseValue(
        transactWithSemanticEvents(
          database,
          [
            ...operations,
            organizationAuditOperationForEvent(semanticEvent, administratorActor(administrator)),
          ],
          [semanticEvent],
        ),
        conflict,
      );
    },
    database,
    generateId,
    nextAggregateVersion: async (organizationId, aggregateType, aggregateId) => {
      const result = await databaseValue(
        database.queryRecords("events", {
          ConsistentRead: true,
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": key("ORG", organizationId, "AGGREGATE", aggregateType, aggregateId),
            ":prefix": `${key("SEMANTIC-EVENT")}#`,
          },
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
          Limit: 1,
          ScanIndexForward: false,
        }),
      );
      const last = result.items[0];
      return last?.itemType === "semantic-event" ? last.data.aggregateVersion + 1 : 1;
    },
    now: dependencies.now ?? (() => new Date()),
    organizationRecord: async <ItemType extends PlatformRecord["itemType"]>(
      organizationId: Ulid,
      itemType: ItemType,
      id: string,
      missing: FailureDescription,
    ) => {
      const record = await databaseValue(
        database.getRecord(
          "control",
          { pk: key("ORG", organizationId), sk: key(itemType.toUpperCase(), id) },
          true,
        ),
      );
      if (record?.itemType !== itemType) {
        throw new PersistenceError("not-found", missing.code, missing.message);
      }
      return record as RecordOf<ItemType>;
    },
    page: <ItemType extends PlatformRecord["itemType"]>(
      organizationId: Ulid,
      itemType: ItemType,
      query: FederationPageQuery,
    ) => {
      const partition = key("ORG", organizationId);
      const prefix = `${key(itemType.toUpperCase())}#`;
      return databaseValue(
        (async () => {
          const exclusiveStartKey = decodeCursor(query.cursor, "base", partition, prefix);
          const result = await database.queryRecords("control", {
            ConsistentRead: true,
            ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
            ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
            ExpressionAttributeValues: { ":pk": partition, ":prefix": prefix },
            KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
            Limit: query.limit ?? 50,
            ScanIndexForward: false,
          });
          return {
            items: result.items.filter(
              (record): record is RecordOf<ItemType> => record.itemType === itemType,
            ),
            nextCursor: result.lastEvaluatedKey
              ? encodeCursor(result.lastEvaluatedKey, "base", partition, prefix)
              : null,
          };
        })(),
      );
    },
    reads: makeFederationReads(database),
  };
}
