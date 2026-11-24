import { Schema } from "effect";
import {
  budgetScopeIndexPartition,
  budgetScopeIndexStatusPrefix,
  scopeSpendPartition,
  scopeSpendPeriodPrefix,
} from "../budget-record-keys.ts";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import {
  BUDGET_PERIODS,
  BudgetRecord,
  ScopeSpendShardRecord,
  type SpendFunding,
} from "../records/usage.ts";
import {
  scopeChain,
  scopeTargetOfRecord,
  type ScopeTarget,
  type UsageScope,
} from "../usage-scope.ts";
import type { BudgetPeriodKind, BudgetRecordValue } from "./contracts.ts";
import { budgetPeriodBounds } from "./periods.ts";

export type ScopeSpendShard = typeof ScopeSpendShardRecord.Type;

/** Shards per scope and period; matches the hourly usage counters' write spreading. */
export const SCOPE_SPEND_SHARD_COUNT = 16;

/**
 * Zero-valued shard records for every scope and period kind a cost at `occurredAt` lands in. Their
 * keys identify the shards to load; `addScopeSpend` produces the next version of each.
 */
export function scopeSpendShardCandidates(input: {
  readonly occurredAt: string;
  readonly scope: UsageScope;
  readonly shard: number;
  readonly updatedAt: string;
}): readonly ScopeSpendShard[] {
  if (
    !Number.isSafeInteger(input.shard) ||
    input.shard < 0 ||
    input.shard >= SCOPE_SPEND_SHARD_COUNT
  ) {
    throw new RangeError("Scope spend shard is out of range.");
  }
  return scopeChain(input.scope).flatMap((target) =>
    BUDGET_PERIODS.map((period) =>
      Schema.decodeUnknownSync(ScopeSpendShardRecord)(
        withCanonicalRecordKeys({
          data: {
            ...target,
            organizationId: input.scope.organizationId,
            organizationFundedUsdMicros: 0,
            period,
            periodStart: budgetPeriodBounds(period, input.occurredAt).periodStart,
            shard: input.shard,
            spendUsdMicros: 0,
            updatedAt: input.updatedAt,
            version: 0,
          },
          itemType: "scope-spend-shard" as const,
        }),
      ),
    ),
  );
}

/**
 * The candidate shard advanced from its stored version by `spendUsdMicros`, which also counts as
 * organization-funded spend when the organization paid.
 */
export function addScopeSpend(
  candidate: ScopeSpendShard,
  previous: ScopeSpendShard | undefined,
  spendUsdMicros: number,
  funding: SpendFunding,
): ScopeSpendShard {
  if (previous && (previous.pk !== candidate.pk || previous.sk !== candidate.sk)) {
    throw new TypeError("Scope spend shard does not match its stored record.");
  }
  const total = (previous?.data.spendUsdMicros ?? 0) + spendUsdMicros;
  if (!Number.isSafeInteger(spendUsdMicros) || spendUsdMicros < 0 || !Number.isSafeInteger(total)) {
    throw new RangeError("Scope spend exceeds the safe integer range.");
  }
  return Schema.decodeUnknownSync(ScopeSpendShardRecord)({
    ...candidate,
    data: {
      ...candidate.data,
      organizationFundedUsdMicros:
        (previous?.data.organizationFundedUsdMicros ?? 0) +
        (funding === "organization" ? spendUsdMicros : 0),
      spendUsdMicros: total,
      version: previous ? previous.data.version + 1 : 0,
    },
  });
}

export interface ScopeSpendTotals {
  readonly organizationFundedUsdMicros: number;
  readonly totalUsdMicros: number;
}

/** Strongly consistent sum of one scope's spend shards for one period: at most 16 items. */
export async function readScopeSpend(
  database: DynamoDatabaseService,
  organizationId: Ulid,
  target: ScopeTarget,
  period: BudgetPeriodKind,
  periodStart: string,
): Promise<ScopeSpendTotals> {
  let totalUsdMicros = 0;
  let organizationFundedUsdMicros = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await database.queryRecords("usage", {
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ExpressionAttributeNames: { "#partition": "pk", "#sort": "sk" },
      ExpressionAttributeValues: {
        ":partition": scopeSpendPartition(organizationId, target),
        ":prefix": scopeSpendPeriodPrefix(period, periodStart),
      },
      KeyConditionExpression: "#partition = :partition AND begins_with(#sort, :prefix)",
      Limit: SCOPE_SPEND_SHARD_COUNT,
    });
    for (const item of page.items) {
      if (item.itemType !== "scope-spend-shard") {
        throw new TypeError("Scope spend partition contains an unexpected record.");
      }
      totalUsdMicros += item.data.spendUsdMicros;
      organizationFundedUsdMicros += item.data.organizationFundedUsdMicros ?? 0;
    }
    if (!Number.isSafeInteger(totalUsdMicros)) {
      throw new RangeError("Scope spend exceeds the safe range.");
    }
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return { organizationFundedUsdMicros, totalUsdMicros };
}

/** Total spend for the budget's own scope and period kind. */
export async function readBudgetSpend(
  database: DynamoDatabaseService,
  budget: BudgetRecordValue,
  periodStart: string,
) {
  const spend = await readScopeSpend(
    database,
    budget.data.organizationId,
    scopeTargetOfRecord(budget),
    budget.data.period,
    periodStart,
  );
  return spend.totalUsdMicros;
}

/** Budgets in one status that govern one scope, via the eventually consistent budget-scope GSI. */
export async function budgetsGoverning(
  database: DynamoDatabaseService,
  organizationId: Ulid,
  target: ScopeTarget,
  status: BudgetRecordValue["data"]["status"],
): Promise<readonly BudgetRecordValue[]> {
  const budgets: BudgetRecordValue[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await database.queryRecords("usage", {
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ExpressionAttributeNames: { "#partition": "gsi1pk", "#sort": "gsi1sk" },
      ExpressionAttributeValues: {
        ":partition": budgetScopeIndexPartition(organizationId, target),
        ":prefix": budgetScopeIndexStatusPrefix(status),
      },
      IndexName: "gsi1",
      KeyConditionExpression: "#partition = :partition AND begins_with(#sort, :prefix)",
      Limit: 100,
    });
    for (const item of page.items) {
      if (item.itemType !== "budget") {
        throw new TypeError("Budget scope index contains an unexpected record.");
      }
      // The index is a projection; trust only the decoded record's own fields.
      const budget = Schema.decodeUnknownSync(BudgetRecord)(item);
      if (budget.data.organizationId === organizationId && budget.data.status === status) {
        budgets.push(budget);
      }
    }
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  return budgets;
}

/** Active budgets governing every level of the scope's chain, most specific first. */
export async function activeBudgetsForScope(
  database: DynamoDatabaseService,
  scope: UsageScope,
): Promise<readonly BudgetRecordValue[]> {
  const levels = await Promise.all(
    scopeChain(scope).map((target) =>
      budgetsGoverning(database, scope.organizationId, target, "active"),
    ),
  );
  return levels.flat();
}
