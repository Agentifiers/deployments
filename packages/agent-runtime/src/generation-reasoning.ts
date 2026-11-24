import {
  GenerationReasoningDetails,
  MAX_GENERATION_REASONING_BYTES,
  NonEmptyString,
  NonNegativeSafeInteger,
} from "@deployments-ai/db";
import {
  normalizeModelId,
  reasoningReplaySupported,
  type ReasoningDetail,
} from "@deployments-ai/model-gateway";
import { Option, Schema } from "effect";
import { wireModelToolCallId } from "./model-tool-context.ts";
import type { RuntimeModelToolCall } from "./types.ts";

declare const replayForm: unique symbol;

export type ReplayReasoningDetails = GenerationReasoningDetails & { readonly [replayForm]: true };

export interface RuntimeGenerationReasoning {
  readonly details: ReplayReasoningDetails;
  readonly modelCallIndex: number;
  readonly producerAttemptId: string;
  readonly producerModelId: string;
}

export type GenerationReasoningCapture =
  | {
      readonly bytes: number;
      readonly kind: "captured";
      readonly reasoning: RuntimeGenerationReasoning;
    }
  | {
      readonly kind: "skipped";
      readonly reason:
        | "absent"
        | "gemma4"
        | "invalid"
        | "no-tool-calls"
        | "oversize"
        | "unformatted"
        | "unsupported-route";
    };

const decodeGenerationReasoningDetails = Schema.decodeUnknownOption(GenerationReasoningDetails);

const ContinuedGenerationReasoning = Schema.Array(
  Schema.Struct({
    details: GenerationReasoningDetails,
    modelCallIndex: NonNegativeSafeInteger,
    producerAttemptId: NonEmptyString,
    producerModelId: NonEmptyString,
  }),
);

export function captureGenerationReasoning(input: {
  readonly details: readonly ReasoningDetail[] | undefined;
  readonly modelCallIndex: number;
  readonly modelToolProtocol: "gemma4" | undefined;
  readonly producerAttemptId: string;
  readonly producerModelId: string;
  readonly toolCalls: readonly RuntimeModelToolCall[];
}): GenerationReasoningCapture {
  if (input.modelToolProtocol === "gemma4") return { kind: "skipped", reason: "gemma4" };
  if (input.toolCalls.length === 0) return { kind: "skipped", reason: "no-tool-calls" };
  if (!input.details) return { kind: "skipped", reason: "absent" };
  if (!reasoningReplaySupported(input.producerModelId)) {
    return { kind: "skipped", reason: "unsupported-route" };
  }
  // OpenRouter translates each block by its `format`; a stream that lost it cannot replay safely.
  if (!input.details.every((detail) => typeof detail.format === "string")) {
    return { kind: "skipped", reason: "unformatted" };
  }
  // Gemini binds its signature to the provider tool-call id, which the platform rewrites on replay.
  const remapped = input.details.map((detail) => {
    const toolCallIndex = input.toolCalls.findIndex((call) => call.modelToolCallId === detail.id);
    return toolCallIndex < 0
      ? detail
      : {
          ...detail,
          id: wireModelToolCallId({ modelCallIndex: input.modelCallIndex, toolCallIndex }),
        };
  });
  const bytes = new TextEncoder().encode(JSON.stringify(remapped)).byteLength;
  const details = decodeGenerationReasoningDetails(remapped);
  if (Option.isNone(details)) {
    return {
      kind: "skipped",
      reason: bytes > MAX_GENERATION_REASONING_BYTES ? "oversize" : "invalid",
    };
  }
  return {
    bytes,
    kind: "captured",
    reasoning: {
      details: details.value as ReplayReasoningDetails,
      modelCallIndex: input.modelCallIndex,
      producerAttemptId: input.producerAttemptId,
      producerModelId: input.producerModelId,
    },
  };
}

export function replayReasoningForAttempt(input: {
  readonly attempt: number;
  readonly history: readonly RuntimeGenerationReasoning[];
  readonly modelId: string;
  readonly modelToolProtocol: "gemma4" | undefined;
}): ReadonlyMap<number, ReplayReasoningDetails> {
  const modelId = normalizeModelId(input.modelId);
  if (
    input.attempt > 0 ||
    input.modelToolProtocol === "gemma4" ||
    !reasoningReplaySupported(modelId)
  ) {
    return new Map();
  }
  return new Map(
    input.history
      .filter((entry) => entry.producerModelId === modelId)
      .map((entry) => [entry.modelCallIndex, entry.details] as const),
  );
}

export function validateGenerationReasoning(
  value: unknown,
  modelCallCount: number,
): readonly RuntimeGenerationReasoning[] {
  const entries = Schema.decodeUnknownSync(ContinuedGenerationReasoning)(value);
  return entries.map((entry, index) => {
    const previous = entries[index - 1];
    if (
      entry.modelCallIndex >= modelCallCount ||
      (previous !== undefined && entry.modelCallIndex <= previous.modelCallIndex)
    ) {
      throw new Error(
        "Runtime model continuation reasoning must name distinct completed generations in ascending order.",
      );
    }
    return { ...entry, details: entry.details as ReplayReasoningDetails };
  });
}
