import { Schema } from "effect";
import { Cursor, PublicId, ResourceName, Timestamp } from "./primitives.ts";
import type { PublicApiRouteContract } from "./route-contract.ts";

export const BUDGET_SCOPE_LEVELS = ["organization", "project", "environment", "workspace"] as const;
export const BUDGET_PERIOD_KINDS = ["daily", "monthly", "quarterly", "yearly"] as const;
export const BUDGET_STATUS_VALUES = ["active", "paused", "archived"] as const;
/** Alert thresholds a budget may carry. */
export const MAX_BUDGET_THRESHOLDS = 10;
/** Period summaries returned per `listBudgetPeriods` page. */
export const MAX_BUDGET_PERIODS_PAGE_LIMIT = 24;

export const BudgetScope = Schema.Literals(BUDGET_SCOPE_LEVELS);
export const BudgetPeriod = Schema.Literals(BUDGET_PERIOD_KINDS);
export const BudgetStatus = Schema.Literals(BUDGET_STATUS_VALUES);

/** Whole US dollar micros (1 USD = 1,000,000). */
const UsdMicros = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "USD micros must be an integer." }),
    Schema.isGreaterThanOrEqualTo(0, {
      message: "USD micros must not be negative.",
    }),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
);

export const BudgetAmountUsdMicros = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({
      message: "Budget amounts must be an integer number of USD micros.",
    }),
    Schema.isGreaterThanOrEqualTo(1, {
      message: "Budget amounts must be positive.",
    }),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER, {
      message: "Budget amounts must be safe integers.",
    }),
  ),
);

export const BudgetThreshold = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Budget thresholds must be whole percentages." }),
    Schema.isGreaterThanOrEqualTo(1, {
      message: "Budget thresholds must be at least 1.",
    }),
    Schema.isLessThanOrEqualTo(100, {
      message: "Budget thresholds must not exceed 100.",
    }),
  ),
);

export const BudgetThresholds = Schema.Array(BudgetThreshold).pipe(
  Schema.check(
    Schema.isMinLength(1, { message: "Budget thresholds must not be empty." }),
    Schema.isMaxLength(MAX_BUDGET_THRESHOLDS, {
      message: `Budgets must not carry more than ${MAX_BUDGET_THRESHOLDS} thresholds.`,
    }),
    Schema.makeFilter<readonly number[]>((input) =>
      input.every((value, index) => index === 0 || value > (input[index - 1] ?? 0))
        ? undefined
        : "Budget thresholds must be strictly ascending.",
    ),
  ),
);

const budgetVersion = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(1, {
      message: "Budget versions must start at 1.",
    }),
  ),
);

export const BudgetResponse = Schema.Struct({
  amountUsdMicros: BudgetAmountUsdMicros,
  archivedAt: Schema.optional(Timestamp),
  createdAt: Timestamp,
  environmentId: Schema.optional(PublicId),
  id: PublicId,
  name: ResourceName,
  organizationId: PublicId,
  period: BudgetPeriod,
  projectId: Schema.optional(PublicId),
  scope: BudgetScope,
  status: BudgetStatus,
  thresholds: BudgetThresholds,
  updatedAt: Timestamp,
  version: budgetVersion,
  workspaceId: Schema.optional(PublicId),
});

export const ListBudgetsResponse = Schema.Struct({
  items: Schema.Array(BudgetResponse),
  nextCursor: Schema.optional(Cursor),
});

/**
 * `project` budgets name `projectId`; `environment` budgets name `environmentId` (and may repeat
 * its `projectId`); `workspace` budgets name `workspaceId` and the `environmentId` it lives in
 * (and may repeat its `projectId`); `organization` budgets name none of them.
 */
export const CreateBudgetRequest = Schema.Struct({
  amountUsdMicros: BudgetAmountUsdMicros,
  environmentId: Schema.optional(PublicId),
  name: ResourceName,
  period: BudgetPeriod,
  projectId: Schema.optional(PublicId),
  scope: BudgetScope,
  thresholds: Schema.optional(BudgetThresholds),
  workspaceId: Schema.optional(PublicId),
});

export const UpdateBudgetRequest = Schema.Struct({
  amountUsdMicros: Schema.optional(BudgetAmountUsdMicros),
  name: Schema.optional(ResourceName),
  status: Schema.optional(Schema.Literals(["active", "paused"])),
  thresholds: Schema.optional(BudgetThresholds),
}).pipe(
  Schema.check(
    Schema.isMinProperties(1, {
      message: "Budget updates must change at least one property.",
    }),
  ),
);

export const BudgetPeriodResponse = Schema.Struct({
  amountUsdMicros: BudgetAmountUsdMicros,
  budgetId: PublicId,
  current: Schema.Boolean,
  exhausted: Schema.Boolean,
  notifiedThresholds: Schema.Array(BudgetThreshold),
  period: BudgetPeriod,
  periodEnd: Timestamp,
  periodStart: Timestamp,
  spendUsdMicros: UsdMicros,
});

export const ListBudgetPeriodsResponse = Schema.Struct({
  items: Schema.Array(BudgetPeriodResponse),
  nextCursor: Schema.optional(Cursor),
});

export const BUDGET_API_SCHEMAS = {
  BudgetPeriodResponse,
  BudgetResponse,
  CreateBudgetRequest,
  ListBudgetPeriodsResponse,
  ListBudgetsResponse,
  UpdateBudgetRequest,
} as const;

const budgetReadErrors = [400, 401, 403, 404, 422] as const;
const budgetMutationErrors = [400, 401, 403, 404, 409, 422, 429] as const;
const cursor = {
  name: "cursor",
  schema: { maxLength: 4_096, minLength: 1, type: "string" },
} as const;

function limit(maximum: number) {
  return {
    name: "limit",
    schema: { maximum, minimum: 1, type: "integer" },
  } as const;
}

export const BUDGET_API_ROUTES = [
  {
    authentication: "platform-bearer",
    errors: budgetReadErrors,
    idempotency: "none",
    method: "GET",
    name: "listBudgets",
    path: "/v1/budgets",
    queryParameters: [cursor, limit(100)],
    requiredAuthorization: "budgets:read",
    responseBody: "ListBudgetsResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Budgets",
  },
  {
    authentication: "platform-bearer",
    errors: budgetMutationErrors,
    idempotency: "required",
    method: "POST",
    name: "createBudget",
    path: "/v1/budgets",
    requestBody: "CreateBudgetRequest",
    requiredAuthorization: "budgets:write",
    responseBody: "BudgetResponse",
    scopeHeaders: "organization",
    successStatus: 201,
    tag: "Budgets",
  },
  {
    authentication: "platform-bearer",
    errors: budgetReadErrors,
    idempotency: "none",
    method: "GET",
    name: "getBudget",
    path: "/v1/budgets/:id",
    requiredAuthorization: "budgets:read",
    responseBody: "BudgetResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Budgets",
  },
  {
    authentication: "platform-bearer",
    errors: budgetMutationErrors,
    idempotency: "required",
    method: "PATCH",
    name: "updateBudget",
    path: "/v1/budgets/:id",
    requestBody: "UpdateBudgetRequest",
    requiredAuthorization: "budgets:write",
    responseBody: "BudgetResponse",
    scopeHeaders: "organization",
    standing: "remediation",
    successStatus: 200,
    tag: "Budgets",
  },
  {
    authentication: "platform-bearer",
    errors: budgetMutationErrors,
    idempotency: "required",
    method: "DELETE",
    name: "archiveBudget",
    path: "/v1/budgets/:id",
    requiredAuthorization: "budgets:write",
    responseBody: "BudgetResponse",
    scopeHeaders: "organization",
    standing: "remediation",
    successStatus: 200,
    tag: "Budgets",
  },
  {
    authentication: "platform-bearer",
    errors: budgetReadErrors,
    idempotency: "none",
    method: "GET",
    name: "listBudgetPeriods",
    path: "/v1/budgets/:id/periods",
    queryParameters: [cursor, limit(MAX_BUDGET_PERIODS_PAGE_LIMIT)],
    requiredAuthorization: "budgets:read",
    responseBody: "ListBudgetPeriodsResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Budgets",
  },
] as const satisfies readonly PublicApiRouteContract[];

export type BudgetApiRouteName = (typeof BUDGET_API_ROUTES)[number]["name"];
