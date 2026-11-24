import type { RuntimeObservabilityContext } from "@deployments-ai/agent-runtime";
import type { BrainRunObservability } from "@deployments-ai/brains";
import type { Ulid } from "@deployments-ai/db";
import type { BrainToolRequest } from "./authorization.ts";

const MAX_BRAIN_QUERY_COUNT = 20;
const MAX_BRAIN_SEARCH_LIMIT = 20;

export interface BrainDocumentEvidence {
  readonly citation: {
    readonly brainId: string;
    readonly chunkId: string;
    readonly coordinates: {
      readonly end: number;
      readonly kind: "utf8-byte";
      readonly start: number;
    };
    readonly documentId: string;
    readonly documentVersionId: string;
    readonly renditionId: string;
    readonly sourceId: string;
  };
  readonly excerpt: string;
  readonly mediaType: string;
  readonly title?: string;
}

export function inputRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Brain tool input must be an object.");
  }
  return value as Readonly<Record<string, unknown>>;
}

export function brainIds(value: unknown): readonly Ulid[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_BRAIN_QUERY_COUNT ||
    !value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  ) {
    throw new TypeError(`Brain tool input requires 1-${MAX_BRAIN_QUERY_COUNT} brainIds.`);
  }
  const normalized = value.map((entry) => entry.trim() as Ulid);
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError("Brain tool input brainIds must be unique.");
  }
  return normalized;
}

export function requiredText(input: Readonly<Record<string, unknown>>, field: string) {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Brain tool input requires ${field}.`);
  }
  return value.trim();
}

export function searchLimit(value: unknown) {
  if (value === undefined) return 8;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 20) {
    throw new TypeError(`Brain search limit must be between 1 and ${MAX_BRAIN_SEARCH_LIMIT}.`);
  }
  return value as number;
}

export function brainRunObservability(
  request: Pick<
    RuntimeObservabilityContext,
    "captureMode" | "parentSpanId" | "spanId" | "traceId"
  > & {
    readonly threadId: Ulid;
    readonly workspaceId?: Ulid;
  },
): BrainRunObservability {
  return {
    captureMode: request.captureMode,
    ...(request.parentSpanId ? { parentSpanId: request.parentSpanId } : {}),
    runSpanId: request.spanId,
    sessionId: request.threadId,
    traceId: request.traceId,
    ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
  };
}

export function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

export function evidenceArtifact(
  request: BrainToolRequest,
  brainIdValues: readonly Ulid[],
  content: unknown,
) {
  return {
    content: JSON.stringify(content, null, 2),
    contentType: "application/json",
    fileName: `brain-evidence-${request.decision.toolCallId}.json`,
    label: "Authorized Brain evidence",
    metadata: { brainIds: brainIdValues, kind: "brain-evidence" },
    type: "brain-evidence",
    visibility: "private" as const,
  };
}
