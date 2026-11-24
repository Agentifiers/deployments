import { appendProgress } from "./runtime-core.ts";
import type {
  AgentRunInput,
  AgentRuntimeDependencies,
  RuntimeToolDecision,
  RuntimeToolExecutionResult,
  RuntimeToolRequest,
} from "./types.ts";

export async function appendToolExecutionStarted(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
  request: RuntimeToolRequest,
  decision: RuntimeToolDecision,
) {
  await appendProgress(input, dependencies, {
    eventType: "tool.running",
    level: "info",
    message: `Running tool ${request.toolName}.`,
    metadata: {
      inputSummary: request.inputSummary,
      toolCallId: decision.toolCallId,
      toolName: request.toolName,
    },
  });
}

export async function appendToolExecutionResult(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
  request: RuntimeToolRequest,
  decision: RuntimeToolDecision,
  result: RuntimeToolExecutionResult,
) {
  try {
    await appendProgress(input, dependencies, {
      eventType: result.status === "completed" ? "tool.completed" : "tool.running",
      level: "info",
      message:
        result.status === "completed"
          ? `Tool ${request.toolName} completed.`
          : `Tool ${request.toolName} is still running.`,
      metadata: {
        toolCallId: decision.toolCallId,
        toolName: request.toolName,
      },
    });
  } catch {
    // A known external tool result must never be displaced by cosmetic progress.
  }
}

export async function appendToolExecutionFailure(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
  request: RuntimeToolRequest,
  decision: RuntimeToolDecision,
) {
  try {
    await appendProgress(input, dependencies, {
      eventType: "tool.failed",
      level: "error",
      message: `Tool ${request.toolName} failed.`,
      metadata: {
        toolCallId: decision.toolCallId,
        toolName: request.toolName,
      },
    });
  } catch {
    // A definitive tool failure must never be displaced by cosmetic progress.
  }
}
