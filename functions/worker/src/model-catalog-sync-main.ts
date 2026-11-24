import {
  BedrockClient,
  GetFoundationModelAvailabilityCommand,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  makeDynamoDatabase,
  makeModelCatalogPersistence,
  tableNamesFromEnvironment,
  type ModelCatalogEntryInput,
  type ModelCatalogPersistence,
  type ModelCatalogSynchronizationResult,
} from "@deployments-ai/db";
import {
  BIFROST_DATASHEET_URL,
  bareOpenAiModelId,
  bedrockModelCandidates,
  OPENAI_MODELS_URL,
  OPENROUTER_MODELS_URL,
  openAiModelCatalogEntries,
  parseBedrockModelCatalog,
  parseOpenAiModelIds,
  parseOpenRouterModelCatalog,
  type BedrockFoundationModelAvailability,
  type BedrockFoundationModelSummary,
  type BedrockInferenceProfileSummary,
  type ModelCatalogEntry,
  type ModelCatalogProvider,
  type ParsedModelCatalog,
} from "@deployments-ai/model-gateway";
import { loadAwsSecretString } from "@deployments-ai/secret-store";

export const MODEL_CATALOG_SYNC_ENV = {
  bedrockRegion: "DEPLOYMENTS_AI_BEDROCK_REGION",
  openAiApiKeySecretArn: "DEPLOYMENTS_AI_OPENAI_API_KEY_SECRET_ARN",
  openAiModelIds: "DEPLOYMENTS_AI_OPENAI_MODEL_IDS",
} as const;

/** Per-provider bound on the whole request, including reading the body. */
const MODEL_CATALOG_FETCH_TIMEOUT_MS = 20_000;
/** OpenRouter's catalog and Bifrost's datasheet are a few MiB; anything far larger is not a model list. */
export const MODEL_CATALOG_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Concurrent `GetFoundationModelAvailability` calls; one per candidate foundation model. */
const BEDROCK_AVAILABILITY_CONCURRENCY = 4;

export type ModelCatalogFetch = (url: string, init: RequestInit) => Promise<Response>;

interface ModelCatalogSyncLogger {
  readonly error: (message: string, fields: Readonly<Record<string, unknown>>) => void;
  readonly info: (message: string, fields: Readonly<Record<string, unknown>>) => void;
}

/** The Bedrock control-plane reads the catalog needs, in the deployment region. */
export interface BedrockModelCatalogReader {
  readonly getFoundationModelAvailability: (
    modelId: string,
  ) => Promise<BedrockFoundationModelAvailability>;
  readonly listFoundationModels: () => Promise<readonly BedrockFoundationModelSummary[]>;
  /** System-defined inference profiles only, across all pages. */
  readonly listInferenceProfiles: () => Promise<readonly BedrockInferenceProfileSummary[]>;
}

/**
 * Where OpenAI model availability comes from: `GET api.openai.com/v1/models` with the deployment's
 * key, or an operator-configured id list when the `openai` provider is served by another endpoint.
 */
export type OpenAiModelAvailability =
  | { readonly loadApiKey: () => Promise<string>; readonly source: "api" }
  | { readonly modelIds: readonly string[]; readonly source: "configured" };

export interface ModelCatalogSyncDependencies {
  /** Present only when Bedrock is a hosted provider; its catalog is the deployment region's. */
  readonly bedrock?: { readonly reader: BedrockModelCatalogReader; readonly region: string };
  readonly catalog: ModelCatalogPersistence;
  readonly fetch: ModelCatalogFetch;
  readonly logger?: ModelCatalogSyncLogger;
  /** Present only when the deployment hosts OpenAI. */
  readonly openAi?: OpenAiModelAvailability;
}

export interface ModelCatalogSyncOptions {
  /** Operator override for a provider snapshot that legitimately retires most active entries. */
  readonly allowMassRetirement?: boolean;
}

interface ModelCatalogProviderSyncReport extends ModelCatalogSynchronizationResult {
  readonly skipped: number;
}

export interface ModelCatalogSyncReport {
  readonly providers: readonly ModelCatalogProviderSyncReport[];
}

export class ModelCatalogSyncError extends Error {
  constructor(
    readonly provider: ModelCatalogProvider,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelCatalogSyncError";
  }
}

async function boundedResponseText(response: Response, provider: ModelCatalogProvider) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MODEL_CATALOG_MAX_RESPONSE_BYTES) {
    throw new ModelCatalogSyncError(
      provider,
      `${provider} model list declares ${declaredLength} bytes; the limit is ${MODEL_CATALOG_MAX_RESPONSE_BYTES}.`,
    );
  }
  if (!response.body) throw new ModelCatalogSyncError(provider, `${provider} model list is empty.`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- stream chunks must be read in order.
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MODEL_CATALOG_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new ModelCatalogSyncError(
        provider,
        `${provider} model list exceeds ${MODEL_CATALOG_MAX_RESPONSE_BYTES} bytes.`,
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function fetchModelList(
  fetcher: ModelCatalogFetch,
  provider: ModelCatalogProvider,
  url: string,
  headers: Readonly<Record<string, string>>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { accept: "application/json", ...headers },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(MODEL_CATALOG_FETCH_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new ModelCatalogSyncError(provider, `${provider} model list request failed.`, { cause });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ModelCatalogSyncError(
      provider,
      `${provider} model list returned HTTP ${response.status}.`,
    );
  }
  let text: string;
  try {
    text = await boundedResponseText(response, provider);
  } catch (cause) {
    if (cause instanceof ModelCatalogSyncError) throw cause;
    throw new ModelCatalogSyncError(provider, `${provider} model list could not be read.`, {
      cause,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ModelCatalogSyncError(provider, `${provider} model list is not JSON.`, { cause });
  }
}

function parsed<T>(provider: ModelCatalogProvider, parse: () => T): T {
  try {
    return parse();
  } catch (cause) {
    throw new ModelCatalogSyncError(
      provider,
      `${provider} model list is malformed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

function catalogEntryInput(entry: ModelCatalogEntry): ModelCatalogEntryInput {
  return {
    capabilities: {
      imageInput: entry.capabilities.imageInput,
      reasoning: entry.capabilities.reasoning,
      structuredOutputs: entry.capabilities.structuredOutputs,
      toolCalling: entry.capabilities.toolCalling,
    },
    contextWindowTokens: entry.contextWindowTokens,
    displayName: entry.displayName,
    ...(entry.maximumOutputTokens !== undefined
      ? { maximumOutputTokens: entry.maximumOutputTokens }
      : {}),
    modelId: entry.modelId,
    pricing: entry.pricing,
    provider: entry.provider,
    providerModelId: entry.providerModelId,
  };
}

async function synchronizeParsedProvider(
  dependencies: ModelCatalogSyncDependencies,
  provider: ModelCatalogProvider,
  catalog: ParsedModelCatalog,
  options: ModelCatalogSyncOptions,
): Promise<ModelCatalogProviderSyncReport> {
  const result = await dependencies.catalog.synchronizeProvider(
    provider,
    catalog.entries.map(catalogEntryInput),
    { allowMassRetirement: options.allowMassRetirement === true },
  );
  const report = { ...result, skipped: catalog.skippedModelIds.length };
  (dependencies.logger ?? console).info("Model catalog provider synchronized.", {
    ...report,
    allowMassRetirement: options.allowMassRetirement === true,
    entries: catalog.entries.length,
  });
  return report;
}

/** Runs `read` over `items` with at most `concurrency` calls in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  read: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      // eslint-disable-next-line no-await-in-loop -- each worker reads one item at a time.
      results[index] = await read(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * Bedrock availability is the account's, in the deployment region; context windows, capabilities,
 * and prices are Bifrost's datasheet, the table the gateway itself meters Bedrock with.
 */
async function synchronizeBedrock(
  dependencies: ModelCatalogSyncDependencies,
  bedrock: NonNullable<ModelCatalogSyncDependencies["bedrock"]>,
  options: ModelCatalogSyncOptions,
): Promise<ModelCatalogProviderSyncReport> {
  const [datasheet, foundationModels, inferenceProfiles] = await Promise.all([
    fetchModelList(dependencies.fetch, "bedrock", BIFROST_DATASHEET_URL, {}),
    bedrock.reader.listFoundationModels(),
    bedrock.reader.listInferenceProfiles(),
  ]);
  const { foundationModelIds } = bedrockModelCandidates(foundationModels, inferenceProfiles);
  const availability = await mapWithConcurrency(
    foundationModelIds,
    BEDROCK_AVAILABILITY_CONCURRENCY,
    async (modelId) =>
      [modelId, await bedrock.reader.getFoundationModelAvailability(modelId)] as const,
  );
  const catalog = parsed("bedrock", () =>
    parseBedrockModelCatalog({
      availability: new Map(availability),
      datasheet,
      foundationModels,
      inferenceProfiles,
      region: bedrock.region,
    }),
  );
  return synchronizeParsedProvider(dependencies, "bedrock", catalog, options);
}

async function availableOpenAiModelIds(
  fetcher: ModelCatalogFetch,
  availability: OpenAiModelAvailability,
): Promise<readonly string[]> {
  if (availability.source === "configured") return availability.modelIds;
  const apiKey = (await availability.loadApiKey()).trim();
  if (!apiKey) throw new ModelCatalogSyncError("openai", "OpenAI API key is empty.");
  const body = await fetchModelList(fetcher, "openai", OPENAI_MODELS_URL, {
    authorization: `Bearer ${apiKey}`,
  });
  return parsed("openai", () => parseOpenAiModelIds(body));
}

interface ProviderFailure {
  readonly cause: unknown;
  readonly provider: ModelCatalogProvider;
}

/**
 * Synchronizes the hosted gateway catalogs. OpenRouter's public list is authoritative metadata for
 * OpenAI, so it is synchronized first and an OpenRouter failure also stops OpenAI. Bedrock depends
 * on neither and is attempted regardless, so a Bedrock-only install keeps a fresh catalog when
 * openrouter.ai is unreachable. Every provider is attempted before any failure is rethrown, so the
 * invocation still reports an error after the healthy providers are committed.
 */
export async function synchronizeModelCatalog(
  dependencies: ModelCatalogSyncDependencies,
  options: ModelCatalogSyncOptions = {},
): Promise<ModelCatalogSyncReport> {
  const logger = dependencies.logger ?? console;
  const providers: ModelCatalogProviderSyncReport[] = [];
  const failures: ProviderFailure[] = [];
  let provider: ModelCatalogProvider = "openrouter";
  try {
    const openRouterBody = await fetchModelList(
      dependencies.fetch,
      provider,
      OPENROUTER_MODELS_URL,
      {},
    );
    const openRouter = parsed(provider, () => parseOpenRouterModelCatalog(openRouterBody));
    providers.push(await synchronizeParsedProvider(dependencies, provider, openRouter, options));
    if (dependencies.openAi) {
      provider = "openai";
      const openAiIds = await availableOpenAiModelIds(dependencies.fetch, dependencies.openAi);
      providers.push(
        await synchronizeParsedProvider(
          dependencies,
          provider,
          openAiModelCatalogEntries(openAiIds, openRouter.entries),
          options,
        ),
      );
    }
  } catch (cause) {
    failures.push({ cause, provider });
  }
  if (dependencies.bedrock) {
    try {
      providers.push(await synchronizeBedrock(dependencies, dependencies.bedrock, options));
    } catch (cause) {
      failures.push({ cause, provider: "bedrock" });
    }
  }
  for (const failure of failures) {
    const { cause } = failure;
    logger.error("Model catalog provider synchronization failed.", {
      errorCode:
        cause instanceof Error && "code" in cause && typeof cause.code === "string"
          ? cause.code
          : undefined,
      errorMessage: cause instanceof Error ? cause.message : String(cause),
      errorType: cause instanceof Error ? cause.name : typeof cause,
      provider: failure.provider,
    });
  }
  const [firstFailure] = failures;
  if (firstFailure && failures.length === 1) throw firstFailure.cause;
  if (firstFailure) {
    throw new AggregateError(
      failures.map((failure) => failure.cause),
      `Model catalog synchronization failed for ${failures.map((failure) => failure.provider).join(", ")}.`,
    );
  }
  return { providers };
}

/** Scheduled events carry EventBridge fields; only an explicit operator flag widens retirement. */
export function modelCatalogSyncOptions(event: unknown): ModelCatalogSyncOptions {
  return {
    allowMassRetirement:
      typeof event === "object" &&
      event !== null &&
      "allowMassRetirement" in event &&
      event.allowMassRetirement === true,
  };
}

function bedrockModelCatalogReader(client: BedrockClient): BedrockModelCatalogReader {
  return {
    getFoundationModelAvailability: (modelId) =>
      client.send(new GetFoundationModelAvailabilityCommand({ modelId })),
    listFoundationModels: async () =>
      (await client.send(new ListFoundationModelsCommand({}))).modelSummaries ?? [],
    listInferenceProfiles: async () => {
      const profiles: BedrockInferenceProfileSummary[] = [];
      let nextToken: string | undefined;
      do {
        // eslint-disable-next-line no-await-in-loop -- pages are chained by nextToken.
        const page = await client.send(
          new ListInferenceProfilesCommand({
            maxResults: 1000,
            typeEquals: "SYSTEM_DEFINED",
            ...(nextToken ? { nextToken } : {}),
          }),
        );
        profiles.push(...(page.inferenceProfileSummaries ?? []));
        nextToken = page.nextToken;
      } while (nextToken);
      return profiles;
    },
  };
}

/**
 * The configured OpenAI availability. A key lists what api.openai.com serves; a configured id list
 * names what a relayed endpoint serves. Both at once is a misconfiguration, not a precedence.
 */
function openAiModelAvailabilityFromEnvironment(
  env: NodeJS.ProcessEnv,
): OpenAiModelAvailability | undefined {
  const { openAiApiKeySecretArn: keyEnv, openAiModelIds: idsEnv } = MODEL_CATALOG_SYNC_ENV;
  const apiKeySecretArn = env[keyEnv]?.trim();
  const modelIds = [
    ...new Set(
      (env[idsEnv] ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  const invalid = modelIds.find((id) => !bareOpenAiModelId(id));
  if (invalid) throw new Error(`${idsEnv} lists ${invalid}, which is not a bare OpenAI model id.`);
  if (apiKeySecretArn && modelIds.length > 0) {
    throw new Error(`${keyEnv} and ${idsEnv} are mutually exclusive.`);
  }
  if (modelIds.length > 0) return { modelIds, source: "configured" };
  return apiKeySecretArn
    ? { loadApiKey: () => loadAwsSecretString(apiKeySecretArn), source: "api" }
    : undefined;
}

export function modelCatalogSyncDependenciesFromEnvironment(
  env: NodeJS.ProcessEnv,
): ModelCatalogSyncDependencies {
  const database = makeDynamoDatabase(
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    tableNamesFromEnvironment(env),
  );
  const bedrockRegion = env[MODEL_CATALOG_SYNC_ENV.bedrockRegion]?.trim();
  const openAi = openAiModelAvailabilityFromEnvironment(env);
  return {
    ...(bedrockRegion
      ? {
          bedrock: {
            reader: bedrockModelCatalogReader(new BedrockClient({ region: bedrockRegion })),
            region: bedrockRegion,
          },
        }
      : {}),
    catalog: makeModelCatalogPersistence(database),
    fetch,
    ...(openAi ? { openAi } : {}),
  };
}

let dependencies: ModelCatalogSyncDependencies | undefined;

export async function handler(event: unknown): Promise<ModelCatalogSyncReport> {
  dependencies ??= modelCatalogSyncDependenciesFromEnvironment(process.env);
  return synchronizeModelCatalog(dependencies, modelCatalogSyncOptions(event));
}
