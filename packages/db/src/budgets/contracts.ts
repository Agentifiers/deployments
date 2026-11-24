import type { Ulid } from "../ids.ts";
import type {
  BUDGET_PERIODS,
  BUDGET_STATUSES,
  BudgetPeriodRecord,
  BudgetRecord,
} from "../records/usage.ts";
import type { ScopeTarget } from "../usage-scope.ts";

export type BudgetRecordValue = typeof BudgetRecord.Type;
export type BudgetPeriodRecordValue = typeof BudgetPeriodRecord.Type;
export type BudgetPeriodKind = (typeof BUDGET_PERIODS)[number];
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

/** Default alert thresholds, in percent of the budget amount. */
export const DEFAULT_BUDGET_THRESHOLDS = [50, 80, 100] as const;
/** Non-archived budgets one organization, project, environment, or workspace may carry. */
export const MAX_BUDGETS_PER_SCOPE = 25;
/** Period summaries returned per `listPeriods` page. */
export const MAX_BUDGET_PERIOD_PAGE_SIZE = 24;
/** Semantic event emitted once per budget period for each crossed threshold. */
export const BUDGET_THRESHOLD_CROSSED_EVENT = "budget.threshold-crossed";

export interface BudgetActor {
  readonly id?: Ulid;
  readonly type: "principal" | "service-account" | "system";
}

export interface CreateBudgetInput {
  readonly actor?: BudgetActor;
  readonly amountUsdMicros: number;
  readonly name: string;
  readonly organizationId: Ulid;
  readonly period: BudgetPeriodKind;
  /** The single scope the budget governs. */
  readonly target: ScopeTarget;
  /** Strictly ascending whole percentages from 1 to 100; defaults to 50/80/100. */
  readonly thresholds?: readonly number[];
}

export interface UpdateBudgetInput {
  readonly actor?: BudgetActor;
  readonly amountUsdMicros?: number;
  readonly budgetId: Ulid;
  readonly name?: string;
  readonly organizationId: Ulid;
  /** Pause or resume enforcement and alerts; archiving uses `archive`. */
  readonly status?: "active" | "paused";
  readonly thresholds?: readonly number[];
}

export interface ArchiveBudgetInput {
  readonly actor?: BudgetActor;
  readonly budgetId: Ulid;
  readonly organizationId: Ulid;
}

export interface ListBudgetsInput {
  readonly cursor?: string;
  readonly limit: number;
  readonly organizationId: Ulid;
}

export interface BudgetPage {
  readonly items: readonly BudgetRecordValue[];
  readonly nextCursor?: string;
}

export interface ListBudgetPeriodsInput {
  readonly budgetId: Ulid;
  readonly cursor?: string;
  readonly limit: number;
  readonly organizationId: Ulid;
}

/** One budget period with its spend read from the usage ledger's scope spend counters. */
export interface BudgetPeriodSummary {
  readonly amountUsdMicros: number;
  readonly budgetId: Ulid;
  readonly current: boolean;
  readonly exhausted: boolean;
  readonly notifiedThresholds: readonly number[];
  readonly period: BudgetPeriodKind;
  readonly periodEnd: string;
  readonly periodStart: string;
  readonly spendUsdMicros: number;
}

export interface BudgetPeriodPage {
  readonly items: readonly BudgetPeriodSummary[];
  readonly nextCursor?: string;
}

/**
 * Budget CRUD and period history. Mutations write the budget and its `budget.created`,
 * `budget.updated`, or `budget.archived` semantic event in one transaction. Errors are
 * `PersistenceError`s: `budget_not_found` (not-found), `budget_archived` and
 * `budget_limit_exceeded` (conflict), `invalid_budget` (invalid-input), `invalid_cursor`
 * (invalid-input), and `version_conflict` (conflict).
 */
export interface BudgetPersistence {
  readonly archive: (input: ArchiveBudgetInput) => Promise<BudgetRecordValue>;
  readonly create: (input: CreateBudgetInput) => Promise<BudgetRecordValue>;
  readonly get: (organizationId: Ulid, budgetId: Ulid) => Promise<BudgetRecordValue>;
  /** Newest-created first, all scopes and statuses in the organization. */
  readonly list: (input: ListBudgetsInput) => Promise<BudgetPage>;
  /** Current period first, back to the period the budget was created in. */
  readonly listPeriods: (input: ListBudgetPeriodsInput) => Promise<BudgetPeriodPage>;
  readonly update: (input: UpdateBudgetInput) => Promise<BudgetRecordValue>;
}

/** An active budget whose current-period spend has reached its amount. */
export interface BudgetExhaustion {
  readonly budget: BudgetRecordValue;
  readonly periodEnd: string;
  readonly periodStart: string;
  readonly spendUsdMicros: number;
}
