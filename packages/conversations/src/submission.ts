import {
  agentManifestAllowsTrigger,
  canonicalResponseFormatJson,
  type AgentResponseFormat,
} from "@deployments-ai/agent-manifest";
import {
  Ulid,
  key,
  makeConversationPersistence,
  type ConversationRecordLocator,
  type EndUserKey,
  type DynamoDatabaseService,
  type MessageSource,
  type InputFileOmission,
  type PlatformRecord,
  type TransactionOperation,
  type RunInitiatingCaller,
} from "@deployments-ai/db";
import type { CaptureMode, SpanId, TraceId } from "@deployments-ai/observability";
import { createThreadStreamEvent, type ThreadStreamEvent } from "@deployments-ai/streaming";
import { createHash } from "node:crypto";
import { selectAgentRelease, type AgentReleaseSelectionResult } from "./release-selection.ts";
import type { InputMediaOmission } from "./run-input.ts";

export type ConversationThread = Extract<PlatformRecord, { readonly itemType: "thread" }>;
export type ConversationMessage = Extract<PlatformRecord, { readonly itemType: "message" }>;
export type ConversationRun = Extract<PlatformRecord, { readonly itemType: "run" }>;
export type AgentDeployment = Extract<PlatformRecord, { readonly itemType: "agent-deployment" }>;
export type AgentRelease = Extract<PlatformRecord, { readonly itemType: "agent-release" }>;

export interface ConversationQueueMessage {
  readonly environmentId: Ulid;
  readonly idempotencyKey: string;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly runId: Ulid;
  readonly spanId: SpanId;
  readonly threadId: Ulid;
  readonly traceId: TraceId;
  readonly userMessageId: Ulid;
  readonly userMessageSequence: number;
}

export interface ConversationQueueEnqueueInput {
  readonly deduplicationId: string;
  readonly message: ConversationQueueMessage;
  readonly messageGroupId: string;
}

export type ConversationQueueEnqueue = (
  input: ConversationQueueEnqueueInput,
  signal?: AbortSignal,
) => Promise<void>;

export interface ConversationScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly workspaceId?: Ulid;
}

export interface SubmitConversationTurnInput extends ConversationScope {
  readonly actor: {
    readonly id?: Ulid;
    readonly type: "principal" | "service-account" | "system";
  };
  readonly agentDeploymentId: Ulid;
  /**
   * Pins the run to one selectable release (primary or active canary candidate). Production
   * callers omit it so the deployment selects the release, including canary traffic splits.
   */
  readonly agentReleaseId?: Ulid;
  readonly channel?: string;
  readonly content: string;
  readonly createThreadIfMissing?: boolean;
  readonly endUserKey?: EndUserKey;
  readonly executor?: string;
  readonly externalThreadKey?: string;
  readonly idempotencyKey: string;
  readonly initiatingCaller?: RunInitiatingCaller;
  readonly inputArtifacts?: readonly string[];
  readonly responseFormat?: AgentResponseFormat;
  readonly messageMetadata?: Readonly<Record<string, unknown>>;
  readonly messageSource?: MessageSource;
  readonly priority?: number;
  /** Keep the assistant result provisional until an external delivery is confirmed. */
  readonly responsePublication?: "external";
  /** Durable audit context for this run that is never replayed as conversation history. */
  readonly runContext?: string;
  readonly signal?: AbortSignal;
  /** Drop the thread's sticky release and select again from the current deployment state. */
  readonly rebaseRelease?: boolean;
  readonly skippedInputFiles?: readonly InputFileOmission[];
  readonly threadId?: Ulid;
  readonly title?: string;
  readonly traceContext?: {
    /** The parent's delegate tool call waits for this child's terminal result. */
    readonly awaitResult?: boolean;
    readonly edgeKind?: "approval_followup" | "delegation" | "handoff" | "scheduled_child";
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly parentAgentDeploymentId: Ulid;
    readonly parentRunId: Ulid;
    readonly parentSpanId: SpanId;
    readonly parentThreadId: Ulid;
    readonly traceId: TraceId;
  };
  readonly trigger?: string;
  readonly captureMode?: CaptureMode;
}

export function streamActor(actor: SubmitConversationTurnInput["actor"]) {
  return {
    ...(actor.id ? { id: actor.id } : {}),
    type:
      actor.type === "service-account"
        ? ("service" as const)
        : actor.type === "system"
          ? ("system" as const)
          : ("user" as const),
  };
}

export interface SubmittedConversationTurn {
  readonly message: ConversationMessage;
  readonly queueMessage: ConversationQueueMessage;
  readonly run: ConversationRun;
  readonly streamEvent: ThreadStreamEvent;
  readonly thread: ConversationThread;
}

export type SubmitConversationTurnResult =
  | (SubmittedConversationTurn & { readonly created: false })
  | (SubmittedConversationTurn & {
      readonly created: true;
      readonly omittedInputArtifacts: readonly InputMediaOmission[];
    });

export interface ConversationServiceOptions {
  readonly appendThreadEvent?: (event: ThreadStreamEvent, signal?: AbortSignal) => Promise<void>;
  readonly database: DynamoDatabaseService;
  readonly enqueueRun: ConversationQueueEnqueue;
  readonly generateId: () => Promise<Ulid>;
  readonly generateSpanId?: () => SpanId;
  readonly generateTraceId?: () => TraceId;
  readonly now?: () => Date;
}

export class ConversationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConversationError";
  }
}

const MAX_USER_MESSAGE_BYTES = 256 * 1024;
const MAX_QUEUE_IDEMPOTENCY_KEY_BYTES = 256;
export const PERMANENT_IDEMPOTENCY_EXPIRES_AT = "9999-12-31T23:59:59.999Z";
export const DEFAULT_HISTORY_LIMIT = 100;
export const MAX_HISTORY_LIMIT = 100;

export async function record(database: DynamoDatabaseService, locator: ConversationRecordLocator) {
  return makeConversationPersistence(database).get(locator);
}

export async function requireActiveWorkspace(
  database: DynamoDatabaseService,
  scope: ConversationScope,
  workspaceId: Ulid,
) {
  const workspace = expected(
    await record(database, {
      environmentId: scope.environmentId,
      id: workspaceId,
      kind: "workspace",
      organizationId: scope.organizationId,
    }),
    "workspace",
    "Workspace",
  );
  if (
    workspace.data.organizationId !== scope.organizationId ||
    workspace.data.projectId !== scope.projectId ||
    workspace.data.environmentId !== scope.environmentId
  ) {
    throw new ConversationError("scope_mismatch", "Workspace does not match the run scope.");
  }
  if (workspace.data.status !== "active") {
    throw new ConversationError("workspace_unavailable", "Workspace is not active.");
  }
  return workspace;
}

export function expected<ItemType extends PlatformRecord["itemType"]>(
  value: PlatformRecord | undefined,
  itemType: ItemType,
  label: string,
): Extract<PlatformRecord, { readonly itemType: ItemType }> {
  if (!value || value.itemType !== itemType) {
    throw new ConversationError("not_found", `${label} was not found.`);
  }
  return value as Extract<PlatformRecord, { readonly itemType: ItemType }>;
}

export function normalizeText(value: string, label: string, maximum = 512) {
  const normalized = value.trim();
  if (!normalized) throw new ConversationError("invalid_request", `${label} is required.`);
  if (normalized.length > maximum) {
    throw new ConversationError("invalid_request", `${label} exceeds ${maximum} characters.`);
  }
  return normalized;
}

export function queueIdempotencyKey(value: string) {
  const normalized = normalizeText(value, "Idempotency key");
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    hasControlCharacter ||
    new TextEncoder().encode(normalized).byteLength > MAX_QUEUE_IDEMPOTENCY_KEY_BYTES
  ) {
    throw new ConversationError(
      "invalid_request",
      `Idempotency key must contain at most ${MAX_QUEUE_IDEMPOTENCY_KEY_BYTES} UTF-8 bytes without control characters.`,
    );
  }
  return normalized;
}

export function content(input: string) {
  const normalized = input.trim();
  if (!normalized) throw new ConversationError("invalid_request", "Message content is required.");
  if (new TextEncoder().encode(normalized).byteLength > MAX_USER_MESSAGE_BYTES) {
    throw new ConversationError(
      "message_too_large",
      `User messages must not exceed ${MAX_USER_MESSAGE_BYTES} bytes.`,
    );
  }
  return normalized;
}

/** The title of a thread created without one, until its first message names it. */
export const DEFAULT_THREAD_TITLE = "New conversation";

export function titleFromContent(value: string) {
  const firstLine = value.split(/\r?\n/u, 1)[0]?.trim() ?? DEFAULT_THREAD_TITLE;
  return firstLine.slice(0, 120) || DEFAULT_THREAD_TITLE;
}

/**
 * A thread keeps its title, except one created without a title and not yet written to (version
 * 0), such as the console's chat threads: its first message titles it like a new thread.
 */
export function submittedThreadTitle(
  previous: ConversationThread | undefined,
  submittedTitle: string,
) {
  if (!previous) return submittedTitle;
  return previous.data.version === 0 && previous.data.title === DEFAULT_THREAD_TITLE
    ? submittedTitle
    : previous.data.title;
}

export function commandHash(
  input: SubmitConversationTurnInput,
  normalizedContent: string,
  normalizedTitle: string,
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        actor: input.actor,
        initiatingCaller: input.initiatingCaller ?? null,
        agentDeploymentId: input.agentDeploymentId,
        channel: input.channel ?? "api",
        captureMode: input.captureMode ?? null,
        content: normalizedContent,
        ...(input.createThreadIfMissing ? { createThreadIfMissing: true } : {}),
        environmentId: input.environmentId,
        executor: input.executor ?? "hosted",
        ...(input.externalThreadKey !== undefined
          ? { externalThreadKey: input.externalThreadKey }
          : {}),
        ...(input.messageMetadata !== undefined ? { messageMetadata: input.messageMetadata } : {}),
        organizationId: input.organizationId,
        priority: input.priority ?? 50,
        projectId: input.projectId,
        ...(input.inputArtifacts !== undefined ? { inputArtifacts: input.inputArtifacts } : {}),
        ...(input.rebaseRelease ? { rebaseRelease: true } : {}),
        ...(input.responseFormat !== undefined
          ? { responseFormat: canonicalResponseFormatJson(input.responseFormat) }
          : {}),
        ...(input.responsePublication !== undefined
          ? { responsePublication: input.responsePublication }
          : {}),
        ...(input.runContext !== undefined ? { runContext: input.runContext } : {}),
        ...(input.skippedInputFiles !== undefined
          ? {
              skippedInputFiles: input.skippedInputFiles.map(({ name, reason }) => ({
                name,
                reason,
              })),
            }
          : {}),
        threadId: input.threadId ?? null,
        title: normalizedTitle,
        traceContext: input.traceContext ?? null,
        trigger: input.trigger ?? "api",
        workspaceId: input.workspaceId ?? null,
      }),
    )
    .digest("hex");
}

export function queueGroupId(message: ConversationQueueMessage) {
  return [message.organizationId, message.projectId, message.environmentId, message.threadId].join(
    ":",
  );
}

export function queueMessage(
  run: ConversationRun,
  message: ConversationMessage,
): ConversationQueueMessage {
  return {
    environmentId: run.data.environmentId,
    idempotencyKey: run.data.idempotencyKey,
    organizationId: run.data.organizationId,
    projectId: run.data.projectId,
    runId: run.data.id,
    spanId: run.data.spanId,
    threadId: run.data.threadId,
    traceId: run.data.traceId,
    userMessageId: message.data.id,
    userMessageSequence: message.data.sequence,
  };
}

export async function loadDeploymentAndRelease(
  database: DynamoDatabaseService,
  input: SubmitConversationTurnInput,
  target: { readonly thread?: ConversationThread | undefined; readonly threadId: Ulid },
): Promise<{
  readonly deployment: AgentDeployment;
  readonly release: AgentRelease;
  readonly selection: AgentReleaseSelectionResult;
}> {
  const deployment = expected(
    await record(database, {
      environmentId: input.environmentId,
      id: input.agentDeploymentId,
      kind: "agent-deployment",
      organizationId: input.organizationId,
    }),
    "agent-deployment",
    "Agent deployment",
  );
  if (
    deployment.data.organizationId !== input.organizationId ||
    deployment.data.projectId !== input.projectId ||
    deployment.data.environmentId !== input.environmentId ||
    deployment.data.currentState !== "ready" ||
    deployment.data.desiredState !== "running"
  ) {
    throw new ConversationError("deployment_unavailable", "Agent deployment is not runnable.");
  }
  const selection = selectAgentRelease({
    deployment,
    rebaseRelease: input.rebaseRelease,
    requestedAgentReleaseId: input.agentReleaseId,
    thread: target.thread,
    threadId: target.threadId,
  });
  if (!selection) {
    throw new ConversationError(
      "release_unavailable",
      "The requested release is not selectable on this agent deployment.",
    );
  }
  const release = expected(
    await record(database, {
      environmentId: input.environmentId,
      id: selection.agentReleaseId,
      kind: "agent-release",
      organizationId: input.organizationId,
    }),
    "agent-release",
    "Agent release",
  );
  if (
    release.data.organizationId !== input.organizationId ||
    release.data.projectId !== input.projectId ||
    release.data.environmentId !== input.environmentId ||
    release.data.agentDefinitionId !== deployment.data.agentDefinitionId ||
    release.data.status !== "active"
  ) {
    throw new ConversationError("release_unavailable", "Agent release is not active.");
  }
  const trigger = (input.trigger ?? "api").trim();
  if (!agentManifestAllowsTrigger(release.data.manifest, trigger)) {
    throw new ConversationError(
      "trigger_not_allowed",
      `Agent release does not allow the ${trigger || "empty"} trigger.`,
    );
  }
  if (
    release.data.manifest.spec.memory?.mode === "workspace" &&
    !(input.workspaceId ?? target.thread?.data.workspaceId)
  ) {
    throw new ConversationError(
      "workspace_required",
      "Agent release uses workspace memory, so the run needs a workspaceId.",
    );
  }
  return { deployment, release, selection };
}

/** Transaction guards that the selected deployment state and release are still unchanged. */
export function runnableControlChecks(
  deployment: AgentDeployment,
  release: AgentRelease,
): readonly TransactionOperation[] {
  return [
    {
      conditionExpression:
        "#data.#version = :version AND #data.#currentState = :ready AND #data.#desiredState = :running",
      expressionAttributeNames: {
        "#currentState": "currentState",
        "#data": "data",
        "#desiredState": "desiredState",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":ready": "ready",
        ":running": "running",
        ":version": deployment.data.version,
      },
      key: { pk: deployment.pk, sk: deployment.sk },
      kind: "condition-check",
      table: "control",
    },
    {
      conditionExpression: "#data.#version = :version AND #data.#status = :active",
      expressionAttributeNames: { "#data": "data", "#status": "status", "#version": "version" },
      expressionAttributeValues: { ":active": "active", ":version": release.data.version },
      key: { pk: release.pk, sk: release.sk },
      kind: "condition-check",
      table: "control",
    },
  ];
}

export async function loadThread(
  database: DynamoDatabaseService,
  input: SubmitConversationTurnInput,
  options: { readonly allowArchived?: boolean } = {},
): Promise<ConversationThread | undefined> {
  if (!input.threadId) {
    if (input.createThreadIfMissing) {
      throw new ConversationError(
        "invalid_request",
        "Thread creation requires an explicitly reserved thread ID.",
      );
    }
    return undefined;
  }
  const value = await record(database, {
    kind: "thread",
    organizationId: input.organizationId,
    threadId: input.threadId,
  });
  if (!value && input.createThreadIfMissing) return undefined;
  const thread = expected(value, "thread", "Thread");
  if (
    thread.data.organizationId !== input.organizationId ||
    thread.data.projectId !== input.projectId ||
    thread.data.environmentId !== input.environmentId ||
    (input.workspaceId !== undefined && thread.data.workspaceId !== input.workspaceId) ||
    thread.data.agentDeploymentId !== input.agentDeploymentId
  ) {
    throw new ConversationError("scope_mismatch", "Thread does not match the requested scope.");
  }
  if (thread.data.archived && !options.allowArchived) {
    throw new ConversationError("thread_archived", "Archived threads cannot receive messages.");
  }
  return thread;
}

export function conversationIdempotencyKey(scope: ConversationScope, value: string) {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "conversation-turn-v1",
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        scope.workspaceId ?? null,
        value,
      ]),
    )
    .digest("hex");
  return `conversation:${digest}`;
}

export function idempotencyKey(scope: ConversationScope, value: string) {
  return {
    pk: key("ORG", scope.organizationId),
    sk: key("IDEMPOTENCY", conversationIdempotencyKey(scope, value)),
  };
}

export async function reconcileSubmission(
  database: DynamoDatabaseService,
  scope: ConversationScope,
  idempotencyKeyValue: string,
  expectedHash: string,
): Promise<Extract<SubmitConversationTurnResult, { readonly created: false }> | undefined> {
  const value = await record(database, {
    idempotencyKey: conversationIdempotencyKey(scope, idempotencyKeyValue),
    kind: "idempotency",
    organizationId: scope.organizationId,
  });
  if (!value) return undefined;
  const idem = expected(value, "idempotency", "Idempotency record");
  if (idem.data.commandHash !== expectedHash) {
    throw new ConversationError(
      "idempotency_conflict",
      "Idempotency key belongs to another request.",
    );
  }
  if (idem.data.status !== "completed") {
    throw new ConversationError(
      "idempotency_in_progress",
      "Idempotent request is still in progress.",
    );
  }
  const [threadId, runId, messageId, eventId] = idem.data.resourceIds;
  const sequence = idem.data.response?.messageSequence;
  if (!threadId || !runId || !messageId || !eventId || !Number.isSafeInteger(sequence)) {
    throw new ConversationError("idempotency_corrupt", "Idempotent response is incomplete.");
  }
  const [threadValue, runValue, messageValue] = await Promise.all([
    record(database, {
      kind: "thread",
      organizationId: scope.organizationId,
      threadId,
    }),
    record(database, {
      idempotencyKey: idempotencyKeyValue,
      kind: "run",
      organizationId: scope.organizationId,
      threadId,
    }),
    record(database, {
      kind: "message",
      messageId,
      organizationId: scope.organizationId,
      sequence: Number(sequence),
      threadId,
    }),
  ]);
  const thread = expected(threadValue, "thread", "Thread");
  const run = expected(runValue, "run", "Run");
  const message = expected(messageValue, "message", "Message");
  const accepted = createThreadStreamEvent({
    actor: {
      ...(typeof idem.data.response?.streamActorId === "string"
        ? { id: idem.data.response.streamActorId }
        : {}),
      type:
        idem.data.response?.streamActorType === "service" ||
        idem.data.response?.streamActorType === "system"
          ? idem.data.response.streamActorType
          : "user",
    },
    environmentId: thread.data.environmentId,
    eventId,
    eventType: "user-message.accepted",
    messageId,
    occurredAt: message.data.createdAt,
    organizationId: scope.organizationId,
    payload: {
      messageId,
      role: "user",
      runId,
      sequence: message.data.sequence,
      threadId,
    },
    projectId: thread.data.projectId,
    runId,
    threadId,
  });
  return {
    created: false,
    message,
    queueMessage: queueMessage(run, message),
    run,
    streamEvent: accepted,
    thread,
  };
}
