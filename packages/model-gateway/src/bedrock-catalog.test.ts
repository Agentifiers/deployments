import { describe, expect, it } from "bun:test";
import {
  bedrockModelCandidates,
  parseBedrockModelCatalog,
  type BedrockFoundationModelAvailability,
  type BedrockFoundationModelSummary,
  type BedrockInferenceProfileSummary,
} from "./bedrock-catalog.ts";

function foundationModel(
  modelId: string,
  overrides: Partial<BedrockFoundationModelSummary> = {},
): BedrockFoundationModelSummary {
  return {
    inferenceTypesSupported: ["ON_DEMAND"],
    inputModalities: ["TEXT"],
    modelId,
    modelLifecycle: { status: "ACTIVE" },
    modelName: modelId,
    outputModalities: ["TEXT"],
    responseStreamingSupported: true,
    ...overrides,
  };
}

function inferenceProfile(
  inferenceProfileId: string,
  foundationModelId: string,
  overrides: Partial<BedrockInferenceProfileSummary> = {},
): BedrockInferenceProfileSummary {
  return {
    inferenceProfileId,
    inferenceProfileName: `Profile ${foundationModelId}`,
    models: [
      { modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${foundationModelId}` },
      { modelArn: `arn:aws:bedrock:us-east-2::foundation-model/${foundationModelId}` },
    ],
    status: "ACTIVE",
    type: "SYSTEM_DEFINED",
    ...overrides,
  };
}

const available: BedrockFoundationModelAvailability = {
  // Models without a marketplace agreement report NOT_AVAILABLE yet are invocable.
  agreementAvailability: { status: "NOT_AVAILABLE" },
  authorizationStatus: "AUTHORIZED",
  entitlementAvailability: "AVAILABLE",
  regionAvailability: "AVAILABLE",
};

function chat(fields: Readonly<Record<string, unknown>> = {}) {
  return {
    input_cost_per_token: 3.5e-8,
    max_input_tokens: 128_000,
    mode: "chat",
    output_cost_per_token: 1.4e-7,
    provider: "bedrock",
    ...fields,
  };
}

const HAIKU = "anthropic.claude-haiku-4-5-20251001-v1:0";
const NOVA = "amazon.nova-micro-v1:0";

describe("bedrock model candidates", () => {
  it("admits on-demand text models and profiles of live regional models", () => {
    const result = bedrockModelCandidates(
      [
        foundationModel(NOVA),
        foundationModel(HAIKU, {
          inferenceTypesSupported: ["INFERENCE_PROFILE"],
          inputModalities: ["TEXT", "IMAGE"],
        }),
        foundationModel("amazon.titan-embed-text-v2:0", { outputModalities: ["EMBEDDING"] }),
        foundationModel("acme.legacy-v1:0", { modelLifecycle: { status: "LEGACY" } }),
        foundationModel("acme.batch-v1:0", { responseStreamingSupported: false }),
      ],
      [
        inferenceProfile(`us.${HAIKU}`, HAIKU, { inferenceProfileName: "US Claude Haiku 4.5" }),
        inferenceProfile(`global.${HAIKU}`, HAIKU),
        // End-of-life model: the profile stays ACTIVE but the region no longer lists the model.
        inferenceProfile(
          "us.anthropic.claude-3-haiku-20240307-v1:0",
          "anthropic.claude-3-haiku-20240307-v1:0",
        ),
        inferenceProfile("us.acme.legacy-v1:0", "acme.legacy-v1:0"),
        inferenceProfile(`us.${NOVA}`, NOVA, { status: "INACTIVE" }),
        inferenceProfile(`apac.${NOVA}`, NOVA, { type: "APPLICATION" }),
        inferenceProfile(`eu.${NOVA}`, NOVA, {
          models: [
            { modelArn: `arn:aws:bedrock:eu-west-1::foundation-model/${NOVA}` },
            { modelArn: `arn:aws:bedrock:eu-west-1::foundation-model/${HAIKU}` },
          ],
        }),
      ],
    );

    expect(result.candidates).toEqual([
      {
        displayName: NOVA,
        foundationModelId: NOVA,
        imageInput: false,
        modelId: `bedrock/${NOVA}`,
        providerModelId: NOVA,
      },
      {
        displayName: `Profile ${HAIKU}`,
        foundationModelId: HAIKU,
        imageInput: true,
        modelId: `bedrock/global.${HAIKU}`,
        providerModelId: `global.${HAIKU}`,
      },
      {
        displayName: "US Claude Haiku 4.5",
        foundationModelId: HAIKU,
        imageInput: true,
        modelId: `bedrock/us.${HAIKU}`,
        providerModelId: `us.${HAIKU}`,
      },
    ]);
    expect(result.foundationModelIds).toEqual([NOVA, HAIKU].toSorted());
  });
});

describe("bedrock model catalog", () => {
  const foundationModels = [
    foundationModel(NOVA),
    foundationModel(HAIKU, {
      inferenceTypesSupported: ["INFERENCE_PROFILE"],
      inputModalities: ["TEXT", "IMAGE"],
    }),
  ];
  const inferenceProfiles = [inferenceProfile(`us.${HAIKU}`, HAIKU)];

  it("joins account availability with datasheet metadata and prices", () => {
    const catalog = parseBedrockModelCatalog({
      availability: new Map([
        [NOVA, available],
        [HAIKU, available],
      ]),
      datasheet: {
        [NOVA]: chat({ cache_read_input_token_cost: 8.75e-9, max_output_tokens: 10_000 }),
        [`bedrock/us-east-2/${NOVA}`]: chat({
          input_cost_per_token: 4e-8,
          max_input_tokens: 64_000,
        }),
        [`bedrock/us-west-2/${NOVA}`]: chat({ input_cost_per_token: 9e-8 }),
        [`us.${HAIKU}`]: chat({
          cache_creation_input_token_cost: 0.00000125,
          cache_creation_input_token_cost_above_1hr: 0.000002,
          cache_read_input_token_cost: 1e-7,
          input_cost_per_token: 0.000001,
          input_cost_per_token_batches: 5e-7,
          max_input_tokens: 200_000,
          max_output_tokens: 64_000,
          output_cost_per_token: 0.000005,
          supports_function_calling: true,
          supports_reasoning: true,
          supports_response_schema: true,
        }),
      },
      foundationModels,
      inferenceProfiles,
      region: "us-east-2",
    });

    expect(catalog.skippedModelIds).toEqual([]);
    expect(catalog.entries).toEqual([
      {
        capabilities: {
          imageInput: false,
          reasoning: false,
          structuredOutputs: false,
          toolCalling: false,
        },
        contextWindowTokens: 64_000,
        displayName: NOVA,
        modelId: `bedrock/${NOVA}`,
        pricing: { inputUsdPerMillionTokens: 0.04, outputUsdPerMillionTokens: 0.14 },
        provider: "bedrock",
        providerModelId: NOVA,
      },
      {
        capabilities: {
          imageInput: true,
          reasoning: true,
          structuredOutputs: true,
          toolCalling: true,
        },
        contextWindowTokens: 200_000,
        displayName: `Profile ${HAIKU}`,
        maximumOutputTokens: 64_000,
        modelId: `bedrock/us.${HAIKU}`,
        pricing: {
          cacheReadUsdPerMillionTokens: 0.1,
          cacheWriteUsdPerMillionTokens: 1.25,
          inputUsdPerMillionTokens: 1,
          outputUsdPerMillionTokens: 5,
        },
        provider: "bedrock",
        providerModelId: `us.${HAIKU}`,
      },
    ]);
  });

  it("falls back to the unscoped datasheet entry and converts sci-notation prices", () => {
    const catalog = parseBedrockModelCatalog({
      availability: new Map([[NOVA, available]]),
      datasheet: {
        [NOVA]: chat({ cache_read_input_token_cost: 8.75e-9, max_output_tokens: 10_000 }),
        [`bedrock/us-east-2/${NOVA}`]: { ...chat(), mode: "embedding" },
      },
      foundationModels: [foundationModel(NOVA)],
      inferenceProfiles: [],
      region: "us-east-2",
    });

    expect(catalog.entries[0]).toMatchObject({
      contextWindowTokens: 128_000,
      maximumOutputTokens: 10_000,
      pricing: {
        cacheReadUsdPerMillionTokens: 0.00875,
        inputUsdPerMillionTokens: 0.035,
        outputUsdPerMillionTokens: 0.14,
      },
    });
  });

  it("maps long-context prices to cumulative tiers above the published threshold", () => {
    const catalog = parseBedrockModelCatalog({
      availability: new Map([[NOVA, available]]),
      datasheet: {
        [NOVA]: chat({
          cache_read_input_token_cost: 3e-7,
          cache_read_input_token_cost_above_200k_tokens: 6e-7,
          cache_read_input_token_cost_above_272k_tokens_ultrafast: 1e-6,
          input_cost_per_token: 0.000003,
          input_cost_per_token_above_200k_tokens: 0.000006,
          input_cost_per_token_above_272k_tokens: 0.000009,
          max_input_tokens: 1_000_000,
          output_cost_per_token: 0.000015,
          output_cost_per_token_above_200k_tokens: 0.0000225,
        }),
      },
      foundationModels: [foundationModel(NOVA)],
      inferenceProfiles: [],
      region: "us-east-2",
    });

    expect(catalog.entries[0]?.pricing).toEqual({
      cacheReadUsdPerMillionTokens: 0.3,
      inputUsdPerMillionTokens: 3,
      outputUsdPerMillionTokens: 15,
      tiers: [
        {
          cacheReadUsdPerMillionTokens: 0.6,
          inputUsdPerMillionTokens: 6,
          minPromptTokens: 200_001,
          outputUsdPerMillionTokens: 22.5,
        },
        {
          cacheReadUsdPerMillionTokens: 0.6,
          inputUsdPerMillionTokens: 9,
          minPromptTokens: 272_001,
          outputUsdPerMillionTokens: 22.5,
        },
      ],
    });
  });

  it("admits bare Mantle-family ids only when Mantle serves that exact id", () => {
    // Bifrost v1.10.1 (core providers/bedrock isMantleModel) sends bare OpenAI-family, Grok, and
    // Gemma 4 ids to bedrock-mantle, where `openai.gpt-oss-20b-1:0` 404s (Mantle names it
    // `openai.gpt-oss-20b`); region-prefixed profile ids always use bedrock-runtime.
    const GPT_OSS = "openai.gpt-oss-20b-1:0";
    const SAFEGUARD = "openai.gpt-oss-safeguard-20b";
    const GEMMA = "google.gemma-4-31b";
    const GROK = "xai.grok-4.6";
    const ASTRA = "openai.gpt-6-astra";
    const mantle = (fields: Readonly<Record<string, unknown>> = {}) =>
      chat({ provider: "bedrock_mantle", ...fields });
    const catalog = parseBedrockModelCatalog({
      availability: new Map(
        [GPT_OSS, SAFEGUARD, GEMMA, GROK, ASTRA].map((id) => [id, available] as const),
      ),
      datasheet: {
        [GPT_OSS]: chat(),
        [`us.${GPT_OSS}`]: chat({ max_input_tokens: 131_072 }),
        [SAFEGUARD]: chat({ max_input_tokens: 131_072 }),
        [`bedrock_mantle/${SAFEGUARD}`]: mantle({ max_input_tokens: 64_000 }),
        [`bedrock_mantle/${GEMMA}`]: mantle({ max_input_tokens: 256_000 }),
        [`bedrock_mantle/${GROK}`]: { ...mantle(), mode: "responses" },
        // Responses-only models stay out of the chat catalog.
        [`us.${ASTRA}`]: { ...chat(), mode: "responses" },
      },
      foundationModels: [
        foundationModel(GPT_OSS),
        foundationModel(SAFEGUARD),
        foundationModel(GEMMA),
        foundationModel(GROK),
        foundationModel(ASTRA, { inferenceTypesSupported: ["INFERENCE_PROFILE"] }),
      ],
      inferenceProfiles: [
        inferenceProfile(`us.${GPT_OSS}`, GPT_OSS),
        inferenceProfile(`us.${ASTRA}`, ASTRA),
      ],
      region: "us-east-2",
    });

    expect(
      catalog.entries.map((entry) => [entry.providerModelId, entry.contextWindowTokens]),
    ).toEqual([
      [GEMMA, 256_000],
      [SAFEGUARD, 131_072],
      [`us.${GPT_OSS}`, 131_072],
    ]);
    expect(catalog.skippedModelIds.toSorted()).toEqual([GPT_OSS, GROK, `us.${ASTRA}`].toSorted());
  });

  it("skips candidates the account cannot invoke or the datasheet does not price", () => {
    const ids = ["acme.a-v1:0", "acme.b-v1:0", "acme.c-v1:0", "acme.d-v1:0", "acme.e-v1:0"];
    const catalog = parseBedrockModelCatalog({
      availability: new Map([
        ["acme.a-v1:0", { ...available, agreementAvailability: { status: "PENDING" } }],
        ["acme.b-v1:0", { ...available, authorizationStatus: "NOT_AUTHORIZED" }],
        ["acme.c-v1:0", available],
        ["acme.d-v1:0", available],
        [NOVA, available],
      ]),
      datasheet: {
        "acme.a-v1:0": chat(),
        "acme.b-v1:0": chat(),
        "acme.c-v1:0": chat({ output_cost_per_token: undefined }),
        "acme.d-v1:0": chat({ max_input_tokens: 0 }),
        "acme.e-v1:0": chat(),
        [NOVA]: { ...chat(), provider: "openai" },
      },
      foundationModels: [...ids, NOVA].map((id) => foundationModel(id)),
      inferenceProfiles: [],
      region: "us-east-2",
    });

    expect(catalog.entries).toEqual([]);
    expect(catalog.skippedModelIds).toEqual([...ids, NOVA]);
  });

  it("rejects a datasheet that is not an object", () => {
    expect(() =>
      parseBedrockModelCatalog({
        availability: new Map(),
        datasheet: [],
        foundationModels: [],
        inferenceProfiles: [],
        region: "us-east-2",
      }),
    ).toThrow(TypeError);
  });
});
