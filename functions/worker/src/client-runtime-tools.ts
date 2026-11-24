import {
  RuntimeToolExecutionKnownFailureError,
  type RuntimeToolAllowedDecision,
  type RuntimeToolExecutionBinding,
  type RuntimeToolExecutionResult,
} from "@deployments-ai/agent-runtime";
import Ajv, { type ValidateFunction } from "ajv";
import {
  assertExecutionPlanMatches,
  BUILTIN_EXECUTION_CONNECTION_ID,
  type RuntimeClientExecutionPlan,
} from "./runtime-tool-planning.ts";
import type { RuntimeToolBindingRequest } from "./runtime-tools.ts";

/** Default client tool result deadline when the extension does not declare timeoutMs. */
const CLIENT_TOOL_DEFAULT_TIMEOUT_MS = 15 * 60_000;

const clientInputValidator = new Ajv({ allErrors: true, strict: false });
const clientInputValidators = new WeakMap<object, ValidateFunction>();

/** Client tools need no provider connection; the binding pins only the adapter plan. */
export function clientExecutionBinding(
  plan: RuntimeClientExecutionPlan,
): RuntimeToolExecutionBinding {
  return {
    authorizationFingerprint: `client:${plan.adapter.toolName}`,
    connectionId: BUILTIN_EXECUTION_CONNECTION_ID,
    externalAccountId: `client:${plan.adapter.toolName}`,
    ...(plan.adapter.toolAdapterId ? { toolAdapterId: plan.adapter.toolAdapterId } : {}),
    toolPlanFingerprint: plan.fingerprint,
  };
}

/** Whether an authorization decision pinned a client-executed tool (see `clientExecutionBinding`). */
export function isClientExecutionBinding(
  binding: RuntimeToolExecutionBinding | undefined,
): boolean {
  return (
    binding !== undefined &&
    binding.connectionId === BUILTIN_EXECUTION_CONNECTION_ID &&
    binding.authorizationFingerprint.startsWith("client:") &&
    binding.externalAccountId === binding.authorizationFingerprint
  );
}

function knownFailure(toolName: string, message: string): RuntimeToolExecutionKnownFailureError {
  return new RuntimeToolExecutionKnownFailureError(toolName, new Error(message));
}

/**
 * Pauses the run for a client-executed tool. The worker performs no network I/O: the calling
 * client reads the input from the tool call and submits the output through the results route.
 */
export function pauseClientToolCall(
  plan: RuntimeClientExecutionPlan,
  request: RuntimeToolBindingRequest & {
    readonly decision: RuntimeToolAllowedDecision;
    readonly executionKind?: "agent-run" | "workflow";
  },
  now: Date,
): RuntimeToolExecutionResult {
  if (request.executionKind === "workflow") {
    throw knownFailure(
      request.toolName,
      `Client tool ${request.toolName} cannot run in a workflow without an interactive caller.`,
    );
  }
  const binding = request.decision.executionBinding;
  const expected = clientExecutionBinding(plan);
  if (
    !binding ||
    binding.authorizationFingerprint !== expected.authorizationFingerprint ||
    binding.connectionId !== expected.connectionId ||
    binding.externalAccountId !== expected.externalAccountId ||
    binding.toolAdapterId !== expected.toolAdapterId
  ) {
    throw knownFailure(
      request.toolName,
      `Client tool ${request.toolName} is missing its authorized execution binding.`,
    );
  }
  assertExecutionPlanMatches(binding, request, plan);
  const schema = plan.adapter.inputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw knownFailure(request.toolName, `Client tool ${request.toolName} has no input schema.`);
  }
  let validate = clientInputValidators.get(schema);
  if (!validate) {
    try {
      validate = clientInputValidator.compile(schema);
    } catch {
      throw knownFailure(
        request.toolName,
        `Client tool ${request.toolName} has an invalid input schema.`,
      );
    }
    clientInputValidators.set(schema, validate);
  }
  if (!validate(request.input ?? {})) {
    throw knownFailure(
      request.toolName,
      `Client tool ${request.toolName} input does not match its schema.`,
    );
  }
  const timeoutMs = plan.execution.timeoutMs ?? CLIENT_TOOL_DEFAULT_TIMEOUT_MS;
  return {
    client: {
      expiresAt: new Date(now.getTime() + timeoutMs).toISOString(),
      ...(plan.adapter.outputSchema ? { outputSchema: plan.adapter.outputSchema } : {}),
    },
    externalOperationId: request.decision.toolCallId,
    outputSummary: `Waiting for the client to run ${request.toolName}.`,
    status: "running",
  };
}
