import {
  BEDROCK_MODEL_PREFIX,
  DEFAULT_AGENT_MODEL_FALLBACK_IDS,
  DEFAULT_AGENT_MODEL_ID,
  MODEL_GATEWAY_ENV_KEYS,
  MODEL_GATEWAY_PROVIDERS,
  MODEL_PROVIDER_PREFIXES,
  type ModelGatewayClientConfig,
  ModelGatewayConfigError,
  type ModelGatewayProvider,
  type ModelGatewayRoute,
  type ModelGatewayRouteScope,
  modelGatewayRouteIdentity,
  ModelGatewayRouteError,
  OPENAI_MODEL_PREFIX,
  OPENROUTER_MODEL_PREFIX,
  OPENROUTER_UNPREFIXED_MODEL_IDS,
  type ResolveModelRouteRequest,
  dedupeValues,
  isRecord,
  optionalString,
  providerModelIdFromSuffix,
  stripPrefix,
} from "./types.ts";

/** A stable reference for a request scope, recorded on the route for attribution. */
export function routeScopeRef(scope: ModelGatewayRouteScope | undefined) {
  const parts = [
    ["organization", optionalString(scope?.organizationId)],
    ["workspace", optionalString(scope?.workspaceId)],
    ["agent", optionalString(scope?.agentId)],
    ["run", optionalString(scope?.runId)],
  ].flatMap(([kind, id]) => (id ? [`${kind}:${id}`] : []));
  return parts.length > 0 ? parts.join("/") : undefined;
}

export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new ModelGatewayConfigError({
      key: MODEL_GATEWAY_ENV_KEYS.baseUrl[0],
      message: "Bifrost base URL is required.",
    });
  }

  return trimmed.toLowerCase().endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export function openAiCompatibleEndpoint(baseUrl: string, path: string) {
  const normalizedPath = path.trim().replace(/^\/+|\/+$/g, "");
  if (!normalizedPath) {
    throw new ModelGatewayConfigError({
      key: MODEL_GATEWAY_ENV_KEYS.baseUrl[0],
      message: "OpenAI-compatible endpoint path is required.",
    });
  }

  return `${normalizeOpenAiCompatibleBaseUrl(baseUrl)}/${normalizedPath}`;
}

/** Foundation model ids (`amazon.nova-micro-v1:0`) and system inference profile ids (`us.…`). */
const BEDROCK_PROVIDER_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:_-]*$/u;

export function normalizeModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return DEFAULT_AGENT_MODEL_ID;

  const lower = trimmed.toLowerCase();
  if (lower === "bedrock" || lower === "openai" || lower === "openrouter") {
    throw new ModelGatewayRouteError({
      message: "Provider-only model ids must include a provider model id.",
      modelId,
    });
  }
  if (lower.startsWith(BEDROCK_MODEL_PREFIX)) {
    const providerModelId = stripPrefix(trimmed, BEDROCK_MODEL_PREFIX)?.trim();
    if (!providerModelId) {
      throw new ModelGatewayRouteError({
        message: "Bedrock model id is missing the foundation model or inference profile id.",
        modelId,
      });
    }
    if (!BEDROCK_PROVIDER_MODEL_ID_PATTERN.test(providerModelId)) {
      throw new ModelGatewayRouteError({
        message:
          "Bedrock model ids must name a foundation model or inference profile id, for example bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0; ARNs are not supported.",
        modelId,
      });
    }

    return `${BEDROCK_MODEL_PREFIX}${providerModelId}`;
  }
  if (lower.startsWith(OPENROUTER_MODEL_PREFIX)) {
    const providerModelId = providerModelIdFromSuffix(
      stripPrefix(trimmed, OPENROUTER_MODEL_PREFIX),
    );
    if (!providerModelId) {
      throw new ModelGatewayRouteError({
        message: "OpenRouter model id is missing the provider model id.",
        modelId,
      });
    }

    return `${OPENROUTER_MODEL_PREFIX}${providerModelId}`;
  }
  if (lower.startsWith(OPENAI_MODEL_PREFIX)) {
    const providerModelId = providerModelIdFromSuffix(stripPrefix(trimmed, OPENAI_MODEL_PREFIX));
    if (!providerModelId) {
      throw new ModelGatewayRouteError({
        message: "OpenAI model id is missing the provider model id.",
        modelId,
      });
    }

    return `${OPENAI_MODEL_PREFIX}${providerModelId}`;
  }
  if (OPENROUTER_UNPREFIXED_MODEL_IDS.has(lower)) return `${OPENROUTER_MODEL_PREFIX}${trimmed}`;
  if (trimmed.includes("/")) {
    const providerModelId = providerModelIdFromSuffix(trimmed);
    if (!providerModelId) {
      throw new ModelGatewayRouteError({
        message: "OpenRouter model id is missing the provider model id.",
        modelId,
      });
    }

    return `${OPENROUTER_MODEL_PREFIX}${providerModelId}`;
  }

  return `${OPENAI_MODEL_PREFIX}${trimmed}`;
}

function normalizeExplicitModelId(modelId: string, message: string) {
  const trimmed = modelId.trim();
  if (!trimmed) {
    throw new ModelGatewayRouteError({
      message,
      modelId,
    });
  }

  return normalizeModelId(trimmed);
}

export function modelProviderForId(modelId: string): ModelGatewayProvider {
  const lower = modelId.toLowerCase();
  if (lower.startsWith(BEDROCK_MODEL_PREFIX)) return "bedrock";
  return lower.startsWith(OPENROUTER_MODEL_PREFIX) ? "openrouter" : "openai";
}

export function providerModelIdForModelId(modelId: string) {
  return stripPrefix(modelId, MODEL_PROVIDER_PREFIXES[modelProviderForId(modelId)]) ?? modelId;
}

function parsedModelGatewayRouteIdentity(
  identity: string,
  requestedModelId: string,
): ModelGatewayRoute {
  let value: unknown;
  try {
    value = JSON.parse(identity);
  } catch {
    throw new ModelGatewayRouteError({
      message: "Pinned model route identity is invalid.",
      modelId: requestedModelId,
    });
  }
  if (!isRecord(value)) {
    throw new ModelGatewayRouteError({
      message: "Pinned model route identity is invalid.",
      modelId: requestedModelId,
    });
  }
  const fallbackModelIds = value.fallbackModelIds;
  const routeScopeRefValue = value.routeScopeRef;
  if (
    typeof value.bifrostModelId !== "string" ||
    !Array.isArray(fallbackModelIds) ||
    fallbackModelIds.some((modelId) => typeof modelId !== "string") ||
    typeof value.modelId !== "string" ||
    !MODEL_GATEWAY_PROVIDERS.includes(value.provider as ModelGatewayProvider) ||
    typeof value.providerModelId !== "string" ||
    typeof value.requestedModelId !== "string" ||
    (routeScopeRefValue !== null && typeof routeScopeRefValue !== "string")
  ) {
    throw new ModelGatewayRouteError({
      message: "Pinned model route identity is invalid.",
      modelId: requestedModelId,
    });
  }
  const route: ModelGatewayRoute = {
    bifrostModelId: value.bifrostModelId,
    fallbackModelIds: [...fallbackModelIds] as string[],
    modelId: value.modelId,
    provider: value.provider as ModelGatewayProvider,
    providerModelId: value.providerModelId,
    requestedModelId: value.requestedModelId,
    ...(routeScopeRefValue === null ? {} : { routeScopeRef: routeScopeRefValue }),
  };
  if (modelGatewayRouteIdentity(route) !== identity) {
    throw new ModelGatewayRouteError({
      message: "Pinned model route identity is not canonical.",
      modelId: requestedModelId,
    });
  }
  return route;
}

function resolveUnpinnedModelRoute(
  request: ResolveModelRouteRequest,
  config: Pick<ModelGatewayClientConfig, "defaultFallbackModelIds" | "defaultModelId"> = {},
): ModelGatewayRoute {
  const requestedModelId =
    request.modelId?.trim() || config.defaultModelId || DEFAULT_AGENT_MODEL_ID;
  const modelId = normalizeModelId(requestedModelId);
  const provider = modelProviderForId(modelId);
  const providerModelId = providerModelIdForModelId(modelId);
  if (!providerModelId.trim()) {
    throw new ModelGatewayRouteError({
      message: "Model id does not include a provider model id.",
      modelId: requestedModelId,
    });
  }
  const fallbackModelIds = dedupeValues(
    (request.fallbackModelIds ?? config.defaultFallbackModelIds ?? DEFAULT_AGENT_MODEL_FALLBACK_IDS)
      .map((fallbackModelId) =>
        normalizeExplicitModelId(fallbackModelId, "Fallback model id is required."),
      )
      .filter((fallbackModelId) => fallbackModelId !== modelId),
  );
  const scopeRef = routeScopeRef(request.scope);

  return {
    bifrostModelId: modelId,
    fallbackModelIds,
    modelId,
    provider,
    providerModelId,
    requestedModelId,
    ...(scopeRef ? { routeScopeRef: scopeRef } : {}),
  };
}

export function resolveModelRoute(
  request: ResolveModelRouteRequest,
  config: Pick<ModelGatewayClientConfig, "defaultFallbackModelIds" | "defaultModelId"> = {},
): ModelGatewayRoute {
  if (!request.routeIdentity) return resolveUnpinnedModelRoute(request, config);
  const requestedModelId =
    request.modelId?.trim() || config.defaultModelId || DEFAULT_AGENT_MODEL_ID;
  parsedModelGatewayRouteIdentity(request.routeIdentity, requestedModelId);
  let resolved: ModelGatewayRoute;
  try {
    resolved = resolveUnpinnedModelRoute(request, config);
  } catch {
    throw new ModelGatewayRouteError({
      message: "The pinned embedding route no longer matches the resolved request route.",
      modelId: requestedModelId,
    });
  }
  if (modelGatewayRouteIdentity(resolved) !== request.routeIdentity) {
    throw new ModelGatewayRouteError({
      message: "The pinned embedding route no longer matches the resolved request route.",
      modelId: requestedModelId,
    });
  }
  return resolved;
}

/**
 * The deployment's route defaults from `MODEL_GATEWAY_ENV_KEYS`: the primary and the comma-separated
 * fallbacks a request that names none resolves to. Unset or blank keys keep the code defaults.
 */
export function modelGatewayRouteDefaultsFromEnv(
  environment: Readonly<Record<string, string | undefined>>,
): Pick<ModelGatewayClientConfig, "defaultFallbackModelIds" | "defaultModelId"> {
  const [defaultModelId, fallbackValue] = [
    MODEL_GATEWAY_ENV_KEYS.defaultModelId,
    MODEL_GATEWAY_ENV_KEYS.defaultFallbackModelIds,
  ].map((names) => names.map((name) => environment[name]?.trim()).find(Boolean));
  const defaultFallbackModelIds = fallbackValue
    ?.split(",")
    .map((modelId) => modelId.trim())
    .filter(Boolean);
  return {
    ...(defaultModelId ? { defaultModelId } : {}),
    ...(defaultFallbackModelIds?.length ? { defaultFallbackModelIds } : {}),
  };
}

/** Headers of a gateway request: the caller's bearer token and Bifrost's extra-params opt-in. */
export function modelGatewayRequestHeaders(token: string): Readonly<Record<string, string>> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    // Bifrost requires this opt-in before merging a request's nested extra_params upstream.
    "x-bf-passthrough-extra-params": "true",
  };
}
