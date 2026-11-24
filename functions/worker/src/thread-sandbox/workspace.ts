import {
  MAX_SANDBOX_WORKSPACE_FAILURE_REASON_CHARACTERS,
  SandboxExecutionTargetKind,
  Ulid,
  type SandboxWorkspaceData,
  type SandboxWorkspacePersistence,
  type SandboxWorkspaceRecordValue,
} from "@deployments-ai/db";
import {
  managedSandboxFromRecord,
  type ManagedSandbox,
  type SandboxLeaseRecordValue,
  type SandboxManagerService,
  type SandboxProviderName,
} from "@deployments-ai/sandbox-hosts";
import { Effect, Schema } from "effect";
import type {
  ThreadSandboxAcquireInput,
  ThreadSandboxReleaseOptions,
  ThreadSandboxScope,
  ThreadSandboxWorkspace,
} from "./contracts.ts";
import {
  ThreadSandboxSnapshotFailure,
  captureWorkspaceSnapshot,
  restoreWorkspaceSnapshot,
} from "./guest-transfer.ts";
import {
  threadSandboxSnapshotKey,
  type ThreadSandboxSnapshotRef,
  type ThreadSandboxSnapshotStore,
} from "./snapshot-store.ts";

/** A lease closer than this to expiry is not handed to another tool call. */
const THREAD_SANDBOX_REUSE_MIN_REMAINING_MS = 15 * 60_000;
/** Release budget when the caller has no run deadline (salvage inside `acquire`). */
const THREAD_SANDBOX_DEFAULT_RELEASE_MS = 240_000;
/** Below this much remaining release time a snapshot is not attempted. */
const THREAD_SANDBOX_MIN_SNAPSHOT_MS = 15_000;
/** Bounds the in-sandbox download and extraction of the latest snapshot. */
const THREAD_SANDBOX_RESTORE_TIMEOUT_MS = 300_000;
/** Grace for in-flight control commands after the release deadline. */
const RELEASE_ABORT_GRACE_MS = 15_000;

export interface ThreadSandboxWorkspaceOptions {
  readonly generateId: () => Promise<Ulid>;
  readonly manager: Pick<SandboxManagerService, "create" | "destroy" | "exec" | "upload">;
  readonly now?: () => number;
  readonly persistence: SandboxWorkspacePersistence;
  readonly providerName: SandboxProviderName;
  readonly snapshots: ThreadSandboxSnapshotStore;
}

type WorkspacePatch = Partial<
  Pick<
    SandboxWorkspaceData,
    "lastSnapshotFailure" | "leaseId" | "leaseRunId" | "restoredLeaseId" | "snapshot"
  >
>;

const CLEARED_LEASE: WorkspacePatch = {
  leaseId: undefined,
  leaseRunId: undefined,
  restoredLeaseId: undefined,
};

const ScopeIds = Schema.Struct({
  environmentId: Ulid,
  executionTargetId: Ulid,
  executionTargetKind: SandboxExecutionTargetKind,
  organizationId: Ulid,
  projectId: Ulid,
  runId: Ulid,
  threadId: Ulid,
  workspaceId: Schema.optional(Ulid),
});
type ScopeIds = typeof ScopeIds.Type;

function decodeScope(scope: ThreadSandboxScope): ScopeIds {
  try {
    return Schema.decodeUnknownSync(ScopeIds)(scope);
  } catch (cause) {
    throw new TypeError("Thread sandbox scope identifiers must be ULIDs.", { cause });
  }
}

function errorType(cause: unknown) {
  return cause instanceof Error ? cause.name : "UnknownError";
}

function logFields(
  scope: Pick<
    ThreadSandboxScope,
    "executionTargetId" | "executionTargetKind" | "organizationId" | "runId" | "threadId"
  >,
  extra: Readonly<Record<string, unknown>>,
) {
  return {
    executionTargetId: scope.executionTargetId,
    executionTargetKind: scope.executionTargetKind,
    organizationId: scope.organizationId,
    runId: scope.runId,
    threadId: scope.threadId,
    ...extra,
  };
}

export function makeThreadSandboxWorkspace(
  options: ThreadSandboxWorkspaceOptions,
): ThreadSandboxWorkspace {
  const { manager, persistence, snapshots } = options;
  const now = options.now ?? Date.now;
  const tails = new Map<string, Promise<void>>();

  // One worker owns a thread's execution lease, so per-process ordering serializes
  // parallel tool calls and the run-exit release of the same workspace.
  function serialized<T>(scope: ThreadSandboxScope, work: () => Promise<T>) {
    const scopeKey = [
      scope.organizationId,
      scope.threadId,
      scope.executionTargetKind,
      scope.executionTargetId,
    ].join("/");
    const next = (tails.get(scopeKey) ?? Promise.resolve()).then(work);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    tails.set(scopeKey, tail);
    void tail.then(() => {
      if (tails.get(scopeKey) === tail) tails.delete(scopeKey);
    });
    return next;
  }

  const load = (scope: ScopeIds) => persistence.load(scope);

  async function write(
    scope: ScopeIds,
    previous: SandboxWorkspaceRecordValue | undefined,
    patch: WorkspacePatch,
  ) {
    const timestamp = new Date(now()).toISOString();
    if (previous) {
      const { version: _version, ...data } = previous.data;
      return persistence.update(previous, { ...data, ...patch, updatedAt: timestamp });
    }
    return persistence.create({
      createdAt: timestamp,
      environmentId: scope.environmentId,
      executionTargetId: scope.executionTargetId,
      executionTargetKind: scope.executionTargetKind,
      id: await options.generateId(),
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      threadId: scope.threadId,
      updatedAt: timestamp,
      ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
      ...patch,
    });
  }

  function leaseUnexpired(lease: SandboxLeaseRecordValue, minimumRemainingMs: number) {
    const expiresAt = lease.data.leaseExpiresAt
      ? Date.parse(lease.data.leaseExpiresAt)
      : Number.POSITIVE_INFINITY;
    return expiresAt - now() > minimumRemainingMs;
  }

  async function recordSnapshotFailure(
    scope: ScopeIds,
    workspace: SandboxWorkspaceRecordValue,
    leaseId: Ulid,
    cause: unknown,
  ) {
    const failure =
      cause instanceof ThreadSandboxSnapshotFailure
        ? { code: cause.code, reason: cause.message }
        : {
            code: "snapshot-failed" as const,
            reason: `Workspace snapshot could not be captured or stored (${errorType(cause)}).`,
          };
    const reason = failure.reason.slice(0, MAX_SANDBOX_WORKSPACE_FAILURE_REASON_CHARACTERS);
    console.error(
      "Thread sandbox snapshot failed; keeping the sandbox alive.",
      logFields(scope, { errorType: errorType(cause), leaseId, reason }),
    );
    try {
      await write(scope, workspace, {
        lastSnapshotFailure: {
          at: new Date(now()).toISOString(),
          code: failure.code,
          leaseId,
          reason,
        },
      });
    } catch (recordCause) {
      console.error(
        "Thread sandbox snapshot failure could not be recorded.",
        logFields(scope, { errorType: errorType(recordCause), leaseId }),
      );
    }
  }

  /** Commits a new snapshot of `lease`; returns undefined after recording a failure. */
  async function snapshot(
    scope: ScopeIds,
    workspace: SandboxWorkspaceRecordValue,
    lease: SandboxLeaseRecordValue,
    deadline: number,
    signal: AbortSignal,
  ) {
    const leaseId = lease.data.id;
    let stored: ThreadSandboxSnapshotRef;
    try {
      if (deadline - now() < THREAD_SANDBOX_MIN_SNAPSHOT_MS) {
        throw new ThreadSandboxSnapshotFailure(
          "Workspace snapshot skipped: too little time remained before the worker deadline.",
          "snapshot-incomplete",
        );
      }
      stored = await captureWorkspaceSnapshot({
        deadline,
        key: threadSandboxSnapshotKey(scope, await options.generateId()),
        manager,
        now,
        sandbox: managedSandboxFromRecord(lease),
        signal,
        snapshots,
      });
    } catch (cause) {
      await recordSnapshotFailure(scope, workspace, leaseId, cause);
      return undefined;
    }
    let committed: SandboxWorkspaceRecordValue;
    try {
      committed = await write(scope, workspace, {
        lastSnapshotFailure: undefined,
        snapshot: { ...stored, capturedAt: new Date(now()).toISOString(), leaseId },
      });
    } catch (cause) {
      // An unknown write outcome may still have committed; only discard a provably orphaned object.
      const latest = await load(scope).catch(() => undefined);
      if (latest?.data.snapshot?.versionId === stored.versionId) {
        committed = latest;
      } else {
        if (latest) await snapshots.delete(stored, signal).catch(() => undefined);
        await recordSnapshotFailure(scope, latest ?? workspace, leaseId, cause);
        return undefined;
      }
    }
    const superseded = workspace.data.snapshot;
    if (superseded) {
      try {
        await snapshots.delete(superseded, signal);
      } catch (cause) {
        console.warn(
          "Superseded thread sandbox snapshot could not be deleted.",
          logFields(scope, { errorType: errorType(cause), leaseId }),
        );
      }
    }
    return committed;
  }

  async function releaseNow(scope: ScopeIds, deadline: number, onlyIfLeasedByRun: boolean) {
    const signal = AbortSignal.timeout(Math.max(0, deadline - now()) + RELEASE_ABORT_GRACE_MS);
    let workspace = await load(scope);
    const leaseId = workspace?.data.leaseId;
    if (!workspace || !leaseId) return;
    if (onlyIfLeasedByRun && workspace.data.leaseRunId !== scope.runId) return;
    const lease = await persistence.loadLease({ ...scope, leaseId });
    if (!lease || lease.data.status === "destroyed") {
      await write(scope, workspace, CLEARED_LEASE);
      return;
    }
    if (
      lease.data.status === "ready" &&
      leaseUnexpired(lease, 0) &&
      workspace.data.restoredLeaseId === leaseId
    ) {
      const committed = await snapshot(scope, workspace, lease, deadline, signal);
      if (!committed) return;
      workspace = committed;
    }
    try {
      await Effect.runPromise(manager.destroy(managedSandboxFromRecord(lease)));
    } catch (cause) {
      console.error(
        "Thread sandbox destroy failed; the lease stays recorded for salvage.",
        logFields(scope, { errorType: errorType(cause), leaseId }),
      );
      return;
    }
    await write(scope, workspace, CLEARED_LEASE);
  }

  async function release(scope: ThreadSandboxScope, releaseOptions?: ThreadSandboxReleaseOptions) {
    try {
      await releaseNow(
        decodeScope(scope),
        releaseOptions?.deadline ?? now() + THREAD_SANDBOX_DEFAULT_RELEASE_MS,
        releaseOptions?.onlyIfLeasedByRun === true,
      );
    } catch (cause) {
      console.error(
        "Thread sandbox release failed.",
        logFields(scope, { errorType: errorType(cause) }),
      );
    }
  }

  async function acquireNow(input: ThreadSandboxAcquireInput): Promise<ManagedSandbox> {
    if (input.policy.mode !== "thread-persistent") {
      throw new TypeError("Thread sandboxes require the thread-persistent sandbox mode.");
    }
    if (input.policy.provider !== options.providerName) {
      throw new TypeError("Thread sandbox provider is not configured for this worker.");
    }
    const scope = decodeScope(input);
    let workspace = await load(scope);
    const currentLeaseId = workspace?.data.leaseId;
    if (workspace && currentLeaseId) {
      const lease = await persistence.loadLease({ ...scope, leaseId: currentLeaseId });
      const healthy =
        lease?.data.status === "ready" &&
        leaseUnexpired(lease, THREAD_SANDBOX_REUSE_MIN_REMAINING_MS) &&
        workspace.data.restoredLeaseId === currentLeaseId;
      // A sandbox whose archive was too large or whose in-sandbox transfer did not finish is
      // healthy and holds the newest files; carrying it into this run beats an older snapshot.
      const failure = workspace.data.lastSnapshotFailure;
      const retained =
        (failure?.code === "archive-too-large" || failure?.code === "snapshot-incomplete") &&
        failure.leaseId === currentLeaseId;
      if (lease && healthy && workspace.data.leaseRunId === scope.runId) {
        return managedSandboxFromRecord(lease);
      }
      if (lease && healthy && retained) {
        await write(scope, workspace, { leaseRunId: scope.runId });
        return managedSandboxFromRecord(lease);
      }
      await release(input);
      workspace = await load(scope);
      const abandoned = workspace?.data.leaseId;
      if (abandoned) {
        console.warn(
          "Abandoning a thread sandbox that could not be released.",
          logFields(scope, {
            leaseId: abandoned,
            reason: workspace?.data.lastSnapshotFailure?.reason ?? "Sandbox destroy failed.",
          }),
        );
      }
    }
    const leaseId = await options.generateId();
    workspace = await write(scope, workspace, {
      leaseId,
      leaseRunId: scope.runId,
      restoredLeaseId: undefined,
    });
    const { policy } = input;
    let sandbox: ManagedSandbox;
    try {
      sandbox = await Effect.runPromise(
        manager.create({
          allocationId: leaseId,
          environmentId: scope.environmentId,
          executionTargetId: scope.executionTargetId,
          executionTargetKind: scope.executionTargetKind,
          isolationMode: "thread-persistent",
          observability: input.observability,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          runId: scope.runId,
          ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}),
          ...(policy.accessPolicyRef ? { accessPolicyRef: policy.accessPolicyRef } : {}),
          ...(policy.imageRef ? { imageRef: policy.imageRef } : {}),
          ...(policy.minMemoryMiB ? { minMemoryMiB: policy.minMemoryMiB } : {}),
          ...(policy.minVcpu ? { minVcpu: policy.minVcpu } : {}),
          ...(policy.poolKey ? { poolKey: policy.poolKey } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      );
    } catch (cause) {
      throw new Error("Thread sandbox allocation did not complete.", { cause });
    }
    const persisted = workspace.data.snapshot;
    if (persisted) {
      await restoreWorkspaceSnapshot({
        deadline: now() + THREAD_SANDBOX_RESTORE_TIMEOUT_MS,
        manager,
        now,
        sandbox,
        signal: input.signal,
        snapshot: persisted,
        snapshots,
      });
    }
    await write(scope, workspace, { restoredLeaseId: leaseId });
    return sandbox;
  }

  return {
    acquire: (input) => serialized(input, () => acquireNow(input)),
    release: (scope, releaseOptions) => serialized(scope, () => release(scope, releaseOptions)),
  };
}
