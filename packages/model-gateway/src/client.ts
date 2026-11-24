import { Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import {
  chatCompletionAssistantMessage,
  chatCompletionFinishReason,
  chatCompletionPlatformServedProvider,
  chatCompletionResponseShape,
  chatCompletionReasoningDetails,
  chatCompletionServedModelId,
  chatCompletionToolCalls,
} from "./responses.ts";
import { unverifiedModelGatewayTokenClaims } from "./gateway-token.ts";
import { fundingForProvider } from "./model-funding.ts";
import {
  modelGatewayRequestHeaders,
  modelProviderForId,
  normalizeOpenAiCompatibleBaseUrl,
  resolveModelRoute,
} from "./routing.ts";
import {
  MODEL_GATEWAY_ENV_KEYS,
  ModelGateway,
  type ModelGatewayChatCompletionRequest,
  type ModelGatewayClientConfig,
  ModelGatewayConfigError,
  ModelGatewayEmbeddingResponseError,
  ModelGatewayRequestError,
  type ModelGatewayRoute,
  modelGatewayRouteIdentity,
  ModelGatewayRouteError,
  type ModelGatewayService,
  ModelGatewayUsageError,
  isRecord,
  stringValue,
} from "./types.ts";
import {
  assertModelUsageIdentity,
  chatCompletionBody,
  chatCompletionTokenMetadata,
  modelUsageLedgerEntry,
  modelUsageAttemptCallId,
  requestOpenAiCompatibleChatCompletion,
  requestOpenAiCompatibleEmbedding,
} from "./usage.ts";

function sameResolvedRoute(left: ModelGatewayRoute, right: ModelGatewayRoute) {
  return (
    left.bifrostModelId === right.bifrostModelId &&
    left.modelId === right.modelId &&
    left.provider === right.provider &&
    left.providerModelId === right.providerModelId &&
    left.requestedModelId === right.requestedModelId &&
    left.routeScopeRef === right.routeScopeRef &&
    left.fallbackModelIds.length === right.fallbackModelIds.length &&
    left.fallbackModelIds.every((modelId, index) => modelId === right.fallbackModelIds[index])
  );
}

/**
 * The base URL and headers of one gateway request, and the funding claim of its token. The token
 * covers the route's primary and fallback models; a credential source that cannot issue one fails
 * the request before it is sent.
 */
function requestClientConfig(
  config: ModelGatewayClientConfig,
  route: ModelGatewayRoute,
  scope: ModelGatewayChatCompletionRequest["scope"],
) {
  return Effect.tryPromise({
    catch: (cause) =>
      new ModelGatewayConfigError({
        key: MODEL_GATEWAY_ENV_KEYS.tokenIssuer[0],
        message: `Model gateway token unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
    try: async () => {
      const token = await config.credentials({
        modelIds: [route.modelId, ...route.fallbackModelIds],
        ...(scope ? { scope } : {}),
      });
      return {
        baseURL: normalizeOpenAiCompatibleBaseUrl(config.baseUrl),
        defaultHeaders: modelGatewayRequestHeaders(token),
        funding: unverifiedModelGatewayTokenClaims(token)?.funding,
      };
    },
  });
}

export function makeModelGateway(config: ModelGatewayClientConfig): ModelGatewayService {
  const routeConfig = {
    ...(config.defaultFallbackModelIds
      ? { defaultFallbackModelIds: config.defaultFallbackModelIds }
      : {}),
    ...(config.defaultModelId ? { defaultModelId: config.defaultModelId } : {}),
  };

  return {
    chatCompletion: Effect.fn("ModelGateway.chatCompletion")((request) =>
      Effect.gen(function* () {
        const requestedModelCallId = stringValue(request.modelCallId);
        const requestRunId = request.runId === undefined ? undefined : stringValue(request.runId);
        const scopeRunId =
          request.scope?.runId === undefined ? undefined : stringValue(request.scope.runId);
        if (
          (request.runId !== undefined && !requestRunId) ||
          (request.scope?.runId !== undefined && !scopeRunId)
        ) {
          return yield* new ModelGatewayUsageError({
            message: "Metered chat requests require a stable run id.",
            modelCallId: request.modelCallId ?? "",
          });
        }
        if (requestRunId && scopeRunId && requestRunId !== scopeRunId) {
          return yield* new ModelGatewayUsageError({
            message: "Chat runId must match scope.runId when both are provided.",
            modelCallId: request.modelCallId ?? "",
          });
        }
        const runId = requestRunId ?? scopeRunId;
        if (runId && !requestedModelCallId) {
          return yield* new ModelGatewayUsageError({
            message: "Metered chat requests require a caller-stable model call id.",
            modelCallId: request.modelCallId ?? "",
          });
        }
        const route = yield* Effect.try({
          catch: (cause) =>
            cause instanceof ModelGatewayRouteError
              ? cause
              : new ModelGatewayRouteError({
                  message: cause instanceof Error ? cause.message : String(cause),
                  modelId: request.modelId ?? "",
                }),
          try: () =>
            resolveModelRoute(
              {
                ...(request.fallbackModelIds ? { fallbackModelIds: request.fallbackModelIds } : {}),
                ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
                ...(request.scope ? { scope: request.scope } : {}),
              },
              routeConfig,
            ),
        });
        const usageAttemptCallId =
          runId && requestedModelCallId
            ? modelUsageAttemptCallId(
                requestedModelCallId,
                stringValue(request.usageAttemptId) ?? randomUUID(),
              )
            : undefined;
        if (runId && requestedModelCallId && usageAttemptCallId) {
          yield* Effect.try({
            catch: (cause) =>
              cause instanceof ModelGatewayUsageError
                ? cause
                : new ModelGatewayUsageError({
                    message: cause instanceof Error ? cause.message : String(cause),
                    modelCallId: requestedModelCallId,
                  }),
            try: () => {
              for (const modelId of [route.modelId, ...route.fallbackModelIds]) {
                assertModelUsageIdentity({
                  modelCallId: usageAttemptCallId,
                  modelId,
                  runId,
                });
              }
            },
          });
        }
        const clientConfig = yield* requestClientConfig(config, route, request.scope);
        const startedAt = Date.now();
        const body = yield* Effect.tryPromise({
          catch: (cause) =>
            cause instanceof ModelGatewayRequestError
              ? cause
              : new ModelGatewayRequestError({
                  endpoint: "openai-compatible:chat/completions",
                  message: cause instanceof Error ? cause.message : String(cause),
                }),
          try: (effectSignal) => {
            const signal =
              request.signal && effectSignal
                ? AbortSignal.any([effectSignal, request.signal])
                : (request.signal ?? effectSignal);
            return requestOpenAiCompatibleChatCompletion({
              baseURL: clientConfig.baseURL,
              body: chatCompletionBody(request, route),
              defaultHeaders: clientConfig.defaultHeaders,
              errorContext: "Model gateway chat completion",
              ...(request.fetch ? { fetch: request.fetch } : {}),
              ...(request.onTextDelta ? { onTextDelta: request.onTextDelta } : {}),
              ...(signal ? { signal } : {}),
            });
          },
        });
        const occurredAt = Date.now();
        const modelId = chatCompletionServedModelId(body, route);
        const providerRequestId = isRecord(body) ? stringValue(body.id) : undefined;
        const modelCallId = requestedModelCallId ?? providerRequestId ?? route.bifrostModelId;
        const usage =
          runId && modelId && requestedModelCallId && usageAttemptCallId
            ? yield* Effect.try({
                catch: (cause) =>
                  cause instanceof ModelGatewayUsageError
                    ? cause
                    : new ModelGatewayUsageError({
                        message: cause instanceof Error ? cause.message : String(cause),
                        modelCallId,
                      }),
                try: () =>
                  modelUsageLedgerEntry({
                    ...(request.modelCatalog?.[modelId]
                      ? { catalogPricing: request.modelCatalog[modelId].pricing }
                      : {}),
                    modelCallId: usageAttemptCallId,
                    modelId,
                    occurredAt,
                    // The gateway funds only the primary model, so a funded call is served by it.
                    payer: fundingForProvider(clientConfig.funding, route.provider),
                    provider: route.provider,
                    response: body,
                    runId,
                    startedAt,
                  }),
              })
            : undefined;
        if (runId && !usage) {
          return yield* new ModelGatewayUsageError({
            message: "Metered chat responses require valid usage metadata.",
            modelCallId,
          });
        }
        const assistantMessage = chatCompletionAssistantMessage(body);
        const finishReason = chatCompletionFinishReason(body);
        const responseShape = chatCompletionResponseShape(body);
        const reasoningDetails = chatCompletionReasoningDetails(body);
        const servedProvider = chatCompletionPlatformServedProvider(body);
        let toolCalls: ReturnType<typeof chatCompletionToolCalls>;
        let responseError: string | undefined;
        try {
          toolCalls = chatCompletionToolCalls(body);
        } catch {
          responseError = "Model gateway returned malformed tool calls.";
        }

        return {
          ...(assistantMessage ? { assistantMessage } : {}),
          body,
          ...(finishReason ? { finishReason } : {}),
          modelCallId,
          ...(modelId ? { modelId } : {}),
          ...(providerRequestId ? { providerRequestId } : {}),
          ...(reasoningDetails ? { reasoningDetails } : {}),
          responseShape,
          route,
          ...(responseError ? { responseError } : {}),
          ...(servedProvider ? { servedProvider } : {}),
          ...(toolCalls ? { toolCalls } : {}),
          ...chatCompletionTokenMetadata(body, usage),
          ...(usage ? { usage } : {}),
        };
      }),
    ),
    embedding: Effect.fn("ModelGateway.embedding")((request) =>
      Effect.gen(function* () {
        const modelCallId = stringValue(request.modelCallId);
        if (!modelCallId) {
          return yield* new ModelGatewayUsageError({
            message: "Embedding usage requires a stable model call id.",
            modelCallId: request.modelCallId,
          });
        }
        const requestRunId = stringValue(request.runId);
        const scopeRunId =
          request.scope?.runId === undefined ? undefined : stringValue(request.scope.runId);
        if (!requestRunId || (request.scope?.runId !== undefined && !scopeRunId)) {
          return yield* new ModelGatewayUsageError({
            message: "Embedding usage requires a stable run id.",
            modelCallId,
          });
        }
        if (scopeRunId && requestRunId !== scopeRunId) {
          return yield* new ModelGatewayUsageError({
            message: "Embedding runId must match scope.runId when both are provided.",
            modelCallId,
          });
        }
        const runId = scopeRunId ?? requestRunId;
        const currentRoute = yield* Effect.try({
          catch: (cause) =>
            cause instanceof ModelGatewayRouteError
              ? cause
              : new ModelGatewayRouteError({
                  message: cause instanceof Error ? cause.message : String(cause),
                  modelId: request.modelId ?? "",
                }),
          try: () =>
            resolveModelRoute(
              {
                fallbackModelIds: request.fallbackModelIds ?? [],
                ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
                ...(request.resolvedRoute
                  ? { routeIdentity: modelGatewayRouteIdentity(request.resolvedRoute) }
                  : {}),
                ...(request.scope ? { scope: request.scope } : {}),
              },
              routeConfig,
            ),
        });
        if (request.resolvedRoute && !sameResolvedRoute(request.resolvedRoute, currentRoute)) {
          return yield* new ModelGatewayRouteError({
            message: "The pinned embedding route no longer matches the resolved request route.",
            modelId: request.modelId ?? "",
          });
        }
        const route = request.resolvedRoute ?? currentRoute;
        const usageAttemptCallId = modelUsageAttemptCallId(modelCallId, randomUUID());
        yield* Effect.try({
          catch: (cause) =>
            cause instanceof ModelGatewayUsageError
              ? cause
              : new ModelGatewayUsageError({
                  message: cause instanceof Error ? cause.message : String(cause),
                  modelCallId,
                }),
          try: () =>
            assertModelUsageIdentity({
              modelCallId: usageAttemptCallId,
              modelId: route.modelId,
              runId,
            }),
        });
        const clientConfig = yield* requestClientConfig(config, route, request.scope);
        const startedAt = Date.now();
        const result = yield* Effect.tryPromise({
          catch: (cause) =>
            cause instanceof ModelGatewayRequestError
              ? cause
              : new ModelGatewayRequestError({
                  endpoint: "openai-compatible:embeddings",
                  message: cause instanceof Error ? cause.message : String(cause),
                }),
          try: (effectSignal) => {
            const signal = AbortSignal.any([
              effectSignal,
              ...(request.signal ? [request.signal] : []),
              ...(request.providerSignal ? [request.providerSignal()] : []),
            ]);
            return requestOpenAiCompatibleEmbedding({
              baseURL: clientConfig.baseURL,
              defaultHeaders: clientConfig.defaultHeaders,
              dimensions: request.dimensions,
              errorContext: "Model gateway embedding",
              fallbackModelIds: route.fallbackModelIds,
              ...(request.fetch ? { fetch: request.fetch } : {}),
              input: request.input,
              model: route.bifrostModelId,
              signal,
            });
          },
        });

        const servedModelId = chatCompletionServedModelId(result.body, route);
        if (!servedModelId) {
          return yield* new ModelGatewayEmbeddingResponseError({
            message:
              "Model gateway embedding response did not identify an authorized served model.",
            modelCallId,
          });
        }
        const servedProvider = modelProviderForId(servedModelId);

        const usage = yield* Effect.try({
          catch: (cause) =>
            cause instanceof ModelGatewayUsageError
              ? cause
              : new ModelGatewayUsageError({
                  message: cause instanceof Error ? cause.message : String(cause),
                  modelCallId,
                }),
          try: () =>
            modelUsageLedgerEntry({
              modelCallId: usageAttemptCallId,
              modelId: servedModelId,
              occurredAt: Date.now(),
              // The gateway serves embeddings with the operator's key whatever the token claims.
              payer: { kind: "operator" },
              provider: servedProvider,
              response: result.body,
              runId,
              startedAt,
              ...(result.usageTokens === undefined
                ? {}
                : { usage: { totalTokens: result.usageTokens } }),
            }),
        });
        if (!usage) {
          return yield* new ModelGatewayUsageError({
            message: "Embedding responses require valid usage metadata.",
            modelCallId,
          });
        }
        if (![route.modelId, ...route.fallbackModelIds].includes(servedModelId)) {
          return yield* new ModelGatewayEmbeddingResponseError({
            message:
              "Model gateway embedding response did not identify an authorized served model.",
            modelCallId,
            usage,
          });
        }
        if (!result.embedding) {
          return yield* new ModelGatewayEmbeddingResponseError({
            message: "Model gateway embedding response did not contain a valid vector.",
            modelCallId,
            usage,
          });
        }

        return {
          ...result,
          embedding: result.embedding,
          modelId: servedModelId,
          provider: servedProvider,
          usage,
        };
      }),
    ),
    resolveRoute: Effect.fn("ModelGateway.resolveRoute")((request) =>
      Effect.try({
        catch: (cause) =>
          cause instanceof ModelGatewayRouteError
            ? cause
            : new ModelGatewayRouteError({
                message: cause instanceof Error ? cause.message : String(cause),
                modelId: request.modelId ?? "",
              }),
        try: () => resolveModelRoute(request, routeConfig),
      }),
    ),
    usageLedgerEntry: Effect.fn("ModelGateway.usageLedgerEntry")((request) =>
      Effect.try({
        catch: (cause) =>
          cause instanceof ModelGatewayUsageError
            ? cause
            : new ModelGatewayUsageError({
                message: cause instanceof Error ? cause.message : String(cause),
                modelCallId: request.modelCallId,
              }),
        try: () => modelUsageLedgerEntry(request),
      }),
    ),
  };
}

export function modelGatewayLayer(config: ModelGatewayClientConfig) {
  return Layer.succeed(ModelGateway, makeModelGateway(config));
}
