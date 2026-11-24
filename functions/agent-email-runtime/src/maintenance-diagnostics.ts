const MAX_MAINTENANCE_ERROR_DEPTH = 4;
const MAX_MAINTENANCE_NESTED_ERRORS = 20;
const MAX_MAINTENANCE_DIAGNOSTIC_NODES =
  1 + MAX_MAINTENANCE_NESTED_ERRORS * (MAX_MAINTENANCE_ERROR_DEPTH + 1);
const SAFE_MAINTENANCE_ERROR_TYPES = new Set([
  "AbortError",
  "AccessDeniedException",
  "AgentEmailMaintenanceOperationError",
  "AggregateError",
  "ConditionalCheckFailedException",
  "DatabaseError",
  "InternalServerError",
  "NoSuchKey",
  "ProvisionedThroughputExceededException",
  "ResourceNotFoundException",
  "ServiceUnavailable",
  "SyntaxError",
  "ThrottlingException",
  "TimeoutError",
  "TransactionCanceledException",
  "TypeError",
  "ValidationException",
  "Error",
]);

export interface AgentEmailMaintenanceErrorDiagnostic {
  readonly cause?: AgentEmailMaintenanceErrorDiagnostic;
  readonly errorType: string;
  readonly errors?: readonly AgentEmailMaintenanceErrorDiagnostic[];
  readonly operation?: AgentEmailMaintenanceOperation;
  readonly providerStatusCode?: number;
}

export interface AgentEmailMaintenanceLogDiagnostic {
  readonly errorTypes: readonly string[];
  readonly operations?: readonly AgentEmailMaintenanceOperation[];
  readonly providerStatusCodes?: readonly number[];
}

export type AgentEmailMaintenanceOperation =
  | "content cleanup"
  | "enqueue"
  | "raw-object purge"
  | "scheduled-send lookup";

export class AgentEmailMaintenanceOperationError extends Error {
  readonly operation: AgentEmailMaintenanceOperation;

  constructor(operation: AgentEmailMaintenanceOperation, cause: unknown) {
    super("Agent email maintenance operation failed.", { cause });
    this.name = "AgentEmailMaintenanceOperationError";
    this.operation = operation;
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function errorType(cause: unknown) {
  const candidate = cause instanceof Error ? cause.name : record(cause)?.name;
  return typeof candidate === "string" && SAFE_MAINTENANCE_ERROR_TYPES.has(candidate)
    ? candidate
    : "UnknownError";
}

function unsafeAgentEmailMaintenanceErrorDiagnostic(
  cause: unknown,
  budget: { remaining: number },
  depth: number,
): AgentEmailMaintenanceErrorDiagnostic {
  if (budget.remaining <= 0) return { errorType: "DiagnosticLimitReached" };
  budget.remaining -= 1;
  const value = record(cause);
  const metadata = record(value?.$metadata);
  const providerStatusCode = metadata?.httpStatusCode;
  const nestedCause = cause instanceof Error && "cause" in cause ? cause.cause : undefined;
  const aggregateErrors = cause instanceof AggregateError ? cause.errors : undefined;
  if (aggregateErrors !== undefined && !Array.isArray(aggregateErrors)) {
    throw new Error("AggregateError errors must be an array.");
  }
  const errors: AgentEmailMaintenanceErrorDiagnostic[] = [];
  if (aggregateErrors && depth < MAX_MAINTENANCE_ERROR_DEPTH) {
    for (const error of aggregateErrors.slice(0, MAX_MAINTENANCE_NESTED_ERRORS)) {
      if (budget.remaining <= 0) break;
      errors.push(unsafeAgentEmailMaintenanceErrorDiagnostic(error, budget, depth + 1));
    }
  }
  return {
    ...(nestedCause !== undefined && depth < MAX_MAINTENANCE_ERROR_DEPTH && budget.remaining > 0
      ? { cause: unsafeAgentEmailMaintenanceErrorDiagnostic(nestedCause, budget, depth + 1) }
      : {}),
    errorType: errorType(cause),
    ...(errors.length > 0 ? { errors } : {}),
    ...(cause instanceof AgentEmailMaintenanceOperationError ? { operation: cause.operation } : {}),
    ...(typeof providerStatusCode === "number" &&
    Number.isSafeInteger(providerStatusCode) &&
    providerStatusCode >= 100 &&
    providerStatusCode <= 599
      ? { providerStatusCode }
      : {}),
  };
}

export function agentEmailMaintenanceErrorDiagnostic(
  cause: unknown,
): AgentEmailMaintenanceErrorDiagnostic {
  try {
    return unsafeAgentEmailMaintenanceErrorDiagnostic(
      cause,
      { remaining: MAX_MAINTENANCE_DIAGNOSTIC_NODES },
      0,
    );
  } catch {
    return { errorType: "DiagnosticFormattingError" };
  }
}

export function agentEmailMaintenanceLogDiagnostic(
  cause: unknown,
): AgentEmailMaintenanceLogDiagnostic {
  const pending = [agentEmailMaintenanceErrorDiagnostic(cause)];
  const errorTypes = new Set<string>();
  const operations = new Set<AgentEmailMaintenanceOperation>();
  const providerStatusCodes = new Set<number>();
  let visited = 0;
  while (pending.length > 0 && visited < MAX_MAINTENANCE_DIAGNOSTIC_NODES) {
    const diagnostic = pending.shift();
    if (!diagnostic) break;
    visited += 1;
    errorTypes.add(diagnostic.errorType);
    if (diagnostic.operation) operations.add(diagnostic.operation);
    if (diagnostic.providerStatusCode) providerStatusCodes.add(diagnostic.providerStatusCode);
    if (diagnostic.errors) {
      for (const error of diagnostic.errors.toReversed()) pending.push(error);
    }
    if (diagnostic.cause) pending.push(diagnostic.cause);
  }
  return {
    errorTypes: [...errorTypes],
    ...(operations.size > 0 ? { operations: [...operations] } : {}),
    ...(providerStatusCodes.size > 0 ? { providerStatusCodes: [...providerStatusCodes] } : {}),
  };
}
