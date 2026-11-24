const INBOUND_OPERATIONS = new Set([
  "dispatch-workflow",
  "load-receipt-source",
  "persist-message",
  "process-receipt",
  "reconcile-message",
  "reserve-thread",
  "resolve-recipients",
]);

type AgentEmailInboundOperation =
  | "dispatch-workflow"
  | "load-receipt-source"
  | "persist-message"
  | "process-receipt"
  | "reconcile-message"
  | "reserve-thread"
  | "resolve-recipients";

export class AgentEmailInboundOperationError extends Error {
  constructor(
    readonly operation: AgentEmailInboundOperation,
    cause: unknown,
  ) {
    super("Agent email inbound operation failed.", { cause });
    this.name = "AgentEmailInboundOperationError";
  }
}

export async function withAgentEmailInboundOperation<Value>(
  operation: AgentEmailInboundOperation,
  run: () => Promise<Value>,
) {
  try {
    return await run();
  } catch (cause) {
    throw new AgentEmailInboundOperationError(operation, cause);
  }
}

function errorRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object"
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function safeErrorIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value)
    ? value
    : undefined;
}

function providerStatusCode(...values: readonly unknown[]) {
  for (const value of values) {
    const status = errorRecord(errorRecord(value)?.$metadata)?.httpStatusCode;
    if (
      typeof status === "number" &&
      Number.isSafeInteger(status) &&
      status >= 100 &&
      status <= 599
    ) {
      return status;
    }
  }
  return undefined;
}

export function agentEmailInboundErrorDiagnostic(cause: unknown) {
  const inboundOperations: AgentEmailInboundOperation[] = [];
  let persistenceOperation: string | undefined;
  let failure = cause;
  for (let depth = 0; depth < 4; depth += 1) {
    const outer = errorRecord(failure);
    if (failure instanceof AgentEmailInboundOperationError) {
      if (INBOUND_OPERATIONS.has(failure.operation)) inboundOperations.push(failure.operation);
      failure = failure.cause;
      continue;
    }
    if (outer?._tag === "AgentEmailPersistenceError") {
      persistenceOperation = safeErrorIdentifier(outer.operation);
      failure = outer.cause;
      continue;
    }
    break;
  }
  const value = errorRecord(failure);
  const tag = value?._tag;
  const taggedErrorType = tag === "DatabaseError" || tag === "RecordDecodeError" ? tag : undefined;
  const errorType =
    taggedErrorType ??
    safeErrorIdentifier(failure instanceof Error ? failure.name : value?.name) ??
    "UnknownError";
  const nestedCause = errorRecord(value?.cause);
  const databaseOperation = safeErrorIdentifier(value?.operation);
  const databaseTable = safeErrorIdentifier(value?.table);
  const databaseReason =
    value?.reason === "conflict" || value?.reason === "unknown" ? value.reason : undefined;
  const statusCode = providerStatusCode(failure, value?.cause);
  return {
    ...(taggedErrorType === "DatabaseError" && databaseOperation ? { databaseOperation } : {}),
    ...(taggedErrorType === "DatabaseError" && databaseReason ? { databaseReason } : {}),
    ...(taggedErrorType === "DatabaseError" && databaseTable ? { databaseTable } : {}),
    errorType,
    ...(inboundOperations.length > 0 ? { inboundOperations } : {}),
    ...(nestedCause
      ? {
          nestedErrorType:
            safeErrorIdentifier(
              value?.cause instanceof Error ? value.cause.name : nestedCause.name,
            ) ?? "UnknownError",
        }
      : {}),
    ...(persistenceOperation ? { persistenceOperation } : {}),
    ...(statusCode ? { providerStatusCode: statusCode } : {}),
  };
}
