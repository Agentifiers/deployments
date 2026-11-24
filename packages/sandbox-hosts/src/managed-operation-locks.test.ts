import {
  DatabaseError,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
  decodePlatformRecord,
  makeIdGenerator,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { type SandboxLease, type SandboxProvider } from "./index.ts";
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

function records(transaction: readonly TransactionOperation[]) {
  return transaction.flatMap((operation) => (operation.kind === "put" ? [operation.record] : []));
}

function leaseRecord(transaction: readonly TransactionOperation[]) {
  const record = records(transaction).find((candidate) => candidate.itemType === "sandbox-lease");
  if (!record || record.itemType !== "sandbox-lease") throw new Error("Missing sandbox lease");
  return record;
}

function recordStoreDatabase(
  initial: readonly PlatformRecord[] = [],
  transactions: TransactionOperation[][] = [],
): DynamoDatabaseService {
  const recordKey = (record: Pick<PlatformRecord, "pk" | "sk">) => `${record.pk}\u0000${record.sk}`;
  const stored = new Map(initial.map((record) => [recordKey(record), record]));
  return {
    deleteRecord: async (record) => {
      stored.delete(recordKey(record));
    },
    getRecord: async (_table, key) =>
      stored.has(recordKey(key)) ? (stored.get(recordKey(key)) as PlatformRecord) : undefined,
    putRecord: async (record, conditionExpression) => {
      const key = recordKey(record);
      if (conditionExpression && stored.has(key)) {
        throw new DatabaseError({
          cause: new Error("conditional put rejected"),
          message: "Conditional put rejected.",
          operation: "put",
          table: "execution",
        });
      }
      stored.set(key, record);
    },
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      transactions.push([...operations]);
      for (const operation of operations) {
        if (operation.kind === "put") stored.set(recordKey(operation.record), operation.record);
        if (operation.kind === "delete") stored.delete(recordKey(operation.record));
      }
    },
  };
}

describe("managed sandbox operation locks", () => {
  test("applies the acquisition timeout while waiting for the process-local lock", async () => {
    let execCalls = 0;
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_local_operation_timeout",
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
      exec: async () => {
        execCalls += 1;
        if (execCalls === 1) {
          markFirstStarted?.();
          await firstReleased;
        }
        return { durationMs: 1, exitCode: 0, stderr: "", stdout: "" };
      },
      resume: async () => lease,
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(provider, recordStoreDatabase(), makeIdGenerator(), {
      operationAcquireTimeoutMs: 0,
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
    const first = Effect.runPromise(manager.exec({ command: ["sleep"], sandbox }));
    await firstStarted;
    const queued = Effect.runPromise(manager.exec({ command: ["pwd"], sandbox })).then(
      () => ({ status: "success" as const }),
      (error: unknown) => ({ error, status: "failure" as const }),
    );
    const outcome = await Promise.race([
      queued,
      new Promise<{ status: "timed-out" }>((resolve) =>
        setTimeout(() => resolve({ status: "timed-out" }), 50),
      ),
    ]);

    releaseFirst?.();
    await first;
    await queued;

    expect(outcome).toMatchObject({
      error: { _tag: "SandboxOperationError", operation: "exec-lease" },
      status: "failure",
    });
    expect(execCalls).toBe(1);
  });

  test("fences provider calls behind a runtime lease held by another worker", async () => {
    let checkpointCalls = 0;
    let execCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_distributed_operation_lease",
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
        checkpointCalls += 1;
        throw new Error("not reached");
      },
      create: async () => lease,
      destroy: async () => undefined,
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => {
        execCalls += 1;
        return { durationMs: 1, exitCode: 0, stderr: "", stdout: "" };
      },
      resume: async () => lease,
      upload: async () => undefined,
    };
    const transactions: TransactionOperation[][] = [];
    const database = recordStoreDatabase([], transactions);
    const manager = makeSandboxManager(provider, database, makeIdGenerator(), {
      operationAcquireTimeoutMs: 0,
      operationLeaseNow: () => 0,
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
    const operationLease = await Effect.runPromise(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            acquiredAt: new Date(0).toISOString(),
            environmentId: ENVIRONMENT_ID,
            expiresAt: new Date(60_000).toISOString(),
            id: sandbox.record.data.id,
            leaseKey: `sandbox-provider-operation/${sandbox.record.data.id}`,
            organizationId: ORGANIZATION_ID,
            owner: "other-worker",
            projectId: PROJECT_ID,
            version: 0,
          },
          itemType: "runtime-lease" as const,
        }),
      ),
    );
    await database.putRecord(operationLease);
    const transactionCount = transactions.length;

    expect(Effect.runPromise(manager.exec({ command: ["pwd"], sandbox }))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "exec-lease",
    });
    expect(execCalls).toBe(0);
    expect(Effect.runPromise(manager.checkpoint(sandbox))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "checkpoint-lease",
    });
    expect(checkpointCalls).toBe(0);
    expect(transactions).toHaveLength(transactionCount);
  });

  test("retries durable acquisition when a contended lease disappears", async () => {
    let createCalls = 0;
    let runtimeLeasePutAttempts = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_operation_handoff",
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
      create: async () => {
        createCalls += 1;
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
    const stored = recordStoreDatabase();
    const conditionalFailure = new DatabaseError({
      cause: new Error("conditional put rejected"),
      message: "Runtime lease already existed.",
      operation: "put",
      table: "execution",
    });
    const database: DynamoDatabaseService = {
      ...stored,
      getRecord: async (table, key, consistentRead) =>
        runtimeLeasePutAttempts === 1 ? undefined : stored.getRecord(table, key, consistentRead),
      putRecord: async (record, conditionExpression) => {
        if (record.itemType === "runtime-lease" && (runtimeLeasePutAttempts += 1) === 1) {
          throw conditionalFailure;
        }
        return stored.putRecord(record, conditionExpression);
      },
    };
    const manager = makeSandboxManager(provider, database, makeIdGenerator(), {
      operationAcquireTimeoutMs: 100,
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
    ).resolves.toBeDefined();

    expect(runtimeLeasePutAttempts).toBe(2);
    expect(createCalls).toBe(1);
  });

  test("does not take over an expired runtime lease without provider-side fencing", async () => {
    let execCalls = 0;
    let runtimeLeasePuts = 0;
    let runtimeLeaseReads = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_stale_distributed_operation_lease",
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
      exec: async () => {
        execCalls += 1;
        return { durationMs: 1, exitCode: 0, stderr: "", stdout: "" };
      },
      resume: async () => lease,
      upload: async () => undefined,
    };
    const transactions: TransactionOperation[][] = [];
    const stored = recordStoreDatabase([], transactions);
    const database: DynamoDatabaseService = {
      ...stored,
      getRecord: (table, key, consistentRead) => {
        if (key.pk.startsWith("RUNTIME-LEASE#")) runtimeLeaseReads += 1;
        return stored.getRecord(table, key, consistentRead);
      },
      putRecord: (record, conditionExpression) => {
        if (record.itemType === "runtime-lease") runtimeLeasePuts += 1;
        return stored.putRecord(record, conditionExpression);
      },
    };
    const manager = makeSandboxManager(provider, database, makeIdGenerator(), {
      operationAcquireTimeoutMs: 100,
      operationLeaseNow: () => 60_001,
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
    const operationLease = await Effect.runPromise(
      decodePlatformRecord(
        withCanonicalRecordKeys({
          data: {
            acquiredAt: new Date(0).toISOString(),
            environmentId: ENVIRONMENT_ID,
            expiresAt: new Date(60_000).toISOString(),
            id: sandbox.record.data.id,
            leaseKey: `sandbox-provider-operation/${sandbox.record.data.id}`,
            organizationId: ORGANIZATION_ID,
            owner: "paused-worker",
            projectId: PROJECT_ID,
            version: 0,
          },
          itemType: "runtime-lease" as const,
        }),
      ),
    );
    await stored.putRecord(operationLease);
    runtimeLeasePuts = 0;
    runtimeLeaseReads = 0;
    const transactionCount = transactions.length;

    expect(Effect.runPromise(manager.exec({ command: ["pwd"], sandbox }))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "exec-lease",
    });

    expect(execCalls).toBe(0);
    expect(runtimeLeasePuts).toBe(1);
    expect(runtimeLeaseReads).toBe(1);
    expect(transactions).toHaveLength(transactionCount);
    const retained = await database.getRecord(
      "execution",
      { pk: operationLease.pk, sk: operationLease.sk },
      true,
    );
    expect(retained).toEqual(operationLease);
  });

  test("reports a durable operation lease release failure after bounded retries", async () => {
    let rejectDeletes = false;
    let deleteAttempts = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_operation_release_failure",
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
    const stored = recordStoreDatabase();
    const database: DynamoDatabaseService = {
      ...stored,
      deleteRecord: async (record) => {
        if (rejectDeletes && record.itemType === "runtime-lease") {
          deleteAttempts += 1;
          throw new DatabaseError({
            cause: new Error("injected runtime lease delete failure"),
            message: "Runtime lease delete failed.",
            operation: "delete",
            table: "execution",
          });
        }
        return stored.deleteRecord(record);
      },
    };
    const manager = makeSandboxManager(provider, database, makeIdGenerator());
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
    rejectDeletes = true;

    expect(Effect.runPromise(manager.exec({ command: ["pwd"], sandbox }))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      message: "Sandbox provider operation lease release failed.",
      operation: "exec-lease-release",
    });
    expect(deleteAttempts).toBe(3);
  });

  test("persists a successful allocation before reporting operation lease release failure", async () => {
    const transactions: TransactionOperation[][] = [];
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_create_release_failure",
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
    const stored = recordStoreDatabase([], transactions);
    const database: DynamoDatabaseService = {
      ...stored,
      deleteRecord: async (record) => {
        if (record.itemType === "runtime-lease") {
          throw new DatabaseError({
            cause: new Error("injected runtime lease delete failure"),
            message: "Runtime lease delete failed.",
            operation: "delete",
            table: "execution",
          });
        }
        return stored.deleteRecord(record);
      },
    };
    const manager = makeSandboxManager(provider, database, makeIdGenerator());

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
      operation: "create-lease-release",
    });
    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      computeUsageActive: true,
      externalSandboxId: "microvm_create_release_failure",
      status: "ready",
    });
  });
});
