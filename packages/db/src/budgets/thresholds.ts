import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { BudgetPeriodRecord } from "../records/usage.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { scopeTargetOfRecord, type UsageScope } from "../usage-scope.ts";
import {
  BUDGET_THRESHOLD_CROSSED_EVENT,
  type BudgetPeriodRecordValue,
  type BudgetRecordValue,
} from "./contracts.ts";
import { budgetPeriodBounds, type BudgetPeriodBounds } from "./periods.ts";
import { activeBudgetsForScope, readBudgetSpend } from "./spend.ts";

const MAX_CONFLICT_RETRIES = 8;

export interface BudgetThresholdCrossing {
  readonly budgetId: Ulid;
  readonly eventId: Ulid;
  readonly periodStart: string;
  readonly spendUsdMicros: number;
  readonly threshold: number;
}

export interface EvaluateBudgetThresholdsOptions {
  readonly generateId?: () => Promise<Ulid>;
  readonly now?: () => Date;
}

/** Whether `spend` has reached `threshold` percent of `amount`, without floating point. */
function budgetThresholdReached(spend: number, amount: number, threshold: number) {
  return BigInt(spend) * 100n >= BigInt(amount) * BigInt(threshold);
}

export async function loadBudgetPeriod(
  database: DynamoDatabaseService,
  budget: BudgetRecordValue,
  periodStart: string,
): Promise<BudgetPeriodRecordValue | undefined> {
  const stored = await database.getRecord(
    "usage",
    {
      pk: key("ORG", budget.data.organizationId, "BUDGET", budget.data.id),
      sk: key("BUDGET-PERIOD", periodStart),
    },
    true,
  );
  if (!stored) return undefined;
  if (stored.itemType !== "budget-period") {
    throw new TypeError("Budget period key resolved to an unexpected record.");
  }
  return stored;
}

function nextBudgetPeriod(input: {
  readonly bounds: BudgetPeriodBounds;
  readonly budget: BudgetRecordValue;
  readonly id: Ulid;
  readonly previous: BudgetPeriodRecordValue | undefined;
  readonly threshold: number;
  readonly timestamp: string;
}): BudgetPeriodRecordValue {
  const { budget, previous } = input;
  const { scope: _scope, ...scopeIds } = scopeTargetOfRecord(budget);
  return Schema.decodeUnknownSync(BudgetPeriodRecord)(
    withCanonicalRecordKeys({
      data: {
        ...scopeIds,
        budgetId: budget.data.id,
        createdAt: previous?.data.createdAt ?? input.timestamp,
        id: previous?.data.id ?? input.id,
        notifiedThresholds: [
          ...(previous?.data.notifiedThresholds ?? []),
          input.threshold,
        ].toSorted((left, right) => left - right),
        organizationId: budget.data.organizationId,
        period: budget.data.period,
        periodEnd: input.bounds.periodEnd,
        periodStart: input.bounds.periodStart,
        updatedAt: input.timestamp,
        version: previous ? previous.data.version + 1 : 1,
      },
      itemType: "budget-period" as const,
    }),
  );
}

/**
 * Records each newly reached threshold of one budget's period with exactly one
 * `budget.threshold-crossed` event. The period record's version guards every notification, so
 * concurrent evaluators race on one conditional write; the loser re-reads and finds the threshold
 * already notified.
 */
async function evaluateBudget(
  database: DynamoDatabaseService,
  budget: BudgetRecordValue,
  occurredAt: string,
  generateId: () => Promise<Ulid>,
  now: () => Date,
): Promise<readonly BudgetThresholdCrossing[]> {
  const bounds = budgetPeriodBounds(budget.data.period, occurredAt);
  const crossings: BudgetThresholdCrossing[] = [];
  let conflicts = 0;
  for (;;) {
    const [spendUsdMicros, previous] = await Promise.all([
      readBudgetSpend(database, budget, bounds.periodStart),
      loadBudgetPeriod(database, budget, bounds.periodStart),
    ]);
    const notified = previous?.data.notifiedThresholds ?? [];
    const threshold = budget.data.thresholds.find(
      (candidate) =>
        !notified.includes(candidate) &&
        budgetThresholdReached(spendUsdMicros, budget.data.amountUsdMicros, candidate),
    );
    if (threshold === undefined) return crossings;
    const timestamp = now().toISOString();
    const [periodId, eventId] = await Promise.all([generateId(), generateId()]);
    const period = nextBudgetPeriod({
      bounds,
      budget,
      id: periodId,
      previous,
      threshold,
      timestamp,
    });
    const event = makeSemanticEventRecord({
      actor: { type: "system" },
      aggregateId: period.data.id,
      aggregateType: "budget-period",
      aggregateVersion: period.data.version,
      ...(budget.data.environmentId ? { environmentId: budget.data.environmentId } : {}),
      eventId,
      eventType: BUDGET_THRESHOLD_CROSSED_EVENT,
      occurredAt: timestamp,
      organizationId: budget.data.organizationId,
      payload: {
        ...scopeTargetOfRecord(budget),
        amountUsdMicros: budget.data.amountUsdMicros,
        budgetId: budget.data.id,
        budgetName: budget.data.name,
        percentUsed: Number((BigInt(spendUsdMicros) * 100n) / BigInt(budget.data.amountUsdMicros)),
        period: budget.data.period,
        periodEnd: bounds.periodEnd,
        periodStart: bounds.periodStart,
        spendUsdMicros,
        threshold,
      },
      ...(budget.data.projectId ? { projectId: budget.data.projectId } : {}),
    });
    try {
      await transactWithSemanticEvents(
        database,
        [{ kind: "put", ...(previous ? { previousRecord: previous } : {}), record: period }],
        [event],
      );
      crossings.push({
        budgetId: budget.data.id,
        eventId,
        periodStart: bounds.periodStart,
        spendUsdMicros,
        threshold,
      });
    } catch (cause) {
      if (!isDatabaseWriteConflict(cause) || (conflicts += 1) >= MAX_CONFLICT_RETRIES) throw cause;
    }
  }
}

/**
 * Evaluates every active budget that governs a cost's workspace, environment, project, or
 * organization for the period containing the cost, emitting one event per newly reached threshold.
 * Idempotent: re-running after a partial failure only emits the thresholds not yet recorded.
 */
export async function evaluateBudgetThresholds(
  database: DynamoDatabaseService,
  input: { readonly occurredAt: string; readonly scope: UsageScope },
  options: EvaluateBudgetThresholdsOptions = {},
): Promise<readonly BudgetThresholdCrossing[]> {
  const ids = makeIdGenerator();
  const generateId = options.generateId ?? (async () => ids.generate());
  const now = options.now ?? (() => new Date());
  const budgets = await activeBudgetsForScope(database, input.scope);
  const results = await Promise.all(
    budgets.map((budget) => evaluateBudget(database, budget, input.occurredAt, generateId, now)),
  );
  return results.flat();
}
