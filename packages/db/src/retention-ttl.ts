import { type DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { Effect } from "effect";
import type { TransactionOperation } from "./client-types.ts";
import {
  DEFAULT_RETENTION_POLICY,
  expiresByRetentionTtl,
  RETENTION_TTL_CLASS_BY_ITEM_TYPE,
  RETENTION_TTL_GRACE_SECONDS,
  type RetentionClass,
  type RetentionPolicy,
} from "./governance/contracts.ts";
import { governanceRecordTimestamp } from "./governance-tenant-directory.ts";
import { key } from "./keys.ts";
import { decodePlatformRecord, type PlatformRecord } from "./records/index.ts";

const DAY_MILLISECONDS = 86_400_000;

/**
 * The retention class whose period sets this record's `ttl`, or `undefined` when retention, not
 * DynamoDB, must decide when it goes.
 */
function retentionTtlClass(record: PlatformRecord): RetentionClass | undefined {
  if (!expiresByRetentionTtl(record.itemType)) return undefined;
  // Retention keeps a thread's events while the thread has active work, and the thread's next
  // event-only append condition-checks that its previous event still exists.
  if (record.itemType === "semantic-event") {
    return record.data.aggregateType === "thread" ? undefined : "events";
  }
  // Retention keeps telemetry of an active run or thread and an attempt still running.
  const data: Readonly<Record<string, unknown>> = record.data;
  if (data.runId !== undefined || data.threadId !== undefined || data.status === "running") {
    return undefined;
  }
  return RETENTION_TTL_CLASS_BY_ITEM_TYPE[record.itemType];
}

/** Whether DynamoDB TTL may already have removed the item: absent to every reader. */
export function recordTtlPassed(record: { readonly ttl?: number | undefined }, now: Date) {
  return record.ttl !== undefined && record.ttl <= Math.floor(now.getTime() / 1_000);
}

/** The `ttl` a record gets under `policy`: its retention deadline plus the grace. */
export function retentionTtl(record: PlatformRecord, policy: RetentionPolicy) {
  const category = retentionTtlClass(record);
  const timestamp = Date.parse(governanceRecordTimestamp(record) ?? "");
  if (!category || !Number.isFinite(timestamp)) return undefined;
  return (
    Math.floor((timestamp + policy[category] * DAY_MILLISECONDS) / 1_000) +
    RETENTION_TTL_GRACE_SECONDS
  );
}

function retentionTtlOrganization(operation: TransactionOperation) {
  if (operation.kind !== "put" || !retentionTtlClass(operation.record)) return undefined;
  const data = operation.record.data;
  return "organizationId" in data && typeof data.organizationId === "string"
    ? data.organizationId
    : undefined;
}

/** The organizations whose retention policy sets a `ttl` the operations write. */
export function retentionTtlOrganizations(
  operations: readonly TransactionOperation[],
): ReadonlySet<string> {
  return new Set(operations.map(retentionTtlOrganization).filter((id) => id !== undefined));
}

/**
 * Sets `ttl` on every put of a retention TTL item type from its organization's policy, which
 * `policies` holds for each of `retentionTtlOrganizations(operations)`.
 */
export function withRetentionTtl<Operation extends TransactionOperation>(
  operations: readonly Operation[],
  policies: ReadonlyMap<string, RetentionPolicy>,
): readonly Operation[] {
  return operations.map((operation) => {
    const policy = policies.get(retentionTtlOrganization(operation) ?? "");
    if (operation.kind !== "put" || !policy) return operation;
    const ttl = retentionTtl(operation.record, policy);
    if (ttl === undefined) return operation;
    // Only `ttl` changes, so the operation keeps its kind and the record its item type.
    const stamped = { ...operation, record: { ...operation.record, ttl } } as Operation;
    return stamped;
  });
}

/** An organization's retention periods, eventually consistent, or the defaults it has not changed. */
export async function readRetentionPolicy(
  client: DynamoDBDocumentClient,
  controlTable: string,
  organizationId: string,
): Promise<RetentionPolicy> {
  const result = await client.send(
    new GetCommand({
      ConsistentRead: true,
      Key: { pk: key("ORG", organizationId), sk: key("RETENTION-POLICY", organizationId) },
      TableName: controlTable,
    }),
  );
  if (!result.Item) return DEFAULT_RETENTION_POLICY;
  const record = await Effect.runPromise(decodePlatformRecord(result.Item));
  if (record.itemType !== "retention-policy") return DEFAULT_RETENTION_POLICY;
  return {
    artifacts: record.data.artifactDays,
    audit: record.data.auditDays,
    events: record.data.eventDays,
    messages: record.data.messageDays,
    runs: record.data.runDays,
    threads: record.data.threadDays,
  };
}
