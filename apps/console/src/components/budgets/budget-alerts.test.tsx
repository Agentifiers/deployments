import { BudgetPeriodResponse, BudgetResponse } from "@deployments-ai/api-contract";
import { PublicId, Slug } from "@deployments-ai/api-contract/primitives";
import { effectiveOrganizationCapabilities } from "@deployments-ai/db";
import { PLATFORM_CLI_SCOPES } from "@deployments-ai/identity";
import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Schema } from "effect";
import { operationAccess } from "../../access.ts";
import type { BudgetAlertScan } from "../../budgets/budget-state.ts";
import { budgetAlertsQuery } from "../../data/budget-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import type { OrganizationShell } from "../../server/console-data.ts";
import type { ClientView } from "@/components/ui/render-client";
import { renderWith } from "../apps/app-fixtures.tsx";
import { BudgetAlertList } from "./budget-list.tsx";

const id = Schema.decodeUnknownSync(PublicId);
const ORG = id("01K000000000000000000000G1");
const PROJECT = id("01K000000000000000000000P1");
const ENVIRONMENT = id("01K000000000000000000000E1");
const BUDGET = id("01K000000000000000000000B1");
const AT = "2026-10-01T00:00:00.000Z";
const scope = { environmentId: ENVIRONMENT, organizationId: ORG, projectId: PROJECT };

const shell: OrganizationShell = {
  access: operationAccess({
    capabilities: effectiveOrganizationCapabilities("owner", PLATFORM_CLI_SCOPES),
    organizationRole: "owner",
  }),
  authorization: { capabilities: [], organizationRole: "owner" },
  organization: {
    createdAt: AT,
    id: ORG,
    name: "Acme",
    slug: Schema.decodeUnknownSync(Slug)("acme"),
    status: "active",
    updatedAt: AT,
  },
  organizations: [],
  principalId: "01K000000000000000000000U1",
  projects: [
    {
      environments: [],
      project: {
        id: PROJECT,
        name: "App",
        slug: Schema.decodeUnknownSync(Slug)("app"),
        status: "active",
      },
    },
  ],
};

const alerts = (scan: BudgetAlertScan) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  queryClient.setQueryData(organizationShellQuery(ORG).queryKey, shell);
  queryClient.setQueryData(budgetAlertsQuery(scope).queryKey, scan);
  return queryClient;
};

async function routed() {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => <BudgetAlertList scope={scope} /> }),
  });
  await router.load();
  return <RouterProvider router={router} />;
}

const rows = (view: ClientView) =>
  [...view.document.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent),
  );

describe("budget alerts", () => {
  test("lists each budget that alerted this period with the highest threshold it crossed", async () => {
    const budget = Schema.decodeUnknownSync(BudgetResponse)({
      amountUsdMicros: 100_000_000,
      createdAt: AT,
      id: BUDGET,
      name: "Monthly cap",
      organizationId: ORG,
      period: "monthly",
      projectId: PROJECT,
      scope: "project",
      status: "active",
      thresholds: [50, 80, 100],
      updatedAt: AT,
      version: 1,
    });
    const current = Schema.decodeUnknownSync(BudgetPeriodResponse)({
      amountUsdMicros: 100_000_000,
      budgetId: BUDGET,
      current: true,
      exhausted: false,
      notifiedThresholds: [50, 80],
      period: "monthly",
      periodEnd: "2026-11-01T00:00:00.000Z",
      periodStart: AT,
      spendUsdMicros: 85_000_000,
    });
    await renderWith(
      alerts({ alerts: [{ budget, current, percent: 85, threshold: 80 }], complete: true }),
      await routed(),
      async (view) => {
        expect(view.document.querySelector("h2, h3")?.textContent).toBe("Alerts this period");
        expect(rows(view).map((cells) => cells.slice(0, 4))).toEqual([
          ["Monthly cap", "Project App", "80%", "$85.00 of $100.00 (85%)"],
        ]);
        expect(view.document.querySelector("tbody a")?.getAttribute("href")).toBe(
          `/o/${ORG}/p/${PROJECT}/e/${ENVIRONMENT}/budgets/${BUDGET}`,
        );
      },
    );
  });

  test("renders nothing when no budget has alerted", async () => {
    await renderWith(alerts({ alerts: [], complete: true }), await routed(), async (view) => {
      expect(view.document.querySelector("[aria-label='Budget alerts']")).toBeNull();
    });
  });
});
