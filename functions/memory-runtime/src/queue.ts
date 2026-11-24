import {
  AwsNativeMemoryError,
  MemoryIndexingError,
  MemoryPlatformError,
  MemorySearchProvisioningStageError,
  type MemoryPlatformScope,
} from "@deployments-ai/memory";
import { databaseFailureLogContext } from "./failure-diagnostics.ts";
export interface QueueRecordLike {
  readonly body: string;
  readonly messageId: string;
}

export interface QueueEventLike {
  readonly Records: readonly QueueRecordLike[];
}

export function queuePayload(record: QueueRecordLike) {
  const parsed = JSON.parse(record.body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Memory queue record must contain an object.");
  }
  const root = parsed as Record<string, unknown>;
  const detail =
    root.detail && typeof root.detail === "object" && !Array.isArray(root.detail)
      ? (root.detail as Record<string, unknown>)
      : root;
  const payload =
    detail.payload && typeof detail.payload === "object" && !Array.isArray(detail.payload)
      ? (detail.payload as Record<string, unknown>)
      : detail;
  const merged: Record<string, unknown> = {
    ...detail,
    ...payload,
    environmentId: detail.environmentId,
    organizationId: detail.organizationId,
    projectId: detail.projectId,
  };
  return merged;
}

export function queueScope(payload: Readonly<Record<string, unknown>>): MemoryPlatformScope {
  const organizationId = payload.organizationId;
  const projectId = payload.projectId;
  const environmentId = payload.environmentId;
  if (
    typeof organizationId !== "string" ||
    typeof projectId !== "string" ||
    typeof environmentId !== "string"
  ) {
    throw new TypeError("Memory queue record is missing tenant scope.");
  }
  return {
    environmentId: environmentId as never,
    organizationId: organizationId as never,
    projectId: projectId as never,
    ...(typeof payload.workspaceId === "string"
      ? { workspaceId: payload.workspaceId as never }
      : {}),
  };
}

export function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} is required.`);
  return value.trim();
}

/** Bounded platform error identity; never includes the message, which may echo tenant content. */
export function memoryPlatformErrorLogContext(...causes: readonly unknown[]) {
  const cause = causes.find(
    (candidate): candidate is MemoryPlatformError => candidate instanceof MemoryPlatformError,
  );
  return cause ? { code: cause.code.slice(0, 128), status: cause.statusCode } : {};
}

function providerFailureLogContext(cause: unknown, stage?: string) {
  const providerCause = cause instanceof MemoryIndexingError ? cause.cause : cause;
  if (providerCause instanceof AwsNativeMemoryError) {
    const reason =
      (providerCause.operation === "validate-existing-open-search-index" ||
        providerCause.operation === "validate-open-search-readiness") &&
      providerCause.cause instanceof Error
        ? providerCause.cause.message.slice(0, 512)
        : undefined;
    return {
      ...(stage === undefined ? {} : { provisioningStage: stage }),
      providerOperation: providerCause.operation,
      ...(reason === undefined ? {} : { providerReason: reason }),
    };
  }
  return stage === undefined ? {} : { provisioningStage: stage };
}

export function logQueueRecordFailure(record: QueueRecordLike, cause: unknown) {
  const stage = cause instanceof MemorySearchProvisioningStageError ? cause.stage : undefined;
  const stagedCause = cause instanceof MemorySearchProvisioningStageError ? cause.cause : cause;
  const diagnosticCause =
    stagedCause instanceof MemoryIndexingError ? stagedCause.cause : stagedCause;
  console.error("Memory queue record failed.", {
    ...databaseFailureLogContext(diagnosticCause),
    errorType: cause instanceof Error ? cause.name : "UnknownError",
    messageId: record.messageId,
    ...memoryPlatformErrorLogContext(cause, stagedCause, diagnosticCause),
    ...providerFailureLogContext(stagedCause, stage),
  });
}

export async function processQueue(
  event: QueueEventLike,
  process: (record: QueueRecordLike) => Promise<void>,
) {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      await process(record);
    } catch (cause) {
      logQueueRecordFailure(record, cause);
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
