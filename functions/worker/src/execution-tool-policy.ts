import {
  RuntimeDeploymentRequiredError,
  type AgentRunExecutionPins,
  type AgentRuntimeDependencies,
  type RuntimeToolDecision,
  type RuntimeToolExecutionResult,
} from "@deployments-ai/agent-runtime";
import type { ExecutionBindingToolPolicy } from "@deployments-ai/db";
import { isClientExecutionBinding } from "./client-runtime-tools.ts";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tool-planning.ts";

type AuthorizeToolCall = NonNullable<AgentRuntimeDependencies["authorizeToolCall"]>;

export const EVALUATION_WRITE_DENIAL_REASON =
  "Evaluation tool policy denies write and execute tools.";
export const EVALUATION_APPROVAL_REJECTION_REASON =
  "Evaluation tool policy rejects approval-gated tool calls.";
export const EVALUATION_CLIENT_TOOL_DENIAL_REASON =
  "Evaluation tool policy denies client-executed tools; no client answers evaluation runs.";
const DEPLOYMENT_OWNED_TOOL_DEFERRAL_REASON =
  "Deployment-owned tool deferred to its executor, which refuses preview and evaluation runs.";

/**
 * Built-ins whose effects outlive a preview or evaluation binding, keyed to the capability they
 * need: delegated children and schedules are production runs of a deployment. Their executors
 * refuse bound runs with a model-visible result (see `deploymentOwnedBuiltin`), so bound-run
 * policies let them through without approval instead of failing or pausing the run.
 */
const DEPLOYMENT_OWNED_BUILTIN_CAPABILITIES: Readonly<Record<string, string>> = {
  "agent.delegate": "Agent delegation",
  "agent.schedule.archive": "Scheduling",
  "agent.schedule.create": "Scheduling",
  "agent.schedule.remind": "Scheduling",
  "app.create": "Agent-built apps",
  "app.dev_token": "Agent-built apps",
  "app.migrate": "Agent-built apps",
  "app.promote": "Agent-built apps",
  "app.release": "Agent-built apps",
  "app.set_publication": "Agent-built apps",
};

function deploymentOwnedToolPreflight(
  request: AgentRunExecutionPins & { readonly toolName: string },
): RuntimeToolExecutionResult | undefined {
  if (!Object.hasOwn(DEPLOYMENT_OWNED_BUILTIN_CAPABILITIES, request.toolName)) {
    throw new Error(`Runtime tool ${request.toolName} is not a deployment-owned built-in.`);
  }
  const capability = DEPLOYMENT_OWNED_BUILTIN_CAPABILITIES[request.toolName]!;
  if (request.agentDeploymentId !== undefined) return undefined;
  const reason = new RuntimeDeploymentRequiredError(capability).message;
  return {
    output: { denied: true, reason },
    outputSummary: `Tool ${request.toolName} failed: ${reason}`,
    status: "completed",
  };
}

/**
 * Marks an executor as deployment-owned: a bound run (no deployment pin) gets a completed tool
 * result describing the denial, which the model reads and recovers from, before any read,
 * mutation claim, or side effect.
 */
export function deploymentOwnedBuiltin(
  execute: ExecuteRuntimeBuiltinTool,
): ExecuteRuntimeBuiltinTool {
  return Object.assign(execute, { preflight: deploymentOwnedToolPreflight });
}

function deferredToExecutor(decision: RuntimeToolDecision): RuntimeToolDecision {
  if (decision.action !== "require-approval") return decision;
  return {
    action: "allow",
    ...(decision.executionBinding ? { executionBinding: decision.executionBinding } : {}),
    reason: DEPLOYMENT_OWNED_TOOL_DEFERRAL_REASON,
    toolCallId: decision.toolCallId,
  };
}

/**
 * Evaluation bindings: only read-effect tools run, approval-gated calls are rejected instead of
 * waiting for a reviewer, and client-executed tools are denied whatever their effect because no
 * client ever answers an evaluation run. Each of those denials fails the run. Deployment-owned
 * built-ins are the exception: they reach their executors, which refuse them model-visibly.
 */
function evaluationToolAuthorization(authorize: AuthorizeToolCall): AuthorizeToolCall {
  return async (request) => {
    // The underlying authorization only plans and evaluates policy; it identifies client tools.
    const decision = await authorize(request);
    if (decision.action !== "deny" && isClientExecutionBinding(decision.executionBinding)) {
      return {
        action: "deny",
        reason: EVALUATION_CLIENT_TOOL_DENIAL_REASON,
        toolCallId: decision.toolCallId,
      };
    }
    if (Object.hasOwn(DEPLOYMENT_OWNED_BUILTIN_CAPABILITIES, request.toolName)) {
      return deferredToExecutor(decision);
    }
    if (request.effect !== "read") {
      return {
        action: "deny",
        reason: EVALUATION_WRITE_DENIAL_REASON,
        toolCallId: decision.toolCallId,
      };
    }
    return decision.action === "require-approval"
      ? {
          action: "deny",
          reason: EVALUATION_APPROVAL_REJECTION_REASON,
          toolCallId: decision.toolCallId,
        }
      : decision;
  };
}

/**
 * Tool authorization for a run executing an execution binding. Interactive (preview) bindings keep
 * the manifest's authorization except that deployment-owned built-ins skip approval, since their
 * executors refuse bound runs anyway; evaluation bindings apply `evaluationToolAuthorization`.
 */
export function boundRunToolAuthorization(
  authorize: AuthorizeToolCall,
  toolPolicy: ExecutionBindingToolPolicy,
): AuthorizeToolCall {
  if (toolPolicy === "evaluation") return evaluationToolAuthorization(authorize);
  return async (request) => {
    const decision = await authorize(request);
    return Object.hasOwn(DEPLOYMENT_OWNED_BUILTIN_CAPABILITIES, request.toolName)
      ? deferredToExecutor(decision)
      : decision;
  };
}
