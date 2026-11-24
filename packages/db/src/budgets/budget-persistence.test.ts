import { describe, expect, test } from "bun:test";
import { PersistenceError } from "../persistence-types.ts";
import type { PlatformRecord } from "../records/index.ts";
import { makeTenancyTestDatabase } from "../tenancy-test-support.ts";
import {
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  PROJECT_ID,
  RUN_SCOPE,
  WORKSPACE_ID,
  recordSpend,
  testId,
} from "./budget-test-support.ts";
import { MAX_BUDGETS_PER_SCOPE } from "./contracts.ts";
import { makeBudgetPersistence } from "./persistence.ts";
import { evaluateBudgetThresholds } from "./thresholds.ts";

const ACTOR = { id: "01J00000000000000000000ACT" as never, type: "principal" as const };

function setup(now = "2026-03-10T00:00:00.000Z") {
  const memory = makeTenancyTestDatabase();
  let clock = new Date(now);
  const budgets = makeBudgetPersistence({
    database: memory.database,
    generateId: testId,
    now: () => clock,
  });
  return {
    ...memory,
    budgets,
    setNow: (value: string) => {
      clock = new Date(value);
    },
  };
}

function budgetEvents(records: ReadonlyMap<string, PlatformRecord>) {
  return [...records.values()].flatMap((record) =>
    record.itemType === "semantic-event" && record.data.aggregateType === "budget"
      ? [[record.data.eventType, record.data.aggregateVersion, record.data.payload] as const]
      : [],
  );
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof PersistenceError) return { code: cause.code, kind: cause.kind };
    throw cause;
  }
  throw new Error("Expected a persistence error.");
}

describe("budget persistence", () => {
  test("creates, updates, pauses, and archives with one semantic event per version", async () => {
    const { budgets, records } = setup();
    const created = await budgets.create({
      actor: ACTOR,
      amountUsdMicros: 250_000_000,
      name: "  Production monthly  ",
      organizationId: ORGANIZATION_ID,
      period: "monthly",
      target: { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID, scope: "environment" },
    });
    expect(created.data).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      name: "Production monthly",
      projectId: PROJECT_ID,
      scope: "environment",
      status: "active",
      thresholds: [50, 80, 100],
      version: 1,
    });
    expect(await budgets.get(ORGANIZATION_ID, created.data.id)).toEqual(created);

    const unchanged = await budgets.update({
      budgetId: created.data.id,
      name: "Production monthly",
      organizationId: ORGANIZATION_ID,
    });
    expect(unchanged.data.version).toBe(1);

    const paused = await budgets.update({
      amountUsdMicros: 300_000_000,
      budgetId: created.data.id,
      organizationId: ORGANIZATION_ID,
      status: "paused",
      thresholds: [90],
    });
    expect(paused.data).toMatchObject({ status: "paused", thresholds: [90], version: 2 });

    const archived = await budgets.archive({
      budgetId: created.data.id,
      organizationId: ORGANIZATION_ID,
    });
    expect(archived.data).toMatchObject({ archivedAt: "2026-03-10T00:00:00.000Z", version: 3 });
    expect(
      await budgets.archive({ budgetId: created.data.id, organizationId: ORGANIZATION_ID }),
    ).toEqual(archived);
    expect(
      await rejection(
        budgets.update({ budgetId: created.data.id, name: "x", organizationId: ORGANIZATION_ID }),
      ),
    ).toEqual({ code: "budget_archived", kind: "conflict" });

    expect(budgetEvents(records).map(([type, version]) => [type, version])).toEqual([
      ["budget.created", 1],
      ["budget.updated", 2],
      ["budget.archived", 3],
    ]);
    expect(budgetEvents(records)[1]![2]).toMatchObject({
      changed: ["amountUsdMicros", "status", "thresholds"],
    });
  });

  test("creates a workspace budget whose event names the workspace and its ancestors", async () => {
    const { budgets, records } = setup();
    const created = await budgets.create({
      amountUsdMicros: 50_000_000,
      name: "Customer cap",
      organizationId: ORGANIZATION_ID,
      period: "monthly",
      target: {
        environmentId: ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        scope: "workspace",
        workspaceId: WORKSPACE_ID,
      },
    });
    expect(created).toMatchObject({
      data: { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID },
      gsi1pk: `ORG#${ORGANIZATION_ID}#BUDGET-SCOPE#WORKSPACE#${WORKSPACE_ID}`,
    });
    expect(budgetEvents(records)).toEqual([
      [
        "budget.created",
        1,
        expect.objectContaining({
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          scope: "workspace",
          workspaceId: WORKSPACE_ID,
        }),
      ],
    ]);
  });

  test("rejects invalid budgets and unknown ids", async () => {
    const { budgets } = setup();
    const base = {
      amountUsdMicros: 1,
      name: "Org",
      organizationId: ORGANIZATION_ID,
      period: "daily" as const,
      target: { scope: "organization" as const },
    };
    expect(await rejection(budgets.create({ ...base, thresholds: [80, 50] }))).toEqual({
      code: "invalid_budget",
      kind: "invalid-input",
    });
    expect(await rejection(budgets.create({ ...base, amountUsdMicros: 0 }))).toEqual({
      code: "invalid_budget",
      kind: "invalid-input",
    });
    expect(await rejection(budgets.create({ ...base, name: " " }))).toEqual({
      code: "invalid_budget",
      kind: "invalid-input",
    });
    expect(
      await rejection(budgets.get(ORGANIZATION_ID, "01J000000000000000000NNNNN" as never)),
    ).toEqual({ code: "budget_not_found", kind: "not-found" });
  });

  test("caps non-archived budgets per scope", async () => {
    const { budgets } = setup();
    const input = {
      amountUsdMicros: 1_000,
      name: "Project",
      organizationId: ORGANIZATION_ID,
      period: "monthly" as const,
      target: { projectId: PROJECT_ID, scope: "project" as const },
    };
    let last;
    for (let index = 0; index < MAX_BUDGETS_PER_SCOPE; index += 1) {
      last = await budgets.create(input);
    }
    expect(await rejection(budgets.create(input))).toEqual({
      code: "budget_limit_exceeded",
      kind: "conflict",
    });
    await budgets.archive({ budgetId: last!.data.id, organizationId: ORGANIZATION_ID });
    expect(budgets.create(input)).resolves.toBeDefined();
    // Other scopes are counted separately.
    expect(budgets.create({ ...input, target: { scope: "organization" } })).resolves.toBeDefined();
  });

  test("lists newest first across scopes with a bound cursor", async () => {
    const { budgets } = setup();
    const created = [];
    for (const target of [
      { scope: "organization" as const },
      { projectId: PROJECT_ID, scope: "project" as const },
      { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID, scope: "environment" as const },
    ]) {
      created.push(
        await budgets.create({
          amountUsdMicros: 5,
          name: target.scope,
          organizationId: ORGANIZATION_ID,
          period: "yearly",
          target,
        }),
      );
    }
    const first = await budgets.list({ limit: 2, organizationId: ORGANIZATION_ID });
    expect(first.items.map((item) => item.data.scope)).toEqual(["environment", "project"]);
    const second = await budgets.list({
      cursor: first.nextCursor!,
      limit: 2,
      organizationId: ORGANIZATION_ID,
    });
    expect(second.items.map((item) => item.data.id)).toEqual([created[0]!.data.id]);
    expect(
      await rejection(
        budgets.list({
          cursor: first.nextCursor!,
          limit: 2,
          organizationId: "01J0000000000000000000RG2Z" as never,
        }),
      ),
    ).toEqual({ code: "invalid_cursor", kind: "invalid-input" });
  });

  test("lists periods from the current one back to creation with ledger spend", async () => {
    const { budgets, database, setNow } = setup("2026-01-20T00:00:00.000Z");
    const budget = await budgets.create({
      amountUsdMicros: 1_000_000,
      name: "Org monthly",
      organizationId: ORGANIZATION_ID,
      period: "monthly",
      target: { scope: "organization" },
      thresholds: [50],
    });
    await recordSpend(database, {
      occurredAt: "2026-01-25T00:00:00.000Z",
      spendUsdMicros: 1_200_000,
    });
    await evaluateBudgetThresholds(
      database,
      { occurredAt: "2026-01-25T00:00:00.000Z", scope: RUN_SCOPE },
      { generateId: testId },
    );
    await recordSpend(database, {
      occurredAt: "2026-03-02T00:00:00.000Z",
      spendUsdMicros: 300_000,
    });
    setNow("2026-03-10T00:00:00.000Z");

    const first = await budgets.listPeriods({
      budgetId: budget.data.id,
      limit: 2,
      organizationId: ORGANIZATION_ID,
    });
    expect(first.items).toEqual([
      expect.objectContaining({
        current: true,
        exhausted: false,
        notifiedThresholds: [],
        periodStart: "2026-03-01T00:00:00.000Z",
        spendUsdMicros: 300_000,
      }),
      expect.objectContaining({
        current: false,
        periodStart: "2026-02-01T00:00:00.000Z",
        spendUsdMicros: 0,
      }),
    ]);
    const second = await budgets.listPeriods({
      budgetId: budget.data.id,
      cursor: first.nextCursor!,
      limit: 2,
      organizationId: ORGANIZATION_ID,
    });
    expect(second).toEqual({
      items: [
        {
          amountUsdMicros: 1_000_000,
          budgetId: budget.data.id,
          current: false,
          exhausted: true,
          notifiedThresholds: [50],
          period: "monthly",
          periodEnd: "2026-02-01T00:00:00.000Z",
          periodStart: "2026-01-01T00:00:00.000Z",
          spendUsdMicros: 1_200_000,
        },
      ],
    });
  });
});
