import {
  DatabaseError,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
  makeIdGenerator,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  managedSandboxFromRecord,
  SandboxAllocationUnknownError,
  type SandboxLease,
  type SandboxProvider,
} from "./index.ts";
import { makeSandboxManager } from "./sandbox-manager.fixture.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB3" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB4" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB5" as Ulid;
const AGENT_DEPLOYMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB6" as Ulid;
const RUN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB7" as Ulid;
const OBSERVABILITY = {
  captureMode: "metadata-only" as const,
  runSpanId: "0123456789abcdef" as const,
  sessionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid,
  traceId: "0123456789abcdef0123456789abcdef" as const,
};

function database(transactions: TransactionOperation[][]): DynamoDatabaseService {
  return {
    deleteRecord: async () => {},
    getRecord: async () => undefined,
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      transactions.push([...operations]);
    },
  };
}

function records(transaction: readonly TransactionOperation[]) {
  return transaction.flatMap((operation) => (operation.kind === "put" ? [operation.record] : []));
}

function leaseRecord(transaction: readonly TransactionOperation[]) {
  const record = records(transaction).find((candidate) => candidate.itemType === "sandbox-lease");
  if (!record || record.itemType !== "sandbox-lease") throw new Error("Missing sandbox lease");
  return record;
}

function statefulDatabase(
  transactions: TransactionOperation[][],
  failOnceEventType?: string,
): DynamoDatabaseService {
  let stored: PlatformRecord | undefined;
  let failed = false;
  return {
    deleteRecord: async () => {},
    getRecord: async () => stored,
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      transactions.push([...operations]);
      const event = records(operations).find((record) => record.itemType === "semantic-event");
      if (
        !failed &&
        failOnceEventType &&
        event?.itemType === "semantic-event" &&
        event.data.eventType === failOnceEventType
      ) {
        failed = true;
        throw new DatabaseError({
          cause: new Error("injected transaction failure"),
          message: `${failOnceEventType} transaction failed`,
          operation: "transact-write",
          table: "execution",
        });
      }
      const next = records(operations).find((record) => record.itemType === "sandbox-lease");
      if (next) stored = next;
    },
  };
}

function databaseSeededWith(
  initial: PlatformRecord,
  transactions: TransactionOperation[][],
): DynamoDatabaseService {
  let stored = initial;
  return {
    deleteRecord: async () => {},
    getRecord: async () => stored,
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      transactions.push([...operations]);
      const next = records(operations).find((record) => record.itemType === "sandbox-lease");
      if (next) stored = next;
    },
  };
}

describe("managed sandbox create reconciliation", () => {
  test("rejects automatic allocation reconciliation after provider configuration changes", async () => {
    const transactions: TransactionOperation[][] = [];
    let createCalls = 0;
    let fingerprint = "lambda-config-a";
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      allocationFingerprint: () => fingerprint,
      automaticAllocationReconciliation: true,
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async (input) => {
        createCalls += 1;
        throw new SandboxAllocationUnknownError({
          allocationError: new Error("response timeout"),
          allocationToken: String(input.allocationId),
        });
      },
      destroy: async () => undefined,
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
      resume: async () => {
        throw new Error("not reached");
      },
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(provider, statefulDatabase(transactions), makeIdGenerator());

    expect(
      Effect.runPromise(
        manager.create({
          executionTargetId: AGENT_DEPLOYMENT_ID,
          executionTargetKind: "agent-deployment",
          environmentId: ENVIRONMENT_ID,
          isolationMode: "run-ephemeral",
          observability: OBSERVABILITY,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          runId: RUN_ID,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "create",
    });

    const unknown = leaseRecord(transactions.at(-1) ?? []);
    expect(unknown.data.providerConfigFingerprint).toBe("lambda-config-a");
    fingerprint = "lambda-config-b";
    expect(Effect.runPromise(manager.reconcileCreate(unknown))).rejects.toMatchObject({
      _tag: "SandboxRecordError",
    });
    const resolved = await Effect.runPromise(
      manager.resolveCreateAsNotAllocated(unknown, Date.parse(unknown.data.updatedAt)),
    );
    expect(resolved.data).toMatchObject({
      failureReason: "provider-create-manually-confirmed-absent",
      status: "destroyed",
    });
    expect(createCalls).toBe(1);
  });

  test("reconciles an allocated sandbox after an unknown allocation commit", async () => {
    const transactions: TransactionOperation[][] = [];
    const allocationIds: Array<Ulid | undefined> = [];
    let reconciliationFailures = 3;
    let failAllocationCommit = true;
    let stored: PlatformRecord | undefined;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_unknown_allocation_commit",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      runId: RUN_ID,
      status: "ready",
    };
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      allocationFingerprint: () => "lambda-test-config",
      automaticAllocationReconciliation: true,
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async (input) => {
        allocationIds.push(input.allocationId);
        return lease;
      },
      destroy: async () => undefined,
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
      resume: async () => lease,
      upload: async () => undefined,
    };
    const failure = new DatabaseError({
      cause: new Error("allocation commit response lost"),
      message: "allocation commit outcome unknown",
      operation: "transact-write",
      table: "execution",
    });
    const db: DynamoDatabaseService = {
      deleteRecord: async () => {},
      getRecord: async () => {
        if (reconciliationFailures > 0) {
          reconciliationFailures -= 1;
          throw failure;
        }
        return stored;
      },
      putRecord: async () => {},
      queryRecords: async () => ({ items: [] }),
      transactWrite: async (operations) => {
        transactions.push([...operations]);
        const event = records(operations).find((record) => record.itemType === "semantic-event");
        if (
          failAllocationCommit &&
          event?.itemType === "semantic-event" &&
          event.data.eventType === "sandbox.allocated"
        ) {
          failAllocationCommit = false;
          throw failure;
        }
        const next = records(operations).find((record) => record.itemType === "sandbox-lease");
        if (next) stored = next;
      },
    };
    const manager = makeSandboxManager(provider, db, makeIdGenerator(), {
      now: () => 10_000,
    });

    expect(
      Effect.runPromise(
        manager.create({
          executionTargetId: AGENT_DEPLOYMENT_ID,
          executionTargetKind: "agent-deployment",
          environmentId: ENVIRONMENT_ID,
          isolationMode: "run-ephemeral",
          observability: OBSERVABILITY,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          runId: RUN_ID,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "SandboxPersistenceUnknownError" });

    if (!stored || stored.itemType !== "sandbox-lease") throw new Error("Missing creating lease");
    const reconciled = await Effect.runPromise(manager.reconcileCreate(stored));
    expect(reconciled.record.data.status).toBe("ready");
    expect(allocationIds).toEqual([stored.data.id, stored.data.id]);
  });

  test("does not publish recovered allocations without verified readiness", async () => {
    const setupTransactions: TransactionOperation[][] = [];
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_unverified_recovery",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      runId: RUN_ID,
      status: "ready",
    };
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async () => lease,
      destroy: async () => undefined,
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
      resume: async () => lease,
      upload: async () => undefined,
    };
    const setupManager = makeSandboxManager(
      provider,
      database(setupTransactions),
      makeIdGenerator(),
      { now: () => 1_000 },
    );
    await Effect.runPromise(
      setupManager.create({
        executionTargetId: AGENT_DEPLOYMENT_ID,
        executionTargetKind: "agent-deployment",
        environmentId: ENVIRONMENT_ID,
        isolationMode: "run-ephemeral",
        observability: OBSERVABILITY,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
      }),
    );
    const allocatedTransaction = setupTransactions.find((transaction) =>
      records(transaction).some(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "sandbox.allocated",
      ),
    );
    const allocated = leaseRecord(allocatedTransaction ?? []);

    let validationCalls = 0;
    const verifiedTransactions: TransactionOperation[][] = [];
    const verifiedManager = makeSandboxManager(
      {
        ...provider,
        validateReadyLease: async (recovered) => {
          validationCalls += 1;
          return {
            ...recovered,
            leaseExpiresAt: 20_000,
            reservedMemoryMiB: 4_096,
            reservedVcpu: 2,
            status: "ready",
          };
        },
      },
      databaseSeededWith(allocated, verifiedTransactions),
      makeIdGenerator(),
      { now: () => 2_000 },
    );
    const verified = await Effect.runPromise(verifiedManager.reconcileCreate(allocated));
    expect(verified.record.data).toMatchObject({
      leaseExpiresAt: "1970-01-01T00:00:20.000Z",
      reservedMemoryMiB: 4_096,
      reservedVcpu: 2,
      status: "ready",
    });
    expect(validationCalls).toBe(1);

    const manualTransactions: TransactionOperation[][] = [];
    const manualManager = makeSandboxManager(
      provider,
      databaseSeededWith(allocated, manualTransactions),
      makeIdGenerator(),
      { now: () => 2_000 },
    );
    expect(Effect.runPromise(manualManager.reconcileCreate(allocated))).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: "Sandbox provider requires manual ready-lease reconciliation.",
    });
    expect(manualTransactions).toHaveLength(0);

    const unreadyTransactions: TransactionOperation[][] = [];
    const unreadyManager = makeSandboxManager(
      {
        ...provider,
        validateReadyLease: async (recovered) => ({
          ...recovered,
          status: "suspended",
        }),
      },
      databaseSeededWith(allocated, unreadyTransactions),
      makeIdGenerator(),
      { now: () => 2_000 },
    );
    expect(Effect.runPromise(unreadyManager.reconcileCreate(allocated))).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: "Sandbox provider returned a lease with invalid readiness, policy, or image.",
    });
    expect(unreadyTransactions).toHaveLength(0);
  });

  test("terminalizes an allocated lease that expired before ready reconciliation", async () => {
    const setupTransactions: TransactionOperation[][] = [];
    let destroyCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_expired_reconciliation",
      isolationMode: "run-ephemeral",
      leaseExpiresAt: 1_000,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      runId: RUN_ID,
      status: "ready",
    };
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async () => lease,
      destroy: async () => {
        destroyCalls += 1;
      },
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
      resume: async () => lease,
      upload: async () => undefined,
    };
    const setupManager = makeSandboxManager(
      provider,
      database(setupTransactions),
      makeIdGenerator(),
      {
        now: (() => {
          const times = [0, 100, 200];
          return () => times.shift() ?? 200;
        })(),
      },
    );
    await Effect.runPromise(
      setupManager.create({
        executionTargetId: AGENT_DEPLOYMENT_ID,
        executionTargetKind: "agent-deployment",
        environmentId: ENVIRONMENT_ID,
        isolationMode: "run-ephemeral",
        observability: OBSERVABILITY,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
      }),
    );
    const allocatedTransaction = setupTransactions.find((transaction) =>
      records(transaction).some(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "sandbox.allocated",
      ),
    );
    const allocated = leaseRecord(allocatedTransaction ?? []);
    const recoveryTransactions: TransactionOperation[][] = [];
    const recoveryManager = makeSandboxManager(
      provider,
      databaseSeededWith(allocated, recoveryTransactions),
      makeIdGenerator(),
      { now: () => 2_000 },
    );

    expect(Effect.runPromise(recoveryManager.reconcileCreate(allocated))).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: "Sandbox allocation expired before ready reconciliation.",
    });
    expect(leaseRecord(recoveryTransactions.at(-1) ?? []).data).toMatchObject({
      destroyedAt: "1970-01-01T00:00:02.000Z",
      failureReason: "provider-lease-expired-before-ready-reconciliation",
      status: "destroyed",
    });
    expect(destroyCalls).toBe(1);
    const usage = records(recoveryTransactions.at(-1) ?? []).find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
        record.itemType === "meter-event" && record.data.metric === "sandbox_ms",
    );
    expect(usage?.data.quantity).toBe(1_000);
    expect(
      recoveryTransactions
        .flatMap(records)
        .some(
          (record) =>
            record.itemType === "semantic-event" && record.data.eventType === "sandbox.ready",
        ),
    ).toBe(false);
  });

  test("meters cleanup retries as non-overlapping usage segments", async () => {
    const transactions: TransactionOperation[][] = [];
    const times = [0, 100, 200, 1_000, 2_000, 3_000, 5_000];
    let destroyCalls = 0;
    let resumeCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_retry",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      reservedMemoryMiB: 2_048,
      reservedVcpu: 1,
      runId: RUN_ID,
      status: "ready",
    };
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => ({
        checkpointRef: "checkpoint",
        createdAt: 1,
        provider: "aws_lambda_microvm",
      }),
      create: async () => lease,
      destroy: async () => {
        destroyCalls += 1;
        if (destroyCalls === 1) throw new Error("temporary terminate failure");
      },
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
      resume: async () => {
        resumeCalls += 1;
        return lease;
      },
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(provider, database(transactions), makeIdGenerator(), {
      now: () => times.shift() ?? 5_000,
    });
    const sandbox = await Effect.runPromise(
      manager.create({
        executionTargetId: AGENT_DEPLOYMENT_ID,
        executionTargetKind: "agent-deployment",
        environmentId: ENVIRONMENT_ID,
        isolationMode: "run-ephemeral",
        observability: OBSERVABILITY,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
      }),
    );

    expect(Effect.runPromise(manager.destroy(sandbox))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "destroy",
    });
    const errored = managedSandboxFromRecord(leaseRecord(transactions[4] ?? []));
    expect(Effect.runPromise(manager.resume(errored))).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: "Sandbox error state is cleanup-only and cannot be resumed.",
    });
    const destroyed = await Effect.runPromise(manager.destroy(errored));

    expect(destroyed.data.status).toBe("destroyed");
    expect(destroyed.data.failureReason).toBeUndefined();
    expect(destroyCalls).toBe(2);
    expect(resumeCalls).toBe(0);
    const usage = transactions
      .flatMap(records)
      .filter(
        (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
          record.itemType === "meter-event" && record.data.metric === "sandbox_ms",
      );
    expect(usage.map((record) => record.data.quantity)).toEqual([2_000, 3_000]);
    expect(new Set(usage.map((record) => record.data.idempotencyKey)).size).toBe(2);
    expect(usage.map((record) => record.data.dimensions)).toEqual([
      expect.objectContaining({
        segmentEndedAt: "1970-01-01T00:00:02.000Z",
        segmentStartedAt: "1970-01-01T00:00:00.000Z",
      }),
      expect.objectContaining({
        segmentEndedAt: "1970-01-01T00:00:05.000Z",
        segmentStartedAt: "1970-01-01T00:00:02.000Z",
      }),
    ]);
  });
});
