import {
  usdPerTokenToUsdPerMillionTokens,
  type ModelCatalogEntry,
  type ModelPricingTier,
  type ModelTokenPrices,
  type ModelTokenPricing,
  type ParsedModelCatalog,
} from "./model-catalog.ts";
import { BEDROCK_MODEL_PREFIX, isRecord } from "./types.ts";

/**
 * Bifrost's published pricing and capability datasheet, keyed by provider model id. The pinned
 * gateway meters Bedrock with this table, and no AWS API publishes context windows or a price list
 * joinable on model id, so it is the catalog's metadata source for Bedrock models.
 */
export const BIFROST_DATASHEET_URL = "https://getbifrost.ai/datasheet";

/** The `ListFoundationModels` summary fields the catalog reads. */
export interface BedrockFoundationModelSummary {
  readonly inferenceTypesSupported?: readonly string[] | undefined;
  readonly inputModalities?: readonly string[] | undefined;
  readonly modelId?: string | undefined;
  readonly modelLifecycle?: { readonly status?: string | undefined } | undefined;
  readonly modelName?: string | undefined;
  readonly outputModalities?: readonly string[] | undefined;
  readonly responseStreamingSupported?: boolean | undefined;
}

/** The `ListInferenceProfiles` summary fields the catalog reads. */
export interface BedrockInferenceProfileSummary {
  readonly inferenceProfileId?: string | undefined;
  readonly inferenceProfileName?: string | undefined;
  readonly models?: readonly { readonly modelArn?: string | undefined }[] | undefined;
  readonly status?: string | undefined;
  readonly type?: string | undefined;
}

/** The `GetFoundationModelAvailability` response fields the catalog reads. */
export interface BedrockFoundationModelAvailability {
  readonly agreementAvailability?: { readonly status?: string | undefined } | undefined;
  readonly authorizationStatus?: string | undefined;
  readonly entitlementAvailability?: string | undefined;
  readonly regionAvailability?: string | undefined;
}

export interface BedrockModelCandidate {
  readonly displayName: string;
  /** The foundation model the id invokes; availability is checked on this model. */
  readonly foundationModelId: string;
  readonly imageInput: boolean;
  /** Canonical platform model id, for example `bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0`. */
  readonly modelId: string;
  /** Foundation model id or system-defined inference profile id passed to Bedrock. */
  readonly providerModelId: string;
}

export interface BedrockModelCandidates {
  readonly candidates: readonly BedrockModelCandidate[];
  /** Sorted, distinct foundation model ids whose account availability must be checked. */
  readonly foundationModelIds: readonly string[];
}

export interface BedrockModelCatalogInput {
  /** Account availability keyed by the foundation model id that was queried. */
  readonly availability: ReadonlyMap<string, BedrockFoundationModelAvailability>;
  readonly datasheet: unknown;
  readonly foundationModels: readonly BedrockFoundationModelSummary[];
  readonly inferenceProfiles: readonly BedrockInferenceProfileSummary[];
  /** The deployment region whose Bedrock endpoint serves the models. */
  readonly region: string;
}

const MAX_BEDROCK_MODEL_ID_LENGTH = 200;
const BEDROCK_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const FOUNDATION_MODEL_ARN_PATTERN = /^arn:[^:]+:bedrock:[^:]*:[^:]*:foundation-model\/(.+)$/u;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_CONTEXT_WINDOW_TOKENS = 100_000_000;
const DATASHEET_TIER_PATTERN =
  /^(?:cache_read_input_token_cost|cache_creation_input_token_cost|input_cost_per_token|output_cost_per_token)_above_(\d+)k_tokens$/u;
const DATASHEET_PRICE_KEYS = {
  cacheReadUsdPerMillionTokens: "cache_read_input_token_cost",
  cacheWriteUsdPerMillionTokens: "cache_creation_input_token_cost",
  inputUsdPerMillionTokens: "input_cost_per_token",
  outputUsdPerMillionTokens: "output_cost_per_token",
} as const satisfies Record<keyof ModelTokenPrices, string>;

type DatasheetPrices = { -readonly [Key in keyof ModelTokenPrices]?: number };

function bedrockModelId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length <= MAX_BEDROCK_MODEL_ID_LENGTH && BEDROCK_MODEL_ID_PATTERN.test(trimmed)
    ? trimmed
    : undefined;
}

/** The single foundation model a system-defined profile routes to, across its regions. */
function profileFoundationModelId(profile: BedrockInferenceProfileSummary) {
  const ids = new Set(
    (profile.models ?? []).map(
      (model) => FOUNDATION_MODEL_ARN_PATTERN.exec(model.modelArn?.trim() ?? "")?.[1],
    ),
  );
  if (ids.size !== 1) return undefined;
  return bedrockModelId([...ids][0]);
}

/**
 * Selects the ids the deployment region can serve through the Converse API. A foundation model is
 * invocable by its bare id only with on-demand throughput; otherwise it is reachable solely through
 * an inference profile. A system-defined profile is admitted only when the model it routes to is
 * listed (and live) in this region, because AWS keeps profiles of end-of-life models active.
 */
export function bedrockModelCandidates(
  foundationModels: readonly BedrockFoundationModelSummary[],
  inferenceProfiles: readonly BedrockInferenceProfileSummary[],
): BedrockModelCandidates {
  // Servable foundation models produce text, are not end-of-life, and stream responses.
  const servable = new Map<string, BedrockFoundationModelSummary>();
  for (const model of foundationModels) {
    const id = bedrockModelId(model.modelId);
    if (
      id &&
      (model.outputModalities ?? []).includes("TEXT") &&
      model.modelLifecycle?.status === "ACTIVE" &&
      model.responseStreamingSupported === true
    ) {
      servable.set(id, model);
    }
  }
  const candidates = new Map<string, BedrockModelCandidate>();
  const addCandidate = (
    providerModelId: string,
    foundationModelId: string,
    name: string | undefined,
  ) => {
    const modelId = `${BEDROCK_MODEL_PREFIX}${providerModelId}`;
    candidates.set(modelId.toLowerCase(), {
      displayName: (name?.trim() || providerModelId).slice(0, MAX_DISPLAY_NAME_LENGTH),
      foundationModelId,
      imageInput: (servable.get(foundationModelId)?.inputModalities ?? []).includes("IMAGE"),
      modelId,
      providerModelId,
    });
  };
  for (const [id, model] of servable) {
    if ((model.inferenceTypesSupported ?? []).includes("ON_DEMAND")) {
      addCandidate(id, id, model.modelName);
    }
  }
  for (const profile of inferenceProfiles) {
    const id = bedrockModelId(profile.inferenceProfileId);
    const foundationModelId = profileFoundationModelId(profile);
    if (
      id &&
      foundationModelId &&
      profile.type === "SYSTEM_DEFINED" &&
      profile.status === "ACTIVE" &&
      servable.has(foundationModelId)
    ) {
      addCandidate(id, foundationModelId, profile.inferenceProfileName);
    }
  }
  const sorted = [...candidates.values()].toSorted((left, right) =>
    left.modelId.localeCompare(right.modelId),
  );
  return {
    candidates: sorted,
    foundationModelIds: [
      ...new Set(sorted.map((candidate) => candidate.foundationModelId)),
    ].toSorted(),
  };
}

/**
 * The account may invoke the model. An agreement status of NOT_AVAILABLE is reported for models
 * that need no marketplace agreement, so only a pending or failed agreement excludes a model.
 */
function accountCanInvoke(availability: BedrockFoundationModelAvailability | undefined) {
  const agreement = availability?.agreementAvailability?.status;
  return (
    availability?.authorizationStatus === "AUTHORIZED" &&
    availability.entitlementAvailability === "AVAILABLE" &&
    availability.regionAvailability === "AVAILABLE" &&
    agreement !== "PENDING" &&
    agreement !== "ERROR"
  );
}

function chatDatasheetEntry(
  datasheet: Readonly<Record<string, unknown>>,
  provider: "bedrock" | "bedrock_mantle",
  key: string,
) {
  const entry = datasheet[key];
  return isRecord(entry) && entry.provider === provider && entry.mode === "chat"
    ? entry
    : undefined;
}

function positiveTokenCount(value: unknown) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_CONTEXT_WINDOW_TOKENS
    ? value
    : undefined;
}

function datasheetPrices(entry: Readonly<Record<string, unknown>>, suffix: string) {
  const prices: DatasheetPrices = {};
  for (const [field, key] of Object.entries(DATASHEET_PRICE_KEYS) as [
    keyof ModelTokenPrices,
    string,
  ][]) {
    const price = usdPerTokenToUsdPerMillionTokens(entry[`${key}${suffix}`]);
    if (price !== undefined) prices[field] = price;
  }
  return prices;
}

function definedPrices(prices: DatasheetPrices): ModelTokenPrices | undefined {
  const { cacheReadUsdPerMillionTokens, cacheWriteUsdPerMillionTokens } = prices;
  const { inputUsdPerMillionTokens, outputUsdPerMillionTokens } = prices;
  if (inputUsdPerMillionTokens === undefined || outputUsdPerMillionTokens === undefined) {
    return undefined;
  }
  return {
    ...(cacheReadUsdPerMillionTokens !== undefined ? { cacheReadUsdPerMillionTokens } : {}),
    ...(cacheWriteUsdPerMillionTokens !== undefined ? { cacheWriteUsdPerMillionTokens } : {}),
    inputUsdPerMillionTokens,
    outputUsdPerMillionTokens,
  };
}

/**
 * Maps the datasheet's long-context prices (`input_cost_per_token_above_200k_tokens`, ...) to
 * tiers. The gateway applies a tier once the prompt exceeds the threshold and falls back to the
 * next lower tier, then the base price, for any price a tier omits; the tiers here are cumulative
 * in the same way, so metering matches what the gateway charges.
 */
function datasheetPricing(entry: Readonly<Record<string, unknown>>): ModelTokenPricing | undefined {
  const base = definedPrices(datasheetPrices(entry, ""));
  if (!base) return undefined;
  const thresholds = new Set<number>();
  for (const key of Object.keys(entry)) {
    const thousands = DATASHEET_TIER_PATTERN.exec(key)?.[1];
    if (thousands) thresholds.add(Number(thousands));
  }
  let previous: ModelTokenPrices = base;
  const tiers: ModelPricingTier[] = [];
  for (const thousands of [...thresholds].toSorted((left, right) => left - right)) {
    const minPromptTokens = positiveTokenCount(thousands * 1_000 + 1);
    const prices = definedPrices({
      ...previous,
      ...datasheetPrices(entry, `_above_${thousands}k_tokens`),
    });
    if (minPromptTokens === undefined || !prices) continue;
    tiers.push({ ...prices, minPromptTokens });
    previous = prices;
  }
  return { ...base, ...(tiers.length > 0 ? { tiers } : {}) };
}

/**
 * Builds the Bedrock catalog for one region. Availability comes from the account's Bedrock APIs;
 * context window, output limit, capabilities, and prices come from Bifrost's datasheet, preferring
 * the region-specific `bedrock/<region>/<id>` entry. A candidate the account cannot invoke, or
 * whose context window or input/output price the datasheet does not publish, is skipped.
 *
 * Bifrost (core `providers/bedrock` `isMantleModel`) sends bare OpenAI-family, Grok, and Gemma 4
 * ids to the Bedrock Mantle endpoint instead of bedrock-runtime, while region-prefixed profile ids
 * always use bedrock-runtime. Mantle names models differently (`openai.gpt-oss-20b`, not
 * `openai.gpt-oss-20b-1:0`), so such a foundation-model id is admitted only when the datasheet
 * publishes a `bedrock_mantle/<id>` row, i.e. Mantle serves that exact id.
 */
export function parseBedrockModelCatalog(input: BedrockModelCatalogInput): ParsedModelCatalog {
  if (!isRecord(input.datasheet)) {
    throw new TypeError("Bifrost datasheet must be a JSON object keyed by model id.");
  }
  const datasheet = input.datasheet;
  const region = input.region.trim();
  const { candidates } = bedrockModelCandidates(input.foundationModels, input.inferenceProfiles);
  const entries: ModelCatalogEntry[] = [];
  const skippedModelIds: string[] = [];
  for (const candidate of candidates) {
    const id = candidate.providerModelId;
    const mantleRouted =
      id === candidate.foundationModelId &&
      (id.startsWith("openai.") || id.startsWith("xai.") || id.includes("gemma-4"));
    const mantleKey = `bedrock_mantle/${id}`;
    if (mantleRouted && !isRecord(datasheet[mantleKey])) {
      skippedModelIds.push(id);
      continue;
    }
    const metadata =
      chatDatasheetEntry(datasheet, "bedrock", `bedrock/${region}/${id}`) ??
      chatDatasheetEntry(datasheet, "bedrock", id) ??
      (mantleRouted ? chatDatasheetEntry(datasheet, "bedrock_mantle", mantleKey) : undefined);
    const contextWindowTokens = positiveTokenCount(metadata?.max_input_tokens);
    const pricing = metadata ? datasheetPricing(metadata) : undefined;
    if (
      !metadata ||
      !accountCanInvoke(input.availability.get(candidate.foundationModelId)) ||
      contextWindowTokens === undefined ||
      !pricing
    ) {
      skippedModelIds.push(id);
      continue;
    }
    const maximumOutputTokens = positiveTokenCount(metadata.max_output_tokens);
    entries.push({
      capabilities: {
        imageInput: candidate.imageInput,
        reasoning: metadata.supports_reasoning === true,
        structuredOutputs: metadata.supports_response_schema === true,
        toolCalling: metadata.supports_function_calling === true,
      },
      contextWindowTokens,
      displayName: candidate.displayName,
      ...(maximumOutputTokens !== undefined ? { maximumOutputTokens } : {}),
      modelId: candidate.modelId,
      pricing,
      provider: "bedrock",
      providerModelId: id,
    });
  }
  return { entries, skippedModelIds };
}
