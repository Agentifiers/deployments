import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { Schema } from "effect";
import { governanceInventoryLayout } from "../governance-inventory-layout.ts";
import { key } from "../keys.ts";
import { RetentionRestampRecord } from "../records/governance.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { retentionTtl } from "../retention-ttl.ts";
import {
  expiresByRetentionTtl,
  RETENTION_TTL_CLASS_BY_ITEM_TYPE,
  RETENTION_TTL_GRACE_SECONDS,
  type RetentionPolicy,
  type RetentionRestamp,
  type RetentionRestampStore,
  type TenantRecord,
} from "./contracts.ts";
import {
  decodeRecord,
  tenantDirectoryDeletes,
  tenantDirectoryPut,
  type DynamoGovernanceContext,
} from "./dynamo-store.ts";
import { makeGovernanceTenantErasure } from "./tenant-erasure.ts";

const DAY_SECONDS = 86_400;
// Two items per record (the record and its locator) keep a batch within the 100-item limit, and
// the byte bound keeps it under DynamoDB's 4 MB transaction request.
const RESTAMPS_PER_TRANSACTION = 50;
const RESTAMP_TRANSACTION_BYTES = 3_000_000;

type RestampRecord = Extract<PlatformRecord, { readonly itemType: "retention-restamp" }>;

export function retentionRestampRecord(restamp: RetentionRestamp): RestampRecord {
  return Schema.decodeUnknownSync(RetentionRestampRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: restamp.createdAt,
        ...(restamp.cursor ? { cursor: restamp.cursor } : {}),
        dueAt: restamp.dueAt,
        id: restamp.organizationId,
        organizationId: restamp.organizationId,
        phase: restamp.phase,
        policyVersion: restamp.policyVersion,
        updatedAt: restamp.updatedAt,
        version: restamp.version,
      },
      itemType: "retention-restamp" as const,
    }),
  ) as RestampRecord;
}

function isConditionFailure(cause: unknown) {
  return (
    cause instanceof Error &&
    (cause.name === "TransactionCanceledException" ||
      cause.name === "ConditionalCheckFailedException")
  );
}

const storedVersionCondition = (restamp: RetentionRestamp) => ({
  ConditionExpression: "#data.#version = :version AND #data.#policyVersion = :policyVersion",
  ExpressionAttributeNames: {
    "#data": "data",
    "#policyVersion": "policyVersion",
    "#version": "version",
  },
  ExpressionAttributeValues: {
    ":policyVersion": restamp.policyVersion,
    ":version": restamp.version,
  },
});

export function makeGovernanceRetentionRestamps(
  context: DynamoGovernanceContext,
): RetentionRestampStore {
  const { client, tableNames } = context;
  const tenantErasure = makeGovernanceTenantErasure(context);

  const restampItems = async (items: readonly TenantRecord[], policy: RetentionPolicy) => {
    const layout = await governanceInventoryLayout(client, tableNames.control);
    const writes = items.flatMap(({ record, table }) => {
      const ttl = retentionTtl(record, policy);
      if (ttl === undefined || record.ttl === undefined || ttl <= record.ttl) return [];
      const raised = { ...record, ttl } as PlatformRecord;
      const version = "version" in record.data ? record.data.version : undefined;
      // Unchanged since the listing read it, so a rewrite or delete in between wins. Semantic
      // events are immutable and carry no version.
      const condition =
        version === undefined
          ? {
              ConditionExpression: "#ttl = :ttl",
              ExpressionAttributeNames: { "#ttl": "ttl" },
              ExpressionAttributeValues: { ":ttl": record.ttl },
            }
          : {
              ConditionExpression: "#ttl = :ttl AND #data.#version = :version",
              ExpressionAttributeNames: { "#data": "data", "#ttl": "ttl", "#version": "version" },
              ExpressionAttributeValues: { ":ttl": record.ttl, ":version": version },
            };
      return [
        {
          bytes: JSON.stringify(raised).length,
          items: [
            { Put: { ...condition, Item: raised, TableName: tableNames[table] ?? table } },
            tenantDirectoryPut(raised, tableNames, layout),
          ],
        },
      ];
    });
    const batches: (typeof writes)[] = [];
    for (const write of writes) {
      const current = batches.at(-1);
      const bytes = current?.reduce((total, entry) => total + entry.bytes, 0) ?? 0;
      if (
        current &&
        current.length < RESTAMPS_PER_TRANSACTION &&
        bytes + write.bytes <= RESTAMP_TRANSACTION_BYTES
      ) {
        current.push(write);
      } else {
        batches.push([write]);
      }
    }
    const send = (batch: typeof writes) =>
      client.send(
        new TransactWriteCommand({ TransactItems: batch.flatMap((entry) => entry.items) }),
      );
    let restamped = 0;
    for (const batch of batches) {
      try {
        await send(batch);
        restamped += batch.length;
      } catch (cause) {
        if (!isConditionFailure(cause)) throw cause;
        for (const write of batch) {
          try {
            await send([write]);
            restamped += 1;
          } catch (single) {
            if (!isConditionFailure(single)) throw single;
          }
        }
      }
    }
    return restamped;
  };

  return {
    async getRetentionRestamp(organizationId) {
      const result = await client.send(
        new GetCommand({
          ConsistentRead: true,
          Key: { pk: key("ORG", organizationId), sk: key("RETENTION-RESTAMP", organizationId) },
          TableName: tableNames.control,
        }),
      );
      if (!result.Item) return undefined;
      const record = await decodeRecord(result.Item);
      if (record.itemType !== "retention-restamp") return undefined;
      const { id: _id, ...restamp } = record.data;
      return restamp;
    },
    async putRetentionRestamp(restamp, previousVersion) {
      const record = retentionRestampRecord(restamp);
      const layout = await governanceInventoryLayout(client, tableNames.control);
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  ...storedVersionCondition({ ...restamp, version: previousVersion }),
                  Item: record,
                  TableName: tableNames.control,
                },
              },
              tenantDirectoryPut(record, tableNames, layout),
            ],
          }),
        );
        return true;
      } catch (cause) {
        if (isConditionFailure(cause)) return false;
        throw cause;
      }
    },
    async deleteRetentionRestamp(restamp) {
      const record = retentionRestampRecord(restamp);
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Delete: {
                  ...storedVersionCondition(restamp),
                  Key: { pk: record.pk, sk: record.sk },
                  TableName: tableNames.control,
                },
              },
              ...tenantDirectoryDeletes(record, tableNames),
            ],
          }),
        );
        return true;
      } catch (cause) {
        if (isConditionFailure(cause)) return false;
        throw cause;
      }
    },
    async restampRetentionTtlPage(organizationId, { cursor, expiringBefore, policy }) {
      const page = await tenantErasure.listTenantRecords(organizationId, cursor, {
        select(locator) {
          if (!expiresByRetentionTtl(locator.recordItemType) || locator.recordTtl === undefined) {
            return undefined;
          }
          if (expiringBefore !== undefined && locator.recordTtl >= expiringBefore) return undefined;
          const timestamp = Date.parse(locator.recordTimestamp ?? "");
          const period = policy[RETENTION_TTL_CLASS_BY_ITEM_TYPE[locator.recordItemType]];
          const target =
            Math.floor(timestamp / 1_000) + period * DAY_SECONDS + RETENTION_TTL_GRACE_SECONDS;
          return Number.isNaN(timestamp) || locator.recordTtl < target ? "consistent" : undefined;
        },
      });
      return {
        ...(page.cursor ? { cursor: page.cursor } : {}),
        restamped: await restampItems(page.items, policy),
      };
    },
  };
}
