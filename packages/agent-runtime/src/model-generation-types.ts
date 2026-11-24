import type { SpanId } from "@deployments-ai/observability";
import type {
  AgentRunIdentity,
  RuntimeObservabilityContext,
  RuntimeTenantScope,
  RuntimeUsageEntry,
} from "./types.ts";

/** Assistant text one model generation produced so far, identified by its model call. */
export interface RuntimeAssistantTextDelta {
  readonly modelCallId: string;
  readonly text: string;
}

/**
 * Live delivery of assistant text while a generation runs. Delivery is best-effort: the runtime
 * ignores its failures, and the finalized assistant message stays canonical.
 */
export interface RuntimeAssistantTextStream {
  readonly append: (delta: RuntimeAssistantTextDelta) => void;
  /** Delivers everything appended for `modelCallId`; awaited before the generation settles. */
  readonly flush: (modelCallId: string) => Promise<void>;
}

/** Model invocation kinds: the assistant generation or the response-depth classifier. */
export type RuntimeModelInvocationKind = "assistant" | "response-depth";

/**
 * Identifies the model generation attempt whose result requested a tool call. Model-requested
 * tools always carry both fields; tool-plan requests carry neither.
 */
export interface RuntimeRequestingModelGeneration {
  /** Attempt id of the model invocation attempt whose result requested the tool. */
  readonly modelAttemptId?: string;
  /** Per-run index of the model generation that requested the tool. */
  readonly modelCallIndex?: number;
}

export type RuntimeModelInvocationAttempt = RuntimeTenantScope &
  AgentRunIdentity &
  RuntimeObservabilityContext & {
    readonly actualModelId?: string;
    readonly actualProvider?: string;
    readonly attemptId: string;
    readonly cachedTokens?: number;
    readonly completedAt: string;
    readonly costUsdMicros?: number;
    readonly errorClass?: string;
    readonly fallbackAttempt: number;
    readonly fallbackReason?: string;
    readonly inputTokens?: number;
    readonly internalEvaluator: boolean;
    readonly invocationId: string;
    readonly invocationKind: RuntimeModelInvocationKind;
    /** Per-run model generation index shared by every attempt of one invocation. */
    readonly modelCallIndex: number;
    readonly outputTokens?: number;
    readonly parentSpanId: SpanId;
    readonly providerRequestId?: string;
    readonly requestedModelId: string;
    readonly requestedProvider?: string;
    readonly runAttempt: number;
    readonly runExecutionVersion: number;
    readonly spanId: SpanId;
    readonly startedAt: string;
    readonly status: "canceled" | "failed" | "succeeded";
    readonly stopReason?: string;
    /** Whether the generation's assistant text was streamed live to thread readers. */
    readonly streaming: boolean;
    readonly totalTokens?: number;
    readonly usageEntry?: RuntimeUsageEntry;
    readonly usageIdempotencyKey?: string;
  };
