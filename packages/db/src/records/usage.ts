import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  Metadata,
  Money,
  NonNegativeSafeInteger,
  NumberMap,
  ObservabilitySourceContext,
  SafeInteger,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  stateVersionFields,
  tenantScopeFields,
  workspaceScopeFields,
} from "../record-schema.ts";
import { SCOPE_LEVELS, scopeFieldsMatch } from "../usage-scope.ts";

/** Who paid for model usage: the operator, or an organization with one of its model credentials. */
export type MeterEventPayer =
  | { readonly kind: "operator" }
  | { readonly kind: "organization"; readonly modelCredentialId: string };

export type SpendFunding = MeterEventPayer["kind"];

/**
 * The `funding` dimension of a meter event. Only an organization-funded event names the
 * organization's model credential (`modelCredentialId`); an event without the dimension is
 * operator-funded, which covers every non-model meter and every event recorded before the
 * dimension existed.
 */
export function meterEventFunding(dimensions: Readonly<Record<string, unknown>>): SpendFunding {
  return dimensions.funding === "organization" ? "organization" : "operator";
}

/** The meter event dimensions that record `payer`, read back by {@link meterEventFunding}. */
export function meterEventFundingDimensions(payer: MeterEventPayer) {
  return payer.kind === "organization"
    ? { funding: "organization" as const, modelCredentialId: payer.modelCredentialId }
    : { funding: "operator" as const };
}

/** A UTC calendar month as `YYYY-MM`, the period an operator-funded spend ceiling covers. */
export const SpendMonth = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^\d{4}-(?:0[1-9]|1[0-2])$/u, { message: "Expected a month as YYYY-MM." }),
  ),
  Schema.brand("SpendMonth"),
);
export type SpendMonth = typeof SpendMonth.Type;

export const MeterEventRecord = makeRecordSchema("meter-event", {
  ...workspaceScopeFields,
  dimensions: Metadata,
  id: Ulid,
  idempotencyKey: Schema.String,
  metric: Schema.String,
  observability: Schema.optional(ObservabilitySourceContext),
  occurredAt: Timestamp,
  quantity: Schema.Number,
  runId: Schema.optional(Ulid),
  source: Schema.String,
  unit: Schema.String,
}).pipe(
  Schema.check(
    Schema.makeFilter(
      ({ data: { dimensions } }) =>
        dimensions.funding === "organization"
          ? typeof dimensions.modelCredentialId === "string" &&
            dimensions.modelCredentialId.trim() !== ""
          : (dimensions.funding === undefined || dimensions.funding === "operator") &&
            dimensions.modelCredentialId === undefined,
      {
        message:
          "Meter event funding must be operator, or organization with its model credential id.",
      },
    ),
  ),
  Schema.check(
    Schema.makeFilter(
      ({ data }) =>
        data.observability?.workspaceId === undefined ||
        data.observability.workspaceId === data.workspaceId,
      { message: "A run's meter event must name the run's workspace." },
    ),
  ),
);

export const UsageCounterShardRecord = makeRecordSchema("usage-counter-shard", {
  ...stateVersionFields,
  ...tenantScopeFields,
  bucket: Schema.String,
  metric: Schema.String,
  quantity: Schema.Number,
  shard: NonNegativeSafeInteger,
  unit: Schema.String,
  updatedAt: Timestamp,
});

/** What an attributed usage counter divides an environment's usage by. */
export const ATTRIBUTIONS = ["agent", "workspace"] as const;
export type Attribution = (typeof ATTRIBUTIONS)[number];

/**
 * One attribution's share of a usage counter: the hourly counter of the meter events attributed
 * to `attributionId`. For `agent`, that is the agent definition the events' run executed; for
 * `workspace`, the workspace the events name.
 * `parts` holds the token splits (`input`, `output`, `cached`, `cache-write`) of the events'
 * dimensions, which the environment counters do not keep.
 */
export const AttributedUsageCounterShardRecord = makeRecordSchema(
  "attributed-usage-counter-shard",
  {
    ...stateVersionFields,
    ...tenantScopeFields,
    attribution: Schema.Literals(ATTRIBUTIONS),
    attributionId: Ulid,
    bucket: Schema.String,
    metric: Schema.String,
    parts: Schema.optional(NumberMap),
    quantity: Schema.Number,
    shard: NonNegativeSafeInteger,
    unit: Schema.String,
    updatedAt: Timestamp,
  },
);

export const UsageAggregateRecord = makeRecordSchema("usage-aggregate", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  bucket: Schema.String,
  dimensions: Schema.optional(Metadata),
  metric: Schema.String,
  quantity: Schema.Number,
  unit: Schema.String,
});

export const CostAggregateRecord = makeRecordSchema("cost-aggregate", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  bucket: Schema.String,
  costs: NumberMap,
  currency: Schema.String,
  source: Schema.String,
  totalMinor: SafeInteger,
});

export const BUDGET_PERIODS = ["daily", "monthly", "quarterly", "yearly"] as const;
export const BUDGET_STATUSES = ["active", "archived", "paused"] as const;
export const MAX_BUDGET_THRESHOLDS = 10;

const ScopeLevelSchema = Schema.Literals(SCOPE_LEVELS);
const BudgetPeriod = Schema.Literals(BUDGET_PERIODS);

/** A whole percentage of the budget amount at which one alert fires per period. */
export const BudgetThresholdPercent = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Budget thresholds must be whole percentages." }),
    Schema.isGreaterThanOrEqualTo(1, { message: "Budget thresholds must be at least 1%." }),
    Schema.isLessThanOrEqualTo(100, { message: "Budget thresholds must not exceed 100%." }),
  ),
);

const BudgetThresholds = Schema.Array(BudgetThresholdPercent).pipe(
  Schema.check(
    Schema.makeFilter(
      (thresholds: readonly number[]) =>
        thresholds.length <= MAX_BUDGET_THRESHOLDS &&
        thresholds.every((value, index) => index === 0 || value > thresholds[index - 1]!),
      { message: "Budget thresholds must be strictly ascending and at most ten." },
    ),
  ),
);

/**
 * A spend limit on exactly one organization, project, environment, or workspace. A budget also
 * records its level's ancestors so threshold events carry the full tenant scope.
 */
export const BudgetRecord = makeRecordSchema("budget", {
  ...mutableResourceFields,
  amountUsdMicros: NonNegativeSafeInteger.pipe(
    Schema.check(Schema.isGreaterThan(0, { message: "Budget amounts must be positive." })),
  ),
  archivedAt: Schema.optional(Timestamp),
  environmentId: Schema.optional(Ulid),
  id: Ulid,
  name: Schema.String,
  organizationId: Ulid,
  period: BudgetPeriod,
  projectId: Schema.optional(Ulid),
  scope: ScopeLevelSchema,
  status: Schema.Literals(BUDGET_STATUSES),
  thresholds: BudgetThresholds,
  workspaceId: Schema.optional(Ulid),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (record) =>
        scopeFieldsMatch(record.data) &&
        record.data.version >= 1 &&
        (record.data.status === "archived") === (record.data.archivedAt !== undefined),
      {
        message:
          "Budget scope identifiers must match the scope level and archived budgets record archivedAt.",
      },
    ),
  ),
);

/**
 * Threshold notification state for one budget period. Spend itself is never copied here; it is
 * read from the scope's `scope-spend-shard` counters so it cannot drift from the usage ledger.
 * `id` is the semantic-event aggregate for the period's threshold events.
 */
export const BudgetPeriodRecord = makeRecordSchema("budget-period", {
  ...mutableResourceFields,
  budgetId: Ulid,
  environmentId: Schema.optional(Ulid),
  id: Ulid,
  notifiedThresholds: BudgetThresholds,
  organizationId: Ulid,
  period: BudgetPeriod,
  periodEnd: Timestamp,
  periodStart: Timestamp,
  projectId: Schema.optional(Ulid),
  workspaceId: Schema.optional(Ulid),
}).pipe(
  Schema.check(
    Schema.makeFilter(
      (record) =>
        record.data.version >= 1 &&
        Date.parse(record.data.periodStart) < Date.parse(record.data.periodEnd),
      { message: "Budget periods start at version one and end after they start." },
    ),
  ),
);

/**
 * One shard of the USD spend recorded for an organization, project, environment, or workspace in
 * one UTC period. The usage materializer increments these in the same transaction as the hourly
 * cost counters, so a period total is a bounded read of `SCOPE_SPEND_SHARD_COUNT` items.
 * `spendUsdMicros` is all spend; `organizationFundedUsdMicros` is the part organizations paid for
 * with their own model keys, and the rest is operator-funded. Shards last written before the split
 * existed lack the field, and their spend is operator-funded because no organization could fund a
 * model call then.
 */
export const ScopeSpendShardRecord = makeRecordSchema("scope-spend-shard", {
  ...stateVersionFields,
  environmentId: Schema.optional(Ulid),
  organizationFundedUsdMicros: Schema.optional(NonNegativeSafeInteger),
  organizationId: Ulid,
  period: BudgetPeriod,
  periodStart: Timestamp,
  projectId: Schema.optional(Ulid),
  scope: ScopeLevelSchema,
  shard: NonNegativeSafeInteger,
  spendUsdMicros: NonNegativeSafeInteger,
  updatedAt: Timestamp,
  workspaceId: Schema.optional(Ulid),
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => scopeFieldsMatch(record.data), {
      message: "Scope spend identifiers must match the scope level.",
    }),
    Schema.makeFilter(
      (record) => (record.data.organizationFundedUsdMicros ?? 0) <= record.data.spendUsdMicros,
      { message: "Organization-funded spend cannot exceed total spend." },
    ),
  ),
);

export const SpendLedgerRecord = makeRecordSchema("spend-ledger", {
  ...tenantScopeFields,
  amount: Money,
  dimensions: Schema.optional(Metadata),
  id: Ulid,
  occurredAt: Timestamp,
  provider: Schema.String,
  providerOperationId: Schema.optional(Schema.String),
  runId: Schema.optional(Ulid),
  usageEventId: Schema.optional(Ulid),
});

export const ProviderBillingPeriodRecord = makeRecordSchema("provider-billing-period", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  actualCost: Schema.optional(Money),
  estimatedCost: Money,
  periodEnd: Schema.String,
  periodStart: Schema.String,
  provider: Schema.String,
  status: Schema.Literals(["closed", "open", "reconciling"]),
});

export const ApiCredentialUsageRecord = makeRecordSchema("api-credential-usage", {
  ...tenantScopeFields,
  apiCredentialId: Ulid,
  createdAt: Timestamp,
  failureReason: Schema.optional(Schema.String),
  id: Ulid,
  ipHash: Schema.optional(Schema.String),
  outcome: Schema.Literals(["allowed", "denied", "error"]),
  requestMethod: Schema.String,
  requestPath: Schema.String,
  userAgentHash: Schema.optional(Schema.String),
});

export const InboxUsageRecord = makeRecordSchema("inbox-usage", {
  ...stateVersionFields,
  ...tenantScopeFields,
  attachmentBytes: Schema.Number,
  bucket: Schema.String,
  inboundMessages: Schema.Number,
  inboxId: Ulid,
  outboundMessages: Schema.Number,
  recipients: Schema.Number,
});

export const StorageUsageRecord = makeRecordSchema("storage-usage", {
  ...stateVersionFields,
  ...tenantScopeFields,
  bucket: Schema.String,
  byteHours: Schema.Number,
  bytes: Schema.Number,
  objectCount: Schema.Number,
  storageClass: Schema.String,
});

export const RateLimitCounterRecord = makeRecordSchema(
  "rate-limit-counter",
  {
    ...stateVersionFields,
    count: Schema.Number,
    expiresAt: Timestamp,
    limitKey: Schema.String,
    organizationId: Schema.optional(Ulid),
    scopeId: Ulid,
    window: Schema.String,
  },
  { expiresAtField: "expiresAt" },
);

export const USAGE_RECORD_SCHEMAS = {
  "api-credential-usage": ApiCredentialUsageRecord,
  "attributed-usage-counter-shard": AttributedUsageCounterShardRecord,
  budget: BudgetRecord,
  "budget-period": BudgetPeriodRecord,
  "cost-aggregate": CostAggregateRecord,
  "inbox-usage": InboxUsageRecord,
  "meter-event": MeterEventRecord,
  "provider-billing-period": ProviderBillingPeriodRecord,
  "rate-limit-counter": RateLimitCounterRecord,
  "scope-spend-shard": ScopeSpendShardRecord,
  "spend-ledger": SpendLedgerRecord,
  "storage-usage": StorageUsageRecord,
  "usage-aggregate": UsageAggregateRecord,
  "usage-counter-shard": UsageCounterShardRecord,
} as const;

export const UsageRecord = Schema.Union(Object.values(USAGE_RECORD_SCHEMAS));
export type UsageRecord = typeof UsageRecord.Type;
