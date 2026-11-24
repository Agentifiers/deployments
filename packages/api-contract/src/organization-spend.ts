import { Schema } from "effect";
import { ModelSpendCeiling } from "./organization-standing.ts";
import { PublicId, Timestamp } from "./primitives.ts";
import type { PublicApiQueryParameter, PublicApiRouteContract } from "./route-contract.ts";

export const SPEND_MONTH_PATTERN_SOURCE = "^\\d{4}-(?:0[1-9]|1[0-2])$";

const UsdMicros = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
);

/** One scope's month spend split by who paid, without the scope's identifiers. */
export const monthSpendFields = {
  asOf: Timestamp.annotate({ description: "When the platform read the spend." }),
  month: Schema.String.pipe(
    Schema.check(Schema.isPattern(new RegExp(SPEND_MONTH_PATTERN_SOURCE, "u"))),
  ).annotate({ description: "The UTC calendar month, as YYYY-MM." }),
  operatorFundedUsdMicros: UsdMicros.annotate({
    description:
      "Spend the installation paid for: model calls on its own provider keys and every other metered cost.",
  }),
  organizationFundedUsdMicros: UsdMicros.annotate({
    description: "Model calls on the organization's own provider keys, at the catalog price.",
  }),
  periodStart: Timestamp.annotate({ description: "The first instant of the month." }),
  totalUsdMicros: UsdMicros.annotate({
    description: "operatorFundedUsdMicros plus organizationFundedUsdMicros.",
  }),
};

const spendFields = { ...monthSpendFields, organizationId: PublicId };

export const SystemOrganizationSpendResponse = Schema.Struct(spendFields);

export const OrganizationSpendResponse = Schema.Struct({
  ...spendFields,
  operatorFundedModelSpendCeiling: ModelSpendCeiling.annotate({
    description:
      "The organization's effective ceiling on operator-funded spend each month. It is the current ceiling, also for a past month.",
  }),
});

const { asOf, month, ...splitFields } = monthSpendFields;
const { periodStart: _periodStart, ...projectSplitFields } = splitFields;

export const OrganizationProjectSpendResponse = Schema.Struct({
  asOf,
  items: Schema.Array(Schema.Struct({ ...projectSplitFields, projectId: PublicId })).annotate({
    description:
      "Every project of the organization, archived ones included, with its spend in the month.",
  }),
  month,
  organizationId: PublicId,
  periodStart: monthSpendFields.periodStart,
});

export const ORGANIZATION_SPEND_API_SCHEMAS = {
  OrganizationProjectSpendResponse,
  OrganizationSpendResponse,
} as const;

export const spendMonthParameter = {
  description:
    "UTC calendar month as YYYY-MM, no later than the current month. Default: the current month.",
  name: "month",
  schema: { pattern: SPEND_MONTH_PATTERN_SOURCE, type: "string" },
} as const satisfies PublicApiQueryParameter;

export const ORGANIZATION_SPEND_API_ROUTES = [
  {
    authentication: "platform-bearer",
    errors: [400, 401, 403, 404],
    idempotency: "none",
    method: "GET",
    name: "getOrganizationSpend",
    path: "/v1/organizations/:id/spend",
    queryParameters: [spendMonthParameter],
    requiredAuthorization: "organizations:read",
    responseBody: "OrganizationSpendResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Tenancy",
  },
  {
    authentication: "platform-bearer",
    errors: [400, 401, 403, 404],
    idempotency: "none",
    method: "GET",
    name: "getOrganizationProjectSpend",
    path: "/v1/organizations/:id/spend/projects",
    queryParameters: [spendMonthParameter],
    requiredAuthorization: "organizations:read",
    responseBody: "OrganizationProjectSpendResponse",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Tenancy",
  },
] as const satisfies readonly PublicApiRouteContract[];
