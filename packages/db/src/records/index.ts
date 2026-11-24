import { Effect, Schema } from "effect";
import { canonicalRecordKeys, type KeyableRecord } from "../record-keys.ts";
import { key } from "../keys.ts";
import { governanceLegacyInventoryPartition } from "../record-key-governance.ts";
import { CONTROL_RECORD_SCHEMAS, ControlRecord } from "./control.ts";
import { EVENTS_RECORD_SCHEMAS, EventsRecord } from "./events.ts";
import { EXECUTION_RECORD_SCHEMAS, ExecutionRecord } from "./execution.ts";
import { USAGE_RECORD_SCHEMAS, UsageRecord } from "./usage.ts";
import {
  IDENTITY_RECORD_SCHEMAS,
  IdentityAuthRecord,
  IdentityEmailDeliveryRecord,
  IdentitySecurityEventRecord,
} from "./identity-auth.ts";
export const TABLE_NAMES = [
  "control",
  "events",
  "execution",
  "identity",
  "identity-email-outbox",
  "usage",
] as const;
export type TableName = (typeof TABLE_NAMES)[number];

export const RECORD_SCHEMAS = {
  ...CONTROL_RECORD_SCHEMAS,
  ...EVENTS_RECORD_SCHEMAS,
  ...EXECUTION_RECORD_SCHEMAS,
  ...IDENTITY_RECORD_SCHEMAS,
  ...USAGE_RECORD_SCHEMAS,
  "identity-email-delivery": IdentityEmailDeliveryRecord,
  "identity-security-event": IdentitySecurityEventRecord,
} as const;

export type ItemType = keyof typeof RECORD_SCHEMAS;

export const PlatformRecord = Schema.Union([
  ControlRecord,
  ExecutionRecord,
  EventsRecord,
  IdentityAuthRecord,
  IdentityEmailDeliveryRecord,
  IdentitySecurityEventRecord,
  UsageRecord,
]);
export type PlatformRecord = typeof PlatformRecord.Type;

export class RecordDecodeError extends Schema.TaggedErrorClass<RecordDecodeError>()(
  "RecordDecodeError",
  {
    cause: Schema.Unknown,
    message: Schema.String,
  },
) {}

export const RECORD_TYPES_BY_TABLE = {
  control: Object.keys(CONTROL_RECORD_SCHEMAS) as readonly (keyof typeof CONTROL_RECORD_SCHEMAS)[],
  execution: Object.keys(
    EXECUTION_RECORD_SCHEMAS,
  ) as readonly (keyof typeof EXECUTION_RECORD_SCHEMAS)[],
  identity: Object.keys(
    IDENTITY_RECORD_SCHEMAS,
  ) as readonly (keyof typeof IDENTITY_RECORD_SCHEMAS)[],
  "identity-email-outbox": ["identity-email-delivery"],
  events: [
    ...(Object.keys(EVENTS_RECORD_SCHEMAS) as readonly (keyof typeof EVENTS_RECORD_SCHEMAS)[]),
    "identity-security-event",
  ],
  usage: Object.keys(USAGE_RECORD_SCHEMAS) as readonly (keyof typeof USAGE_RECORD_SCHEMAS)[],
} as const satisfies Record<TableName, readonly ItemType[]>;

const tableByItemType = Object.fromEntries(
  TABLE_NAMES.flatMap((table) => RECORD_TYPES_BY_TABLE[table].map((itemType) => [itemType, table])),
) as Record<ItemType, TableName>;

export function tableForItemType(itemType: ItemType): TableName {
  return tableByItemType[itemType];
}

export function withCanonicalRecordKeys<const InputRecord extends KeyableRecord>(
  record: InputRecord,
) {
  const {
    gsi1pk: _gsi1pk,
    gsi1sk: _gsi1sk,
    gsi2pk: _gsi2pk,
    gsi2sk: _gsi2sk,
    ...recordWithoutIndexKeys
  } = record as InputRecord & Partial<Record<"gsi1pk" | "gsi1sk" | "gsi2pk" | "gsi2sk", string>>;
  return {
    ...recordWithoutIndexKeys,
    ...canonicalRecordKeys(record, tableForItemType(record.itemType as ItemType)),
  };
}

function omitUndefinedValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== undefined).map(omitUndefinedValues);
  }
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, omitUndefinedValues(entry)]),
  );
}

function normalizedRecordKeys(record: PlatformRecord): PlatformRecord | undefined {
  const canonical = canonicalRecordKeys(record, tableForItemType(record.itemType));
  const primaryAndFirstIndexMatch =
    record.pk === canonical.pk &&
    record.sk === canonical.sk &&
    record.gsi1pk === canonical.gsi1pk &&
    record.gsi1sk === canonical.gsi1sk;
  const firstTwoIndexesMatch =
    primaryAndFirstIndexMatch &&
    record.gsi2pk === canonical.gsi2pk &&
    record.gsi2sk === canonical.gsi2sk;
  const stagedGovernanceSecondIndex = new Set<PlatformRecord["itemType"]>([
    "governance-operation",
    "immutable-audit-export",
    "retention-cleanup",
  ]);
  if (firstTwoIndexesMatch) return record;
  if (
    record.itemType === "governance-tenant-record" &&
    record.pk === governanceLegacyInventoryPartition(record.data.organizationId) &&
    record.sk === canonical.sk &&
    record.gsi1pk === canonical.gsi1pk &&
    record.gsi1sk === canonical.gsi1sk &&
    record.gsi2pk === canonical.gsi2pk &&
    record.gsi2sk === canonical.gsi2sk
  ) {
    // Locators stay on the legacy partition until a deploy switches shard writes on.
    return record;
  }
  if (
    primaryAndFirstIndexMatch &&
    stagedGovernanceSecondIndex.has(record.itemType) &&
    record.gsi2pk === undefined &&
    record.gsi2sk === undefined
  ) {
    // Governance reconciliation indexes are backfilled after their physical indexes exist.
    return { ...record, ...canonical } as PlatformRecord;
  }
  if (
    record.itemType === "artifact" &&
    primaryAndFirstIndexMatch &&
    record.gsi2pk === canonical.gsi2pk &&
    record.gsi2sk === key("ARTIFACT", record.data.status, record.data.updatedAt, record.data.id)
  ) {
    // Sorted by status and update time before the environment index sorted artifacts by creation;
    // the artifact-creation-index deploy migration rewrites these keys.
    return record;
  }
  if (
    record.itemType === "run" &&
    primaryAndFirstIndexMatch &&
    record.gsi2pk === key("ENV", record.data.environmentId) &&
    record.gsi2sk === canonical.gsi2sk
  ) {
    // Normalize the previous environment-scoped run index during staged rollout.
    return { ...record, ...canonical } as PlatformRecord;
  }
  if (
    record.itemType === "provider-mutation-claim" &&
    record.pk === key("ORG", record.data.organizationId, "ENV", record.data.environmentId) &&
    record.sk === key("PROVIDER-MUTATION-CLAIM", record.data.idempotencyKey) &&
    record.gsi1pk === undefined &&
    record.gsi1sk === undefined &&
    record.gsi2pk === key("ENV", record.data.environmentId) &&
    record.gsi2sk ===
      key(
        "PROVIDER-MUTATION-CLAIM",
        record.data.status,
        record.data.updatedAt,
        record.data.idempotencyKey,
      )
  ) {
    // Keep legacy claim keys addressable during the run-scoped key rollout.
    return record;
  }
  return undefined;
}

const KEY_ATTRIBUTES = ["pk", "sk", "gsi1pk", "gsi1sk", "gsi2pk", "gsi2sk"] as const;

function mismatchedKeyAttributes(record: PlatformRecord) {
  const canonical = canonicalRecordKeys(record, tableForItemType(record.itemType));
  return KEY_ATTRIBUTES.filter((attribute) => record[attribute] !== canonical[attribute]);
}

export function decodePlatformRecord(input: unknown) {
  return Schema.decodeUnknownEffect(PlatformRecord, {
    onExcessProperty: "error",
  })(input).pipe(
    Effect.flatMap((record) =>
      Effect.try({
        catch: (cause) =>
          new RecordDecodeError({
            cause,
            message: "DynamoDB item keys cannot be derived from the registered record payload.",
          }),
        try: () => normalizedRecordKeys(record),
      }).pipe(
        Effect.flatMap((normalized) =>
          normalized
            ? Effect.succeed(omitUndefinedValues(normalized) as PlatformRecord)
            : Effect.fail(
                new RecordDecodeError({
                  cause: record,
                  message: `DynamoDB ${record.itemType} item keys do not match the registered record payload: ${mismatchedKeyAttributes(record).join(", ")}.`,
                }),
              ),
        ),
      ),
    ),
    Effect.mapError((cause) =>
      cause instanceof RecordDecodeError
        ? cause
        : new RecordDecodeError({
            cause,
            message: "DynamoDB item does not match a registered platform record schema.",
          }),
    ),
  );
}
