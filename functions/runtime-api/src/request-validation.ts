import {
  CancelWorkflowExecutionRequest,
  ResolveWorkflowApprovalRequest,
  StartWorkflowExecutionRequest,
} from "@deployments-ai/api-contract";
import {
  CreateEndUserErasureRequest,
  CreatePreviewRequest,
  CreateThreadRequest,
  CreateWebhookSubscriptionRequest,
  RotateWebhookSecretRequest,
  UpdateWebhookRequest,
  MAX_TOOL_RESULT_OUTPUT_BYTES,
  PublishRunMessageRequest,
  SearchRunsRequest,
  SubmitAgentRunRequest,
  ToolResultOutput,
  SubmitPreviewTurnRequest,
} from "@deployments-ai/api-contract/runtime";
import { Schema } from "effect";
import { RuntimeApiError } from "./runtime-support.ts";

const MAX_EXTERNAL_OPERATION_ID_BYTES = 512;
const DEFAULT_ARTIFACT_ACCESS_EXPIRATION_SECONDS = 900;
const MIN_ARTIFACT_ACCESS_EXPIRATION_SECONDS = 60;
const MAX_ARTIFACT_ACCESS_EXPIRATION_SECONDS = 3600;
const MAX_RUNTIME_LIST_CURSOR_CHARACTERS = 4_096;
const STRICT_SCHEMA_OPTIONS = { onExcessProperty: "error" } as const;

export function artifactAccessExpiration(
  body: Readonly<Record<string, unknown>>,
  options: { readonly now?: Date; readonly retentionExpiresAt?: string } = {},
): number {
  const value = body.expiresInSeconds;
  let expiration = DEFAULT_ARTIFACT_ACCESS_EXPIRATION_SECONDS;
  if (value !== undefined) {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < MIN_ARTIFACT_ACCESS_EXPIRATION_SECONDS ||
      value > MAX_ARTIFACT_ACCESS_EXPIRATION_SECONDS
    ) {
      throw new RuntimeApiError(
        400,
        "invalid_request",
        `expiresInSeconds must be an integer between ${MIN_ARTIFACT_ACCESS_EXPIRATION_SECONDS} and ${MAX_ARTIFACT_ACCESS_EXPIRATION_SECONDS}.`,
      );
    }
    expiration = value;
  }
  if (options.retentionExpiresAt === undefined) return expiration;
  const remainingSeconds = Math.floor(
    (Date.parse(options.retentionExpiresAt) - (options.now ?? new Date()).getTime()) / 1000,
  );
  if (!Number.isSafeInteger(remainingSeconds) || remainingSeconds < 1) {
    throw new RuntimeApiError(409, "artifact_unavailable", "Artifact is not available.");
  }
  return Math.min(expiration, remainingSeconds);
}

export function optionalObjectValue(
  body: Readonly<Record<string, unknown>>,
  field: string,
): Readonly<Record<string, unknown>> | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeApiError(400, "invalid_request", `${field} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function optionalBooleanValue(
  body: Readonly<Record<string, unknown>>,
  field: string,
): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new RuntimeApiError(400, "invalid_request", `${field} must be a boolean.`);
  }
  return value;
}

export function stringValue(
  body: Readonly<Record<string, unknown>>,
  name: string,
  required = true,
): string | undefined {
  const value = body[name];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!required && value === undefined) return undefined;
  throw new RuntimeApiError(400, "invalid_request", `${name} is required.`);
}

export function boundedStringValue(
  body: Readonly<Record<string, unknown>>,
  name: string,
  maximumCharacters: number,
  required = true,
): string | undefined {
  const value = body[name];
  if (!required && value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    Array.from(value).length > maximumCharacters
  ) {
    throw new RuntimeApiError(
      400,
      "invalid_request",
      `${name} must be trimmed and contain from 1 to ${maximumCharacters} characters.`,
    );
  }
  return value;
}

export function numberValue(
  body: Readonly<Record<string, unknown>>,
  name: string,
): number | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RuntimeApiError(400, "invalid_request", `${name} must be an integer.`);
  }
  return value;
}

export function runtimeListCursor(value: string): string {
  if (!value || value.length > MAX_RUNTIME_LIST_CURSOR_CHARACTERS) {
    throw new RuntimeApiError(
      400,
      "invalid_cursor",
      `cursor must contain from 1 to ${MAX_RUNTIME_LIST_CURSOR_CHARACTERS} characters.`,
    );
  }
  return value;
}

export function webhookSubscriptionRequest(body: Readonly<Record<string, unknown>>) {
  try {
    return Schema.decodeUnknownSync(CreateWebhookSubscriptionRequest, STRICT_SCHEMA_OPTIONS)(body);
  } catch {
    throw new RuntimeApiError(
      400,
      "invalid_webhook_subscription",
      "Webhook subscription request is invalid.",
    );
  }
}

export function webhookUpdateRequest(body: Readonly<Record<string, unknown>>) {
  try {
    return Schema.decodeUnknownSync(UpdateWebhookRequest, STRICT_SCHEMA_OPTIONS)(body);
  } catch {
    throw new RuntimeApiError(
      400,
      "invalid_webhook_subscription",
      "Webhook subscription update is invalid.",
    );
  }
}

export function webhookSecretRotationRequest(body: Readonly<Record<string, unknown>>) {
  try {
    return Schema.decodeUnknownSync(RotateWebhookSecretRequest, STRICT_SCHEMA_OPTIONS)(body);
  } catch {
    throw new RuntimeApiError(
      400,
      "invalid_webhook_secret_rotation",
      "previousSecretExpiresInSeconds must be an integer from 0 to 604800.",
    );
  }
}

export function threadCreationRequest(body: Readonly<Record<string, unknown>>) {
  try {
    return Schema.decodeUnknownSync(CreateThreadRequest, STRICT_SCHEMA_OPTIONS)(body);
  } catch {
    throw new RuntimeApiError(
      400,
      "invalid_thread_creation",
      "Thread creation request is invalid.",
    );
  }
}

export function endUserErasureRequest(body: Readonly<Record<string, unknown>>) {
  try {
    return Schema.decodeUnknownSync(CreateEndUserErasureRequest, STRICT_SCHEMA_OPTIONS)(body);
  } catch {
    throw new RuntimeApiError(
      400,
      "invalid_request",
      "End-user erasure takes { endUserId } with an endUserId of 1 to 256 characters.",
    );
  }
}

export function agentRunSubmissionRequest(body: Readonly<Record<string, unknown>>) {
  try {
    return Schema.decodeUnknownSync(SubmitAgentRunRequest, STRICT_SCHEMA_OPTIONS)(body);
  } catch {
    throw new RuntimeApiError(400, "invalid_request", "Agent run submission request is invalid.");
  }
}

export function previewCreationRequest(body: Readonly<Record<string, unknown>>) {
  let input: CreatePreviewRequest;
  try {
    input = Schema.decodeUnknownSync(CreatePreviewRequest, STRICT_SCHEMA_OPTIONS)(body);
  } catch {
    throw new RuntimeApiError(400, "invalid_request", "Preview creation request is invalid.");
  }
  if (input.runtimeConfig !== undefined && input.fromAgentDeploymentId !== undefined) {
    throw new RuntimeApiError(
      400,
      "invalid_request",
      "Provide either runtimeConfig or fromAgentDeploymentId, not both.",
    );
  }
  return input;
}

export function previewTurnRequest(body: Readonly<Record<string, unknown>>) {
  try {
    return Schema.decodeUnknownSync(SubmitPreviewTurnRequest, STRICT_SCHEMA_OPTIONS)(body);
  } catch {
    throw new RuntimeApiError(400, "invalid_request", "Preview turn request is invalid.");
  }
}

export function runMessagePublicationRequest(body: Readonly<Record<string, unknown>>) {
  try {
    return Schema.decodeUnknownSync(PublishRunMessageRequest, STRICT_SCHEMA_OPTIONS)(body);
  } catch {
    throw new RuntimeApiError(
      400,
      "invalid_request",
      "Run message publication request is invalid.",
    );
  }
}

export function runSearchRequest(body: Readonly<Record<string, unknown>>) {
  try {
    return Schema.decodeUnknownSync(SearchRunsRequest, STRICT_SCHEMA_OPTIONS)(body);
  } catch {
    throw new RuntimeApiError(400, "invalid_request", "Run search request is invalid.");
  }
}

export function workflowExecutionStartRequest(body: Readonly<Record<string, unknown>>) {
  try {
    return Schema.decodeUnknownSync(StartWorkflowExecutionRequest, STRICT_SCHEMA_OPTIONS)(body);
  } catch {
    throw new RuntimeApiError(400, "invalid_request", "Workflow execution request is invalid.");
  }
}

export function workflowExecutionCancelRequest(body: Readonly<Record<string, unknown>>) {
  try {
    return Schema.decodeUnknownSync(CancelWorkflowExecutionRequest, STRICT_SCHEMA_OPTIONS)(body);
  } catch {
    throw new RuntimeApiError(
      400,
      "invalid_request",
      "Workflow execution cancellation request is invalid.",
    );
  }
}

export function workflowApprovalResolutionRequest(body: Readonly<Record<string, unknown>>) {
  try {
    return Schema.decodeUnknownSync(ResolveWorkflowApprovalRequest, STRICT_SCHEMA_OPTIONS)(body);
  } catch {
    throw new RuntimeApiError(400, "invalid_request", "Workflow approval request is invalid.");
  }
}

/** Parses the optional structured output of a tool result submission. */
export function toolResultOutput(
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  if (body.output === undefined) return undefined;
  try {
    return Schema.decodeUnknownSync(ToolResultOutput)(body.output);
  } catch {
    throw new RuntimeApiError(
      400,
      "invalid_tool_output",
      `output must be a JSON object of at most ${MAX_TOOL_RESULT_OUTPUT_BYTES} UTF-8 bytes.`,
    );
  }
}

/** Client-executed tools may omit externalOperationId; provider-async tools must send it. */
export function optionalExternalOperationId(
  body: Readonly<Record<string, unknown>>,
): string | undefined {
  const value = body.externalOperationId;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value) {
    throw new RuntimeApiError(
      400,
      "invalid_external_operation_id",
      "externalOperationId must be a non-empty string.",
    );
  }
  const hasControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    value !== value.trim() ||
    value.startsWith("unknown:") ||
    hasControlCharacter ||
    new TextEncoder().encode(value).byteLength > MAX_EXTERNAL_OPERATION_ID_BYTES
  ) {
    throw new RuntimeApiError(
      400,
      "invalid_external_operation_id",
      `externalOperationId must contain at most ${MAX_EXTERNAL_OPERATION_ID_BYTES} UTF-8 bytes without control characters or surrounding whitespace and must not use the reserved unknown: prefix.`,
    );
  }
  return value;
}
