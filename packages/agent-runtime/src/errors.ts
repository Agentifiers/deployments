import type {
  RuntimeArtifactContinuation,
  RuntimeCompletedToolCall,
  RuntimeModelContinuation,
  RuntimePendingAction,
  RuntimeRetriedToolCall,
  RuntimeToolDecision,
  RuntimeUsageEntry,
} from "./types.ts";
import type { RuntimeModelInvocationAttempt } from "./model-generation-types.ts";

const runtimeExecutionFailureStateKey = Symbol(
  "@deployments-ai/agent-runtime/runtime-execution-failure-state",
);

export interface RuntimeExecutionFailureState {
  readonly artifactContinuation: RuntimeArtifactContinuation;
  readonly completedToolCalls: readonly RuntimeCompletedToolCall[];
  readonly modelContinuation?: RuntimeModelContinuation;
  readonly usage: readonly RuntimeUsageEntry[];
}

type RuntimeExecutionFailureCarrier = {
  readonly [runtimeExecutionFailureStateKey]?: RuntimeExecutionFailureState;
};

export function withRuntimeExecutionFailureState(
  cause: unknown,
  state: RuntimeExecutionFailureState,
): unknown {
  const target =
    cause instanceof Error
      ? cause
      : new Error(
          typeof cause === "string" && cause.trim() ? cause.trim() : "Agent runtime failed.",
        );
  try {
    Object.defineProperty(target, runtimeExecutionFailureStateKey, {
      configurable: false,
      enumerable: false,
      value: state,
      writable: false,
    });
    return target;
  } catch {
    return new RuntimeExecutionFailedError(target, state);
  }
}

export function runtimeExecutionFailureState(
  cause: unknown,
): RuntimeExecutionFailureState | undefined {
  if (!cause || (typeof cause !== "object" && typeof cause !== "function")) return undefined;
  return (cause as RuntimeExecutionFailureCarrier)[runtimeExecutionFailureStateKey];
}

export class RuntimeExecutionFailedError extends Error {
  readonly [runtimeExecutionFailureStateKey]: RuntimeExecutionFailureState;

  constructor(
    readonly runtimeCause: unknown,
    state: RuntimeExecutionFailureState,
  ) {
    super("Agent runtime failed.", { cause: runtimeCause });
    this.name = "RuntimeExecutionFailedError";
    this[runtimeExecutionFailureStateKey] = state;
  }
}

export class RuntimeRunCanceledError extends Error {
  constructor(
    readonly phase: string,
    readonly pendingAction?: RuntimePendingAction,
  ) {
    super(`Agent run was canceled before ${phase}.`);
    this.name = "RuntimeRunCanceledError";
  }
}

/**
 * Abort reason a draining host uses to stop an in-flight run at its drain deadline. The runtime
 * reports such a stop as `interrupted`, never `canceled`, so the host can requeue the run.
 */
export class RuntimeHostShutdownError extends Error {
  constructor() {
    super("Agent run was interrupted because its worker host is shutting down.");
    this.name = "RuntimeHostShutdownError";
  }
}

/** Whether the signal was aborted by a draining host rather than by cancellation or claim loss. */
export function isRuntimeHostShutdown(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason instanceof RuntimeHostShutdownError;
}

export class RuntimeArtifactPublicationError extends Error {
  readonly artifactPersisted: boolean;

  constructor(message: string, options?: ErrorOptions & { readonly artifactPersisted?: boolean }) {
    super(message, options);
    this.name = "RuntimeArtifactPublicationError";
    this.artifactPersisted = options?.artifactPersisted === true;
  }
}

export class RuntimeArtifactPersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeArtifactPersistenceError";
  }
}

export class RuntimeArtifactValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeArtifactValidationError";
  }
}

export class RuntimeModelInvocationPersistenceError extends Error {
  constructor(
    readonly attempt: RuntimeModelInvocationAttempt,
    readonly persistenceCause: unknown,
  ) {
    super(`Model invocation ${attempt.attemptId} could not be persisted.`, {
      cause: persistenceCause,
    });
    this.name = "RuntimeModelInvocationPersistenceError";
  }

  get attemptId() {
    return this.attempt.attemptId;
  }
}

export class RuntimeToolDeniedError extends Error {
  constructor(readonly decision: RuntimeToolDecision) {
    super(`Tool call ${decision.toolCallId} was denied: ${decision.reason}`);
    this.name = "RuntimeToolDeniedError";
  }
}

export class RuntimeToolRecoveryRequiredError extends Error {
  constructor(
    readonly pendingAction: RuntimePendingAction,
    readonly handlingCause: unknown,
  ) {
    super(
      `Tool ${pendingAction.toolName} has an unknown execution outcome and requires reconciliation.`,
      { cause: handlingCause },
    );
    this.name = "RuntimeToolRecoveryRequiredError";
  }
}

export class RuntimeToolExecutionKnownFailureError extends Error {
  constructor(
    readonly toolName: string,
    readonly executionCause: unknown,
  ) {
    super(`Tool ${toolName} failed without an ambiguous execution outcome.`, {
      cause: executionCause,
    });
    this.name = "RuntimeToolExecutionKnownFailureError";
  }
}

export class RuntimeToolPreparationRetryableError extends Error {
  constructor(
    readonly toolName: string,
    readonly preparationCause: unknown,
    /** The failing read and its failures so far, set by the runtime for the worker to persist. */
    readonly retriedToolCall?: RuntimeRetriedToolCall,
  ) {
    super(`Tool ${toolName} preparation failed before provider dispatch.`, {
      cause: preparationCause,
    });
    this.name = "RuntimeToolPreparationRetryableError";
  }
}

export class RuntimeAsyncSandboxCommandError extends Error {
  constructor(readonly operationId: string) {
    super(
      `Sandbox command started asynchronous operation ${operationId}; asynchronous exec is unsupported.`,
    );
    this.name = "RuntimeAsyncSandboxCommandError";
  }
}
