import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { governancePersistenceDirectoryDeleteItem } from "../governance-tenant-directory.ts";
import { key } from "../keys.ts";
import {
  isOrganizationGateSource,
  organizationGateLaneTransactItems,
  organizationGateSourceOrganizationId,
} from "../organization-gate/lanes.ts";
import type { PlatformRecord } from "../records/index.ts";
import { makeTransactWriteRequestToken } from "../transaction-conditions.ts";
import type {
  ErasableTenantRecord,
  GovernanceStore,
  TenantInventoryLocatorKey,
  TenantRecord,
} from "./contracts.ts";
import { GovernanceError } from "./contracts.ts";
import {
  MAX_BATCH_WRITE_ATTEMPTS,
  batchWriteRetryDelay,
  persistenceDirectoryDeletes,
  retentionDependentDeletes,
  type DynamoGovernanceContext,
  type TransactWriteItem,
} from "./dynamo-store.ts";

const MAX_BATCH_WRITE_ITEMS = 25;
const BATCH_WRITE_CONCURRENCY = 8;

/**
 * The writes that must commit atomically with a record's delete: its run locator, its unique
 * claims (each only while still owned by it), and the organization gate lanes it holds.
 */
export async function atomicDependentDeletes(
  context: DynamoGovernanceContext,
  record: PlatformRecord,
  claimExists?: (claim: { readonly pk: string; readonly sk: string }) => boolean,
) {
  return [
    ...retentionDependentDeletes(
      record,
      context.now().toISOString(),
      context.tableNames,
      claimExists,
    ),
    ...(isOrganizationGateSource(record)
      ? await organizationGateLaneTransactItems({
          changes: [{ present: false, record }],
          client: context.client,
          controlTable: context.tableNames.control,
          organizationId: organizationGateSourceOrganizationId(record),
        })
      : []),
  ];
}

/** Deletes one record with its locators and `dependentDeletes` in one transaction. */
export async function deleteWithDependents(
  context: DynamoGovernanceContext,
  { record, table }: TenantRecord,
  dependentDeletes: readonly TransactWriteItem[],
) {
  const { client, tableNames } = context;
  const transactItems = [
    { Delete: { Key: { pk: record.pk, sk: record.sk }, TableName: tableNames[table] ?? table } },
    ...persistenceDirectoryDeletes(record, tableNames),
    ...dependentDeletes,
  ];
  try {
    await client.send(
      new TransactWriteCommand({
        ClientRequestToken: makeTransactWriteRequestToken(
          ["tenant-erasure-delete", table, record.pk, record.sk],
          transactItems,
        ),
        TransactItems: transactItems,
      }),
    );
  } catch (cause) {
    const name = cause && typeof cause === "object" && "name" in cause ? String(cause.name) : "";
    if (name !== "ConditionalCheckFailedException" && name !== "TransactionCanceledException") {
      throw cause;
    }
    const remaining = await client.send(
      new GetCommand({
        ConsistentRead: true,
        Key: { pk: record.pk, sk: record.sk },
        TableName: tableNames[table] ?? table,
      }),
    );
    if (remaining.Item) throw cause;
  }
}

function locatorsOf({ locators, record }: ErasableTenantRecord) {
  if (locators) return locators;
  return (["legacy", "sharded"] as const).flatMap((layout) => {
    const item = governancePersistenceDirectoryDeleteItem(record, "", layout);
    return item ? [item.Delete.Key] : [];
  });
}

type DeleteRequest = { readonly key: TenantInventoryLocatorKey; readonly tableName: string };

async function batchDelete(
  context: DynamoGovernanceContext,
  requests: readonly DeleteRequest[],
  retryDeadline: number,
) {
  const unique = [
    ...new Map(
      requests.map((request) => [
        `${request.tableName}\0${request.key.pk}\0${request.key.sk}`,
        request,
      ]),
    ).values(),
  ];
  const chunks: DeleteRequest[][] = [];
  for (let offset = 0; offset < unique.length; offset += MAX_BATCH_WRITE_ITEMS) {
    chunks.push(unique.slice(offset, offset + MAX_BATCH_WRITE_ITEMS));
  }
  const sendChunk = async (chunk: readonly DeleteRequest[]) => {
    let pending: Record<string, { DeleteRequest: { Key: Record<string, unknown> } }[]> = {};
    for (const { key: itemKey, tableName } of chunk) {
      (pending[tableName] ??= []).push({
        DeleteRequest: { Key: { pk: itemKey.pk, sk: itemKey.sk } },
      });
    }
    for (let attempt = 1; Object.keys(pending).length > 0; attempt += 1) {
      let failure: unknown;
      try {
        const result = await context.client.send(new BatchWriteCommand({ RequestItems: pending }));
        pending = (result.UnprocessedItems ?? {}) as typeof pending;
      } catch (cause) {
        failure = cause;
      }
      if (Object.keys(pending).length === 0) return;
      const retryDelay = batchWriteRetryDelay(attempt, context.batchWriteRandom);
      if (
        attempt >= MAX_BATCH_WRITE_ATTEMPTS ||
        context.now().getTime() + retryDelay >= retryDeadline
      ) {
        throw new GovernanceError(
          "tenant_erasure_delete_deferred",
          `Tenant erasure record deletion remained throttled past its retry budget: ${failure instanceof Error ? failure.message : "unprocessed deletes"}.`,
        );
      }
      await context.batchWriteSleep(retryDelay);
    }
  };
  for (let offset = 0; offset < chunks.length; offset += BATCH_WRITE_CONCURRENCY) {
    await Promise.all(chunks.slice(offset, offset + BATCH_WRITE_CONCURRENCY).map(sendChunk));
  }
}

export function makeGovernanceTenantErasureWrites(context: DynamoGovernanceContext) {
  const { client, tableNames } = context;
  /**
   * Global claim values (inbox addresses, organization slugs) can be taken by another
   * organization once an owner's transaction on this or an earlier page released them, so a claim
   * is deleted only while it still names the owner it was listed with.
   */
  const deleteOwnedClaim = async (
    claim: Extract<PlatformRecord, { readonly itemType: "unique-claim" }>,
  ) => {
    try {
      await client.send(
        new DeleteCommand({
          ConditionExpression:
            "#data.#ownerId = :ownerId AND #data.#ownerPk = :ownerPk AND #data.#ownerSk = :ownerSk",
          ExpressionAttributeNames: {
            "#data": "data",
            "#ownerId": "ownerId",
            "#ownerPk": "ownerPk",
            "#ownerSk": "ownerSk",
          },
          ExpressionAttributeValues: {
            ":ownerId": claim.data.ownerId,
            ":ownerPk": claim.data.ownerPk,
            ":ownerSk": claim.data.ownerSk,
          },
          Key: { pk: claim.pk, sk: claim.sk },
          TableName: tableNames.control,
        }),
      );
    } catch (cause) {
      const name = cause && typeof cause === "object" && "name" in cause ? String(cause.name) : "";
      if (name !== "ConditionalCheckFailedException") throw cause;
    }
  };
  return {
    async eraseTenantRecords(fence, records, staleLocators, retryDeadline) {
      const retryDeadlineMilliseconds = Date.parse(retryDeadline);
      if (!Number.isFinite(retryDeadlineMilliseconds)) {
        throw new Error("Tenant erasure retry deadline is invalid.");
      }
      const held = await client.send(
        new GetCommand({
          ConsistentRead: true,
          Key: {
            pk: key("ORG", fence.organizationId),
            sk: key("ERASURE-FENCE", fence.organizationId),
          },
          TableName: tableNames.control,
        }),
      );
      if (
        (held.Item?.data as { operationId?: unknown } | undefined)?.operationId !==
        fence.operationId
      ) {
        throw new GovernanceError(
          "tenant_erasure_fence_lost",
          "Tenant erasure no longer holds its organization's erasure fence.",
        );
      }
      const ordinary: ErasableTenantRecord[] = [];
      for (const item of records) {
        const present = item.dependents
          ? new Set(item.dependents.map(({ record }) => `${record.pk}\0${record.sk}`))
          : undefined;
        const dependentDeletes = await atomicDependentDeletes(
          context,
          item.record,
          present && ((claim) => present.has(`${claim.pk}\0${claim.sk}`)),
        );
        if (dependentDeletes.length === 0) ordinary.push(item);
        else await deleteWithDependents(context, item, dependentDeletes);
      }
      const claims = ordinary.flatMap(({ record }) =>
        record.itemType === "unique-claim" ? [record] : [],
      );
      for (let offset = 0; offset < claims.length; offset += BATCH_WRITE_CONCURRENCY) {
        await Promise.all(
          claims.slice(offset, offset + BATCH_WRITE_CONCURRENCY).map(deleteOwnedClaim),
        );
      }
      await batchDelete(
        context,
        ordinary.flatMap(({ record, table }) =>
          record.itemType === "unique-claim"
            ? []
            : [{ key: { pk: record.pk, sk: record.sk }, tableName: tableNames[table] ?? table }],
        ),
        retryDeadlineMilliseconds,
      );
      await batchDelete(
        context,
        [...ordinary.flatMap(locatorsOf), ...staleLocators].map((locator) => ({
          key: locator,
          tableName: tableNames.control,
        })),
        retryDeadlineMilliseconds,
      );
    },
  } satisfies Pick<GovernanceStore, "eraseTenantRecords">;
}
