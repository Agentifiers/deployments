import { Schema } from "effect";
import {
  AgentInputArtifacts,
  AgentResponseFormat,
  INPUT_FILE_OMISSION_REASONS,
} from "@deployments-ai/agent-manifest";
import { SpanId, TraceId } from "@deployments-ai/observability/identifier-codecs";
import { AwsRcsMessage } from "./aws-rcs-contracts.ts";
import { EndUserId } from "./conversation-erasure-contracts.ts";
import { Cursor, Metadata, PageLimit, PublicId, Timestamp } from "./primitives.ts";

export * from "./aws-rcs-contracts.ts";

export function trimmedText(label: string, maximumCharacters: number) {
  return Schema.String.pipe(
    Schema.check(
      Schema.isTrimmed({
        message: `${label} must not contain surrounding whitespace.`,
      }),
      Schema.isMinLength(1, { message: `${label} must not be empty.` }),
      Schema.isMaxLength(maximumCharacters, {
        message: `${label} must not exceed ${maximumCharacters} characters.`,
      }),
    ),
  );
}

export const AgentRunContent = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed({
      message: "Agent run content must not contain surrounding whitespace.",
    }),
    Schema.isMinLength(1, { message: "Agent run content must not be empty." }),
    Schema.makeFilter<string>((value) =>
      new TextEncoder().encode(value).byteLength <= 256 * 1024
        ? undefined
        : "Agent run content must not exceed 262144 UTF-8 bytes.",
    ),
  ),
);

export const AgentRunContext = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed({
      message: "Agent run context must not contain surrounding whitespace.",
    }),
    Schema.isMinLength(1, { message: "Agent run context must not be empty." }),
    Schema.makeFilter<string>((value) =>
      new TextEncoder().encode(value).byteLength <= 256 * 1024
        ? undefined
        : "Agent run context must not exceed 262144 UTF-8 bytes.",
    ),
  ),
);

export const RuntimeTimezone = trimmedText("Timezone", 50).pipe(
  Schema.check(
    Schema.makeFilter<string>((value) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
        return undefined;
      } catch {
        return "Timezone must be a valid IANA timezone.";
      }
    }),
  ),
);

export const HeartbeatMinute = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Heartbeat minutes must be integers." }),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(1440),
  ),
);

export const HeartbeatActiveWindow = Schema.Struct({
  daysOfWeek: Schema.optional(
    Schema.Array(
      Schema.Number.pipe(
        Schema.check(
          Schema.isInt(),
          Schema.isGreaterThanOrEqualTo(0),
          Schema.isLessThanOrEqualTo(6),
        ),
      ),
    ).pipe(
      Schema.check(
        Schema.makeFilter<readonly number[]>((days) =>
          days.length <= 7 && new Set(days).size === days.length
            ? undefined
            : "Heartbeat days must contain at most seven unique values.",
        ),
      ),
    ),
  ),
  endMinuteOfDay: HeartbeatMinute,
  startMinuteOfDay: HeartbeatMinute.pipe(Schema.check(Schema.isLessThanOrEqualTo(1439))),
});

export const HeartbeatIntervalMs = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Heartbeat intervals must be integers." }),
    Schema.isGreaterThanOrEqualTo(60_000),
    Schema.isLessThanOrEqualTo(30 * 24 * 60 * 60_000),
    Schema.makeFilter<number>((value) =>
      value % 60_000 === 0 ? undefined : "Heartbeat intervals must use whole minutes.",
    ),
  ),
);

export const SubmitAgentRunRequest = Schema.Struct({
  content: AgentRunContent,
  /** End user the new thread belongs to; refused for an existing thread with another subject. */
  endUserId: Schema.optional(EndUserId),
  inputArtifacts: Schema.optional(AgentInputArtifacts),
  /** Drop the thread's sticky release and select again from the deployment's current releases. */
  rebaseRelease: Schema.optional(Schema.Boolean),
  responseFormat: Schema.optional(AgentResponseFormat),
  responsePublication: Schema.optional(Schema.Literal("external")),
  runContext: Schema.optional(AgentRunContext),
  threadId: Schema.optional(PublicId),
  title: Schema.optional(trimmedText("Title", 120)),
  workspaceId: Schema.optional(PublicId),
});

export const PublishRunMessageRequest = Schema.Struct({
  content: AgentRunContent,
});

export const RuntimeRunStatus = Schema.Literals([
  "canceled",
  "completed",
  "failed",
  "queued",
  "running",
  "waiting-for-approval",
  "waiting-for-tool",
]);

/** Customer runs belong to a deployment; preview and evaluation runs to an execution binding. */
export const ExecutionPurpose = Schema.Literals(["customer", "evaluation", "preview"]);

export interface SearchRunsRequestOwner {
  readonly agentDeploymentId?: string | undefined;
  readonly executionBindingId?: string | undefined;
}

/** Omitting both owners searches every run in the caller's environment, newest first. */
export const SearchRunsRequest = Schema.Struct({
  agentDeploymentId: Schema.optional(PublicId),
  agentReleaseId: Schema.optional(PublicId),
  createdAfter: Schema.optional(Timestamp),
  createdBefore: Schema.optional(Timestamp),
  cursor: Schema.optional(Cursor),
  executionBindingId: Schema.optional(PublicId),
  executionPurpose: Schema.optional(ExecutionPurpose),
  limit: Schema.optional(PageLimit),
  status: Schema.optional(RuntimeRunStatus),
  threadId: Schema.optional(PublicId),
}).pipe(
  Schema.check(
    Schema.makeFilter<SearchRunsRequestOwner>((request) =>
      request.agentDeploymentId !== undefined && request.executionBindingId !== undefined
        ? "Provide at most one of agentDeploymentId or executionBindingId."
        : undefined,
    ),
  ),
);

/** Where a thread created through `POST /v1/threads` was started; channel bindings set their own. */
export const ThreadCreationChannel = Schema.Literals(["api", "console"]);

export const CreateThreadRequest = Schema.Struct({
  agentDeploymentId: PublicId,
  /** Defaults to `api`. The console sends `console` for chats and uploads started there. */
  channel: Schema.optional(ThreadCreationChannel),
  continueFromThreadId: Schema.optional(PublicId),
  /** End user the thread belongs to; a continued thread inherits its source thread's. */
  endUserId: Schema.optional(EndUserId),
  title: Schema.optional(trimmedText("Title", 120)),
  workspaceId: Schema.optional(PublicId),
});

export const WebhookEventTypes = Schema.Array(trimmedText("Webhook event type", 128)).pipe(
  Schema.check(
    Schema.isMinLength(1, {
      message: "At least one webhook event type is required.",
    }),
    Schema.isMaxLength(100, {
      message: "Webhook event types must not exceed 100 entries.",
    }),
    Schema.makeFilter<readonly string[]>((values) =>
      new Set(values).size === values.length
        ? undefined
        : "Webhook event types must contain unique values.",
    ),
  ),
);

export const WebhookResourceFilterIds = Schema.Array(PublicId).pipe(
  Schema.check(
    Schema.isMinLength(1, {
      message: "Webhook resource filters must not be empty.",
    }),
    Schema.isMaxLength(100, {
      message: "Webhook resource filters must not exceed 100 entries.",
    }),
    Schema.makeFilter<readonly string[]>((values) =>
      new Set(values).size === values.length
        ? undefined
        : "Webhook resource filters must contain unique values.",
    ),
  ),
);

export const WebhookResourceFilterTypes = Schema.Array(
  trimmedText("Webhook aggregate type", 128),
).pipe(
  Schema.check(
    Schema.isMinLength(1, {
      message: "Webhook resource filters must not be empty.",
    }),
    Schema.isMaxLength(100, {
      message: "Webhook resource filters must not exceed 100 entries.",
    }),
    Schema.makeFilter<readonly string[]>((values) =>
      new Set(values).size === values.length
        ? undefined
        : "Webhook resource filters must contain unique values.",
    ),
  ),
);

export interface WebhookResourceFilterValues {
  readonly aggregateIds?: readonly string[] | undefined;
  readonly aggregateTypes?: readonly string[] | undefined;
  readonly environmentIds?: readonly string[] | undefined;
  readonly projectIds?: readonly string[] | undefined;
}

export const WebhookResourceFilters = Schema.Struct({
  aggregateIds: Schema.optional(WebhookResourceFilterIds),
  aggregateTypes: Schema.optional(WebhookResourceFilterTypes),
  environmentIds: Schema.optional(WebhookResourceFilterIds),
  projectIds: Schema.optional(WebhookResourceFilterIds),
}).pipe(
  Schema.check(
    Schema.makeFilter<WebhookResourceFilterValues>((filters) => {
      const entryCount = Object.values(filters).reduce(
        (total, values) => total + (values?.length ?? 0),
        0,
      );
      if (entryCount === 0) {
        return "Webhook resource filters must not be empty.";
      }
      if (entryCount > 100) {
        return "Webhook resource filters must not exceed 100 total entries.";
      }
      if (new TextEncoder().encode(JSON.stringify(filters)).byteLength > 32_768) {
        return "Webhook resource filters must not exceed 32768 UTF-8 bytes.";
      }
      return undefined;
    }),
  ),
);

export const CreateWebhookSubscriptionRequest = Schema.Struct({
  eventTypes: WebhookEventTypes,
  name: trimmedText("Webhook name", 120),
  resourceFilters: Schema.optional(WebhookResourceFilters),
  url: trimmedText("Webhook URL", 2_048),
});

export const ResolveApprovalRequest = Schema.Struct({
  decision: Schema.Literals(["approved", "rejected"]),
  threadId: PublicId,
});

export const RuntimeExternalOperationId = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed({
      message: "externalOperationId must not contain surrounding whitespace.",
    }),
    Schema.isMinLength(1, {
      message: "externalOperationId must not be empty.",
    }),
    Schema.makeFilter<string>((value) => {
      const hasControlCharacter = Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0)!;
        return codePoint <= 0x1f || codePoint === 0x7f;
      });
      return !value.startsWith("unknown:") &&
        !hasControlCharacter &&
        new TextEncoder().encode(value).byteLength <= 512
        ? undefined
        : "externalOperationId must contain at most 512 UTF-8 bytes without control characters and must not use the reserved unknown: prefix.";
    }),
  ),
);

/** Largest structured tool result output accepted by the runtime API (UTF-8 JSON bytes). */
export const MAX_TOOL_RESULT_OUTPUT_BYTES = 96 * 1024;

export const ToolResultOutput = Metadata.pipe(
  Schema.check(
    Schema.makeFilter<Readonly<Record<string, unknown>>>((value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_TOOL_RESULT_OUTPUT_BYTES
        ? undefined
        : `Tool result output must be at most ${MAX_TOOL_RESULT_OUTPUT_BYTES} UTF-8 bytes of JSON.`,
    ),
  ),
);

export const ResolveToolResultRequest = Schema.Struct({
  /** Required for provider-asynchronous tools; client-executed tools default to the tool call id. */
  externalOperationId: Schema.optional(RuntimeExternalOperationId),
  outcome: Schema.Literals(["completed", "failed"]),
  /** Structured JSON result; required when a client-executed tool completes. */
  output: Schema.optional(ToolResultOutput),
  outputSummary: Schema.optional(trimmedText("Tool result output summary", 1_000)),
  threadId: PublicId,
});

export const CreateScheduleRequest = Schema.Struct({
  agentDeploymentId: PublicId,
  expression: trimmedText("Schedule expression", 256),
  name: trimmedText("Schedule name", 120),
  prompt: trimmedText("Schedule prompt", 40_000),
  threadId: Schema.optional(PublicId),
  timezone: Schema.optional(RuntimeTimezone),
  workspaceId: Schema.optional(PublicId),
});

export const CreateHeartbeatRequest = Schema.Struct({
  activeWindow: Schema.optional(HeartbeatActiveWindow),
  agentDeploymentId: PublicId,
  instructions: trimmedText("Heartbeat instructions", 32_000),
  intervalMs: Schema.optional(HeartbeatIntervalMs),
  skipWhenBusy: Schema.optional(Schema.Boolean),
  threadId: Schema.optional(PublicId),
  timezone: Schema.optional(RuntimeTimezone),
  workspaceId: Schema.optional(PublicId),
});

export const UpdateScheduleRequest = Schema.Struct({
  expression: Schema.optional(trimmedText("Schedule expression", 256)),
  name: Schema.optional(trimmedText("Schedule name", 120)),
  prompt: Schema.optional(trimmedText("Schedule prompt", 40_000)),
  timezone: Schema.optional(Schema.NullOr(RuntimeTimezone)),
});

export const UpdateHeartbeatRequest = Schema.Struct({
  activeWindow: Schema.optional(Schema.NullOr(HeartbeatActiveWindow)),
  instructions: Schema.optional(trimmedText("Heartbeat instructions", 32_000)),
  intervalMs: Schema.optional(HeartbeatIntervalMs),
  skipWhenBusy: Schema.optional(Schema.Boolean),
  timezone: Schema.optional(Schema.NullOr(RuntimeTimezone)),
});

export const Channel = Schema.Literals(["imessage", "rcs", "slack", "sms", "teams", "telegram"]);
export const ChannelProvider = Schema.Literals([
  "aws_end_user_messaging_rcs",
  "slack_cloudflare_edge",
  "slack_edge",
  "teams_bot_framework",
  "telegram",
]);
export const ChannelMetadata = Schema.Record(Schema.String, Schema.Unknown);

export const CreateChannelBindingRequest = Schema.Struct({
  agentDefinitionId: PublicId,
  agentDeploymentId: PublicId,
  channel: Channel,
  connectionId: Schema.optional(PublicId),
  externalAccountId: Schema.optional(trimmedText("External account ID", 512)),
  externalChannelId: Schema.optional(trimmedText("External channel ID", 512)),
  externalThreadKey: Schema.optional(trimmedText("External thread key", 1_024)),
  externalWorkspaceId: Schema.optional(trimmedText("External workspace ID", 512)),
  metadata: Schema.optional(ChannelMetadata),
  provider: ChannelProvider,
  workspaceId: Schema.optional(PublicId),
});

export const UpdateChannelBindingRequest = Schema.Struct({
  agentDeploymentId: Schema.optional(Schema.NullOr(PublicId)),
  connectionId: Schema.optional(Schema.NullOr(PublicId)),
  externalAccountId: Schema.optional(Schema.NullOr(trimmedText("External account ID", 512))),
  externalChannelId: Schema.optional(Schema.NullOr(trimmedText("External channel ID", 512))),
  externalThreadKey: Schema.optional(Schema.NullOr(trimmedText("External thread key", 1_024))),
  externalWorkspaceId: Schema.optional(Schema.NullOr(trimmedText("External workspace ID", 512))),
  metadata: Schema.optional(Schema.NullOr(ChannelMetadata)),
});

const ChannelBindingCredentialVersion = Schema.Number.pipe(
  Schema.check(
    Schema.makeFilter<number>((value) =>
      Number.isSafeInteger(value) && value >= 0
        ? undefined
        : "expectedVersion must be a non-negative safe integer.",
    ),
  ),
);

export const PutChannelBindingCredentialRequest = Schema.Struct({
  expectedVersion: ChannelBindingCredentialVersion,
  expiresAt: Schema.optional(Timestamp),
  scopes: Schema.optional(Schema.Array(trimmedText("Credential scope", 512))),
  values: Schema.Record(
    Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/u))),
    Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  ).pipe(
    Schema.check(
      Schema.makeFilter<Readonly<Record<string, string>>>((values) =>
        Object.keys(values).length > 0 ? undefined : "At least one credential field is required.",
      ),
    ),
  ),
});

export const DeleteChannelBindingCredentialRequest = Schema.Struct({
  expectedVersion: ChannelBindingCredentialVersion,
});

export const ComposeChannelDeliveryRequest = Schema.Struct({
  content: trimmedText("Channel delivery content", 40_000),
  externalChannelId: Schema.optional(trimmedText("External channel ID", 512)),
  externalThreadKey: trimmedText("External thread key", 1_024),
  rcsMessage: Schema.optional(AwsRcsMessage),
  runId: PublicId,
  threadId: PublicId,
});

export const RuntimeListQuery = Schema.Struct({
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(PageLimit),
});

export const RuntimeIdempotencyKey = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed({
      message: "Runtime idempotency keys must not contain surrounding whitespace.",
    }),
    Schema.isMinLength(1, {
      message: "Runtime idempotency keys must not be empty.",
    }),
    Schema.makeFilter<string>((value) => {
      const hasControlCharacter = Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0)!;
        return codePoint <= 0x1f || codePoint === 0x7f;
      });
      return !hasControlCharacter && new TextEncoder().encode(value).byteLength <= 256
        ? undefined
        : "Runtime idempotency keys must contain at most 256 UTF-8 bytes without control characters.";
    }),
  ),
);

export const FireAutomationRequest = Schema.Struct({
  fireKey: Schema.optional(RuntimeIdempotencyKey),
});

export const FireHeartbeatRequest = Schema.Struct({
  agentDeploymentId: PublicId,
  fireKey: Schema.optional(RuntimeIdempotencyKey),
});

export const RuntimeMutableFields = {
  createdAt: Timestamp,
  updatedAt: Timestamp,
  version: Schema.Number,
} as const;

export const RuntimeTenantFields = {
  environmentId: PublicId,
  organizationId: PublicId,
  projectId: PublicId,
} as const;

export const RuntimeWorkspaceFields = {
  ...RuntimeTenantFields,
  workspaceId: Schema.optional(PublicId),
} as const;

export const RuntimeActor = Schema.Struct({
  id: Schema.optional(PublicId),
  type: Schema.Literals(["agent", "principal", "service-account", "system", "worker"]),
});

export const RuntimeBodyAccess = Schema.Struct({
  byteSize: Schema.Number,
  contentType: Schema.String,
  expiresAt: Timestamp,
  sha256: Schema.String,
  url: Schema.String,
});

export const ThreadResponse = Schema.Struct({
  ...RuntimeMutableFields,
  ...RuntimeWorkspaceFields,
  agentDeploymentId: Schema.optional(PublicId),
  archived: Schema.Boolean,
  channel: Schema.String,
  continuedFromThreadId: Schema.optional(PublicId),
  createdBy: RuntimeActor,
  executionBindingId: Schema.optional(PublicId),
  executionPurpose: ExecutionPurpose,
  externalThreadKey: Schema.optional(Schema.String),
  id: PublicId,
  object: Schema.Literal("thread"),
  pinned: Schema.Boolean,
  /** Release this thread's runs stay on while it remains selectable on the deployment. */
  pinnedAgentReleaseId: Schema.optional(PublicId),
  streamId: PublicId,
  title: Schema.String,
});

export const MessageResponse = Schema.Struct({
  ...RuntimeTenantFields,
  agentDeploymentId: Schema.optional(PublicId),
  body: Schema.optional(Schema.String),
  bodyAccess: Schema.optional(RuntimeBodyAccess),
  contentHash: Schema.String,
  createdAt: Timestamp,
  id: PublicId,
  inputArtifacts: Schema.optional(AgentInputArtifacts),
  /** Files a channel or email message attached that the turn left out, and why. */
  inputOmissions: Schema.optional(
    Schema.Array(
      Schema.Struct({ name: Schema.String, reason: Schema.Literals(INPUT_FILE_OMISSION_REASONS) }),
    ),
  ),
  metadata: Schema.optional(Metadata),
  object: Schema.Literal("message"),
  role: Schema.Literals(["assistant", "system", "tool", "user"]),
  runId: Schema.optional(PublicId),
  sequence: Schema.Number,
  streamEventId: Schema.optional(PublicId),
  threadId: PublicId,
  /** Files left out beyond the ones `inputOmissions` lists. */
  unlistedInputOmissions: Schema.optional(
    Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  ),
});

export const MessagePublicationResponse = Schema.Struct({
  ...RuntimeMutableFields,
  ...RuntimeTenantFields,
  agentDeploymentId: PublicId,
  committedAt: Schema.optional(Timestamp),
  id: PublicId,
  messageId: PublicId,
  messageSequence: Schema.Number,
  object: Schema.Literal("message-publication"),
  publishedAt: Schema.optional(Timestamp),
  releasedAt: Schema.optional(Timestamp),
  runId: PublicId,
  sourceMessageId: PublicId,
  sourceMessageSequence: Schema.Number,
  status: Schema.Literals(["reserved", "committed", "published", "released"]),
  streamEventId: PublicId,
  threadId: PublicId,
});

/** The schedule or heartbeat fire that submitted a run. */
export const RunAutomation = Schema.Struct({
  fireId: PublicId,
  id: PublicId,
  kind: Schema.Literals(["heartbeat", "schedule"]),
});

export const RunResponse = Schema.Struct({
  ...RuntimeMutableFields,
  ...RuntimeWorkspaceFields,
  agentDeploymentId: Schema.optional(PublicId),
  agentReleaseId: Schema.optional(PublicId),
  attempt: Schema.Number,
  automation: Schema.optional(RunAutomation),
  checkpointCount: Schema.Number,
  completedAt: Schema.optional(Timestamp),
  error: Schema.optional(Metadata),
  executionBindingId: Schema.optional(PublicId),
  executionPurpose: ExecutionPurpose,
  executor: Schema.String,
  id: PublicId,
  object: Schema.Literal("run"),
  parentSpanId: Schema.optional(SpanId),
  priority: Schema.Number,
  releaseSelection: Schema.optional(Schema.Literals(["candidate", "primary"])),
  replayedFromRunId: Schema.optional(PublicId),
  replayedFromTraceId: Schema.optional(TraceId),
  spanId: SpanId,
  startedAt: Schema.optional(Timestamp),
  status: Schema.Literals([
    "canceled",
    "completed",
    "failed",
    "queued",
    "running",
    "waiting-for-approval",
    "waiting-for-tool",
  ]),
  threadId: PublicId,
  traceId: TraceId,
  trigger: Schema.String,
});

export const ApprovalResponse = Schema.Struct({
  ...RuntimeMutableFields,
  ...RuntimeTenantFields,
  escalatedAt: Schema.optional(Timestamp),
  escalationCount: Schema.Number,
  escalationPolicy: Schema.optional(Metadata),
  /** Present for preview and evaluation approvals, which a binding requests instead of a deployment. */
  executionBindingId: Schema.optional(PublicId),
  executionPurpose: ExecutionPurpose,
  expiresAt: Schema.optional(Timestamp),
  id: PublicId,
  object: Schema.Literal("approval"),
  request: Metadata,
  /** Present for customer approvals only. */
  requestedByAgentDeploymentId: Schema.optional(PublicId),
  resolvedAt: Schema.optional(Timestamp),
  resolvedByPrincipalId: Schema.optional(PublicId),
  runId: PublicId,
  status: Schema.Literals(["approved", "expired", "pending", "rejected"]),
  toolCallId: Schema.optional(PublicId),
});

export type ThreadResponse = typeof ThreadResponse.Type;
export type MessageResponse = typeof MessageResponse.Type;
export type MessagePublicationResponse = typeof MessagePublicationResponse.Type;
export type RunResponse = typeof RunResponse.Type;
export type ApprovalResponse = typeof ApprovalResponse.Type;
