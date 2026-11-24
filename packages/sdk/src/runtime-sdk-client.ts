import type { JsonValue } from "@deployments-ai/api-contract/primitives";
import type {
  ListWorkflowExecutionsResponse,
  ListWorkflowStepAttemptsResponse,
  WorkflowApprovalResponse,
  WorkflowExecutionResponse,
} from "@deployments-ai/api-contract";
import type {
  ApprovalResponse,
  ArtifactAccessUrlResponse,
  ArtifactResponse,
  ChannelBindingResponse,
  ChannelDeliveryResponse,
  ComposeChannelDeliveryResponse,
  CreateArtifactUploadResponse,
  ConversationErasureResponse,
  CreateEndUserErasureRequest,
  CreateThreadStreamSessionResponse,
  CreateWebhookResponse,
  FireHeartbeatResponse,
  FireScheduleResponse,
  HeartbeatResponse,
  ListApprovalsResponse,
  ListArtifactsResponse,
  ListChannelBindingsResponse,
  ListChannelDeliveriesResponse,
  ListHeartbeatFiresResponse,
  ListHeartbeatsResponse,
  ListRunsResponse,
  ListScheduleFiresResponse,
  ListSchedulesResponse,
  ListThreadMessagesResponse,
  ListThreadsResponse,
  ListToolCallsResponse,
  MessageResponse,
  MessagePublicationResponse,
  ListWebhookDeliveriesResponse,
  ListWebhookDeliveryAttemptsResponse,
  ListWebhooksResponse,
  ResolveApprovalResponse,
  ResolveToolResultResponse,
  RotateWebhookSecretResponse,
  RunResponse,
  ScheduleResponse,
  SubmitAgentRunResponse,
  ThreadResponse,
  TestWebhookResponse,
  VerifyChannelBindingResponse,
  WebhookDeliveryResponse,
  WebhookResponse,
} from "@deployments-ai/api-contract/runtime";
import type { PlatformContext, PlatformResponse, PlatformStreamPage } from "./index.ts";
import type { UploadArtifactBytesInput } from "./runtime-sdk-artifact-upload.ts";
import type { RuntimePreviewsSdk } from "./runtime-sdk-previews.ts";
import type { RuntimeWebhookDeliveriesSdk, RuntimeWebhooksSdk } from "./runtime-sdk-webhooks.ts";
import { PlatformRequestError } from "./index.ts";

export type RuntimeContext = PlatformContext;
export interface RuntimeMutationOptions {
  readonly idempotencyKey: string;
}
export interface RuntimeListOptions {
  readonly cursor?: string;
  readonly limit?: number;
}
export interface RuntimeErasureWaitOptions {
  /** Delay between polls; defaults to 2000 ms. */
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
  /** Give up after this long; defaults to 10 minutes. */
  readonly timeoutMs?: number;
}
export type RuntimeWorkflowExecutionStatus =
  | "queued"
  | "running"
  | "waiting-for-agent"
  | "waiting-for-tool"
  | "waiting-for-approval"
  | "waiting-for-delivery"
  | "completed"
  | "failed"
  | "canceling"
  | "canceled";
export interface RuntimeWorkflowExecutionListOptions extends RuntimeListOptions {
  readonly status?: RuntimeWorkflowExecutionStatus;
}
export interface StartWorkflowExecutionInput {
  readonly input?: Readonly<Record<string, JsonValue>>;
  readonly workspaceId?: string;
}
export interface CancelWorkflowExecutionInput {
  readonly expectedVersion: number;
}
export interface ResolveWorkflowApprovalInput {
  readonly decision: "approved" | "rejected";
}
export type RuntimeRunStatus =
  | "canceled"
  | "completed"
  | "failed"
  | "queued"
  | "running"
  | "waiting-for-approval"
  | "waiting-for-tool";
export type RuntimeRunExecutionPurpose = "customer" | "evaluation" | "preview";
/** Run filters shared by `runs.list` and `runs.search`; timestamps are inclusive canonical UTC. */
export interface RuntimeRunFilters {
  readonly agentReleaseId?: string;
  readonly createdAfter?: string;
  readonly createdBefore?: string;
  readonly executionPurpose?: RuntimeRunExecutionPurpose;
  readonly status?: RuntimeRunStatus;
  readonly threadId?: string;
}
/**
 * At most one owner filter. With neither, every run in the environment is returned, newest first.
 */
export type RuntimeRunOwnerFilter =
  | { readonly agentDeploymentId?: string; readonly executionBindingId?: never }
  | { readonly agentDeploymentId?: never; readonly executionBindingId?: string };
export type RuntimeRunListOptions = RuntimeListOptions & RuntimeRunFilters & RuntimeRunOwnerFilter;
export interface RuntimeThreadListOptions extends RuntimeListOptions {
  readonly executionBindingId?: string;
}
export type SearchRunsInput = RuntimeRunFilters &
  RuntimeRunOwnerFilter & {
    readonly cursor?: string;
    readonly limit?: number;
  };
export interface SubmitAgentRunInput {
  readonly content: string;
  readonly inputArtifacts?: readonly string[];
  readonly responseFormat?: {
    readonly type: "json_schema";
    readonly name: string;
    readonly schema: Readonly<Record<string, JsonValue>>;
  };
  readonly runContext?: string;
  readonly responsePublication?: "external";
  readonly threadId?: string;
  readonly title?: string;
  readonly workspaceId?: string;
}
export interface PublishRunMessageInput {
  readonly content: string;
}
export interface CreateThreadInput {
  readonly agentDeploymentId: string;
  readonly continueFromThreadId?: string;
  readonly title?: string;
  readonly workspaceId?: string;
}
export interface ResolveApprovalInput {
  readonly decision: "approved" | "rejected";
  readonly threadId: string;
}
export interface RuntimeApprovalListOptions extends RuntimeListOptions {
  readonly status?: "approved" | "expired" | "pending" | "rejected";
}
export interface RuntimeArtifactListOptions extends RuntimeListOptions {
  readonly contentType?: string;
  readonly createdAfter?: string;
  readonly createdBefore?: string;
  readonly runId?: string;
  readonly threadId?: string;
  readonly type?: string;
}
export interface CreateArtifactUploadInput {
  readonly byteSize: number;
  readonly contentType: string;
  readonly fileName: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly name: string;
  readonly retentionExpiresAt?: string;
  readonly runId?: string;
  readonly sha256: string;
  readonly threadId?: string;
  readonly type: string;
  readonly visibility?: "organization" | "private";
}
export interface UpdateArtifactRetentionInput {
  readonly expectedVersion: number;
  readonly retentionExpiresAt: string | null;
}
export interface ResolveToolResultInput {
  /** Required for provider-asynchronous tools; client-executed tools default to the tool call id. */
  readonly externalOperationId?: string;
  readonly outcome: "completed" | "failed";
  /** Structured JSON object (at most 96 KiB); required when a client-executed tool completes. */
  readonly output?: Readonly<Record<string, unknown>>;
  readonly outputSummary?: string;
  readonly threadId: string;
}
export interface CreateScheduleInput {
  readonly agentDeploymentId: string;
  readonly expression: string;
  readonly name: string;
  readonly prompt: string;
  readonly threadId?: string;
  readonly timezone?: string;
  readonly workspaceId?: string;
}
export interface FireScheduleInput {
  readonly fireKey?: string;
}
export interface UpdateScheduleInput {
  readonly expression?: string;
  readonly name?: string;
  readonly prompt?: string;
  readonly timezone?: string | null;
}
export interface CreateHeartbeatInput {
  readonly activeWindow?: {
    readonly daysOfWeek?: readonly number[];
    readonly endMinuteOfDay: number;
    readonly startMinuteOfDay: number;
  };
  readonly agentDeploymentId: string;
  readonly instructions: string;
  readonly intervalMs?: number;
  readonly skipWhenBusy?: boolean;
  readonly threadId?: string;
  readonly timezone?: string;
  readonly workspaceId?: string;
}
export interface FireHeartbeatInput {
  readonly agentDeploymentId: string;
  readonly fireKey?: string;
}
export interface UpdateHeartbeatInput {
  readonly activeWindow?: CreateHeartbeatInput["activeWindow"] | null;
  readonly instructions?: string;
  readonly intervalMs?: number;
  readonly skipWhenBusy?: boolean;
  readonly timezone?: string | null;
}
export interface CreateChannelBindingInput {
  readonly agentDefinitionId: string;
  readonly agentDeploymentId: string;
  readonly channel: "imessage" | "rcs" | "slack" | "sms" | "teams" | "telegram";
  readonly connectionId?: string;
  readonly externalAccountId?: string;
  readonly externalChannelId?: string;
  readonly externalThreadKey?: string;
  readonly externalWorkspaceId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly provider:
    | "aws_end_user_messaging_rcs"
    | "slack_cloudflare_edge"
    | "slack_edge"
    | "teams_bot_framework"
    | "telegram";
  readonly workspaceId?: string;
}
export interface UpdateChannelBindingInput {
  readonly agentDeploymentId?: string | null;
  readonly connectionId?: string | null;
  readonly externalAccountId?: string | null;
  readonly externalChannelId?: string | null;
  readonly externalThreadKey?: string | null;
  readonly externalWorkspaceId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}
export type AwsRcsSuggestedActionInput =
  | { readonly Reply: AwsRcsActionBaseInput }
  | {
      readonly OpenUrl:
        | (AwsRcsActionBaseInput & { readonly Url: string })
        | (AwsRcsActionBaseInput & { readonly Application: "BROWSER"; readonly Url: string })
        | (AwsRcsActionBaseInput & {
            readonly Application: "WEBVIEW";
            readonly Url: string;
            readonly WebviewViewMode?: "FULL" | "HALF" | "TALL";
          });
    }
  | {
      readonly DialPhone: AwsRcsActionBaseInput & { readonly PhoneNumber: string };
    }
  | {
      readonly ShowLocation: AwsRcsActionBaseInput & {
        readonly Label?: string;
        readonly Latitude: number;
        readonly Longitude: number;
      };
    }
  | { readonly RequestLocation: AwsRcsActionBaseInput }
  | {
      readonly CreateCalendarEvent: AwsRcsActionBaseInput & {
        readonly Description?: string;
        readonly EndTime: string;
        readonly StartTime: string;
        readonly Title: string;
      };
    };
export interface AwsRcsActionBaseInput {
  readonly PostbackData: string;
  readonly Text: string;
}
export interface AwsRcsCardContentInput {
  readonly Description?: string;
  readonly Media?: {
    readonly FileUrl: string;
    readonly Height?: "MEDIUM" | "SHORT" | "TALL";
    readonly ThumbnailUrl?: string;
  };
  readonly Suggestions?: readonly AwsRcsSuggestedActionInput[];
  readonly Title?: string;
}
export interface AwsRcsCarouselCardContentInput {
  readonly Description?: string;
  readonly Media?: {
    readonly FileUrl: string;
    readonly Height?: "MEDIUM" | "SHORT";
    readonly ThumbnailUrl?: string;
  };
  readonly Suggestions?: readonly AwsRcsSuggestedActionInput[];
  readonly Title?: string;
}
export type AwsRcsContentInput =
  | { readonly TextMessage: { readonly Body: string } }
  | {
      readonly FileMessage: { readonly FileUrl: string; readonly ThumbnailUrl?: string };
    }
  | {
      readonly RichCard:
        | { readonly CardContent: AwsRcsCardContentInput; readonly CardOrientation: "VERTICAL" }
        | {
            readonly CardContent: AwsRcsCardContentInput;
            readonly CardOrientation: "HORIZONTAL";
            readonly ThumbnailImageAlignment?: "LEFT" | "RIGHT";
          };
    }
  | {
      readonly Carousel: {
        readonly CardContents: readonly AwsRcsCarouselCardContentInput[];
        readonly CardWidth: "MEDIUM" | "SMALL";
      };
    };
export interface AwsRcsMessageInput {
  readonly ConfigurationSetName?: string;
  readonly Context?: Readonly<Record<string, string>>;
  readonly DryRun?: boolean;
  readonly FallbackConfiguration?:
    | {
        readonly Channel: "SMS";
        readonly MessageBody: string;
      }
    | {
        readonly Channel: "MMS";
        readonly MediaUrls?: readonly string[];
        readonly MessageBody: string;
      }
    | {
        readonly Channel: "MMS";
        readonly MediaUrls: readonly string[];
        readonly MessageBody?: string;
      };
  readonly MaxPrice?: string;
  readonly MessageFeedbackEnabled?: boolean;
  readonly MessageTrafficType?:
    | "ACKNOWLEDGEMENT"
    | "AUTHENTICATION"
    | "PROMOTION"
    | "SERVICE_REQUEST"
    | "TRANSACTION";
  readonly ProtectConfigurationId?: string;
  readonly RcsMessageContent?: {
    readonly Content: AwsRcsContentInput;
    readonly Suggestions?: readonly AwsRcsSuggestedActionInput[];
  };
  readonly TimeToLive?: number;
}
export interface ComposeChannelDeliveryInput {
  readonly content: string;
  readonly externalChannelId?: string;
  readonly externalThreadKey: string;
  readonly rcsMessage?: AwsRcsMessageInput;
  readonly runId: string;
  readonly threadId: string;
}
export type RuntimeScheduleFireArguments =
  | [input: FireScheduleInput & { readonly fireKey: string }, options?: RuntimeMutationOptions]
  | [input: FireScheduleInput | undefined, options: RuntimeMutationOptions];
export type RuntimeHeartbeatFireArguments =
  | [input: FireHeartbeatInput & { readonly fireKey: string }, options?: RuntimeMutationOptions]
  | [input: FireHeartbeatInput, options: RuntimeMutationOptions];
export type RuntimeStreamSession = CreateThreadStreamSessionResponse;
/** The parts of a stream session that address and authorize reads on the stream gateway. */
export type RuntimeStreamTarget = Pick<RuntimeStreamSession, "accessToken" | "streamUrl">;
export interface RuntimeStreamReadOptions {
  readonly cursor?: string;
  readonly live?: "long-poll";
  readonly offset?: string;
  readonly signal?: AbortSignal;
}
export interface RuntimeStreamEventsOptions {
  readonly cursor?: string;
  /** Offset to read after: `-1` for the beginning, or a page's `nextOffset` to resume. */
  readonly offset: string;
  /** Ends iteration quietly when aborted. */
  readonly signal?: AbortSignal;
}
export type RuntimeResource =
  | SubmitAgentRunResponse
  | ThreadResponse
  | MessagePublicationResponse
  | RunResponse
  | ResolveApprovalResponse
  | ResolveToolResultResponse
  | ApprovalResponse
  | CreateWebhookResponse
  | RotateWebhookSecretResponse
  | TestWebhookResponse
  | WebhookResponse
  | WebhookDeliveryResponse
  | ArtifactResponse
  | ArtifactAccessUrlResponse
  | CreateArtifactUploadResponse
  | ChannelBindingResponse
  | ChannelDeliveryResponse
  | ComposeChannelDeliveryResponse
  | VerifyChannelBindingResponse
  | ScheduleResponse
  | FireScheduleResponse
  | HeartbeatResponse
  | FireHeartbeatResponse
  | WorkflowExecutionResponse
  | WorkflowApprovalResponse;
export type RuntimePage =
  | ListRunsResponse
  | ListArtifactsResponse
  | ListThreadsResponse
  | ListApprovalsResponse
  | ListToolCallsResponse
  | ListWebhooksResponse
  | ListWebhookDeliveriesResponse
  | ListWebhookDeliveryAttemptsResponse
  | ListChannelBindingsResponse
  | ListChannelDeliveriesResponse
  | ListThreadMessagesResponse
  | ListSchedulesResponse
  | ListScheduleFiresResponse
  | ListHeartbeatsResponse
  | ListHeartbeatFiresResponse
  | ListWorkflowExecutionsResponse
  | ListWorkflowStepAttemptsResponse;

export interface RuntimeSdk {
  readonly previews: RuntimePreviewsSdk;
  readonly workflowExecutions: {
    list(
      options?: RuntimeWorkflowExecutionListOptions,
    ): Promise<PlatformResponse<ListWorkflowExecutionsResponse>>;
    start(
      workflowReleaseId: string,
      input: StartWorkflowExecutionInput,
      options: RuntimeMutationOptions,
    ): Promise<PlatformResponse<WorkflowExecutionResponse>>;
    get(workflowExecutionId: string): Promise<PlatformResponse<WorkflowExecutionResponse>>;
    cancel(
      workflowExecutionId: string,
      input: CancelWorkflowExecutionInput,
    ): Promise<PlatformResponse<WorkflowExecutionResponse>>;
    listSteps(
      workflowExecutionId: string,
      options?: RuntimeListOptions,
    ): Promise<PlatformResponse<ListWorkflowStepAttemptsResponse>>;
  };
  readonly workflowApprovals: {
    get(
      workflowExecutionId: string,
      workflowApprovalId: string,
    ): Promise<PlatformResponse<WorkflowApprovalResponse>>;
    resolve(
      workflowExecutionId: string,
      workflowApprovalId: string,
      input: ResolveWorkflowApprovalInput,
    ): Promise<PlatformResponse<WorkflowApprovalResponse>>;
  };
  readonly runs: {
    list(options?: RuntimeRunListOptions): Promise<PlatformResponse<ListRunsResponse>>;
    search(input: SearchRunsInput): Promise<PlatformResponse<ListRunsResponse>>;
    submit(
      agentDeploymentId: string,
      input: SubmitAgentRunInput,
      options: RuntimeMutationOptions,
    ): Promise<PlatformResponse<SubmitAgentRunResponse>>;
    get(threadId: string, runId: string): Promise<PlatformResponse<RunResponse>>;
    /** Reads a run by ID within the caller's environment without its thread. */
    getById(runId: string): Promise<PlatformResponse<RunResponse>>;
    getMessage(threadId: string, runId: string): Promise<PlatformResponse<MessageResponse>>;
    reserveMessagePublication(
      threadId: string,
      runId: string,
      input: PublishRunMessageInput,
      options: RuntimeMutationOptions,
    ): Promise<PlatformResponse<MessagePublicationResponse>>;
    publishMessage(
      threadId: string,
      runId: string,
      input: PublishRunMessageInput,
      options: RuntimeMutationOptions,
    ): Promise<PlatformResponse<MessageResponse>>;
    releaseMessagePublication(
      threadId: string,
      runId: string,
      input: PublishRunMessageInput,
      options: RuntimeMutationOptions,
    ): Promise<PlatformResponse<MessagePublicationResponse>>;
    cancel(runId: string): Promise<PlatformResponse<RunResponse>>;
    retry(runId: string): Promise<PlatformResponse<RunResponse>>;
    replay(runId: string, options: RuntimeMutationOptions): Promise<PlatformResponse<RunResponse>>;
  };
  readonly threads: {
    list(options?: RuntimeThreadListOptions): Promise<PlatformResponse<ListThreadsResponse>>;
    create(input: CreateThreadInput): Promise<PlatformResponse<ThreadResponse>>;
    get(threadId: string): Promise<PlatformResponse<ThreadResponse>>;
    archive(threadId: string): Promise<PlatformResponse<ThreadResponse>>;
    /**
     * Permanently erases the thread and everything derived from it. The thread is gone from the
     * API as soon as this returns; the returned erasure completes asynchronously.
     */
    erase(threadId: string): Promise<PlatformResponse<ConversationErasureResponse>>;
    getErasure(
      threadId: string,
      erasureId: string,
    ): Promise<PlatformResponse<ConversationErasureResponse>>;
    /** Polls the erasure until it completes, fails, or is canceled. */
    waitForErasure(
      threadId: string,
      erasureId: string,
      options?: RuntimeErasureWaitOptions,
    ): Promise<PlatformResponse<ConversationErasureResponse>>;
    listMessages(
      threadId: string,
      options?: RuntimeListOptions,
    ): Promise<PlatformResponse<ListThreadMessagesResponse>>;
    createStreamSession(threadId: string): Promise<PlatformResponse<RuntimeStreamSession>>;
    /** One catch-up or long-poll read of the session's thread stream. */
    readStreamPage<T = unknown>(
      session: RuntimeStreamTarget,
      options?: RuntimeStreamReadOptions,
    ): Promise<PlatformStreamPage<T>>;
    /**
     * Follows the session's thread stream over SSE, yielding a page per Durable Streams control
     * event and reconnecting from the last offset whenever the server ends the connection. Ends
     * after a page reports the stream closed, or when `signal` aborts. An expired session surfaces
     * as a 401 `PlatformApiError` on reconnect.
     */
    streamEvents<T = unknown>(
      session: RuntimeStreamTarget,
      options: RuntimeStreamEventsOptions,
    ): AsyncIterable<PlatformStreamPage<T>>;
  };
  /** Erasure of every thread one of your end users owns, keyed by your own end-user id. */
  readonly endUsers: {
    erase(
      input: CreateEndUserErasureRequest,
    ): Promise<PlatformResponse<ConversationErasureResponse>>;
    getErasure(erasureId: string): Promise<PlatformResponse<ConversationErasureResponse>>;
    /** Polls the erasure until it completes, fails, or is canceled. */
    waitForErasure(
      erasureId: string,
      options?: RuntimeErasureWaitOptions,
    ): Promise<PlatformResponse<ConversationErasureResponse>>;
  };
  readonly approvals: {
    list(options?: RuntimeApprovalListOptions): Promise<PlatformResponse<ListApprovalsResponse>>;
    get(runId: string, approvalId: string): Promise<PlatformResponse<ApprovalResponse>>;
    resolve(
      runId: string,
      approvalId: string,
      input: ResolveApprovalInput,
    ): Promise<PlatformResponse<ResolveApprovalResponse>>;
  };
  readonly toolCalls: {
    list(
      runId: string,
      options?: RuntimeListOptions,
    ): Promise<PlatformResponse<ListToolCallsResponse>>;
    resolve(
      runId: string,
      toolCallId: string,
      input: ResolveToolResultInput,
    ): Promise<PlatformResponse<ResolveToolResultResponse>>;
  };
  readonly webhooks: RuntimeWebhooksSdk;
  readonly webhookDeliveries: RuntimeWebhookDeliveriesSdk;
  readonly artifacts: {
    list(options?: RuntimeArtifactListOptions): Promise<PlatformResponse<ListArtifactsResponse>>;
    createUpload(
      input: CreateArtifactUploadInput,
    ): Promise<PlatformResponse<CreateArtifactUploadResponse>>;
    get(artifactId: string): Promise<PlatformResponse<ArtifactResponse>>;
    completeUpload(artifactId: string): Promise<PlatformResponse<ArtifactResponse>>;
    uploadBytes(input: UploadArtifactBytesInput): Promise<PlatformResponse<ArtifactResponse>>;
    updateRetention(
      artifactId: string,
      input: UpdateArtifactRetentionInput,
    ): Promise<PlatformResponse<ArtifactResponse>>;
    createAccessUrl(
      artifactId: string,
      input?: {
        readonly disposition?: "attachment" | "inline";
        readonly expiresInSeconds?: number;
      },
    ): Promise<PlatformResponse<ArtifactAccessUrlResponse>>;
    delete(artifactId: string): Promise<PlatformResponse<ArtifactResponse>>;
  };
  readonly channelBindings: {
    list(options?: RuntimeListOptions): Promise<PlatformResponse<ListChannelBindingsResponse>>;
    create(
      input: CreateChannelBindingInput,
      options: RuntimeMutationOptions,
    ): Promise<PlatformResponse<ChannelBindingResponse>>;
    get(bindingId: string): Promise<PlatformResponse<ChannelBindingResponse>>;
    update(
      bindingId: string,
      input: UpdateChannelBindingInput,
    ): Promise<PlatformResponse<ChannelBindingResponse>>;
    archive(bindingId: string): Promise<PlatformResponse<ChannelBindingResponse>>;
    verify(bindingId: string): Promise<PlatformResponse<VerifyChannelBindingResponse>>;
    composeDelivery(
      bindingId: string,
      input: ComposeChannelDeliveryInput,
      options: RuntimeMutationOptions,
    ): Promise<PlatformResponse<ComposeChannelDeliveryResponse>>;
  };
  readonly channelDeliveries: {
    list(options?: RuntimeListOptions): Promise<PlatformResponse<ListChannelDeliveriesResponse>>;
    get(runId: string, deliveryId: string): Promise<PlatformResponse<ChannelDeliveryResponse>>;
  };
  readonly schedules: {
    list(options?: RuntimeListOptions): Promise<PlatformResponse<ListSchedulesResponse>>;
    create(
      input: CreateScheduleInput,
      options: RuntimeMutationOptions,
    ): Promise<PlatformResponse<ScheduleResponse>>;
    get(scheduleId: string): Promise<PlatformResponse<ScheduleResponse>>;
    update(
      scheduleId: string,
      input: UpdateScheduleInput,
    ): Promise<PlatformResponse<ScheduleResponse>>;
    pause(scheduleId: string): Promise<PlatformResponse<ScheduleResponse>>;
    resume(scheduleId: string): Promise<PlatformResponse<ScheduleResponse>>;
    archive(scheduleId: string): Promise<PlatformResponse<ScheduleResponse>>;
    listFires(
      scheduleId: string,
      options?: RuntimeListOptions,
    ): Promise<PlatformResponse<ListScheduleFiresResponse>>;
    fire(
      scheduleId: string,
      ...args: RuntimeScheduleFireArguments
    ): Promise<PlatformResponse<FireScheduleResponse>>;
  };
  readonly heartbeats: {
    list(options?: RuntimeListOptions): Promise<PlatformResponse<ListHeartbeatsResponse>>;
    create(
      input: CreateHeartbeatInput,
      options: RuntimeMutationOptions,
    ): Promise<PlatformResponse<HeartbeatResponse>>;
    get(heartbeatId: string): Promise<PlatformResponse<HeartbeatResponse>>;
    update(
      heartbeatId: string,
      input: UpdateHeartbeatInput,
    ): Promise<PlatformResponse<HeartbeatResponse>>;
    pause(heartbeatId: string): Promise<PlatformResponse<HeartbeatResponse>>;
    resume(heartbeatId: string): Promise<PlatformResponse<HeartbeatResponse>>;
    archive(heartbeatId: string): Promise<PlatformResponse<HeartbeatResponse>>;
    listFires(
      heartbeatId: string,
      options?: RuntimeListOptions,
    ): Promise<PlatformResponse<ListHeartbeatFiresResponse>>;
    fire(
      heartbeatId: string,
      ...args: RuntimeHeartbeatFireArguments
    ): Promise<PlatformResponse<FireHeartbeatResponse>>;
  };
}

export function segment(value: string) {
  return encodeURIComponent(value);
}

export function validatedIdempotencyKey(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    new TextEncoder().encode(value).byteLength > 256 ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new PlatformRequestError(
      `${label} requires a non-empty idempotency key of at most 256 UTF-8 bytes without surrounding whitespace or control characters.`,
    );
  }
  return value;
}

export function mutation(options: RuntimeMutationOptions | undefined, label: string) {
  return { idempotencyKey: validatedIdempotencyKey(options?.idempotencyKey, label) };
}

export function fireMutation(
  input: { readonly fireKey?: string } | undefined,
  options: RuntimeMutationOptions | undefined,
  label: string,
) {
  if (options !== undefined) return mutation(options, label);
  validatedIdempotencyKey(input?.fireKey, `${label} fireKey`);
  return {};
}
