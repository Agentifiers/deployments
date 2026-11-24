import {
  DOCUMENT_MEDIA_TYPES,
  INPUT_AUDIO_MEDIA_TYPES,
  INPUT_FILE_UNUSABLE_REASONS,
  INPUT_IMAGE_MEDIA_TYPES,
} from "@deployments-ai/agent-manifest/input-files";
import { Schema } from "effect";
import { Cursor, JsonValue, Metadata, PublicId, Timestamp } from "./primitives.ts";
import type { PublicApiRouteContract } from "./route-contract.ts";
import { CONVERSATION_ERASURE_API_SCHEMAS } from "./conversation-erasure-contracts.ts";
import { RUNTIME_LOG_API_SCHEMAS } from "./runtime-log-schemas.ts";
import {
  CancelWorkflowExecutionRequest,
  ListWorkflowExecutionsResponse,
  ListWorkflowStepAttemptsResponse,
  ResolveWorkflowApprovalRequest,
  StartWorkflowExecutionRequest,
  WorkflowApprovalResponse,
  WorkflowExecutionResponse,
  WorkflowStepAttemptResponse,
} from "./workflows.ts";

import {
  CreatePreviewRequest,
  PreviewResponse,
  SubmitPreviewTurnRequest,
} from "./preview-contracts.ts";
import {
  CreateWebhookResponse,
  ListWebhookDeliveriesResponse,
  ListWebhookDeliveryAttemptsResponse,
  ListWebhooksResponse,
  RotateWebhookSecretResponse,
  TestWebhookResponse,
  WEBHOOK_API_SCHEMAS,
  WebhookDeliveryResponse,
  WebhookResponse,
} from "./webhook-contracts.ts";
import {
  ApprovalResponse,
  Channel,
  ChannelMetadata,
  ChannelProvider,
  ComposeChannelDeliveryRequest,
  CreateChannelBindingRequest,
  CreateHeartbeatRequest,
  CreateScheduleRequest,
  CreateThreadRequest,
  CreateWebhookSubscriptionRequest,
  DeleteChannelBindingCredentialRequest,
  FireAutomationRequest,
  FireHeartbeatRequest,
  HeartbeatActiveWindow,
  HeartbeatIntervalMs,
  MessageResponse,
  MessagePublicationResponse,
  PublishRunMessageRequest,
  PutChannelBindingCredentialRequest,
  ResolveApprovalRequest,
  ResolveToolResultRequest,
  RunAutomation,
  RunResponse,
  RuntimeActor,
  RuntimeIdempotencyKey,
  RuntimeListQuery,
  RuntimeMutableFields,
  RuntimeTenantFields,
  RuntimeTimezone,
  RuntimeWorkspaceFields,
  SearchRunsRequest,
  SubmitAgentRunRequest,
  ThreadResponse,
  UpdateChannelBindingRequest,
  UpdateHeartbeatRequest,
  UpdateScheduleRequest,
} from "./runtime-request-contracts.ts";
import {
  CreateArtifactAccessUrlRequest,
  CreateArtifactUploadRequest,
  UpdateArtifactRetentionRequest,
} from "./runtime-artifact-request-contracts.ts";
export const ToolCallResponse = Schema.Struct({
  ...RuntimeMutableFields,
  ...RuntimeTenantFields,
  approvalId: Schema.optional(PublicId),
  completedAt: Schema.optional(Timestamp),
  effect: Schema.Literals(["execute", "read", "write"]),
  /** Present only for tool calls the calling client must execute. */
  executionType: Schema.optional(Schema.Literal("client")),
  /** Deadline for submitting a client tool result; the call fails and the run resumes after it. */
  expiresAt: Schema.optional(Timestamp),
  externalOperationId: Schema.optional(Schema.String),
  id: PublicId,
  /** Tool input; projected only for client-executed tool calls. */
  input: Schema.optional(Metadata),
  inputSummary: Schema.String,
  /**
   * Attempt id of the model invocation attempt whose result requested this tool call; equals that
   * model span's `attempt_id`. Present, with `modelCallIndex`, only on model-requested tool calls.
   */
  modelAttemptId: Schema.optional(Schema.String),
  /**
   * Per-run index of the model generation that requested this tool call. The next generation has
   * index `modelCallIndex + 1`. Present only together with `modelAttemptId`.
   */
  modelCallIndex: Schema.optional(
    Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  ),
  object: Schema.Literal("tool-call"),
  /** Submitted structured output; projected only for client-executed tool calls. */
  output: Schema.optional(Metadata),
  /** JSON Schema the client tool output must satisfy, when the extension declares one. */
  outputSchema: Schema.optional(Metadata),
  outputSummary: Schema.optional(Schema.String),
  policyAction: Schema.optional(Schema.Literals(["allow", "deny", "require-approval"])),
  policyReason: Schema.optional(Schema.String),
  requiredScopes: Schema.Array(Schema.String),
  runId: PublicId,
  startedAt: Schema.optional(Timestamp),
  status: Schema.Literals(["failed", "pending", "running", "succeeded", "waiting"]),
  toolAdapterId: Schema.optional(PublicId),
  toolName: Schema.String,
  toolPlanFingerprint: Schema.optional(Schema.String),
});

export const CallbackDispatchEvidenceResponse = Schema.Struct({
  ...RuntimeWorkspaceFields,
  agentDefinitionId: PublicId,
  agentDeploymentId: PublicId,
  agentReleaseId: PublicId,
  approval: Schema.optional(
    Schema.Struct({
      expiresAt: Schema.optional(Timestamp),
      id: PublicId,
      kind: Schema.Literals(["agent-run", "workflow"]),
      resolvedBy: Schema.optional(
        Schema.Struct({
          id: Schema.optional(PublicId),
          type: Schema.Literals(["agent", "principal", "service-account", "system", "worker"]),
        }),
      ),
      status: Schema.Literal("approved"),
    }),
  ),
  createdAt: Timestamp,
  effect: Schema.Literals(["execute", "read", "write"]),
  executionKind: Schema.Literals(["agent-run", "workflow"]),
  id: PublicId,
  idempotencyKey: Schema.String,
  inputHash: Schema.String,
  object: Schema.Literal("callback-dispatch-evidence"),
  policyAction: Schema.Literals(["allow", "require-approval"]),
  policyReason: Schema.String,
  requiredScopes: Schema.Array(Schema.String),
  runId: PublicId,
  threadId: PublicId,
  toolCallId: PublicId,
  toolName: Schema.String,
});

/** How a `type: "input"` upload resolved; `message` says why an unusable file can't be attached. */
export const ArtifactInputFileResponse = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("image"),
    mediaType: Schema.Literals(INPUT_IMAGE_MEDIA_TYPES),
  }),
  Schema.Struct({
    kind: Schema.Literal("audio"),
    mediaType: Schema.Literals(INPUT_AUDIO_MEDIA_TYPES),
  }),
  Schema.Struct({
    kind: Schema.Literal("document"),
    mediaType: Schema.Literals(DOCUMENT_MEDIA_TYPES),
    summary: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("unusable"),
    message: Schema.String,
    reason: Schema.Literals(INPUT_FILE_UNUSABLE_REASONS),
  }),
]);

export const ArtifactResponse = Schema.Struct({
  agentDeploymentId: Schema.optional(PublicId),
  artifactId: PublicId,
  byteSize: Schema.Number,
  contentType: Schema.String,
  createdAt: Timestamp,
  fileName: Schema.optional(Schema.String),
  input: Schema.optional(ArtifactInputFileResponse),
  metadata: Schema.optional(Metadata),
  name: Schema.String,
  object: Schema.Literal("artifact"),
  retentionExpiresAt: Schema.optional(Timestamp),
  runId: Schema.optional(PublicId),
  status: Schema.Literals(["available", "deleted", "failed", "pending"]),
  threadId: Schema.optional(PublicId),
  type: Schema.String,
  updatedAt: Timestamp,
  version: Schema.Number,
  visibility: Schema.Literals(["organization", "private", "public"]),
});

export const ArtifactAccessUrlResponse = Schema.Struct({
  expiresAt: Timestamp,
  url: Schema.String,
});

export const CreateArtifactUploadResponse = Schema.Struct({
  artifact: ArtifactResponse,
  upload: Schema.Struct({
    expiresAt: Timestamp,
    headers: Schema.Record(Schema.String, Schema.String),
    method: Schema.Literal("PUT"),
    url: Schema.String,
  }),
});

export const ListArtifactsResponse = Schema.Struct({
  artifacts: Schema.Array(ArtifactResponse),
  nextCursor: Schema.optional(Schema.String),
});

export const ScheduleConfiguration = Schema.Struct({
  expression: Schema.String,
  timezone: Schema.optional(RuntimeTimezone),
});

/** The agent tool call that created a schedule during a run. */
export const ScheduleCreatedFrom = Schema.Struct({
  runId: PublicId,
  threadId: PublicId,
  toolCallId: PublicId,
  toolName: Schema.String,
});

export const ScheduleResponse = Schema.Struct({
  ...RuntimeMutableFields,
  ...RuntimeWorkspaceFields,
  agentDeploymentId: PublicId,
  createdBy: Schema.optional(RuntimeActor),
  createdFrom: Schema.optional(ScheduleCreatedFrom),
  id: PublicId,
  name: Schema.String,
  nextRunAt: Schema.optional(Timestamp),
  object: Schema.Literal("schedule"),
  prompt: Schema.optional(Schema.String),
  schedule: ScheduleConfiguration,
  status: Schema.Literals(["active", "archived", "paused", "provisioning"]),
  threadId: Schema.optional(PublicId),
});

export const HeartbeatConfiguration = Schema.Struct({
  instructions: Schema.String,
  intervalMs: HeartbeatIntervalMs,
  skipWhenBusy: Schema.Boolean,
  timezone: Schema.optional(RuntimeTimezone),
});

export const HeartbeatResponse = Schema.Struct({
  ...RuntimeMutableFields,
  ...RuntimeWorkspaceFields,
  activeWindow: Schema.optional(HeartbeatActiveWindow),
  agentDeploymentId: PublicId,
  createdBy: Schema.optional(RuntimeActor),
  id: PublicId,
  lastRunAt: Schema.optional(Timestamp),
  nextRunAt: Schema.optional(Timestamp),
  object: Schema.Literal("heartbeat"),
  schedule: HeartbeatConfiguration,
  status: Schema.Literals(["active", "archived", "disabled", "paused", "provisioning"]),
  threadId: Schema.optional(PublicId),
});

export const ChannelBindingResponseFields = {
  ...RuntimeMutableFields,
  ...RuntimeWorkspaceFields,
  agentDefinitionId: PublicId,
  agentDeploymentId: Schema.optional(PublicId),
  channel: Channel,
  connectionId: Schema.optional(PublicId),
  credentialAttached: Schema.Boolean,
  externalAccountId: Schema.optional(Schema.String),
  externalChannelId: Schema.optional(Schema.String),
  externalThreadKey: Schema.optional(Schema.String),
  externalWorkspaceId: Schema.optional(Schema.String),
  id: PublicId,
  lastVerifiedAt: Schema.optional(Timestamp),
  metadata: Schema.optional(ChannelMetadata),
  object: Schema.Literal("channel-binding"),
  provider: ChannelProvider,
  status: Schema.Literals(["active", "archived", "disabled"]),
} as const;

export const ChannelBindingResponse = Schema.Struct(ChannelBindingResponseFields);

export const VerifyChannelBindingResponse = Schema.Struct({
  ...ChannelBindingResponseFields,
  verification: Schema.Literal("configuration-and-credential"),
});

export const ChannelDeliveryResponse = Schema.Struct({
  ...RuntimeMutableFields,
  ...RuntimeWorkspaceFields,
  attempts: Schema.Number,
  bindingId: Schema.optional(PublicId),
  channel: Channel,
  contentPreview: Schema.String,
  externalThreadKey: Schema.String,
  failedAt: Schema.optional(Timestamp),
  id: PublicId,
  lastError: Schema.optional(Schema.String),
  object: Schema.Literal("channel-delivery"),
  provider: ChannelProvider,
  providerMessageId: Schema.optional(Schema.String),
  runId: PublicId,
  sentAt: Schema.optional(Timestamp),
  status: Schema.Literals(["failed", "queued", "sending", "sent"]),
  threadId: PublicId,
});

export const ComposeChannelDeliveryResponse = Schema.Struct({
  delivery: ChannelDeliveryResponse,
  duplicate: Schema.Boolean,
});

export const ScheduleFireResponse = Schema.Struct({
  ...RuntimeTenantFields,
  createdAt: Timestamp,
  fireKey: Schema.String,
  firedAt: Timestamp,
  id: PublicId,
  object: Schema.Literal("schedule-fire"),
  runId: Schema.optional(PublicId),
  scheduleId: PublicId,
  scheduleVersion: Schema.optional(Schema.Number),
  status: Schema.Literals(["accepted", "duplicate", "failed"]),
  threadId: Schema.optional(PublicId),
});

export const HeartbeatRunResponse = Schema.Struct({
  ...RuntimeTenantFields,
  completedAt: Schema.optional(Timestamp),
  createdAt: Timestamp,
  heartbeatId: PublicId,
  id: PublicId,
  object: Schema.Literal("heartbeat-run"),
  responseKind: Schema.optional(Schema.String),
  runId: Schema.optional(PublicId),
  skipReason: Schema.optional(Schema.String),
  status: Schema.Literals(["accepted", "skipped"]),
  threadId: Schema.optional(PublicId),
  version: Schema.Number,
});

export const AutomationRunResponse = Schema.Struct({
  runId: PublicId,
  threadId: PublicId,
});

export const SubmitAgentRunResponse = Schema.Struct({
  created: Schema.Boolean,
  message: MessageResponse,
  run: RunResponse,
  thread: ThreadResponse,
});

export const ListThreadMessagesResponse = Schema.Struct({
  messages: Schema.Array(MessageResponse),
  nextCursor: Schema.optional(Cursor),
});

export const ListRunsResponse = Schema.Struct({
  nextCursor: Schema.optional(Cursor),
  runs: Schema.Array(RunResponse),
});

export const ListThreadsResponse = Schema.Struct({
  nextCursor: Schema.optional(Cursor),
  threads: Schema.Array(ThreadResponse),
});

export const ListApprovalsResponse = Schema.Struct({
  approvals: Schema.Array(ApprovalResponse),
  nextCursor: Schema.optional(Cursor),
});

export const ListToolCallsResponse = Schema.Struct({
  nextCursor: Schema.optional(Cursor),
  toolCalls: Schema.Array(ToolCallResponse),
});

export const ListChannelBindingsResponse = Schema.Struct({
  channelBindings: Schema.Array(ChannelBindingResponse),
  nextCursor: Schema.optional(Cursor),
});

export const ListChannelDeliveriesResponse = Schema.Struct({
  channelDeliveries: Schema.Array(ChannelDeliveryResponse),
  nextCursor: Schema.optional(Cursor),
});

export const RuntimeStreamReplayState = Schema.Struct({
  canonicalMessageIds: Schema.optional(Schema.Array(PublicId)),
  eventIds: Schema.optional(Schema.Array(PublicId)),
  finalizedMessageIds: Schema.Array(PublicId),
  historyThroughSequence: Schema.optional(Schema.Number),
});

export const RuntimeStreamSession = Schema.Struct({
  environmentId: PublicId,
  expiresAt: Timestamp,
  offset: Schema.String,
  organizationId: PublicId,
  permissions: Schema.Array(Schema.Literals(["append", "read"])),
  projectId: PublicId,
  readUrl: Schema.String,
  replayState: RuntimeStreamReplayState,
  sessionId: PublicId,
  threadId: PublicId,
});

export const CreateThreadStreamSessionResponse = Schema.Struct({
  accessToken: Schema.String,
  history: Schema.Array(MessageResponse),
  historyNextCursor: Schema.optional(Cursor),
  session: RuntimeStreamSession,
  /** Absolute URL of this thread's stream on the public stream gateway. */
  streamUrl: Schema.String,
});

export const ResolveApprovalResponse = Schema.Struct({
  approval: ApprovalResponse,
  decision: Schema.Literals(["approved", "expired", "rejected"]),
  run: RunResponse,
  toolCall: ToolCallResponse,
});

export const ResolveToolResultResponse = Schema.Struct({
  outcome: Schema.Literals(["completed", "failed"]),
  run: RunResponse,
  toolCall: ToolCallResponse,
});

export const ListSchedulesResponse = Schema.Struct({
  nextCursor: Schema.optional(Cursor),
  schedules: Schema.Array(ScheduleResponse),
});

export const ListScheduleFiresResponse = Schema.Struct({
  fires: Schema.Array(ScheduleFireResponse),
  nextCursor: Schema.optional(Cursor),
});

export const FireScheduleResponse = Schema.Struct({
  duplicate: Schema.Boolean,
  fire: ScheduleFireResponse,
  run: Schema.optional(AutomationRunResponse),
});

export const ListHeartbeatsResponse = Schema.Struct({
  heartbeats: Schema.Array(HeartbeatResponse),
  nextCursor: Schema.optional(Cursor),
});

export const ListHeartbeatFiresResponse = Schema.Struct({
  fires: Schema.Array(HeartbeatRunResponse),
  nextCursor: Schema.optional(Cursor),
});

export const FireHeartbeatResponse = Schema.Struct({
  duplicate: Schema.Boolean,
  heartbeatRun: HeartbeatRunResponse,
  run: Schema.optional(AutomationRunResponse),
});

export const RuntimeResourceResponse = Schema.Union([
  ThreadResponse,
  MessageResponse,
  MessagePublicationResponse,
  RunResponse,
  ApprovalResponse,
  ToolCallResponse,
  CallbackDispatchEvidenceResponse,
  ArtifactResponse,
  ArtifactAccessUrlResponse,
  ScheduleResponse,
  HeartbeatResponse,
  ScheduleFireResponse,
  HeartbeatRunResponse,
  SubmitAgentRunResponse,
  CreateThreadStreamSessionResponse,
  ResolveApprovalResponse,
  ResolveToolResultResponse,
  FireScheduleResponse,
  FireHeartbeatResponse,
  ChannelBindingResponse,
  ChannelDeliveryResponse,
  ComposeChannelDeliveryResponse,
  VerifyChannelBindingResponse,
  CreateWebhookResponse,
  RotateWebhookSecretResponse,
  TestWebhookResponse,
  WebhookResponse,
  WebhookDeliveryResponse,
]);
export const RuntimePageResponse = Schema.Union([
  ListRunsResponse,
  ListThreadsResponse,
  ListApprovalsResponse,
  ListToolCallsResponse,
  ListWebhooksResponse,
  ListWebhookDeliveriesResponse,
  ListWebhookDeliveryAttemptsResponse,
  ListChannelBindingsResponse,
  ListChannelDeliveriesResponse,
  ListThreadMessagesResponse,
  ListSchedulesResponse,
  ListScheduleFiresResponse,
  ListHeartbeatsResponse,
  ListHeartbeatFiresResponse,
]);
/** Catch-up and long-poll reads return the JSON array of thread stream events after `offset`. */
export const RuntimeStreamResponse = Schema.Array(JsonValue);
export const RuntimeTimestamp = Timestamp;

export type ToolCallResponse = typeof ToolCallResponse.Type;
export type CallbackDispatchEvidenceResponse = typeof CallbackDispatchEvidenceResponse.Type;
export type ArtifactInputFileResponse = typeof ArtifactInputFileResponse.Type;
export type ArtifactResponse = typeof ArtifactResponse.Type;
export type ArtifactAccessUrlResponse = typeof ArtifactAccessUrlResponse.Type;
export type CreateArtifactUploadResponse = typeof CreateArtifactUploadResponse.Type;
export type ListArtifactsResponse = typeof ListArtifactsResponse.Type;
export type ChannelBindingResponse = typeof ChannelBindingResponse.Type;
export type ChannelDeliveryResponse = typeof ChannelDeliveryResponse.Type;
export type ComposeChannelDeliveryResponse = typeof ComposeChannelDeliveryResponse.Type;
export type VerifyChannelBindingResponse = typeof VerifyChannelBindingResponse.Type;
export type ScheduleResponse = typeof ScheduleResponse.Type;
export type HeartbeatResponse = typeof HeartbeatResponse.Type;
export type ScheduleFireResponse = typeof ScheduleFireResponse.Type;
export type HeartbeatRunResponse = typeof HeartbeatRunResponse.Type;
export type AutomationRunResponse = typeof AutomationRunResponse.Type;
export type SubmitAgentRunResponse = typeof SubmitAgentRunResponse.Type;
export type ListThreadMessagesResponse = typeof ListThreadMessagesResponse.Type;
export type ListRunsResponse = typeof ListRunsResponse.Type;
export type ListThreadsResponse = typeof ListThreadsResponse.Type;
export type ListApprovalsResponse = typeof ListApprovalsResponse.Type;
export type ListToolCallsResponse = typeof ListToolCallsResponse.Type;
export type ListChannelBindingsResponse = typeof ListChannelBindingsResponse.Type;
export type ListChannelDeliveriesResponse = typeof ListChannelDeliveriesResponse.Type;
export type RuntimeStreamSession = typeof RuntimeStreamSession.Type;
export type CreateThreadStreamSessionResponse = typeof CreateThreadStreamSessionResponse.Type;
export type ResolveApprovalResponse = typeof ResolveApprovalResponse.Type;
export type ResolveToolResultResponse = typeof ResolveToolResultResponse.Type;
export type ListSchedulesResponse = typeof ListSchedulesResponse.Type;
export type ListScheduleFiresResponse = typeof ListScheduleFiresResponse.Type;
export type FireScheduleResponse = typeof FireScheduleResponse.Type;
export type ListHeartbeatsResponse = typeof ListHeartbeatsResponse.Type;
export type ListHeartbeatFiresResponse = typeof ListHeartbeatFiresResponse.Type;
export type FireHeartbeatResponse = typeof FireHeartbeatResponse.Type;

export const RUNTIME_API_SCHEMAS = {
  ...CONVERSATION_ERASURE_API_SCHEMAS,
  ...RUNTIME_LOG_API_SCHEMAS,
  ApprovalResponse,
  CallbackDispatchEvidenceResponse,
  ArtifactAccessUrlResponse,
  ArtifactResponse,
  AutomationRunResponse,
  ChannelBindingResponse,
  ChannelDeliveryResponse,
  ComposeChannelDeliveryResponse,
  CreateArtifactAccessUrlRequest,
  CreateArtifactUploadResponse,
  ComposeChannelDeliveryRequest,
  CreateChannelBindingRequest,
  CreateArtifactUploadRequest,
  CreateHeartbeatRequest,
  CreateThreadStreamSessionResponse,
  CreateScheduleRequest,
  CreateThreadRequest,
  CreateWebhookSubscriptionRequest,
  DeleteChannelBindingCredentialRequest,
  PutChannelBindingCredentialRequest,
  FireAutomationRequest,
  FireHeartbeatResponse,
  FireHeartbeatRequest,
  FireScheduleResponse,
  HeartbeatConfiguration,
  HeartbeatResponse,
  HeartbeatRunResponse,
  ListChannelBindingsResponse,
  ListChannelDeliveriesResponse,
  ListHeartbeatFiresResponse,
  ListHeartbeatsResponse,
  ListApprovalsResponse,
  ListArtifactsResponse,
  ListRunsResponse,
  ListSchedulesResponse,
  ListScheduleFiresResponse,
  ListThreadMessagesResponse,
  ListThreadsResponse,
  ListToolCallsResponse,
  MessageResponse,
  MessagePublicationResponse,
  PublishRunMessageRequest,
  ResolveApprovalRequest,
  ResolveApprovalResponse,
  ResolveToolResultRequest,
  ResolveToolResultResponse,
  RunAutomation,
  RunResponse,
  RuntimeIdempotencyKey,
  RuntimeListQuery,
  RuntimePageResponse,
  RuntimeResourceResponse,
  RuntimeStreamReplayState,
  RuntimeStreamSession,
  RuntimeStreamResponse,
  RuntimeTimestamp,
  ScheduleConfiguration,
  ScheduleCreatedFrom,
  ScheduleFireResponse,
  ScheduleResponse,
  SearchRunsRequest,
  SubmitAgentRunRequest,
  SubmitAgentRunResponse,
  ThreadResponse,
  ToolCallResponse,
  UpdateChannelBindingRequest,
  UpdateHeartbeatRequest,
  UpdateScheduleRequest,
  VerifyChannelBindingResponse,
  ...WEBHOOK_API_SCHEMAS,
  UpdateArtifactRetentionRequest,
  CancelWorkflowExecutionRequest,
  ListWorkflowExecutionsResponse,
  ListWorkflowStepAttemptsResponse,
  ResolveWorkflowApprovalRequest,
  StartWorkflowExecutionRequest,
  WorkflowApprovalResponse,
  WorkflowExecutionResponse,
  WorkflowStepAttemptResponse,
  CreatePreviewRequest,
  PreviewResponse,
  SubmitPreviewTurnRequest,
} as const;

export type RuntimeApiSchemaName = keyof typeof RUNTIME_API_SCHEMAS;

export type RuntimeApiRouteContract = PublicApiRouteContract & {
  readonly idempotent?: true;
  readonly requestBody?: RuntimeApiSchemaName;
  readonly responseBody: RuntimeApiSchemaName;
} & (
    | {
        readonly authentication: "api-credential-or-platform-bearer";
        readonly requiredScope: string;
      }
    | {
        readonly authentication: "stream-session";
        readonly requiredPermission: "append" | "read";
      }
  );
