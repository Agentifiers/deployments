import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  NonEmptyString,
  NonNegativeSafeInteger,
  StringList,
  Timestamp,
  makeRecordSchema,
} from "../record-schema.ts";

export const GovernanceTenantRecordRecord = makeRecordSchema(
  "governance-tenant-record",
  {
    // Sorted, distinct Brain ids the canonical record names; drives the Brain-scoped inventory index.
    brainIds: Schema.optional(
      Schema.Array(NonEmptyString).pipe(Schema.check(Schema.isMinLength(1))),
    ),
    organizationId: Ulid,
    // Sorted, distinct sha256(bucket, key) digests of every object reference the record data
    // names; lets retention find the records that share a blob without reading the organization.
    // Always written; a locator without it is treated as possibly referencing any object.
    recordObjectDigests: Schema.optional(StringList),
    recordItemType: NonEmptyString,
    recordPk: NonEmptyString,
    recordSk: NonEmptyString,
    recordTable: Schema.Literals(["control", "events", "execution", "usage"]),
    // The record's retention anchor (`governanceRecordTimestamp`); lets retention skip records
    // that cannot be due without reading them.
    recordTimestamp: Schema.optional(Schema.String),
    recordTtl: Schema.optional(NonNegativeSafeInteger),
    threadIds: Schema.optional(Schema.Array(Ulid).pipe(Schema.check(Schema.isMinLength(1)))),
  },
  // DynamoDB TTL removes a locator with its record.
  { ttlField: "recordTtl" },
);

export const GovernanceLegacyRecordRecord = makeRecordSchema("governance-legacy-record", {
  kind: Schema.Literal("principal-idempotency"),
  recordItemType: Schema.Literal("idempotency"),
  recordPk: NonEmptyString,
  recordSk: NonEmptyString,
  recordTable: Schema.Literal("events"),
  recordTtl: Schema.optional(NonNegativeSafeInteger),
});

export const GovernanceInventoryStateRecord = makeRecordSchema("governance-inventory-state", {
  completedAt: Timestamp,
  id: Schema.Literal("v1"),
  sourceExportArns: StringList,
});
