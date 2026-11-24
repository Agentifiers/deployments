import type {
  AgentModelOptions,
  AgentResponseDepthPolicy,
  AgentResponseFormat,
} from "@deployments-ai/agent-manifest";
import type { ArtifactOwner, Ulid } from "@deployments-ai/db";
import type {
  ModelCatalogRuntimeEntries,
  ModelUsagePayer,
  ReasoningDetail,
} from "@deployments-ai/model-gateway";
import type { CaptureMode, SpanId, TraceId } from "@deployments-ai/observability";
import type { AgentPlanUpdate } from "@deployments-ai/streaming";
import type {
  RuntimeAssistantTextDelta,
  RuntimeAssistantTextStream,
  RuntimeModelInvocationAttempt,
  RuntimeRequestingModelGeneration,
} from "./model-generation-types.ts";
import type { ReplayReasoningDetails, RuntimeGenerationReasoning } from "./generation-reasoning.ts";
import type {
  RuntimeAttachmentIndexEntry,
  RuntimeInputArtifact,
  RuntimeInputOmission,
} from "./model-attachments.ts";
import type {
  SandboxLease,
  SandboxProvider,
  SandboxProviderName,
} from "@deployments-ai/sandbox-hosts";

export interface RuntimeTenantScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly workspaceId?: Ulid;
}

/**
 * Customer runs execute a production deployment and its release. Preview and evaluation runs
 * execute an execution binding; they carry a release and definition only when the binding was
 * created from a published release.
 */
export type AgentRunExecutionPins =
  | {
      readonly agentDefinitionId: Ulid;
      readonly agentDeploymentId: Ulid;
      readonly agentReleaseId: Ulid;
      readonly executionBindingId?: undefined;
      readonly executionPurpose?: "customer";
    }
  | {
      readonly agentDefinitionId?: Ulid;
      readonly agentDeploymentId?: undefined;
      readonly agentReleaseId?: Ulid;
      readonly executionBindingId: Ulid;
      readonly executionPurpose: "evaluation" | "preview";
    };

export type AgentRunIdentity = AgentRunExecutionPins & {
  readonly runId: Ulid;
  readonly threadId: Ulid;
};

export interface RuntimeObservabilityContext {
  readonly agentManifestHash: string;
  readonly captureMode: CaptureMode;
  readonly parentSpanId?: SpanId;
  readonly spanId: SpanId;
  readonly traceId: TraceId;
}

/**
 * Agent runs execute tools under their immutable trace context; deterministic workflow tool steps
 * have no run trace. The context is supplied whole or not at all.
 */
export type RuntimeToolTraceContext =
  | RuntimeObservabilityContext
  | { readonly [Field in keyof RuntimeObservabilityContext]?: undefined };

export type RuntimeMemoryMode = "agent" | "off" | "organization" | "thread" | "workspace";

export type RuntimeBrainRetrievalMode =
  | "brain-first"
  | "explicit"
  | "hybrid"
  | "memory-first"
  | "off";

export interface RuntimeMemoryContextItem {
  readonly content: string;
  readonly createdAt?: string;
  readonly memoryId: Ulid;
  readonly memoryType?: "episode" | "fact" | "preference" | "procedure" | "summary";
  readonly rank?: number;
  readonly score?: number;
  readonly sensitivity: "confidential" | "internal" | "public" | "restricted";
  readonly validFrom?: string;
  readonly validUntil?: string;
}

export interface RuntimeBrainEvidenceContextItem {
  readonly brainId: string;
  readonly chunkId: string;
  readonly coordinates: {
    readonly end: number;
    readonly kind: string;
    readonly start: number;
  };
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly excerpt: string;
  readonly renditionId: string;
  readonly score: number;
  readonly sensitivity: "confidential" | "internal" | "public" | "restricted";
  readonly sourceId: string;
  readonly title?: string;
}

export interface RuntimeConversationMessage {
  readonly content: string;
  readonly createdAt?: string;
  readonly messageId?: Ulid;
  /** Attachment identity is retained for provenance, never automatically reloaded from history. */
  readonly inputArtifacts?: readonly string[];
  readonly threadId?: Ulid;
  readonly role: "assistant" | "system" | "tool" | "user";
  readonly sequence?: number;
}

export interface RuntimeConversationTimingAnchor {
  readonly createdAt: string;
  readonly role: "assistant" | "user";
}

export interface RuntimeConversationCheckpoint {
  readonly fromMessageCreatedAt?: string;
  readonly fromSequence: number;
  readonly sourceMessageCount: number;
  readonly summary: string;
  readonly throughMessageCreatedAt?: string;
  readonly throughMessageCharacterOffset?: number;
  readonly throughSequence: number;
}

export interface RuntimeHistorySelection {
  readonly availableMessages: number;
  readonly characterBudget: number;
  readonly selectedMessages: number;
}

export interface RuntimeRetriedToolCall {
  readonly failures: number;
  readonly idempotencyKey: string;
}

export interface RuntimeToolRequest extends RuntimeRequestingModelGeneration {
  readonly effect: "execute" | "read" | "write";
  readonly idempotencyKey: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly inputSummary: string;
  readonly requiredScopes?: readonly string[];
  readonly toolName: string;
}

export interface RuntimeToolDefinition {
  readonly description?: string;
  readonly effect: RuntimeToolRequest["effect"];
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  readonly requiredScopes: readonly string[];
  readonly toolName: string;
}

export interface RuntimeToolExecutionBinding {
  /** Digest of provider, connection version, and authoritative resource bindings. */
  readonly authorizationFingerprint: string;
  readonly connectionId: Ulid;
  readonly externalAccountId: string;
  /**
   * Digest of the destinations a person approved for a data boundary, when an egress approval
   * gated the call; execution requires the destinations still needing approval to match it.
   */
  readonly destinationsHash?: string;
  /** Stable digest of the exact input authorized for execution, when applicable. */
  readonly inputHash?: string;
  /** Durable control-plane adapter used to authorize and execute this call. */
  readonly toolAdapterId?: Ulid;
  /** Digest of the code-owned executor kind, effect, scopes, and routing metadata. */
  readonly toolPlanFingerprint?: string;
}

interface RuntimeToolDecisionBase {
  readonly reason: string;
  readonly toolCallId: Ulid;
}

export interface RuntimeToolDeniedDecision extends RuntimeToolDecisionBase {
  readonly action: "deny";
  readonly approvalId?: never;
  readonly executionBinding?: never;
}

export interface RuntimeToolAllowedDecision extends RuntimeToolDecisionBase {
  readonly action: "allow";
  readonly approvalId?: never;
  readonly executionBinding?: RuntimeToolExecutionBinding;
}

export interface RuntimeToolApprovalDecision extends RuntimeToolDecisionBase {
  readonly action: "require-approval";
  readonly approvalId: Ulid;
  /**
   * Present only when the organization's data boundary asks for this approval: every destination
   * the call would send data to that the egress allowlist does not cover, in full. The binding then
   * carries the input hash the approval covers.
   */
  readonly destinations?: readonly string[];
  readonly executionBinding?: RuntimeToolExecutionBinding;
}

export type RuntimeToolDecision =
  | RuntimeToolAllowedDecision
  | RuntimeToolApprovalDecision
  | RuntimeToolDeniedDecision;

export interface RuntimeCompletedToolCall extends RuntimeRequestingModelGeneration {
  readonly approvalId?: Ulid;
  readonly effect: RuntimeToolRequest["effect"];
  readonly executionBinding?: RuntimeToolExecutionBinding;
  readonly externalOperationId?: string;
  readonly idempotencyKey: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly inputSummary: string;
  readonly outputSummary?: string;
  readonly output?: Readonly<Record<string, unknown>>;
  readonly policyAction: "allow" | "require-approval";
  readonly policyReason: string;
  readonly requiredScopes: readonly string[];
  readonly refreshTransientArtifacts?: boolean;
  readonly toolCallId: Ulid;
  readonly toolName: string;
}

export interface RuntimeApprovedToolCall {
  readonly approvalId: Ulid;
  readonly effect: RuntimeToolRequest["effect"];
  readonly executionBinding?: RuntimeToolExecutionBinding;
  readonly idempotencyKey: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly inputSummary: string;
  readonly policyReason: string;
  readonly requiredScopes: readonly string[];
  readonly toolCallId: Ulid;
  readonly toolName: string;
}

/** Pause metadata for tools executed by the calling client instead of the worker. */
export interface RuntimeClientToolPause {
  readonly expiresAt: string;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

export interface RuntimeToolExecutionResult {
  readonly artifacts?: readonly RuntimeArtifact[];
  /** Present only when a client-executed tool paused the run awaiting client output. */
  readonly client?: RuntimeClientToolPause;
  readonly externalOperationId?: string;
  readonly outputSummary?: string;
  readonly output?: Readonly<Record<string, unknown>>;
  readonly status: "completed" | "running";
  readonly transientArtifacts?: readonly RuntimeArtifact[];
}

export interface RuntimePendingToolRequest extends RuntimeRequestingModelGeneration {
  readonly effect: "execute" | "read" | "write";
  readonly executionBinding?: RuntimeToolExecutionBinding;
  readonly idempotencyKey: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly inputSummary: string;
  readonly policyReason: string;
  readonly requiredScopes: readonly string[];
}

export type RuntimePendingAction = RuntimePendingToolRequest &
  (
    | {
        readonly approvalId: Ulid;
        /** The decision's data-boundary destinations, shown to the approver. */
        readonly destinations?: readonly string[];
        readonly kind: "approval";
        readonly toolCallId: Ulid;
        readonly toolName: string;
      }
    | {
        readonly client?: RuntimeClientToolPause;
        readonly externalOperationId: string;
        readonly kind: "tool";
        readonly toolCallId: Ulid;
        readonly toolName: string;
      }
  );

export interface RuntimeArtifact {
  readonly content: string | Uint8Array;
  readonly contentType?: string;
  readonly fileName: string;
  readonly label: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly type?: string;
  readonly visibility?: "organization" | "private" | "public";
}

export type {
  RuntimeAttachmentIndexEntry,
  RuntimeInputArtifact,
  RuntimeInputOmission,
} from "./model-attachments.ts";
export type { ReplayReasoningDetails, RuntimeGenerationReasoning } from "./generation-reasoning.ts";

export interface RuntimeArtifactContinuation {
  readonly artifactBytes: number;
  readonly artifactIndexCursor: number;
  readonly artifacts: readonly Pick<
    RuntimeArtifact,
    "contentType" | "fileName" | "label" | "type" | "visibility"
  >[];
  readonly pendingArtifactPublicationIndexes?: readonly number[];
  readonly sandboxCompleted?: boolean;
  readonly sandboxFailureMessage?: string;
}

export type RuntimeResponseDepthMode = "default" | "detailed";

export interface RuntimeModelContinuationRecord {
  /** Number of completed model generations, used to keep model-call identifiers stable. */
  readonly modelCallCount: number;
  readonly responseDepthMode?: RuntimeResponseDepthMode;
  /** Complete model-generated request history required to validate and resume a paused run. */
  readonly toolRequests: readonly RuntimeToolRequest[];
}

export interface RuntimeModelContinuation extends RuntimeModelContinuationRecord {
  readonly generationReasoning: readonly RuntimeGenerationReasoning[];
}

export interface RuntimeSandboxCaptureFile {
  readonly contentType?: string;
  readonly fileName?: string;
  readonly label?: string;
  readonly maxBytes?: number;
  readonly path: string;
}

export interface RuntimeSandboxCommand {
  readonly captureFiles?: readonly RuntimeSandboxCaptureFile[];
  readonly captureOutput?: boolean;
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly label?: string;
  readonly timeoutMs?: number;
}

export interface RuntimeSandboxPolicy {
  readonly accessPolicyRef?: string;
  readonly imageRef?: string;
  readonly minMemoryMiB?: number;
  readonly minVcpu?: number;
  readonly mode: "none" | "run-ephemeral" | "thread-persistent";
  readonly poolKey?: string;
  readonly provider: SandboxProviderName;
}

export interface RuntimeInputMedia {
  readonly artifactIds: readonly string[];
  readonly owner: ArtifactOwner;
  readonly promptMessageId: Ulid;
}

export type AgentRunInput = RuntimeTenantScope &
  AgentRunIdentity &
  RuntimeObservabilityContext & {
    readonly approvedToolCalls?: readonly RuntimeApprovedToolCall[];
    readonly attachmentIndex?: readonly RuntimeAttachmentIndexEntry[];
    readonly artifactContinuation?: RuntimeArtifactContinuation;
    readonly brainRetrievalMode?: RuntimeBrainRetrievalMode;
    /**
     * Host-driven checkpoint request, true while the worker host drains. At the next tool-batch
     * boundary the runtime checkpoints progress made in this execution, or returns
     * `interrupted` when there is nothing new to persist, instead of starting another generation.
     */
    readonly checkpointRequested?: () => boolean;
    readonly completedToolCalls?: readonly RuntimeCompletedToolCall[];
    readonly conversationCheckpoint?: RuntimeConversationCheckpoint;
    readonly conversationTimingAnchor?: RuntimeConversationTimingAnchor;
    readonly instructions: string;
    readonly inputMedia?: RuntimeInputMedia;
    readonly inputOmissions?: readonly RuntimeInputOmission[];
    readonly unlistedInputOmissions?: number;
    readonly responseFormat?: AgentResponseFormat;
    readonly historySelection?: RuntimeHistorySelection;
    readonly memoryMode?: RuntimeMemoryMode;
    /** Release-pinned model generation cap; the runtime enforces the lower of this and its hard ceiling. */
    readonly maxModelGenerations?: number;
    /** Release-pinned completed tool call cap; the runtime enforces the lower of this and its hard ceiling. */
    readonly maxToolCalls?: number;
    /** Environment-admitted catalog metadata for the run's non-curated primary and fallback models. */
    readonly modelCatalog?: ModelCatalogRuntimeEntries;
    readonly modelFallbackIds?: readonly string[];
    readonly modelFallbackStartIndex?: number;
    readonly modelContinuation?: RuntimeModelContinuation;
    readonly modelId: string;
    readonly modelInputTokenBudget?: number;
    /** Release-pinned provider request options for every generation of this run. */
    readonly modelOptions?: AgentModelOptions;
    readonly modelOutputTokenReserve?: number;
    readonly modelToolProtocol?: "gemma4";
    /** Release-pinned tool names the model may choose from. */
    readonly modelToolNames?: readonly string[];
    readonly prompt: string;
    /** Canonical acceptance time of the user or automation prompt. */
    readonly promptCreatedAt?: string;
    readonly runContext?: string;
    readonly recentMessages?: readonly RuntimeConversationMessage[];
    readonly relevantMemories?: readonly RuntimeMemoryContextItem[];
    readonly responseDepthPolicy?: AgentResponseDepthPolicy;
    /** The call whose retryable failures requeued this run, and how many times it has failed. */
    readonly retriedToolCall?: RuntimeRetriedToolCall;
    readonly runAttempt: number;
    readonly runExecutionVersion: number;
    readonly sandboxCommands?: readonly RuntimeSandboxCommand[];
    readonly sandboxPolicy: RuntimeSandboxPolicy;
    readonly signal?: AbortSignal;
    readonly skills?: readonly string[];
    readonly toolRequests?: readonly RuntimeToolRequest[];
    /** Release-pinned opt-in: attach the latest generation's screenshot artifacts as model images. */
    readonly toolResultImages?: "screenshots";
  };

export type RuntimeModelGenerationRequest = RuntimeTenantScope &
  AgentRunIdentity &
  RuntimeObservabilityContext & {
    readonly attachmentIndex?: readonly RuntimeAttachmentIndexEntry[];
    readonly completedToolCalls: readonly RuntimeCompletedToolCall[];
    readonly conversationCheckpoint?: RuntimeConversationCheckpoint;
    readonly conversationTimingAnchor?: RuntimeConversationTimingAnchor;
    readonly brainEvidence: readonly RuntimeBrainEvidenceContextItem[];
    readonly instructions: string;
    readonly inputArtifacts?: readonly RuntimeInputArtifact[];
    readonly inputOmissions?: readonly RuntimeInputOmission[];
    readonly unlistedInputOmissions?: number;
    readonly promptMessageId?: Ulid;
    readonly responseFormat?: AgentResponseFormat;
    readonly historySelection?: RuntimeHistorySelection;
    readonly memories: readonly RuntimeMemoryContextItem[];
    /** Admitted catalog limits and pricing, keyed by canonical model id; see AgentRunInput. */
    readonly modelCatalog?: ModelCatalogRuntimeEntries;
    readonly modelCallId: string;
    readonly modelToolCallSlots: readonly RuntimeModelToolCallSlot[];
    readonly modelId: string;
    readonly modelInputTokenBudget?: number;
    readonly modelOptions?: AgentModelOptions;
    readonly modelOutputTokenReserve?: number;
    readonly modelToolProtocol?: "gemma4";
    readonly onTextDelta?: (delta: RuntimeAssistantTextDelta) => void;
    readonly prompt: string;
    /** Canonical acceptance time of the user or automation prompt. */
    readonly promptCreatedAt?: string;
    readonly recentMessages: readonly RuntimeConversationMessage[];
    readonly replayReasoning?: ReadonlyMap<number, ReplayReasoningDetails>;
    readonly responseDepthPolicy?: AgentResponseDepthPolicy;
    readonly responseDepthMode?: RuntimeResponseDepthMode;
    /** Code-owned recovery context for the deliberate second attempt against the same route. */
    readonly responseRecovery?: "same-model-retry";
    readonly sandboxArtifacts: readonly RuntimeArtifact[];
    readonly runContext?: string;
    readonly signal?: AbortSignal;
    readonly skills: readonly string[];
    readonly tools: readonly RuntimeToolDefinition[];
    readonly toolResultImages?: "screenshots";
  };

export interface RuntimeModelToolCallSlot {
  readonly idempotencyKey: string;
  readonly modelCallIndex: number;
  readonly toolCallIndex: number;
}

export interface RuntimeUsageEntry {
  /** Prompt tokens served from the provider cache, a subset of inputTokens. */
  readonly cachedInputTokens?: number;
  /** Prompt tokens written to the provider cache, a subset of inputTokens. */
  readonly cacheWriteInputTokens?: number;
  readonly costUsdNanoDollars?: number;
  readonly costUsdMicros?: number;
  readonly idempotencyKey: string;
  readonly inputTokens?: number;
  readonly modelId?: string;
  readonly occurredAt: number | string;
  readonly outputTokens?: number;
  /** Who paid for `model_tokens` usage; the worker refuses model usage without it. */
  readonly payer?: ModelUsagePayer;
  readonly provider?: string;
  readonly quantity: number;
  readonly runId?: string;
  readonly source: string;
  readonly startedAt?: number | string;
  readonly type: string;
  readonly unit: string;
}

export interface RuntimeModelGenerationResult {
  readonly assistantMessage: string;
  readonly inputTokens?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly outputTokens?: number;
  readonly reasoningDetails?: readonly ReasoningDetail[];
  readonly resolvedModelId?: string;
  readonly responseError?: string;
  readonly toolCalls?: readonly RuntimeModelToolCall[];
  readonly totalTokens?: number;
  readonly usage?: readonly RuntimeUsageEntry[];
}

export interface RuntimeModelToolCall {
  readonly input?: Readonly<Record<string, unknown>>;
  /** Provider-native correlation used only to derive a stable runtime idempotency key. */
  readonly modelToolCallId: string;
  readonly toolName: string;
}

export interface RuntimeModelGenerationPort {
  (request: RuntimeModelGenerationRequest): Promise<RuntimeModelGenerationResult>;
  readonly validateRunInput?: (input: AgentRunInput) => Promise<void> | void;
}

export type RuntimeProgressEvent = RuntimeTenantScope &
  AgentRunIdentity &
  RuntimeObservabilityContext & {
    readonly eventType: string;
    readonly level: "debug" | "error" | "info" | "warn";
    readonly message: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly occurredAt: string;
  };

export type RuntimeAgentPlanEvent = RuntimeTenantScope &
  AgentRunIdentity &
  RuntimeObservabilityContext & {
    readonly occurredAt: string;
    readonly runAttempt: number;
    readonly runExecutionVersion: number;
  } & AgentPlanUpdate;

export type RuntimeMemoryRecallRequest = RuntimeTenantScope &
  AgentRunIdentity &
  RuntimeObservabilityContext & {
    readonly memoryMode: Exclude<RuntimeMemoryMode, "off">;
    readonly prompt: string;
    readonly recentMessages: readonly RuntimeConversationMessage[];
    readonly signal?: AbortSignal;
  };

export type RuntimeBrainRecallRequest = RuntimeTenantScope &
  AgentRunIdentity &
  RuntimeObservabilityContext & {
    readonly brainRetrievalMode: Exclude<RuntimeBrainRetrievalMode, "off">;
    readonly memories: readonly RuntimeMemoryContextItem[];
    readonly prompt: string;
    readonly recentMessages: readonly RuntimeConversationMessage[];
    readonly signal?: AbortSignal;
  };

export interface RuntimeBrainRecallResult {
  readonly brainRequired: boolean;
  readonly evidence: readonly RuntimeBrainEvidenceContextItem[];
  readonly reasons: readonly string[];
  readonly route: "both" | "brain" | "memory" | "neither";
  readonly unmetEvidenceRequirement: boolean;
}

export type RuntimeBrainEvidenceRevalidationRequest = RuntimeTenantScope &
  AgentRunIdentity &
  RuntimeObservabilityContext & {
    readonly evidence: readonly RuntimeBrainEvidenceContextItem[];
    readonly signal?: AbortSignal;
  };

export interface RuntimeSandboxLeaseUpdate {
  readonly context: RuntimeTenantScope & AgentRunIdentity & RuntimeObservabilityContext;
  readonly lease: SandboxLease;
  readonly phase: "created" | "destroyed";
}

export interface RuntimeSandboxLeaseMismatch {
  readonly expected: RuntimeTenantScope & AgentRunIdentity;
  readonly lease: SandboxLease;
}

export type RuntimeSandboxAllocationRecovery = RuntimeTenantScope &
  AgentRunIdentity &
  (
    | {
        readonly allocationToken: string;
        readonly automaticReconciliation: boolean;
        readonly kind: "unknown";
        readonly provider: SandboxProviderName;
      }
    | {
        readonly cleanupCompletedAt?: number;
        readonly identityVerified: boolean;
        readonly kind: "lease";
        readonly lease: SandboxLease;
        readonly provider: SandboxProviderName;
      }
  );

export interface AgentRuntimeDependencies {
  readonly assistantTextStream?: RuntimeAssistantTextStream;
  readonly appendProgress?: (event: RuntimeProgressEvent) => Promise<void>;
  readonly publishAgentPlan?: (event: RuntimeAgentPlanEvent) => Promise<void>;
  readonly authorizeToolCall?: (
    request: RuntimeToolRequest &
      RuntimeTenantScope &
      AgentRunIdentity & { readonly signal?: AbortSignal },
  ) => Promise<RuntimeToolDecision>;
  readonly executeToolCall?: (
    request: RuntimeToolRequest &
      RuntimeTenantScope &
      AgentRunIdentity &
      RuntimeToolTraceContext & {
        readonly approvalId?: Ulid;
        readonly brainEvidence?: readonly RuntimeBrainEvidenceContextItem[];
        readonly completedToolCalls?: readonly RuntimeCompletedToolCall[];
        readonly decision: RuntimeToolAllowedDecision;
        readonly executionKind?: "agent-run" | "workflow";
        readonly policyAction?: "allow" | "require-approval";
        readonly recordedArtifactIds?: readonly Ulid[];
        readonly signal?: AbortSignal;
      },
  ) => Promise<RuntimeToolExecutionResult>;
  readonly generateAssistantMessage: RuntimeModelGenerationPort;
  readonly loadArtifact?: (
    index: number,
    context: RuntimeTenantScope & AgentRunIdentity,
  ) => Promise<RuntimeArtifact>;
  readonly loadInputArtifacts?: (
    input: RuntimeTenantScope &
      AgentRunIdentity & {
        readonly media: RuntimeInputMedia;
        readonly signal?: AbortSignal;
      },
  ) => Promise<readonly RuntimeInputArtifact[]>;
  readonly now?: () => number;
  readonly recallMemory?: (
    request: RuntimeMemoryRecallRequest,
  ) => Promise<readonly RuntimeMemoryContextItem[]>;
  readonly recallBrain?: (request: RuntimeBrainRecallRequest) => Promise<RuntimeBrainRecallResult>;
  readonly revalidateBrainEvidence?: (
    request: RuntimeBrainEvidenceRevalidationRequest,
  ) => Promise<readonly RuntimeBrainEvidenceContextItem[]>;
  readonly recordModelInvocation?: (attempt: RuntimeModelInvocationAttempt) => Promise<void>;
  readonly recordArtifact?: (
    artifact: RuntimeArtifact,
    index: number,
    context: RuntimeTenantScope & AgentRunIdentity & RuntimeObservabilityContext,
  ) => Promise<void>;
  readonly retryArtifactPublication?: (
    index: number,
    context: RuntimeTenantScope & AgentRunIdentity,
  ) => Promise<void>;
  readonly recordSandboxAllocationRecovery?: (
    recovery: RuntimeSandboxAllocationRecovery,
  ) => Promise<void>;
  readonly recordSandboxLease?: (update: RuntimeSandboxLeaseUpdate) => Promise<void>;
  readonly reportSandboxLeaseMismatch?: (mismatch: RuntimeSandboxLeaseMismatch) => Promise<void>;
  readonly resolveToolDefinition?: (
    toolName: string,
    context?: RuntimeTenantScope & AgentRunIdentity,
  ) => Promise<RuntimeToolDefinition | undefined>;
  readonly sandboxProvider?: SandboxProvider;
  readonly shouldCancel?: (runId: Ulid) => Promise<boolean>;
}

export type AgentRunCompletionStatus =
  | "canceled"
  /** Durable progress was saved at a tool-batch boundary; the worker requeues the run immediately. */
  | "checkpointed"
  | "completed"
  /**
   * The host stopped the run (drain request with nothing new to checkpoint, or a
   * `RuntimeHostShutdownError` abort); the worker requeues it without consuming a retry attempt.
   */
  | "interrupted"
  | "waiting-for-approval"
  | "waiting-for-tool";

export interface AgentRunResult {
  readonly artifactContinuation: RuntimeArtifactContinuation;
  readonly artifacts: readonly RuntimeArtifact[];
  readonly assistantMessage: string;
  readonly brainEvidence: readonly RuntimeBrainEvidenceContextItem[];
  readonly completionStatus: AgentRunCompletionStatus;
  readonly completedToolCalls: readonly RuntimeCompletedToolCall[];
  readonly modelContinuation?: RuntimeModelContinuation;
  readonly modelId?: string;
  readonly pendingAction?: RuntimePendingAction;
  readonly usage: readonly RuntimeUsageEntry[];
}

export interface AgentRuntime {
  readonly execute: (input: AgentRunInput) => Promise<AgentRunResult>;
}
