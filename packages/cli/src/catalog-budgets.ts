import type { CommandCatalog } from "./types.ts";
import {
  action,
  id,
  json,
  list,
  mutate,
  number,
  requiredNumber,
  requiredText,
  show,
  text,
} from "./catalog-helpers.ts";

const BUDGETS_PATH = "/v1/budgets";
const thresholds = json("Alert thresholds as a JSON array of ascending percents, e.g. [50,80,100]");

export const budgetCommandCatalog: CommandCatalog = {
  budget: {
    summary: "Organization, project, environment, and workspace spend budgets",
    actions: {
      list: list(BUDGETS_PATH, "organization", "List spend budgets", {
        limitField: "limit",
        maxLimit: 100,
        target: "query",
      }),
      create: action({
        summary: "Create a spend budget",
        method: "POST",
        path: BUDGETS_PATH,
        scope: "organization",
        output: "detail",
        args: {
          name: requiredText("Budget name"),
          scope: requiredText("Budget scope (organization, project, environment, workspace)"),
          "project-id": {
            ...text("Project the budget governs"),
            field: "projectId",
          },
          "environment-id": {
            ...text("Environment the budget or its workspace governs"),
            field: "environmentId",
          },
          "workspace-id": {
            ...text("Workspace the budget governs"),
            field: "workspaceId",
          },
          period: requiredText("Budget period (daily, monthly, quarterly, yearly)"),
          "amount-usd-micros": {
            ...requiredNumber("Budget amount in USD micros"),
            field: "amountUsdMicros",
          },
          thresholds,
        },
        idempotent: true,
      }),
      show: show(BUDGETS_PATH, "organization", "Show a spend budget"),
      update: action({
        summary: "Rename, resize, pause, or resume a spend budget",
        method: "PATCH",
        path: `${BUDGETS_PATH}/:id`,
        scope: "organization",
        output: "detail",
        args: {
          id,
          name: text("Budget name"),
          "amount-usd-micros": {
            ...number("Budget amount in USD micros"),
            field: "amountUsdMicros",
          },
          status: text("Budget status (active, paused)"),
          thresholds,
        },
        idempotent: true,
      }),
      archive: mutate("DELETE", BUDGETS_PATH, "organization", "Archive a spend budget", { id }),
      periods: action({
        summary: "List a budget's periods with spend",
        method: "GET",
        path: `${BUDGETS_PATH}/:id/periods`,
        scope: "organization",
        output: "list",
        args: { id },
        pagination: { limitField: "limit", maxLimit: 24, target: "query" },
      }),
    },
  },
};
