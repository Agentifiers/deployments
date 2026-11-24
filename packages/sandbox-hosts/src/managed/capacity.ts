import {
  DatabaseError,
  RecordDecodeError,
  capacityHolding,
  fromDatabase,
  makeOrganizationCapacity,
  sandboxHostPersistence,
} from "@deployments-ai/db";
import { Effect, Exit, type Cause } from "effect";
import {
  SandboxCapacityError,
  SandboxOperationError,
  type ManagedSandbox,
  type ManagerBase,
  type SandboxCapacityRecovery,
  type SandboxCapacityRejection,
  type SandboxLeaseRecordValue,
  type SandboxManagerError,
} from "./contracts.ts";
import { managedSandboxFromRecord } from "./public.ts";
import { leaseRecordWithUpdates } from "./records.ts";
import type { TransitionRuntime } from "./transitions.ts";

const MAX_STALE_HOLDER_DESTROYS = 2;

class LeaseCommitFailure {
  constructor(readonly cause: Cause.Cause<SandboxManagerError>) {}
}

export interface CapacityRuntime {
  readonly commitHoldingTransitionRetryingAfterStaleHolderDestroy: (
    previous: SandboxLeaseRecordValue | undefined,
    record: SandboxLeaseRecordValue,
    eventType: string,
  ) => Effect.Effect<SandboxLeaseRecordValue, SandboxManagerError>;
}

function leaseExpired(lease: SandboxLeaseRecordValue, now: number) {
  return lease.data.leaseExpiresAt !== undefined && Date.parse(lease.data.leaseExpiresAt) <= now;
}

function runEphemeralDestroyFailed(lease: SandboxLeaseRecordValue) {
  return (
    lease.data.isolationMode === "run-ephemeral" &&
    lease.data.status === "error" &&
    lease.data.failureReason === "provider-destroy-failed"
  );
}

function runEphemeralRunHoldsNoExecutionClaim(
  lease: SandboxLeaseRecordValue,
  executionClaimRunIds: ReadonlySet<string>,
) {
  return (
    lease.data.isolationMode === "run-ephemeral" &&
    lease.data.runId !== undefined &&
    !executionClaimRunIds.has(lease.data.runId)
  );
}

function staleHolderReason(
  lease: SandboxLeaseRecordValue,
  now: number,
  executionClaimRunIds: ReadonlySet<string>,
): SandboxCapacityRecovery["reason"] | undefined {
  if (!lease.data.externalSandboxId) return undefined;
  if (leaseExpired(lease, now)) return "lease-expired";
  if (runEphemeralDestroyFailed(lease)) return "destroy-failed";
  if (runEphemeralRunHoldsNoExecutionClaim(lease, executionClaimRunIds)) return "run-not-running";
  return undefined;
}

export function createCapacityRuntime(
  context: ManagerBase &
    TransitionRuntime & {
      readonly destroy: (
        sandbox: ManagedSandbox,
      ) => Effect.Effect<SandboxLeaseRecordValue, SandboxManagerError>;
    },
): CapacityRuntime {
  const { config, database, destroy, now, provider, commitTransition } = context;
  const capacity = makeOrganizationCapacity(database);

  const recoverStaleHolder = (rejection: SandboxCapacityRejection) =>
    Effect.gen(function* () {
      const [holders, runs] = yield* fromDatabase(() =>
        Promise.all([
          capacity.claims(rejection.organizationId, "active-sandbox"),
          capacity.claims(rejection.organizationId, "run-execution"),
        ]),
      );
      const executionClaimRunIds = new Set(runs.map((claim) => claim.ownerId));
      let destroys = 0;
      for (const holder of holders) {
        if (destroys === MAX_STALE_HOLDER_DESTROYS) break;
        const lease = yield* fromDatabase(() =>
          sandboxHostPersistence.read(database, "execution", holder.ownerKey, true),
        );
        if (lease?.itemType !== "sandbox-lease") continue;
        const reason = staleHolderReason(lease, now(), executionClaimRunIds);
        if (!reason) continue;
        destroys += 1;
        const destroyed = yield* Effect.result(destroy(managedSandboxFromRecord(lease)));
        if (destroyed._tag === "Failure") continue;
        config.onStaleCapacityRecovered({ ...rejection, leaseId: lease.data.id, reason });
        return true;
      }
      return false;
    });

  return {
    commitHoldingTransitionRetryingAfterStaleHolderDestroy: (previous, record, eventType) => {
      if (previous && capacityHolding(previous)) {
        return commitTransition(previous, record, eventType);
      }
      const { id, organizationId, runId } = record.data;
      return Effect.gen(function* () {
        const limit = yield* Effect.tryPromise({
          catch: (cause) =>
            new SandboxOperationError({
              cause,
              leaseId: id,
              message: "The organization active-sandbox limit could not be resolved.",
              operation: "sandbox-capacity-limit",
              provider: provider.name,
            }),
          try: () => config.organizationSandboxLimit(organizationId),
        });
        const acquire = Effect.tryPromise({
          catch: (cause) => cause,
          try: () =>
            capacity.acquire({
              commit: (slot) =>
                Effect.runPromiseExit(
                  leaseRecordWithUpdates(record, { capacitySlot: slot }).pipe(
                    Effect.flatMap((slotted) => commitTransition(previous, slotted, eventType)),
                  ),
                ).then((exit) => {
                  if (Exit.isSuccess(exit)) return exit.value;
                  throw new LeaseCommitFailure(exit.cause);
                }),
              holderId: id,
              limit,
              organizationId,
              resource: "active-sandbox",
            }),
        }).pipe(
          Effect.catch((cause) =>
            cause instanceof LeaseCommitFailure
              ? Effect.failCause(cause.cause)
              : cause instanceof DatabaseError || cause instanceof RecordDecodeError
                ? Effect.fail(cause)
                : Effect.die(cause),
          ),
        );
        const first = yield* acquire;
        if (first.kind === "acquired") return first.value;
        const atLimit = {
          inUse: first.inUse,
          limit: first.limit,
          organizationId,
          ...(runId ? { requestingRunId: runId } : {}),
        };
        const acquisition = (yield* recoverStaleHolder(atLimit)) ? yield* acquire : first;
        if (acquisition.kind === "acquired") return acquisition.value;
        config.onSandboxCapacityRejected({
          ...atLimit,
          inUse: acquisition.inUse,
          limit: acquisition.limit,
        });
        return yield* Effect.fail(
          new SandboxCapacityError({
            inUse: acquisition.inUse,
            limit: acquisition.limit,
            message: `The organization reached its limit of ${acquisition.limit} active sandboxes.`,
            organizationId,
          }),
        );
      });
    },
  };
}
