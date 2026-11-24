import { describe, expect, it } from "bun:test";
import { makeModelCatalogPersistence } from "@deployments-ai/db";
import {
  BIFROST_DATASHEET_URL,
  OPENAI_MODELS_URL,
  OPENROUTER_MODELS_URL,
} from "@deployments-ai/model-gateway";
import { inMemoryDatabase } from "./agent-run.fixture.ts";
import {
  MODEL_CATALOG_MAX_RESPONSE_BYTES,
  MODEL_CATALOG_SYNC_ENV,
  ModelCatalogSyncError,
  modelCatalogSyncDependenciesFromEnvironment,
  modelCatalogSyncOptions,
  synchronizeModelCatalog,
  type BedrockModelCatalogReader,
  type ModelCatalogFetch,
  type ModelCatalogSyncDependencies,
} from "./model-catalog-sync-main.ts";

function openRouterModel(id: string, prompt = "0.0000025") {
  return {
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    context_length: 128_000,
    id,
    name: id,
    pricing: { completion: "0.00001", prompt },
    supported_parameters: ["tools", "structured_outputs"],
    top_provider: { max_completion_tokens: 16_384 },
  };
}

const openRouterBody = {
  data: [
    openRouterModel("openai/gpt-4.1-mini"),
    openRouterModel("acme/chat"),
    openRouterModel("acme/image-only", "0"),
    { ...openRouterModel("acme/no-text"), architecture: { output_modalities: ["image"] } },
  ],
};

interface RecordedRequest {
  readonly authorization: string | null;
  readonly url: string;
}

function jsonFetch(
  bodies: Readonly<Record<string, unknown>>,
  requests: RecordedRequest[] = [],
): ModelCatalogFetch {
  return async (url, init) => {
    requests.push({ authorization: new Headers(init.headers).get("authorization"), url });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = bodies[url];
    return body instanceof Response ? body : Response.json(body);
  };
}

const silent = { error: () => undefined, info: () => undefined };

function syncDependencies(
  fetcher: ModelCatalogFetch,
  overrides: Partial<ModelCatalogSyncDependencies> = {},
) {
  const memory = inMemoryDatabase([]);
  const catalog = makeModelCatalogPersistence(memory.database);
  const dependencies: ModelCatalogSyncDependencies = {
    catalog,
    fetch: fetcher,
    logger: silent,
    ...overrides,
  };
  return { catalog, dependencies };
}

const NOVA = "amazon.nova-micro-v1:0";
const HAIKU = "anthropic.claude-haiku-4-5-20251001-v1:0";

function bedrockReader(availabilityRequests: string[] = []): BedrockModelCatalogReader {
  const textModel = {
    inputModalities: ["TEXT"],
    modelLifecycle: { status: "ACTIVE" },
    outputModalities: ["TEXT"],
    responseStreamingSupported: true,
  };
  return {
    getFoundationModelAvailability: async (modelId) => {
      availabilityRequests.push(modelId);
      return {
        agreementAvailability: { status: modelId === HAIKU ? "PENDING" : "NOT_AVAILABLE" },
        authorizationStatus: "AUTHORIZED",
        entitlementAvailability: "AVAILABLE",
        regionAvailability: "AVAILABLE",
      };
    },
    listFoundationModels: async () => [
      { ...textModel, inferenceTypesSupported: ["ON_DEMAND"], modelId: NOVA, modelName: "Nova" },
      { ...textModel, inferenceTypesSupported: ["INFERENCE_PROFILE"], modelId: HAIKU },
    ],
    listInferenceProfiles: async () => [
      {
        inferenceProfileId: `us.${HAIKU}`,
        models: [{ modelArn: `arn:aws:bedrock:us-east-2::foundation-model/${HAIKU}` }],
        status: "ACTIVE",
        type: "SYSTEM_DEFINED",
      },
    ],
  };
}

const datasheetBody = {
  [NOVA]: {
    input_cost_per_token: 3.5e-8,
    max_input_tokens: 128_000,
    mode: "chat",
    output_cost_per_token: 1.4e-7,
    provider: "bedrock",
  },
};

describe("model catalog sync", () => {
  it("synchronizes OpenRouter publicly and OpenAI through the configured key", async () => {
    const requests: RecordedRequest[] = [];
    const { catalog, dependencies } = syncDependencies(
      jsonFetch(
        {
          [OPENAI_MODELS_URL]: { data: [{ id: "gpt-4.1-mini" }, { id: "gpt-unpublished" }] },
          [OPENROUTER_MODELS_URL]: openRouterBody,
        },
        requests,
      ),
      { openAi: { loadApiKey: async () => " sk-test \n", source: "api" } },
    );

    const report = await synchronizeModelCatalog(dependencies);

    expect(requests).toEqual([
      { authorization: null, url: OPENROUTER_MODELS_URL },
      { authorization: "Bearer sk-test", url: OPENAI_MODELS_URL },
    ]);
    expect(report.providers).toMatchObject([
      { created: 3, provider: "openrouter", skipped: 1 },
      { created: 1, provider: "openai", skipped: 1 },
    ]);
    const entries = await catalog.listEntries();
    expect(entries.map((entry) => entry.modelId)).toEqual([
      "openai/gpt-4.1-mini",
      "openrouter/acme/chat",
      "openrouter/acme/image-only",
      "openrouter/openai/gpt-4.1-mini",
    ]);
    expect(entries.find((entry) => entry.modelId === "openai/gpt-4.1-mini")).toMatchObject({
      capabilities: { imageInput: true, structuredOutputs: true, toolCalling: true },
      contextWindowTokens: 128_000,
      maximumOutputTokens: 16_384,
      pricing: { inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 10 },
      provider: "openai",
      providerModelId: "gpt-4.1-mini",
      status: "active",
    });
  });

  it("synchronizes only OpenRouter when no OpenAI key is configured", async () => {
    const requests: RecordedRequest[] = [];
    const { dependencies } = syncDependencies(
      jsonFetch({ [OPENROUTER_MODELS_URL]: openRouterBody }, requests),
    );

    const report = await synchronizeModelCatalog(dependencies);

    expect(requests.map((request) => request.url)).toEqual([OPENROUTER_MODELS_URL]);
    expect(report.providers.map((provider) => provider.provider)).toEqual(["openrouter"]);
  });

  it("builds OpenAI entries from configured model ids without calling OpenAI", async () => {
    const luna = {
      ...openRouterModel("openai/gpt-6-luna"),
      context_length: 1_050_000,
      name: "OpenAI: GPT-6 Luna",
      pricing: { completion: "0.00004", input_cache_read: "0.0000005", prompt: "0.000005" },
      supported_parameters: ["tools", "response_format", "structured_outputs", "reasoning"],
      top_provider: { max_completion_tokens: 128_000 },
    };
    const { openAi } = modelCatalogSyncDependenciesFromEnvironment({
      [MODEL_CATALOG_SYNC_ENV.openAiModelIds]: " gpt-6-luna, gpt-unpublished ,gpt-6-luna,",
    });
    expect(openAi).toEqual({ modelIds: ["gpt-6-luna", "gpt-unpublished"], source: "configured" });
    const requests: RecordedRequest[] = [];
    const { catalog, dependencies } = syncDependencies(
      jsonFetch({ [OPENROUTER_MODELS_URL]: { data: [...openRouterBody.data, luna] } }, requests),
      { openAi: openAi! },
    );

    const report = await synchronizeModelCatalog(dependencies);

    expect(requests).toEqual([{ authorization: null, url: OPENROUTER_MODELS_URL }]);
    expect(report.providers).toMatchObject([
      { created: 4, provider: "openrouter", skipped: 1 },
      { created: 1, provider: "openai", skipped: 1 },
    ]);
    const openAiEntries = (await catalog.listEntries()).filter(
      (entry) => entry.provider === "openai",
    );
    expect(openAiEntries).toMatchObject([
      {
        capabilities: {
          imageInput: true,
          reasoning: true,
          structuredOutputs: true,
          toolCalling: true,
        },
        contextWindowTokens: 1_050_000,
        displayName: "OpenAI: GPT-6 Luna",
        maximumOutputTokens: 128_000,
        modelId: "openai/gpt-6-luna",
        pricing: {
          cacheReadUsdPerMillionTokens: 0.5,
          inputUsdPerMillionTokens: 5,
          outputUsdPerMillionTokens: 40,
        },
        provider: "openai",
        providerModelId: "gpt-6-luna",
        status: "active",
      },
    ]);
  });

  it("takes OpenAI availability from either the key or the configured ids, never both", () => {
    const openAiFrom = (env: NodeJS.ProcessEnv) =>
      modelCatalogSyncDependenciesFromEnvironment(env).openAi;
    const keyArn = "arn:aws:secretsmanager:us-east-2:123456789012:secret:openai";

    expect(openAiFrom({})).toBeUndefined();
    expect(openAiFrom({ [MODEL_CATALOG_SYNC_ENV.openAiModelIds]: " , " })).toBeUndefined();
    expect(openAiFrom({ [MODEL_CATALOG_SYNC_ENV.openAiApiKeySecretArn]: keyArn })?.source).toBe(
      "api",
    );
    expect(() =>
      openAiFrom({
        [MODEL_CATALOG_SYNC_ENV.openAiApiKeySecretArn]: keyArn,
        [MODEL_CATALOG_SYNC_ENV.openAiModelIds]: "gpt-6-luna",
      }),
    ).toThrow(
      "DEPLOYMENTS_AI_OPENAI_API_KEY_SECRET_ARN and DEPLOYMENTS_AI_OPENAI_MODEL_IDS are mutually exclusive.",
    );
    expect(() =>
      openAiFrom({ [MODEL_CATALOG_SYNC_ENV.openAiModelIds]: "gpt-6-luna,openai/gpt-6-sol" }),
    ).toThrow(
      "DEPLOYMENTS_AI_OPENAI_MODEL_IDS lists openai/gpt-6-sol, which is not a bare OpenAI model id.",
    );
  });

  it("throws on provider failures without committing a partial catalog", async () => {
    const failing = syncDependencies(
      jsonFetch({ [OPENROUTER_MODELS_URL]: new Response("unavailable", { status: 503 }) }),
    );
    expect(synchronizeModelCatalog(failing.dependencies)).rejects.toThrow(
      "openrouter model list returned HTTP 503.",
    );
    expect(await failing.catalog.listEntries()).toEqual([]);

    const malformed = syncDependencies(jsonFetch({ [OPENROUTER_MODELS_URL]: { models: [] } }));
    expect(synchronizeModelCatalog(malformed.dependencies)).rejects.toBeInstanceOf(
      ModelCatalogSyncError,
    );

    const oversized = syncDependencies(
      jsonFetch({
        [OPENROUTER_MODELS_URL]: new Response("x".repeat(MODEL_CATALOG_MAX_RESPONSE_BYTES + 1)),
      }),
    );
    expect(synchronizeModelCatalog(oversized.dependencies)).rejects.toThrow(
      `openrouter model list exceeds ${MODEL_CATALOG_MAX_RESPONSE_BYTES} bytes.`,
    );
  });

  it("reports an OpenAI failure after committing the OpenRouter snapshot", async () => {
    const { catalog, dependencies } = syncDependencies(
      jsonFetch({
        [OPENAI_MODELS_URL]: new Response("{}", { status: 401 }),
        [OPENROUTER_MODELS_URL]: openRouterBody,
      }),
      { openAi: { loadApiKey: async () => "sk-revoked", source: "api" } },
    );

    expect(synchronizeModelCatalog(dependencies)).rejects.toThrow(
      "openai model list returned HTTP 401.",
    );
    expect((await catalog.listEntries()).map((entry) => entry.provider)).not.toContain("openai");
    expect(await catalog.listEntries()).toHaveLength(3);
  });

  it("refuses a mass retirement unless an operator invoke allows it", async () => {
    const { catalog, dependencies } = syncDependencies(
      jsonFetch({ [OPENROUTER_MODELS_URL]: openRouterBody }),
    );
    await synchronizeModelCatalog(dependencies);
    const shrunk = {
      ...dependencies,
      fetch: jsonFetch({ [OPENROUTER_MODELS_URL]: { data: [openRouterModel("acme/chat")] } }),
    };

    expect(
      synchronizeModelCatalog(
        shrunk,
        modelCatalogSyncOptions({ "detail-type": "Scheduled Event" }),
      ),
    ).rejects.toThrow("would retire 2 of 3 active models");
    const report = await synchronizeModelCatalog(
      shrunk,
      modelCatalogSyncOptions({ allowMassRetirement: true }),
    );

    expect(report.providers[0]).toMatchObject({ provider: "openrouter", retired: 2, unchanged: 1 });
    const statuses = Object.fromEntries(
      (await catalog.listEntries()).map((entry) => [entry.modelId, entry.status]),
    );
    expect(statuses).toEqual({
      "openrouter/acme/chat": "active",
      "openrouter/acme/image-only": "retired",
      "openrouter/openai/gpt-4.1-mini": "retired",
    });
  });

  it("synchronizes the deployment region's Bedrock catalog", async () => {
    const requests: RecordedRequest[] = [];
    const availabilityRequests: string[] = [];
    const { catalog, dependencies } = syncDependencies(
      jsonFetch(
        { [BIFROST_DATASHEET_URL]: datasheetBody, [OPENROUTER_MODELS_URL]: openRouterBody },
        requests,
      ),
      { bedrock: { reader: bedrockReader(availabilityRequests), region: "us-east-2" } },
    );

    const report = await synchronizeModelCatalog(dependencies);

    expect(requests.map((request) => request.url).toSorted()).toEqual(
      [BIFROST_DATASHEET_URL, OPENROUTER_MODELS_URL].toSorted(),
    );
    expect(availabilityRequests.toSorted()).toEqual([NOVA, HAIKU].toSorted());
    expect(report.providers).toMatchObject([
      { created: 3, provider: "openrouter" },
      { created: 1, provider: "bedrock", skipped: 1 },
    ]);
    expect(
      (await catalog.listEntries()).find((entry) => entry.provider === "bedrock"),
    ).toMatchObject({
      contextWindowTokens: 128_000,
      displayName: "Nova",
      modelId: `bedrock/${NOVA}`,
      pricing: { inputUsdPerMillionTokens: 0.035, outputUsdPerMillionTokens: 0.14 },
      providerModelId: NOVA,
      status: "active",
    });
  });

  it("enables Bedrock only when the deployment configures its region", () => {
    expect(modelCatalogSyncDependenciesFromEnvironment({}).bedrock).toBeUndefined();
    expect(
      modelCatalogSyncDependenciesFromEnvironment({
        [MODEL_CATALOG_SYNC_ENV.bedrockRegion]: " us-east-2 ",
      }).bedrock?.region,
    ).toBe("us-east-2");
  });

  it("still synchronizes Bedrock when OpenRouter fails, then reports the failure", async () => {
    const errors: unknown[] = [];
    const { catalog, dependencies } = syncDependencies(
      jsonFetch({
        [BIFROST_DATASHEET_URL]: datasheetBody,
        [OPENROUTER_MODELS_URL]: new Response("unavailable", { status: 503 }),
      }),
      {
        bedrock: { reader: bedrockReader(), region: "us-east-2" },
        logger: { error: (_message, fields) => errors.push(fields), info: () => undefined },
      },
    );

    expect(synchronizeModelCatalog(dependencies)).rejects.toThrow(
      "openrouter model list returned HTTP 503.",
    );
    expect((await catalog.listEntries()).map((entry) => entry.modelId)).toEqual([
      `bedrock/${NOVA}`,
    ]);
    expect(errors).toMatchObject([{ provider: "openrouter" }]);
  });

  it("attempts every provider and aggregates multiple failures", async () => {
    const errors: unknown[] = [];
    const { dependencies } = syncDependencies(
      jsonFetch({
        [BIFROST_DATASHEET_URL]: [],
        [OPENROUTER_MODELS_URL]: new Response("unavailable", { status: 503 }),
      }),
      {
        bedrock: { reader: bedrockReader(), region: "us-east-2" },
        logger: { error: (_message, fields) => errors.push(fields), info: () => undefined },
      },
    );

    const failure = await synchronizeModelCatalog(dependencies).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(
      "Model catalog synchronization failed for openrouter, bedrock.",
    );
    expect(errors).toMatchObject([{ provider: "openrouter" }, { provider: "bedrock" }]);
  });
});
