import { AGENT_DELEGATE_TOOL_NAME } from "@deployments-ai/agent-manifest";
import type { RuntimePendingAction } from "@deployments-ai/agent-runtime";
import { key } from "@deployments-ai/db";
import { TERMINAL_STATUSES } from "./agent-run-input.ts";
import { loadRunDelegation, type RunDelegation } from "./agent-delegation-targets.ts";
import { ApprovalResolutionError, queueMessage } from "./approval-shared.ts";
import { queryRecordPages } from "./builtin-tool-support.ts";
import { MAX_TOOL_RESULT_OUTPUT_BYTES } from "./client-tool-results.ts";
import { runToolContinuation } from "./continuation.ts";
import { loadFinalizedMessageForRun, loadThreadRunById } from "./records.ts";
import { resolveRunToolResult } from "./tool-result-resolution.ts";
import type { AgentRunWorkerDependencies, RunRecordValue, ToolCallRecordValue } from "./types.ts";

const encoder = new TextEncoder();
// Leaves headroom inside the structured tool output ceiling for the result envelope.
const MAX_CHILD_ANSWER_BYTES = MAX_TOOL_RESULT_OUTPUT_BYTES - 4 * 1_024;

function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

/** The longest prefix of text whose JSON encoding fits the byte budget. */
function fittingPrefix(text: string, maximumBytes: number): string {
  if (jsonBytes(text) <= maximumBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(text.slice(0, middle)) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  // Never split a UTF-16 surrogate pair.
  const code = text.charCodeAt(low - 1);
  return code >= 0xd800 && code <= 0xdbff ? text.slice(0, low - 1) : text.slice(0, low);
}

async function completedChildOutput(
  dependencies: AgentRunWorkerDependencies,
  child: RunRecordValue,
): Promise<Readonly<Record<string, unknown>>> {
  const message = await loadFinalizedMessageForRun(
    dependencies.database,
    queueMessage(child),
    child,
  );
  if (!message) {
    throw new Error(`Completed sub-agent run ${child.data.id} has no finalized message yet.`);
  }
  let body = message.data.body;
  if (body === undefined) {
    if (!dependencies.readMessageBody) {
      throw new Error("Reading an externalized sub-agent answer requires a message body reader.");
    }
    body = await dependencies.readMessageBody(message);
  }
  const envelope = {
    childRunId: child.data.id,
    childThreadId: child.data.threadId,
    status: "completed",
  };
  // Completion already validated structured answers against the child's response format.
  if (child.data.responseFormat) {
    const structuredOutput = JSON.parse(body) as unknown;
    if (jsonBytes(structuredOutput) <= MAX_CHILD_ANSWER_BYTES) {
      return { ...envelope, structuredOutput };
    }
  }
  const finalMessage = fittingPrefix(body, MAX_CHILD_ANSWER_BYTES);
  return {
    ...envelope,
    finalMessage,
    ...(finalMessage.length < body.length ? { finalMessageTruncated: true } : {}),
  };
}

function childFailureSummary(child: RunRecordValue): string {
  if (child.data.status === "canceled") return `Sub-agent run ${child.data.id} was canceled.`;
  const reason = child.data.error?.message;
  return typeof reason === "string" && reason.trim()
    ? `Sub-agent run ${child.data.id} failed: ${reason}`
    : `Sub-agent run ${child.data.id} failed.`;
}

/** Every `agent.delegate` tool call of the parent correlated to this child run. */
async function awaitingToolCalls(
  dependencies: AgentRunWorkerDependencies,
  parent: RunRecordValue,
  childRunId: string,
): Promise<readonly ToolCallRecordValue[]> {
  const items = await queryRecordPages({
    database: dependencies.database,
    input: {
      ConsistentRead: true,
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": key("ORG", parent.data.organizationId, "RUN", parent.data.id),
        ":prefix": "TOOL-CALL#",
      },
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
    },
    table: "execution",
  });
  return items.filter(
    (item): item is ToolCallRecordValue =>
      item.itemType === "tool-call" &&
      item.data.runId === parent.data.id &&
      item.data.toolName === AGENT_DELEGATE_TOOL_NAME &&
      item.data.externalOperationId === childRunId,
  );
}

/**
 * Resolves the parent's awaited `agent.delegate` tool call from a terminal child run. Completed
 * children resume the parent with their answer; failed or canceled children fail the tool call and
 * resume the parent with the failure so the model can recover. A canceled parent keeps its canceled status: the child is not canceled
 * with it, and its result is only reconciled onto the open tool call. A parent that has not
 * paused yet is resolved by its own pause publication instead. Redelivery replays the identical
 * persisted resolution so an interrupted resume publication is completed exactly once.
 */
export async function resolveAwaitedDelegation(
  dependencies: AgentRunWorkerDependencies,
  child: RunRecordValue,
  knownLink?: RunDelegation,
): Promise<void> {
  if (!TERMINAL_STATUSES.has(child.data.status) || child.data.parentSpanId === undefined) return;
  const link =
    knownLink ??
    (await loadRunDelegation(dependencies.database, child.data.organizationId, child.data.id));
  if (!link?.data.awaitResult) return;
  const parent = await loadThreadRunById(
    dependencies.database,
    {
      environmentId: link.data.environmentId,
      organizationId: link.data.organizationId,
      projectId: link.data.projectId,
      threadId: link.data.parentThreadId,
    },
    link.data.parentRunId,
  );
  if (!parent) return;
  const toolCalls = await awaitingToolCalls(dependencies, parent, child.data.id);
  if (toolCalls.length === 0) return;
  const pending = runToolContinuation(parent).pendingAction;
  const completed = child.data.status === "completed";
  const output = completed ? await completedChildOutput(dependencies, child) : undefined;
  for (const toolCall of toolCalls) {
    if (
      toolCall.data.status === "running" &&
      ((parent.data.status !== "waiting-for-tool" && parent.data.status !== "canceled") ||
        pending?.kind !== "tool" ||
        pending.toolCallId !== toolCall.data.id)
    ) {
      continue;
    }
    try {
      await resolveRunToolResult(
        {
          environmentId: parent.data.environmentId,
          externalOperationId: child.data.id,
          organizationId: parent.data.organizationId,
          outcome: completed ? "completed" : "failed",
          ...(output ? { output } : {}),
          outputSummary: completed
            ? `Sub-agent run ${child.data.id} completed.`
            : childFailureSummary(child),
          projectId: parent.data.projectId,
          runId: parent.data.id,
          threadId: parent.data.threadId,
          toolCallId: toolCall.data.id,
        },
        {
          ...(dependencies.appendThreadEvent
            ? { appendThreadEvent: (event) => dependencies.appendThreadEvent!(event) }
            : {}),
          database: dependencies.database,
          ...(dependencies.enqueueRun
            ? { enqueueRun: dependencies.enqueueRun, enqueueTerminalRun: dependencies.enqueueRun }
            : {}),
          generateId: dependencies.generateId,
          ...(dependencies.now ? { now: dependencies.now } : {}),
        },
      );
    } catch (cause) {
      // A tool call resolved differently (for example by an operator) is left as recorded.
      if (cause instanceof ApprovalResolutionError && cause.code === "tool_call_already_resolved") {
        continue;
      }
      throw cause;
    }
  }
}

/**
 * Closes the race where an awaited child finished before its parent paused: after the parent
 * publishes its `agent.delegate` pause, resolve it immediately from an already-terminal child.
 */
export async function resolvePausedDelegation(
  dependencies: AgentRunWorkerDependencies,
  parent: RunRecordValue,
  pendingAction: RuntimePendingAction,
): Promise<void> {
  if (
    parent.data.status !== "waiting-for-tool" ||
    pendingAction.kind !== "tool" ||
    pendingAction.toolName !== AGENT_DELEGATE_TOOL_NAME
  ) {
    return;
  }
  const link = await loadRunDelegation(
    dependencies.database,
    parent.data.organizationId,
    pendingAction.externalOperationId as RunRecordValue["data"]["id"],
  );
  if (!link?.data.awaitResult || link.data.parentRunId !== parent.data.id) return;
  const child = await loadThreadRunById(
    dependencies.database,
    {
      environmentId: link.data.environmentId,
      organizationId: link.data.organizationId,
      projectId: link.data.projectId,
      threadId: link.data.childThreadId,
    },
    link.data.childRunId,
  );
  if (child) await resolveAwaitedDelegation(dependencies, child, link);
}
