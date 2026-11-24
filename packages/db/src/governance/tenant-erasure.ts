import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { governanceInventoryLayout } from "../governance-inventory-layout.ts";
import { key } from "../keys.ts";
import {
  governanceInventoryShardPartitions,
  governanceLegacyInventoryPartition,
} from "../record-key-governance.ts";
import {
  organizationGateLaneRepairItems,
  readOrganizationGateLanes,
} from "../organization-gate/lanes.ts";
import type { DynamoGovernanceContext } from "./dynamo-store.ts";
import {
  decodeCursor,
  decodeRecord,
  encodeCursor,
  erasureFenceRecord,
  erasureReceiptFromRecord,
  erasureReceiptRecord,
  legacyIdempotencyResponse,
  operationFromRecord,
  operationRecord,
  responseBelongsToOrganization,
  storedPolicy,
  tenantDirectoryDeletes,
  tenantDirectoryLocatorDelete,
} from "./dynamo-store.ts";
import type { GovernanceStore, TenantRecord } from "./contracts.ts";
import {
  batchGetAll,
  pruneExpiredLocators,
  resolveSelectedTenantInventory,
  resolveTenantInventory,
  type GovernanceDirectoryRecord,
} from "./inventory-resolution.ts";

const GOVERNANCE_INVENTORY_PAGE_SIZE = 100;

export function makeGovernanceTenantErasure(context: DynamoGovernanceContext) {
  const { client, now, options, tableNames } = context;
  return {
    async finalizeErasure(operation, receipt, previousVersion) {
      const operationItem = operationRecord(operation);
      const fenceItem = erasureFenceRecord({
        createdAt: operation.createdAt,
        operationId: operation.id,
        organizationId: operation.organizationId,
      });
      const organizationKey = {
        pk: key("ORG", operation.organizationId),
        sk: key("ORG", operation.organizationId),
      };
      const lanes = organizationGateLaneRepairItems({
        at: now().toISOString(),
        controlTable: tableNames.control,
        lanes: await readOrganizationGateLanes(
          client,
          tableNames.control,
          operation.organizationId,
        ),
        organizationId: operation.organizationId,
        state: undefined,
      });
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                Item: erasureReceiptRecord(receipt),
                TableName: tableNames.control,
              },
            },
            {
              Delete: {
                ConditionExpression: "#data.#version = :previousVersion",
                ExpressionAttributeNames: {
                  "#data": "data",
                  "#version": "version",
                },
                ExpressionAttributeValues: {
                  ":previousVersion": previousVersion,
                },
                Key: { pk: operationItem.pk, sk: operationItem.sk },
                TableName: tableNames.control,
              },
            },
            ...tenantDirectoryDeletes(operationItem, tableNames),
            {
              Delete: {
                ConditionExpression: "#data.#operationId = :operationId",
                ExpressionAttributeNames: {
                  "#data": "data",
                  "#operationId": "operationId",
                },
                ExpressionAttributeValues: { ":operationId": operation.id },
                Key: {
                  pk: key("ORG", operation.organizationId),
                  sk: key("ERASURE-FENCE", operation.organizationId),
                },
                TableName: tableNames.control,
              },
            },
            ...tenantDirectoryDeletes(fenceItem, tableNames),
            {
              Delete: {
                ConditionExpression: "#itemType = :organization AND #data.#id = :organizationId",
                ExpressionAttributeNames: {
                  "#data": "data",
                  "#id": "id",
                  "#itemType": "itemType",
                },
                ExpressionAttributeValues: {
                  ":organization": "organization",
                  ":organizationId": operation.organizationId,
                },
                Key: organizationKey,
                TableName: tableNames.control,
              },
            },
            ...(["legacy", "sharded"] as const).map((layout) =>
              tenantDirectoryLocatorDelete(
                operation.organizationId,
                "control",
                organizationKey.pk,
                organizationKey.sk,
                tableNames,
                layout,
              ),
            ),
            ...lanes,
          ],
        }),
      );
    },
    async getErasureReceipt(operationId) {
      const result = await client.send(
        new GetCommand({
          ConsistentRead: true,
          Key: {
            pk: key("GLOBAL", "erasure-receipt"),
            sk: key("ERASURE-RECEIPT", operationId),
          },
          TableName: tableNames.control,
        }),
      );
      if (!result.Item) return undefined;
      const record = await decodeRecord(result.Item);
      return record.itemType === "erasure-receipt" ? erasureReceiptFromRecord(record) : undefined;
    },
    async getOperation(organizationId, operationId) {
      const result = await client.send(
        new GetCommand({
          ConsistentRead: true,
          Key: {
            pk: key("ORG", organizationId),
            sk: key("GOVERNANCE-OPERATION", operationId),
          },
          TableName: tableNames.control,
        }),
      );
      if (!result.Item) return undefined;
      const record = await decodeRecord(result.Item);
      return record.itemType === "governance-operation" ? operationFromRecord(record) : undefined;
    },
    async organizationExists(organizationId) {
      const result = await client.send(
        new GetCommand({
          ConsistentRead: true,
          Key: {
            pk: key("ORG", organizationId),
            sk: key("ORG", organizationId),
          },
          TableName: tableNames.control,
        }),
      );
      if (!result.Item) return false;
      const record = await decodeRecord(result.Item);
      return record.itemType === "organization" && record.data.id === organizationId;
    },
    async getRetentionPolicy(organizationId) {
      const result = await client.send(
        new GetCommand({
          ConsistentRead: true,
          Key: {
            pk: key("ORG", organizationId),
            sk: key("RETENTION-POLICY", organizationId),
          },
          TableName: tableNames.control,
        }),
      );
      if (!result.Item) return undefined;
      const record = await decodeRecord(result.Item);
      return record.itemType === "retention-policy" ? storedPolicy(record) : undefined;
    },
    async listTenantRecords(organizationId, cursor, selection) {
      const decoded = decodeCursor(cursor);
      const partitions = [
        governanceLegacyInventoryPartition(organizationId),
        ...governanceInventoryShardPartitions(organizationId),
      ];
      const partition = partitions[decoded.tableIndex];
      if (partition === undefined) throw new Error("Invalid governance inventory cursor.");
      if (!cursor && options.requireTenantInventoryReady) {
        const state = await client.send(
          new GetCommand({
            ConsistentRead: true,
            Key: {
              pk: key("GLOBAL", "GOVERNANCE-INVENTORY"),
              sk: key("STATE", "v1"),
            },
            TableName: tableNames.control,
          }),
        );
        const record = state.Item ? await decodeRecord(state.Item) : undefined;
        if (record?.itemType !== "governance-inventory-state") {
          throw new Error(
            "Governance tenant inventory is unavailable until its authoritative directory backfill completes.",
          );
        }
      }
      const result = await client.send(
        new QueryCommand({
          ConsistentRead: true,
          ExclusiveStartKey: decoded.key,
          ExpressionAttributeNames: { "#inventory": "pk" },
          ExpressionAttributeValues: { ":inventory": partition },
          KeyConditionExpression: "#inventory = :inventory",
          Limit: GOVERNANCE_INVENTORY_PAGE_SIZE,
          TableName: tableNames.control,
        }),
      );
      const layout = await governanceInventoryLayout(client, tableNames.control);
      const directory = await Promise.all(
        (result.Items ?? []).map(async (item) => {
          const record = await decodeRecord(item);
          if (record.itemType !== "governance-tenant-record") {
            throw new Error("Governance inventory partition contains an unexpected record.");
          }
          return record;
        }),
      );
      const items = selection
        ? await resolveSelectedTenantInventory(
            context,
            organizationId,
            directory,
            layout,
            selection,
          )
        : await resolveTenantInventory(context, organizationId, directory, layout);
      const next = result.LastEvaluatedKey
        ? { key: result.LastEvaluatedKey, tableIndex: decoded.tableIndex }
        : decoded.tableIndex + 1 < partitions.length
          ? { tableIndex: decoded.tableIndex + 1 }
          : undefined;
      return { ...(next ? { cursor: encodeCursor(next) } : {}), items };
    },
    async listLegacyRuntimeLeases(resourceIds) {
      if (resourceIds.length === 0) return [];
      const ids = [...new Set(resourceIds)];
      const records: Record<string, unknown>[] = [];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const keys = ids.slice(offset, offset + 100).map((resourceId) => ({
          pk: key("RUNTIME-LEASE", resourceId),
          sk: key("RUNTIME-LEASE", `agent-run-thread/${resourceId}`),
        }));
        records.push(
          ...(await batchGetAll(context, {
            [tableNames.execution]: { ConsistentRead: true, Keys: keys },
          })),
        );
      }
      const leases: TenantRecord[] = [];
      for (const item of records) {
        const record = await decodeRecord(item);
        if (record.itemType === "runtime-lease" && record.data.organizationId === undefined) {
          leases.push({ record, table: "execution" });
        }
      }
      return leases;
    },
    async listLegacyPrincipalIdempotency(organizationId) {
      const records: TenantRecord[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const result = await client.send(
          new QueryCommand({
            ConsistentRead: true,
            ExclusiveStartKey: exclusiveStartKey,
            ExpressionAttributeNames: { "#legacy": "pk" },
            ExpressionAttributeValues: {
              ":legacy": key("GLOBAL", "GOVERNANCE-LEGACY", "principal-idempotency"),
            },
            KeyConditionExpression: "#legacy = :legacy",
            Limit: GOVERNANCE_INVENTORY_PAGE_SIZE,
            TableName: tableNames.control,
          }),
        );
        const directory = await Promise.all(
          (result.Items ?? []).map(async (item) => {
            const record = await decodeRecord(item);
            if (record.itemType !== "governance-legacy-record") {
              throw new Error("Governance legacy inventory contains an unexpected record.");
            }
            return record;
          }),
        );
        const legacyItems = await batchGetAll(context, {
          [tableNames.events]: {
            ConsistentRead: true,
            Keys: directory.map((entry) => ({
              pk: entry.data.recordPk,
              sk: entry.data.recordSk,
            })),
          },
        });
        const expected = new Map(
          directory.map((entry) => [`${entry.data.recordPk}\0${entry.data.recordSk}`, entry]),
        );
        const resolved = new Map<
          string,
          Extract<Awaited<ReturnType<typeof decodeRecord>>, { readonly itemType: "idempotency" }>
        >();
        for (const item of legacyItems) {
          const record = await decodeRecord(item);
          const recordKey = `${record.pk}\0${record.sk}`;
          const entry = expected.get(recordKey);
          if (
            !entry ||
            record.itemType !== "idempotency" ||
            !record.data.principalId ||
            record.data.organizationId !== undefined ||
            record.ttl !== entry.data.recordTtl
          ) {
            throw new Error(
              "Governance legacy inventory does not resolve to its canonical idempotency record.",
            );
          }
          resolved.set(recordKey, record);
        }
        const currentEpochSeconds = Math.floor(now().getTime() / 1_000);
        const expiredLocators: GovernanceDirectoryRecord[] = [];
        for (const entry of directory) {
          const record = resolved.get(`${entry.data.recordPk}\0${entry.data.recordSk}`);
          if (!record) {
            if (entry.data.recordTtl !== undefined && entry.data.recordTtl <= currentEpochSeconds) {
              expiredLocators.push(entry);
              continue;
            }
            throw new Error("Governance legacy inventory contains a stale record locator.");
          }
          const response = await legacyIdempotencyResponse(
            record,
            options.idempotencyResponseProtector,
          );
          if (responseBelongsToOrganization(response, organizationId)) {
            records.push({ record, table: "events" });
          }
        }
        await pruneExpiredLocators({ client, tableNames }, expiredLocators);
        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);
      return records;
    },
  } satisfies Pick<
    GovernanceStore,
    | "finalizeErasure"
    | "getErasureReceipt"
    | "getOperation"
    | "organizationExists"
    | "getRetentionPolicy"
    | "listTenantRecords"
    | "listLegacyRuntimeLeases"
    | "listLegacyPrincipalIdempotency"
  > &
    ThisType<GovernanceStore>;
}
