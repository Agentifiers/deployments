import { TENANT_LIMIT_DEFINITIONS, type TenantLimitName } from "@deployments-ai/tenant-limits";
import { Schema } from "effect";
import { PublicId } from "./primitives.ts";

const DESCRIPTIONS: Readonly<Record<TenantLimitName, string>> = {
  activeSandboxes: "Sandboxes the organization may hold active or resuming at once.",
  apiRequestBurst: "Requests the organization may send at once before the rate applies.",
  apiRequestsPerSecond: "Sustained API requests per second across the organization.",
  concurrentRuns: "Runs the organization may execute at once; later runs wait queued.",
};

function limitValue(field: TenantLimitName) {
  const { maximum, minimum } = TENANT_LIMIT_DEFINITIONS[field];
  return Schema.Number.pipe(
    Schema.check(
      Schema.isInt({ message: `${field} must be an integer.` }),
      Schema.isGreaterThanOrEqualTo(minimum, {
        message: `${field} must be an integer from ${minimum} to ${maximum}.`,
      }),
      Schema.isLessThanOrEqualTo(maximum, {
        message: `${field} must be an integer from ${minimum} to ${maximum}.`,
      }),
    ),
  ).annotate({ description: DESCRIPTIONS[field] });
}

/** Where an organization's limit comes from; the operator's grant outranks a service's plan. */
export const TENANT_LIMIT_SOURCES = ["default", "plan", "override"] as const;

const EffectiveTenantLimit = (field: TenantLimitName) =>
  Schema.Struct({
    source: Schema.Literals(TENANT_LIMIT_SOURCES).annotate({
      description:
        "default: the install default. plan: set by a machine service's grant, such as a billing plan. override: set by the operator.",
    }),
    value: limitValue(field),
  });

export const TenantLimitValues = Schema.Struct({
  activeSandboxes: limitValue("activeSandboxes"),
  apiRequestBurst: limitValue("apiRequestBurst"),
  apiRequestsPerSecond: limitValue("apiRequestsPerSecond"),
  concurrentRuns: limitValue("concurrentRuns"),
});

/** An absent field leaves the limit to the next grant or the platform default. */
export const TenantLimitOverrides = Schema.Struct({
  activeSandboxes: Schema.optional(limitValue("activeSandboxes")),
  apiRequestBurst: Schema.optional(limitValue("apiRequestBurst")),
  apiRequestsPerSecond: Schema.optional(limitValue("apiRequestsPerSecond")),
  concurrentRuns: Schema.optional(limitValue("concurrentRuns")),
});

export const EffectiveTenantLimits = Schema.Struct({
  activeSandboxes: EffectiveTenantLimit("activeSandboxes"),
  apiRequestBurst: EffectiveTenantLimit("apiRequestBurst"),
  apiRequestsPerSecond: EffectiveTenantLimit("apiRequestsPerSecond"),
  concurrentRuns: EffectiveTenantLimit("concurrentRuns"),
});

export const OrganizationLimitsResponse = Schema.Struct({
  effective: EffectiveTenantLimits,
  organizationId: PublicId,
});
