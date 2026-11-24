import { modelProviderForId, normalizeModelId, providerModelIdForModelId } from "./routing.ts";
import {
  RESPONSE_INPUT_TOKEN_KEYS,
  RESPONSE_OUTPUT_TOKEN_KEYS,
  RESPONSE_TOTAL_TOKEN_KEYS,
  chatCompletionMessageContent,
  firstChatCompletionChoice,
  textContentPart,
} from "./response-types.ts";
import {
  MODEL_GATEWAY_PROVIDERS,
  type ModelGatewayProvider,
  type ModelGatewayRoute,
  type ModelGatewayToolCall,
  type NormalizeModelUsageRequest,
  type ReasoningDetail,
  isRecord,
  stringValue,
} from "./types.ts";

export function chatCompletionAssistantMessage(body: unknown): string | undefined {
  const choice = firstChatCompletionChoice(body);
  const message = isRecord(choice?.message) ? choice.message : undefined;
  return chatCompletionMessageContent(message?.content)?.trim();
}

type ChatCompletionChoiceShape = "missing" | "record" | "unsupported";
type ChatCompletionMessageShape = "missing" | "record" | "unsupported";
type ChatCompletionValueShape =
  | "empty-parts"
  | "empty-text"
  | "mixed-parts"
  | "missing"
  | "nontext-parts"
  | "null"
  | "text"
  | "text-parts"
  | "unsupported";
type ChatCompletionReasoningCarrier = "analysis" | "missing" | "reasoning" | "reasoning-content";
type ChatCompletionToolCallsShape = "empty" | "missing" | "present" | "unsupported";
type ChatCompletionRawResponseShape =
  | "invalid-json-string"
  | "json-nonrecord-string"
  | "json-record-string"
  | "missing"
  | "null"
  | "record"
  | "unsupported";

export interface ChatCompletionEnvelopeShape {
  readonly choiceCount: number;
  readonly choiceShape: ChatCompletionChoiceShape;
  readonly contentCharacters: number;
  readonly contentPartCount: number;
  readonly contentShape: ChatCompletionValueShape;
  readonly messageShape: ChatCompletionMessageShape;
  readonly reasoningCarrier: ChatCompletionReasoningCarrier;
  readonly reasoningCharacters: number;
  readonly reasoningShape: ChatCompletionValueShape;
  readonly toolCallCount: number;
  readonly toolCallsShape: ChatCompletionToolCallsShape;
}

export interface ModelGatewayChatCompletionResponseShape {
  readonly normalized: ChatCompletionEnvelopeShape;
  readonly raw?: ChatCompletionEnvelopeShape;
  readonly rawResponseShape: ChatCompletionRawResponseShape;
}

function diagnosticValueShape(value: unknown) {
  if (value === undefined) {
    return { characters: 0, partCount: 0, shape: "missing" as const };
  }
  if (value === null) return { characters: 0, partCount: 0, shape: "null" as const };
  if (typeof value === "string") {
    return {
      characters: value.length,
      partCount: 0,
      shape: value.trim() ? ("text" as const) : ("empty-text" as const),
    };
  }
  if (!Array.isArray(value)) {
    return { characters: 0, partCount: 0, shape: "unsupported" as const };
  }
  if (value.length === 0) {
    return { characters: 0, partCount: 0, shape: "empty-parts" as const };
  }

  const textParts = value.map(textContentPart);
  const text = textParts.filter((part): part is string => part !== undefined).join("");
  const textPartCount = textParts.filter((part) => part !== undefined).length;
  return {
    characters: text.length,
    partCount: value.length,
    shape: !text.trim()
      ? ("nontext-parts" as const)
      : textPartCount === value.length
        ? ("text-parts" as const)
        : ("mixed-parts" as const),
  };
}

function diagnosticReasoning(message: Record<string, unknown> | undefined) {
  const candidates = [
    ["reasoning-content", message?.reasoning_content],
    ["reasoning", message?.reasoning],
    ["analysis", message?.analysis],
  ] as const;
  const candidate = candidates.find(([, value]) => value !== undefined);
  if (!candidate) {
    return {
      carrier: "missing" as const,
      characters: 0,
      shape: "missing" as const,
    };
  }
  const value = diagnosticValueShape(candidate[1]);
  return { carrier: candidate[0], characters: value.characters, shape: value.shape };
}

function chatCompletionEnvelopeShape(body: unknown): ChatCompletionEnvelopeShape {
  const response = isRecord(body) ? body : undefined;
  const choices = Array.isArray(response?.choices) ? response.choices : undefined;
  const choice = choices?.find(isRecord);
  const rawMessage = choice?.message;
  const message = isRecord(rawMessage) ? rawMessage : undefined;
  const content = diagnosticValueShape(message?.content);
  const reasoning = diagnosticReasoning(message);
  const rawToolCalls = message?.tool_calls;
  const toolCallsShape =
    rawToolCalls === undefined
      ? "missing"
      : Array.isArray(rawToolCalls)
        ? rawToolCalls.length > 0
          ? "present"
          : "empty"
        : "unsupported";

  return {
    choiceCount: choices?.length ?? 0,
    choiceShape: choice ? "record" : choices && choices.length > 0 ? "unsupported" : "missing",
    contentCharacters: content.characters,
    contentPartCount: content.partCount,
    contentShape: content.shape,
    messageShape: rawMessage === undefined ? "missing" : message ? "record" : "unsupported",
    reasoningCarrier: reasoning.carrier,
    reasoningCharacters: reasoning.characters,
    reasoningShape: reasoning.shape,
    toolCallCount: Array.isArray(rawToolCalls) ? rawToolCalls.length : 0,
    toolCallsShape,
  };
}

export function chatCompletionResponseShape(
  body: unknown,
): ModelGatewayChatCompletionResponseShape {
  const response = isRecord(body) ? body : undefined;
  const extraFields = isRecord(response?.extra_fields) ? response.extra_fields : undefined;
  const rawResponse = extraFields?.raw_response;
  let raw: ChatCompletionEnvelopeShape | undefined;
  let rawResponseShape: ChatCompletionRawResponseShape = "missing";

  if (rawResponse === null) {
    rawResponseShape = "null";
  } else if (isRecord(rawResponse)) {
    raw = chatCompletionEnvelopeShape(rawResponse);
    rawResponseShape = "record";
  } else if (typeof rawResponse === "string") {
    try {
      const decoded: unknown = JSON.parse(rawResponse);
      if (isRecord(decoded)) {
        raw = chatCompletionEnvelopeShape(decoded);
        rawResponseShape = "json-record-string";
      } else {
        rawResponseShape = "json-nonrecord-string";
      }
    } catch {
      rawResponseShape = "invalid-json-string";
    }
  } else if (rawResponse !== undefined) {
    rawResponseShape = "unsupported";
  }

  return {
    normalized: chatCompletionEnvelopeShape(body),
    ...(raw ? { raw } : {}),
    rawResponseShape,
  };
}

export function chatCompletionFinishReason(body: unknown): string | undefined {
  const choice = firstChatCompletionChoice(body);
  return stringValue(choice?.finish_reason ?? choice?.finishReason);
}

export function chatCompletionToolCalls(
  body: unknown,
): readonly ModelGatewayToolCall[] | undefined {
  const choice = firstChatCompletionChoice(body);
  const message = isRecord(choice?.message) ? choice.message : undefined;
  if (message?.tool_calls === undefined) return undefined;
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    throw new Error("Model gateway tool_calls must be a non-empty array.");
  }

  return message.tool_calls.map((value, index) => {
    if (!isRecord(value) || (value.type !== undefined && value.type !== "function")) {
      throw new Error(`Model gateway tool call ${index} is not a function call.`);
    }
    const callable = isRecord(value.function) ? value.function : undefined;
    const id = stringValue(value.id);
    const name = stringValue(callable?.name);
    const rawArguments = callable?.arguments;
    if (!id || !name) {
      throw new Error(`Model gateway tool call ${index} is missing its id or function name.`);
    }
    const invalidText = (text: string, maximumBytes: number) =>
      new TextEncoder().encode(text).byteLength > maximumBytes ||
      Array.from(text).some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || code === 127;
      });
    if (invalidText(id, 1_024) || invalidText(name, 256)) {
      throw new Error(`Model gateway tool call ${index} has invalid correlation text.`);
    }
    let args: unknown;
    try {
      args = typeof rawArguments === "string" ? JSON.parse(rawArguments) : rawArguments;
    } catch {
      throw new Error(`Model gateway tool call ${index} has malformed JSON arguments.`);
    }
    if (!isRecord(args)) {
      throw new Error(`Model gateway tool call ${index} arguments must be a JSON object.`);
    }
    return { arguments: args, id, name };
  });
}

function isReasoningDetail(value: unknown): value is ReasoningDetail {
  return isRecord(value) && typeof value.type === "string" && value.type.startsWith("reasoning.");
}

export function chatCompletionReasoningDetails(
  body: unknown,
): readonly ReasoningDetail[] | undefined {
  const message = firstChatCompletionChoice(body)?.message;
  const details = isRecord(message) ? message.reasoning_details : undefined;
  return Array.isArray(details) && details.length > 0 && details.every(isReasoningDetail)
    ? details
    : undefined;
}

function chatCompletionExtraFields(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  return isRecord(body.extra_fields) ? body.extra_fields : undefined;
}

function recordPathString(
  record: Record<string, unknown> | undefined,
  path: readonly string[],
): string | undefined {
  let current: unknown = record;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }

  return stringValue(current);
}

export function chatCompletionServedProvider(body: unknown): string | undefined {
  const extraFields = chatCompletionExtraFields(body);
  return (
    recordPathString(extraFields, ["routing_info", "resolved_model", "provider"]) ??
    recordPathString(extraFields, ["routing_info", "resolved_model", "provider_name"]) ??
    recordPathString(extraFields, ["resolved_model", "provider"]) ??
    recordPathString(extraFields, ["resolved_model", "provider_name"]) ??
    stringValue(extraFields?.provider) ??
    recordPathString(extraFields, ["routing_info", "provider"]) ??
    recordPathString(extraFields, ["routing_info", "provider_name"]) ??
    recordPathString(extraFields, ["routing_info", "provider_used"]) ??
    recordPathString(extraFields, ["routing_info", "model", "provider"]) ??
    recordPathString(extraFields, ["resolved_provider"]) ??
    recordPathString(extraFields, ["provider_used"]) ??
    recordPathString(extraFields, ["served_provider"])
  );
}

export function chatCompletionPlatformServedProvider(body: unknown): string | undefined {
  return chatCompletionServedProvider(body);
}

export function chatCompletionServedKeyName(body: unknown): string | undefined {
  return recordPathString(chatCompletionExtraFields(body), ["routing_info", "key"]);
}

function chatCompletionBifrostResolvedModelId(body: unknown): string | undefined {
  const extraFields = chatCompletionExtraFields(body);
  return (
    recordPathString(extraFields, ["routing_info", "resolved_model", "model"]) ??
    recordPathString(extraFields, ["routing_info", "resolved_model", "model_id"]) ??
    recordPathString(extraFields, ["routing_info", "resolved_model", "provider_model"]) ??
    recordPathString(extraFields, ["routing_info", "resolved_model", "provider_model_id"]) ??
    recordPathString(extraFields, ["routing_info", "resolved_model", "id"]) ??
    recordPathString(extraFields, ["routing_info", "resolved_model", "name"]) ??
    recordPathString(extraFields, ["routing_info", "resolved_model"]) ??
    recordPathString(extraFields, ["resolved_model", "model"]) ??
    recordPathString(extraFields, ["resolved_model", "model_id"]) ??
    recordPathString(extraFields, ["resolved_model", "provider_model"]) ??
    recordPathString(extraFields, ["resolved_model", "provider_model_id"]) ??
    recordPathString(extraFields, ["resolved_model", "id"]) ??
    recordPathString(extraFields, ["resolved_model", "name"]) ??
    recordPathString(extraFields, ["resolved_model_used"]) ??
    recordPathString(extraFields, ["resolved_model"]) ??
    recordPathString(extraFields, ["routing_info", "model"]) ??
    recordPathString(extraFields, ["routing_info", "model_id"]) ??
    recordPathString(extraFields, ["routing_info", "model_used"]) ??
    recordPathString(extraFields, ["routing_info", "model", "id"]) ??
    recordPathString(extraFields, ["routing_info", "model", "name"]) ??
    recordPathString(extraFields, ["model_used"]) ??
    recordPathString(extraFields, ["provider_model"]) ??
    recordPathString(extraFields, ["provider_model_id"])
  );
}

function chatCompletionTopLevelModelId(body: unknown): string | undefined {
  return isRecord(body) ? stringValue(body.model) : undefined;
}

function modelGatewayProvider(value: string | undefined): ModelGatewayProvider | undefined {
  return MODEL_GATEWAY_PROVIDERS.find((provider) => provider === value);
}

function candidateModelIdsForProvider(
  route: ModelGatewayRoute,
  provider: ModelGatewayProvider | undefined,
) {
  const candidates = [route.modelId, ...route.fallbackModelIds].filter(
    (modelId) => !provider || modelProviderForId(modelId) === provider,
  );
  return [...new Set(candidates)];
}

function uniquelyIdentifiedRouteModelId(
  route: ModelGatewayRoute,
  provider: ModelGatewayProvider | undefined,
) {
  const candidates = candidateModelIdsForProvider(route, provider);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function routeModelIdForProviderModelId(route: ModelGatewayRoute, providerModelId: string) {
  const normalizedProviderModelId = providerModelId.toLowerCase();
  const candidates = [route.modelId, ...route.fallbackModelIds].filter(
    (modelId) => providerModelIdForModelId(modelId).toLowerCase() === normalizedProviderModelId,
  );
  const uniqueCandidates = [...new Set(candidates)];
  return uniqueCandidates.length === 1 ? uniqueCandidates[0] : undefined;
}

function providerQualifiedModelId(
  modelId: string,
  provider: ModelGatewayProvider | undefined,
  route: ModelGatewayRoute,
) {
  if ([route.modelId, ...route.fallbackModelIds].includes(modelId)) {
    if (!provider || modelProviderForId(modelId) === provider) return modelId;
  }
  if (!provider) {
    return modelId;
  }
  if (modelProviderForId(modelId) === provider && modelId.startsWith(`${provider}/`)) {
    return modelId;
  }

  return `${provider}/${modelId}`;
}

export function chatCompletionServedModelId(
  body: unknown,
  route: ModelGatewayRoute,
): string | undefined {
  const bifrostResolvedModelId = chatCompletionBifrostResolvedModelId(body);
  const topLevelModelId = chatCompletionTopLevelModelId(body);
  const rawServedProvider = chatCompletionPlatformServedProvider(body);
  const servedProvider = modelGatewayProvider(rawServedProvider);

  if (bifrostResolvedModelId) {
    return providerQualifiedModelId(bifrostResolvedModelId, servedProvider, route);
  }

  if (rawServedProvider) {
    if (!servedProvider) return undefined;
    if (topLevelModelId) {
      return providerQualifiedModelId(topLevelModelId, servedProvider, route);
    }
    return uniquelyIdentifiedRouteModelId(route, servedProvider);
  }

  if (topLevelModelId) {
    const routedModelId = routeModelIdForProviderModelId(route, topLevelModelId);
    if (routedModelId) return routedModelId;
    try {
      return normalizeModelId(topLevelModelId);
    } catch {
      return undefined;
    }
  }

  return uniquelyIdentifiedRouteModelId(route, undefined);
}

export function positiveInteger(value: unknown): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return undefined;
  }
  return value;
}

export interface IntegerRead {
  readonly invalid: boolean;
  readonly value?: number;
}

export function integerFromValues(values: readonly unknown[]): IntegerRead {
  let firstValue: number | undefined;

  for (const value of values) {
    if (value === undefined) continue;
    const parsed = positiveInteger(value);
    if (parsed === undefined) return { invalid: true };
    firstValue ??= parsed;
  }

  return firstValue === undefined ? { invalid: false } : { invalid: false, value: firstValue };
}

function recordValues(record: Record<string, unknown>, keys: readonly string[]) {
  const values: unknown[] = [];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) values.push(record[key]);
  }

  return values;
}

export function integerRecordValue(record: Record<string, unknown>, keys: readonly string[]) {
  return integerFromValues(recordValues(record, keys));
}

function splitTokenTotal(input: IntegerRead, output: IntegerRead): number | undefined {
  if (input.invalid || output.invalid) return undefined;

  const total = (input.value ?? 0) + (output.value ?? 0);
  return total > 0 && Number.isSafeInteger(total) ? total : undefined;
}

export function usageTotalTokenValue(
  usage: NormalizeModelUsageRequest["usage"],
): number | undefined {
  if (!usage) return undefined;
  return integerFromValues([usage.totalTokens]).value;
}

export function usageSplitTokenTotal(
  usage: NormalizeModelUsageRequest["usage"],
): number | undefined {
  if (!usage) return undefined;
  return splitTokenTotal(
    integerFromValues([usage.inputTokens, usage.promptTokens]),
    integerFromValues([usage.outputTokens, usage.completionTokens]),
  );
}

function usdCostMicros(value: unknown): number | undefined {
  const normalized = typeof value === "string" ? value.trim().replace(/^\$/, "") : value;
  const parsed =
    typeof normalized === "string" ? (normalized ? Number(normalized) : undefined) : normalized;

  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) return undefined;
  const micros = Math.round(parsed * 1_000_000);
  return Number.isSafeInteger(micros) ? micros : undefined;
}

export function responseCostUsdMicros(response: unknown): number | undefined {
  if (!isRecord(response)) return undefined;
  const body = isRecord(response.body) ? response.body : response;
  const usage = isRecord(body.usage) ? body.usage : undefined;
  const usageCost = isRecord(usage?.cost) ? usage.cost : undefined;
  const candidates = [
    positiveInteger(body.cost_usd_micros),
    positiveInteger(usage?.cost_usd_micros),
    usdCostMicros(body.response_cost),
    usdCostMicros(body.cost),
    usdCostMicros(body.cost_usd),
    usdCostMicros(usageCost?.total_cost),
    usdCostMicros(usageCost?.totalCost),
    usdCostMicros(usageCost?.request_cost),
    usdCostMicros(usageCost?.requestCost),
    usdCostMicros(usageCost?.cost),
    usdCostMicros(usageCost?.usd),
    usdCostMicros(usage?.cost),
    usdCostMicros(usage?.cost_usd),
    usdCostMicros(usage?.total_cost),
    usdCostMicros(usage?.total_cost_usd),
  ];

  return candidates.find((value): value is number => value !== undefined);
}

export function responseUsageRecord(response: unknown): Record<string, unknown> | undefined {
  if (!isRecord(response)) return undefined;
  const body = isRecord(response.body) ? response.body : response;
  return isRecord(body.usage) ? body.usage : undefined;
}

export function responseTotalTokens(response: unknown): number | undefined {
  const usage = responseUsageRecord(response);
  if (!usage) return undefined;

  const total = integerRecordValue(usage, RESPONSE_TOTAL_TOKEN_KEYS);
  if (total.invalid || total.value !== undefined) return total.value;

  return splitTokenTotal(
    integerRecordValue(usage, RESPONSE_INPUT_TOKEN_KEYS),
    integerRecordValue(usage, RESPONSE_OUTPUT_TOKEN_KEYS),
  );
}

export function usageTokensFromResponse(body: unknown): number | undefined {
  const usage = responseUsageRecord(body);
  if (!usage) return undefined;

  const totalTokens = integerRecordValue(usage, RESPONSE_TOTAL_TOKEN_KEYS);
  return totalTokens.invalid ? undefined : totalTokens.value;
}
