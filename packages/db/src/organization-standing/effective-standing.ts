import {
  coherentLimits,
  effectiveLimitValues,
  resolveEffectiveLimits,
  type TenantLimits,
} from "@deployments-ai/tenant-limits";
import {
  PLAN_FEATURE_NAMES,
  standingSource,
  type ActiveHold,
  type ModelSpendCeiling,
  type OrganizationStanding,
  type PlanFeatureName,
  type StandingSource,
} from "../records/organization-standing.ts";
import { dataBoundaryOf, type DataBoundary } from "./data-boundary.ts";

export type PlanFeatures = Readonly<Record<PlanFeatureName, boolean>>;

/** The install default: every feature on, so an install that never grants one is unchanged. */
export const ALL_FEATURES_ENABLED: PlanFeatures = { scim: true, sso: true };

export interface EffectiveEntitlements {
  readonly features: PlanFeatures;
  readonly tenantLimits: TenantLimits;
  readonly operatorFundedModelSpendCeiling: ModelSpendCeiling;
}

/** What an organization with no grant may use; every plan feature is on by default. */
export type InstallDefaults = Omit<EffectiveEntitlements, "features">;

export type StandingHold = ActiveHold & { readonly source: StandingSource };

interface StandingView {
  /** Version of the stored record; 0 when the organization has never had standing written. */
  readonly version: number;
  readonly entitlements: EffectiveEntitlements;
  readonly dataBoundary: DataBoundary;
}

/** Whether the organization is suspended, and by which holds; enough to decide an activity. */
export type HoldState =
  | { readonly state: "active" }
  | {
      readonly state: "suspended";
      readonly suspendedAt: string;
      readonly holds: readonly [StandingHold, ...StandingHold[]];
    };

export type EffectiveStanding = StandingView & HoldState;

export function holdState(stored: OrganizationStanding | undefined): HoldState {
  const suspension = stored?.suspension;
  if (!suspension) return { state: "active" };
  const [first, ...rest] = Object.values(suspension.holds)
    .map((hold) => ({ ...hold, source: standingSource(hold.placedBy) }))
    .toSorted(
      (left, right) =>
        left.placedAt.localeCompare(right.placedAt) || left.source.localeCompare(right.source),
    );
  return first
    ? { holds: [first, ...rest], state: "suspended", suspendedAt: suspension.since }
    : { state: "active" };
}

/** The operator grant's ceiling, then the service grant's, then the install default. */
export function effectiveModelSpendCeiling(
  stored: OrganizationStanding | undefined,
  installDefault: ModelSpendCeiling,
): ModelSpendCeiling {
  return (
    stored?.grants.operator?.entitlements.operatorFundedModelSpendCeiling ??
    stored?.grants.service?.entitlements.operatorFundedModelSpendCeiling ??
    installDefault
  );
}

/**
 * Merges field by field: the operator grant, then the service grant, then install defaults. A
 * missing record is an active organization on install defaults. Each source sets its fields
 * alone, so the merged burst is raised to the merged rate when it ends up below it.
 */
export function effectiveStanding(
  stored: OrganizationStanding | undefined,
  installDefaults: InstallDefaults,
): EffectiveStanding {
  const strongestLast = [stored?.grants.service, stored?.grants.operator].flatMap((grant) =>
    grant ? [grant.entitlements] : [],
  );
  const tenantLimits = strongestLast.reduce<TenantLimits>(
    (merged, grant) =>
      effectiveLimitValues(resolveEffectiveLimits(merged, grant.tenantLimits ?? {})),
    installDefaults.tenantLimits,
  );
  const features = Object.fromEntries(
    PLAN_FEATURE_NAMES.map((name) => [
      name,
      stored?.grants.operator?.entitlements.features?.[name] ??
        stored?.grants.service?.entitlements.features?.[name] ??
        ALL_FEATURES_ENABLED[name],
    ]),
  ) as Record<PlanFeatureName, boolean>;
  const entitlements = {
    features,
    operatorFundedModelSpendCeiling: effectiveModelSpendCeiling(
      stored,
      installDefaults.operatorFundedModelSpendCeiling,
    ),
    tenantLimits: coherentLimits(tenantLimits),
  };
  return {
    dataBoundary: dataBoundaryOf(stored?.dataBoundary),
    entitlements,
    version: stored?.version ?? 0,
    ...holdState(stored),
  };
}
