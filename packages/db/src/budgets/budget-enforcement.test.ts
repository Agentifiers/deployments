import { describe, expect, test } from "bun:test";
import type { PlatformRecord } from "../records/index.ts";
import { makeTenancyTestDatabase } from "../tenancy-test-support.ts";
import { findExhaustedBudget } from "./admission.ts";
import {
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  OTHER_ENVIRONMENT_ID,
  OTHER_WORKSPACE_ID,
  PROJECT_ID,
  RUN_SCOPE,
  WORKSPACE_ID,
  WORKSPACE_RUN_SCOPE,
  budgetRecord,
  recordSpend,
  seed,
  testId,
} from "./budget-test-support.ts";
import { BUDGET_THRESHOLD_CROSSED_EVENT } from "./contracts.ts";
import { budgetPeriodBounds, previousBudgetPeriod } from "./periods.ts";
import { evaluateBudgetThresholds } from "./thresholds.ts";

const JANUARY = "2026-01-15T12:00:00.000Z";

function thresholdEvents(records: ReadonlyMap<string, PlatformRecord>) {
  return [...records.values()].flatMap((record) =>
    record.itemType === "semantic-event" && record.data.eventType === BUDGET_THRESHOLD_CROSSED_EVENT
      ? [record.data]
      : [],
  );
}

describe("budget periods", () => {
  test("align every period kind to UTC boundaries with exclusive ends", () => {
    expect(budgetPeriodBounds("daily", "2026-12-31T23:59:59.999Z")).toEqual({
      periodEnd: "2027-01-01T00:00:00.000Z",
      periodStart: "2026-12-31T00:00:00.000Z",
    });
    expect(budgetPeriodBounds("monthly", "2026-02-28T23:00:00.000Z")).toEqual({
      periodEnd: "2026-03-01T00:00:00.000Z",
      periodStart: "2026-02-01T00:00:00.000Z",
    });
    expect(budgetPeriodBounds("quarterly", "2026-08-31T10:00:00.000Z")).toEqual({
      periodEnd: "2026-10-01T00:00:00.000Z",
      periodStart: "2026-07-01T00:00:00.000Z",
    });
    expect(budgetPeriodBounds("yearly", "2026-10-02T00:00:00.000Z")).toEqual({
      periodEnd: "2027-01-01T00:00:00.000Z",
      periodStart: "2026-01-01T00:00:00.000Z",
    });
    expect(budgetPeriodBounds("monthly", "2027-01-01T00:00:00.000Z").periodStart).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    expect(previousBudgetPeriod("quarterly", "2026-01-01T00:00:00.000Z")).toEqual({
      periodEnd: "2026-01-01T00:00:00.000Z",
      periodStart: "2025-10-01T00:00:00.000Z",
    });
  });
});

describe("run admission", () => {
  for (const scope of ["environment", "project", "organization"] as const) {
    test(`refuses at 100% of an active ${scope} budget and admits below it`, async () => {
      const { database } = makeTenancyTestDatabase();
      await seed(database, [budgetRecord({ scope })]);
      await recordSpend(database, { occurredAt: JANUARY, spendUsdMicros: 999_999 });

      expect(await findExhaustedBudget(database, RUN_SCOPE, new Date(JANUARY))).toBeUndefined();

      await recordSpend(database, { occurredAt: JANUARY, shard: 7, spendUsdMicros: 1 });
      const exhausted = await findExhaustedBudget(database, RUN_SCOPE, new Date(JANUARY));
      expect(exhausted).toMatchObject({
        budget: { data: { id: "01J000000000000000000BDG01", scope } },
        periodEnd: "2026-02-01T00:00:00.000Z",
        periodStart: "2026-01-01T00:00:00.000Z",
        spendUsdMicros: 1_000_000,
      });
    });
  }

  test("never refuses for paused or archived budgets", async () => {
    const { database } = makeTenancyTestDatabase();
    await seed(database, [
      budgetRecord({ scope: "organization", status: "paused" }),
      budgetRecord({
        archivedAt: "2026-01-02T00:00:00.000Z",
        id: "01J000000000000000000BDG02",
        scope: "environment",
        status: "archived",
      }),
    ]);
    await recordSpend(database, { occurredAt: JANUARY, spendUsdMicros: 5_000_000 });

    expect(await findExhaustedBudget(database, RUN_SCOPE, new Date(JANUARY))).toBeUndefined();
  });

  test("counts sibling environments toward project and organization budgets only", async () => {
    const { database } = makeTenancyTestDatabase();
    await seed(database, [budgetRecord({ scope: "environment" })]);
    await recordSpend(database, {
      occurredAt: JANUARY,
      scope: { ...RUN_SCOPE, environmentId: OTHER_ENVIRONMENT_ID },
      spendUsdMicros: 2_000_000,
    });
    expect(await findExhaustedBudget(database, RUN_SCOPE, new Date(JANUARY))).toBeUndefined();

    await seed(database, [budgetRecord({ id: "01J000000000000000000BDG03", scope: "project" })]);
    expect(
      (await findExhaustedBudget(database, RUN_SCOPE, new Date(JANUARY)))?.budget.data.scope,
    ).toBe("project");
  });

  test("refuses a workspace's runs at its own budget and admits its siblings", async () => {
    const { database } = makeTenancyTestDatabase();
    await seed(database, [
      budgetRecord({ amountUsdMicros: 1_000_000, scope: "workspace" }),
      budgetRecord({
        amountUsdMicros: 3_000_000,
        id: "01J000000000000000000BDG06",
        scope: "environment",
      }),
    ]);
    const siblingScope = { ...RUN_SCOPE, workspaceId: OTHER_WORKSPACE_ID };
    await recordSpend(database, {
      occurredAt: JANUARY,
      scope: siblingScope,
      spendUsdMicros: 999_999,
    });
    expect(
      await findExhaustedBudget(database, WORKSPACE_RUN_SCOPE, new Date(JANUARY)),
    ).toBeUndefined();

    await recordSpend(database, {
      occurredAt: JANUARY,
      scope: WORKSPACE_RUN_SCOPE,
      spendUsdMicros: 1_000_000,
    });
    expect(
      await findExhaustedBudget(database, WORKSPACE_RUN_SCOPE, new Date(JANUARY)),
    ).toMatchObject({
      budget: { data: { scope: "workspace", workspaceId: WORKSPACE_ID } },
      spendUsdMicros: 1_000_000,
    });
    expect(await findExhaustedBudget(database, siblingScope, new Date(JANUARY))).toBeUndefined();
    expect(await findExhaustedBudget(database, RUN_SCOPE, new Date(JANUARY))).toBeUndefined();

    await recordSpend(database, { occurredAt: JANUARY, spendUsdMicros: 1_000_001 });
    expect(
      (await findExhaustedBudget(database, siblingScope, new Date(JANUARY)))?.budget.data.scope,
    ).toBe("environment");
  });

  test("rolls over at the UTC period boundary", async () => {
    const { database } = makeTenancyTestDatabase();
    await seed(database, [
      budgetRecord({ scope: "organization" }),
      budgetRecord({ id: "01J000000000000000000BDG04", period: "daily", scope: "project" }),
    ]);
    await recordSpend(database, {
      occurredAt: "2026-01-31T23:59:59.999Z",
      spendUsdMicros: 1_000_000,
    });

    expect(
      (await findExhaustedBudget(database, RUN_SCOPE, new Date("2026-01-31T23:59:59.999Z")))?.budget
        .data.period,
    ).toBeDefined();
    expect(
      await findExhaustedBudget(database, RUN_SCOPE, new Date("2026-02-01T00:00:00.000Z")),
    ).toBeUndefined();
  });
});

describe("threshold events", () => {
  test("emits one event per crossed threshold and is idempotent on re-evaluation", async () => {
    const { database, records } = makeTenancyTestDatabase();
    await seed(database, [budgetRecord({ scope: "environment" })]);
    const evaluate = () =>
      evaluateBudgetThresholds(
        database,
        { occurredAt: JANUARY, scope: RUN_SCOPE },
        { generateId: testId, now: () => new Date(JANUARY) },
      );

    await recordSpend(database, { occurredAt: JANUARY, spendUsdMicros: 499_999 });
    expect(await evaluate()).toEqual([]);
    await recordSpend(database, { occurredAt: JANUARY, spendUsdMicros: 1 });
    expect((await evaluate()).map((crossing) => crossing.threshold)).toEqual([50]);
    expect(await evaluate()).toEqual([]);

    // One cost can jump several thresholds; each still gets its own event.
    await recordSpend(database, { occurredAt: JANUARY, spendUsdMicros: 600_000 });
    expect((await evaluate()).map((crossing) => crossing.threshold)).toEqual([80, 100]);

    const events = thresholdEvents(records);
    expect(events.map((event) => [event.payload.threshold, event.aggregateVersion])).toEqual([
      [50, 1],
      [80, 2],
      [100, 3],
    ]);
    expect(events[2]).toMatchObject({
      aggregateType: "budget-period",
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      payload: {
        amountUsdMicros: 1_000_000,
        budgetId: "01J000000000000000000BDG01",
        percentUsed: 110,
        period: "monthly",
        periodStart: "2026-01-01T00:00:00.000Z",
        scope: "environment",
        spendUsdMicros: 1_100_000,
      },
      projectId: PROJECT_ID,
    });
    expect(new Set(events.map((event) => event.aggregateId)).size).toBe(1);
  });

  test("emits each threshold exactly once under concurrent spend writes", async () => {
    const memory = makeTenancyTestDatabase();
    let conflicts = 0;
    const database = {
      ...memory.database,
      transactWrite: async (...args: Parameters<typeof memory.database.transactWrite>) => {
        try {
          return await memory.database.transactWrite(...args);
        } catch (error) {
          conflicts += 1;
          throw error;
        }
      },
    };
    await seed(database, [budgetRecord({ scope: "organization" })]);
    await recordSpend(database, { occurredAt: JANUARY, spendUsdMicros: 400_000 });

    // Twelve cost writers on distinct shards each evaluate right after their own write.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, shard) =>
        recordSpend(database, {
          occurredAt: JANUARY,
          shard: shard + 1,
          spendUsdMicros: 50_000,
        }).then(() =>
          evaluateBudgetThresholds(
            database,
            { occurredAt: JANUARY, scope: RUN_SCOPE },
            { generateId: testId },
          ),
        ),
      ),
    );

    expect(conflicts).toBeGreaterThan(0);
    expect(
      results
        .flat()
        .map((crossing) => crossing.threshold)
        .toSorted((left, right) => left - right),
    ).toEqual([50, 80, 100]);
    const events = thresholdEvents(memory.records);
    expect(
      events
        .map((event) => Number(event.payload.threshold))
        .toSorted((left, right) => left - right),
    ).toEqual([50, 80, 100]);
    expect(events.every((event) => event.projectId === undefined)).toBe(true);
  });

  test("alerts again in the next period and ignores paused budgets", async () => {
    const { database, records } = makeTenancyTestDatabase();
    await seed(database, [
      budgetRecord({ period: "daily", scope: "project", thresholds: [80] }),
      budgetRecord({ id: "01J000000000000000000BDG05", scope: "project", status: "paused" }),
    ]);
    for (const occurredAt of ["2026-01-15T23:00:00.000Z", "2026-01-16T01:00:00.000Z"]) {
      await recordSpend(database, { occurredAt, spendUsdMicros: 900_000 });
      await evaluateBudgetThresholds(
        database,
        { occurredAt, scope: RUN_SCOPE },
        { generateId: testId },
      );
    }

    expect(
      thresholdEvents(records).map((event) => [event.payload.budgetId, event.payload.periodStart]),
    ).toEqual([
      ["01J000000000000000000BDG01", "2026-01-15T00:00:00.000Z"],
      ["01J000000000000000000BDG01", "2026-01-16T00:00:00.000Z"],
    ]);
  });

  test("emits a workspace budget's crossing with its workspace, never for a sibling's spend", async () => {
    const { database, records } = makeTenancyTestDatabase();
    await seed(database, [budgetRecord({ scope: "workspace", thresholds: [50] })]);
    const siblingScope = { ...RUN_SCOPE, workspaceId: OTHER_WORKSPACE_ID };
    for (const scope of [siblingScope, RUN_SCOPE]) {
      await recordSpend(database, { occurredAt: JANUARY, scope, spendUsdMicros: 900_000 });
      expect(
        await evaluateBudgetThresholds(
          database,
          { occurredAt: JANUARY, scope },
          { generateId: testId },
        ),
      ).toEqual([]);
    }

    await recordSpend(database, {
      occurredAt: JANUARY,
      scope: WORKSPACE_RUN_SCOPE,
      spendUsdMicros: 500_000,
    });
    await evaluateBudgetThresholds(
      database,
      { occurredAt: JANUARY, scope: WORKSPACE_RUN_SCOPE },
      { generateId: testId },
    );

    const events = thresholdEvents(records);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      payload: {
        environmentId: ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        scope: "workspace",
        spendUsdMicros: 500_000,
        threshold: 50,
        workspaceId: WORKSPACE_ID,
      },
      projectId: PROJECT_ID,
    });
    const period = [...records.values()].find((record) => record.itemType === "budget-period");
    expect(period?.data).toMatchObject({ workspaceId: WORKSPACE_ID });
  });
});
