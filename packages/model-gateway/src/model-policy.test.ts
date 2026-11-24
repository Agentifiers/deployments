import { describe, expect, it } from "bun:test";
import {
  admitModel,
  admitModelReferences,
  admittedModelIds,
  agentModelGrantScope,
  catalogLookupModelIds,
  CURATED_DEFAULT_MODEL_POLICY,
  effectiveModelPolicy,
  modelPolicyRuleIssues,
  parseModelPolicyEntry,
  type EffectiveModelPolicy,
  type OperatorModelGrants,
} from "./model-policy.ts";
import { DEFAULT_AGENT_MODEL_ID } from "./types.ts";

const BEDROCK_HAIKU = "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0";
const catalogIds = new Set(["openrouter/anthropic/claude-sonnet-4.6", "openai/o3", BEDROCK_HAIKU]);
const catalog = { has: (modelId: string) => catalogIds.has(modelId) };

function policy(models: readonly string[], includeCuratedModels = false): EffectiveModelPolicy {
  return {
    modelPolicyId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
    rules: { includeCuratedModels, models },
    source: "model-policy",
  };
}

describe("model policy admission", () => {
  it("keeps the curated models as the default policy", () => {
    expect(admitModel(DEFAULT_AGENT_MODEL_ID, CURATED_DEFAULT_MODEL_POLICY, catalog)).toEqual({
      allowed: true,
      basis: "environment-policy",
      curated: true,
      modelId: DEFAULT_AGENT_MODEL_ID,
    });
    expect(admitModel("qwen/qwen3.7-plus", CURATED_DEFAULT_MODEL_POLICY, catalog)).toMatchObject({
      allowed: true,
      modelId: "openrouter/qwen/qwen3.7-plus",
    });
    expect(
      admitModel("openrouter/anthropic/claude-sonnet-4.6", CURATED_DEFAULT_MODEL_POLICY, catalog),
    ).toMatchObject({ allowed: false, reason: "model_not_allowed_by_environment_policy" });
  });

  it("admits the curated Bedrock global profiles without a policy or catalog entry", () => {
    for (const modelId of [
      "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
      "bedrock/global.cohere.embed-v4:0",
    ]) {
      expect(admitModel(modelId, CURATED_DEFAULT_MODEL_POLICY, catalog)).toEqual({
        allowed: true,
        basis: "environment-policy",
        curated: true,
        modelId,
      });
    }
  });

  it("allows provider-wide and exact entries only for active catalog models", () => {
    const providerWide = policy(["openrouter/*"]);
    expect(admitModel("openrouter/anthropic/claude-sonnet-4.6", providerWide, catalog)).toEqual({
      allowed: true,
      basis: "environment-policy",
      curated: false,
      modelId: "openrouter/anthropic/claude-sonnet-4.6",
    });
    expect(admitModel("openrouter/vendor/retired", providerWide, catalog)).toMatchObject({
      allowed: false,
      reason: "model_not_in_catalog",
    });
    expect(admitModel("openai/o3", providerWide, catalog)).toMatchObject({
      allowed: false,
      reason: "model_not_allowed_by_environment_policy",
    });
    expect(admitModel("openai/o3", policy(["openai/o3"]), catalog)).toMatchObject({
      allowed: true,
    });
    expect(admitModel(DEFAULT_AGENT_MODEL_ID, policy(["openai/o3"]), catalog)).toMatchObject({
      allowed: false,
      reason: "model_not_allowed_by_environment_policy",
    });
    expect(admitModel(DEFAULT_AGENT_MODEL_ID, policy(["openai/o3"], true), catalog)).toMatchObject({
      allowed: true,
      curated: true,
    });
  });

  it("admits Bedrock models only through the policy and the account's synchronized catalog", () => {
    expect(admitModel(BEDROCK_HAIKU, CURATED_DEFAULT_MODEL_POLICY, catalog)).toMatchObject({
      allowed: false,
      reason: "model_not_allowed_by_environment_policy",
    });
    expect(admitModel(BEDROCK_HAIKU, policy(["bedrock/*"]), catalog)).toEqual({
      allowed: true,
      basis: "environment-policy",
      curated: false,
      modelId: BEDROCK_HAIKU,
    });
    // A model the account has not enabled never enters the catalog, so admission names the gap.
    expect(
      admitModel("bedrock/anthropic.claude-opus-4-1-20250805-v1:0", policy(["bedrock/*"]), catalog),
    ).toMatchObject({
      allowed: false,
      message:
        "Model bedrock/anthropic.claude-opus-4-1-20250805-v1:0 is not an active entry in the platform model catalog.",
      reason: "model_not_in_catalog",
    });
    expect(admitModel("openai/o3", policy(["bedrock/*"]), catalog)).toMatchObject({
      reason: "model_not_allowed_by_environment_policy",
    });
  });

  it("rejects unknown provider prefixes and malformed ids", () => {
    expect(
      admitModel("anthropic/claude-sonnet-4.6", policy(["openrouter/*"]), catalog),
    ).toMatchObject({ allowed: false, reason: "unknown_model_provider" });
    expect(admitModel("vertex/claude", CURATED_DEFAULT_MODEL_POLICY, catalog)).toMatchObject({
      reason: "unknown_model_provider",
    });
    expect(
      admitModel(
        "bedrock/arn:aws:bedrock:us-east-2:123456789012:application-inference-profile/abc",
        policy(["bedrock/*"]),
        catalog,
      ),
    ).toMatchObject({ reason: "invalid_model_id" });
    expect(admitModel("openrouter/", policy(["openrouter/*"]), catalog)).toMatchObject({
      reason: "invalid_model_id",
    });
    expect(
      catalogLookupModelIds(["openrouter/x/y", "anthropic/z", DEFAULT_AGENT_MODEL_ID]),
    ).toEqual(["openrouter/x/y", "openrouter/qwen/qwen3.7-plus"]);
  });
});

describe("model policy entries", () => {
  it("parses canonical ids and hosted provider wildcards only", () => {
    expect(parseModelPolicyEntry("openrouter/*")).toEqual({
      kind: "provider",
      provider: "openrouter",
    });
    expect(parseModelPolicyEntry("openai/o3")).toEqual({ kind: "model", modelId: "openai/o3" });
    expect(parseModelPolicyEntry("bedrock/*")).toEqual({ kind: "provider", provider: "bedrock" });
    expect(parseModelPolicyEntry(BEDROCK_HAIKU)).toEqual({ kind: "model", modelId: BEDROCK_HAIKU });
    expect(() => parseModelPolicyEntry("vertex/*")).toThrow("supported provider prefix");
    expect(() => parseModelPolicyEntry("gpt-4o")).toThrow("supported provider prefix");
    expect(() => parseModelPolicyEntry("openrouter/anthropic/*")).toThrow("Provider-wide");
    expect(() => parseModelPolicyEntry("openrouter/anthropic/claude-*")).toThrow(
      "whole provider suffix",
    );
    expect(() => parseModelPolicyEntry(" openai/o3")).toThrow("trimmed");
  });

  it("reports repeated, unknown, and empty rule sets", () => {
    expect(
      modelPolicyRuleIssues(
        {
          includeCuratedModels: false,
          models: [
            "openai/o3",
            "openai/o3",
            "openrouter/vendor/unknown",
            "openrouter/*",
            DEFAULT_AGENT_MODEL_ID,
          ],
        },
        catalog,
      ),
    ).toEqual([
      { entry: "openai/o3", message: "Model policy entry openai/o3 is repeated." },
      {
        entry: "openrouter/vendor/unknown",
        message: "Model openrouter/vendor/unknown is not in the platform model catalog.",
      },
    ]);
    expect(modelPolicyRuleIssues({ includeCuratedModels: false, models: [] }, catalog)).toEqual([
      {
        entry: "",
        message: "A model policy that excludes the curated models must allow at least one model.",
      },
    ]);
  });
});

describe("model reference admission", () => {
  const pricing = { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 };
  const entries = new Map([
    [
      "openrouter/anthropic/claude-sonnet-4.6",
      {
        capabilities: { imageInput: true },
        contextWindowTokens: 200_000,
        maximumOutputTokens: 64_000,
        modelId: "openrouter/anthropic/claude-sonnet-4.6",
        pricing,
        status: "active" as const,
      },
    ],
    [
      "openrouter/vendor/retired",
      {
        capabilities: { imageInput: true },
        contextWindowTokens: 8_000,
        modelId: "openrouter/vendor/retired",
        pricing,
        status: "retired" as const,
      },
    ],
  ]);

  it("returns runtime catalog metadata only for admitted non-curated models", () => {
    const policy = effectiveModelPolicy({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
      includeCuratedModels: true,
      models: ["openrouter/*"],
    });
    const result = admitModelReferences(
      [
        "openrouter/anthropic/claude-sonnet-4.6",
        DEFAULT_AGENT_MODEL_ID,
        "openrouter/vendor/retired",
      ],
      policy,
      entries,
    );
    expect(result.admissions.map((admission) => admission.allowed)).toEqual([true, true, false]);
    expect(result.admissions[2]).toMatchObject({ reason: "model_not_in_catalog" });
    expect(result.modelCatalog).toEqual({
      "openrouter/anthropic/claude-sonnet-4.6": {
        contextWindowTokens: 200_000,
        maximumOutputTokens: 64_000,
        pricing,
      },
    });
    expect(result.imageInput).toEqual(
      new Map([
        ["openrouter/anthropic/claude-sonnet-4.6", "supported"],
        [DEFAULT_AGENT_MODEL_ID, "supported"],
        ["openrouter/vendor/retired", "unknown"],
      ]),
    );
    expect(effectiveModelPolicy(undefined)).toBe(CURATED_DEFAULT_MODEL_POLICY);
  });
});

describe("operator grant admission", () => {
  const uncataloged = "openrouter/vendor/operator-granted";
  const openAiGranted = "openai/gpt-4o";
  const scope = agentModelGrantScope({ agentDefinitionId: "agent_1", organizationId: "org_1" });
  const grants = (...operatorGrants: OperatorModelGrants["grants"]): OperatorModelGrants => ({
    grants: operatorGrants,
    scope,
  });

  it("admits a model the agent's grant lists, outside policy and catalog, on any provider", () => {
    const granted = grants(
      { agentId: "agent_1", allowedModels: [uncataloged], organizationId: "org_1" },
      {
        agentId: "agent_1",
        allowedModels: [openAiGranted],
        organizationId: "org_1",
        providers: ["openai"],
      },
    );
    expect(admitModel(uncataloged, CURATED_DEFAULT_MODEL_POLICY, catalog, granted)).toEqual({
      allowed: true,
      basis: "operator-grant",
      curated: false,
      modelId: uncataloged,
    });
    expect(admitModel(openAiGranted, policy(["openai/o3"]), catalog, granted)).toMatchObject({
      allowed: true,
      basis: "operator-grant",
    });
    expect(admitModel(uncataloged, CURATED_DEFAULT_MODEL_POLICY, catalog)).toMatchObject({
      reason: "model_not_allowed_by_environment_policy",
    });
    expect(
      admitModel(openAiGranted, policy(["openai/o3"]), catalog, {
        ...granted,
        scope: agentModelGrantScope({ agentDefinitionId: "agent_2", organizationId: "org_1" }),
      }),
    ).toMatchObject({ reason: "model_not_allowed_by_environment_policy" });
  });

  it("follows the most specific grant scope and ignores default curated allowances", () => {
    // The most specific matching grant decides, so an agent grant that omits the model shadows
    // an organization grant that lists it.
    const shadowed = grants(
      { allowedModels: [uncataloged], organizationId: "org_1" },
      { agentId: "agent_1", allowedModels: ["openai/gpt-5.2"], organizationId: "org_1" },
    );
    expect(admitModel(uncataloged, CURATED_DEFAULT_MODEL_POLICY, catalog, shadowed)).toMatchObject({
      allowed: false,
    });
    expect(
      admitModel(
        uncataloged,
        CURATED_DEFAULT_MODEL_POLICY,
        catalog,
        grants({ allowedModels: [uncataloged], organizationId: "org_1" }),
      ),
    ).toMatchObject({ allowed: true });
    // `*` and absent allowedModels route the curated defaults; they grant nothing beyond them.
    expect(
      admitModel(
        DEFAULT_AGENT_MODEL_ID,
        policy(["openai/o3"]),
        catalog,
        grants({ agentId: "agent_1", allowedModels: ["*"], organizationId: "org_1" }),
      ),
    ).toMatchObject({ reason: "model_not_allowed_by_environment_policy" });
  });

  it("records the policy as the basis when the policy also admits a granted model", () => {
    const granted = grants({
      agentId: "agent_1",
      allowedModels: ["openai/o3", uncataloged],
      organizationId: "org_1",
      providers: ["openai", "openrouter"],
    });
    const { admissions } = admitModelReferences(
      ["openai/o3", uncataloged, "openai/o3"],
      policy(["openai/o3"]),
      new Map(),
      granted,
    );
    expect(admissions.map((admission) => admission.allowed && admission.basis)).toEqual([
      "operator-grant",
      "operator-grant",
      "operator-grant",
    ]);
    const cataloged = admitModel("openai/o3", policy(["openai/o3"]), catalog, granted);
    expect(cataloged).toMatchObject({ allowed: true, basis: "environment-policy" });
    expect(
      admittedModelIds([
        cataloged,
        admitModel(uncataloged, CURATED_DEFAULT_MODEL_POLICY, catalog, granted),
        admitModel(DEFAULT_AGENT_MODEL_ID, CURATED_DEFAULT_MODEL_POLICY, catalog),
        admitModel(DEFAULT_AGENT_MODEL_ID, CURATED_DEFAULT_MODEL_POLICY, catalog),
        admitModel("openrouter/vendor/unknown", CURATED_DEFAULT_MODEL_POLICY, catalog),
      ]),
    ).toEqual(["openai/o3", uncataloged, DEFAULT_AGENT_MODEL_ID]);
  });

  it("returns catalog metadata for a granted model only from an active entry", () => {
    const result = admitModelReferences(
      ["openrouter/vendor/retired"],
      CURATED_DEFAULT_MODEL_POLICY,
      new Map([
        [
          "openrouter/vendor/retired",
          {
            capabilities: { imageInput: false },
            contextWindowTokens: 32_000,
            modelId: "openrouter/vendor/retired",
            pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 },
            status: "retired" as const,
          },
        ],
      ]),
      grants({ agentId: "agent_1", allowedModels: ["openrouter/vendor/retired"] }),
    );
    expect(result.admissions[0]).toMatchObject({ allowed: true });
    expect(result.modelCatalog).toEqual({});
  });
});
