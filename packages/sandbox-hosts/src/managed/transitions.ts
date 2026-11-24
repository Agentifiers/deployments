import { fromDatabase, sandboxHostPersistence } from "@deployments-ai/db";
import type { DatabaseError, TransactionOperation } from "@deployments-ai/db";
import { transactWithSemanticEvents } from "@deployments-ai/events";
import { isDeepStrictEqual } from "node:util";
import { Effect } from "effect";
import {
  SandboxPersistenceUnknownError,
  type ManagerBase,
  type SandboxLeaseRecordValue,
  type SandboxManagerError,
} from "./contracts.ts";
import {
  generateId,
  newSandboxIdentityClaimOperations,
  put,
  semanticEvent,
  timestamp,
  transitionRequestToken,
  updateLeaseRecord,
} from "./records.ts";
import { usageRecords } from "./usage.ts";

const MAX_SANDBOX_USAGE_SEGMENT_MS = 90 * 24 * 60 * 60 * 1_000;
const PERSISTENCE_RECONCILIATION_ATTEMPTS = 3;

function isPersistenceUnknown(error: SandboxManagerError) {
  return error._tag === "SandboxPersistenceUnknownError";
}

export function createTransitionRuntime(context: ManagerBase) {
  const { provider, database, ids, config, now } = context;
  function reconcileTransitionCommit(record: SandboxLeaseRecordValue, cause: DatabaseError) {
    return Effect.gen(function* () {
      let lastReadFailure: unknown;
      for (let attempt = 0; attempt < PERSISTENCE_RECONCILIATION_ATTEMPTS; attempt += 1) {
        const existing = yield* Effect.result(
          fromDatabase(() =>
            sandboxHostPersistence.read(
              database,
              "execution",
              { pk: record.pk, sk: record.sk },
              true,
            ),
          ),
        );
        if (existing._tag === "Success") {
          if (existing.success !== undefined && isDeepStrictEqual(existing.success, record)) {
            return undefined;
          }
          if (
            existing.success !== undefined &&
            existing.success.itemType === "sandbox-lease" &&
            existing.success.data.version > record.data.version
          ) {
            return yield* Effect.fail(
              new SandboxPersistenceUnknownError({
                cause: {
                  observedRecord: existing.success,
                  transactionFailure: cause,
                },
                leaseId: record.data.id,
                message: `Sandbox persistence outcome is unknown for provider ${provider.name}.`,
                operation: "persistence-reconciliation",
                provider: provider.name,
              }),
            );
          }
          return yield* Effect.fail(cause);
        }
        lastReadFailure = existing.failure;
      }
      return yield* Effect.fail(
        new SandboxPersistenceUnknownError({
          cause: {
            transactionFailure: cause,
            reconciliationFailure: lastReadFailure,
          },
          leaseId: record.data.id,
          message: `Sandbox persistence outcome is unknown for provider ${provider.name}.`,
          operation: "persistence-reconciliation",
          provider: provider.name,
        }),
      );
    });
  }

  function prepareTransitionCommit(
    previous: SandboxLeaseRecordValue | undefined,
    record: SandboxLeaseRecordValue,
    eventType: string,
    extraOperations: readonly TransactionOperation[] = [],
  ) {
    return newSandboxIdentityClaimOperations(previous, record).pipe(
      Effect.flatMap((claimOperations) =>
        generateId(ids).pipe(
          Effect.map((eventId) => {
            const event = semanticEvent(record, eventId, eventType);
            const operations = [put(previous, record), ...claimOperations, ...extraOperations];
            const requestToken = transitionRequestToken(record, event);
            return fromDatabase(() =>
              transactWithSemanticEvents(database, operations, [event], requestToken),
            ).pipe(
              Effect.catchTag("DatabaseError", (cause) => reconcileTransitionCommit(record, cause)),
              Effect.as(record),
            );
          }),
        ),
      ),
    );
  }

  function commitTransition(
    previous: SandboxLeaseRecordValue | undefined,
    record: SandboxLeaseRecordValue,
    eventType: string,
    extraOperations: readonly TransactionOperation[] = [],
  ) {
    return prepareTransitionCommit(previous, record, eventType, extraOperations).pipe(
      Effect.flatMap((commit) => commit),
    );
  }

  function commitPreparedTransitionWithRetry(
    commit: Effect.Effect<SandboxLeaseRecordValue, SandboxManagerError>,
  ) {
    return Effect.result(commit).pipe(
      Effect.flatMap((first) =>
        first._tag === "Success" || isPersistenceUnknown(first.failure)
          ? first._tag === "Success"
            ? Effect.succeed(first.success)
            : Effect.fail(first.failure)
          : commit,
      ),
    );
  }

  function commitDestroyCompletion(releasing: SandboxLeaseRecordValue, completedAt: number) {
    return updateLeaseRecord(
      releasing,
      { destroyCompletedAt: timestamp(completedAt), status: "releasing" },
      completedAt,
    ).pipe(
      Effect.flatMap((completedRecord) =>
        prepareTransitionCommit(releasing, completedRecord, "sandbox.destroy-completed").pipe(
          Effect.flatMap(commitPreparedTransitionWithRetry),
        ),
      ),
    );
  }

  function transition(
    previous: SandboxLeaseRecordValue,
    updates: Readonly<Record<string, unknown>>,
    eventType: string,
    removeFields: readonly string[] = [],
  ) {
    const transitionAt = now();
    return updateLeaseRecord(previous, updates, transitionAt, removeFields).pipe(
      Effect.flatMap((record) => commitTransition(previous, record, eventType)),
    );
  }

  function prepareTerminalTransition(
    previous: SandboxLeaseRecordValue,
    updates: Readonly<Record<string, unknown>>,
    eventType: string,
    options: {
      readonly activeSegmentStartedAt?: string;
      readonly completedAt?: number;
      readonly nextComputeUsageActive?: boolean;
      readonly removeFields?: readonly string[];
      readonly transitionAt?: number;
      readonly usageReservation?: {
        readonly reservedMemoryMiB?: number;
        readonly reservedVcpu?: number;
      };
      readonly usageDimensionsRecord?: SandboxLeaseRecordValue;
    } = {},
  ) {
    const requestedTransitionAt = options.transitionAt ?? now();
    const requestedCompletedAt = options.completedAt ?? requestedTransitionAt;
    const nextComputeUsageActive =
      updates.status === "destroyed"
        ? false
        : (options.nextComputeUsageActive ?? previous.data.computeUsageActive);
    const leaseExpirationCandidates = [
      previous.data.leaseExpiresAt,
      typeof updates.leaseExpiresAt === "string" ? updates.leaseExpiresAt : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .map(Date.parse)
      .filter(Number.isFinite);
    const effectiveLeaseExpiresAt =
      leaseExpirationCandidates.length > 0
        ? Math.min(...leaseExpirationCandidates)
        : requestedCompletedAt;
    return Effect.gen(function* () {
      let accounted = previous;
      let activeSegmentStartedAt = options.activeSegmentStartedAt;
      while (true) {
        const computeUsageActive =
          activeSegmentStartedAt !== undefined ||
          accounted.data.computeUsageActive ||
          accounted.data.usagePendingThrough !== undefined;
        const requestedStart =
          activeSegmentStartedAt ??
          accounted.data.usageAccountedThrough ??
          accounted.data.usageStartedAt;
        const pendingThrough = accounted.data.usagePendingThrough
          ? Date.parse(accounted.data.usagePendingThrough)
          : requestedCompletedAt;
        const segmentEndedAt = Math.min(
          requestedCompletedAt,
          effectiveLeaseExpiresAt,
          pendingThrough,
        );
        const segmentStartedAt = computeUsageActive
          ? Math.min(Date.parse(requestedStart), segmentEndedAt)
          : segmentEndedAt;
        if (segmentEndedAt - segmentStartedAt <= MAX_SANDBOX_USAGE_SEGMENT_MS) break;

        const chunkEndedAt = segmentStartedAt + MAX_SANDBOX_USAGE_SEGMENT_MS;
        const chunk = yield* updateLeaseRecord(
          accounted,
          {
            computeUsageActive: nextComputeUsageActive,
            usageAccountedThrough: timestamp(chunkEndedAt),
            usagePendingThrough: timestamp(segmentEndedAt),
          },
          now(),
        );
        const usage = yield* usageRecords(
          accounted,
          chunk,
          chunkEndedAt,
          ids,
          config.costPolicy,
          activeSegmentStartedAt,
          options.usageReservation,
          options.usageDimensionsRecord,
        );
        accounted = yield* commitTransition(
          accounted,
          chunk,
          "sandbox.usage-recorded",
          usage.map(
            (meter): TransactionOperation => ({
              kind: "put",
              record: meter,
            }),
          ),
        );
        activeSegmentStartedAt = undefined;
      }

      const completedAt = accounted.data.usagePendingThrough
        ? Date.parse(accounted.data.usagePendingThrough)
        : requestedCompletedAt;
      const terminalUpdates = {
        ...updates,
        computeUsageActive: nextComputeUsageActive,
        usageAccountedThrough: timestamp(completedAt),
        ...(updates.status === "destroyed" ? { destroyedAt: timestamp(completedAt) } : {}),
      };
      const transitionAt = Math.max(
        requestedTransitionAt,
        Date.parse(accounted.data.updatedAt),
        completedAt,
      );
      const removeFields = [
        "usagePendingThrough",
        ...(options.removeFields ?? []),
        ...(accounted.data.status === "checkpointing" && updates.status !== "checkpointing"
          ? ["checkpointRequestedAt"]
          : []),
      ];
      const record = yield* updateLeaseRecord(
        accounted,
        terminalUpdates,
        transitionAt,
        removeFields,
      );
      const usage = yield* usageRecords(
        accounted,
        record,
        completedAt,
        ids,
        config.costPolicy,
        activeSegmentStartedAt,
        options.usageReservation,
        options.usageDimensionsRecord,
      );
      const commit = yield* prepareTransitionCommit(
        accounted,
        record,
        eventType,
        usage.map(
          (meter): TransactionOperation => ({
            kind: "put",
            record: meter,
          }),
        ),
      );
      return { commit, previous: accounted, record };
    });
  }

  function terminalTransition(
    previous: SandboxLeaseRecordValue,
    updates: Readonly<Record<string, unknown>>,
    eventType: string,
    options: {
      readonly activeSegmentStartedAt?: string;
      readonly completedAt?: number;
      readonly nextComputeUsageActive?: boolean;
      readonly removeFields?: readonly string[];
      readonly transitionAt?: number;
      readonly usageReservation?: {
        readonly reservedMemoryMiB?: number;
        readonly reservedVcpu?: number;
      };
      readonly usageDimensionsRecord?: SandboxLeaseRecordValue;
    } = {},
  ) {
    return prepareTerminalTransition(previous, updates, eventType, options).pipe(
      Effect.flatMap(({ commit }) => commit),
    );
  }
  return {
    commitDestroyCompletion,
    commitPreparedTransitionWithRetry,
    commitTransition,
    prepareTerminalTransition,
    prepareTransitionCommit,
    terminalTransition,
    transition,
  };
}

export type TransitionRuntime = ReturnType<typeof createTransitionRuntime>;
