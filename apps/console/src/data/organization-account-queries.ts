import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  loadCostRows,
  loadOrganizationLimits,
  loadOrganizationSpend,
  loadOrganizationStanding,
  loadProjectSpend,
  loadWorkspaceSpend,
} from "../server/organization-account-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { SCOPE_FIELDS, type EnvironmentScope } from "../scope.ts";
import { fields, requireIds } from "./server-input.ts";

type OrganizationInput = { readonly organizationId: string };
type MonthInput = OrganizationInput & { readonly month: string };

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

const organizationInput = (input: OrganizationInput) => requireIds(input, ["organizationId"]);

function requireMonth(input: unknown): string {
  const { month } = fields(input);
  if (typeof month !== "string" || !MONTH.test(month)) {
    throw new TypeError("month must be a UTC month as YYYY-MM.");
  }
  return month;
}

const monthInput = (input: MonthInput) => ({
  ...organizationInput(input),
  month: requireMonth(input),
});

const fetchOrganizationStanding = createServerFn({ method: "GET" })
  .validator(organizationInput)
  .handler(async ({ data }) =>
    loadOrganizationStanding(await requireAccessToken(), data.organizationId),
  );

const fetchOrganizationSpend = createServerFn({ method: "GET" })
  .validator((input: OrganizationInput & { readonly month?: string }) => ({
    ...organizationInput(input),
    month: fields(input).month === undefined ? undefined : requireMonth(input),
  }))
  .handler(async ({ data }) =>
    loadOrganizationSpend(await requireAccessToken(), data.organizationId, data.month),
  );

const fetchProjectSpend = createServerFn({ method: "GET" })
  .validator(monthInput)
  .handler(async ({ data }) =>
    loadProjectSpend(await requireAccessToken(), data.organizationId, data.month),
  );

const environmentMonthInput = (input: {
  readonly month: string;
  readonly scope: EnvironmentScope;
}) => ({
  month: requireMonth(input),
  scope: requireIds(fields(input).scope, SCOPE_FIELDS),
});

const fetchWorkspaceSpend = createServerFn({ method: "GET" })
  .validator(environmentMonthInput)
  .handler(async ({ data }) =>
    loadWorkspaceSpend(await requireAccessToken(), data.scope, data.month),
  );

const fetchCostRows = createServerFn({ method: "GET" })
  .validator(environmentMonthInput)
  .handler(async ({ data }) => loadCostRows(await requireAccessToken(), data.scope, data.month));

const fetchOrganizationLimits = createServerFn({ method: "GET" })
  .validator(organizationInput)
  .handler(async ({ data }) =>
    loadOrganizationLimits(await requireAccessToken(), data.organizationId),
  );

export const organizationStandingQuery = (organizationId: string) =>
  queryOptions({
    queryFn: () => fetchOrganizationStanding({ data: { organizationId } }),
    queryKey: ["organization-standing", organizationId],
  });

/** `month` undefined is the current month to date. */
export const organizationSpendQuery = (organizationId: string, month?: string) =>
  queryOptions({
    queryFn: () =>
      fetchOrganizationSpend({
        data: { organizationId, ...(month === undefined ? {} : { month }) },
      }),
    queryKey: ["organization-spend", organizationId, month ?? "current"],
  });

export const projectSpendQuery = (organizationId: string, month: string) =>
  queryOptions({
    queryFn: () => fetchProjectSpend({ data: { month, organizationId } }),
    queryKey: ["organization-spend", organizationId, month, "projects"],
  });

export const workspaceSpendQuery = (scope: EnvironmentScope, month: string) =>
  queryOptions({
    queryFn: () => fetchWorkspaceSpend({ data: { month, scope } }),
    queryKey: [
      "organization-spend",
      scope.organizationId,
      month,
      "workspaces",
      scope.projectId,
      scope.environmentId,
    ],
  });

export const costRowsQuery = (scope: EnvironmentScope, month: string) =>
  queryOptions({
    queryFn: () => fetchCostRows({ data: { month, scope } }),
    queryKey: [
      "organization-spend",
      scope.organizationId,
      month,
      "costs",
      scope.projectId,
      scope.environmentId,
    ],
  });

export const organizationLimitsQuery = (organizationId: string) =>
  queryOptions({
    queryFn: () => fetchOrganizationLimits({ data: { organizationId } }),
    queryKey: ["organization-limits", organizationId],
  });
