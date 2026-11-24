import { key } from "./keys.ts";
import { scopeKeyParts, type ScopeTarget } from "./usage-scope.ts";

/** Base partition of a scope's `scope-spend-shard` counters. */
export function scopeSpendPartition(organizationId: string, target: ScopeTarget) {
  return key("ORG", organizationId, "SPEND", ...scopeKeyParts(target));
}

/** Sort-key prefix of every shard of one scope's spend in one period. */
export function scopeSpendPeriodPrefix(period: string, periodStart: string) {
  return `${key("SCOPE-SPEND-SHARD", period, periodStart)}#`;
}

/** GSI1 partition listing the budgets that govern one scope. */
export function budgetScopeIndexPartition(organizationId: string, target: ScopeTarget) {
  return key("ORG", organizationId, "BUDGET-SCOPE", ...scopeKeyParts(target));
}

/** GSI1 sort-key prefix of the budgets in one status. */
export function budgetScopeIndexStatusPrefix(status: string) {
  return `${key("BUDGET", status)}#`;
}
