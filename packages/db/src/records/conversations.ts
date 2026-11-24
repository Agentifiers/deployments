import { Schema } from "effect";
import {
  AgentInputArtifacts,
  AgentResponseFormat,
  INPUT_FILE_OMISSION_REASONS,
  MAX_INPUT_ARTIFACTS,
} from "@deployments-ai/agent-manifest";
import {
  CaptureMode,
  OBSERVABILITY_REDACTION_POLICY_VERSION,
  OBSERVABILITY_SCHEMA_VERSION,
  SpanId,
  TraceId,
} from "@deployments-ai/observability";
import { Ulid } from "../ids.ts";
import {
  ExecutionPurpose,
  hasConsistentExecutionPins,
  type BoundExecutionPins,
  type CustomerExecutionPins,
  type WithExecutionPins,
} from "./execution-bindings.ts";
import { EndUserKey } from "./conversation-erasure.ts";
import {
  ActorReference,
  BlobReference,
  Metadata,
  NonEmptyString,
  NonNegativeSafeInteger,
  ObservabilitySourceContext,
  QueuePriority,
  StringList,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  stateVersionFields,
  tenantScopeFields,
  workspaceScopeFields,
} from "../record-schema.ts";

const ThreadRecordBase = makeRecordSchema("thread", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  agentDeploymentId: Schema.optional(Ulid),
  archived: Schema.Boolean,
  channel: Schema.String,
  continuedFromThreadId: Schema.optional(Ulid),
  createdBy: ActorReference,
  endUserKey: Schema.optional(EndUserKey),
  executionBindingId: Schema.optional(Ulid),
  executionPurpose: Schema.optional(ExecutionPurpose),
  externalThreadKey: Schema.optional(Schema.String),
  id: Ulid,
  pinned: Schema.Boolean,
  pinnedAgentReleaseId: Schema.optional(Ulid),
  streamId: Ulid,
  title: Schema.String,
});

/** Customer threads pin a deployment; preview/evaluation threads pin an execution binding. */
export type ThreadRecord = WithExecutionPins<
  typeof ThreadRecordBase.Type,
  CustomerExecutionPins,
  BoundExecutionPins
>;

export const ThreadRecord = ThreadRecordBase.pipe(
  Schema.refine((record): record is ThreadRecord => hasConsistentExecutionPins(record.data), {
    identifier: "ThreadExecutionPins",
    message:
      "Customer threads require only agentDeploymentId; preview and evaluation threads require only executionBindingId.",
  }),
);

export const IngressSourceKind = Schema.Literals(["agent-email-binding", "channel-binding"]);
export type IngressSourceKind = typeof IngressSourceKind.Type;

export const IngressSource = Schema.Struct({
  sourceId: Ulid,
  sourceKind: IngressSourceKind,
  type: Schema.Literal("ingress"),
});
export type IngressSource = typeof IngressSource.Type;

export const InboundThreadRouteRecord = makeRecordSchema("inbound-thread-route", {
  ...tenantScopeFields,
  agentDeploymentId: Ulid,
  channel: Schema.optional(Schema.String),
  createdAt: Timestamp,
  externalAccountId: Schema.optional(Schema.String),
  externalChannelId: Schema.optional(Schema.String),
  externalThreadKey: NonEmptyString,
  externalWorkspaceId: Schema.optional(Schema.String),
  ingressRouteId: Schema.optional(NonEmptyString),
  id: NonEmptyString,
  provider: Schema.optional(Schema.String),
  sourceId: Ulid,
  sourceKind: IngressSourceKind,
  threadId: Ulid,
});

const ChannelIngressPendingSource = Schema.Struct({
  acceptedAt: Timestamp,
  attachmentCount: NonNegativeSafeInteger,
  contentBytes: NonNegativeSafeInteger,
  metadataBytes: NonNegativeSafeInteger,
  payloadBytes: NonNegativeSafeInteger,
  receivedAt: Timestamp,
  senderId: NonEmptyString,
  sequence: NonNegativeSafeInteger,
  sourceRecordId: NonEmptyString,
});

export const ChannelIngressBurstHeadRecord = makeRecordSchema("channel-ingress-burst-head", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  activeBurstId: Schema.optional(NonEmptyString),
  dueAt: Schema.optional(Timestamp),
  id: NonEmptyString,
  latestBurstId: Schema.optional(NonEmptyString),
  nextSequence: NonNegativeSafeInteger,
  pending: Schema.Array(ChannelIngressPendingSource),
  route: Metadata,
  routeId: NonEmptyString,
});

export const ChannelIngressSourceRecord = makeRecordSchema(
  "channel-ingress-source",
  {
    ...mutableResourceFields,
    ...tenantScopeFields,
    burstId: Schema.optional(NonEmptyString),
    contentBytes: NonNegativeSafeInteger,
    expiresAt: Timestamp,
    id: NonEmptyString,
    payload: Metadata,
    precedingBurstId: Schema.optional(NonEmptyString),
    receivedAt: Timestamp,
    routeId: NonEmptyString,
    senderId: NonEmptyString,
    sourceFingerprint: NonEmptyString,
    sourceMessageId: NonEmptyString,
    status: Schema.Literals(["prepared", "staged"]),
  },
  { expiresAtField: "expiresAt" },
);

export const ChannelIngressSourceClaimRecord = makeRecordSchema("channel-ingress-source-claim", {
  ...tenantScopeFields,
  burstId: NonEmptyString,
  createdAt: Timestamp,
  id: NonEmptyString,
  routeId: NonEmptyString,
  sourceFingerprint: NonEmptyString,
  sourceMessageId: NonEmptyString,
});

export const ChannelIngressBurstRecord = makeRecordSchema(
  "channel-ingress-burst",
  {
    ...mutableResourceFields,
    ...tenantScopeFields,
    attachmentCount: NonNegativeSafeInteger,
    contentBytes: NonNegativeSafeInteger,
    expiresAt: Timestamp,
    id: NonEmptyString,
    metadataBytes: NonNegativeSafeInteger,
    payloadBytes: NonNegativeSafeInteger,
    payloads: Schema.Array(Metadata),
    precedingBurstId: Schema.optional(NonEmptyString),
    routeId: NonEmptyString,
    sourceMessageIds: StringList,
    sourceRecordIds: StringList,
    status: Schema.Literals(["prepared", "submitted"]),
    submittedAt: Schema.optional(Timestamp),
    throughSequence: NonNegativeSafeInteger,
  },
  { expiresAtField: "expiresAt" },
);

export const MessageSource = Schema.Struct({
  inboxId: Ulid,
  inboxMessageCreatedAt: Timestamp,
  inboxMessageId: Ulid,
  inboxThreadId: Ulid,
  kind: Schema.Literal("agent-email"),
});
export type MessageSource = typeof MessageSource.Type;

export const InputFileOmission = Schema.Struct({
  name: Schema.String.pipe(Schema.check(Schema.isMaxLength(512))),
  reason: Schema.Literals(INPUT_FILE_OMISSION_REASONS),
});
export type InputFileOmission = typeof InputFileOmission.Type;
export const MAX_LISTED_INPUT_OMISSIONS = MAX_INPUT_ARTIFACTS;

export const MessageRecord = makeRecordSchema("message", {
  ...tenantScopeFields,
  agentDeploymentId: Schema.optional(Ulid),
  body: Schema.optional(Schema.String),
  bodyRef: Schema.optional(BlobReference),
  contentHash: Schema.String,
  createdAt: Timestamp,
  id: Ulid,
  inputArtifacts: Schema.optional(AgentInputArtifacts),
  inputOmissions: Schema.optional(
    Schema.Array(InputFileOmission).pipe(
      Schema.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_LISTED_INPUT_OMISSIONS)),
    ),
  ),
  metadata: Schema.optional(Metadata),
  role: Schema.Literals(["assistant", "system", "tool", "user"]),
  runId: Schema.optional(Ulid),
  sequence: NonNegativeSafeInteger,
  source: Schema.optional(MessageSource),
  streamEventId: Schema.optional(Ulid),
  threadId: Ulid,
  unlistedInputOmissions: Schema.optional(
    NonNegativeSafeInteger.check(Schema.isGreaterThanOrEqualTo(1)),
  ),
});

const mailLinkFields = {
  ...tenantScopeFields,
  createdAt: Timestamp,
  inboxId: Ulid,
  inboxMessageId: Ulid,
  inboxThreadId: Ulid,
  messageId: Ulid,
  threadId: Ulid,
};

export const ConversationInboxThreadRecord = makeRecordSchema(
  "conversation-inbox-thread",
  mailLinkFields,
);

export const InboxThreadConversationRecord = makeRecordSchema(
  "inbox-thread-conversation",
  mailLinkFields,
);

export const MessagePublicationRecord = makeRecordSchema("message-publication", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  actor: ActorReference,
  agentDeploymentId: Ulid,
  commandHash: Schema.String,
  committedAt: Schema.optional(Timestamp),
  deliveredContentHash: Schema.String,
  id: Ulid,
  messageId: Ulid,
  messageSequence: NonNegativeSafeInteger,
  publishedAt: Schema.optional(Timestamp),
  releasedAt: Schema.optional(Timestamp),
  runId: Ulid,
  safeContentHash: Schema.String,
  sourceMessageId: Ulid,
  sourceMessageSequence: NonNegativeSafeInteger,
  status: Schema.Literals(["reserved", "committed", "published", "released"]),
  streamEventId: Ulid,
  threadId: Ulid,
});

const ConversationCheckpointRecordBase = makeRecordSchema("conversation-checkpoint", {
  ...tenantScopeFields,
  agentDeploymentId: Schema.optional(Ulid),
  contentHash: Schema.String,
  continuedFromCheckpointId: Schema.optional(Ulid),
  continuedFromThreadId: Schema.optional(Ulid),
  continuedFromThroughSequence: Schema.optional(NonNegativeSafeInteger),
  createdAt: Timestamp,
  executionBindingId: Schema.optional(Ulid),
  executionPurpose: Schema.optional(ExecutionPurpose),
  fromMessageCreatedAt: Schema.optional(Timestamp),
  fromSequence: NonNegativeSafeInteger,
  id: Ulid,
  replacesCheckpointId: Schema.optional(Ulid),
  runId: Ulid,
  sourceMessageCount: NonNegativeSafeInteger,
  summary: Schema.String,
  threadId: Ulid,
  throughMessageCharacterOffset: Schema.optional(NonNegativeSafeInteger),
  throughMessageCreatedAt: Schema.optional(Timestamp),
  throughSequence: NonNegativeSafeInteger,
}).pipe(
  Schema.check(
    Schema.makeFilter((record) => {
      if (
        record.data.fromMessageCreatedAt &&
        record.data.throughMessageCreatedAt &&
        record.data.fromMessageCreatedAt > record.data.throughMessageCreatedAt
      ) {
        return {
          path: ["data", "throughMessageCreatedAt"],
          issue: "throughMessageCreatedAt must not precede fromMessageCreatedAt.",
        };
      }
    }),
  ),
);

/** Checkpoints carry the execution pins of the run that compacted the conversation. */
export type ConversationCheckpointRecord = WithExecutionPins<
  typeof ConversationCheckpointRecordBase.Type,
  CustomerExecutionPins,
  BoundExecutionPins
>;

export const ConversationCheckpointRecord = ConversationCheckpointRecordBase.pipe(
  Schema.refine(
    (record): record is ConversationCheckpointRecord => hasConsistentExecutionPins(record.data),
    {
      identifier: "ConversationCheckpointExecutionPins",
      message: "Conversation checkpoints carry exactly the execution pins of their run.",
    },
  ),
);

export type RunInitiatingCaller =
  | { readonly principalId: Ulid; readonly scopes: readonly string[]; readonly type: "principal" }
  | {
      readonly apiCredentialId: Ulid;
      readonly serviceAccountId: Ulid;
      readonly type: "service-account";
    }
  | IngressSource;

export const RunInitiatingCaller = Schema.Union([
  Schema.Struct({
    principalId: Ulid,
    scopes: StringList,
    type: Schema.Literal("principal"),
  }),
  Schema.Struct({
    apiCredentialId: Ulid,
    serviceAccountId: Ulid,
    type: Schema.Literal("service-account"),
  }),
  IngressSource,
]) as Schema.Codec<RunInitiatingCaller, unknown>;

export const RunStatus = Schema.Literals([
  "canceled",
  "completed",
  "failed",
  "queued",
  "running",
  "waiting-for-approval",
  "waiting-for-tool",
]);
export type RunStatus = typeof RunStatus.Type;

const RunRecordBase = makeRecordSchema("run", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  agentDeploymentId: Schema.optional(Ulid),
  agentReleaseId: Schema.optional(Ulid),
  attempt: Schema.Number,
  captureMode: CaptureMode,
  checkpointCount: Schema.optional(NonNegativeSafeInteger),
  claimedAt: Schema.optional(Schema.String),
  claimedBy: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  error: Schema.optional(Metadata),
  executionBindingId: Schema.optional(Ulid),
  executionPurpose: Schema.optional(ExecutionPurpose),
  executionSlot: Schema.optional(NonNegativeSafeInteger),
  executor: Schema.String,
  heartbeatAt: Schema.optional(Schema.String),
  id: Ulid,
  idempotencyKey: Schema.String,
  initiatingCaller: Schema.optional(RunInitiatingCaller),
  inputArtifacts: Schema.optional(AgentInputArtifacts),
  responseFormat: Schema.optional(AgentResponseFormat),
  priority: QueuePriority,
  redactionPolicyVersion: Schema.Literal(OBSERVABILITY_REDACTION_POLICY_VERSION),
  releaseSelection: Schema.optional(Schema.Literals(["candidate", "primary"])),
  responsePublication: Schema.optional(Schema.Literal("external")),
  runContext: Schema.optional(Schema.String),
  replayedFromRunId: Schema.optional(Ulid),
  replayedFromTraceId: Schema.optional(TraceId),
  sandboxPoolId: Schema.optional(Ulid),
  queuedAt: Schema.optional(Timestamp),
  startedAt: Schema.optional(Schema.String),
  status: RunStatus,
  spanId: SpanId,
  schemaVersion: Schema.Literal(OBSERVABILITY_SCHEMA_VERSION),
  threadId: Ulid,
  traceId: TraceId,
  parentSpanId: Schema.optional(SpanId),
  toolContinuation: Schema.optional(Metadata),
  trigger: Schema.String,
  userMessageId: Schema.optional(Ulid),
  userMessageSequence: Schema.optional(NonNegativeSafeInteger),
});

type RunRecordWithPins = WithExecutionPins<
  typeof RunRecordBase.Type,
  CustomerExecutionPins & { readonly agentReleaseId: Ulid },
  BoundExecutionPins & { readonly agentReleaseId?: Ulid }
>;

export type RunRecord = RunRecordWithPins & {
  readonly data:
    | { readonly inputArtifacts?: undefined }
    | {
        readonly initiatingCaller: RunInitiatingCaller;
        readonly inputArtifacts: typeof AgentInputArtifacts.Type;
        readonly userMessageId: Ulid;
      };
};

export const RunRecord = RunRecordBase.pipe(
  Schema.refine(
    (record): record is RunRecordWithPins =>
      hasConsistentExecutionPins(record.data) &&
      (record.data.agentDeploymentId === undefined || record.data.agentReleaseId !== undefined) &&
      (record.data.executionBindingId === undefined ||
        record.data.responsePublication === undefined),
    {
      identifier: "RunExecutionPins",
      message:
        "Customer runs require agentDeploymentId and agentReleaseId; preview and evaluation runs require executionBindingId and never publish externally.",
    },
  ),
  Schema.refine(
    (record): record is RunRecord =>
      record.data.inputArtifacts === undefined ||
      (record.data.initiatingCaller !== undefined && record.data.userMessageId !== undefined),
    {
      identifier: "RunInputMediaOwnership",
      message: "Runs with input artifacts carry their initiating caller and prompt message.",
    },
  ),
);

export const RunLookupRecord = makeRecordSchema("run-lookup", {
  ...tenantScopeFields,
  createdAt: Timestamp,
  idempotencyKey: Schema.String,
  runId: Ulid,
  threadId: Ulid,
});

export const RunEdgeRecord = makeRecordSchema("run-edge", {
  ...tenantScopeFields,
  childRunId: Ulid,
  childThreadId: Ulid,
  createdAt: Timestamp,
  fromAgentDeploymentId: Ulid,
  id: Ulid,
  kind: Schema.String,
  metadata: Schema.optional(Metadata),
  parentSpanId: SpanId,
  parentRunId: Ulid,
  traceId: TraceId,
  threadId: Ulid,
  toAgentDeploymentId: Ulid,
});

export const TimelineEventRecord = makeRecordSchema("timeline-event", {
  ...tenantScopeFields,
  actor: Schema.optional(ActorReference),
  createdAt: Timestamp,
  data: Schema.optional(Metadata),
  eventType: Schema.String,
  id: Ulid,
  runId: Ulid,
  sequence: NonNegativeSafeInteger,
  threadId: Ulid,
});

const ToolCallRecordBase = makeRecordSchema("tool-call", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  approvalId: Schema.optional(Ulid),
  authorizationFingerprint: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  connectionId: Schema.optional(Ulid),
  /** Digest of the destinations a person approved, for a data boundary's egress approval. */
  destinationsHash: Schema.optional(Schema.String),
  effect: Schema.Literals(["execute", "read", "write"]),
  /** Present only for tool calls executed by the calling client; the worker never runs them. */
  executionType: Schema.optional(Schema.Literal("client")),
  /** Logical deadline for client-executed tool results; enforced by maintenance, not TTL. */
  expiresAt: Schema.optional(Timestamp),
  /** Output JSON Schema snapshotted when a client-executed tool call paused the run. */
  outputSchema: Schema.optional(Metadata),
  externalAccountId: Schema.optional(NonEmptyString),
  externalOperationId: Schema.optional(Schema.String),
  id: Ulid,
  idempotencyKey: Schema.optional(Schema.String),
  input: Schema.optional(Metadata),
  inputHash: Schema.optional(Schema.String),
  inputSummary: Schema.String,
  /** Attempt id of the model invocation attempt whose result requested this tool call. */
  modelAttemptId: Schema.optional(NonEmptyString),
  /** Per-run index of the model generation that requested this tool call. */
  modelCallIndex: Schema.optional(NonNegativeSafeInteger),
  mutationEnvelope: Schema.optional(Metadata),
  observability: Schema.optional(ObservabilitySourceContext),
  output: Schema.optional(Metadata),
  outputSummary: Schema.optional(Schema.String),
  policyAction: Schema.optional(Schema.Literals(["allow", "deny", "require-approval"])),
  policyReason: Schema.optional(Schema.String),
  refreshTransientArtifacts: Schema.optional(Schema.Boolean),
  requiredScopes: StringList,
  runId: Ulid,
  startedAt: Schema.optional(Schema.String),
  status: Schema.Literals(["failed", "pending", "running", "succeeded", "waiting"]),
  toolAdapterId: Schema.optional(Ulid),
  toolName: Schema.String,
  toolPlanFingerprint: Schema.optional(Schema.String),
  threadId: Ulid,
});

/** Model-requested tool calls name both the requesting attempt and generation; others neither. */
export const ToolCallRecord = ToolCallRecordBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof ToolCallRecordBase.Type>((record) =>
      (record.data.modelAttemptId === undefined) === (record.data.modelCallIndex === undefined)
        ? undefined
        : "Tool call modelAttemptId and modelCallIndex must be present together.",
    ),
  ),
);

const ApprovalRecordBase = makeRecordSchema("approval", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  escalatedAt: Schema.optional(Schema.String),
  escalationCount: Schema.Number,
  escalationPolicy: Schema.optional(Metadata),
  executionBindingId: Schema.optional(Ulid),
  executionPurpose: Schema.optional(ExecutionPurpose),
  expiresAt: Schema.optional(Timestamp),
  id: Ulid,
  observability: Schema.optional(ObservabilitySourceContext),
  request: Metadata,
  requestedByAgentDeploymentId: Schema.optional(Ulid),
  resolvedAt: Schema.optional(Schema.String),
  resolvedByPrincipalId: Schema.optional(Ulid),
  runId: Ulid,
  status: Schema.Literals(["approved", "expired", "pending", "rejected"]),
  toolCallId: Schema.optional(Ulid),
  threadId: Ulid,
});

type ApprovalRecordBaseType = typeof ApprovalRecordBase.Type;

/**
 * Customer approvals are requested by a production deployment; preview approvals are requested
 * by the run's execution binding and never name a deployment.
 */
export type ApprovalRecord = Omit<ApprovalRecordBaseType, "data"> & {
  readonly data: Omit<
    ApprovalRecordBaseType["data"],
    "executionBindingId" | "executionPurpose" | "requestedByAgentDeploymentId"
  > &
    (
      | (Omit<CustomerExecutionPins, "agentDeploymentId"> & {
          readonly requestedByAgentDeploymentId: Ulid;
        })
      | (Omit<BoundExecutionPins, "agentDeploymentId"> & {
          readonly requestedByAgentDeploymentId?: undefined;
        })
    );
};

export const ApprovalRecord = ApprovalRecordBase.pipe(
  Schema.refine(
    (record): record is ApprovalRecord =>
      hasConsistentExecutionPins({
        agentDeploymentId: record.data.requestedByAgentDeploymentId,
        executionBindingId: record.data.executionBindingId,
        executionPurpose: record.data.executionPurpose,
      }),
    {
      identifier: "ApprovalExecutionPins",
      message:
        "Customer approvals require only requestedByAgentDeploymentId; preview and evaluation approvals require only executionBindingId.",
    },
  ),
);

export const ApprovalActionTokenRecord = makeRecordSchema(
  "approval-action-token",
  {
    ...stateVersionFields,
    approvalId: Ulid,
    channel: Schema.String,
    createdAt: Timestamp,
    expiresAt: Timestamp,
    id: Ulid,
    organizationId: Ulid,
    status: Schema.Literals(["active", "consumed", "expired", "revoked"]),
    tokenHash: NonEmptyString,
  },
  { expiresAtField: "expiresAt" },
);
