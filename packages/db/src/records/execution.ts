import { Schema } from "effect";
import { ArtifactRecord } from "./artifacts.ts";
import {
  McpSessionRecord,
  OAuthRefreshClaimRecord,
  ProviderMutationClaimRecord,
  RuntimeLeaseRecord,
  StreamSessionRecord,
} from "./coordination.ts";
import {
  ApprovalActionTokenRecord,
  ApprovalRecord,
  ConversationCheckpointRecord,
  ChannelIngressBurstHeadRecord,
  ChannelIngressBurstRecord,
  ChannelIngressSourceClaimRecord,
  ChannelIngressSourceRecord,
  InboundThreadRouteRecord,
  MessageRecord,
  ConversationInboxThreadRecord,
  InboxThreadConversationRecord,
  MessagePublicationRecord,
  RunEdgeRecord,
  RunLookupRecord,
  RunRecord,
  ThreadRecord,
  TimelineEventRecord,
  ToolCallRecord,
} from "./conversations.ts";
import {
  InboxMessageThreadAliasTombstoneRecord,
  InboxMessageTombstoneRecord,
  InboxThreadErasureFenceRecord,
  ThreadTombstoneRecord,
} from "./conversation-erasure.ts";
import { GenerationReasoningRecord } from "./generation-reasoning.ts";
import {
  InboxAttachmentRecord,
  InboxContentCleanupRecord,
  InboxDraftRecord,
  InboxDraftCreatedIndexRecord,
  InboxMessageCreatedIndexRecord,
  InboxMessageThreadAliasRecord,
  InboxMessageThreadIndexRecord,
  InboxMessageRecord,
  InboxProviderEventRecord,
  InboxResourceLocatorRecord,
  InboxThreadCreatedIndexRecord,
  InboxThreadRecord,
} from "./inbox.ts";
import {
  MemoryFlushRecord,
  MemoryIndexJobRecord,
  MemoryRecallAttemptRecord,
  MemoryRetrievalRecord,
  MemoryReviewItemRecord,
  MemoryShadowJobRecord,
} from "./memory-runtime.ts";
import { ModelInvocationRecord, TraceRecord } from "./observability.ts";
import { RuntimeLogBatchRecord } from "./runtime-logs.ts";
import { EVALUATION_EXECUTION_RECORD_SCHEMAS } from "./evaluations.ts";
import {
  ChannelDeliveryLookupRecord,
  ChannelDeliveryRecord,
  HeartbeatRecord,
  HeartbeatRunRecord,
  ImageJobRecord,
  PdfJobRecord,
  ScheduleFireRecord,
  SlackAgentStreamRecord,
  TeamsAgentStreamRecord,
  AgentRunPlanRecord,
} from "./runtime-work.ts";
import { SandboxLeaseRecord, SandboxWorkspaceRecord } from "./sandboxes.ts";
import { RunDelegationRecord } from "./run-delegations.ts";
import { CallbackDispatchEvidenceRecord } from "./runtime-callbacks.ts";
import {
  BrainIndexJobRecord,
  BrainContentCleanupRecord,
  BrainDuplicatePassRecord,
  BrainErasureJobRecord,
  BrainQueryAttemptRecord,
  BrainRetrievalRecord,
  BrainReviewItemRecord,
  BrainSyncJobRecord,
} from "./brain-runtime.ts";
import {
  WorkflowApprovalRecord,
  WorkflowExecutionLookupRecord,
  WorkflowExecutionRecord,
  WorkflowStepAttemptRecord,
  WorkflowStepCorrelationRecord,
} from "./workflows.ts";

export * from "./artifacts.ts";
export * from "./brain-runtime.ts";
export * from "./coordination.ts";
export * from "./conversations.ts";
export * from "./generation-reasoning.ts";
export * from "./inbox.ts";
export * from "./memory-runtime.ts";
export * from "./observability.ts";
export * from "./runtime-work.ts";
export * from "./run-delegations.ts";
export * from "./runtime-callbacks.ts";
export * from "./runtime-logs.ts";
export * from "./sandboxes.ts";
export * from "./workflows.ts";

export const EXECUTION_RECORD_SCHEMAS = {
  ...EVALUATION_EXECUTION_RECORD_SCHEMAS,
  approval: ApprovalRecord,
  "approval-action-token": ApprovalActionTokenRecord,
  artifact: ArtifactRecord,
  "brain-content-cleanup": BrainContentCleanupRecord,
  "brain-duplicate-pass": BrainDuplicatePassRecord,
  "brain-erasure-job": BrainErasureJobRecord,
  "brain-index-job": BrainIndexJobRecord,
  "brain-query-attempt": BrainQueryAttemptRecord,
  "brain-retrieval": BrainRetrievalRecord,
  "brain-review-item": BrainReviewItemRecord,
  "brain-sync-job": BrainSyncJobRecord,
  "channel-delivery": ChannelDeliveryRecord,
  "channel-delivery-lookup": ChannelDeliveryLookupRecord,
  "channel-ingress-burst": ChannelIngressBurstRecord,
  "channel-ingress-burst-head": ChannelIngressBurstHeadRecord,
  "channel-ingress-source-claim": ChannelIngressSourceClaimRecord,
  "channel-ingress-source": ChannelIngressSourceRecord,
  "callback-dispatch-evidence": CallbackDispatchEvidenceRecord,
  "conversation-checkpoint": ConversationCheckpointRecord,
  "generation-reasoning": GenerationReasoningRecord,
  heartbeat: HeartbeatRecord,
  "heartbeat-run": HeartbeatRunRecord,
  "image-job": ImageJobRecord,
  "inbox-attachment": InboxAttachmentRecord,
  "inbox-content-cleanup": InboxContentCleanupRecord,
  "inbox-draft": InboxDraftRecord,
  "inbox-draft-created-index": InboxDraftCreatedIndexRecord,
  "inbox-message-created-index": InboxMessageCreatedIndexRecord,
  "inbox-message-thread-alias": InboxMessageThreadAliasRecord,
  "inbox-message-thread-alias-tombstone": InboxMessageThreadAliasTombstoneRecord,
  "inbox-message-thread-index": InboxMessageThreadIndexRecord,
  "inbox-message": InboxMessageRecord,
  "inbox-message-tombstone": InboxMessageTombstoneRecord,
  "inbox-thread-conversation": InboxThreadConversationRecord,
  "inbox-thread-erasure-fence": InboxThreadErasureFenceRecord,
  "inbox-provider-event": InboxProviderEventRecord,
  "inbox-resource-locator": InboxResourceLocatorRecord,
  "inbox-thread-created-index": InboxThreadCreatedIndexRecord,
  "inbox-thread": InboxThreadRecord,
  "inbound-thread-route": InboundThreadRouteRecord,
  "mcp-session": McpSessionRecord,
  "oauth-refresh-claim": OAuthRefreshClaimRecord,
  "memory-flush": MemoryFlushRecord,
  "memory-index-job": MemoryIndexJobRecord,
  "memory-recall-attempt": MemoryRecallAttemptRecord,
  "memory-retrieval": MemoryRetrievalRecord,
  "memory-review-item": MemoryReviewItemRecord,
  "memory-shadow-job": MemoryShadowJobRecord,
  "model-invocation": ModelInvocationRecord,
  "conversation-inbox-thread": ConversationInboxThreadRecord,
  message: MessageRecord,
  "message-publication": MessagePublicationRecord,
  "pdf-job": PdfJobRecord,
  "provider-mutation-claim": ProviderMutationClaimRecord,
  run: RunRecord,
  "run-lookup": RunLookupRecord,
  "run-delegation": RunDelegationRecord,
  "run-edge": RunEdgeRecord,
  "runtime-lease": RuntimeLeaseRecord,
  "runtime-log-batch": RuntimeLogBatchRecord,
  "sandbox-lease": SandboxLeaseRecord,
  "sandbox-workspace": SandboxWorkspaceRecord,
  "schedule-fire": ScheduleFireRecord,
  "slack-agent-stream": SlackAgentStreamRecord,
  "teams-agent-stream": TeamsAgentStreamRecord,
  "agent-run-plan": AgentRunPlanRecord,
  "stream-session": StreamSessionRecord,
  thread: ThreadRecord,
  "thread-tombstone": ThreadTombstoneRecord,
  trace: TraceRecord,
  "timeline-event": TimelineEventRecord,
  "tool-call": ToolCallRecord,
  "workflow-execution": WorkflowExecutionRecord,
  "workflow-execution-lookup": WorkflowExecutionLookupRecord,
  "workflow-approval": WorkflowApprovalRecord,
  "workflow-step-attempt": WorkflowStepAttemptRecord,
  "workflow-step-correlation": WorkflowStepCorrelationRecord,
} as const;

export const ExecutionRecord = Schema.Union(Object.values(EXECUTION_RECORD_SCHEMAS));
export type ExecutionRecord = typeof ExecutionRecord.Type;
