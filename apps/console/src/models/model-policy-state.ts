import type {
  CreateModelPolicyRequest,
  ModelPolicyResponse,
  UpdateModelPolicyRequest,
} from "@deployments-ai/api-contract/models";

export interface ModelPolicyDraft {
  readonly name: string;
  readonly description: string;
  readonly includeCuratedModels: boolean;
  readonly entries: string;
}

export interface ModelPolicyRulesInput {
  readonly includeCuratedModels: boolean;
  readonly models: readonly string[];
}

export type NextRules = ModelPolicyRulesInput | null;

export type PolicyTransition =
  | { readonly kind: "create"; readonly body: CreateModelPolicyRequest }
  | {
      readonly kind: "update";
      readonly policyId: string;
      readonly expectedVersion: number;
      readonly patch: Omit<UpdateModelPolicyRequest, "expectedVersion">;
    };

export function draftFrom(policy: ModelPolicyResponse | undefined): ModelPolicyDraft {
  return policy
    ? {
        description: policy.description ?? "",
        entries: policy.models.join("\n"),
        includeCuratedModels: policy.includeCuratedModels,
        name: policy.name,
      }
    : { description: "", entries: "", includeCuratedModels: true, name: "" };
}

export function draftRules(draft: ModelPolicyDraft): ModelPolicyRulesInput {
  return {
    includeCuratedModels: draft.includeCuratedModels,
    models: draft.entries
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  };
}

/** An empty description goes out as `""`: the API keeps the previous one when it is omitted. */
export function policyTransition(
  active: ModelPolicyResponse | undefined,
  draft: ModelPolicyDraft,
): PolicyTransition {
  const rules = draftRules(draft);
  const name = draft.name.trim();
  const description = draft.description.trim();
  if (!active) {
    return {
      body: { ...rules, models: [...rules.models], name, ...(description ? { description } : {}) },
      kind: "create",
    };
  }
  const modelsChanged =
    rules.models.length !== active.models.length ||
    rules.models.some((entry, index) => entry !== active.models[index]);
  return {
    expectedVersion: active.version,
    kind: "update",
    patch: {
      ...(name === active.name ? {} : { name }),
      ...(description === (active.description ?? "") ? {} : { description }),
      ...(rules.includeCuratedModels === active.includeCuratedModels
        ? {}
        : { includeCuratedModels: rules.includeCuratedModels }),
      ...(modelsChanged ? { models: [...rules.models] } : {}),
    },
    policyId: active.id,
  };
}
