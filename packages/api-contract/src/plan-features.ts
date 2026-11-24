import { Schema } from "effect";

/**
 * Features a plan can turn off. `sso` is identity federation and login domains; `scim` is
 * directory sync. Every install default enables every feature, so an install that never grants
 * one is unchanged.
 */
export const PLAN_FEATURES = ["scim", "sso"] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];

/** A grant names only the features it decides; an absent key leaves it to the next source. */
export const PlanFeatureGrant = Schema.Struct({
  scim: Schema.optional(Schema.Boolean),
  sso: Schema.optional(Schema.Boolean),
}).annotate({ description: "Features this grant enables (true) or disables (false)." });

export const PlanFeatureValues = Schema.Struct({
  scim: Schema.Boolean,
  sso: Schema.Boolean,
}).annotate({ description: "Whether each plan feature is enabled for the organization." });
export type PlanFeatureValues = typeof PlanFeatureValues.Type;

export const ALL_PLAN_FEATURES: PlanFeatureValues = { scim: true, sso: true };

/** The organization admin routes each feature gates. Reads stay open so members see the setup. */
export const PLAN_FEATURE_ROUTES = {
  scim: ["putDirectory", "createDirectoryToken"],
  sso: ["addLoginDomain", "verifyLoginDomain", "putIdentityProvider", "setIdentityProviderState"],
} as const satisfies Readonly<Record<PlanFeature, readonly string[]>>;

export type PlanGatedRoute = (typeof PLAN_FEATURE_ROUTES)[PlanFeature][number];

/** The feature a route needs, or undefined when no plan feature gates it. */
export function planFeatureOfRoute(routeName: string): PlanFeature | undefined {
  return PLAN_FEATURES.find((feature) =>
    (PLAN_FEATURE_ROUTES[feature] as readonly string[]).includes(routeName),
  );
}

export const FEATURE_NOT_IN_PLAN_TYPE = "https://docs.deployments.ai/errors/feature-not-in-plan";

export const FeatureNotInPlanProblem = Schema.Struct({
  code: Schema.Literal("feature_not_in_plan"),
  detail: Schema.String,
  feature: Schema.Literals(PLAN_FEATURES),
  requestId: Schema.String,
  status: Schema.Literal(403),
  title: Schema.String,
  type: Schema.Literal(FEATURE_NOT_IN_PLAN_TYPE),
}).annotate({
  description:
    "Refusal of a change that needs a plan feature the organization does not have. Removing and revoking stay allowed.",
});
