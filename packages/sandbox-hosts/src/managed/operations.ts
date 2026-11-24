import {
  type PlatformRecord,
  UNIQUE_CLAIM_CONDITION,
  type Ulid,
  fromDatabase,
  sandboxHostPersistence,
} from "@deployments-ai/db";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Cause, Duration, Effect, Exit } from "effect";
import {
  SandboxAllocationUnknownError,
  SandboxCheckpointUnknownError,
  SandboxDestroyUnknownError,
  SandboxResumeUnknownError,
} from "../types.ts";
import {
  SandboxOperationError,
  type ManagerBase,
  type SandboxLeaseRecordValue,
  type SandboxManagerError,
  type SandboxOperationGuard,
} from "./contracts.ts";
import { acquireLeaseOperationLock } from "./local-lock.ts";
import {
  createRuntimeLeaseRecord,
  hasRuntimeLeaseScope,
  type RuntimeLeaseRecordValue,
  type ScopedRuntimeLeaseRecordValue,
} from "./records.ts";

const PERSISTENCE_RECONCILIATION_ATTEMPTS = 3;
const SANDBOX_OPERATION_RETRY_MS = 25;
const MAX_SANDBOX_OPERATION_RETRY_MS = 1_000;

type RuntimeLeaseScope = Pick<
  SandboxLeaseRecordValue["data"],
  "environmentId" | "id" | "organizationId" | "projectId"
>;

function operationRetryDelay(attempt: number, remainingMs: number) {
  const exponential = Math.min(
    MAX_SANDBOX_OPERATION_RETRY_MS,
    SANDBOX_OPERATION_RETRY_MS * 2 ** Math.min(attempt, 6),
  );
  const jittered = Math.max(1, Math.floor(exponential * (0.5 + Math.random() * 0.5)));
  return Math.min(remainingMs, jittered);
}

export function operationError(
  provider: ManagerBase["provider"],
  operation: string,
  cause: unknown,
  leaseId?: Ulid,
) {
  return new SandboxOperationError({
    cause,
    ...(leaseId ? { leaseId } : {}),
    message: `Sandbox ${operation} failed for provider ${provider.name}.`,
    operation,
    provider: provider.name,
  });
}

export function createOperationRuntime(context: ManagerBase) {
  const {
    provider,
    database,
    operationAcquireTimeoutMs,
    operationLeaseMs,
    operationLeaseNow,
    providerMutationSignals,
  } = context;
  function unlockedProviderCall<A>(
    operation: string,
    leaseId: Ulid | undefined,
    call: (signal: AbortSignal) => Promise<A>,
    operationSignal?: AbortSignal,
    callerSignal?: AbortSignal,
  ) {
    return Effect.tryPromise({
      catch: (cause) => operationError(provider, operation, cause, leaseId),
      try: (interruptionSignal) => {
        if (callerSignal?.aborted) {
          return Promise.reject(
            callerSignal.reason ?? new Error("Sandbox operation was canceled."),
          );
        }
        const signals = [interruptionSignal];
        if (operationSignal) signals.push(operationSignal);
        if (callerSignal) signals.push(callerSignal);
        return call(AbortSignal.any(signals));
      },
    });
  }

  function unlockedProviderMutation<A>(
    operation: string,
    leaseId: Ulid | undefined,
    call: (signal: AbortSignal) => Promise<A>,
    operationSignal?: AbortSignal,
    callerSignal?: AbortSignal,
  ) {
    return unlockedProviderCall(
      operation,
      leaseId,
      (signal) => {
        if (operationSignal) providerMutationSignals.add(operationSignal);
        return call(signal);
      },
      operationSignal,
      callerSignal,
    );
  }

  function operationLeaseFailure(
    operation: string,
    leaseId: Ulid,
    cause: unknown,
    message = "Sandbox provider operation is already in progress.",
  ) {
    return new SandboxOperationError({
      cause,
      leaseId,
      message,
      operation: `${operation}-lease`,
      provider: provider.name,
    });
  }

  function renewalFailureCause(operation: string, leaseId: Ulid, cause: unknown) {
    if (operation === "checkpoint") return new SandboxCheckpointUnknownError(cause);
    if (operation === "destroy") return new SandboxDestroyUnknownError(cause);
    if (operation === "resume") return new SandboxResumeUnknownError(cause);
    if (operation === "create") {
      return new SandboxAllocationUnknownError({
        allocationError: cause,
        allocationToken: leaseId,
        ...(provider.automaticAllocationReconciliation === undefined
          ? {}
          : {
              automaticReconciliation: provider.automaticAllocationReconciliation,
            }),
      });
    }
    return cause;
  }

  function acquireDurableOperationLease(
    leaseScope: RuntimeLeaseScope,
    operation: string,
    acquireDeadline: number,
  ) {
    return Effect.gen(function* () {
      const leaseId = leaseScope.id;
      const owner = randomUUID();
      const leaseKey = `sandbox-provider-operation/${leaseId}`;
      let contention: unknown;
      let contentionAttempt = 0;
      while (true) {
        const acquiredAt = operationLeaseNow();
        const candidate = yield* createRuntimeLeaseRecord({
          acquiredAt,
          environmentId: leaseScope.environmentId,
          expiresAt: acquiredAt + operationLeaseMs,
          id: leaseId,
          leaseKey,
          organizationId: leaseScope.organizationId,
          owner,
          projectId: leaseScope.projectId,
          version: 0,
        });
        const created = yield* Effect.result(
          fromDatabase(() =>
            sandboxHostPersistence.write(database, candidate, UNIQUE_CLAIM_CONDITION),
          ),
        );
        if (created._tag === "Success") return candidate;

        const current = yield* fromDatabase(() =>
          sandboxHostPersistence.read(
            database,
            "execution",
            { pk: candidate.pk, sk: candidate.sk },
            true,
          ),
        );
        if (current === undefined) {
          contention = {
            acquireFailure: created.failure,
            observedLease: "absent-after-contention",
          };
          if (acquireDeadline - Date.now() <= 0) {
            return yield* Effect.fail(operationLeaseFailure(operation, leaseId, contention));
          }
          const remaining = acquireDeadline - Date.now();
          yield* Effect.sleep(Duration.millis(operationRetryDelay(contentionAttempt, remaining)));
          contentionAttempt += 1;
          continue;
        }
        if (current.itemType !== "runtime-lease") {
          return yield* Effect.fail(
            operationLeaseFailure(operation, leaseId, {
              acquireFailure: created.failure,
              observedRecord: current,
            }),
          );
        }
        if (current.data.owner === owner) {
          if (hasRuntimeLeaseScope(current)) return current;
          return yield* Effect.fail(
            operationLeaseFailure(operation, leaseId, {
              acquireFailure: created.failure,
              observedLease: current,
            }),
          );
        }
        contention = {
          acquireFailure: created.failure,
          observedLease: current,
        };

        if (Date.parse(current.data.expiresAt) <= acquiredAt) {
          return yield* Effect.fail(
            operationLeaseFailure(operation, leaseId, {
              priorContention: contention,
              staleLeaseRequiresManualRecovery: true,
            }),
          );
        }

        const remaining = acquireDeadline - Date.now();
        if (remaining <= 0) {
          return yield* Effect.fail(operationLeaseFailure(operation, leaseId, contention));
        }
        yield* Effect.sleep(Duration.millis(operationRetryDelay(contentionAttempt, remaining)));
        contentionAttempt += 1;
      }
    });
  }

  function renewDurableOperationLease(record: ScopedRuntimeLeaseRecordValue) {
    const renewedAt = operationLeaseNow();
    return createRuntimeLeaseRecord({
      acquiredAt: Date.parse(record.data.acquiredAt),
      environmentId: record.data.environmentId,
      expiresAt: renewedAt + operationLeaseMs,
      id: record.data.id,
      leaseKey: record.data.leaseKey,
      organizationId: record.data.organizationId,
      owner: record.data.owner,
      projectId: record.data.projectId,
      renewedAt,
      version: record.data.version + 1,
    }).pipe(
      Effect.flatMap((replacement) =>
        fromDatabase(() =>
          sandboxHostPersistence.commit(database, [
            { kind: "put", previousRecord: record, record: replacement },
          ]),
        ).pipe(Effect.as(replacement)),
      ),
    );
  }

  async function deleteDurableOperationLease(
    record: RuntimeLeaseRecordValue,
    operation: string,
    leaseId: Ulid,
  ) {
    let lastFailure: unknown;
    for (let attempt = 0; attempt < PERSISTENCE_RECONCILIATION_ATTEMPTS; attempt += 1) {
      let deleteFailure: unknown;
      try {
        await sandboxHostPersistence.remove(database, record);
        return;
      } catch (cause) {
        deleteFailure = cause;
      }
      lastFailure = deleteFailure;

      let observed: PlatformRecord | undefined;
      try {
        observed = await sandboxHostPersistence.read(
          database,
          "execution",
          { pk: record.pk, sk: record.sk },
          true,
        );
      } catch (readFailure) {
        lastFailure = { deleteFailure, readFailure };
        continue;
      }
      if (observed === undefined) return;
      if (!isDeepStrictEqual(observed, record)) {
        throw operationLeaseFailure(
          operation,
          leaseId,
          { deleteFailure, observedRecord: observed },
          "Sandbox provider operation lease ownership changed during release.",
        );
      }
    }
    throw operationLeaseFailure(
      operation,
      leaseId,
      lastFailure,
      "Sandbox provider operation lease release failed.",
    );
  }

  function acquireLeaseOperationGuard(leaseScope: RuntimeLeaseScope, operation: string) {
    return Effect.gen(function* () {
      const leaseId = leaseScope.id;
      const acquireDeadline = Date.now() + operationAcquireTimeoutMs;
      const releaseLocal = yield* Effect.tryPromise({
        catch: (cause) => operationLeaseFailure(operation, leaseId, cause),
        try: (signal) => acquireLeaseOperationLock(leaseId, acquireDeadline, signal),
      });
      const durable = yield* Effect.result(
        acquireDurableOperationLease(leaseScope, operation, acquireDeadline),
      );
      if (durable._tag === "Failure") {
        releaseLocal();
        return yield* Effect.fail(durable.failure);
      }

      let current = durable.success;
      let released = false;
      let retained = false;
      let releasePromise: Promise<void> | undefined;
      const abortController = new AbortController();
      let renewalTail = Promise.resolve();
      const renew = () => {
        renewalTail = renewalTail.then(async () => {
          if (released || abortController.signal.aborted) return;
          current = await Effect.runPromise(renewDurableOperationLease(current));
        });
        return renewalTail;
      };
      const renewalTimer = setInterval(
        () => {
          void renew().catch((cause) => {
            if (released || abortController.signal.aborted) return;
            clearInterval(renewalTimer);
            abortController.abort(
              operationLeaseFailure(
                operation,
                leaseId,
                renewalFailureCause(operation, leaseId, cause),
                "Sandbox provider operation lease renewal failed.",
              ),
            );
          });
        },
        Math.max(1_000, Math.floor(operationLeaseMs / 3)),
      );
      renewalTimer.unref?.();

      return {
        signal: abortController.signal,
        retain() {
          retained = true;
        },
        release(retain = false) {
          if (releasePromise) return releasePromise;
          released = true;
          clearInterval(renewalTimer);
          const pendingRelease: Promise<void> = renewalTail
            .catch(() => undefined)
            .then(async () => {
              if (!retain && !retained && !abortController.signal.aborted) {
                await deleteDurableOperationLease(current, operation, leaseId);
              }
            })
            .finally(releaseLocal);
          releasePromise = pendingRelease;
          return pendingRelease;
        },
      };
    });
  }

  function releaseLeaseOperationGuard(
    guard: SandboxOperationGuard,
    operation: string,
    leaseId: Ulid,
    retain = false,
    successfulResult?: unknown,
  ) {
    return Effect.tryPromise({
      catch: (cause) =>
        new SandboxOperationError({
          cause,
          leaseId,
          message: "Sandbox provider operation lease release failed.",
          operation: `${operation}-lease-release`,
          provider: provider.name,
          ...(successfulResult === undefined ? {} : { successfulResult }),
        }),
      try: () => guard.release(retain),
    });
  }

  function withLeaseOperationLock<A>(
    leaseScope: RuntimeLeaseScope,
    operation: string,
    use: (
      signal: AbortSignal,
      retain: () => void,
      guard: SandboxOperationGuard,
    ) => Effect.Effect<A, SandboxManagerError>,
    retainInterruptedProviderCall?: () => boolean,
  ): Effect.Effect<A, SandboxManagerError> {
    const leaseId = leaseScope.id;
    return Effect.acquireUseRelease(
      acquireLeaseOperationGuard(leaseScope, operation),
      (guard) =>
        Effect.result(use(guard.signal, () => guard.retain(), guard)).pipe(
          Effect.flatMap((result) => {
            if (guard.signal.aborted) {
              return Effect.fail(
                guard.signal.reason instanceof SandboxOperationError
                  ? guard.signal.reason
                  : operationLeaseFailure(operation, leaseId, guard.signal.reason),
              );
            }
            return result._tag === "Success"
              ? Effect.succeed(result.success)
              : Effect.fail(result.failure);
          }),
        ),
      (guard, exit) =>
        releaseLeaseOperationGuard(
          guard,
          operation,
          leaseId,
          guard.signal.aborted ||
            (Exit.isFailure(exit) &&
              Cause.hasInterrupts(exit.cause) &&
              (retainInterruptedProviderCall?.() ?? providerMutationSignals.has(guard.signal))),
          Exit.isSuccess(exit) ? exit.value : undefined,
        ),
    );
  }

  function guardedDownloadStream(
    stream: ReadableStream<Uint8Array>,
    guard: SandboxOperationGuard,
    callerSignal?: AbortSignal,
  ) {
    const reader = stream.getReader();
    let finished = false;
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
    const abort = (reason: unknown) => {
      if (finished) return;
      void reader
        .cancel(reason)
        .catch(() => undefined)
        .then(release)
        .then(() => controllerRef?.error(reason));
    };
    const abortForGuard = () =>
      abort(guard.signal.reason ?? new Error("Sandbox download operation lease was lost."));
    const abortForCaller = () =>
      abort(callerSignal?.reason ?? new Error("Sandbox download was canceled."));
    const release = async () => {
      if (finished) return;
      finished = true;
      guard.signal.removeEventListener("abort", abortForGuard);
      callerSignal?.removeEventListener("abort", abortForCaller);
      try {
        reader.releaseLock();
      } finally {
        await guard.release();
      }
    };
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controllerRef = controller;
        guard.signal.addEventListener("abort", abortForGuard, { once: true });
        callerSignal?.addEventListener("abort", abortForCaller, { once: true });
        if (guard.signal.aborted) abortForGuard();
        else if (callerSignal?.aborted) abortForCaller();
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          await release();
        }
      },
      async pull(controller) {
        try {
          guard.signal.throwIfAborted();
          const next = await reader.read();
          guard.signal.throwIfAborted();
          if (next.done) {
            await release();
            controller.close();
            return;
          }
          controller.enqueue(next.value);
        } catch (cause) {
          await release();
          controller.error(cause);
        }
      },
    });
  }

  function providerMutationCall<A>(
    operation: string,
    leaseScope: RuntimeLeaseScope,
    call: (signal: AbortSignal) => Promise<A>,
    callerSignal?: AbortSignal,
  ) {
    return withLeaseOperationLock(leaseScope, operation, (signal) =>
      unlockedProviderMutation(operation, leaseScope.id, call, signal, callerSignal),
    );
  }
  return {
    acquireLeaseOperationGuard,
    guardedDownloadStream,
    providerMutationCall,
    releaseLeaseOperationGuard,
    unlockedProviderCall,
    unlockedProviderMutation,
    withLeaseOperationLock,
  };
}

export type OperationRuntime = ReturnType<typeof createOperationRuntime>;
