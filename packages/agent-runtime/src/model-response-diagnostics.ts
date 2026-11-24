import type {
  ChatCompletionEnvelopeShape,
  ModelGatewayChatCompletionResponseShape,
  ModelGatewayToolCall,
} from "@deployments-ai/model-gateway";

const NO_INITIATION_MARKER = "[NO_INITIATION]";
const MAX_DIAGNOSTIC_COUNT = 10_000_000;

const CHOICE_SHAPES = new Set(["missing", "record", "unsupported"]);
const CONTENT_SHAPES = new Set([
  "empty-parts",
  "empty-text",
  "mixed-parts",
  "missing",
  "nontext-parts",
  "null",
  "text",
  "text-parts",
  "unsupported",
]);
const MESSAGE_SHAPES = new Set(["missing", "record", "unsupported"]);
const RAW_RESPONSE_SHAPES = new Set([
  "invalid-json-string",
  "json-nonrecord-string",
  "json-record-string",
  "missing",
  "null",
  "record",
  "unsupported",
]);
const REASONING_CARRIERS = new Set(["analysis", "missing", "reasoning", "reasoning-content"]);
const TOOL_CALL_SHAPES = new Set(["empty", "missing", "present", "unsupported"]);

function safeDiagnosticCount(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_DIAGNOSTIC_COUNT
    ? value
    : undefined;
}

function safeEnum(value: unknown, values: ReadonlySet<string>): string | undefined {
  return typeof value === "string" && values.has(value) ? value : undefined;
}

function safeEnvelopeShape(value: unknown): ChatCompletionEnvelopeShape | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const shape = value as Readonly<Record<string, unknown>>;
  const choiceCount = safeDiagnosticCount(shape.choiceCount);
  const choiceShape = safeEnum(shape.choiceShape, CHOICE_SHAPES);
  const contentCharacters = safeDiagnosticCount(shape.contentCharacters);
  const contentPartCount = safeDiagnosticCount(shape.contentPartCount);
  const contentShape = safeEnum(shape.contentShape, CONTENT_SHAPES);
  const messageShape = safeEnum(shape.messageShape, MESSAGE_SHAPES);
  const reasoningCarrier = safeEnum(shape.reasoningCarrier, REASONING_CARRIERS);
  const reasoningCharacters = safeDiagnosticCount(shape.reasoningCharacters);
  const reasoningShape = safeEnum(shape.reasoningShape, CONTENT_SHAPES);
  const toolCallCount = safeDiagnosticCount(shape.toolCallCount);
  const toolCallsShape = safeEnum(shape.toolCallsShape, TOOL_CALL_SHAPES);
  if (
    choiceCount === undefined ||
    !choiceShape ||
    contentCharacters === undefined ||
    contentPartCount === undefined ||
    !contentShape ||
    !messageShape ||
    !reasoningCarrier ||
    reasoningCharacters === undefined ||
    !reasoningShape ||
    toolCallCount === undefined ||
    !toolCallsShape
  ) {
    return undefined;
  }

  return {
    choiceCount,
    choiceShape: choiceShape as ChatCompletionEnvelopeShape["choiceShape"],
    contentCharacters,
    contentPartCount,
    contentShape: contentShape as ChatCompletionEnvelopeShape["contentShape"],
    messageShape: messageShape as ChatCompletionEnvelopeShape["messageShape"],
    reasoningCarrier: reasoningCarrier as ChatCompletionEnvelopeShape["reasoningCarrier"],
    reasoningCharacters,
    reasoningShape: reasoningShape as ChatCompletionEnvelopeShape["reasoningShape"],
    toolCallCount,
    toolCallsShape: toolCallsShape as ChatCompletionEnvelopeShape["toolCallsShape"],
  };
}

function safeGatewayResponseShape(
  value: unknown,
): ModelGatewayChatCompletionResponseShape | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const shape = value as Readonly<Record<string, unknown>>;
  const normalized = safeEnvelopeShape(shape.normalized);
  const rawResponseShape = safeEnum(shape.rawResponseShape, RAW_RESPONSE_SHAPES);
  const hasRaw = Object.prototype.hasOwnProperty.call(shape, "raw");
  const raw = hasRaw ? safeEnvelopeShape(shape.raw) : undefined;
  if (!normalized || !rawResponseShape || (hasRaw && !raw)) return undefined;

  return {
    normalized,
    ...(raw ? { raw } : {}),
    rawResponseShape:
      rawResponseShape as ModelGatewayChatCompletionResponseShape["rawResponseShape"],
  };
}

function safeResponseDepthViolation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const violation = value as Readonly<Record<string, unknown>>;
  const wordCount = safeDiagnosticCount(violation.wordCount);
  const minimumWords = safeDiagnosticCount(violation.minimumWords);
  const maximumWords = safeDiagnosticCount(violation.maximumWords);
  if (
    wordCount === undefined ||
    minimumWords === undefined ||
    maximumWords === undefined ||
    minimumWords < 1 ||
    maximumWords > 8192 ||
    minimumWords > maximumWords ||
    (wordCount >= minimumWords && wordCount <= maximumWords)
  )
    return undefined;
  return { wordCount, minimumWords, maximumWords };
}

export function safeResponseInterpretation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const interpretation = value as Readonly<Record<string, unknown>>;
  const disposition =
    typeof interpretation.disposition === "string" &&
    /^[a-z][a-z-]*$/u.test(interpretation.disposition)
      ? interpretation.disposition
      : undefined;
  const assistantCharacters = safeDiagnosticCount(interpretation.assistantCharacters);
  const providerAssistantCharacters = safeDiagnosticCount(
    interpretation.providerAssistantCharacters,
  );
  const providerToolCallCount = safeDiagnosticCount(interpretation.providerToolCallCount);
  const hasGatewayResponseShape = Object.prototype.hasOwnProperty.call(
    interpretation,
    "gatewayResponseShape",
  );
  const gatewayResponseShape = hasGatewayResponseShape
    ? safeGatewayResponseShape(interpretation.gatewayResponseShape)
    : undefined;
  const hasResponseDepthViolation = Object.prototype.hasOwnProperty.call(
    interpretation,
    "responseDepthViolation",
  );
  const responseDepthViolation = hasResponseDepthViolation
    ? safeResponseDepthViolation(interpretation.responseDepthViolation)
    : undefined;
  if (
    !disposition ||
    assistantCharacters === undefined ||
    providerAssistantCharacters === undefined ||
    providerToolCallCount === undefined ||
    (hasGatewayResponseShape && !gatewayResponseShape) ||
    (hasResponseDepthViolation && !responseDepthViolation)
  ) {
    return undefined;
  }

  return {
    assistantCharacters,
    disposition,
    ...(gatewayResponseShape ? { gatewayResponseShape } : {}),
    ...(responseDepthViolation ? { responseDepthViolation } : {}),
    providerAssistantCharacters,
    providerToolCallCount,
  } as const;
}

export function gemma4ResponseDisposition(input: {
  readonly assistantMessage: string;
  readonly exhausted: boolean;
  readonly finalAssistantMessage: string;
  readonly hasProviderToolCalls: boolean;
  readonly outwardToolCallCount: number;
  readonly rejectedDisabledTextualToolCall: boolean;
  readonly rejectedHabitualLaughterEnding: boolean;
  readonly rejectedProviderToolCalls: boolean;
  readonly repeatedCompletedSideEffect: boolean;
  readonly safeCompletedSideEffectAcknowledgement: string;
  readonly startsWithTextualToolCall: boolean;
  readonly textualToolCall: ModelGatewayToolCall | undefined;
}) {
  if (input.rejectedProviderToolCalls) return "rejected-provider-tool-calls";
  if (input.rejectedDisabledTextualToolCall) return "rejected-disabled-textual-tool-call";
  if (input.outwardToolCallCount > 0) {
    return input.hasProviderToolCalls
      ? "accepted-provider-tool-calls"
      : "accepted-textual-tool-call";
  }
  if (input.rejectedHabitualLaughterEnding) return "rejected-habitual-laughter-ending";
  if (input.safeCompletedSideEffectAcknowledgement) {
    return input.repeatedCompletedSideEffect
      ? "repeated-side-effect-acknowledgement"
      : "post-side-effect-acknowledgement";
  }
  if (input.finalAssistantMessage === NO_INITIATION_MARKER) return "suppression-marker";
  if (input.finalAssistantMessage) return "visible-text";
  if (input.exhausted) return "output-exhausted";
  if (!input.assistantMessage.trim()) return "provider-empty";
  if (input.textualToolCall || input.startsWithTextualToolCall) {
    return "textual-tool-call-without-action";
  }
  const content = input.assistantMessage.trim();
  if (content.startsWith("<thought>")) {
    return content.includes("</thought>")
      ? "thought-envelope-without-visible-text"
      : "unclosed-thought-envelope";
  }
  if (content.startsWith("<|channel>thought\n")) {
    return content.includes("<channel|>")
      ? "thought-channel-without-visible-text"
      : "unclosed-thought-channel";
  }
  if (/^(?:<\|)?thought(?:\|>)?[ \t]*(?::[ \t]*)?(?:\r?\n|$)/iu.test(content)) {
    return "leading-thought-control";
  }
  return "sanitized-without-visible-text";
}
