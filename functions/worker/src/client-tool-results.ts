import Ajv, { type ValidateFunction } from "ajv";
import { AGENT_DELEGATE_TOOL_NAME } from "@deployments-ai/agent-manifest";
import { ApprovalResolutionError } from "./approval-shared.ts";
import type { ToolCallRecordValue } from "./types.ts";

type ToolOutput = Readonly<Record<string, unknown>>;

/** Largest structured tool output accepted from a result submission (UTF-8 JSON bytes). */
export const MAX_TOOL_RESULT_OUTPUT_BYTES = 96 * 1024;
export const CLIENT_TOOL_EXPIRED_SUMMARY = "Client tool did not return a result before it expired.";

const outputSchemaValidator = new Ajv({ allErrors: true, strict: false });
const outputValidators = new WeakMap<object, ValidateFunction>();
const utf8Encoder = new TextEncoder();

function isClientToolCall(toolCall: ToolCallRecordValue): boolean {
  return toolCall.data.executionType === "client";
}

/**
 * Client tool calls and awaited `agent.delegate` calls resume the run for both outcomes so the
 * model can recover from a client or sub-agent failure; other asynchronous tools resume only on
 * completion.
 */
export function resumesAfterToolResult(
  toolCall: ToolCallRecordValue,
  outcome: "completed" | "failed",
): boolean {
  return (
    outcome === "completed" ||
    isClientToolCall(toolCall) ||
    toolCall.data.toolName === AGENT_DELEGATE_TOOL_NAME
  );
}

/** Client tool calls correlate by their own id when the caller omits externalOperationId. */
export function toolResultExternalOperationId(
  toolCall: ToolCallRecordValue,
  provided: string | undefined,
): string | undefined {
  return provided ?? (isClientToolCall(toolCall) ? toolCall.data.id : undefined);
}

export function clientToolCallExpired(toolCall: ToolCallRecordValue, now: Date): boolean {
  return (
    isClientToolCall(toolCall) &&
    toolCall.data.expiresAt !== undefined &&
    Date.parse(toolCall.data.expiresAt) <= now.getTime()
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sameToolOutput(
  persisted: ToolOutput | undefined,
  submitted: ToolOutput | undefined,
): boolean {
  if (persisted === undefined || submitted === undefined) return persisted === submitted;
  return stableJson(persisted) === stableJson(submitted);
}

/**
 * Validates a submitted tool result before it is persisted. Returns the structured output to
 * store on the tool call, if any.
 */
export function acceptedToolResultOutput(
  toolCall: ToolCallRecordValue,
  outcome: "completed" | "failed",
  output: ToolOutput | undefined,
): ToolOutput | undefined {
  if (output === undefined) {
    if (outcome === "completed" && isClientToolCall(toolCall)) {
      throw new ApprovalResolutionError(
        "invalid_tool_output",
        "Completed client tool results require a structured output object.",
      );
    }
    return undefined;
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new ApprovalResolutionError(
      "invalid_tool_output",
      "Tool result output must be a JSON object.",
    );
  }
  if (utf8Encoder.encode(JSON.stringify(output)).byteLength > MAX_TOOL_RESULT_OUTPUT_BYTES) {
    throw new ApprovalResolutionError(
      "invalid_tool_output",
      `Tool result output must be at most ${MAX_TOOL_RESULT_OUTPUT_BYTES} UTF-8 bytes.`,
    );
  }
  const schema = toolCall.data.outputSchema;
  if (outcome === "completed" && isClientToolCall(toolCall) && schema) {
    let validate = outputValidators.get(schema);
    if (!validate) {
      try {
        validate = outputSchemaValidator.compile(schema);
      } catch {
        throw new ApprovalResolutionError(
          "invalid_tool_output_schema",
          `Client tool ${toolCall.data.toolName} has an invalid output schema.`,
        );
      }
      outputValidators.set(schema, validate);
    }
    if (!validate(output)) {
      throw new ApprovalResolutionError(
        "invalid_tool_output",
        `Client tool ${toolCall.data.toolName} output does not match its output schema.`,
      );
    }
  }
  return output;
}
