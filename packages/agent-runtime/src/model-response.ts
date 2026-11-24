import type {
  ModelGatewayChatCompletionResult,
  ModelGatewayToolCall,
  OpenAiCompatibleChatCompletionMessage,
} from "@deployments-ai/model-gateway";
import { isDeepStrictEqual } from "node:util";
import {
  gemma4AssistantText,
  gemma4OutputExhausted,
  gemma4TextualToolCall,
  type Gemma4ModelTool,
} from "./gemma4-output.ts";
import { withoutPlatformTimingLabels } from "./conversation-temporal-context.ts";
import { gemma4ResponseDisposition } from "./model-response-diagnostics.ts";
import { hasHabitualLaughterEnding } from "./response-style.ts";
import { responseDepthViolation } from "./response-depth.ts";
import { modelToolInputValidator } from "./sandbox-continuation.ts";
import type { RuntimeModelGenerationRequest, RuntimeModelGenerationResult } from "./types.ts";

export function runtimeModelResponse(input: {
  readonly contextPacking: unknown;
  readonly gemma4: boolean;
  readonly modelMessages: readonly OpenAiCompatibleChatCompletionMessage[];
  readonly modelTools: readonly Gemma4ModelTool[];
  readonly modelToolsEnabled: boolean;
  readonly request: RuntimeModelGenerationRequest;
  readonly result: ModelGatewayChatCompletionResult;
}): RuntimeModelGenerationResult {
  const { gemma4, modelTools, modelToolsEnabled, request, result } = input;
  const assistantMessage = result.assistantMessage ?? "";
  const modelToolByName = new Map(modelTools.map((tool) => [tool.name, tool.tool] as const));
  const exhaustedGemma4Output = gemma4 && gemma4OutputExhausted(result.finishReason);
  const validModelToolCall = (call: ModelGatewayToolCall) => {
    const tool = modelToolByName.get(call.name);
    return tool !== undefined && modelToolInputValidator(tool)(call.arguments);
  };
  const hasProviderToolCalls = (result.toolCalls?.length ?? 0) > 0;
  const rejectedProviderToolCalls =
    (!modelToolsEnabled && hasProviderToolCalls) ||
    (gemma4 &&
      hasProviderToolCalls &&
      (exhaustedGemma4Output ||
        result.toolCalls?.some((call) => !validModelToolCall(call)) === true));
  const acceptedToolCalls =
    modelToolsEnabled && hasProviderToolCalls && !rejectedProviderToolCalls
      ? result.toolCalls
      : undefined;
  const parsedTextualToolCall =
    gemma4 && !hasProviderToolCalls
      ? gemma4TextualToolCall(assistantMessage, modelTools, {
          requireAuthoritativeBoundary: exhaustedGemma4Output,
        })
      : undefined;
  const textualToolCall =
    modelToolsEnabled && parsedTextualToolCall && validModelToolCall(parsedTextualToolCall)
      ? parsedTextualToolCall
      : undefined;
  const rejectedDisabledTextualToolCall = !modelToolsEnabled && parsedTextualToolCall !== undefined;
  const modelToolSlots = new Map(
    request.modelToolCallSlots.map((slot) => [slot.idempotencyKey, slot] as const),
  );
  const latestCompletedModelTool = request.completedToolCalls.findLast((tool) =>
    modelToolSlots.has(tool.idempotencyKey),
  );
  const latestModelCallIndex = latestCompletedModelTool
    ? modelToolSlots.get(latestCompletedModelTool.idempotencyKey)!.modelCallIndex
    : undefined;
  const latestCompletedModelTools = request.completedToolCalls.filter(
    (tool) => modelToolSlots.get(tool.idempotencyKey)?.modelCallIndex === latestModelCallIndex,
  );
  const mappedToolCalls = (acceptedToolCalls ?? (textualToolCall ? [textualToolCall] : [])).map(
    (call) => {
      const tool = modelToolByName.get(call.name);
      if (!tool) {
        throw new Error(`Model requested unavailable runtime tool ${call.name}.`);
      }
      return {
        input: call.arguments,
        modelToolCallId: call.id,
        toolName: tool.toolName,
      };
    },
  );
  const repeatsLatestCompletedSideEffect = (call: (typeof mappedToolCalls)[number]) =>
    gemma4 &&
    latestCompletedModelTools.some(
      (tool) =>
        tool.effect !== "read" &&
        call.toolName === tool.toolName &&
        isDeepStrictEqual(call.input, tool.input),
    );
  const repeatedCompletedSideEffect = mappedToolCalls.some(repeatsLatestCompletedSideEffect);
  const outwardToolCalls = mappedToolCalls.filter(
    (call) => !repeatsLatestCompletedSideEffect(call),
  );
  const previousAssistantMessages = gemma4
    ? input.modelMessages.flatMap((message) =>
        message.role === "assistant" && typeof message.content === "string"
          ? [message.content]
          : [],
      )
    : undefined;
  const gemma4Text = gemma4
    ? gemma4AssistantText(
        assistantMessage,
        result.finishReason,
        latestCompletedModelTool !== undefined,
      )
    : undefined;
  const startsWithTextualToolCall = /^(?:<\|tool_call>)?_?call:/u.test(assistantMessage.trim());
  const safeCompletedSideEffectAcknowledgement =
    latestCompletedModelTool &&
    latestCompletedModelTool.effect !== "read" &&
    !rejectedProviderToolCalls &&
    !rejectedDisabledTextualToolCall &&
    outwardToolCalls.length === 0 &&
    (repeatedCompletedSideEffect || !startsWithTextualToolCall)
      ? "got it"
      : "";
  const normalizedAssistantMessage =
    request.responseFormat && !rejectedProviderToolCalls && !rejectedDisabledTextualToolCall
      ? assistantMessage
      : withoutPlatformTimingLabels(
          rejectedProviderToolCalls || rejectedDisabledTextualToolCall
            ? ""
            : textualToolCall && !repeatedCompletedSideEffect
              ? ""
              : gemma4
                ? gemma4Text || safeCompletedSideEffectAcknowledgement
                : assistantMessage,
        );
  const rejectedHabitualLaughterEnding =
    !request.responseFormat &&
    previousAssistantMessages !== undefined &&
    outwardToolCalls.length === 0 &&
    hasHabitualLaughterEnding(normalizedAssistantMessage, previousAssistantMessages);
  const styleFilteredAssistantMessage = rejectedHabitualLaughterEnding
    ? ""
    : normalizedAssistantMessage;
  const responseDisposition = gemma4
    ? gemma4ResponseDisposition({
        assistantMessage,
        exhausted: exhaustedGemma4Output,
        finalAssistantMessage: styleFilteredAssistantMessage,
        hasProviderToolCalls,
        outwardToolCallCount: outwardToolCalls.length,
        rejectedDisabledTextualToolCall,
        rejectedHabitualLaughterEnding,
        rejectedProviderToolCalls,
        repeatedCompletedSideEffect,
        safeCompletedSideEffectAcknowledgement,
        startsWithTextualToolCall,
        textualToolCall,
      })
    : "provider-text";
  const depthViolation =
    !request.responseFormat &&
    styleFilteredAssistantMessage &&
    outwardToolCalls.length === 0 &&
    responseDisposition !== "post-side-effect-acknowledgement" &&
    responseDisposition !== "repeated-side-effect-acknowledgement"
      ? responseDepthViolation(request, styleFilteredAssistantMessage)
      : undefined;
  const finalAssistantMessage = depthViolation ? "" : styleFilteredAssistantMessage;
  const responseError = depthViolation
    ? "Response rejected because it is outside the configured response-depth word bounds."
    : rejectedHabitualLaughterEnding
      ? "Response rejected because of a habitual laughter ending."
      : result.responseError;
  return {
    assistantMessage: finalAssistantMessage,
    ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
    metadata: {
      contextPacking: input.contextPacking,
      finishReason: result.finishReason,
      modelCallId: result.modelCallId,
      providerRequestId: result.providerRequestId,
      responseInterpretation: {
        assistantCharacters: finalAssistantMessage.length,
        disposition: depthViolation ? "rejected-response-depth" : responseDisposition,
        ...(depthViolation ? { responseDepthViolation: depthViolation } : {}),
        ...(result.responseShape ? { gatewayResponseShape: result.responseShape } : {}),
        providerAssistantCharacters: assistantMessage.length,
        providerToolCallCount: result.toolCalls?.length ?? 0,
      },
      resolvedModelId: result.modelId,
      servedProvider: result.servedProvider,
    },
    ...(result.modelId ? { resolvedModelId: result.modelId } : {}),
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.reasoningDetails ? { reasoningDetails: result.reasoningDetails } : {}),
    ...(responseError ? { responseError } : {}),
    ...(outwardToolCalls.length > 0 ? { toolCalls: outwardToolCalls } : {}),
    ...(result.totalTokens !== undefined ? { totalTokens: result.totalTokens } : {}),
    ...(result.usage ? { usage: [result.usage] } : {}),
  };
}
