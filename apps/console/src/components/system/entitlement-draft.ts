import { ALL_PLAN_FEATURES, type PlanFeature } from "@deployments-ai/api-contract/plan-features";
import { ReplaceSystemOrganizationEntitlementsRequest } from "@deployments-ai/api-contract/system";
import { Cause, Exit, Schema } from "effect";
import {
  invalid,
  parseUsdAmount,
  usdInputValue,
  type Parsed,
} from "../../budgets/budget-amount.ts";
import type { SystemStanding } from "../../server/system-data.ts";

export type EntitlementGrant = typeof ReplaceSystemOrganizationEntitlementsRequest.Type;
export type EntitlementValues = SystemStanding["effective"];
export type TenantLimitName = keyof EntitlementValues["tenantLimits"];
export type ModelSpendCeiling = EntitlementValues["operatorFundedModelSpendCeiling"];

export const TENANT_LIMITS: readonly { readonly label: string; readonly name: TenantLimitName }[] =
  [
    { label: "Concurrent runs", name: "concurrentRuns" },
    { label: "Active sandboxes", name: "activeSandboxes" },
    { label: "API requests per second", name: "apiRequestsPerSecond" },
    { label: "API request burst", name: "apiRequestBurst" },
  ];

export const PLAN_FEATURE_FIELDS: readonly {
  readonly label: string;
  readonly name: PlanFeature;
}[] = [
  { label: "Single sign-on (SSO)", name: "sso" },
  { label: "Directory sync (SCIM)", name: "scim" },
];

/** `inherit` leaves the feature out of the grant, so it falls to the service grant or default. */
export const FEATURE_DRAFTS = ["inherit", "on", "off"] as const;
export type FeatureDraft = (typeof FEATURE_DRAFTS)[number];

/** `inherit` leaves the ceiling out of the grant, so it falls to the service grant or default. */
export type CeilingDraft =
  | { readonly kind: "inherit" }
  | { readonly kind: "unlimited" }
  | { readonly kind: "monthly"; readonly usd: string };

/** Form text per limit; an empty string leaves the limit out of the grant. */
export interface EntitlementDraft {
  readonly ceiling: CeilingDraft;
  readonly features: Readonly<Record<PlanFeature, FeatureDraft>>;
  readonly limits: Readonly<Record<TenantLimitName, string>>;
}

export function draftFromGrant(grant: EntitlementGrant | undefined): EntitlementDraft {
  const ceiling = grant?.operatorFundedModelSpendCeiling;
  return {
    ceiling:
      ceiling === undefined
        ? { kind: "inherit" }
        : ceiling === "unlimited"
          ? { kind: "unlimited" }
          : { kind: "monthly", usd: usdInputValue(ceiling.monthlyUsdMicros) },
    features: Object.fromEntries(
      PLAN_FEATURE_FIELDS.map(({ name }) => {
        const enabled = grant?.features?.[name];
        return [name, enabled === undefined ? "inherit" : enabled ? "on" : "off"];
      }),
    ) as Record<PlanFeature, FeatureDraft>,
    limits: Object.fromEntries(
      TENANT_LIMITS.map(({ name }) => [name, grant?.tenantLimits?.[name]?.toString() ?? ""]),
    ) as Record<TenantLimitName, string>,
  };
}

const decodeGrant = Schema.decodeUnknownExit(ReplaceSystemOrganizationEntitlementsRequest);

const ZERO_USD = /^\$?0+(?:\.0+)?$/u;

/** A zero ceiling is meaningful: it gives the organization no operator-funded allowance. */
export function parseCeilingUsd(text: string): Parsed<number> {
  return ZERO_USD.test(text.trim()) ? { ok: true, value: 0 } : parseUsdAmount(text);
}

export function parseLimit(name: TenantLimitName, text: string): Parsed<number | undefined> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  if (!/^\d+$/u.test(trimmed)) return invalid("Enter a whole number");
  const value = Number(trimmed);
  const decoded = decodeGrant({ tenantLimits: { [name]: value } });
  if (Exit.isSuccess(decoded)) return { ok: true, value };
  const error = Cause.squash(decoded.cause);
  const message = error instanceof Error ? error.message.split("\n")[0] : undefined;
  return invalid(message ?? `${name} is out of range`);
}

export interface DraftErrors {
  readonly ceiling?: string;
  readonly limits: Partial<Record<TenantLimitName, string>>;
}

export type ParsedDraft =
  | { readonly ok: true; readonly grant: EntitlementGrant }
  | { readonly ok: false; readonly errors: DraftErrors };

export function parseDraft(draft: EntitlementDraft): ParsedDraft {
  const limitErrors: Partial<Record<TenantLimitName, string>> = {};
  const tenantLimits: Partial<Record<TenantLimitName, number>> = {};
  for (const { name } of TENANT_LIMITS) {
    const parsed = parseLimit(name, draft.limits[name]);
    if (!parsed.ok) limitErrors[name] = parsed.message;
    else if (parsed.value !== undefined) tenantLimits[name] = parsed.value;
  }
  const features: Partial<Record<PlanFeature, boolean>> = {};
  for (const { name } of PLAN_FEATURE_FIELDS) {
    if (draft.features[name] !== "inherit") features[name] = draft.features[name] === "on";
  }
  let ceiling: ModelSpendCeiling | undefined;
  let ceilingError: string | undefined;
  if (draft.ceiling.kind === "unlimited") ceiling = "unlimited";
  if (draft.ceiling.kind === "monthly") {
    const usd = parseCeilingUsd(draft.ceiling.usd);
    if (usd.ok) ceiling = { monthlyUsdMicros: usd.value };
    else ceilingError = usd.message;
  }
  if (ceilingError !== undefined || Object.keys(limitErrors).length > 0) {
    return {
      errors: {
        limits: limitErrors,
        ...(ceilingError === undefined ? {} : { ceiling: ceilingError }),
      },
      ok: false,
    };
  }
  return {
    grant: {
      ...(Object.keys(features).length === 0 ? {} : { features }),
      ...(ceiling === undefined ? {} : { operatorFundedModelSpendCeiling: ceiling }),
      ...(Object.keys(tenantLimits).length === 0 ? {} : { tenantLimits }),
    },
    ok: true,
  };
}

/**
 * What the platform would enforce with `operatorGrant` in place, merged as the platform merges:
 * field by field the operator grant, then the service grant, then the install defaults, with
 * the burst raised to the rate when the merge leaves it below. A feature no grant decides is on,
 * the platform's install default.
 */
export function previewEffective(
  standing: Pick<SystemStanding, "defaults" | "grants">,
  operatorGrant: EntitlementGrant | undefined,
): EntitlementValues {
  const service = standing.grants.service?.entitlements;
  const tenantLimits = Object.fromEntries(
    TENANT_LIMITS.map(({ name }) => [
      name,
      operatorGrant?.tenantLimits?.[name] ??
        service?.tenantLimits?.[name] ??
        standing.defaults.tenantLimits[name],
    ]),
  ) as EntitlementValues["tenantLimits"];
  const features = Object.fromEntries(
    PLAN_FEATURE_FIELDS.map(({ name }) => [
      name,
      operatorGrant?.features?.[name] ?? service?.features?.[name] ?? ALL_PLAN_FEATURES[name],
    ]),
  ) as EntitlementValues["features"];
  return {
    features,
    operatorFundedModelSpendCeiling:
      operatorGrant?.operatorFundedModelSpendCeiling ??
      service?.operatorFundedModelSpendCeiling ??
      standing.defaults.operatorFundedModelSpendCeiling,
    tenantLimits:
      tenantLimits.apiRequestBurst < tenantLimits.apiRequestsPerSecond
        ? { ...tenantLimits, apiRequestBurst: tenantLimits.apiRequestsPerSecond }
        : tenantLimits,
  };
}
