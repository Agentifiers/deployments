import {
  QueryCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import {
  ErasureFenceRecord,
  ErasureReceiptRecord,
  GovernanceOperationRecord,
  RetentionCleanupRecord,
  RetentionPolicyRecord,
} from "../records/control.ts";
import { TenantErasureProgress } from "../records/governance.ts";
import {
  decodePlatformRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type TableName,
} from "../records/index.ts";
import { key } from "../keys.ts";
import type { GovernanceInventoryLayout } from "../governance-inventory-layout.ts";
import { GOVERNANCE_DISPATCH_SHARD_COUNT } from "../record-key-governance.ts";
import {
  governancePersistenceDirectoryDeleteItem,
  governanceTenantDirectoryDeleteItem,
  governanceTenantDirectoryDeleteLocatorItem,
  governanceTenantDirectoryPutItem,
  governanceTenantOrganizationId,
} from "../governance-tenant-directory.ts";
import { makeUniqueClaimRecord, uniqueClaimRequirements } from "../unique-claims.ts";
import { runLocatorRecord } from "../dynamo-database.ts";
import { withClaimOwnerCondition } from "../transaction-conditions.ts";
import type { IdempotencyResponseProtector } from "../idempotency.ts";
import type { TableNames, TransactionDelete, TransactionOperation } from "../client-types.ts";
import { Effect, Schema } from "effect";
import { makeGovernanceOperationWrites } from "./operation-writes.ts";
import { makeGovernanceRetentionStorage } from "./retention-storage.ts";
import { makeGovernanceRetentionRestamps } from "./retention-restamp.ts";
import { makeGovernanceOperationHistory } from "./operation-history.ts";
import { makeGovernanceTenantErasure } from "./tenant-erasure.ts";
import { makeGovernanceBrainInventory } from "./brain-inventory.ts";
import { makeGovernanceErasureInventory } from "./erasure-inventory.ts";
import { makeGovernanceTenantErasureWrites } from "./tenant-erasure-writes.ts";
import type {
  BrainTenantInventory,
  ErasureFence,
  ErasureReceipt,
  GovernanceObjectReference,
  GovernanceOperation,
  GovernanceStore,
  RetentionRestampStore,
  RetentionCleanup,
  StoredRetentionPolicy,
} from "./contracts.ts";
import { GovernanceError } from "./contracts.ts";
import { governanceOperationRequestedAuditEvent } from "./governance-audit-events.ts";
import { governanceOperationHistoryRecord } from "./operation-history.ts";
import { makeIdGenerator } from "../ids.ts";

export type TransactWriteItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

export const MAX_BATCH_WRITE_ATTEMPTS = 8;
const MAX_BATCH_WRITE_RETRY_DELAY_MILLISECONDS = 1_000;

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function batchWriteRetryDelay(attempt: number, random: () => number) {
  const ceiling = Math.min(
    MAX_BATCH_WRITE_RETRY_DELAY_MILLISECONDS,
    50 * 2 ** Math.max(0, attempt - 1),
  );
  return Math.max(1, Math.floor(ceiling * random()));
}

export function encodeCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor(value: string | undefined): {
  readonly key?: Record<string, unknown>;
  readonly tableIndex: number;
} {
  if (!value) return { tableIndex: 0 };
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
    key?: Record<string, unknown>;
    tableIndex?: unknown;
  };
  if (!Number.isSafeInteger(parsed.tableIndex) || Number(parsed.tableIndex) < 0) {
    throw new Error("Invalid governance inventory cursor.");
  }
  return {
    ...(parsed.key ? { key: parsed.key } : {}),
    tableIndex: Number(parsed.tableIndex),
  };
}

export function objectBlob(
  reference: GovernanceObjectReference,
  contentType = "application/x-ndjson",
) {
  return {
    bucket: reference.bucket,
    byteSize: reference.sizeBytes,
    contentType,
    ...(reference.etag ? { etag: reference.etag } : {}),
    key: reference.key,
    sha256: reference.sha256,
    versionId: reference.versionId,
  };
}

export function operationFromRecord(
  record: Extract<PlatformRecord, { readonly itemType: "governance-operation" }>,
): GovernanceOperation {
  const data = record.data;
  if (data.output && !data.output.versionId) {
    throw new Error("Governance operation output is missing its immutable S3 version ID.");
  }
  if (data.archive && !data.archive.versionId) {
    throw new Error("Governance operation archive is missing its immutable S3 version ID.");
  }
  return {
    ...(data.archive
      ? {
          archive: {
            bucket: data.archive.bucket,
            ...(data.archive.etag ? { etag: data.archive.etag } : {}),
            key: data.archive.key,
            sha256: data.archive.sha256,
            sizeBytes: data.archive.byteSize,
            versionId: data.archive.versionId as string,
          },
        }
      : {}),
    ...(data.auditRetainedUntil ? { auditRetainedUntil: data.auditRetainedUntil } : {}),
    ...(data.auditSignature ? { auditSignature: data.auditSignature } : {}),
    ...(data.auditSignatureKeyId ? { auditSignatureKeyId: data.auditSignatureKeyId } : {}),
    ...(data.auditSignaturePublicKey
      ? { auditSignaturePublicKey: data.auditSignaturePublicKey }
      : {}),
    ...(data.brainSearchErasureReceipt
      ? { brainSearchErasureReceipt: data.brainSearchErasureReceipt }
      : {}),
    ...(data.canonicalDeletedAt ? { canonicalDeletedAt: data.canonicalDeletedAt } : {}),
    ...(data.completedAt ? { completedAt: data.completedAt } : {}),
    ...(data.conversationErasure ? { conversationErasure: data.conversationErasure } : {}),
    createdAt: data.createdAt,
    ...(data.dispatchReadyAt ? { dispatchReadyAt: data.dispatchReadyAt } : {}),
    ...(data.erasureAuditRootHash ? { erasureAuditRootHash: data.erasureAuditRootHash } : {}),
    ...(data.erasureProgress
      ? { erasureProgress: Schema.decodeUnknownSync(TenantErasureProgress)(data.erasureProgress) }
      : {}),
    ...(data.error ? { error: data.error } : {}),
    ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
    id: data.id,
    idempotencyKey: data.idempotencyKey,
    kind: data.kind,
    ...(data.leaseExpiresAt ? { leaseExpiresAt: data.leaseExpiresAt } : {}),
    ...(data.memorySearchErasureReceipt
      ? { memorySearchErasureReceipt: data.memorySearchErasureReceipt }
      : {}),
    ...(data.observabilityErasureProgress
      ? { observabilityErasureProgress: data.observabilityErasureProgress }
      : {}),
    ...(data.observabilityErasureReceipt
      ? { observabilityErasureReceipt: data.observabilityErasureReceipt }
      : {}),
    organizationId: data.organizationId,
    ...(data.output
      ? {
          output: {
            bucket: data.output.bucket,
            ...(data.output.etag ? { etag: data.output.etag } : {}),
            key: data.output.key,
            sha256: data.output.sha256,
            sizeBytes: data.output.byteSize,
            versionId: data.output.versionId as string,
          },
        }
      : {}),
    requestedByPrincipalId: data.requestedByPrincipalId,
    ...(data.startedAt ? { startedAt: data.startedAt } : {}),
    status: data.status,
    ...(data.summary ? { summary: data.summary } : {}),
    updatedAt: data.updatedAt,
    version: data.version,
  };
}

export function operationRecord(operation: GovernanceOperation) {
  return Schema.decodeUnknownSync(GovernanceOperationRecord)(
    withCanonicalRecordKeys({
      data: {
        ...(operation.archive ? { archive: objectBlob(operation.archive) } : {}),
        ...(operation.auditRetainedUntil
          ? { auditRetainedUntil: operation.auditRetainedUntil }
          : {}),
        ...(operation.auditSignature ? { auditSignature: operation.auditSignature } : {}),
        ...(operation.auditSignatureKeyId
          ? { auditSignatureKeyId: operation.auditSignatureKeyId }
          : {}),
        ...(operation.auditSignaturePublicKey
          ? { auditSignaturePublicKey: operation.auditSignaturePublicKey }
          : {}),
        ...(operation.brainSearchErasureReceipt
          ? { brainSearchErasureReceipt: operation.brainSearchErasureReceipt }
          : {}),
        ...(operation.canonicalDeletedAt
          ? { canonicalDeletedAt: operation.canonicalDeletedAt }
          : {}),
        ...(operation.completedAt ? { completedAt: operation.completedAt } : {}),
        ...(operation.conversationErasure
          ? { conversationErasure: operation.conversationErasure }
          : {}),
        createdAt: operation.createdAt,
        ...(operation.dispatchReadyAt ? { dispatchReadyAt: operation.dispatchReadyAt } : {}),
        ...(operation.erasureAuditRootHash
          ? { erasureAuditRootHash: operation.erasureAuditRootHash }
          : {}),
        ...(operation.erasureProgress ? { erasureProgress: operation.erasureProgress } : {}),
        ...(operation.error ? { error: operation.error } : {}),
        ...(operation.expiresAt ? { expiresAt: operation.expiresAt } : {}),
        id: operation.id,
        idempotencyKey: operation.idempotencyKey,
        kind: operation.kind,
        ...(operation.leaseExpiresAt ? { leaseExpiresAt: operation.leaseExpiresAt } : {}),
        ...(operation.memorySearchErasureReceipt
          ? { memorySearchErasureReceipt: operation.memorySearchErasureReceipt }
          : {}),
        ...(operation.observabilityErasureProgress
          ? { observabilityErasureProgress: operation.observabilityErasureProgress }
          : {}),
        ...(operation.observabilityErasureReceipt
          ? { observabilityErasureReceipt: operation.observabilityErasureReceipt }
          : {}),
        organizationId: operation.organizationId,
        ...(operation.output
          ? {
              output: objectBlob(operation.output),
              outputSha256: operation.output.sha256,
            }
          : {}),
        requestedByPrincipalId: operation.requestedByPrincipalId,
        ...(operation.startedAt ? { startedAt: operation.startedAt } : {}),
        status: operation.status,
        ...(operation.summary ? { summary: operation.summary } : {}),
        updatedAt: operation.updatedAt,
        version: operation.version,
      },
      itemType: "governance-operation" as const,
    }),
  );
}

/**
 * Completion operations for a prepared export: the operation becomes dispatch-ready, gains its
 * create-only history pointer, and its request is audited in the API's idempotency completion
 * transaction. A replayed request (already dispatch-ready) adds none of them again.
 */
export function governanceOperationDispatchCompletion(
  operation: GovernanceOperation,
  dispatchReadyAt: string,
  auditEventId: string,
  operatorAccessGrantId?: string,
): readonly TransactionOperation[] {
  if (operation.kind === "tenant-erasure" || operation.dispatchReadyAt) return [];
  const ready = {
    ...operation,
    dispatchReadyAt,
    updatedAt: dispatchReadyAt,
  };
  return [
    {
      kind: "put",
      record: operationRecord(ready),
    },
    {
      kind: "put",
      record: governanceOperationHistoryRecord(ready),
    },
    {
      kind: "put",
      record: governanceOperationRequestedAuditEvent(
        operation,
        auditEventId,
        dispatchReadyAt,
        operatorAccessGrantId,
      ),
    },
  ];
}

export function policyRecord(policy: StoredRetentionPolicy) {
  return Schema.decodeUnknownSync(RetentionPolicyRecord)(
    withCanonicalRecordKeys({
      data: {
        artifactDays: policy.artifacts,
        auditDays: policy.audit,
        createdAt: policy.createdAt,
        eventDays: policy.events,
        id: policy.organizationId,
        messageDays: policy.messages,
        organizationId: policy.organizationId,
        runDays: policy.runs,
        threadDays: policy.threads,
        updatedAt: policy.updatedAt,
        updatedByPrincipalId: policy.updatedByPrincipalId,
        version: policy.version,
      },
      itemType: "retention-policy" as const,
    }),
  );
}

export function erasureReceiptRecord(receipt: ErasureReceipt) {
  return Schema.decodeUnknownSync(ErasureReceiptRecord)(
    withCanonicalRecordKeys({
      data: {
        auditRootHash: receipt.auditRootHash,
        completedAt: receipt.completedAt,
        id: receipt.id,
        ...(receipt.memorySearch ? { memorySearch: receipt.memorySearch } : {}),
        ...(receipt.observability ? { observability: receipt.observability } : {}),
        organizationHash: receipt.organizationHash,
        recordsDeleted: receipt.recordsDeleted,
        requestedByPrincipalHash: receipt.requestedByPrincipalHash,
      },
      itemType: "erasure-receipt" as const,
    }),
  );
}

export function erasureFenceRecord(fence: ErasureFence) {
  return Schema.decodeUnknownSync(ErasureFenceRecord)(
    withCanonicalRecordKeys({
      data: {
        ...fence,
        id: fence.organizationId,
      },
      itemType: "erasure-fence" as const,
    }),
  );
}

export function retentionDependentDeletes(
  record: PlatformRecord,
  createdAt: string,
  tableNames: TableNames,
  claimExists: (claim: { readonly pk: string; readonly sk: string }) => boolean = () => true,
): TransactWriteItem[] {
  const organizationId = governanceTenantOrganizationId(record);
  const locator = runLocatorRecord(record);
  const locatorDeletes: TransactWriteItem[] = locator
    ? [
        {
          Delete: {
            Key: { pk: locator.pk, sk: locator.sk },
            TableName: tableNames.control,
          },
        },
        ...tenantDirectoryDeletes(locator, tableNames),
      ]
    : [];
  const claimDeletes = uniqueClaimRequirements(record).flatMap((requirement) => {
    const claim = makeUniqueClaimRecord(requirement, createdAt) as Extract<
      PlatformRecord,
      { readonly itemType: "unique-claim" }
    >;
    if (!claimExists(claim)) return [];
    const conditioned = withClaimOwnerCondition(
      { kind: "delete" as const, record: claim } as TransactionDelete,
      requirement,
    );
    return [
      {
        Delete: {
          ConditionExpression: conditioned.conditionExpression,
          ExpressionAttributeNames: conditioned.expressionAttributeNames,
          ExpressionAttributeValues: conditioned.expressionAttributeValues,
          Key: { pk: claim.pk, sk: claim.sk },
          TableName: tableNames.control,
        },
      } satisfies TransactWriteItem,
      ...tenantDirectoryDeletes(claim, tableNames, organizationId),
    ];
  });
  return [...locatorDeletes, ...claimDeletes];
}

export function retentionCleanupRecord(cleanup: RetentionCleanup) {
  return Schema.decodeUnknownSync(RetentionCleanupRecord)(
    withCanonicalRecordKeys({
      data: { ...cleanup },
      itemType: "retention-cleanup" as const,
    }),
  );
}

export function erasureReceiptFromRecord(
  record: Extract<PlatformRecord, { readonly itemType: "erasure-receipt" }>,
): ErasureReceipt {
  return {
    auditRootHash: record.data.auditRootHash,
    completedAt: record.data.completedAt,
    id: record.data.id,
    ...(record.data.memorySearch ? { memorySearch: record.data.memorySearch } : {}),
    ...(record.data.observability ? { observability: record.data.observability } : {}),
    organizationHash: record.data.organizationHash,
    recordsDeleted: record.data.recordsDeleted,
    requestedByPrincipalHash: record.data.requestedByPrincipalHash,
  };
}

export function storedPolicy(
  record: Extract<PlatformRecord, { readonly itemType: "retention-policy" }>,
): StoredRetentionPolicy {
  return {
    artifacts: record.data.artifactDays,
    audit: record.data.auditDays,
    createdAt: record.data.createdAt,
    events: record.data.eventDays,
    messages: record.data.messageDays,
    organizationId: record.data.organizationId,
    runs: record.data.runDays,
    threads: record.data.threadDays,
    updatedAt: record.data.updatedAt,
    updatedByPrincipalId: record.data.updatedByPrincipalId,
    version: record.data.version,
  };
}

export async function decodeRecord(value: unknown) {
  return Effect.runPromise(decodePlatformRecord(value));
}

export function organizationExistsCondition(organizationId: string, tableName: string) {
  return {
    ConditionCheck: {
      ConditionExpression: "attribute_exists(pk)",
      Key: {
        pk: key("ORG", organizationId),
        sk: key("ORG", organizationId),
      },
      TableName: tableName,
    },
  };
}

export function tenantDirectoryPut(
  record: PlatformRecord,
  tableNames: TableNames,
  layout: GovernanceInventoryLayout,
) {
  const item = governanceTenantDirectoryPutItem(record, tableNames.control, layout);
  if (!item) throw new Error(`${record.itemType} is not eligible for tenant inventory.`);
  return item;
}

/**
 * Deletes a record's locator from both partitions: while a deploy switches shard writes on, a
 * record can have a locator on its legacy partition and its shard, or only on the one a process
 * with the other cached layout does not delete.
 */
export function tenantDirectoryDeletes(
  record: PlatformRecord,
  tableNames: TableNames,
  organizationId?: string,
) {
  return (["legacy", "sharded"] as const).map((layout) => {
    const item = governanceTenantDirectoryDeleteItem(
      record,
      tableNames.control,
      layout,
      organizationId,
    );
    if (!item) throw new Error(`${record.itemType} is not eligible for tenant inventory.`);
    return item;
  });
}

/** {@link tenantDirectoryDeletes}, or the one global locator of a legacy governance record. */
export function persistenceDirectoryDeletes(record: PlatformRecord, tableNames: TableNames) {
  const placed = (layout: GovernanceInventoryLayout) => {
    const item = governancePersistenceDirectoryDeleteItem(record, tableNames.control, layout);
    if (!item) throw new Error(`${record.itemType} is not eligible for governance inventory.`);
    return item;
  };
  const legacy = placed("legacy");
  const sharded = placed("sharded");
  return legacy.Delete.Key.pk === sharded.Delete.Key.pk ? [sharded] : [legacy, sharded];
}

export function tenantDirectoryLocatorDelete(
  organizationId: string,
  table: TableName,
  pk: string,
  sk: string,
  tableNames: TableNames,
  layout: GovernanceInventoryLayout,
) {
  return governanceTenantDirectoryDeleteLocatorItem(
    organizationId,
    table,
    pk,
    sk,
    tableNames.control,
    layout,
  );
}

export async function legacyIdempotencyResponse(
  record: Extract<PlatformRecord, { readonly itemType: "idempotency" }>,
  protector: IdempotencyResponseProtector | undefined,
) {
  if (record.data.response === undefined) return undefined;
  if (record.data.responseEncoding === "envelope-v1") {
    return record.data.response.kind === "undefined" ? undefined : record.data.response.value;
  }
  if (record.data.responseEncoding !== "protected-envelope-v1") {
    return record.data.response;
  }
  if (!protector || !record.data.principalId) {
    throw new GovernanceError(
      "legacy_idempotency_migration_unavailable",
      "Legacy tenant idempotency responses require the configured response protector.",
    );
  }
  try {
    return await protector.unprotect(record.data.response, {
      fingerprint: record.data.commandHash,
      idempotencyKey: record.data.idempotencyKey,
      principalId: record.data.principalId,
    });
  } catch {
    throw new GovernanceError(
      "legacy_idempotency_migration_failed",
      "A legacy tenant idempotency response could not be classified safely.",
    );
  }
}

export function responseBelongsToOrganization(response: unknown, organizationId: string) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return false;
  const value = response as Readonly<Record<string, unknown>>;
  return value.organizationId === organizationId || value.id === organizationId;
}

export interface DynamoGovernanceStoreOptions {
  readonly batchWriteRandom?: () => number;
  readonly batchWriteSleep?: (milliseconds: number) => Promise<void>;
  /** Mints audit event ULIDs; defaults to a monotonic generator. */
  readonly generateId?: () => string;
  readonly idempotencyResponseProtector?: IdempotencyResponseProtector;
  readonly now?: () => Date;
  readonly requireTenantInventoryReady?: boolean;
  /** Inventory locators one tenant erasure page lists; defaults to 500. */
  readonly tenantErasurePageSize?: number;
}
export function makeDynamoGovernanceContext(
  client: DynamoDBDocumentClient,
  tableNames: TableNames,
  options: DynamoGovernanceStoreOptions = {},
) {
  const ids = makeIdGenerator();
  return {
    batchWriteRandom: options.batchWriteRandom ?? Math.random,
    batchWriteSleep: options.batchWriteSleep ?? defaultSleep,
    client,
    generateId: options.generateId ?? (() => ids.generate()),
    now: options.now ?? (() => new Date()),
    options,
    tableNames,
  };
}

export type DynamoGovernanceContext = ReturnType<typeof makeDynamoGovernanceContext>;

export function makeDynamoGovernanceStore(
  client: DynamoDBDocumentClient,
  tableNames: TableNames,
  options: DynamoGovernanceStoreOptions = {},
): GovernanceStore & BrainTenantInventory & RetentionRestampStore {
  const context = makeDynamoGovernanceContext(client, tableNames, options);
  return {
    ...makeGovernanceOperationWrites(context),
    ...makeGovernanceOperationHistory(context),
    ...makeGovernanceTenantErasure(context),
    ...makeGovernanceBrainInventory(context),
    ...makeGovernanceRetentionStorage(context),
    ...makeGovernanceErasureInventory(context),
    ...makeGovernanceTenantErasureWrites(context),
    ...makeGovernanceRetentionRestamps(context),
  };
}

export async function listGovernedOrganizationIds(
  client: DynamoDBDocumentClient,
  tableNames: Pick<TableNames, "control" | "events">,
) {
  const organizations: string[] = [];
  for (const source of [
    {
      field: "id",
      indexName: "gsi1",
      itemType: "organization",
      partition: key("GLOBAL", "ORGANIZATIONS"),
      partitionName: "gsi1pk",
      tableName: tableNames.control,
    },
    {
      field: "organizationId",
      indexName: "gsi2",
      itemType: "retention-cleanup",
      partition: key("GLOBAL", "GOVERNED-ORGANIZATIONS"),
      partitionName: "gsi2pk",
      tableName: tableNames.control,
    },
    {
      field: "organizationId",
      indexName: "gsi2",
      itemType: "immutable-audit-export",
      partition: key("GLOBAL", "GOVERNED-ORGANIZATIONS"),
      partitionName: "gsi2pk",
      tableName: tableNames.events,
    },
  ] as const) {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await client.send(
        new QueryCommand({
          ConsistentRead: false,
          ExclusiveStartKey: exclusiveStartKey,
          ExpressionAttributeNames: {
            "#data": "data",
            "#itemType": "itemType",
            "#partition": source.partitionName,
          },
          ExpressionAttributeValues: {
            ":itemType": source.itemType,
            ":partition": source.partition,
          },
          FilterExpression: "#itemType = :itemType",
          IndexName: source.indexName,
          KeyConditionExpression: "#partition = :partition",
          ProjectionExpression: "#data",
          TableName: source.tableName,
        }),
      );
      for (const item of result.Items ?? []) {
        const organizationId = (
          item.data as { id?: unknown; organizationId?: unknown } | undefined
        )?.[source.field];
        if (typeof organizationId === "string") organizations.push(organizationId);
      }
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
  }
  return [...new Set(organizations)].sort();
}

export async function listDispatchableGovernanceOperations(
  client: DynamoDBDocumentClient,
  tableNames: Pick<TableNames, "control" | "events">,
  observedAt = new Date(),
) {
  const messages: (
    | { operationId: string; organizationId: string }
    | { kind: "retention-restamp"; organizationId: string }
  )[] = [];
  for (const status of ["pending", "running"] as const) {
    for (let shard = 0; shard < GOVERNANCE_DISPATCH_SHARD_COUNT; shard += 1) {
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const result = await client.send(
          new QueryCommand({
            ConsistentRead: false,
            ExclusiveStartKey: exclusiveStartKey,
            ExpressionAttributeNames: {
              "#due": "gsi2sk",
              "#partition": "gsi2pk",
            },
            ExpressionAttributeValues: {
              ":due": key(observedAt.toISOString(), "ZZZZZZZZZZZZZZZZZZZZZZZZZZ"),
              ":partition": key("GOVERNANCE-DISPATCH", status, String(shard).padStart(2, "0")),
            },
            IndexName: "gsi2",
            KeyConditionExpression: "#partition = :partition AND #due <= :due",
            TableName: tableNames.control,
          }),
        );
        for (const item of result.Items ?? []) {
          const record = await decodeRecord(item);
          if (record.itemType === "retention-restamp") {
            messages.push({
              kind: "retention-restamp",
              organizationId: record.data.organizationId,
            });
            continue;
          }
          if (record.itemType !== "governance-operation") continue;
          const operation = operationFromRecord(record);
          const leaseExpired =
            operation.status === "running" &&
            operation.leaseExpiresAt !== undefined &&
            Date.parse(operation.leaseExpiresAt) <= observedAt.getTime();
          if (operation.status !== "pending" && !leaseExpired) continue;
          if (operation.kind !== "tenant-erasure" && !operation.dispatchReadyAt) continue;

          messages.push({
            operationId: operation.id,
            organizationId: operation.organizationId,
          });
        }
        exclusiveStartKey = result.LastEvaluatedKey;
      } while (exclusiveStartKey);
    }
  }
  const order = (message: (typeof messages)[number]) =>
    "kind" in message ? "" : message.operationId;
  return messages.sort(
    (left, right) =>
      left.organizationId.localeCompare(right.organizationId) ||
      order(left).localeCompare(order(right)),
  );
}
