/** Test fixtures for the operational reads: usage-table records and a DynamoDB query emulator. */
import {
  ApiCredentialUsageRecord,
  AttributedUsageCounterShardRecord,
  AuditEventRecord,
  CostAggregateRecord,
  MeterEventRecord,
  SpendLedgerRecord,
  UsageCounterShardRecord,
  withCanonicalRecordKeys,
  type AttributionTarget,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  createOperationalReadService,
  makeAesGcmOperationalCursorCodec,
} from "./operational-reads.ts";

export const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
export const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
export const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
export const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
export const CREDENTIAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
export const NOW = "2026-07-25T12:00:00.000Z";
export const cursorCodec = makeAesGcmOperationalCursorCodec(Buffer.alloc(32, 7));

export function operationalService(databaseService: DynamoDatabaseService) {
  return createOperationalReadService({ cursorCodec, database: databaseService });
}

export function record(
  schema: Schema.ConstraintDecoder<unknown>,
  value: Parameters<typeof withCanonicalRecordKeys>[0],
): PlatformRecord {
  return Schema.decodeUnknownSync(schema)(withCanonicalRecordKeys(value)) as PlatformRecord;
}

export function counterShard(
  metric: string,
  bucket: string,
  shard: number,
  quantity: number,
  unit: string,
): PlatformRecord {
  return record(UsageCounterShardRecord, {
    data: {
      bucket,
      environmentId: ENVIRONMENT_ID,
      metric,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      quantity,
      shard,
      unit,
      updatedAt: bucket,
      version: 0,
    },
    itemType: "usage-counter-shard",
  });
}

/** One agent definition's or workspace's counter shard, as the usage materializer keeps it. */
export function attributedCounterShard(
  { attribution, attributionId }: AttributionTarget,
  metric: string,
  bucket: string,
  quantity: number,
  unit: string,
  parts?: Readonly<Record<string, number>>,
): PlatformRecord {
  return record(AttributedUsageCounterShardRecord, {
    data: {
      attribution,
      attributionId,
      bucket,
      environmentId: ENVIRONMENT_ID,
      metric,
      organizationId: ORGANIZATION_ID,
      ...(parts ? { parts } : {}),
      projectId: PROJECT_ID,
      quantity,
      shard: 0,
      unit,
      updatedAt: bucket,
      version: 0,
    },
    itemType: "attributed-usage-counter-shard",
  });
}

/** A meter event; `sequence` makes its ULID unique within a test. */
export function meterEvent(
  sequence: number,
  metric: string,
  occurredAt: string,
  quantity: number,
  unit: string,
  dimensions: Readonly<Record<string, number | string>> = {},
): PlatformRecord {
  const id = `01ARZ3NDEKTSV4RRFFQ69G${String(sequence).padStart(4, "0")}`;
  return record(MeterEventRecord, {
    data: {
      dimensions,
      environmentId: ENVIRONMENT_ID,
      id,
      idempotencyKey: id,
      metric,
      occurredAt,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      quantity,
      source: "test",
      unit,
    },
    itemType: "meter-event",
  });
}

type QueryInput = Parameters<DynamoDatabaseService["queryRecords"]>[1];

function attribute(record: PlatformRecord, name: string) {
  return String((record as unknown as Readonly<Record<string, unknown>>)[name]);
}

/**
 * Answers queries the way DynamoDB does for the key conditions this service issues: partition
 * equality with an optional sort-key `BETWEEN`, ordered by sort key, `Limit`, and
 * `ExclusiveStartKey`. `read` counts the records each query reads.
 */
function queryPartition(records: readonly PlatformRecord[], input: QueryInput, read: number[]) {
  const names = input.ExpressionAttributeNames ?? {};
  const values = (input.ExpressionAttributeValues ?? {}) as Readonly<Record<string, string>>;
  const partitionName = names["#pk"] ?? "pk";
  const sortName = names["#sk"] ?? (partitionName === "gsi2pk" ? "gsi2sk" : "sk");
  const ranged = input.KeyConditionExpression?.includes("BETWEEN") === true;
  let matched = records
    .filter((record) => attribute(record, partitionName) === values[":pk"])
    .filter(
      (record) =>
        !ranged ||
        (attribute(record, sortName) >= values[":lower"]! &&
          attribute(record, sortName) <= values[":upper"]!),
    )
    .toSorted((left, right) => (attribute(left, sortName) < attribute(right, sortName) ? -1 : 1));
  if (input.ScanIndexForward === false) matched = matched.toReversed();
  const start = input.ExclusiveStartKey;
  if (start) {
    const index = matched.findIndex(
      (record) => attribute(record, "pk") === start.pk && attribute(record, "sk") === start.sk,
    );
    matched = matched.slice(index + 1);
  }
  const limit = input.Limit ?? matched.length;
  const items = matched.slice(0, limit);
  read.push(items.length);
  const last = items.at(-1);
  return {
    items,
    ...(matched.length > limit && last
      ? {
          lastEvaluatedKey: Object.fromEntries(
            [...new Set(["pk", "sk", partitionName, sortName])].map((name) => [
              name,
              attribute(last, name),
            ]),
          ),
        }
      : {}),
  };
}

export function database(
  records: readonly PlatformRecord[],
  read: number[] = [],
): DynamoDatabaseService {
  return {
    deleteRecord: async () => {},
    getRecord: async (table, key) =>
      records.find(
        (item) =>
          item.pk === key.pk &&
          item.sk === key.sk &&
          (table === "control"
            ? item.itemType === "environment"
            : table === "events"
              ? item.itemType === "audit-event"
              : false),
      ),
    putRecord: async () => {},
    queryRecords: async (table, input) =>
      queryPartition(
        records.filter((item) =>
          table === "events" ? item.itemType === "audit-event" : item.itemType !== "audit-event",
        ),
        input,
        read,
      ),
    transactWrite: async () => {},
  };
}

export function fixtureRecords(): readonly PlatformRecord[] {
  const environment = {
    data: {
      createdAt: NOW,
      id: ENVIRONMENT_ID,
      kind: "production",
      name: "Production",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      slug: "production",
      status: "active",
      updatedAt: NOW,
      version: 0,
    },
    itemType: "environment" as const,
  };
  return [
    withCanonicalRecordKeys(environment) as PlatformRecord,
    record(UsageCounterShardRecord, {
      data: {
        bucket: NOW,
        environmentId: ENVIRONMENT_ID,
        metric: "model.tokens",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        quantity: 12,
        shard: 0,
        unit: "tokens",
        updatedAt: NOW,
        version: 0,
      },
      itemType: "usage-counter-shard",
    }),
    record(CostAggregateRecord, {
      data: {
        bucket: NOW,
        costs: { model: 7 },
        createdAt: NOW,
        currency: "USD",
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        source: "model",
        totalMinor: 7,
        updatedAt: NOW,
        version: 0,
      },
      itemType: "cost-aggregate",
    }),
    record(SpendLedgerRecord, {
      data: {
        amount: { amountMinor: 9, currency: "USD" },
        environmentId: ENVIRONMENT_ID,
        id: CREDENTIAL_ID,
        occurredAt: NOW,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "openai",
      },
      itemType: "spend-ledger",
    }),
    record(ApiCredentialUsageRecord, {
      data: {
        apiCredentialId: CREDENTIAL_ID,
        createdAt: NOW,
        environmentId: ENVIRONMENT_ID,
        id: EVENT_ID,
        organizationId: ORGANIZATION_ID,
        outcome: "allowed",
        projectId: PROJECT_ID,
        requestMethod: "POST",
        requestPath: "/v1/threads/thread/runs",
      },
      itemType: "api-credential-usage",
    }),
    record(AuditEventRecord, {
      data: {
        action: "api-key.rotated",
        actor: { id: PRINCIPAL_ID, type: "principal" },
        environmentId: ENVIRONMENT_ID,
        eventId: EVENT_ID,
        occurredAt: NOW,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        resourceId: CREDENTIAL_ID,
        resourceType: "api-credential",
      },
      itemType: "audit-event",
    }),
  ];
}

export const invocation = {
  identity: {
    environmentIds: [ENVIRONMENT_ID],
    organizationIds: [ORGANIZATION_ID],
    principalId: PRINCIPAL_ID,
    projectIds: [PROJECT_ID],
    scopes: ["usage:read", "spend:read", "api-keys:read", "audit:read"],
  },
  query: {},
  scope: { environmentId: ENVIRONMENT_ID },
};
