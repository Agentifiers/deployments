import {
  executePinnedHttpRequest,
  executePinnedHttpsWithSameOriginRedirects,
  NetSecurityError,
  NetSecurityRedirectError,
  normalizeHttpsOriginForComparison,
  readResponseTextWithByteLimit,
  type DnsLookup,
  type ExecutePinnedHttpRequestOptions,
} from "@deployments-ai/net-security";
import type { RuntimeToolExecutionResult } from "@deployments-ai/agent-runtime";
import type { CallbackChannelOrigin } from "@deployments-ai/db";
import type {
  ToolAdapterDefinition,
  ToolAdapterHttpCallbackExecution,
} from "@deployments-ai/tools";
import { assertNoCredentialLeak } from "@deployments-ai/tools";
import Ajv, { type ValidateFunction } from "ajv";
import type { AuthorizedRuntimeToolBindingRequest } from "./runtime-tools.ts";
import { providerMutationRequestIdempotencyKey } from "./runtime-idempotency.ts";

const DEFAULT_RUNTIME_CALLBACK_REQUEST_MAX_BYTES = 256 * 1_024;
const DEFAULT_RUNTIME_CALLBACK_RESPONSE_MAX_BYTES = 1 * 1_024 * 1_024;
const DEFAULT_RUNTIME_CALLBACK_TIMEOUT_MS = 30_000;
// The callback response is the tool result the model acts on; the full body stays in the artifact.
const MAX_RUNTIME_CALLBACK_OUTPUT_SUMMARY_CHARACTERS = 4_000;

const callbackSchemaValidator = new Ajv({ allErrors: true, strict: false });
const callbackInputValidators = new WeakMap<object, ValidateFunction>();
const utf8Encoder = new TextEncoder();

export interface RuntimeHttpCallbackExecutorOptions {
  readonly dnsLookup?: DnsLookup;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly pinnedRequest?: (args: ExecutePinnedHttpRequestOptions) => Promise<Response>;
  readonly requestTimeoutMs?: number;
}

/** One thread-sandbox file attached to a callback; `content` is present only for UTF-8 text. */
export interface RuntimeCallbackWorkspaceFile {
  readonly byteSize: number;
  readonly content?: string | undefined;
  /** Relative to `/workspace`. */
  readonly path: string;
  readonly sha256: string;
}

function runtimeHttpCallbackRequestBody(input: {
  readonly callbackEvidenceId: string;
  readonly effect: "execute" | "read" | "write";
  readonly effectiveInput: Readonly<Record<string, unknown>>;
  readonly options?: Pick<RuntimeHttpCallbackExecutorOptions, "maxRequestBytes">;
  readonly origin?: CallbackChannelOrigin;
  readonly request: AuthorizedRuntimeToolBindingRequest;
  readonly workspaceFiles?: readonly RuntimeCallbackWorkspaceFile[];
}): string {
  const { effectiveInput, request } = input;
  const body = JSON.stringify({
    // Preview/evaluation calls identify their execution binding so receivers can tell them apart
    // from production traffic.
    ...(request.executionBindingId === undefined
      ? { agentDeploymentId: request.agentDeploymentId }
      : {
          executionBindingId: request.executionBindingId,
          executionPurpose: request.executionPurpose,
        }),
    ...(request.approvalId ? { approvalId: request.approvalId } : {}),
    callbackEvidenceId: input.callbackEvidenceId,
    effect: input.effect,
    idempotencyKey: providerMutationRequestIdempotencyKey(request.runId, request.idempotencyKey),
    input: effectiveInput,
    inputHash: request.decision.executionBinding.inputHash,
    logicalIdempotencyKey: request.idempotencyKey,
    organizationId: request.organizationId,
    ...(input.origin ? { origin: input.origin } : {}),
    policyAction: request.policyAction,
    requiredScopes: request.requiredScopes ?? [],
    runId: request.runId,
    threadId: request.threadId,
    toolCallId: request.decision.toolCallId,
    toolName: request.toolName,
    version: 1,
    ...(input.workspaceFiles ? { workspaceFiles: { files: input.workspaceFiles } } : {}),
    ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
  });
  const maximumRequestBytes = positiveInteger(
    input.options?.maxRequestBytes,
    DEFAULT_RUNTIME_CALLBACK_REQUEST_MAX_BYTES,
    "HTTP callback request byte limit",
  );
  if (utf8Encoder.encode(body).byteLength > maximumRequestBytes) {
    throw new RuntimeHttpCallbackKnownFailureError(
      request.toolName,
      input.workspaceFiles
        ? `HTTP callback ${request.toolName} request exceeded ${maximumRequestBytes} bytes with its workspace files attached.`
        : `HTTP callback ${request.toolName} request was too large.`,
    );
  }
  return body;
}

export class RuntimeHttpCallbackKnownFailureError extends Error {
  constructor(
    readonly toolName: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeHttpCallbackKnownFailureError";
  }
}

export class RuntimeHttpCallbackOutcomeUnknownError extends Error {
  constructor(
    readonly toolName: string,
    options?: ErrorOptions,
  ) {
    super(`HTTP callback ${toolName} has an unknown outcome after dispatch.`, options);
    this.name = "RuntimeHttpCallbackOutcomeUnknownError";
  }
}

export class RuntimeHttpCallbackRetryableError extends Error {
  constructor(
    readonly toolName: string,
    options?: ErrorOptions,
  ) {
    super(`HTTP callback ${toolName} failed before a durable outcome was observed.`, options);
    this.name = "RuntimeHttpCallbackRetryableError";
  }
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RuntimeHttpCallbackKnownFailureError(
      "http_callback",
      `${label} must be a positive safe integer.`,
    );
  }
  return resolved;
}

function endpoint(execution: ToolAdapterHttpCallbackExecution): {
  readonly origin: string;
  readonly url: URL;
} {
  if (execution.completionMode !== "sync") {
    throw new RuntimeHttpCallbackKnownFailureError(
      "http_callback",
      "HTTP callback execution supports only synchronous completion.",
    );
  }
  const rawOrigin = execution.endpointOrigin.trim();
  let origin: string;
  try {
    origin = normalizeHttpsOriginForComparison(rawOrigin);
  } catch (cause) {
    throw new RuntimeHttpCallbackKnownFailureError(
      "http_callback",
      "HTTP callback endpoint origin is not a valid HTTPS origin.",
      { cause },
    );
  }
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(rawOrigin);
  } catch (cause) {
    throw new RuntimeHttpCallbackKnownFailureError(
      "http_callback",
      "HTTP callback endpoint origin is invalid.",
      { cause },
    );
  }
  if (
    parsedOrigin.origin !== origin ||
    parsedOrigin.pathname !== "/" ||
    parsedOrigin.search ||
    parsedOrigin.hash
  ) {
    throw new RuntimeHttpCallbackKnownFailureError(
      "http_callback",
      "HTTP callback endpointOrigin must contain only an HTTPS origin.",
    );
  }
  const path = execution.endpointPath.trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("#")) {
    throw new RuntimeHttpCallbackKnownFailureError(
      "http_callback",
      "HTTP callback endpointPath must be an absolute path without a fragment.",
    );
  }
  let url: URL;
  try {
    url = new URL(path, `${origin}/`);
  } catch (cause) {
    throw new RuntimeHttpCallbackKnownFailureError(
      "http_callback",
      "HTTP callback endpoint path is invalid.",
      { cause },
    );
  }
  if (url.origin !== origin) {
    throw new RuntimeHttpCallbackKnownFailureError(
      "http_callback",
      "HTTP callback endpoint escaped its configured origin.",
    );
  }
  return { origin, url };
}

function validateEffectiveInput(
  definition: ToolAdapterDefinition,
  value: Readonly<Record<string, unknown>>,
): void {
  const schema = definition.inputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new RuntimeHttpCallbackKnownFailureError(
      definition.toolName,
      `HTTP callback ${definition.toolName} requires an object input schema.`,
    );
  }
  let validate = callbackInputValidators.get(schema);
  if (!validate) {
    try {
      validate = callbackSchemaValidator.compile(schema);
    } catch (cause) {
      throw new RuntimeHttpCallbackKnownFailureError(
        definition.toolName,
        `HTTP callback ${definition.toolName} has an invalid input schema.`,
        { cause },
      );
    }
    callbackInputValidators.set(schema, validate);
  }
  if (!validate(value)) {
    throw new RuntimeHttpCallbackKnownFailureError(
      definition.toolName,
      `HTTP callback ${definition.toolName} input does not match its schema.`,
    );
  }
}

export function prepareRuntimeHttpCallback(input: {
  readonly callbackEvidenceId: string;
  readonly definition: ToolAdapterDefinition;
  readonly effect: "execute" | "read" | "write";
  readonly effectiveInput: Readonly<Record<string, unknown>>;
  readonly execution: ToolAdapterHttpCallbackExecution;
  readonly options?: RuntimeHttpCallbackExecutorOptions;
  readonly origin?: CallbackChannelOrigin;
  readonly request: AuthorizedRuntimeToolBindingRequest;
  readonly workspaceFiles?: readonly RuntimeCallbackWorkspaceFile[];
}) {
  validateEffectiveInput(input.definition, input.effectiveInput);
  const target = endpoint(input.execution);
  const maximumResponseBytes = positiveInteger(
    input.options?.maxResponseBytes,
    DEFAULT_RUNTIME_CALLBACK_RESPONSE_MAX_BYTES,
    "HTTP callback response byte limit",
  );
  const requestTimeoutMs = positiveInteger(
    input.options?.requestTimeoutMs,
    DEFAULT_RUNTIME_CALLBACK_TIMEOUT_MS,
    "HTTP callback timeout",
  );
  const body = runtimeHttpCallbackRequestBody({
    callbackEvidenceId: input.callbackEvidenceId,
    effect: input.effect,
    effectiveInput: input.effectiveInput,
    ...(input.options ? { options: input.options } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    request: input.request,
    ...(input.workspaceFiles ? { workspaceFiles: input.workspaceFiles } : {}),
  });
  return { body, maximumResponseBytes, requestTimeoutMs, target };
}

function timeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, deadline]) : deadline;
}

function safeFileSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80) || "callback"
  );
}

function callbackArtifact(
  responseBody: string,
  contentType: string,
  request: AuthorizedRuntimeToolBindingRequest,
  responseStatus: number,
  maximumCharacters: number,
) {
  const truncated = responseBody.length > maximumCharacters;
  const sourceIsJson = contentType.toLowerCase().includes("json");
  let validJson = false;
  if (sourceIsJson && responseBody.trim()) {
    try {
      JSON.parse(responseBody);
      validJson = true;
    } catch {
      validJson = false;
    }
  }
  const artifactIsJson = validJson && !truncated;
  const content = responseBody.trim()
    ? `${responseBody.slice(0, maximumCharacters)}${truncated ? "\n[truncated]" : ""}\n`
    : "{}\n";
  return {
    content,
    contentType: artifactIsJson ? "application/json" : "text/plain; charset=utf-8",
    fileName: `${request.decision.toolCallId}-${safeFileSegment(request.toolName)}.callback.${
      artifactIsJson ? "json" : "txt"
    }`,
    label: `${request.toolName} callback response`,
    metadata: {
      responseStatus,
      resultSummary: {
        ok: true,
        status: responseStatus,
        toolName: request.toolName,
      },
      source: "extension.http_callback",
      toolCallId: request.decision.toolCallId,
      toolName: request.toolName,
      truncated,
    },
    type: "report",
    visibility: "private",
  } as const;
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function knownConfigurationFailure(cause: unknown): boolean {
  return (
    cause instanceof NetSecurityRedirectError ||
    (cause instanceof NetSecurityError &&
      ["credentials", "invalid-url", "non-https", "non-public-host", "private-address"].includes(
        cause.code,
      ))
  );
}

export async function executeRuntimeHttpCallback(input: {
  readonly callbackEvidenceId: string;
  readonly definition: ToolAdapterDefinition;
  readonly effect: "execute" | "read" | "write";
  readonly effectiveInput: Readonly<Record<string, unknown>>;
  readonly execution: ToolAdapterHttpCallbackExecution;
  readonly maximumArtifactCharacters: number;
  readonly options?: RuntimeHttpCallbackExecutorOptions;
  readonly origin?: CallbackChannelOrigin;
  readonly request: AuthorizedRuntimeToolBindingRequest;
  readonly workspaceFiles?: readonly RuntimeCallbackWorkspaceFile[];
}): Promise<RuntimeToolExecutionResult> {
  const { definition, execution, request } = input;
  const { body, maximumResponseBytes, requestTimeoutMs, target } =
    prepareRuntimeHttpCallback(input);

  let dispatched = false;
  try {
    const result = await executePinnedHttpsWithSameOriginRedirects({
      body,
      ...(input.options?.dnsLookup ? { dnsLookup: input.options.dnsLookup } : {}),
      headers: {
        ...(execution.authorizationHeader ? { authorization: execution.authorizationHeader } : {}),
        "content-type": "application/json",
      },
      maxRedirects: 0,
      method: "POST",
      pinnedRequest: async (args) => {
        dispatched = true;
        return (input.options?.pinnedRequest ?? executePinnedHttpRequest)(args);
      },
      signal: timeoutSignal(request.signal, requestTimeoutMs),
      url: target.url,
      verifiedOrigin: target.origin,
    });
    if (!result.response.ok) {
      try {
        await result.response.body?.cancel();
      } catch {
        // The received status is authoritative even if response cleanup fails.
      }
      const cause = new Error(
        `HTTP callback ${definition.toolName} returned HTTP ${result.response.status}.`,
      );
      if (input.effect !== "read" && transientStatus(result.response.status)) {
        throw new RuntimeHttpCallbackOutcomeUnknownError(definition.toolName, { cause });
      }
      if (input.effect === "read" && transientStatus(result.response.status)) {
        throw new RuntimeHttpCallbackRetryableError(definition.toolName, { cause });
      }
      throw new RuntimeHttpCallbackKnownFailureError(definition.toolName, cause.message, { cause });
    }
    const responseBody = await readResponseTextWithByteLimit(
      result.response,
      maximumResponseBytes,
      `HTTP callback ${definition.toolName} response`,
    );
    if (execution.authorizationHeader) {
      const separator = execution.authorizationHeader.indexOf(" ");
      const sensitiveMaterials = new Set([
        execution.authorizationHeader,
        ...(separator > 0 ? [execution.authorizationHeader.slice(separator + 1)] : []),
      ]);
      let structuredBody: unknown;
      try {
        structuredBody = JSON.parse(responseBody);
      } catch {
        structuredBody = undefined;
      }
      try {
        assertNoCredentialLeak(responseBody, sensitiveMaterials, structuredBody);
      } catch (cause) {
        if (input.effect !== "read") {
          throw new RuntimeHttpCallbackOutcomeUnknownError(definition.toolName, { cause });
        }
        throw new RuntimeHttpCallbackKnownFailureError(
          definition.toolName,
          `HTTP callback ${definition.toolName} echoed credential material.`,
          { cause },
        );
      }
    }
    const contentType = result.response.headers.get("content-type") ?? "text/plain";
    const resultText = responseBody.trim();
    return {
      artifacts: [
        callbackArtifact(
          responseBody,
          contentType,
          request,
          result.response.status,
          input.maximumArtifactCharacters,
        ),
      ],
      outputSummary: !resultText
        ? `HTTP callback ${definition.toolName} completed with status ${result.response.status}.`
        : resultText.length <= MAX_RUNTIME_CALLBACK_OUTPUT_SUMMARY_CHARACTERS
          ? resultText
          : `${resultText.slice(0, MAX_RUNTIME_CALLBACK_OUTPUT_SUMMARY_CHARACTERS - 14)}\n[truncated]`,
      status: "completed",
    };
  } catch (cause) {
    if (
      cause instanceof RuntimeHttpCallbackKnownFailureError ||
      cause instanceof RuntimeHttpCallbackOutcomeUnknownError ||
      cause instanceof RuntimeHttpCallbackRetryableError
    ) {
      throw cause;
    }
    if (input.effect !== "read" && dispatched) {
      throw new RuntimeHttpCallbackOutcomeUnknownError(definition.toolName, { cause });
    }
    if (knownConfigurationFailure(cause)) {
      throw new RuntimeHttpCallbackKnownFailureError(
        definition.toolName,
        `HTTP callback ${definition.toolName} endpoint is not an allowed public HTTPS target.`,
        { cause },
      );
    }
    throw new RuntimeHttpCallbackRetryableError(definition.toolName, { cause });
  }
}
