import { PublicId, Slug } from "@deployments-ai/api-contract/primitives";
import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import {
  costRowsQuery,
  organizationSpendQuery,
  projectSpendQuery,
  workspaceSpendQuery,
} from "../../data/organization-account-queries.ts";
import { INSTALL_COPY } from "../../edition.ts";
import type { OrganizationShell } from "../../server/console-data.ts";
import type {
  OrganizationSpend,
  ProjectSpend,
  WorkspaceSpend,
} from "../../server/organization-account-data.ts";
import {
  costRows,
  costRowsCsv,
  parseSpendMonthSearch,
  spendMonths,
  spendMonthWindow,
} from "../../usage/organization-spend.ts";
import type { ClientView } from "@/components/ui/render-client";
import { renderWith } from "../apps/app-fixtures.tsx";
import { EnvironmentSpendSection, ProjectSpendSection } from "./organization-spend-breakdown.tsx";
import { OrganizationSpendSection } from "./organization-usage.tsx";

const id = Schema.decodeUnknownSync(PublicId);
const ORG = id("01K000000000000000000000G1");
const APP = id("01K000000000000000000000P1");
const TOOLS = id("01K000000000000000000000P2");
const PROD = id("01K000000000000000000000E1");
const AT = "2026-10-09T12:00:00.000Z";

const environment = (environmentId: string, projectId: string, name: string) => ({
  createdAt: AT,
  id: id(environmentId),
  name,
  organizationId: ORG,
  projectId: id(projectId),
  slug: Schema.decodeUnknownSync(Slug)(name),
  status: "active" as const,
  type: "production" as const,
  updatedAt: AT,
});

const PROJECTS: OrganizationShell["projects"] = [
  {
    environments: [environment(PROD, APP, "prod")],
    project: {
      id: APP,
      name: "App",
      slug: Schema.decodeUnknownSync(Slug)("app"),
      status: "active",
    },
  },
  {
    environments: [],
    project: {
      id: TOOLS,
      name: "Tools",
      slug: Schema.decodeUnknownSync(Slug)("tools"),
      status: "archived",
    },
  },
];

const rows = (view: ClientView) =>
  [...view.document.querySelectorAll("tbody tr")].map((row) =>
    [...row.querySelectorAll("td")].map((cell) => cell.textContent),
  );
const text = (view: ClientView, selector: string) =>
  [...view.document.querySelectorAll(selector)].map((node) => node.textContent?.trim());

const seeded = (seed: (queryClient: QueryClient) => void) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  seed(queryClient);
  return queryClient;
};

describe("spend months", () => {
  test("offers the current UTC month and the twelve before it, newest first", () => {
    const months = spendMonths(new Date("2026-01-31T23:30:00.000-02:00"));
    expect([months.length, months[0], months[1], months.at(-1)]).toEqual([
      13,
      "2026-02",
      "2026-01",
      "2025-02",
    ]);
  });

  test("keeps only an offered past month in the URL; the current month is the default", () => {
    const now = new Date("2026-10-15T00:00:00.000Z");
    expect(
      ["2026-09", "2025-10", "2025-09", "2026-10", "2026-11", "September", 7].map((month) =>
        parseSpendMonthSearch({ month }, now),
      ),
    ).toEqual([{ month: "2026-09" }, { month: "2025-10" }, {}, {}, {}, {}, {}]);
  });

  test("a month's window runs from its first instant to the next month's", () => {
    expect(spendMonthWindow("2026-12")).toEqual({
      since: "2026-12-01T00:00:00.000Z",
      until: "2027-01-01T00:00:00.000Z",
    });
  });
});

describe("cost records", () => {
  const records = [
    {
      data: { bucket: AT, metric: "model_tokens.cost_usd_micros", quantity: 1_250_000 },
      type: "usage-counter-shard",
    },
    {
      data: { bucket: AT, metric: "model_tokens.cost_usd_micros", quantity: 250_000 },
      type: "usage-counter-shard",
    },
    {
      data: { bucket: AT, metric: "model_tokens.cost_usd_nanodollars", quantity: 9 },
      type: "usage-counter-shard",
    },
    { data: { bucket: AT, costs: { model: 7 }, source: "model" }, type: "cost-aggregate" },
  ];

  test("sums micro-dollar cost shards by hour and source and skips the alternative representations", () => {
    expect(costRows(PROD, records)).toEqual([
      { environmentId: PROD, hour: AT, source: "model_tokens", usdMicros: 1_500_000 },
    ]);
  });

  test("exports the rows as CSV with USD to the micro-dollar", () => {
    expect(costRowsCsv(costRows(PROD, records), () => "App / prod, east")).toBe(
      `hour_start_utc,environment,environment_id,source,cost_usd\r\n${AT},"App / prod, east",${PROD},model_tokens,1.500000\r\n`,
    );
  });
});

describe("spend history", () => {
  const spend = (month: string, operatorFundedUsdMicros: number): OrganizationSpend => ({
    asOf: AT,
    month,
    operatorFundedModelSpendCeiling: { monthlyUsdMicros: 5_000_000 },
    operatorFundedUsdMicros,
    organizationFundedUsdMicros: 0,
    organizationId: ORG,
    periodStart: `${month}-01T00:00:00.000Z`,
    totalUsdMicros: operatorFundedUsdMicros,
  });

  test("a past month reads as the whole month against the current ceiling, without the reached warning", async () => {
    const queryClient = seeded((client) =>
      client.setQueryData(
        organizationSpendQuery(ORG, "2026-08").queryKey,
        spend("2026-08", 6_000_000),
      ),
    );
    await renderWith(
      queryClient,
      <OrganizationSpendSection month="2026-08" organizationId={ORG} />,
      async (view) => {
        expect(text(view, "p")[0]).toStartWith("August 2026, as of");
        expect(text(view, "[data-slot=card-content]")[0]).toBe(
          "Paid by the installation$6.00120% of the current $5.00 monthly ceiling",
        );
        expect(view.document.querySelector("[role=alert], [role=status]")).toBeNull();
      },
    );
  });

  test("lists projects that spent, largest first, under the install's payer label, and counts the rest", async () => {
    const items: readonly ProjectSpend[] = [
      {
        operatorFundedUsdMicros: 0,
        organizationFundedUsdMicros: 0,
        projectId: APP,
        totalUsdMicros: 0,
      },
      {
        operatorFundedUsdMicros: 2_000_000,
        organizationFundedUsdMicros: 500_000,
        projectId: TOOLS,
        totalUsdMicros: 2_500_000,
      },
    ];
    const queryClient = seeded((client) =>
      client.setQueryData(projectSpendQuery(ORG, "2026-09").queryKey, items),
    );
    await renderWith(
      queryClient,
      <ProjectSpendSection
        copy={INSTALL_COPY.managed}
        month="2026-09"
        organizationId={ORG}
        projects={PROJECTS}
      />,
      async (view) => {
        expect(text(view, "thead th")).toEqual([
          "Project",
          "Billed by your plan",
          "Organization keys",
          "Total",
        ]);
        expect(rows(view)).toEqual([["Tools", "$2.00", "$0.50", "$2.50"]]);
        expect(text(view, "p")).toEqual(["1 more project recorded no spend."]);
      },
    );
  });

  test("one environment's workspaces and cost rows show for the month", async () => {
    const scope = { environmentId: PROD, organizationId: ORG, projectId: APP };
    const workspaces: readonly WorkspaceSpend[] = [
      {
        name: "customer-a",
        operatorFundedUsdMicros: 400_000,
        organizationFundedUsdMicros: 0,
        totalUsdMicros: 400_000,
        workspaceId: id("01K000000000000000000000W1"),
      },
    ];
    const queryClient = seeded((client) => {
      client.setQueryData(workspaceSpendQuery(scope, "2026-09").queryKey, workspaces);
      client.setQueryData(costRowsQuery(scope, "2026-09").queryKey, [
        {
          environmentId: PROD,
          hour: "2026-09-02T10:00:00.000Z",
          source: "model_tokens",
          usdMicros: 1_500_000,
        },
      ]);
    });
    await renderWith(
      queryClient,
      <EnvironmentSpendSection
        copy={INSTALL_COPY["self-hosted"]}
        month="2026-09"
        organizationId={ORG}
        projects={PROJECTS}
        showCosts
        showWorkspaces
      />,
      async (view) => {
        expect(text(view, "select option")).toEqual(["App / prod"]);
        expect(text(view, "h3")).toEqual(["Workspaces", "Cost records"]);
        expect(text(view, "thead th")).toContain("Paid by the installation");
        expect(rows(view)).toEqual([
          ["customer-a", "$0.40", "$0.00", "$0.40"],
          ["2026-09-02 10:00", "model_tokens", "$1.50"],
        ]);
        expect(text(view, "button")).toEqual(["Export CSV"]);
      },
    );
  });
});
