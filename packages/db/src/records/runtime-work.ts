import { Schema } from "effect";
import { TraceId } from "@deployments-ai/observability";
import { Ulid } from "../ids.ts";
import {
  ExecutionPurpose,
  hasConsistentExecutionPins,
  type BoundExecutionPins,
  type CustomerExecutionPins,
  type WithExecutionPins,
} from "./execution-bindings.ts";
import {
  ActorReference,
  BlobReference,
  DynamoKmsCredentialReference,
  DynamoValue,
  Metadata,
  NonEmptyString,
  NonNegativeSafeInteger,
  SecretReference,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  stateVersionFields,
  tenantScopeFields,
  workspaceScopeFields,
} from "../record-schema.ts";

export const ScheduleFireRecord = makeRecordSchema("schedule-fire", {
  ...tenantScopeFields,
  createdAt: Timestamp,
  fireKey: Schema.String,
  firedAt: Timestamp,
  id: Ulid,
  runId: Schema.optional(Ulid),
  scheduleId: Ulid,
  scheduleVersion: Schema.optional(NonNegativeSafeInteger),
  status: Schema.Literals(["accepted", "duplicate", "failed"]),
  threadId: Schema.optional(Ulid),
});

export const HeartbeatRecord = makeRecordSchema("heartbeat", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  activeWindow: Schema.optional(Metadata),
  agentDeploymentId: Ulid,
  createdBy: Schema.optional(ActorReference),
  id: Ulid,
  lastRunAt: Schema.optional(Schema.String),
  nextRunAt: Schema.optional(Schema.String),
  schedule: Metadata,
  status: Schema.Literals(["active", "archived", "disabled", "paused", "provisioning"]),
  threadId: Schema.optional(Ulid),
});

export const HeartbeatRunRecord = makeRecordSchema("heartbeat-run", {
  ...stateVersionFields,
  ...tenantScopeFields,
  completedAt: Schema.optional(Schema.String),
  createdAt: Timestamp,
  heartbeatId: Ulid,
  id: Ulid,
  responseKind: Schema.optional(Schema.String),
  runId: Schema.optional(Ulid),
  skipReason: Schema.optional(Schema.String),
  status: Schema.Literals(["accepted", "skipped"]),
  threadId: Schema.optional(Ulid),
});

export const ChannelDeliveryRecord = makeRecordSchema("channel-delivery", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  attempts: Schema.Number,
  bindingId: Schema.optional(Ulid),
  channel: Schema.String,
  contentPreview: Schema.String,
  credentialRef: Schema.optional(SecretReference),
  deliveryMode: Schema.optional(
    Schema.Literals(["slack-stream-fallback", "teams-stream-fallback"]),
  ),
  slackStreamRunClaimedAt: Schema.optional(Timestamp),
  teamsStreamRunClaimedAt: Schema.optional(Timestamp),
  externalThreadKey: Schema.String,
  failedAt: Schema.optional(Schema.String),
  id: Ulid,
  idempotencyKey: Schema.String,
  lastError: Schema.optional(Schema.String),
  provider: Schema.String,
  providerMessageId: Schema.optional(Schema.String),
  providerPayload: Schema.optional(DynamoValue),
  publicationContent: Schema.optional(Schema.String),
  responsePublication: Schema.optional(Schema.Literal("external")),
  requestHash: Schema.optional(Schema.String),
  runId: Ulid,
  sentAt: Schema.optional(Schema.String),
  sourceMessageId: Schema.optional(Ulid),
  sourceMessageSequence: Schema.optional(NonNegativeSafeInteger),
  status: Schema.Literals(["failed", "queued", "sending", "sent"]),
  threadId: Ulid,
  routeId: Schema.optional(NonEmptyString),
  throughSequence: Schema.optional(NonNegativeSafeInteger),
});

export const ChannelDeliveryLookupRecord = makeRecordSchema("channel-delivery-lookup", {
  ...tenantScopeFields,
  createdAt: Timestamp,
  deliveryId: Ulid,
  idempotencyKey: Schema.String,
  runId: Ulid,
  threadId: Ulid,
});

export const SlackAgentStreamRecord = makeRecordSchema("slack-agent-stream", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  agentDeploymentId: Ulid,
  bindingId: Ulid,
  bindingVersion: NonNegativeSafeInteger,
  channelId: NonEmptyString,
  credentialRef: DynamoKmsCredentialReference,
  fallbackAllowed: Schema.Boolean,
  fallbackDeliveryId: Schema.optional(Ulid),
  id: Ulid,
  lastError: Schema.optional(Schema.String),
  recipientTeamId: NonEmptyString,
  recipientUserId: NonEmptyString,
  runAttempt: NonNegativeSafeInteger,
  runClaimedAt: Timestamp,
  runExecutionVersion: NonNegativeSafeInteger,
  runId: Ulid,
  status: Schema.Literals(["starting", "streaming", "paused", "stopped", "failed"]),
  streamTs: Schema.optional(NonEmptyString),
  threadId: Ulid,
  threadTs: NonEmptyString,
});

export const TeamsAgentStreamRecord = makeRecordSchema("teams-agent-stream", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  agentDeploymentId: Ulid,
  bindingId: Ulid,
  bindingVersion: NonNegativeSafeInteger,
  conversationId: NonEmptyString,
  credentialRef: DynamoKmsCredentialReference,
  fallbackAllowed: Schema.Boolean,
  fallbackDeliveryId: Schema.optional(Ulid),
  id: Ulid,
  lastError: Schema.optional(Schema.String),
  recipientId: NonEmptyString,
  runAttempt: NonNegativeSafeInteger,
  runClaimedAt: Timestamp,
  runExecutionVersion: NonNegativeSafeInteger,
  runId: Ulid,
  serviceUrl: NonEmptyString,
  status: Schema.Literals(["starting", "streaming", "paused", "stopped", "failed"]),
  streamId: Schema.optional(NonEmptyString),
  streamStartedAt: Schema.optional(Timestamp),
  tenantId: NonEmptyString,
  threadId: Ulid,
});

const AgentPlanText = NonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter<string>((input) =>
      Array.from(input).length <= 256
        ? undefined
        : "Agent plan text supports at most 256 characters.",
    ),
  ),
);

const AgentPlanRevision = NonNegativeSafeInteger.pipe(
  Schema.check(
    Schema.isGreaterThanOrEqualTo(1, { message: "Agent plan revisions must start at 1." }),
  ),
);

const AgentPlanTask = Schema.Struct({
  details: Schema.optional(AgentPlanText),
  id: AgentPlanText,
  order: NonNegativeSafeInteger,
  status: Schema.Literals(["completed", "failed", "in_progress", "pending", "skipped"]),
  title: AgentPlanText,
});

const AgentPlanTasks = Schema.Array(AgentPlanTask).pipe(
  Schema.check(
    Schema.isMinLength(1, { message: "Agent plans require at least one task." }),
    Schema.isMaxLength(16, { message: "Agent plans support at most 16 tasks." }),
    Schema.makeFilter<readonly (typeof AgentPlanTask.Type)[]>((tasks) => {
      if (new Set(tasks.map((task) => task.id)).size !== tasks.length) {
        return "Agent plan task IDs must be unique.";
      }
      return new Set(tasks.map((task) => task.order)).size === tasks.length
        ? undefined
        : "Agent plan task order values must be unique.";
    }),
  ),
);

const AgentRunPlanRecordBase = makeRecordSchema("agent-run-plan", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  agentDeploymentId: Schema.optional(Ulid),
  executionBindingId: Schema.optional(Ulid),
  executionPurpose: Schema.optional(ExecutionPurpose),
  id: Ulid,
  planRevision: AgentPlanRevision,
  runAttempt: NonNegativeSafeInteger,
  runClaimedAt: Timestamp,
  runExecutionVersion: NonNegativeSafeInteger,
  runId: Ulid,
  tasks: AgentPlanTasks,
  threadId: Ulid,
  title: AgentPlanText,
  traceId: TraceId,
});

export type AgentRunPlanRecord = WithExecutionPins<
  typeof AgentRunPlanRecordBase.Type,
  CustomerExecutionPins,
  BoundExecutionPins
>;

export const AgentRunPlanRecord = AgentRunPlanRecordBase.pipe(
  Schema.refine((record): record is AgentRunPlanRecord => hasConsistentExecutionPins(record.data), {
    identifier: "AgentRunPlanExecutionPins",
    message: "Agent run plans carry exactly the execution pins of their run.",
  }),
);

export const ImageJobRecord = makeRecordSchema("image-job", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  completion: Schema.optional(Metadata),
  externalOperationId: Schema.optional(Schema.String),
  id: Ulid,
  request: Metadata,
  runId: Schema.optional(Ulid),
  status: Schema.Literals(["failed", "queued", "running", "succeeded"]),
  threadId: Schema.optional(Ulid),
  toolCallId: Schema.optional(Ulid),
});

export const PdfJobRecord = makeRecordSchema("pdf-job", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  artifact: Schema.optional(BlobReference),
  error: Schema.optional(Schema.String),
  externalOperationId: Schema.optional(Schema.String),
  id: Ulid,
  request: Metadata,
  runId: Ulid,
  status: Schema.Literals(["failed", "queued", "running", "succeeded"]),
  threadId: Ulid,
  toolCallId: Ulid,
});
