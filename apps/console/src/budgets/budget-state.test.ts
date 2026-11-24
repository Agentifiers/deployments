import {
  BudgetPeriodResponse,
  BudgetResponse,
  CreateBudgetRequest,
  UpdateBudgetRequest,
} from "@deployments-ai/api-contract";
import { PublicId, Slug } from "@deployments-ai/api-contract/primitives";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import type { OrganizationShell } from "../server/console-data.ts";
import {
  admissionImpact,
  BUDGET_ACTIONS,
  budgetAlerts,
  budgetChanges,
  changesApplied,
  budgetConfirmation,
  budgetHealth,
  budgetPage,
  budgetRow,
  governs,
  parseBudgetSearch,
  parseThresholds,
  readBudgetDraft,
  refusingBudgets,
  sameTarget,
  STATUS_AFTER,
  type AdmissionEffect,
  type Budget,
  type BudgetPeriod,
  type TargetIds,
} from "./budget-state.ts";

const id = Schema.decodeUnknownSync(PublicId);
const slug = Schema.decodeUnknownSync(Slug);

const ORGANIZATION = id("01J9ZQ4V6X8Y2K3M5N7P9R1T30");
const PROJECT = id("01J9ZQ4V6X8Y2K3M5N7P9R1TP1");
const OTHER_PROJECT = id("01J9ZQ4V6X8Y2K3M5N7P9R1TP2");
const ENVIRONMENT = id("01J9ZQ4V6X8Y2K3M5N7P9R1TE1");
const OTHER_ENVIRONMENT = id("01J9ZQ4V6X8Y2K3M5N7P9R1TE2");
const WORKSPACE = "01J9ZQ4V6X8Y2K3M5N7P9RWS01";
const OTHER_WORKSPACE = "01J9ZQ4V6X8Y2K3M5N7P9RWS02";
const SCOPE = { environmentId: ENVIRONMENT, organizationId: ORGANIZATION, projectId: PROJECT };

const ENV_BUDGET = id("01J9ZQ4V6X8Y2K3M5N7P9R1T3V");
const ORG_BUDGET = id("01J9ZQ4V6X8Y2K3M5N7P9R1T3W");
const PAUSED_BUDGET = id("01J9ZQ4V6X8Y2K3M5N7P9R1T3X");
const ELSEWHERE_BUDGET = id("01J9ZQ4V6X8Y2K3M5N7P9R1T3Y");
const ARCHIVED_BUDGET = id("01J9ZQ4V6X8Y2K3M5N7P9R1T3Z");
const STALE_BUDGET = id("01J9ZQ4V6X8Y2K3M5N7P9R1T40");
const OTHER_BUDGET = id("01J9ZQ4V6X8Y2K3M5N7P9R1T41");

const ORGANIZATION_TARGET: TargetIds = { scope: "organization" };
const PROJECT_TARGET: TargetIds = { projectId: PROJECT, scope: "project" };
const ENVIRONMENT_TARGET: TargetIds = {
  environmentId: ENVIRONMENT,
  projectId: PROJECT,
  scope: "environment",
};

function budget(
  id: string,
  name: string,
  target: TargetIds,
  options: { readonly amount?: number; readonly status?: Budget["status"] } = {},
): Budget {
  return Schema.decodeUnknownSync(BudgetResponse)({
    ...target,
    amountUsdMicros: options.amount ?? 1,
    ...(options.status === "archived" ? { archivedAt: "2026-10-05T12:00:00.000Z" } : {}),
    createdAt: "2026-10-01T00:00:00.000Z",
    id,
    name,
    organizationId: ORGANIZATION,
    period: "daily",
    status: options.status ?? "active",
    thresholds: [50, 80, 100],
    updatedAt: "2026-10-01T00:00:00.000Z",
    version: 1,
  });
}

function period(
  budgetId: string,
  spend: number,
  amount: number,
  current = true,
  notifiedThresholds: readonly number[] = [],
): BudgetPeriod {
  return Schema.decodeUnknownSync(BudgetPeriodResponse)({
    amountUsdMicros: amount,
    budgetId,
    current,
    exhausted: spend >= amount,
    notifiedThresholds,
    period: "daily",
    periodEnd: "2026-10-06T00:00:00.000Z",
    periodStart: "2026-10-05T00:00:00.000Z",
    spendUsdMicros: spend,
  });
}

function shell(type: "development" | "production"): OrganizationShell["projects"] {
  const environment = (environmentId: typeof ENVIRONMENT, environmentType: typeof type) => ({
    createdAt: "2026-10-01T00:00:00.000Z",
    id: environmentId,
    name: environmentId === ENVIRONMENT ? "dev" : "other",
    organizationId: ORGANIZATION,
    projectId: PROJECT,
    slug: slug(environmentId === ENVIRONMENT ? "dev" : "other"),
    status: "active" as const,
    type: environmentType,
    updatedAt: "2026-10-01T00:00:00.000Z",
  });
  return [
    {
      environments: [environment(ENVIRONMENT, "development"), environment(OTHER_ENVIRONMENT, type)],
      project: { id: PROJECT, name: "QA", slug: slug("qa"), status: "active" },
    },
  ];
}

test("each status change leads to another status, and archived is terminal", () => {
  const transitions = Object.entries(BUDGET_ACTIONS).flatMap(([status, actions]) =>
    actions.flatMap((action) =>
      action === "edit" ? [] : [`${status} -${action}-> ${STATUS_AFTER[action]}`],
    ),
  );
  expect(transitions).toEqual([
    "active -pause-> paused",
    "active -archive-> archived",
    "paused -resume-> active",
    "paused -archive-> archived",
  ]);
});

describe("parseThresholds", () => {
  test("sorts and de-duplicates whole percentages", () => {
    expect(parseThresholds("100, 50 80")).toEqual({ ok: true, value: [50, 80, 100] });
    expect(parseThresholds("50,50")).toEqual({ ok: true, value: [50] });
  });

  test("rejects what the API's threshold schema rejects", () => {
    expect(parseThresholds("0")).toEqual({
      message: "Each threshold must be a whole percentage from 1 to 100",
      ok: false,
    });
    expect(parseThresholds("101")).toEqual({
      message: "Each threshold must be a whole percentage from 1 to 100",
      ok: false,
    });
    expect(parseThresholds("1,2,3,4,5,6,7,8,9,10,11")).toEqual({
      message: "Use at most 10 thresholds",
      ok: false,
    });
    expect(parseThresholds(" , ")).toEqual({
      message: "Enter 1 to 10 thresholds, such as 50, 80, 100",
      ok: false,
    });
  });
});

test("governs follows admission's targets that cover the whole environment", () => {
  expect(governs(ORGANIZATION_TARGET, SCOPE)).toBe(true);
  expect(governs(PROJECT_TARGET, SCOPE)).toBe(true);
  expect(governs({ projectId: OTHER_PROJECT, scope: "project" }, SCOPE)).toBe(false);
  expect(governs(ENVIRONMENT_TARGET, SCOPE)).toBe(true);
  expect(
    governs({ environmentId: OTHER_ENVIRONMENT, projectId: PROJECT, scope: "environment" }, SCOPE),
  ).toBe(false);
  expect(
    governs({ ...ENVIRONMENT_TARGET, scope: "workspace", workspaceId: WORKSPACE }, SCOPE),
  ).toBe(false);
});

describe("alerts", () => {
  test("budgetAlerts lists live budgets whose current period alerted, furthest over first", () => {
    const alerts = budgetAlerts([
      {
        budget: budget(ORG_BUDGET, "org", ORGANIZATION_TARGET, { amount: 10 }),
        current: period(ORG_BUDGET, 6, 10, true, [50]),
      },
      {
        budget: budget(ENV_BUDGET, "env", ENVIRONMENT_TARGET, { amount: 10 }),
        current: period(ENV_BUDGET, 9, 10, true, [50, 80]),
      },
      {
        budget: budget(PAUSED_BUDGET, "paused", PROJECT_TARGET, { status: "paused" }),
        current: period(PAUSED_BUDGET, 1, 1, true, [50, 80, 100]),
      },
      {
        budget: budget(STALE_BUDGET, "last period", ENVIRONMENT_TARGET),
        current: period(STALE_BUDGET, 1, 1, false, [100]),
      },
      {
        budget: budget(ARCHIVED_BUDGET, "archived", ENVIRONMENT_TARGET, { status: "archived" }),
        current: period(ARCHIVED_BUDGET, 1, 1, true, [100]),
      },
      {
        budget: budget(ELSEWHERE_BUDGET, "quiet", PROJECT_TARGET),
        current: period(ELSEWHERE_BUDGET, 0, 1),
      },
      { budget: budget(OTHER_BUDGET, "unread", PROJECT_TARGET), current: undefined },
    ]);
    expect(
      alerts.map(({ budget: { name }, percent, threshold }) => [name, threshold, percent]),
    ).toEqual([
      ["paused", 100, 100],
      ["env", 80, 90],
      ["org", 50, 60],
    ]);
  });
});

describe("refusals", () => {
  const paused = budget(PAUSED_BUDGET, "paused project", PROJECT_TARGET, { status: "paused" });
  const entries = [
    {
      budget: budget(ORG_BUDGET, "org", ORGANIZATION_TARGET, { amount: 10 }),
      current: period(ORG_BUDGET, 10, 10),
    },
    { budget: paused, current: period(PAUSED_BUDGET, 5, 1) },
    {
      budget: budget(ELSEWHERE_BUDGET, "elsewhere", {
        environmentId: OTHER_ENVIRONMENT,
        projectId: PROJECT,
        scope: "environment",
      }),
      current: period(ELSEWHERE_BUDGET, 3, 1),
    },
    {
      budget: budget(ARCHIVED_BUDGET, "archived", ENVIRONMENT_TARGET, { status: "archived" }),
      current: period(ARCHIVED_BUDGET, 3, 1, false),
    },
    {
      budget: budget(STALE_BUDGET, "stale", ENVIRONMENT_TARGET),
      current: period(STALE_BUDGET, 3, 1, false),
    },
    { budget: budget(ENV_BUDGET, "env", ENVIRONMENT_TARGET), current: period(ENV_BUDGET, 2, 1) },
  ];

  test("refusingBudgets lists active, exhausted, governing budgets in admission order", () => {
    expect(
      refusingBudgets(entries, SCOPE).map(({ budget: refusing, percent }) => [
        refusing.id,
        percent,
      ]),
    ).toEqual([
      [ENV_BUDGET, 200],
      [ORG_BUDGET, 100],
    ]);
  });

  test("budgetHealth tells a paused over-limit budget from a refusing one", () => {
    expect(budgetHealth(paused, period(PAUSED_BUDGET, 5, 1))).toBe("over-limit-paused");
    expect(budgetHealth(paused, undefined)).toBe("unknown");
    expect(budgetHealth({ status: "active" }, period(ENV_BUDGET, 0, 1))).toBe("within");
  });

  test("budgetRow carries health, percent, and whether the budget governs here", () => {
    const elsewhere = entries[2]!;
    expect(budgetRow(elsewhere.budget, elsewhere.current, SCOPE)).toMatchObject({
      governsHere: false,
      health: "refusing",
      percent: 300,
    });
    const archived = entries[3]!;
    expect(budgetRow(archived.budget, undefined, SCOPE)).toMatchObject({
      governsHere: true,
      health: "archived",
      percent: undefined,
    });
  });
});

test("budgetPage shows what applies here in admission order, or every budget in API order", () => {
  const newestFirst = [
    budget(ENV_BUDGET, "b env", ENVIRONMENT_TARGET),
    budget(ORG_BUDGET, "a org", ORGANIZATION_TARGET),
    budget(ARCHIVED_BUDGET, "c archived", ENVIRONMENT_TARGET, { status: "archived" }),
    budget(ELSEWHERE_BUDGET, "d elsewhere", { projectId: OTHER_PROJECT, scope: "project" }),
    budget(PAUSED_BUDGET, "e project", PROJECT_TARGET, { status: "paused" }),
  ];
  const applies = budgetPage(newestFirst, {
    offset: 0,
    pageSize: 2,
    scope: SCOPE,
    view: "applies",
  });
  expect({ ...applies, budgets: applies.budgets.map((entry) => entry.name) }).toEqual({
    budgets: ["b env", "e project"],
    hidden: 2,
    nextOffset: 2,
  });
  const all = budgetPage(newestFirst, { offset: 2, pageSize: 25, scope: SCOPE, view: "all" });
  expect({ ...all, budgets: all.budgets.map((entry) => entry.name) }).toEqual({
    budgets: ["c archived", "d elsewhere", "e project"],
    hidden: 0,
  });
});

test("parseBudgetSearch keeps only the all-budgets view", () => {
  expect(parseBudgetSearch({ show: "all" })).toEqual({ show: "all" });
  expect(parseBudgetSearch({ show: "everything" })).toEqual({});
});

describe("budgetChanges", () => {
  const loaded = budget(ENV_BUDGET, "QA (daily)", ENVIRONMENT_TARGET);

  test("sends only the fields that changed", () => {
    const changes = budgetChanges(loaded, {
      amount: "1000",
      name: " QA (daily) ",
      thresholds: "100, 80, 50",
    });
    expect(changes).toEqual({ ok: true, value: { amountUsdMicros: 1_000_000_000 } });
    expect(budgetChanges(loaded, { amount: "0.000001", name: "QA", thresholds: "90" })).toEqual({
      ok: true,
      value: { name: "QA", thresholds: [90] },
    });
  });

  test("refuses an empty update, which the API's schema rejects", () => {
    expect(
      budgetChanges(loaded, { amount: "$0.000001", name: "QA (daily)", thresholds: "50 80 100" }),
    ).toEqual({ message: "Nothing changed", ok: false });
    expect(budgetChanges(loaded, { amount: "1", name: "  ", thresholds: "50" })).toEqual({
      message: "Enter a name of 1 to 120 characters",
      ok: false,
    });
  });

  test("produces bodies the update schema accepts", () => {
    const changes = budgetChanges(loaded, { amount: "2.5", name: "QA", thresholds: "25, 75" });
    if (!changes.ok) throw new Error(changes.message);
    expect(Schema.decodeUnknownSync(UpdateBudgetRequest)(changes.value)).toEqual({
      amountUsdMicros: 2_500_000,
      name: "QA",
      thresholds: [25, 75],
    });
  });
});

describe("readBudgetDraft", () => {
  test("names both IDs of an environment target and leaves default thresholds to the API", () => {
    const draft = readBudgetDraft({
      amount: "0.000001",
      name: " qa-d2-refusal ",
      period: "daily",
      target: { environmentId: ENVIRONMENT, projectId: PROJECT, scope: "environment" },
      thresholds: "50, 80, 100",
    });
    expect(draft).toEqual({
      ok: true,
      value: {
        amountUsdMicros: 1,
        environmentId: ENVIRONMENT,
        name: "qa-d2-refusal",
        period: "daily",
        projectId: PROJECT,
        scope: "environment",
      },
    });
    if (!draft.ok) throw new Error(draft.message);
    const accepted: unknown = Schema.decodeUnknownSync(CreateBudgetRequest)(draft.value);
    expect(accepted).toEqual(draft.value);
  });

  test("a workspace draft names the workspace and its environment as the API requires", () => {
    const draft = readBudgetDraft({
      amount: "25",
      name: "Workspace cap",
      period: "monthly",
      target: {
        environmentId: ENVIRONMENT,
        projectId: PROJECT,
        scope: "workspace",
        workspaceId: WORKSPACE,
      },
      thresholds: "50, 80, 100",
    });
    if (!draft.ok) throw new Error(draft.message);
    const accepted: unknown = Schema.decodeUnknownSync(CreateBudgetRequest)(draft.value);
    expect(accepted).toEqual({
      amountUsdMicros: 25_000_000,
      environmentId: ENVIRONMENT,
      name: "Workspace cap",
      period: "monthly",
      projectId: PROJECT,
      scope: "workspace",
      workspaceId: WORKSPACE,
    });
  });

  test("sends custom thresholds and reports the first invalid field", () => {
    expect(
      readBudgetDraft({
        amount: "1000000",
        name: "qa-d2-org",
        period: "monthly",
        target: { scope: "organization" },
        thresholds: "90",
      }),
    ).toEqual({
      ok: true,
      value: {
        amountUsdMicros: 1_000_000_000_000,
        name: "qa-d2-org",
        period: "monthly",
        scope: "organization",
        thresholds: [90],
      },
    });
    expect(
      readBudgetDraft({
        amount: "ten",
        name: "qa",
        period: "monthly",
        target: { projectId: PROJECT, scope: "project" },
        thresholds: "50",
      }),
    ).toEqual({ message: "Enter an amount in US dollars, such as 250 or 0.50", ok: false });
  });
});

describe("budgetConfirmation", () => {
  test("asks for the ID tail to archive, to refuse runs at once, or to change what governs production", () => {
    const development = shell("development");
    const edit = (effect: AdmissionEffect) =>
      budgetConfirmation(ENVIRONMENT_TARGET, development, { budgetId: ENV_BUDGET, effect });
    expect(
      budgetConfirmation(ENVIRONMENT_TARGET, development, {
        budgetId: ENV_BUDGET,
        destructive: true,
      }),
    ).toBe("7P9R1T3V");
    expect(edit("refuses-now")).toBe("7P9R1T3V");
    expect(edit("spend-unknown")).toBeUndefined();
    expect(edit("keeps-refusing")).toBeUndefined();
    expect(edit("admits")).toBeUndefined();
    expect(
      budgetConfirmation(ENVIRONMENT_TARGET, shell("production"), { budgetId: ENV_BUDGET }),
    ).toBeUndefined();
    expect(
      budgetConfirmation(ORGANIZATION_TARGET, shell("production"), { budgetId: ENV_BUDGET }),
    ).toBe("7P9R1T3V");
  });

  test("names the target of a new budget, so widening it asks again", () => {
    const production = shell("production");
    expect(budgetConfirmation(ENVIRONMENT_TARGET, production, {})).toBeUndefined();
    expect(
      budgetConfirmation(ENVIRONMENT_TARGET, shell("development"), { effect: "refuses-now" }),
    ).toBe("dev");
    expect(budgetConfirmation(PROJECT_TARGET, production, {})).toBe("QA");
    expect(budgetConfirmation(ORGANIZATION_TARGET, production, {})).toBe("organization");
    expect(
      budgetConfirmation(ORGANIZATION_TARGET, shell("development"), { effect: "spend-unknown" }),
    ).toBeUndefined();
  });
});

describe("admissionImpact", () => {
  const spentThree = { current: true, spendUsdMicros: 3 };

  test("names every active environment a refusing budget would stop", () => {
    expect(
      admissionImpact(
        { ...ORGANIZATION_TARGET, amountUsdMicros: 3, status: "active" },
        spentThree,
        shell("production"),
      ),
    ).toEqual({ effect: "refuses-now", environments: ["QA / dev", "QA / other"] });
    expect(
      admissionImpact(
        { ...ENVIRONMENT_TARGET, amountUsdMicros: 1, status: "active" },
        spentThree,
        shell("production"),
      ),
    ).toEqual({ effect: "refuses-now", environments: ["QA / dev"] });
  });

  test("a workspace budget names only its workspace's environment", () => {
    expect(
      admissionImpact(
        {
          ...ENVIRONMENT_TARGET,
          amountUsdMicros: 1,
          scope: "workspace",
          status: "active",
          workspaceId: WORKSPACE,
        },
        spentThree,
        shell("production"),
      ),
    ).toEqual({ effect: "refuses-now", environments: ["the workspace in QA / dev"] });
  });

  test("admits above the spend or while paused, and cannot tell without a current period", () => {
    const projects = shell("development");
    const next = { ...PROJECT_TARGET, amountUsdMicros: 4, status: "active" as const };
    expect(admissionImpact(next, spentThree, projects).effect).toBe("admits");
    expect(
      admissionImpact({ ...next, amountUsdMicros: 3, status: "paused" }, spentThree, projects)
        .effect,
    ).toBe("admits");
    expect(admissionImpact(next, undefined, projects).effect).toBe("spend-unknown");
    expect(admissionImpact(next, { current: false, spendUsdMicros: 0 }, projects).effect).toBe(
      "spend-unknown",
    );
  });

  test("an edit that leaves a refusing budget refusing stops no run that was admitted", () => {
    const projects = shell("development");
    const next = { ...ENVIRONMENT_TARGET, amountUsdMicros: 2, status: "active" as const };
    expect(
      admissionImpact(next, spentThree, projects, { amountUsdMicros: 1, status: "active" }),
    ).toEqual({ effect: "keeps-refusing", environments: ["QA / dev"] });
    expect(
      admissionImpact(next, spentThree, projects, { amountUsdMicros: 4, status: "active" }).effect,
    ).toBe("refuses-now");
    expect(
      admissionImpact(next, spentThree, projects, { amountUsdMicros: 1, status: "paused" }).effect,
    ).toBe("refuses-now");
  });
});

test("changesApplied recognizes an update the budget already holds", () => {
  const loaded = budget(ENV_BUDGET, "QA", ENVIRONMENT_TARGET, { amount: 1_000_000 });
  expect(changesApplied(loaded, { amountUsdMicros: 1_000_000, name: "QA" })).toBe(true);
  expect(changesApplied(loaded, { status: "paused" })).toBe(false);
  expect(changesApplied(loaded, { thresholds: [50, 80, 100] })).toBe(true);
  expect(changesApplied(loaded, { thresholds: [50] })).toBe(false);
});

test("sameTarget compares the scope and the ID that scope names", () => {
  expect(sameTarget(ENVIRONMENT_TARGET, { environmentId: ENVIRONMENT, scope: "environment" })).toBe(
    true,
  );
  expect(sameTarget(PROJECT_TARGET, ENVIRONMENT_TARGET)).toBe(false);
  expect(sameTarget(PROJECT_TARGET, { projectId: OTHER_PROJECT, scope: "project" })).toBe(false);
  expect(sameTarget(ORGANIZATION_TARGET, { scope: "organization" })).toBe(true);
  const workspaceTarget = {
    ...ENVIRONMENT_TARGET,
    scope: "workspace",
    workspaceId: WORKSPACE,
  } as const;
  expect(sameTarget(workspaceTarget, workspaceTarget)).toBe(true);
  expect(sameTarget(workspaceTarget, ENVIRONMENT_TARGET)).toBe(false);
  expect(sameTarget(workspaceTarget, { ...workspaceTarget, workspaceId: OTHER_WORKSPACE })).toBe(
    false,
  );
});
