import { Schema } from "effect";
import { recordDataFields } from "./record-schema.ts";
import {
  RECORD_SCHEMAS,
  RECORD_TYPES_BY_TABLE,
  type ItemType,
  type TableName,
} from "./records/index.ts";
export const ACCESS_PATTERN_REGISTRY_VERSION = 1 as const;

export const AccessPattern = Schema.Struct({
  consistency: Schema.Literals(["eventual", "strong"]),
  description: Schema.String,
  index: Schema.Literals(["base", "gsi1", "gsi2"]),
  name: Schema.String,
  partitionKey: Schema.String,
  recordTypes: Schema.Array(Schema.String),
  sortKey: Schema.String,
  table: Schema.Literals([
    "control",
    "events",
    "execution",
    "identity",
    "identity-email-outbox",
    "usage",
  ]),
  uniqueness: Schema.Literals(["conditional", "none", "transactional"]),
  version: Schema.Number,
});
export type AccessPattern = typeof AccessPattern.Type;

function recordTypesWithDataField(table: TableName, field: string): readonly ItemType[] {
  return RECORD_TYPES_BY_TABLE[table].filter((itemType) =>
    recordDataFields(RECORD_SCHEMAS[itemType]).includes(field),
  );
}

export const controlOrganizationRecordTypes = recordTypesWithDataField(
  "control",
  "organizationId",
).filter(
  (itemType) =>
    itemType !== "brain-edge" &&
    itemType !== "brain-deployment-mount" &&
    itemType !== "brain-grant" &&
    itemType !== "email-domain" &&
    itemType !== "email-tenant" &&
    itemType !== "inbox-binding" &&
    itemType !== "memory-space-grant" &&
    itemType !== "monitor",
);
export const controlEnvironmentRecordTypes = recordTypesWithDataField(
  "control",
  "environmentId",
).filter(
  (itemType) =>
    itemType !== "memory-index-state" && itemType !== "email-domain" && itemType !== "email-tenant",
);
const executionEnvironmentRecordTypes = recordTypesWithDataField(
  "execution",
  "environmentId",
).filter(
  (itemType) =>
    itemType !== "generation-reasoning" &&
    itemType !== "runtime-log-batch" &&
    itemType !== "memory-index-job" &&
    itemType !== "memory-recall-attempt" &&
    itemType !== "memory-retrieval" &&
    itemType !== "runtime-lease",
);
export const executionTenantActivityRecordTypes = executionEnvironmentRecordTypes.filter(
  (itemType) => itemType !== "run",
);
export const usageBudgetRecordTypes: readonly ItemType[] = [
  "budget",
  "budget-period",
  "scope-spend-shard",
];
/** Read through their base partition only; the metric indexes hold environment counters. */
export const usageAttributedRecordTypes: readonly ItemType[] = ["attributed-usage-counter-shard"];
const usageMetricIndexExcluded = [...usageBudgetRecordTypes, ...usageAttributedRecordTypes];
export const usageOrganizationRecordTypes = recordTypesWithDataField(
  "usage",
  "organizationId",
).filter((itemType) => !usageMetricIndexExcluded.includes(itemType));
export const usageEnvironmentRecordTypes = recordTypesWithDataField(
  "usage",
  "environmentId",
).filter((itemType) => !usageMetricIndexExcluded.includes(itemType));

export function pattern(
  table: TableName,
  index: AccessPattern["index"],
  name: string,
  description: string,
  partitionKey: string,
  sortKey: string,
  recordTypes: readonly ItemType[],
  options: Pick<AccessPattern, "consistency" | "uniqueness">,
): AccessPattern {
  return {
    ...options,
    description,
    index,
    name,
    partitionKey,
    recordTypes,
    sortKey,
    table,
    version: ACCESS_PATTERN_REGISTRY_VERSION,
  };
}
