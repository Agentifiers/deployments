import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { RuntimeLeaseRecord } from "../records/execution.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { organizationGateLaneTransactItems } from "../organization-gate/lanes.ts";
import { key, organizationWriteFenceCondition } from "../keys.ts";
import { governanceInventoryLayout } from "../governance-inventory-layout.ts";
import { Schema } from "effect";
import type { DynamoGovernanceContext } from "./dynamo-store.ts";
import {
  decodeRecord,
  erasureFenceRecord,
  operationRecord,
  organizationExistsCondition,
  policyRecord,
  retentionCleanupRecord,
  retentionDependentDeletes,
  tenantDirectoryDeletes,
  tenantDirectoryPut,
} from "./dynamo-store.ts";
import type { GovernanceStore } from "./contracts.ts";
import { retentionRestampRecord } from "./retention-restamp.ts";
import { GovernanceError } from "./contracts.ts";
import {
  governanceAuditTransactItems,
  retentionPolicyAuditEvent,
} from "./governance-audit-events.ts";

export function makeGovernanceRetentionStorage(context: DynamoGovernanceContext) {
  const {
    batchWriteRandom: _batchWriteRandom,
    batchWriteSleep: _batchWriteSleep,
    client,
    generateId,
    now,
    options: _options,
    tableNames,
  } = context;
  return {
    async scopeLegacyRuntimeLeases(organizationId, leases, fenceOperationId) {
      for (const item of leases) {
        if (
          item.table !== "execution" ||
          item.record.itemType !== "runtime-lease" ||
          item.record.data.organizationId !== undefined
        ) {
          continue;
        }
        const scoped = Schema.decodeUnknownSync(RuntimeLeaseRecord)(
          withCanonicalRecordKeys({
            ...item.record,
            data: { ...item.record.data, organizationId },
          }),
        );
        const layout = await governanceInventoryLayout(client, tableNames.control);
        try {
          await client.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  ConditionCheck: {
                    ConditionExpression: "#data.#operationId = :fenceOperationId",
                    ExpressionAttributeNames: {
                      "#data": "data",
                      "#operationId": "operationId",
                    },
                    ExpressionAttributeValues: {
                      ":fenceOperationId": fenceOperationId,
                    },
                    Key: {
                      pk: key("ORG", organizationId),
                      sk: key("ERASURE-FENCE", organizationId),
                    },
                    TableName: tableNames.control,
                  },
                },
                organizationExistsCondition(organizationId, tableNames.control),
                {
                  Put: {
                    ConditionExpression:
                      "attribute_not_exists(#data.#organizationId) AND #data.#version = :version AND #data.#expiresAt = :expiresAt AND #data.#owner = :owner",
                    ExpressionAttributeNames: {
                      "#data": "data",
                      "#expiresAt": "expiresAt",
                      "#organizationId": "organizationId",
                      "#owner": "owner",
                      "#version": "version",
                    },
                    ExpressionAttributeValues: {
                      ":expiresAt": item.record.data.expiresAt,
                      ":owner": item.record.data.owner,
                      ":version": item.record.data.version,
                    },
                    Item: scoped,
                    TableName: tableNames.execution,
                  },
                },
                tenantDirectoryPut(scoped, tableNames, layout),
              ],
            }),
          );
        } catch (cause) {
          if (
            !cause ||
            typeof cause !== "object" ||
            !("name" in cause) ||
            cause.name !== "TransactionCanceledException"
          ) {
            throw cause;
          }
          const result = await client.send(
            new GetCommand({
              ConsistentRead: true,
              Key: { pk: item.record.pk, sk: item.record.sk },
              TableName: tableNames.execution,
            }),
          );
          if (!result.Item) continue;
          const current = await decodeRecord(result.Item);
          if (
            current.itemType === "runtime-lease" &&
            current.data.organizationId === organizationId
          ) {
            continue;
          }
          throw cause;
        }
      }
    },
    async putRetentionPolicy(policy, previousVersion, restamp, operatorAccessGrantId) {
      const restampRecord = restamp ? retentionRestampRecord(restamp) : undefined;
      const fenceCondition = organizationWriteFenceCondition(now());
      const record = policyRecord(policy);
      const fenceKey = {
        pk: key("ORG", policy.organizationId),
        sk: key("ERASURE-FENCE", policy.organizationId),
      };
      const layout = await governanceInventoryLayout(client, tableNames.control);
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  ConditionExpression: fenceCondition.conditionExpression,
                  ExpressionAttributeNames: fenceCondition.expressionAttributeNames,
                  ExpressionAttributeValues: fenceCondition.expressionAttributeValues,
                  Key: fenceKey,
                  TableName: tableNames.control,
                },
              },
              organizationExistsCondition(policy.organizationId, tableNames.control),
              {
                Put: {
                  ConditionExpression:
                    previousVersion === undefined
                      ? "attribute_not_exists(pk) AND attribute_not_exists(sk)"
                      : "#data.#version = :previousVersion",
                  ...(previousVersion === undefined
                    ? {}
                    : {
                        ExpressionAttributeNames: {
                          "#data": "data",
                          "#version": "version",
                        },
                        ExpressionAttributeValues: {
                          ":previousVersion": previousVersion,
                        },
                      }),
                  Item: record,
                  TableName: tableNames.control,
                },
              },
              tenantDirectoryPut(record, tableNames, layout),
              // A lengthening replaces any pending restamp, which then restarts from the top.
              ...(restampRecord
                ? [
                    { Put: { Item: restampRecord, TableName: tableNames.control } },
                    tenantDirectoryPut(restampRecord, tableNames, layout),
                  ]
                : []),
              ...governanceAuditTransactItems(
                retentionPolicyAuditEvent(policy, generateId(), operatorAccessGrantId),
                tableNames,
                layout,
              ),
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
              Key: fenceKey,
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
    },
    async releaseErasureFence(fence) {
      const record = erasureFenceRecord(fence);
      const lanes = await organizationGateLaneTransactItems({
        changes: [{ present: false, record }],
        client,
        controlTable: tableNames.control,
        organizationId: record.data.organizationId,
      });
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                ConditionExpression:
                  "attribute_not_exists(pk) OR #data.#operationId = :operationId",
                ExpressionAttributeNames: {
                  "#data": "data",
                  "#operationId": "operationId",
                },
                ExpressionAttributeValues: { ":operationId": fence.operationId },
                Key: { pk: record.pk, sk: record.sk },
                TableName: tableNames.control,
              },
            },
            ...tenantDirectoryDeletes(record, tableNames),
            ...lanes,
          ],
        }),
      );
    },
    async stageErasureRetentionCleanup(item, cleanup, erasureOperationId) {
      if (
        item.record.itemType !== "governance-operation" ||
        item.record.data.kind !== "audit-export"
      ) {
        throw new Error("Only partial audit exports can be retained across tenant erasure.");
      }
      const cleanupRecord = retentionCleanupRecord(cleanup);
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
                  pk: key("ORG", cleanup.organizationId),
                  sk: key("ERASURE-FENCE", cleanup.organizationId),
                },
                TableName: tableNames.control,
              },
            },
            organizationExistsCondition(cleanup.organizationId, tableNames.control),
            {
              Put: {
                ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                Item: cleanupRecord,
                TableName: tableNames.control,
              },
            },
            tenantDirectoryPut(cleanupRecord, tableNames, layout),
            {
              Delete: {
                ConditionExpression: "#data.#version = :version",
                ExpressionAttributeNames: {
                  "#data": "data",
                  "#version": "version",
                },
                ExpressionAttributeValues: {
                  ":version": item.record.data.version,
                },
                Key: { pk: item.record.pk, sk: item.record.sk },
                TableName: tableNames.control,
              },
            },
            ...tenantDirectoryDeletes(item.record, tableNames, cleanup.organizationId),
          ],
        }),
      );
    },
    async stageRetentionCleanup(item, cleanup, fenceOperationId) {
      const data = item.record.data as Readonly<Record<string, unknown>>;
      const version = data.version;
      const timestampField = [
        "retentionExpiresAt",
        "completedAt",
        "occurredAt",
        "updatedAt",
        "createdAt",
      ].find((field) => typeof data[field] === "string");
      const field = typeof version === "number" ? "version" : timestampField;
      const expected = typeof version === "number" ? version : field ? data[field] : undefined;
      if (!field || expected === undefined) {
        throw new Error(`Retention candidate ${item.record.itemType} has no concurrency token.`);
      }
      const cleanupRecord = retentionCleanupRecord(cleanup);
      const layout = await governanceInventoryLayout(client, tableNames.control);
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  ConditionExpression: fenceOperationId
                    ? "#data.#operationId = :fenceOperationId"
                    : "attribute_not_exists(pk)",
                  ...(fenceOperationId
                    ? {
                        ExpressionAttributeNames: {
                          "#data": "data",
                          "#operationId": "operationId",
                        },
                        ExpressionAttributeValues: {
                          ":fenceOperationId": fenceOperationId,
                        },
                      }
                    : {}),
                  Key: {
                    pk: key("ORG", cleanup.organizationId),
                    sk: key("ERASURE-FENCE", cleanup.organizationId),
                  },
                  TableName: tableNames.control,
                },
              },
              ...(item.record.itemType === "immutable-audit-export"
                ? []
                : [organizationExistsCondition(cleanup.organizationId, tableNames.control)]),
              {
                Put: {
                  ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                  Item: cleanupRecord,
                  TableName: tableNames.control,
                },
              },
              tenantDirectoryPut(cleanupRecord, tableNames, layout),
              {
                Delete: {
                  ConditionExpression: "#data.#field = :expected",
                  ExpressionAttributeNames: {
                    "#data": "data",
                    "#field": field,
                  },
                  ExpressionAttributeValues: { ":expected": expected },
                  Key: { pk: item.record.pk, sk: item.record.sk },
                  TableName: tableNames[item.table] ?? item.table,
                },
              },
              ...tenantDirectoryDeletes(item.record, tableNames, cleanup.organizationId),
              ...retentionDependentDeletes(item.record, cleanup.createdAt, tableNames),
            ],
          }),
        );
        return true;
      } catch (cause) {
        if (
          cause &&
          typeof cause === "object" &&
          "name" in cause &&
          (cause.name === "TransactionCanceledException" ||
            cause.name === "ConditionalCheckFailedException")
        ) {
          return false;
        }
        throw cause;
      }
    },
    async updateOperation(operation, previousVersion) {
      const record = operationRecord(operation);
      const layout = await governanceInventoryLayout(client, tableNames.control);
      await client.send(
        new TransactWriteCommand({
          TransactItems: [
            organizationExistsCondition(operation.organizationId, tableNames.control),
            {
              Put: {
                // Claims are fenced atomically, so an operation that is already
                // running may checkpoint and finish behind a later retention or
                // erasure fence while pending operations remain unable to start.
                ConditionExpression:
                  "#data.#version = :previousVersion AND #data.#status = :running",
                ExpressionAttributeNames: {
                  "#data": "data",
                  "#status": "status",
                  "#version": "version",
                },
                ExpressionAttributeValues: {
                  ":previousVersion": previousVersion,
                  ":running": "running",
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
  } satisfies Pick<
    GovernanceStore,
    | "scopeLegacyRuntimeLeases"
    | "putRetentionPolicy"
    | "releaseErasureFence"
    | "stageErasureRetentionCleanup"
    | "stageRetentionCleanup"
    | "updateOperation"
  > &
    ThisType<GovernanceStore>;
}
