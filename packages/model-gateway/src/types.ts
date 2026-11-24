import { Context, Effect, Schema } from "effect";
import type { ModelCatalogRuntimeEntries, ModelTokenPricing } from "./model-catalog.ts";
import type { ModelFunding, ModelUsagePayer } from "./model-funding.ts";
import type { ProviderRetrySleep } from "./provider-retry.ts";
import type { ModelGatewayChatCompletionResponseShape } from "./responses.ts";

export const MODEL_GATEWAY_ENV_KEYS = {
  baseUrl: ["DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL"],
  defaultFallbackModelIds: [
    "DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS",
    "AGENT_DEFAULT_MODEL_FALLBACK_IDS",
  ],
  defaultModelId: ["DEPLOYMENTS_AI_DEFAULT_MODEL_ID", "AGENT_DEFAULT_MODEL_ID"],
  /** Name or ARN of the Lambda function that issues this process's gateway tokens. */
  tokenIssuer: ["DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER"],
} as const;

export const OPENAI_MODEL_PREFIX = "openai/";

export const OPENROUTER_MODEL_PREFIX = "openrouter/";

/**
 * Amazon Bedrock models are addressed as `bedrock/<foundation model or inference profile id>`, for
 * example `bedrock/amazon.nova-micro-v1:0` or `bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0`.
 */
export const BEDROCK_MODEL_PREFIX = "bedrock/";

export const DEFAULT_AGENT_MODEL_ID = "openrouter/qwen/qwen3.7-plus";

export const DEFAULT_AGENT_MODEL_FALLBACK_IDS = [
  "openrouter/z-ai/glm-5.2",
  "openrouter/xiaomi/mimo-v2.5",
] as const;

export const DEFAULT_BIFROST_OPENAI_ALLOWED_MODELS = [
  "gpt-5.2",
  "gpt-4.1",
  "gpt-4o",
  "gpt-4o-mini",
  "text-embedding-3-small",
] as const;

export const DEFAULT_BIFROST_OPENROUTER_ALLOWED_MODELS = [
  "qwen/qwen3.7-plus",
  "z-ai/glm-5.2",
  "xiaomi/mimo-v2.5",
  "z-ai/glm-5.3-flash",
  "anthropic/claude-opus-5.5",
  "openai/gpt-4o",
  "openai/text-embedding-3-small",
] as const;

/**
 * Bedrock global cross-Region inference profiles. A Bedrock-only install runs them without a
 * third-party key once the account has Bedrock model access to them.
 */
export const DEFAULT_BIFROST_BEDROCK_ALLOWED_MODELS = [
  "global.anthropic.claude-haiku-4-5-20251001-v1:0",
  "global.cohere.embed-v4:0",
] as const;

export const OPENROUTER_UNPREFIXED_MODEL_IDS = new Set([
  "qwen/qwen3.7-plus",
  "xiaomi/mimo-v2.5",
  "z-ai/glm-5.2",
]);

export const MODEL_GATEWAY_PROVIDERS = ["bedrock", "openai", "openrouter"] as const;

export type ModelGatewayProvider = (typeof MODEL_GATEWAY_PROVIDERS)[number];

export const MODEL_PROVIDER_PREFIXES: Readonly<Record<ModelGatewayProvider, string>> = {
  bedrock: BEDROCK_MODEL_PREFIX,
  openai: OPENAI_MODEL_PREFIX,
  openrouter: OPENROUTER_MODEL_PREFIX,
};

/**
 * Provider-native curated model ids: what an operator grant allows for a provider when it has no
 * explicit allowlist. Other Bedrock models are admitted through the synchronized catalog or
 * explicit operator grants.
 */
export const CURATED_PROVIDER_MODEL_IDS: Readonly<Record<ModelGatewayProvider, readonly string[]>> =
  {
    bedrock: DEFAULT_BIFROST_BEDROCK_ALLOWED_MODELS,
    openai: DEFAULT_BIFROST_OPENAI_ALLOWED_MODELS,
    openrouter: DEFAULT_BIFROST_OPENROUTER_ALLOWED_MODELS,
  };

export const ModelGatewayProviderSchema = Schema.Literals(MODEL_GATEWAY_PROVIDERS);

export class ModelGatewayConfigError extends Schema.TaggedErrorClass<ModelGatewayConfigError>()(
  "ModelGatewayConfigError",
  {
    key: Schema.String,
    message: Schema.String,
  },
) {}

export class ModelGatewayRouteError extends Schema.TaggedErrorClass<ModelGatewayRouteError>()(
  "ModelGatewayRouteError",
  {
    message: Schema.String,
    modelId: Schema.String,
  },
) {}

export class ModelGatewayUsageError extends Schema.TaggedErrorClass<ModelGatewayUsageError>()(
  "ModelGatewayUsageError",
  {
    message: Schema.String,
    modelCallId: Schema.String,
  },
) {}

export class ModelGatewayRequestError extends Schema.TaggedErrorClass<ModelGatewayRequestError>()(
  "ModelGatewayRequestError",
  {
    endpoint: Schema.String,
    message: Schema.String,
    providerCode: Schema.optional(Schema.String),
    providerMessage: Schema.optional(Schema.String),
    status: Schema.optional(Schema.Number),
  },
) {}

/**
 * Returns the bearer token a request presents to the model gateway. It receives the route's
 * canonical model ids (primary first) and the request scope so a source can pick or mint a token
 * whose claims cover them; it rejects when no token may be issued.
 */
export type ModelGatewayCredentials = (request: ModelGatewayCredentialRequest) => Promise<string>;

export interface ModelGatewayCredentialRequest {
  readonly modelIds: readonly string[];
  readonly scope?: ModelGatewayRouteScope;
}

export interface ModelGatewayClientConfig {
  readonly baseUrl: string;
  readonly credentials: ModelGatewayCredentials;
  readonly defaultFallbackModelIds?: readonly string[];
  readonly defaultModelId?: string;
}

export interface ModelGatewayRouteScope {
  readonly agentId?: string;
  readonly organizationId?: string;
  readonly runId?: string;
  readonly workspaceId?: string;
}

export interface ResolveModelRouteRequest {
  readonly fallbackModelIds?: readonly string[];
  readonly modelId?: string;
  /** Canonical immutable route identity that must still be satisfiable by this gateway config. */
  readonly routeIdentity?: string;
  readonly scope?: ModelGatewayRouteScope;
}

export interface ModelGatewayRoute {
  readonly bifrostModelId: string;
  readonly fallbackModelIds: readonly string[];
  readonly modelId: string;
  readonly provider: ModelGatewayProvider;
  readonly providerModelId: string;
  readonly requestedModelId: string;
  readonly routeScopeRef?: string;
}

export function modelGatewayRouteIdentity(route: ModelGatewayRoute) {
  return JSON.stringify({
    bifrostModelId: route.bifrostModelId,
    fallbackModelIds: [...route.fallbackModelIds],
    modelId: route.modelId,
    provider: route.provider,
    providerModelId: route.providerModelId,
    requestedModelId: route.requestedModelId,
    routeScopeRef: route.routeScopeRef ?? null,
  });
}

export interface ModelUsageLedgerEntry {
  /** Prompt tokens served from the provider cache, a subset of inputTokens. */
  readonly cachedInputTokens?: number;
  /** Prompt tokens written to the provider cache, a subset of inputTokens. */
  readonly cacheWriteInputTokens?: number;
  readonly costUsdNanoDollars?: number;
  readonly costUsdMicros?: number;
  readonly idempotencyKey: string;
  readonly modelId: string;
  readonly occurredAt: number | string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly payer: ModelUsagePayer;
  readonly provider: ModelGatewayProvider;
  readonly quantity: number;
  readonly runId: string;
  readonly source: string;
  readonly startedAt?: number | string;
  readonly type: "model_tokens";
  readonly unit: "tokens";
}

const ModelUsagePayerSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("operator") }),
  Schema.Struct({ kind: Schema.Literal("organization"), modelCredentialId: Schema.NonEmptyString }),
]);

export const ModelUsageLedgerEntrySchema = Schema.Struct({
  cachedInputTokens: Schema.optionalKey(Schema.Number),
  cacheWriteInputTokens: Schema.optionalKey(Schema.Number),
  costUsdNanoDollars: Schema.optionalKey(Schema.Number),
  costUsdMicros: Schema.optionalKey(Schema.Number),
  idempotencyKey: Schema.String,
  modelId: Schema.String,
  occurredAt: Schema.Union([Schema.Number, Schema.String]),
  inputTokens: Schema.optionalKey(Schema.Number),
  outputTokens: Schema.optionalKey(Schema.Number),
  payer: ModelUsagePayerSchema,
  provider: ModelGatewayProviderSchema,
  quantity: Schema.Number,
  runId: Schema.String,
  source: Schema.String,
  startedAt: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
  type: Schema.Literal("model_tokens"),
  unit: Schema.Literal("tokens"),
});

export interface NormalizeModelUsageRequest {
  /** Catalog prices for the served model; used when the gateway response carries no cost. */
  readonly catalogPricing?: ModelTokenPricing;
  readonly costUsdMicros?: number;
  readonly modelCallId: string;
  readonly modelId: string;
  readonly occurredAt?: number | string;
  /** Who pays for the call: the funding the served model's provider ran under. */
  readonly payer: ModelFunding;
  readonly provider: ModelGatewayProvider;
  readonly response?: unknown;
  readonly runId: string;
  readonly startedAt?: number | string;
  readonly usage?: {
    readonly completionTokens?: number;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly promptTokens?: number;
    readonly totalTokens?: number;
  };
}

export interface OpenAiCompatibleEmbeddingRequest {
  readonly baseURL: string;
  readonly defaultHeaders: Readonly<Record<string, string>>;
  readonly dimensions: number;
  readonly errorContext?: string;
  readonly fallbackModelIds?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly input: string;
  readonly model: string;
  readonly signal?: AbortSignal;
  /** Backoff sleep between transient-failure retries; injectable for deterministic tests. */
  readonly sleep?: ProviderRetrySleep;
}

export interface ReasoningDetail {
  readonly type: `reasoning.${string}`;
  readonly [field: string]: unknown;
}

export interface OpenAiCompatibleChatCompletionMessage {
  readonly content: string | readonly unknown[];
  readonly role: "assistant" | "system" | "tool" | "user" | (string & {});
  readonly reasoning_details?: readonly ReasoningDetail[];
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly {
    readonly function: {
      readonly arguments: string;
      readonly name: string;
    };
    readonly id: string;
    readonly type: "function";
  }[];
}

export interface OpenAiCompatibleChatCompletionRequest {
  readonly baseURL: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly defaultHeaders: Readonly<Record<string, string>>;
  readonly errorContext?: string;
  readonly fetch?: typeof fetch;
  readonly headersTimeoutMs?: number;
  /** Receives the primary choice's streamed assistant text as it arrives. */
  readonly onTextDelta?: (text: string) => void;
  readonly signal?: AbortSignal;
  /** Backoff sleep between transient-failure retries; injectable for deterministic tests. */
  readonly sleep?: ProviderRetrySleep;
  /** Inter-chunk idle limit for streamed completions; defaults to 300 s. */
  readonly streamIdleTimeoutMs?: number;
}

export interface ModelGatewayChatCompletionRequest {
  readonly additionalBody?: Readonly<Record<string, unknown>>;
  readonly fallbackModelIds?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly maxTokens?: number;
  readonly messages: readonly OpenAiCompatibleChatCompletionMessage[];
  /** Admitted catalog metadata keyed by canonical platform model id (primary and fallbacks). */
  readonly modelCatalog?: ModelCatalogRuntimeEntries;
  readonly modelCallId?: string;
  readonly modelId?: string;
  /** Receives streamed assistant text; never alters the aggregated result. */
  readonly onTextDelta?: (text: string) => void;
  readonly parallelToolCalls?: boolean;
  readonly responseFormat?: {
    readonly type: "json_schema";
    readonly name: string;
    readonly schema: Readonly<Record<string, unknown>>;
  };
  readonly runId?: string;
  readonly scope?: ModelGatewayRouteScope;
  readonly signal?: AbortSignal;
  readonly toolChoice?: "auto" | "none" | "required";
  readonly tools?: readonly Readonly<Record<string, unknown>>[];
  readonly usageAttemptId?: string;
}

export interface ModelGatewayChatCompletionResult {
  readonly assistantMessage?: string;
  readonly body: unknown;
  /** Prompt tokens served from the provider cache, a subset of inputTokens. */
  readonly cachedInputTokens?: number;
  /** Prompt tokens written to the provider cache, a subset of inputTokens. */
  readonly cacheWriteInputTokens?: number;
  readonly finishReason?: string;
  readonly inputTokens?: number;
  readonly modelCallId: string;
  readonly modelId?: string;
  readonly providerRequestId?: string;
  readonly reasoningDetails?: readonly ReasoningDetail[];
  readonly responseShape?: ModelGatewayChatCompletionResponseShape;
  readonly outputTokens?: number;
  readonly route: ModelGatewayRoute;
  readonly servedProvider?: string;
  readonly totalTokens?: number;
  readonly responseError?: string;
  readonly toolCalls?: readonly ModelGatewayToolCall[];
  readonly usage?: ModelUsageLedgerEntry;
}

export interface ModelGatewayToolCall {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly name: string;
}

export interface ModelGatewayEmbeddingRequest {
  readonly dimensions: number;
  readonly fallbackModelIds?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly input: string;
  readonly modelCallId: string;
  readonly modelId?: string;
  /**
   * Called once credentials resolve, just before the provider request is sent. The returned
   * signal bounds only the provider round-trip; `signal` bounds the whole call.
   */
  readonly providerSignal?: () => AbortSignal;
  /** A route resolved for this exact request and pinned after revalidation by the gateway. */
  readonly resolvedRoute?: ModelGatewayRoute;
  readonly runId: string;
  readonly scope?: ModelGatewayRouteScope;
  readonly signal?: AbortSignal;
}

export interface ModelGatewayEmbeddingResult {
  readonly body: unknown;
  readonly embedding: readonly number[];
  readonly modelId: string;
  readonly provider: ModelGatewayProvider;
  readonly usage?: ModelUsageLedgerEntry;
  readonly usageTokens?: number;
}

export interface OpenAiCompatibleEmbeddingResponse {
  readonly body: unknown;
  readonly embedding?: readonly number[];
  readonly usageTokens?: number;
}

export class ModelGatewayEmbeddingResponseError extends Schema.TaggedErrorClass<ModelGatewayEmbeddingResponseError>()(
  "ModelGatewayEmbeddingResponseError",
  {
    message: Schema.String,
    modelCallId: Schema.String,
    usage: Schema.optional(ModelUsageLedgerEntrySchema),
  },
) {}

export interface ModelGatewayService {
  readonly chatCompletion: (
    request: ModelGatewayChatCompletionRequest,
  ) => Effect.Effect<
    ModelGatewayChatCompletionResult,
    | ModelGatewayConfigError
    | ModelGatewayRequestError
    | ModelGatewayRouteError
    | ModelGatewayUsageError
  >;
  readonly embedding: (
    request: ModelGatewayEmbeddingRequest,
  ) => Effect.Effect<
    ModelGatewayEmbeddingResult,
    | ModelGatewayConfigError
    | ModelGatewayEmbeddingResponseError
    | ModelGatewayRequestError
    | ModelGatewayRouteError
    | ModelGatewayUsageError
  >;
  readonly resolveRoute: (
    request: ResolveModelRouteRequest,
  ) => Effect.Effect<ModelGatewayRoute, ModelGatewayRouteError>;
  readonly usageLedgerEntry: (
    request: NormalizeModelUsageRequest,
  ) => Effect.Effect<ModelUsageLedgerEntry | undefined, ModelGatewayUsageError>;
}

export class ModelGateway extends Context.Service<ModelGateway, ModelGatewayService>()(
  "@deployments-ai/ModelGateway",
) {}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function stripPrefix(value: string, prefix: string) {
  return value.toLowerCase().startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

export function providerModelIdFromSuffix(suffix: string | undefined) {
  const providerModelId = suffix?.trim();
  if (!providerModelId) return undefined;
  if (providerModelId.split("/").some((segment) => !segment.trim())) return undefined;

  return providerModelId;
}

export function dedupeValues(values: readonly string[]) {
  return [...new Set(values)];
}

export * from "./response-types.ts";
