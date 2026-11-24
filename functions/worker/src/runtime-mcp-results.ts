import {
  RuntimeToolExecutionKnownFailureError,
  type RuntimeToolExecutionResult,
} from "@deployments-ai/agent-runtime";
import { RemoteMcpError, type RemoteMcpToolCallResult } from "@deployments-ai/mcp-client";
import { assertNoCredentialLeak, type ToolAdapterDefinition } from "@deployments-ai/tools";
import Ajv, { type ValidateFunction } from "ajv";
import type { AuthorizedRuntimeToolBindingRequest } from "./runtime-tool-planning.ts";

/** Shared remote MCP execution mechanics for tenant and vendor MCP servers. */

export const DEFAULT_RUNTIME_MCP_ARTIFACT_MAX_CHARACTERS = 48_000;
export const DEFAULT_RUNTIME_MCP_TIMEOUT_MS = 60_000;
const MAX_RUNTIME_MCP_OUTPUT_SUMMARY_CHARACTERS = 4_000;
const MAX_RUNTIME_MCP_SERVER_METADATA_BYTES = 256;
const inputSchemaValidator = new Ajv({ allErrors: true, strict: false });
const inputValidators = new WeakMap<object, ValidateFunction>();
const utf8Encoder = new TextEncoder();

export class RuntimeMcpBindingValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeMcpBindingValidationError";
  }
}

export function positiveRuntimeMcpInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return resolved;
}

export function validMcpHeaderValue(value: string, label: string): string {
  const normalized = value.trim();
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!normalized || hasControlCharacter) {
    throw new RuntimeMcpBindingValidationError(`${label} is invalid.`);
  }
  return normalized;
}

/** Secret values and header values (and their post-scheme tokens) that must never persist. */
export function mcpCredentialMaterials(
  secretValues: Readonly<Record<string, string>>,
  headers: Readonly<Record<string, string>>,
): ReadonlySet<string> {
  const materials = new Set<string>();
  for (const value of [...Object.values(secretValues), ...Object.values(headers)]) {
    const normalized = value.trim();
    if (!normalized) continue;
    materials.add(normalized);
    const separator = normalized.indexOf(" ");
    if (separator > 0 && normalized.slice(separator + 1).trim()) {
      materials.add(normalized.slice(separator + 1).trim());
    }
  }
  return materials;
}

/** Overlays grant constraints (which win) onto the input and validates the adapter schema. */
export function constrainedMcpArguments(
  definition: ToolAdapterDefinition,
  input: Readonly<Record<string, unknown>> | undefined,
  constraints: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const value = { ...input, ...constraints };
  const schema = definition.inputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new RuntimeMcpBindingValidationError(
      `Runtime MCP tool ${definition.toolName} requires an object input schema.`,
    );
  }
  let validate = inputValidators.get(schema);
  if (!validate) {
    try {
      validate = inputSchemaValidator.compile(schema);
    } catch (cause) {
      throw new RuntimeMcpBindingValidationError(
        `Runtime MCP tool ${definition.toolName} has an invalid input schema.`,
        { cause },
      );
    }
    inputValidators.set(schema, validate);
  }
  if (!validate(value)) {
    throw new RuntimeMcpBindingValidationError(
      `Runtime MCP tool ${definition.toolName} input does not match its schema.`,
    );
  }
  return value;
}

/** Transient transport/server failures; every other remote failure is deterministic. */
export function remoteMcpFailureRetryable(cause: RemoteMcpError): boolean {
  const status = cause.statusCode;
  return (
    cause.code === "timeout" ||
    cause.code === "transport" ||
    (cause.code === "http" &&
      (status === 408 ||
        status === 425 ||
        status === 429 ||
        (status !== undefined && status >= 500)))
  );
}

function boundedSummary(value: string) {
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length <= MAX_RUNTIME_MCP_OUTPUT_SUMMARY_CHARACTERS
    ? normalized
    : `${normalized.slice(0, MAX_RUNTIME_MCP_OUTPUT_SUMMARY_CHARACTERS - 14)}\n[truncated]`;
}

function boundedRemoteMetadata(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const characters: string[] = [];
  let byteLength = 0;
  for (const character of normalized) {
    const characterBytes = utf8Encoder.encode(character).byteLength;
    if (byteLength + characterBytes > MAX_RUNTIME_MCP_SERVER_METADATA_BYTES) break;
    characters.push(character);
    byteLength += characterBytes;
  }
  return characters.join("") || undefined;
}

function outputSummary(result: Readonly<Record<string, unknown>>) {
  const content = result.content;
  if (!Array.isArray(content))
    return boundedSummary(JSON.stringify(result.structuredContent ?? {}));
  const parts = content.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Readonly<Record<string, unknown>>;
    if (item.type === "text" && typeof item.text === "string") return [item.text];
    if (typeof item.type === "string") return [`[${item.type} content]`];
    return [];
  });
  return boundedSummary(parts.join("\n"));
}

function runtimeArtifact(
  call: RemoteMcpToolCallResult,
  request: AuthorizedRuntimeToolBindingRequest,
  mcpToolName: string,
  maximumCharacters: number,
) {
  const serialized = JSON.stringify(call.result, null, 2);
  const truncated = serialized.length > maximumCharacters;
  const body = truncated
    ? `${serialized.slice(0, maximumCharacters - 14)}\n[truncated]\n`
    : `${serialized}\n`;
  return {
    content: body,
    contentType: truncated ? "text/plain; charset=utf-8" : "application/json",
    fileName: `${request.decision.toolCallId}-${mcpToolName.replace(/[^a-zA-Z0-9._-]+/gu, "-")}.mcp.${
      truncated ? "txt" : "json"
    }`,
    label: `${call.serverName ?? "Remote MCP"} tool response`,
    metadata: {
      mcpToolName,
      protocolVersion: call.protocolVersion ?? null,
      resultSummary: { ok: !call.isError, toolName: request.toolName },
      serverName: call.serverName ?? null,
      serverVersion: call.serverVersion ?? null,
      source: "mcp.remote",
      toolCallId: request.decision.toolCallId,
      toolName: request.toolName,
      truncated,
    },
    type: "report",
    visibility: "private",
  } as const;
}

/**
 * Turns a remote MCP call into the persisted tool result: fails closed when the response echoes
 * credential material, bounds server metadata, and records a private report artifact. Remote
 * `isError` results still complete so the model sees the tool's error.
 */
export function completedMcpExecution(input: {
  readonly call: RemoteMcpToolCallResult;
  readonly maximumCharacters: number;
  readonly mcpToolName: string;
  readonly request: AuthorizedRuntimeToolBindingRequest;
  readonly sensitiveMaterials: ReadonlySet<string>;
}): RuntimeToolExecutionResult {
  const { call, mcpToolName, request } = input;
  try {
    const persistedRemoteData = {
      protocolVersion: call.protocolVersion ?? null,
      result: call.result,
      serverName: call.serverName ?? null,
      serverVersion: call.serverVersion ?? null,
    };
    assertNoCredentialLeak(
      JSON.stringify(persistedRemoteData),
      input.sensitiveMaterials,
      persistedRemoteData,
    );
  } catch (cause) {
    throw new RuntimeToolExecutionKnownFailureError(request.toolName, cause);
  }
  const serverName = boundedRemoteMetadata(call.serverName);
  const serverVersion = boundedRemoteMetadata(call.serverVersion);
  const persistedCall: RemoteMcpToolCallResult = {
    isError: call.isError,
    ...(call.protocolVersion ? { protocolVersion: call.protocolVersion } : {}),
    result: call.result,
    ...(serverName ? { serverName } : {}),
    ...(serverVersion ? { serverVersion } : {}),
  };
  const summary = outputSummary(call.result);
  return {
    artifacts: [runtimeArtifact(persistedCall, request, mcpToolName, input.maximumCharacters)],
    outputSummary: call.isError
      ? `MCP tool ${mcpToolName} reported an error${summary ? `: ${summary}` : "."}`
      : (summary ?? `MCP tool ${mcpToolName} completed.`),
    status: "completed",
  };
}
