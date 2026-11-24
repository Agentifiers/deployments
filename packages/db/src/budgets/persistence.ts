import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { BudgetRecord } from "../records/usage.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { scopeTargetOfRecord } from "../usage-scope.ts";
import {
  DEFAULT_BUDGET_THRESHOLDS,
  MAX_BUDGET_PERIOD_PAGE_SIZE,
  MAX_BUDGETS_PER_SCOPE,
  type BudgetActor,
  type BudgetPeriodSummary,
  type BudgetPersistence,
  type BudgetRecordValue,
} from "./contracts.ts";
import { budgetPeriodBounds, previousBudgetPeriod } from "./periods.ts";
import { budgetsGoverning, readBudgetSpend } from "./spend.ts";
import { loadBudgetPeriod } from "./thresholds.ts";

const MAX_BUDGET_NAME_LENGTH = 120;
const BUDGET_PREFIX = `${key("BUDGET")}#`;

export interface BudgetPersistenceDependencies {
  readonly database: DynamoDatabaseService;
  readonly generateId?: () => Promise<Ulid>;
  readonly now?: () => Date;
}

function invalid(message: string) {
  return new PersistenceError("invalid-input", "invalid_budget", message);
}

function invalidCursor() {
  return new PersistenceError("invalid-input", "invalid_cursor", "The cursor is invalid.");
}

function budgetName(value: string) {
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_BUDGET_NAME_LENGTH) {
    throw invalid(`Budget names must be 1 to ${MAX_BUDGET_NAME_LENGTH} characters.`);
  }
  return name;
}

function decodeBudget(value: unknown) {
  try {
    return Schema.decodeUnknownSync(BudgetRecord)(value);
  } catch (cause) {
    throw invalid(cause instanceof Error ? cause.message : "The budget is invalid.");
  }
}

function eventPayload(budget: BudgetRecordValue, changed?: readonly string[]) {
  return {
    ...scopeTargetOfRecord(budget),
    amountUsdMicros: budget.data.amountUsdMicros,
    budgetId: budget.data.id,
    ...(changed ? { changed: [...changed] } : {}),
    name: budget.data.name,
    period: budget.data.period,
    status: budget.data.status,
    thresholds: [...budget.data.thresholds],
  };
}

function encodeListCursor(organizationId: Ulid, lastKey: Readonly<Record<string, unknown>>) {
  return Buffer.from(JSON.stringify({ organizationId, sk: lastKey.sk, v: 1 })).toString(
    "base64url",
  );
}

function decodeListCursor(organizationId: Ulid, cursor: string) {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      readonly organizationId?: unknown;
      readonly sk?: unknown;
      readonly v?: unknown;
    };
    if (
      decoded.v !== 1 ||
      decoded.organizationId !== organizationId ||
      typeof decoded.sk !== "string" ||
      !decoded.sk.startsWith(BUDGET_PREFIX)
    ) {
      throw invalidCursor();
    }
    return { pk: key("ORG", organizationId), sk: decoded.sk };
  } catch {
    throw invalidCursor();
  }
}

function encodePeriodCursor(budgetId: Ulid, periodStart: string) {
  return Buffer.from(JSON.stringify({ budgetId, periodStart, v: 1 })).toString("base64url");
}

function decodePeriodCursor(budget: BudgetRecordValue, cursor: string) {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      readonly budgetId?: unknown;
      readonly periodStart?: unknown;
      readonly v?: unknown;
    };
    if (
      decoded.v !== 1 ||
      decoded.budgetId !== budget.data.id ||
      typeof decoded.periodStart !== "string" ||
      budgetPeriodBounds(budget.data.period, decoded.periodStart).periodStart !==
        decoded.periodStart
    ) {
      throw invalidCursor();
    }
    return decoded.periodStart;
  } catch {
    throw invalidCursor();
  }
}

export function makeBudgetPersistence(
  dependencies: BudgetPersistenceDependencies,
): BudgetPersistence {
  const { database } = dependencies;
  const ids = makeIdGenerator();
  const generateId = dependencies.generateId ?? (async () => ids.generate());
  const now = dependencies.now ?? (() => new Date());

  async function load(organizationId: Ulid, budgetId: Ulid) {
    const stored = await database.getRecord(
      "usage",
      { pk: key("ORG", organizationId), sk: key("BUDGET", budgetId) },
      true,
    );
    if (stored?.itemType !== "budget" || stored.data.organizationId !== organizationId) {
      throw new PersistenceError("not-found", "budget_not_found", "Budget was not found.");
    }
    return stored;
  }

  async function commit(
    budget: BudgetRecordValue,
    previous: BudgetRecordValue | undefined,
    eventType: string,
    actor: BudgetActor | undefined,
    changed?: readonly string[],
  ) {
    const event = makeSemanticEventRecord({
      actor: actor ?? { type: "system" },
      aggregateId: budget.data.id,
      aggregateType: "budget",
      aggregateVersion: budget.data.version,
      ...(budget.data.environmentId ? { environmentId: budget.data.environmentId } : {}),
      eventId: await generateId(),
      eventType,
      occurredAt: budget.data.updatedAt,
      organizationId: budget.data.organizationId,
      payload: eventPayload(budget, changed),
      ...(budget.data.projectId ? { projectId: budget.data.projectId } : {}),
    });
    try {
      await transactWithSemanticEvents(
        database,
        [{ kind: "put", ...(previous ? { previousRecord: previous } : {}), record: budget }],
        [event],
      );
    } catch (cause) {
      if (isDatabaseWriteConflict(cause)) {
        throw new PersistenceError(
          "conflict",
          "version_conflict",
          "The budget changed concurrently; retry the request.",
        );
      }
      throw cause;
    }
    return budget;
  }

  return {
    async create(input) {
      const [active, paused] = await Promise.all([
        budgetsGoverning(database, input.organizationId, input.target, "active"),
        budgetsGoverning(database, input.organizationId, input.target, "paused"),
      ]);
      if (active.length + paused.length >= MAX_BUDGETS_PER_SCOPE) {
        throw new PersistenceError(
          "conflict",
          "budget_limit_exceeded",
          `A ${input.target.scope} may carry at most ${MAX_BUDGETS_PER_SCOPE} active or paused budgets; archive one first.`,
        );
      }
      const timestamp = now().toISOString();
      const budget = decodeBudget(
        withCanonicalRecordKeys({
          data: {
            ...input.target,
            amountUsdMicros: input.amountUsdMicros,
            createdAt: timestamp,
            id: await generateId(),
            name: budgetName(input.name),
            organizationId: input.organizationId,
            period: input.period,
            status: "active",
            thresholds: [...(input.thresholds ?? DEFAULT_BUDGET_THRESHOLDS)],
            updatedAt: timestamp,
            version: 1,
          },
          itemType: "budget" as const,
        }),
      );
      return commit(budget, undefined, "budget.created", input.actor);
    },

    get: load,

    async list(input) {
      const page = await database.queryRecords("usage", {
        ConsistentRead: true,
        ...(input.cursor
          ? { ExclusiveStartKey: decodeListCursor(input.organizationId, input.cursor) }
          : {}),
        ExpressionAttributeNames: { "#partition": "pk", "#sort": "sk" },
        ExpressionAttributeValues: {
          ":partition": key("ORG", input.organizationId),
          ":prefix": BUDGET_PREFIX,
        },
        KeyConditionExpression: "#partition = :partition AND begins_with(#sort, :prefix)",
        Limit: input.limit,
        ScanIndexForward: false,
      });
      const items = page.items.map((item) => {
        if (item.itemType !== "budget") {
          throw new TypeError("Budget partition contains an unexpected record.");
        }
        return item;
      });
      return {
        items,
        ...(page.lastEvaluatedKey
          ? { nextCursor: encodeListCursor(input.organizationId, page.lastEvaluatedKey) }
          : {}),
      };
    },

    async listPeriods(input) {
      const budget = await load(input.organizationId, input.budgetId);
      const limit = Math.min(Math.max(input.limit, 1), MAX_BUDGET_PERIOD_PAGE_SIZE);
      const instant = now();
      const currentStart = budgetPeriodBounds(budget.data.period, instant).periodStart;
      const lastActive = budget.data.archivedAt ? new Date(budget.data.archivedAt) : instant;
      const firstStart = budgetPeriodBounds(budget.data.period, budget.data.createdAt).periodStart;
      let bounds = input.cursor
        ? budgetPeriodBounds(budget.data.period, decodePeriodCursor(budget, input.cursor))
        : budgetPeriodBounds(budget.data.period, lastActive);
      const pending: (typeof bounds)[] = [];
      while (pending.length < limit && bounds.periodStart >= firstStart) {
        pending.push(bounds);
        bounds = previousBudgetPeriod(budget.data.period, bounds.periodStart);
      }
      const items = await Promise.all(
        pending.map(async (period): Promise<BudgetPeriodSummary> => {
          const [spendUsdMicros, stored] = await Promise.all([
            readBudgetSpend(database, budget, period.periodStart),
            loadBudgetPeriod(database, budget, period.periodStart),
          ]);
          return {
            amountUsdMicros: budget.data.amountUsdMicros,
            budgetId: budget.data.id,
            current: period.periodStart === currentStart,
            exhausted: spendUsdMicros >= budget.data.amountUsdMicros,
            notifiedThresholds: [...(stored?.data.notifiedThresholds ?? [])],
            period: budget.data.period,
            periodEnd: period.periodEnd,
            periodStart: period.periodStart,
            spendUsdMicros,
          };
        }),
      );
      return {
        items,
        ...(pending.length === limit && bounds.periodStart >= firstStart
          ? { nextCursor: encodePeriodCursor(budget.data.id, bounds.periodStart) }
          : {}),
      };
    },

    async update(input) {
      const previous = await load(input.organizationId, input.budgetId);
      if (previous.data.status === "archived") {
        throw new PersistenceError(
          "conflict",
          "budget_archived",
          "Archived budgets are immutable.",
        );
      }
      const patch = {
        ...(input.amountUsdMicros === undefined ? {} : { amountUsdMicros: input.amountUsdMicros }),
        ...(input.name === undefined ? {} : { name: budgetName(input.name) }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.thresholds === undefined ? {} : { thresholds: [...input.thresholds] }),
      };
      const changed = Object.entries(patch)
        .filter(
          ([field, value]) =>
            JSON.stringify(value) !==
            JSON.stringify(previous.data[field as keyof typeof previous.data]),
        )
        .map(([field]) => field)
        .toSorted();
      if (changed.length === 0) return previous;
      const budget = decodeBudget(
        withCanonicalRecordKeys({
          data: {
            ...previous.data,
            ...patch,
            updatedAt: now().toISOString(),
            version: previous.data.version + 1,
          },
          itemType: "budget" as const,
        }),
      );
      return commit(budget, previous, "budget.updated", input.actor, changed);
    },

    async archive(input) {
      const previous = await load(input.organizationId, input.budgetId);
      if (previous.data.status === "archived") return previous;
      const timestamp = now().toISOString();
      const budget = decodeBudget(
        withCanonicalRecordKeys({
          data: {
            ...previous.data,
            archivedAt: timestamp,
            status: "archived",
            updatedAt: timestamp,
            version: previous.data.version + 1,
          },
          itemType: "budget" as const,
        }),
      );
      return commit(budget, previous, "budget.archived", input.actor);
    },
  };
}
