import "@tanstack/react-start/server-only";
import {
  costRows,
  sortCostRows,
  spendMonthWindow,
  type CostRow,
  type SpendSplit,
} from "../usage/organization-spend.ts";
import type { EnvironmentScope } from "../scope.ts";
import { fanOut } from "./fan-out.ts";
import {
  callRoute,
  collectPages,
  type PlatformApiClient,
  type RouteResponse,
} from "./platform-api.ts";

export type OrganizationStanding = RouteResponse<"getOrganizationStanding">;
export type OrganizationSpend = RouteResponse<"getOrganizationSpend">;
export type OrganizationLimits = RouteResponse<"getOrganizationLimits">["effective"];

export type AccountPlatform = Pick<PlatformApiClient, "callRoute">;

const accountPlatform: AccountPlatform = { callRoute };

/** The customer view: holds carry only their reason, customer message, and start. */
export function loadOrganizationStanding(
  accessToken: string,
  organizationId: string,
  client: AccountPlatform = accountPlatform,
): Promise<OrganizationStanding> {
  return client.callRoute(
    "getOrganizationStanding",
    { path: { id: organizationId }, scope: { organizationId } },
    accessToken,
  );
}

/** One UTC month's spend; `month` undefined reads the current month to date. */
export function loadOrganizationSpend(
  accessToken: string,
  organizationId: string,
  month: string | undefined,
  client: AccountPlatform = accountPlatform,
): Promise<OrganizationSpend> {
  return client.callRoute(
    "getOrganizationSpend",
    { path: { id: organizationId }, query: { month }, scope: { organizationId } },
    accessToken,
  );
}

/** Each project's spend in the month, archived projects included. */
export async function loadProjectSpend(
  accessToken: string,
  organizationId: string,
  month: string,
  client: AccountPlatform = accountPlatform,
): Promise<readonly ProjectSpend[]> {
  const spend = await client.callRoute(
    "getOrganizationProjectSpend",
    { path: { id: organizationId }, query: { month }, scope: { organizationId } },
    accessToken,
  );
  return spend.items;
}

export type ProjectSpend = RouteResponse<"getOrganizationProjectSpend">["items"][number];

export interface WorkspaceSpend extends SpendSplit {
  readonly name: string;
  readonly workspaceId: string;
}

/** Each workspace's spend in the month in one environment, archived workspaces included. */
export async function loadWorkspaceSpend(
  accessToken: string,
  scope: EnvironmentScope,
  month: string,
  client: AccountPlatform = accountPlatform,
): Promise<readonly WorkspaceSpend[]> {
  const workspaces = await collectPages((cursor) =>
    client.callRoute("listWorkspaces", { query: { cursor, limit: 100 }, scope }, accessToken),
  );
  return fanOut(workspaces, async (workspace) => {
    const { operatorFundedUsdMicros, organizationFundedUsdMicros, totalUsdMicros } =
      await client.callRoute(
        "getWorkspaceSpend",
        { path: { id: workspace.id }, query: { month }, scope },
        accessToken,
      );
    return {
      name: workspace.name,
      operatorFundedUsdMicros,
      organizationFundedUsdMicros,
      totalUsdMicros,
      workspaceId: workspace.id,
    };
  });
}

/** Records per cost-list page; the API allows up to 1,000. */
const COST_PAGE_LIMIT = 1_000;

/**
 * Itemized cost of one environment in the month: every page of its cost records, folded into one
 * row per hour and source.
 */
export async function loadCostRows(
  accessToken: string,
  scope: {
    readonly environmentId: string;
    readonly organizationId: string;
    readonly projectId: string;
  },
  month: string,
  client: AccountPlatform = accountPlatform,
): Promise<readonly CostRow[]> {
  const records = await collectPages((cursor) =>
    client.callRoute(
      "listCostRecords",
      { query: { cursor, limit: COST_PAGE_LIMIT, ...spendMonthWindow(month) }, scope },
      accessToken,
    ),
  );
  return sortCostRows(costRows(scope.environmentId, records));
}

/** The limits the platform enforces now, each marked as the install default or an override. */
export async function loadOrganizationLimits(
  accessToken: string,
  organizationId: string,
  client: AccountPlatform = accountPlatform,
): Promise<OrganizationLimits> {
  const limits = await client.callRoute(
    "getOrganizationLimits",
    { path: { id: organizationId }, scope: { organizationId } },
    accessToken,
  );
  return limits.effective;
}
