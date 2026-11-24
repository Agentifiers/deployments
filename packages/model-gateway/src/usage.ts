import {
  integerRecordValue,
  integerFromValues,
  positiveInteger,
  responseCostUsdMicros,
  responseTotalTokens,
  responseUsageRecord,
  usageSplitTokenTotal,
  usageTokensFromResponse,
  usageTotalTokenValue,
} from "./responses.ts";
import { modelCatalogCostUsdNanoDollars } from "./model-catalog.ts";
import { modelProviderForId, normalizeModelId, openAiCompatibleEndpoint } from "./routing.ts";
import {
  RESPONSE_INPUT_TOKEN_KEYS,
  RESPONSE_OUTPUT_TOKEN_KEYS,
  RESPONSE_TOTAL_TOKEN_KEYS,
} from "./response-types.ts";
import {
  type ModelGatewayChatCompletionRequest,
  type ModelGatewayEmbeddingResult,
  ModelGatewayRequestError,
  type ModelGatewayRoute,
  ModelGatewayUsageError,
  type ModelUsageLedgerEntry,
  type NormalizeModelUsageRequest,
  type OpenAiCompatibleChatCompletionRequest,
  type OpenAiCompatibleEmbeddingRequest,
  type OpenAiCompatibleEmbeddingResponse,
  isRecord,
} from "./types.ts";
import {
  RETRYABLE_PROVIDER_ERROR_CODES,
  requestWithProviderRetry,
  retryableProviderStatus,
} from "./provider-retry.ts";
import {
  chatCompletionProviderErrorDiagnostic,
  providerErrorMessageSuffix,
} from "./provider-errors.ts";
import {
  CHAT_COMPLETION_STREAM_IDLE_TIMEOUT_MS,
  readChatCompletionEventStream,
} from "./chat-completion-stream.ts";
import { fetch as undiciFetch } from "undici";

const MODEL_USAGE_DYNAMODB_SORT_KEY_MAX_BYTES = 1_024;
const MODEL_USAGE_DYNAMODB_SORT_KEY_PREFIX = "METER-EVENT#";
const MODEL_USAGE_DYNAMODB_GSI_SORT_KEY_PREFIX = `${encodeURIComponent(
  "+275760-09-13T00:00:00.000Z",
)}#`;
const MODEL_USAGE_ATTEMPT_ID_PLACEHOLDER = "00000000-0000-4000-8000-000000000000";
const CANONICAL_ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

function usageTokenValue(
  explicitValues: readonly unknown[],
  response: unknown,
  responseKeys: readonly string[],
) {
  const explicit = integerFromValues(explicitValues);
  if (explicit.invalid) return undefined;
  if (explicit.value !== undefined) return explicit.value;
  const responseUsage = responseUsageRecord(response);
  if (!responseUsage) return undefined;
  return integerRecordValue(responseUsage, responseKeys).value;
}

// OpenRouter reports cached_tokens/cache_write_tokens; Bifrost normalizes to cached_*_tokens.
const PROMPT_CACHE_READ_TOKEN_KEYS = ["cached_tokens", "cached_read_tokens"] as const;
const PROMPT_CACHE_WRITE_TOKEN_KEYS = ["cache_write_tokens", "cached_write_tokens"] as const;

function promptCacheTokens(response: unknown) {
  const details = responseUsageRecord(response)?.prompt_tokens_details;
  if (!isRecord(details)) return {};
  const cachedInputTokens = integerRecordValue(details, PROMPT_CACHE_READ_TOKEN_KEYS).value;
  const cacheWriteInputTokens = integerRecordValue(details, PROMPT_CACHE_WRITE_TOKEN_KEYS).value;
  return {
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {}),
  };
}

export function modelUsageAttemptCallId(modelCallId: string, attemptId: string) {
  return `${modelCallId}:attempt:${attemptId}`;
}

export function assertModelUsageIdentity(request: {
  readonly modelCallId: string;
  readonly modelId: string;
  readonly runId: string;
}) {
  const modelCallId = request.modelCallId.trim();
  if (!modelCallId) {
    throw new ModelGatewayUsageError({
      message: "Model usage idempotency requires a stable model call id.",
      modelCallId: request.modelCallId,
    });
  }
  const runId = request.runId.trim();
  if (!CANONICAL_ULID_PATTERN.test(runId)) {
    throw new ModelGatewayUsageError({
      message: "Model usage idempotency requires a canonical ULID run id.",
      modelCallId,
    });
  }
  const requestedModelId = request.modelId.trim();
  if (!requestedModelId) {
    throw new ModelGatewayUsageError({
      message: "Model usage requires a stable model id.",
      modelCallId,
    });
  }
  const modelId = normalizeModelId(requestedModelId);
  const idempotencyKey = `${runId}:model_tokens:bifrost:${modelCallId}:${modelId}`;
  const encodedIdempotencyKey = encodeURIComponent(idempotencyKey);
  const sortKeys = [
    `${MODEL_USAGE_DYNAMODB_SORT_KEY_PREFIX}${encodedIdempotencyKey}`,
    `${MODEL_USAGE_DYNAMODB_GSI_SORT_KEY_PREFIX}${encodedIdempotencyKey}`,
  ];
  if (
    sortKeys.some(
      (sortKey) =>
        new TextEncoder().encode(sortKey).byteLength > MODEL_USAGE_DYNAMODB_SORT_KEY_MAX_BYTES,
    )
  ) {
    throw new ModelGatewayUsageError({
      message: "Model usage identity exceeds the DynamoDB sort-key limit.",
      modelCallId,
    });
  }

  return { idempotencyKey, modelCallId, modelId, runId };
}

export function assertModelUsageAttemptIdentity(request: {
  readonly modelCallId: string;
  readonly modelId: string;
  readonly runId: string;
}) {
  return assertModelUsageIdentity({
    ...request,
    modelCallId: modelUsageAttemptCallId(request.modelCallId, MODEL_USAGE_ATTEMPT_ID_PLACEHOLDER),
  });
}

export function modelUsageLedgerEntry(
  request: NormalizeModelUsageRequest,
): ModelUsageLedgerEntry | undefined {
  const { idempotencyKey, modelId, runId } = assertModelUsageIdentity(request);
  const provider = modelProviderForId(modelId);
  const { payer } = request;
  if (payer.kind === "organization" && payer.provider !== provider) {
    throw new ModelGatewayUsageError({
      message: `Usage of ${modelId} cannot be paid with an organization's ${payer.provider} credential.`,
      modelCallId: request.modelCallId,
    });
  }

  const totalTokens =
    usageTotalTokenValue(request.usage) ??
    responseTotalTokens(request.response) ??
    usageSplitTokenTotal(request.usage);
  if (totalTokens === undefined) return undefined;

  const inputTokens = usageTokenValue(
    [request.usage?.inputTokens, request.usage?.promptTokens],
    request.response,
    RESPONSE_INPUT_TOKEN_KEYS,
  );
  const outputTokens = usageTokenValue(
    [request.usage?.outputTokens, request.usage?.completionTokens],
    request.response,
    RESPONSE_OUTPUT_TOKEN_KEYS,
  );

  const explicitCostUsdMicros = positiveInteger(request.costUsdMicros);
  const cacheTokens = promptCacheTokens(request.response);
  const catalogCostUsdNanoDollars =
    request.catalogPricing && inputTokens !== undefined && outputTokens !== undefined
      ? modelCatalogCostUsdNanoDollars(request.catalogPricing, {
          ...cacheTokens,
          inputTokens,
          outputTokens,
        })
      : undefined;
  // Gateway-reported cost is authoritative; catalog prices meter models the gateway cannot price.
  const reportedCostUsdMicros = explicitCostUsdMicros ?? responseCostUsdMicros(request.response);
  const computedCost =
    reportedCostUsdMicros === undefined && catalogCostUsdNanoDollars !== undefined
      ? {
          costUsdMicros: Math.round(catalogCostUsdNanoDollars / 1_000),
          costUsdNanoDollars: catalogCostUsdNanoDollars,
        }
      : undefined;
  const costUsdMicros = computedCost?.costUsdMicros ?? reportedCostUsdMicros;

  return {
    ...cacheTokens,
    ...(computedCost ? { costUsdNanoDollars: computedCost.costUsdNanoDollars } : {}),
    ...(costUsdMicros !== undefined ? { costUsdMicros } : {}),
    idempotencyKey,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    modelId,
    occurredAt: request.occurredAt ?? Date.now(),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    payer:
      payer.kind === "organization"
        ? { kind: "organization", modelCredentialId: payer.credentialId }
        : { kind: "operator" },
    provider,
    quantity: totalTokens,
    runId,
    source: `bifrost:${modelId}`,
    ...(request.startedAt !== undefined ? { startedAt: request.startedAt } : {}),
    type: "model_tokens",
    unit: "tokens",
  };
}

async function readOpenAiCompatibleJsonBody(args: {
  readonly errorContext: string;
  readonly response: Response;
}): Promise<unknown> {
  const text = await args.response.text();
  if (!text.trim()) return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (args.response.ok) {
      throw new ModelGatewayRequestError({
        endpoint: args.response.url,
        message: `${args.errorContext} response was invalid JSON.`,
      });
    }

    return undefined;
  }
}

export function openAiCompatibleEmbeddingFromBody(args: {
  readonly body: unknown;
  readonly dimensions: number;
}): Pick<ModelGatewayEmbeddingResult, "embedding" | "usageTokens"> | undefined {
  if (!isRecord(args.body) || !Array.isArray(args.body.data)) return undefined;

  const first = args.body.data.find(isRecord);
  const embedding = Array.isArray(first?.embedding) ? first.embedding : undefined;
  if (
    !embedding ||
    embedding.length !== args.dimensions ||
    embedding.some((component) => typeof component !== "number" || !Number.isFinite(component))
  ) {
    return undefined;
  }

  const usageTokens = usageTokensFromResponse(args.body);
  return {
    embedding: embedding as number[],
    ...(usageTokens === undefined ? {} : { usageTokens }),
  };
}

export async function requestOpenAiCompatibleEmbedding(
  request: OpenAiCompatibleEmbeddingRequest,
): Promise<OpenAiCompatibleEmbeddingResponse> {
  const fetchImpl = request.fetch ?? globalThis.fetch;

  const errorContext = request.errorContext?.trim() || "OpenAI-compatible embedding";
  const endpoint = openAiCompatibleEndpoint(request.baseURL, "embeddings");
  const requestBody = JSON.stringify({
    dimensions: request.dimensions,
    ...(request.fallbackModelIds && request.fallbackModelIds.length > 0
      ? {
          fallbacks: request.fallbackModelIds,
        }
      : {}),
    input: request.input,
    model: request.model,
  });
  const body = await requestWithProviderRetry<unknown>({
    attempt: async () => {
      const response = await fetchImpl(endpoint, {
        body: requestBody,
        headers: request.defaultHeaders,
        method: "POST",
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const responseBody = await readOpenAiCompatibleJsonBody({ errorContext, response });
      if (response.ok) return { kind: "succeeded", value: responseBody };
      const { code, message } = chatCompletionProviderErrorDiagnostic(responseBody);
      const failure = new ModelGatewayRequestError({
        endpoint,
        message: `${errorContext} failed with status ${response.status}.`,
        ...(code ? { providerCode: code } : {}),
        status: response.status,
      });
      if (!retryableProviderStatus(response.status, message, code)) throw failure;
      return { failure, headers: response.headers, kind: "retryable" };
    },
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.sleep ? { sleep: request.sleep } : {}),
  });

  const embedding = openAiCompatibleEmbeddingFromBody({
    body,
    dimensions: request.dimensions,
  });
  if (embedding) return { body, ...embedding };
  const usageTokens = usageTokensFromResponse(body);
  return {
    body,
    ...(usageTokens === undefined ? {} : { usageTokens }),
  };
}

export async function requestOpenAiCompatibleChatCompletion(
  request: OpenAiCompatibleChatCompletionRequest,
): Promise<unknown> {
  // undici ships its own RequestInit/Response declarations that differ from the runtime's fetch
  // types (headers under exactOptionalPropertyTypes, static `preconnect`); runtime-compatible.
  const fetchImpl = request.fetch ?? (undiciFetch as unknown as typeof globalThis.fetch);

  const errorContext = request.errorContext?.trim() || "OpenAI-compatible chat completion";
  const endpoint = openAiCompatibleEndpoint(request.baseURL, "chat/completions");
  const requestBody = JSON.stringify(request.body);
  return await requestWithProviderRetry<unknown>({
    attempt: async () => {
      const response = await fetchImpl(endpoint, {
        body: requestBody,
        headers: request.defaultHeaders,
        method: "POST",
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (response.ok && contentType.includes("text/event-stream")) {
        return await readChatCompletionEventStream({
          endpoint,
          errorContext,
          idleTimeoutMs: request.streamIdleTimeoutMs ?? CHAT_COMPLETION_STREAM_IDLE_TIMEOUT_MS,
          ...(request.onTextDelta ? { onTextDelta: request.onTextDelta } : {}),
          response,
          ...(request.signal ? { signal: request.signal } : {}),
        });
      }
      // Rejections, and provider envelopes Bifrost answers before streaming, arrive as JSON.
      const body = await readOpenAiCompatibleJsonBody({ errorContext, response });
      const { code, error: providerError, message } = chatCompletionProviderErrorDiagnostic(body);
      if (!response.ok) {
        const failure = new ModelGatewayRequestError({
          endpoint,
          message: `${errorContext} failed with status ${response.status}${providerErrorMessageSuffix(code, message)}.`,
          ...(code ? { providerCode: code } : {}),
          ...(message ? { providerMessage: message } : {}),
          status: response.status,
        });
        if (!retryableProviderStatus(response.status, message, code)) throw failure;
        return { failure, headers: response.headers, kind: "retryable" };
      }
      if (!providerError) return { kind: "succeeded", value: body };

      const failure = new ModelGatewayRequestError({
        endpoint,
        message: `${errorContext} returned a provider error${providerErrorMessageSuffix(code, message)}.`,
        ...(code ? { providerCode: code } : {}),
        ...(message ? { providerMessage: message } : {}),
      });
      if (!code || !RETRYABLE_PROVIDER_ERROR_CODES[code]) throw failure;
      return { failure, headers: response.headers, kind: "retryable" };
    },
    ...(request.signal ? { signal: request.signal } : {}),
    ...(request.sleep ? { sleep: request.sleep } : {}),
  });
}

export function chatCompletionBody(
  request: ModelGatewayChatCompletionRequest,
  route: ModelGatewayRoute,
) {
  const { fallbacks: _fallbacks, ...additionalBody } = request.additionalBody ?? {};
  return {
    ...additionalBody,
    ...(route.fallbackModelIds.length > 0
      ? {
          fallbacks: route.fallbackModelIds,
        }
      : {}),
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    messages: request.messages,
    model: route.bifrostModelId,
    // Native JSON-schema enforcement is available on these compatible routes.
    // Other routes receive the same trusted schema instructions from the runtime,
    // whose final validator remains authoritative for every provider.
    ...(request.responseFormat && (route.provider === "openai" || route.provider === "openrouter")
      ? {
          response_format: {
            type: "json_schema",
            json_schema: {
              name: request.responseFormat.name,
              schema: request.responseFormat.schema,
              strict: false,
            },
          },
        }
      : {}),
    ...(request.parallelToolCalls === undefined
      ? {}
      : { parallel_tool_calls: request.parallelToolCalls }),
    stream: true,
    // Metered runs require usage; streamed completions report it only in a final chunk on request.
    stream_options: { include_usage: true },
    ...(request.toolChoice === undefined ? {} : { tool_choice: request.toolChoice }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
  };
}

export function chatCompletionTokenMetadata(
  body: unknown,
  usage: ModelUsageLedgerEntry | undefined,
) {
  const usageRecord = responseUsageRecord(body);
  const inputTokens = usageRecord
    ? integerRecordValue(usageRecord, RESPONSE_INPUT_TOKEN_KEYS).value
    : undefined;
  const outputTokens = usageRecord
    ? integerRecordValue(usageRecord, RESPONSE_OUTPUT_TOKEN_KEYS).value
    : undefined;
  const totalTokens =
    usage?.quantity ??
    (usageRecord ? integerRecordValue(usageRecord, RESPONSE_TOTAL_TOKEN_KEYS).value : undefined) ??
    responseTotalTokens(body);

  return {
    ...promptCacheTokens(body),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}
