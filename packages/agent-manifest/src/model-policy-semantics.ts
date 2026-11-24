import type { AgentManifestV1 } from "./schema.ts";
import type { AgentManifestSemanticIssue } from "./semantics.ts";

/**
 * The environment's decision for one model reference. Environment policy and catalog state live
 * outside the manifest, so callers evaluate them and this module only maps decisions to issues.
 */
export type AgentManifestModelDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string; readonly message: string };

/**
 * Checks the primary and fallback models of a manifest against an environment's model policy.
 * Issue codes are the decision codes, for example `model_not_allowed_by_environment_policy`.
 */
export function agentManifestModelPolicyIssues(
  manifest: AgentManifestV1,
  decide: (modelId: string) => AgentManifestModelDecision,
): AgentManifestSemanticIssue[] {
  const references = [
    { modelId: manifest.spec.model.id, path: "/spec/model/id" },
    ...(manifest.spec.model.fallbackIds ?? []).map((modelId, index) => ({
      modelId,
      path: `/spec/model/fallbackIds/${index}`,
    })),
  ];
  return references.flatMap(({ modelId, path }) => {
    const decision = decide(modelId);
    return decision.allowed ? [] : [{ code: decision.code, message: decision.message, path }];
  });
}
