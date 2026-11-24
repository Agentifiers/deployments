import { describe, expect, test as it } from "bun:test";

import {
  admitModel,
  chatCompletionServedModelId,
  CURATED_DEFAULT_MODEL_POLICY,
  modelProviderForId,
  modelUsageLedgerEntry,
  normalizeModelId,
  providerModelIdForModelId,
  resolveModelRoute,
} from "./index.ts";

const HAIKU = "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0";
const NOVA = "bedrock/amazon.nova-micro-v1:0";
const scope = { agentId: "agent_1", organizationId: "org_1", runId: "run_1" };

describe("Bedrock model routing", () => {
  it("normalizes foundation model and inference profile ids under the bedrock prefix", () => {
    expect(normalizeModelId("Bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe(HAIKU);
    expect(normalizeModelId(` ${NOVA} `)).toBe(NOVA);
    expect(modelProviderForId(HAIKU)).toBe("bedrock");
    expect(providerModelIdForModelId(HAIKU)).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(() => normalizeModelId("bedrock")).toThrow("Provider-only model ids");
    expect(() => normalizeModelId("bedrock/")).toThrow("missing the foundation model");
    expect(() =>
      normalizeModelId("bedrock/arn:aws:bedrock:us-east-2:123456789012:inference-profile/x"),
    ).toThrow("ARNs are not supported");
  });

  it("routes Bedrock models under their provider", () => {
    expect(resolveModelRoute({ fallbackModelIds: [NOVA], modelId: HAIKU })).toEqual({
      bifrostModelId: HAIKU,
      fallbackModelIds: [NOVA],
      modelId: HAIKU,
      provider: "bedrock",
      providerModelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      requestedModelId: HAIKU,
    });
  });

  it("admits an uncataloged Bedrock model only through an explicit operator grant", () => {
    const grants = [
      {
        agentId: "agent_1",
        allowedModels: [NOVA],
        organizationId: "org_1",
        providers: ["bedrock"],
      },
    ] as const;
    const emptyCatalog = { has: () => false };
    expect(
      admitModel(NOVA, CURATED_DEFAULT_MODEL_POLICY, emptyCatalog, { grants, scope }),
    ).toMatchObject({ allowed: true, basis: "operator-grant", modelId: NOVA });
    expect(
      admitModel(HAIKU, CURATED_DEFAULT_MODEL_POLICY, emptyCatalog, { grants, scope }),
    ).toMatchObject({ allowed: false, reason: "model_not_allowed_by_environment_policy" });
  });

  it("qualifies the served Bedrock model reported by Bifrost", () => {
    const route = resolveModelRoute({ fallbackModelIds: [NOVA], modelId: HAIKU });
    expect(
      chatCompletionServedModelId(
        {
          extra_fields: { model_requested: "amazon.nova-micro-v1:0", provider: "bedrock" },
          model: "amazon.nova-micro-v1:0",
        },
        route,
      ),
    ).toBe(NOVA);
  });
});

describe("Bedrock usage metering", () => {
  it("meters Bedrock calls from catalog prices with Bifrost's cache token details", () => {
    // Bifrost folds Converse cache reads and writes into prompt_tokens and reports them separately.
    const entry = modelUsageLedgerEntry({
      payer: { kind: "operator" },
      catalogPricing: {
        cacheReadUsdPerMillionTokens: 0.11,
        cacheWriteUsdPerMillionTokens: 1.375,
        inputUsdPerMillionTokens: 1.1,
        outputUsdPerMillionTokens: 5.5,
      },
      modelCallId: "call-1",
      modelId: HAIKU,
      provider: "bedrock",
      response: {
        usage: {
          completion_tokens: 50,
          prompt_tokens: 1_300,
          prompt_tokens_details: { cached_read_tokens: 1_000, cached_write_tokens: 200 },
          total_tokens: 1_350,
        },
      },
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
    });

    expect(entry).toMatchObject({
      cacheWriteInputTokens: 200,
      cachedInputTokens: 1_000,
      // 100 uncached × 1.1 + 1,000 reads × 0.11 + 200 writes × 1.375 + 50 output × 5.5 (per 1M).
      costUsdMicros: 770,
      costUsdNanoDollars: 770_000,
      inputTokens: 1_300,
      modelId: HAIKU,
      outputTokens: 50,
      provider: "bedrock",
      quantity: 1_350,
      source: `bifrost:${HAIKU}`,
    });
  });
});
