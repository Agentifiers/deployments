import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ImmutableAuditExportRecord } from "../records/events.ts";
import { withCanonicalRecordKeys, type PlatformRecord, type TableName } from "../records/index.ts";
import { key } from "../keys.ts";
import { governanceInventoryLayout } from "../governance-inventory-layout.ts";
import { makeTransactWriteRequestToken } from "../transaction-conditions.ts";
import { Schema } from "effect";
import { isDeepStrictEqual } from "node:util";
import type { DynamoGovernanceContext } from "./dynamo-store.ts";
import { organizationGateLaneTransactItems } from "../organization-gate/lanes.ts";
import {
  MAX_BATCH_WRITE_ATTEMPTS,
  batchWriteRetryDelay,
  decodeRecord,
  erasureFenceRecord,
  objectBlob,
  operationRecord,
  organizationExistsCondition,
  persistenceDirectoryDeletes,
  retentionCleanupRecord,
  tenantDirectoryDeletes,
  tenantDirectoryPut,
} from "./dynamo-store.ts";
import type { GovernanceOperationKind, GovernanceStore } from "./contracts.ts";
import { GovernanceError } from "./contracts.ts";
import {
  governanceAuditTransactItems,
  governanceOperationRequestedAuditEvent,
} from "./governance-audit-events.ts";
import { governanceOperationHistoryRecord } from "./operation-history.ts";
import { atomicDependentDeletes, deleteWithDependents } from "./tenant-erasure-writes.ts";

/** Each target is one record delete and up to two locator deletes, within 100 items. */
const ERASURE_DELETE_BATCH_SIZE = 33;

const ORGANIZATION_FENCE_POLICY: Record<GovernanceOperationKind, "claim" | "check"> = {
  "audit-export": "claim",
  "end-user-erasure": "check",
  "tenant-erasure": "check",
  "tenant-export": "claim",
  "thread-erasure": "check",
};

export function makeGovernanceOperationWrites(context: DynamoGovernanceContext) {
  const {
    batchWriteRandom,
    batchWriteSleep,
    client,
    generateId,
    now,
    options: _options,
    tableNames,
  } = context;
  return {
    async appendImmutableAuditExport(manifest, operation, observedAt) {
      if (!operation.leaseExpiresAt) {
        throw new Error("Immutable audit export commit requires an operation lease.");
      }
      const record = Schema.decodeUnknownSync(ImmutableAuditExportRecord)(
        withCanonicalRecordKeys({
          data: {
            algorithm: manifest.algorithm,
            archive: objectBlob(manifest.archive),
            createdAt: manifest.createdAt,
            createdByPrincipalId: manifest.createdByPrincipalId,
            ...(manifest.firstEventAt ? { firstEventAt: manifest.firstEventAt } : {}),
            id: manifest.id,
            ...(manifest.lastEventAt ? { lastEventAt: manifest.lastEventAt } : {}),
            object: objectBlob(manifest.object, "application/json"),
            organizationId: manifest.organizationId,
            recordCount: manifest.recordCount,
            retainedUntil: manifest.retainedUntil,
            rootHash: manifest.rootHash,
            signature: manifest.signature,
            signatureKeyId: manifest.signatureKeyId,
            signaturePublicKey: manifest.signaturePublicKey,
          },
          itemType: "immutable-audit-export" as const,
        }),
      );
      const layout = await governanceInventoryLayout(client, tableNames.control);
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  ConditionExpression:
                    "#data.#version = :operationVersion AND #data.#status = :running AND #data.#leaseExpiresAt > :observedAt",
                  ExpressionAttributeNames: {
                    "#data": "data",
                    "#leaseExpiresAt": "leaseExpiresAt",
                    "#status": "status",
                    "#version": "version",
                  },
                  ExpressionAttributeValues: {
                    ":observedAt": observedAt,
                    ":operationVersion": operation.version,
                    ":running": "running",
                  },
                  Key: {
                    pk: key("ORG", manifest.organizationId),
                    sk: key("GOVERNANCE-OPERATION", operation.id),
                  },
                  TableName: tableNames.control,
                },
              },
              organizationExistsCondition(manifest.organizationId, tableNames.control),
              {
                Put: {
                  ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                  Item: record,
                  TableName: tableNames.events,
                },
              },
              tenantDirectoryPut(record, tableNames, layout),
            ],
          }),
        );
      } catch (cause) {
        if (
          !cause ||
          typeof cause !== "object" ||
          !("name" in cause) ||
          (cause.name !== "ConditionalCheckFailedException" &&
            cause.name !== "TransactionCanceledException")
        ) {
          throw cause;
        }
        const result = await client.send(
          new GetCommand({
            ConsistentRead: true,
            Key: { pk: record.pk, sk: record.sk },
            TableName: tableNames.events,
          }),
        );
        if (!result.Item) throw cause;
        const existing = await decodeRecord(result.Item);
        if (!isDeepStrictEqual(existing, record)) throw cause;
      }
    },
    async beginErasure(fence) {
      const record = erasureFenceRecord(fence);
      const lanes = await organizationGateLaneTransactItems({
        changes: [{ present: true, record }],
        client,
        controlTable: tableNames.control,
        organizationId: record.data.organizationId,
      });
      const layout = await governanceInventoryLayout(client, tableNames.control);
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              organizationExistsCondition(fence.organizationId, tableNames.control),
              {
                Put: {
                  ConditionExpression:
                    "attribute_not_exists(pk) OR #data.#leaseExpiresAt <= :createdAt",
                  ExpressionAttributeNames: {
                    "#data": "data",
                    "#leaseExpiresAt": "leaseExpiresAt",
                  },
                  ExpressionAttributeValues: { ":createdAt": fence.createdAt },
                  Item: record,
                  TableName: tableNames.control,
                },
              },
              tenantDirectoryPut(record, tableNames, layout),
              ...lanes,
            ],
          }),
        );
      } catch (cause) {
        if (
          !cause ||
          typeof cause !== "object" ||
          !("name" in cause) ||
          (cause.name !== "ConditionalCheckFailedException" &&
            cause.name !== "TransactionCanceledException")
        ) {
          throw cause;
        }
        const existing = await client.send(
          new GetCommand({
            ConsistentRead: true,
            Key: { pk: record.pk, sk: record.sk },
            TableName: tableNames.control,
          }),
        );
        const holderId = (existing.Item?.data as { operationId?: unknown } | undefined)
          ?.operationId;
        if (holderId === fence.operationId) return;
        const holder =
          typeof holderId === "string"
            ? await client.send(
                new GetCommand({
                  ConsistentRead: true,
                  Key: {
                    pk: key("ORG", fence.organizationId),
                    sk: key("GOVERNANCE-OPERATION", holderId),
                  },
                  TableName: tableNames.control,
                }),
              )
            : undefined;
        if (
          holder?.Item?.itemType === "governance-operation" &&
          (holder.Item.data as { kind?: unknown } | undefined)?.kind === "tenant-erasure"
        ) {
          throw new GovernanceError(
            "tenant_erasure_in_progress",
            "Another tenant erasure is already in progress.",
          );
        }
        throw new GovernanceError(
          "tenant_governance_busy",
          "Tenant governance is fenced by another operation.",
        );
      }
    },
    async cancelOperationForErasure(operation, previousVersion, erasureOperationId) {
      const record = operationRecord(operation);
      const layout = await governanceInventoryLayout(client, tableNames.control);
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                ConditionExpression: "#data.#operationId = :erasureOperationId",
                ExpressionAttributeNames: {
                  "#data": "data",
                  "#operationId": "operationId",
                },
                ExpressionAttributeValues: {
                  ":erasureOperationId": erasureOperationId,
                },
                Key: {
                  pk: key("ORG", operation.organizationId),
                  sk: key("ERASURE-FENCE", operation.organizationId),
                },
                TableName: tableNames.control,
              },
            },
            organizationExistsCondition(operation.organizationId, tableNames.control),
            {
              Put: {
                ConditionExpression: "#data.#version = :previousVersion",
                ExpressionAttributeNames: {
                  "#data": "data",
                  "#version": "version",
                },
                ExpressionAttributeValues: {
                  ":previousVersion": previousVersion,
                },
                Item: record,
                TableName: tableNames.control,
              },
            },
            tenantDirectoryPut(record, tableNames, layout),
          ],
        }),
      );
      return operation;
    },
    async claimOperation(operation, previousVersion) {
      const record = operationRecord(operation);
      const fence = erasureFenceRecord({
        createdAt: operation.createdAt,
        operationId: operation.id,
        organizationId: operation.organizationId,
      });
      const fencePolicy = ORGANIZATION_FENCE_POLICY[operation.kind];
      const fenceCondition = {
        ConditionExpression:
          "attribute_not_exists(pk) OR #data.#operationId = :operationId OR #data.#leaseExpiresAt <= :observedAt",
        ExpressionAttributeNames: {
          "#data": "data",
          "#leaseExpiresAt": "leaseExpiresAt",
          "#operationId": "operationId",
        },
        ExpressionAttributeValues: {
          ":observedAt": operation.updatedAt,
          ":operationId": operation.id,
        },
        TableName: tableNames.control,
      };
      const fenceTransaction =
        fencePolicy === "claim"
          ? { Put: { ...fenceCondition, Item: fence } }
          : { ConditionCheck: { ...fenceCondition, Key: { pk: fence.pk, sk: fence.sk } } };
      const layout = await governanceInventoryLayout(client, tableNames.control);
      const fenceDirectoryTransaction =
        fencePolicy === "claim"
          ? [
              tenantDirectoryPut(fence, tableNames, layout),
              ...(await organizationGateLaneTransactItems({
                changes: [{ present: true, record: fence }],
                client,
                controlTable: tableNames.control,
                organizationId: fence.data.organizationId,
              })),
            ]
          : [];
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              fenceTransaction,
              ...fenceDirectoryTransaction,
              organizationExistsCondition(operation.organizationId, tableNames.control),
              {
                Put: {
                  ConditionExpression:
                    operation.kind === "tenant-erasure"
                      ? "#data.#version = :previousVersion"
                      : "#data.#version = :previousVersion AND attribute_exists(#data.#dispatchReadyAt)",
                  ExpressionAttributeNames: {
                    "#data": "data",
                    ...(operation.kind === "tenant-erasure"
                      ? {}
                      : { "#dispatchReadyAt": "dispatchReadyAt" }),
                    "#version": "version",
                  },
                  ExpressionAttributeValues: {
                    ":previousVersion": previousVersion,
                  },
                  Item: record,
                  TableName: tableNames.control,
                },
              },
              tenantDirectoryPut(record, tableNames, layout),
            ],
          }),
        );
      } catch (cause) {
        if (
          cause &&
          typeof cause === "object" &&
          "name" in cause &&
          cause.name === "TransactionCanceledException"
        ) {
          const activeFence = await client.send(
            new GetCommand({
              ConsistentRead: true,
              Key: { pk: fence.pk, sk: fence.sk },
              TableName: tableNames.control,
            }),
          );
          const activeFenceData = activeFence.Item?.data as
            | { leaseExpiresAt?: unknown; operationId?: unknown }
            | undefined;
          const leaseExpired =
            typeof activeFenceData?.leaseExpiresAt === "string" &&
            activeFenceData.leaseExpiresAt <= operation.updatedAt;
          if (activeFence.Item && activeFenceData?.operationId !== operation.id && !leaseExpired) {
            throw new GovernanceError(
              "tenant_erasure_in_progress",
              "Tenant governance is fenced by an erasure operation.",
            );
          }
          const stored = await client.send(
            new GetCommand({
              ConsistentRead: true,
              Key: { pk: record.pk, sk: record.sk },
              TableName: tableNames.control,
            }),
          );
          if (
            (stored.Item?.data as { version?: unknown } | undefined)?.version !== previousVersion
          ) {
            throw new GovernanceError(
              "operation_not_runnable",
              "Governance operation changed while it was being claimed.",
            );
          }
        }
        throw cause;
      }
      return operation;
    },
    async createOperation(operation, operatorAccessGrantId) {
      const record = operationRecord(operation);
      const history = governanceOperationHistoryRecord(operation);
      const fence = erasureFenceRecord({
        createdAt: operation.createdAt,
        operationId: operation.id,
        organizationId: operation.organizationId,
      });
      const layout = await governanceInventoryLayout(client, tableNames.control);
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  ConditionExpression: "attribute_not_exists(pk)",
                  Key: { pk: fence.pk, sk: fence.sk },
                  TableName: tableNames.control,
                },
              },
              organizationExistsCondition(operation.organizationId, tableNames.control),
              {
                Put: {
                  ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                  Item: record,
                  TableName: tableNames.control,
                },
              },
              tenantDirectoryPut(record, tableNames, layout),
              {
                Put: {
                  ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                  Item: history,
                  TableName: tableNames.control,
                },
              },
              tenantDirectoryPut(history, tableNames, layout),
              ...governanceAuditTransactItems(
                governanceOperationRequestedAuditEvent(
                  operation,
                  generateId(),
                  operation.createdAt,
                  operatorAccessGrantId,
                ),
                tableNames,
                layout,
              ),
            ],
          }),
        );
      } catch (cause) {
        if (!cause || typeof cause !== "object" || !("name" in cause)) {
          throw cause;
        }
        const existing = await this.getOperation(operation.organizationId, operation.id);
        if (existing?.kind === "tenant-erasure" && operation.kind === "tenant-erasure") {
          if (existing.requestedByPrincipalId === operation.requestedByPrincipalId) {
            return existing;
          }
          throw new GovernanceError(
            "tenant_erasure_already_requested",
            "Tenant erasure has already been requested by another principal.",
          );
        }
        if (
          existing?.idempotencyKey === operation.idempotencyKey &&
          existing.kind === operation.kind &&
          existing.requestedByPrincipalId === operation.requestedByPrincipalId
        ) {
          return existing;
        }
        if (cause.name === "TransactionCanceledException") {
          const activeFence = await client.send(
            new GetCommand({
              ConsistentRead: true,
              Key: { pk: fence.pk, sk: fence.sk },
              TableName: tableNames.control,
            }),
          );
          if (activeFence.Item) {
            throw new GovernanceError(
              "tenant_erasure_in_progress",
              "Tenant governance is fenced by an erasure operation.",
            );
          }
        }
        throw cause;
      }
      return operation;
    },
    async completeRetentionCleanup(cleanup) {
      const record = retentionCleanupRecord(cleanup);
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                ConditionExpression: "#data.#createdAt = :createdAt",
                ExpressionAttributeNames: {
                  "#createdAt": "createdAt",
                  "#data": "data",
                },
                ExpressionAttributeValues: { ":createdAt": cleanup.createdAt },
                Key: { pk: record.pk, sk: record.sk },
                TableName: tableNames.control,
              },
            },
            ...tenantDirectoryDeletes(record, tableNames),
          ],
        }),
      );
    },
    async deleteTenantRecords(records, retryDeadline) {
      const retryDeadlineMilliseconds = Date.parse(retryDeadline);
      if (!Number.isFinite(retryDeadlineMilliseconds)) {
        throw new Error("Tenant erasure retry deadline is invalid.");
      }
      const targets = new Map<
        string,
        {
          readonly pk: string;
          readonly record: PlatformRecord;
          readonly sk: string;
          readonly table: TableName;
        }
      >();
      for (const item of records) {
        const record = item.record;
        const dependentDeletes = await atomicDependentDeletes(context, record);
        if (dependentDeletes.length === 0) {
          targets.set(`${item.table}\u0000${record.pk}\u0000${record.sk}`, {
            pk: record.pk,
            record,
            sk: record.sk,
            table: item.table,
          });
          continue;
        }
        await deleteWithDependents(context, item, dependentDeletes);
      }
      const deletionTargets = [...targets.values()];
      for (let offset = 0; offset < deletionTargets.length; offset += ERASURE_DELETE_BATCH_SIZE) {
        const batch = deletionTargets.slice(offset, offset + ERASURE_DELETE_BATCH_SIZE);
        for (let attempt = 1; ; attempt += 1) {
          try {
            const transactItems = batch.flatMap((target) => [
              {
                Delete: {
                  Key: { pk: target.pk, sk: target.sk },
                  TableName: tableNames[target.table] ?? target.table,
                },
              },
              ...persistenceDirectoryDeletes(target.record, tableNames),
            ]);
            await client.send(
              new TransactWriteCommand({
                ClientRequestToken: makeTransactWriteRequestToken(
                  ["tenant-erasure-delete-batch"],
                  transactItems,
                ),
                TransactItems: transactItems,
              }),
            );
            break;
          } catch (cause) {
            const retryDelay = batchWriteRetryDelay(attempt, batchWriteRandom);
            if (
              attempt >= MAX_BATCH_WRITE_ATTEMPTS ||
              now().getTime() + retryDelay >= retryDeadlineMilliseconds
            ) {
              throw new GovernanceError(
                "tenant_erasure_delete_deferred",
                `Tenant erasure record deletion remained throttled past its retry budget: ${cause instanceof Error ? cause.message : "unknown failure"}.`,
              );
            }
            await batchWriteSleep(retryDelay);
          }
        }
      }
    },
  } satisfies Pick<
    GovernanceStore,
    | "appendImmutableAuditExport"
    | "beginErasure"
    | "cancelOperationForErasure"
    | "claimOperation"
    | "createOperation"
    | "completeRetentionCleanup"
    | "deleteTenantRecords"
  > &
    ThisType<GovernanceStore>;
}
