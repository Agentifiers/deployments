import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  AutomationError,
  type AutomationDependencies,
  type AutomationRunRequest,
  type TimerProvider,
} from "@deployments-ai/automations";
import {
  createConversationService,
  ConversationError,
  type EndUserKeyDeriver,
  isRunRefusal,
  transientConversationMessageMetadata,
} from "@deployments-ai/conversations";
import type { CredentialVaultService } from "@deployments-ai/credential-vault";
import { INPUT_FILE_PROBLEMS } from "@deployments-ai/agent-manifest";
import {
  type ApiCredentialUsageRecorder,
  type ArtifactInputFile,
  EndUserErasureInProgressError,
  ThreadErasedError,
  Ulid,
  key,
  type DynamoDatabaseService,
  type AdmitManifest,
  type PlatformRecord,
  WorkflowExecutionPersistenceError,
  runtimeApiPersistence,
} from "@deployments-ai/db";
import type { FileTextExtractor } from "@deployments-ai/file-text";
import {
  appendThreadStreamEvents,
  StreamContractError,
  StreamSessionExpiredError,
  type DurableStreamTransport,
  type ThreadStreamEvent,
} from "@deployments-ai/streaming";
import { ApprovalResolutionError } from "@deployments-ai/worker/approvals";
import { RunMutationError } from "@deployments-ai/worker/run-mutations";
import { createSqsAgentRunQueueEnqueue } from "@deployments-ai/worker/sqs";
import type { WebhookRequestSender } from "@deployments-ai/webhooks";
import type { OrganizationGate } from "@deployments-ai/organization-admission";
import { Schema } from "effect";
import { conversationErrorStatus } from "./conversation-error-status.ts";
import { listEnvironmentRecords } from "./environment-record-pagination.ts";
import { RuntimeApiError } from "./runtime-api-error.ts";
import {
  credentialHash,
  signThreadHistoryCursor,
  verifyThreadHistoryCursor,
} from "./runtime-auth-crypto.ts";
import {
  requireScope,
  type RuntimeApiPrincipal,
  type RuntimeHumanAuthenticator,
} from "./runtime-principal.ts";
import type { WebhookDeliveryQueue } from "./webhook-runtime.ts";

export {
  credentialHash,
  listEnvironmentRecords,
  requireScope,
  RuntimeApiError,
  signThreadHistoryCursor,
  verifyThreadHistoryCursor,
};
export type { RuntimeApiCredentialPrincipal, RuntimeApiPrincipal } from "./runtime-principal.ts";

export interface HttpApiEvent {
  readonly body?: string | null;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly isBase64Encoded?: boolean;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>> | null;
  readonly rawPath: string;
  readonly requestContext?: { readonly http?: { readonly method?: string } };
}

export interface HttpApiResult {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly isBase64Encoded?: boolean;
  readonly statusCode: number;
}

export interface RuntimeApiDependencies {
  readonly artifactBucket: string;
  readonly legacyArtifactBuckets?: readonly string[];
  readonly artifactKmsKeyArn?: string;
  readonly artifactS3: S3Client;
  readonly fileTextExtractor: FileTextExtractor;
  /** Admits platform bearer JWT holders; without it the runtime API accepts only API keys. */
  readonly authenticateHuman?: RuntimeHumanAuthenticator;
  readonly database: DynamoDatabaseService;
  readonly credentialVault?: CredentialVaultService;
  readonly durableTransport: DurableStreamTransport;
  readonly enqueueRun: ReturnType<typeof createSqsAgentRunQueueEnqueue>;
  readonly endUserSubjects: EndUserKeyDeriver;
  readonly generateId: () => Promise<Ulid>;
  /** Admits a preview binding's manifest the way publish does. */
  readonly admitManifest: AdmitManifest;
  readonly now?: () => Date;
  readonly organizationGate?: OrganizationGate;
  readonly recordApiCredentialUsage?: ApiCredentialUsageRecorder;
  readonly sessionTokenSecret: string;
  /** Public stream gateway origin that serves the thread streams sessions are issued for. */
  readonly streamGatewayBaseUrl: string;
  readonly timerProvider?: TimerProvider;
  /** Schedules manual webhook delivery retries; retries answer 503 without it. */
  readonly webhookDeliveryQueue?: WebhookDeliveryQueue;
  /** Egress for webhook test sends; defaults to the pinned, SSRF-safe HTTPS sender. */
  readonly webhookSender?: WebhookRequestSender;
}

export function headers(event: HttpApiEvent) {
  return Object.fromEntries(
    Object.entries(event.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

export function requiredIdempotencyKey(event: HttpApiEvent) {
  const value = headers(event)["idempotency-key"];
  if (value === undefined || !value.trim()) {
    throw new RuntimeApiError(400, "idempotency_key_required", "idempotency-key is required.");
  }
  return validatedIdempotencyKey(value, "idempotency-key");
}

export function validatedIdempotencyKey(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new RuntimeApiError(400, "invalid_idempotency_key", `${label} is required.`);
  }
  if (value !== normalized) {
    throw new RuntimeApiError(
      400,
      "invalid_idempotency_key",
      `${label} must not contain surrounding whitespace.`,
    );
  }
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (hasControlCharacter || new TextEncoder().encode(normalized).byteLength > 256) {
    throw new RuntimeApiError(
      400,
      "invalid_idempotency_key",
      `${label} must contain at most 256 UTF-8 bytes without control characters.`,
    );
  }
  return normalized;
}

export function response(
  statusCode: number,
  body: unknown,
  contentType = "application/json",
): HttpApiResult {
  return {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": contentType, "cache-control": "no-store" },
    statusCode,
  };
}

export function problem(error: RuntimeApiError, requestId?: string) {
  return response(
    error.status,
    {
      code: error.code,
      detail: error.message,
      ...(requestId ? { requestId } : {}),
      status: error.status,
      title: error.code.replaceAll("_", " "),
      type: `https://docs.deployments.ai/errors/${error.code.replaceAll("_", "-")}`,
    },
    "application/problem+json",
  );
}

export function runtimeApiErrorFromCause(cause: unknown): RuntimeApiError {
  if (cause instanceof RuntimeApiError) return cause;
  if (cause instanceof RunMutationError) return new RuntimeApiError(409, cause.code, cause.message);
  if (cause instanceof ThreadErasedError) {
    return new RuntimeApiError(404, "thread_not_found", "Thread not found.");
  }
  if (cause instanceof EndUserErasureInProgressError) {
    return new RuntimeApiError(
      409,
      "end_user_erasure_in_progress",
      "An erasure of this end user is in progress; new threads for it are refused until it completes.",
    );
  }
  if (cause instanceof WorkflowExecutionPersistenceError) {
    const status = cause.code === "not_found" ? 404 : 409;
    return new RuntimeApiError(status, `workflow_execution_${cause.code}`, cause.message);
  }
  if (cause instanceof StreamSessionExpiredError) {
    return new RuntimeApiError(401, "stream_session_expired", cause.message);
  }
  if (cause instanceof StreamContractError) {
    if (cause.field.startsWith("sessionToken")) {
      return new RuntimeApiError(401, "invalid_stream_token", cause.message);
    }
    if (cause.field.startsWith("history.")) {
      return new RuntimeApiError(413, "stream_history_too_large", cause.message);
    }
    return new RuntimeApiError(400, "invalid_stream_request", cause.message);
  }
  if (cause instanceof ConversationError) {
    const status = conversationErrorStatus(cause);
    return new RuntimeApiError(
      status,
      cause.code,
      status >= 500 ? "Internal server error." : cause.message,
    );
  }
  if (cause instanceof AutomationError) {
    const status =
      cause.code === "not_found" || cause.code === "scope_mismatch"
        ? 404
        : cause.code.startsWith("invalid_")
          ? 400
          : cause.code === "deployment_unavailable" ||
              cause.code === "automation_archived" ||
              cause.code === "release_unavailable" ||
              cause.code === "thread_archived" ||
              cause.code === "trigger_not_allowed" ||
              cause.code === "workspace_unavailable" ||
              cause.code === "idempotency_conflict"
            ? 409
            : 500;
    return new RuntimeApiError(
      status,
      cause.code,
      status >= 500 ? "Internal server error." : cause.message,
    );
  }
  if (cause instanceof ApprovalResolutionError) {
    const conflictCodes = new Set([
      "approval_already_resolved",
      "evaluation_approval_unsupported",
      "execution_binding_expired",
      "external_operation_mismatch",
      "run_not_waiting_for_approval",
      "run_not_waiting_for_tool",
      "thread_publication_pending",
      "tool_call_already_resolved",
      "tool_call_expired",
      "tool_call_not_waiting_for_approval",
    ]);
    const status =
      cause.code === "run_not_found" ||
      cause.code === "approval_not_found" ||
      cause.code === "tool_call_not_found"
        ? 404
        : cause.code === "approval_requires_human"
          ? 403
          : cause.code.startsWith("invalid_")
            ? 400
            : conflictCodes.has(cause.code)
              ? 409
              : 500;
    return new RuntimeApiError(
      status,
      cause.code,
      status >= 500 ? "Internal server error." : cause.message,
    );
  }
  const code =
    typeof cause === "object" && cause && "code" in cause && typeof cause.code === "string"
      ? cause.code.replaceAll("-", "_")
      : "internal_error";
  const status = code.includes("not_found")
    ? 404
    : code.includes("scope")
      ? 403
      : code.includes("invalid")
        ? 400
        : code.includes("conflict")
          ? 409
          : 500;
  return new RuntimeApiError(
    status,
    code,
    status >= 500
      ? "Internal server error."
      : cause instanceof Error
        ? cause.message
        : "Request failed.",
  );
}

export function id(value: string | undefined, label: string): Ulid {
  try {
    return Schema.decodeUnknownSync(Ulid)(value);
  } catch {
    throw new RuntimeApiError(400, "invalid_id", `${label} must be a canonical ULID.`);
  }
}

export function jsonBody(event: HttpApiEvent): Readonly<Record<string, unknown>> {
  if (!event.body) return {};
  try {
    const decoded = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    const value = JSON.parse(decoded) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Readonly<Record<string, unknown>>;
  } catch {
    throw new RuntimeApiError(400, "invalid_json", "Request body must be a JSON object.");
  }
}

export async function getRecord(
  database: DynamoDatabaseService,
  table: "control" | "execution",
  recordKey: { readonly pk: string; readonly sk: string },
) {
  return runtimeApiPersistence.read(database, table, recordKey, true);
}

export function assertRecord<T extends PlatformRecord["itemType"]>(
  value: PlatformRecord | undefined,
  itemType: T,
  label: string,
): Extract<PlatformRecord, { readonly itemType: T }> {
  if (!value || value.itemType !== itemType) {
    throw new RuntimeApiError(404, "not_found", `${label} was not found.`);
  }
  return value as Extract<PlatformRecord, { readonly itemType: T }>;
}

export function publicRecord<RecordType extends PlatformRecord>(
  record: RecordType,
): RecordType["data"] & { readonly object: RecordType["itemType"] } {
  return { ...record.data, object: record.itemType } as RecordType["data"] & {
    readonly object: RecordType["itemType"];
  };
}

type MessageRecord = Extract<PlatformRecord, { readonly itemType: "message" }>;
type ObjectUrlSigner = (
  client: S3Client,
  command: GetObjectCommand,
  options: { readonly expiresIn: number },
) => Promise<string>;

export async function publicMessage(
  record: MessageRecord,
  dependencies: RuntimeApiDependencies,
  signObjectUrl: ObjectUrlSigner = (client, command, options) =>
    getSignedUrl(client, command, options),
) {
  const { bodyRef, ...data } = record.data;
  if (!bodyRef) return { ...data, object: record.itemType };
  if (
    bodyRef.bucket !== dependencies.artifactBucket &&
    !dependencies.legacyArtifactBuckets?.includes(bodyRef.bucket)
  ) {
    throw new RuntimeApiError(
      500,
      "message_body_invalid",
      "Message body storage does not match the runtime artifact bucket.",
    );
  }
  const expiresIn = 5 * 60;
  const now = dependencies.now?.() ?? new Date();
  const url = await signObjectUrl(
    dependencies.artifactS3,
    new GetObjectCommand({
      Bucket: bodyRef.bucket,
      Key: bodyRef.key,
      ResponseContentType: bodyRef.contentType,
      ...(bodyRef.versionId ? { VersionId: bodyRef.versionId } : {}),
    }),
    { expiresIn },
  );
  return {
    ...data,
    bodyAccess: {
      byteSize: bodyRef.byteSize,
      contentType: bodyRef.contentType,
      expiresAt: new Date(now.getTime() + expiresIn * 1000).toISOString(),
      sha256: bodyRef.sha256,
      url,
    },
    object: record.itemType,
  };
}

export const MAX_RUNTIME_API_HISTORY_RESPONSE_BYTES = 4 * 1024 * 1024;
const HISTORY_CURSOR_RESERVE = "x".repeat(8 * 1024);

export async function publicMessagePage(
  records: readonly MessageRecord[],
  dependencies: RuntimeApiDependencies,
  upstreamNextCursor?: string,
  snapshotUpperSk?: string,
) {
  const messages: Array<Awaited<ReturnType<typeof publicMessage>>> = [];
  for (const [index, record] of records.entries()) {
    const projected = await publicMessage(record, dependencies);
    const candidate = [...messages, projected];
    const byteLength = new TextEncoder().encode(
      JSON.stringify({
        messages: candidate,
        nextCursor: upstreamNextCursor ?? HISTORY_CURSOR_RESERVE,
      }),
    ).byteLength;
    if (byteLength > MAX_RUNTIME_API_HISTORY_RESPONSE_BYTES) {
      if (messages.length === 0) {
        throw new RuntimeApiError(
          413,
          "message_page_too_large",
          "A single message exceeds the public history response limit.",
        );
      }
      const previous = records[index - 1]!;
      let upperSk = snapshotUpperSk;
      if (upstreamNextCursor) {
        try {
          const decoded = JSON.parse(
            Buffer.from(upstreamNextCursor, "base64url").toString("utf8"),
          ) as { upperSk?: unknown };
          if (typeof decoded.upperSk === "string" && decoded.upperSk.startsWith("MESSAGE#")) {
            upperSk = decoded.upperSk;
          }
        } catch {
          // The upstream cursor is validated when it is consumed.
        }
      }
      return {
        messages,
        nextCursor: Buffer.from(
          JSON.stringify({ pk: previous.pk, sk: previous.sk, ...(upperSk ? { upperSk } : {}) }),
          "utf8",
        ).toString("base64url"),
      };
    }
    messages.push(projected);
  }
  return { messages, ...(upstreamNextCursor ? { nextCursor: upstreamNextCursor } : {}) };
}

export async function appendRuntimeThreadEvent(
  dependencies: RuntimeApiDependencies,
  event: ThreadStreamEvent,
  signal?: AbortSignal,
) {
  await appendThreadStreamEvents({
    events: [event],
    producerId: event.eventId,
    producerType: "api",
    ...(signal ? { signal } : {}),
    scope: event,
    transport: dependencies.durableTransport,
  });
}

function publicInputFile(input: ArtifactInputFile) {
  switch (input.kind) {
    case "audio":
    case "image":
      return input;
    case "document":
      return { kind: input.kind, mediaType: input.mediaType, summary: input.summary };
    case "unusable":
      return {
        kind: input.kind,
        message: INPUT_FILE_PROBLEMS[input.reason].copy,
        reason: input.reason,
      };
    default: {
      const unhandled: never = input;
      return unhandled;
    }
  }
}

export function publicArtifact(record: Extract<PlatformRecord, { readonly itemType: "artifact" }>) {
  return {
    agentDeploymentId: record.data.agentDeploymentId,
    artifactId: record.data.id,
    byteSize: record.data.storage.byteSize,
    contentType: record.data.storage.contentType,
    createdAt: record.data.createdAt,
    fileName: record.data.storage.fileName,
    ...(record.data.input ? { input: publicInputFile(record.data.input) } : {}),
    metadata: record.data.metadata,
    name: record.data.name,
    object: record.itemType,
    retentionExpiresAt: record.data.retentionExpiresAt,
    runId: record.data.runId,
    status: record.data.status,
    type: record.data.type,
    updatedAt: record.data.updatedAt,
    version: record.data.version,
    visibility: record.data.visibility,
    ...(record.data.threadId ? { threadId: record.data.threadId } : {}),
  };
}

export function scoped<
  T extends {
    readonly data: Readonly<Record<string, unknown>>;
    readonly itemType: string;
  },
>(record: T, principal: RuntimeApiPrincipal): T {
  const data = record.data;
  if (
    data.organizationId !== principal.scope.organizationId ||
    data.projectId !== principal.scope.projectId ||
    data.environmentId !== principal.scope.environmentId
  ) {
    throw new RuntimeApiError(404, "not_found", `${record.itemType} was not found.`);
  }
  return record;
}

export function conversationService(dependencies: RuntimeApiDependencies) {
  return createConversationService({
    appendThreadEvent: (event, signal?: AbortSignal) =>
      appendRuntimeThreadEvent(dependencies, event, signal),
    database: dependencies.database,
    enqueueRun: dependencies.enqueueRun,
    generateId: dependencies.generateId,
    ...(dependencies.now ? { now: dependencies.now } : {}),
  });
}

async function submitAutomationRun(
  dependencies: RuntimeApiDependencies,
  input: Parameters<NonNullable<AutomationDependencies["submitRun"]>>[0],
) {
  assertRecord(
    await getRecord(dependencies.database, "control", {
      pk: key("ORG", input.organizationId, "ENV", input.environmentId),
      sk: key("AGENT-DEPLOYMENT", input.agentDeploymentId),
    }),
    "agent-deployment",
    "Agent deployment",
  );
  const result = await automationSubmission(
    conversationService(dependencies).submitTurn({
      ...input,
      actor: { type: "system" },
      ...(input.trigger === "heartbeat" || input.trigger === "schedule"
        ? { messageMetadata: transientConversationMessageMetadata() }
        : {}),
      title: automationRunTitle(input.trigger),
    }),
  );
  return { runId: result.run.data.id, threadId: result.thread.data.id };
}

/**
 * Settles an automation's conversation submission under the `SubmitAutomationRun` contract: a
 * run refusal, such as an exhausted budget or a suspended organization, becomes an `AutomationError`
 * with the same code, which records a skipped fire.
 */
export async function automationSubmission<T>(submission: Promise<T>): Promise<T> {
  try {
    return await submission;
  } catch (cause) {
    if (isRunRefusal(cause)) {
      throw new AutomationError(cause.code, cause.message, { cause });
    }
    throw cause;
  }
}

export function automationRunTitle(trigger: AutomationRunRequest["trigger"]) {
  return trigger === "heartbeat" ? "Heartbeat" : "Scheduled run";
}

export function automationDependencies(
  dependencies: RuntimeApiDependencies,
): AutomationDependencies {
  return {
    database: dependencies.database,
    generateId: dependencies.generateId,
    ...(dependencies.now ? { now: dependencies.now } : {}),
    submitRun: (input) => submitAutomationRun(dependencies, input),
    ...(dependencies.timerProvider ? { timerProvider: dependencies.timerProvider } : {}),
  };
}

export async function loadThread(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  threadId: Ulid,
) {
  return scoped(
    assertRecord(
      await getRecord(dependencies.database, "execution", {
        pk: key("ORG", principal.scope.organizationId, "THREAD", threadId),
        sk: key("THREAD", threadId),
      }),
      "thread",
      "Thread",
    ),
    principal,
  );
}

export async function loadRunById(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  runId: Ulid,
) {
  const locator = scoped(
    assertRecord(
      await getRecord(dependencies.database, "control", {
        pk: key("ORG", principal.scope.organizationId, "ENV", principal.scope.environmentId),
        sk: key("RUN-LOCATOR", runId),
      }),
      "run-locator",
      "Run",
    ),
    principal,
  );
  return scoped(
    assertRecord(
      await getRecord(dependencies.database, "execution", {
        pk: locator.data.runPk,
        sk: locator.data.runSk,
      }),
      "run",
      "Run",
    ),
    principal,
  );
}
