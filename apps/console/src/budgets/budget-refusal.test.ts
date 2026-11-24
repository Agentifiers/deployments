import { describe, expect, test } from "bun:test";
import { refusalNotice } from "./budget-refusal.ts";

const DETAIL =
  'Budget "QA (daily)" (01J9ZQ4V6X8Y2K3M5N7P9R1T3V) for the environment has reached 104% of its daily limit for the period starting 2026-10-05T00:00:00.000Z; new runs are refused until the period ends or the budget is raised, paused, or archived.';

describe("refusalNotice", () => {
  test("reads the budget the refusal names", () => {
    expect(refusalNotice({ code: "budget_exhausted", detail: DETAIL })).toEqual({
      budgetId: "01J9ZQ4V6X8Y2K3M5N7P9R1T3V",
      name: "QA (daily)",
      percent: 104,
      period: "daily",
      periodStart: "2026-10-05T00:00:00.000Z",
      scope: "environment",
    });
  });

  test.each(["organization", "project", "environment", "workspace"] as const)(
    "reads a refusal by a %s budget",
    (scope) => {
      const detail = DETAIL.replace("for the environment", `for the ${scope}`);
      expect(refusalNotice({ code: "budget_exhausted", detail })).toMatchObject({
        budgetId: "01J9ZQ4V6X8Y2K3M5N7P9R1T3V",
        scope,
      });
    },
  );

  test("anchors on the real ID when the name imitates the sentence", () => {
    const name =
      'x" (01J9ZQ4V6X8Y2K3M5N7P9R1T3W) for the project has reached 5% of its daily limit for the period starting y; new runs are refused';
    const detail = `Budget "${name}" (01J9ZQ4V6X8Y2K3M5N7P9R1T3V) for the organization has reached 100% of its monthly limit for the period starting 2026-10-01T00:00:00.000Z; new runs are refused until the period ends or the budget is raised, paused, or archived.`;
    expect(refusalNotice({ code: "budget_exhausted", detail })).toEqual({
      budgetId: "01J9ZQ4V6X8Y2K3M5N7P9R1T3V",
      name,
      percent: 100,
      period: "monthly",
      periodStart: "2026-10-01T00:00:00.000Z",
      scope: "organization",
    });
  });

  test("ignores other problems and prose it cannot read", () => {
    expect(refusalNotice({ code: "rate_limited", detail: DETAIL })).toBeUndefined();
    expect(
      refusalNotice({ code: "budget_exhausted", detail: 'Budget "Org monthly" is exhausted.' }),
    ).toBeUndefined();
    expect(refusalNotice({ code: "budget_exhausted" })).toBeUndefined();
  });
});
