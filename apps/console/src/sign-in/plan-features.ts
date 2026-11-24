import { PLAN_FEATURE_ROUTES, type PlanFeature } from "@deployments-ai/api-contract/plan-features";
import type { OperationAccess } from "../access.ts";

export type PlanFeatures = Readonly<Record<PlanFeature, boolean>>;

/**
 * Access with the routes of each feature the plan leaves out switched off, so the Sign-in panels
 * hide the actions the API would refuse with `feature_not_in_plan`. Reads, removals, and
 * revocations stay, so an organization that lost a feature can still see and undo its setup.
 */
export function planAccess(access: OperationAccess, features: PlanFeatures): OperationAccess {
  const blocked = new Set<string>(
    (Object.keys(PLAN_FEATURE_ROUTES) as PlanFeature[]).flatMap((feature) =>
      features[feature] ? [] : PLAN_FEATURE_ROUTES[feature],
    ),
  );
  return Object.fromEntries(
    Object.entries(access).map(([operation, allowed]) => [
      operation,
      allowed && !blocked.has(operation),
    ]),
  ) as OperationAccess;
}
