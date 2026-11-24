import type {
  AgentRuntimeDependencies,
  RuntimeCompletedToolCall,
  RuntimeBrainEvidenceContextItem,
  RuntimeMemoryMode,
  RuntimePendingAction,
} from "@deployments-ai/agent-runtime";
import type {
  DynamoDatabaseService,
  DynamoValue,
  LoadModelOperatorGrants,
  OrganizationCapacity,
  PlatformRecord,
  Ulid,
} from "@deployments-ai/db";
import type { SpanId, TraceId } from "@deployments-ai/observability";
import type { MemoryReviewMode } from "@deployments-ai/memory";
import type { ThreadStreamEvent } from "@deployments-ai/streaming";
import type { TenantLimitResolver } from "@deployments-ai/tenant-limits";
import type { AgentRunModelTokenRegistry } from "./agent-run-model-tokens.ts";
import type { RuntimeRunLogRegistry } from "./runtime-log-emitter.ts";
import type { ScheduleClientToolExpiration } from "./client-tool-expiration.ts";
import type { TeamsConnectorClient } from "@deployments-ai/channel-adapters/teams";
import type { SlackAgentStreamClient } from "./slack-agent-stream.ts";
import type { ThreadSandboxWorkspace } from "./thread-sandbox/contracts.ts";
import type { TenantLimitMetrics } from "./tenant-limit-metrics.ts";

export type RunRecordValue = Extract<PlatformRecord, { readonly itemType: "run" }>;
export type RunLookupRecordValue = Extract<PlatformRecord, { readonly itemType: "run-lookup" }>;
export type ThreadRecordValue = Extract<PlatformRecord, { readonly itemType: "thread" }>;
export type MessageRecordValue = Extract<PlatformRecord, { readonly itemType: "message" }>;
export type ConversationCheckpointRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "conversation-checkpoint" }
>;
export type TimelineEventRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "timeline-event" }
>;
export type ToolCallRecordValue = Extract<PlatformRecord, { readonly itemType: "tool-call" }>;
export type ApprovalRecordValue = Extract<PlatformRecord, { readonly itemType: "approval" }>;
export type AgentDeploymentRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "agent-deployment" }
>;
export type AgentReleaseRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "agent-release" }
>;

export const EXTERNAL_PUBLICATION_SETTLED_RECOVERY_REASON = "external-publication-settled" as const;
export const THREAD_CONTINUITY_RECOVERY_REASON = "thread-continuity-recovery" as const;

export type AgentRunRecoveryReason =
  | typeof EXTERNAL_PUBLICATION_SETTLED_RECOVERY_REASON
  | typeof THREAD_CONTINUITY_RECOVERY_REASON;

export interface AgentRunQueueMessage {
  readonly environmentId: Ulid;
  readonly idempotencyKey: string;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly recoveryReason?: AgentRunRecoveryReason;
  readonly runId: Ulid;
  readonly spanId: SpanId;
  readonly threadId: Ulid;
  readonly traceId: TraceId;
  readonly userMessageId: Ulid;
  readonly userMessageSequence: number;
}

export function agentRunQueueMessageGroupId(message: AgentRunQueueMessage): string {
  return [message.organizationId, message.projectId, message.environmentId, message.threadId].join(
    ":",
  );
}

export function agentRunRecoveryQueueMessageGroupId(message: AgentRunQueueMessage): string {
  return `${agentRunQueueMessageGroupId(message)}:recovery`;
}

export interface AgentRunQueueEnqueueInput {
  readonly deduplicationId: string;
  readonly message: AgentRunQueueMessage;
  readonly messageGroupId: string;
}

export type AgentRunQueueEnqueue = (
  input: AgentRunQueueEnqueueInput,
  signal?: AbortSignal,
) => Promise<void>;

export interface AgentRunQueueDelivery {
  readonly messageId: string;
  readonly receiptHandle: string;
  readonly receiveCount?: number;
}

export interface AgentRunMessageBodyWrite {
  readonly body: string;
  readonly contentHash: string;
  readonly messageId: Ulid;
  readonly run: RunRecordValue;
  readonly signal?: AbortSignal;
}

export class AgentRunMessageBodyWriteOutcomeUnknownError extends AggregateError {
  constructor(errors: Iterable<unknown>) {
    super(errors, "Assistant message body write outcome could not be reconciled.");
    this.name = "AgentRunMessageBodyWriteOutcomeUnknownError";
  }
}

export interface AgentRunMessageBodyDelete {
  readonly bodyRef: NonNullable<MessageRecordValue["data"]["bodyRef"]>;
  readonly messageId: Ulid;
  readonly run: RunRecordValue;
  readonly signal?: AbortSignal;
}

export interface AgentRunQueueVisibilityExtension {
  (
    delivery: AgentRunQueueDelivery,
    message: AgentRunQueueMessage,
    signal?: AbortSignal,
  ): Promise<void>;
  readonly renewalIntervalMs: number;
}

export type AgentRunQueueRetry = (
  delivery: AgentRunQueueDelivery,
  message: AgentRunQueueMessage | undefined,
  visibilityTimeoutSeconds: number,
) => Promise<void>;

/** The worker host's drain state as seen by the runs it is executing. */
export interface AgentRunHostDrain {
  /** Epoch milliseconds by which in-flight runs must exit; undefined while the host is not draining. */
  readonly deadline: () => number | undefined;
  /** Aborted with a `RuntimeHostShutdownError` once the drain deadline passes. */
  readonly signal: AbortSignal;
}

export interface AgentRunWorkerDependencies {
  readonly appendThreadEvent?: (event: ThreadStreamEvent, signal?: AbortSignal) => Promise<void>;
  readonly createExecutionInputArtifactLoader?: () => NonNullable<
    AgentRuntimeDependencies["loadInputArtifacts"]
  >;
  readonly database: DynamoDatabaseService;
  readonly deleteMessageBody?: (input: AgentRunMessageBodyDelete) => Promise<void>;
  readonly enqueueMemoryFlush?: (
    run: RunRecordValue,
    memoryMode: RuntimeMemoryMode,
    checkpointMode?: "auto" | "off",
    reviewMode?: MemoryReviewMode,
    modelId?: string,
  ) => Promise<"enqueued" | "unconfigured">;
  readonly enqueueRun?: AgentRunQueueEnqueue;
  readonly extendQueueVisibility?: AgentRunQueueVisibilityExtension;
  readonly generateId: () => Promise<Ulid>;
  readonly heartbeatIntervalMs?: number;
  /** Present on the long-lived worker host; drives drain checkpoints and shutdown interruption. */
  readonly hostDrain?: AgentRunHostDrain;
  /** Operator model grants; per-run model admission admits models the run's grants list. */
  readonly loadModelOperatorGrants?: LoadModelOperatorGrants;
  readonly now?: () => Date;
  readonly organizationCapacity: OrganizationCapacity;
  readonly queueMaxReceiveCount: number;
  readonly queueVisibilityExtensionTimeoutMs?: number;
  readonly prepareBrainPublication?: (input: {
    readonly body: string;
    readonly brainEvidence: readonly RuntimeBrainEvidenceContextItem[];
    readonly brainToolCalls: readonly RuntimeCompletedToolCall[];
    readonly run: RunRecordValue;
    readonly signal?: AbortSignal;
  }) => Promise<{
    readonly body: string;
    readonly messageMetadata: Readonly<Record<string, DynamoValue>>;
  }>;
  readonly readMessageBody?: (message: MessageRecordValue, signal?: AbortSignal) => Promise<string>;
  readonly readChannelCredential?: (input: {
    readonly bindingId: Ulid;
    readonly environmentId: Ulid;
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly reference: Extract<
      NonNullable<
        Extract<PlatformRecord, { readonly itemType: "channel-binding" }>["data"]["credentialRef"]
      >,
      { readonly store: "dynamodb-kms" }
    >;
  }) => Promise<Readonly<Record<string, string>>>;
  readonly retryQueueMessage?: AgentRunQueueRetry;
  readonly reportQueueVisibilityFailure?: (
    delivery: AgentRunQueueDelivery,
    message: AgentRunQueueMessage | undefined,
    cause: unknown,
  ) => Promise<void>;
  readonly runningClaimTimeoutMs?: number;
  /** Schedules the deadline of a paused client-executed tool call. */
  readonly scheduleClientToolExpiration?: ScheduleClientToolExpiration;
  readonly slackAgentStream?: SlackAgentStreamClient;
  /**
   * Claims this worker holds; the agent generation gateway mints run tokens only for registered
   * runs. The processor registers a run after claiming it and removes it when execution ends.
   */
  readonly runModelTokens?: AgentRunModelTokenRegistry;
  /**
   * Loggers of the runs this worker executes. The processor registers one per claimed execution;
   * tools that print output (hosted code) find it by run. Without it no runtime logs are kept.
   */
  readonly runtimeLogs?: RuntimeRunLogRegistry;
  /** Bot Connector client for Teams personal-chat agent streams. */
  readonly teamsAgentStream?: Pick<TeamsConnectorClient, "sendActivity" | "updateActivity">;
  readonly runtime: Omit<
    AgentRuntimeDependencies,
    "appendProgress" | "loadInputArtifacts" | "recordModelInvocation"
  >;
  readonly tenantLimitMetrics: TenantLimitMetrics;
  readonly tenantLimits: TenantLimitResolver;
  /**
   * Owns thread-persistent sandboxes; the processor releases them at every run exit except a
   * checkpoint, and when a checkpointed run ends without resuming.
   */
  readonly threadSandbox?: ThreadSandboxWorkspace;
  readonly workerId: string;
  readonly writeMessageBody?: (
    input: AgentRunMessageBodyWrite,
  ) => Promise<NonNullable<MessageRecordValue["data"]["bodyRef"]>>;
}

export type ProcessAgentRunResult =
  | { readonly action: "completed"; readonly messageId: Ulid; readonly run: RunRecordValue }
  | {
      readonly action: "paused";
      readonly pendingAction: RuntimePendingAction;
      readonly run: RunRecordValue;
      readonly status: "waiting-for-approval" | "waiting-for-tool";
    }
  | {
      readonly action: "deferred";
      readonly inUse: number;
      readonly limit: number;
      readonly reason: "organization_concurrency_limited";
      readonly retryAfterSeconds: number;
      readonly run?: undefined;
    }
  | {
      readonly action: "requeued";
      /**
       * The retryable runtime failure behind the requeue: its error class, the bounded, redacted
       * message persisted on the `run.retry-scheduled` event, and the class names down its cause
       * chain. Cause messages are never included.
       */
      readonly failure?: {
        readonly causeTypes: readonly string[];
        readonly message: string;
        readonly type: string;
      };
      readonly reason: string;
      readonly retryAfterSeconds: number;
      readonly run?: undefined;
    }
  | { readonly action: "skipped"; readonly reason: string; readonly run?: RunRecordValue };
