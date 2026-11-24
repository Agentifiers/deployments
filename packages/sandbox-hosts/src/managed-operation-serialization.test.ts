import {
  DatabaseError,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
  makeIdGenerator,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import {
  managedSandboxFromRecord,
  SandboxAllocationUnknownError,
  SandboxCheckpointUnknownError,
  SandboxDestroyUnknownError,
  SandboxResumeUnknownError,
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

describe("managed sandbox operation serialization", () => {
  test("releases an interrupted resume lease during provider preflight", async () => {
    let markResumePreflightStarted: (() => void) | undefined;
    const resumePreflightStarted = new Promise<void>((resolve) => {
      markResumePreflightStarted = resolve;
    });
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_resume_preflight_abort",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      runId: RUN_ID,
      status: "ready",
    };
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async (input) => ({
        checkpointRef: `lambda-microvm://${input.lease.externalSandboxId}/suspended`,
        createdAt: Date.now(),
        provider: "aws_lambda_microvm",
      }),
      create: async () => lease,
      destroy: async () => undefined,
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
      resume: async (input) => {
        markResumePreflightStarted?.();
        return await new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason), {
            once: true,
          });
        });
      },
      upload: async () => undefined,
    };
    const database = recordStoreDatabase();
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
    const suspended = await Effect.runPromise(manager.checkpoint(sandbox));
    const fiber = Effect.runFork(manager.resume(suspended));
    await resumePreflightStarted;

    await Effect.runPromise(Fiber.interrupt(fiber));

    const operationLeaseKey = withCanonicalRecordKeys({
      data: {
        id: suspended.record.data.id,
        leaseKey: `sandbox-provider-operation/${suspended.record.data.id}`,
      },
      itemType: "runtime-lease" as const,
    });
    const operationLease = await database.getRecord(
      "execution",
      { pk: operationLeaseKey.pk, sk: operationLeaseKey.sk },
      true,
    );
    expect(operationLease === undefined).toBe(true);
  });

  test("retains the operation lease after ambiguous lifecycle mutations", async () => {
    const transactions: TransactionOperation[][] = [];
    let checkpointMode: "success" | "unknown" = "success";
    let createMode: "success" | "unknown" = "unknown";
    let destroyMode: "success" | "unknown" = "success";
    let resumeMode: "success" | "unknown" = "success";
    let createCalls = 0;
    let checkpointReconciliationCalls = 0;
    let destroyCalls = 0;
    let resumeReconciliationCalls = 0;
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      allocationFingerprint: () => "lambda-operation-lease-test",
      automaticAllocationReconciliation: true,
      checkpoint: async (input) => {
        if (checkpointMode === "unknown") {
          throw new SandboxCheckpointUnknownError(new Error("checkpoint response timeout"));
        }
        return {
          checkpointRef: `lambda-microvm://${input.lease.externalSandboxId}/suspended`,
          createdAt: Date.now(),
          provider: "aws_lambda_microvm",
        };
      },
      create: async (input) => {
        createCalls += 1;
        if (createMode === "unknown") {
          throw new SandboxAllocationUnknownError({
            allocationError: new Error("create response timeout"),
            allocationToken: String(input.allocationId),
          });
        }
        return {
          ...input,
          externalSandboxId: `microvm_${input.allocationId}`,
          provider: "aws_lambda_microvm",
          status: "ready",
        };
      },
      destroy: async () => {
        destroyCalls += 1;
        if (destroyMode === "unknown") {
          throw new SandboxDestroyUnknownError(new Error("destroy response timeout"));
        }
      },
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
      reconcileCheckpoint: async (input) => {
        checkpointReconciliationCalls += 1;
        return { lease: { ...input.lease, status: "ready" } };
      },
      reconcileResume: async (input) => {
        resumeReconciliationCalls += 1;
        return { ...input.lease, status: "ready" };
      },
      resume: async (input) => {
        if (resumeMode === "unknown") {
          throw new SandboxResumeUnknownError(new Error("resume response timeout"));
        }
        return { ...input.lease, status: "ready" };
      },
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(
      provider,
      recordStoreDatabase([], transactions),
      makeIdGenerator(),
      { operationAcquireTimeoutMs: 0 },
    );
    const createInput = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment" as const,
      environmentId: ENVIRONMENT_ID,
      isolationMode: "run-ephemeral" as const,
      observability: OBSERVABILITY,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
    };

    expect(Effect.runPromise(manager.create(createInput))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "create",
    });
    const unknownCreate = leaseRecord(transactions.at(-1) ?? []);
    createMode = "success";
    expect(Effect.runPromise(manager.reconcileCreate(unknownCreate))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "reconcile-create-lease",
    });
    expect(createCalls).toBe(1);

    const checkpointSandbox = await Effect.runPromise(manager.create(createInput));
    checkpointMode = "unknown";
    expect(Effect.runPromise(manager.checkpoint(checkpointSandbox))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "checkpoint",
    });
    const unknownCheckpoint = leaseRecord(transactions.at(-1) ?? []);
    expect(Effect.runPromise(manager.reconcileCheckpoint(unknownCheckpoint))).rejects.toMatchObject(
      {
        _tag: "SandboxOperationError",
        operation: "reconcile-checkpoint-lease",
      },
    );
    expect(checkpointReconciliationCalls).toBe(0);

    checkpointMode = "success";
    const destroySandbox = await Effect.runPromise(manager.create(createInput));
    destroyMode = "unknown";
    expect(Effect.runPromise(manager.destroy(destroySandbox))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "destroy",
    });
    const unknownDestroy = managedSandboxFromRecord(leaseRecord(transactions.at(-1) ?? []));
    expect(Effect.runPromise(manager.destroy(unknownDestroy))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "destroy-lease",
    });
    expect(destroyCalls).toBe(1);

    destroyMode = "success";
    const resumeSandbox = await Effect.runPromise(manager.create(createInput));
    const suspended = await Effect.runPromise(manager.checkpoint(resumeSandbox));
    resumeMode = "unknown";
    expect(Effect.runPromise(manager.resume(suspended))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "resume",
    });
    const unknownResume = leaseRecord(transactions.at(-1) ?? []);
    expect(
      Effect.runPromise(
        manager.reconcileResumeWithLease(unknownResume, {
          ...managedSandboxFromRecord(unknownResume).lease,
          status: "ready",
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "reconcile-resume-lease",
    });
    expect(resumeReconciliationCalls).toBe(0);
  });

  test("rejects stale and expired ready snapshots before data-plane calls", async () => {
    const transactions: TransactionOperation[][] = [];
    let execCalls = 0;
    let clock = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_stale",
      isolationMode: "run-ephemeral",
      leaseExpiresAt: 10_000,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      runId: RUN_ID,
      status: "ready",
    };
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => ({
        checkpointRef: "lambda-microvm://microvm_stale/suspended",
        createdAt: 1,
        provider: "aws_lambda_microvm",
      }),
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
    const manager = makeSandboxManager(
      provider,
      statefulDatabase(transactions),
      makeIdGenerator(),
      {
        now: () => clock,
      },
    );
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
    await Effect.runPromise(manager.checkpoint(sandbox));

    expect(Effect.runPromise(manager.exec({ command: ["pwd"], sandbox }))).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: "Sandbox state changed; reload the lease before a data-plane operation.",
    });

    const secondTransactions: TransactionOperation[][] = [];
    const secondManager = makeSandboxManager(
      provider,
      statefulDatabase(secondTransactions),
      makeIdGenerator(),
      { now: () => clock },
    );
    const expiring = await Effect.runPromise(
      secondManager.create({
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
    clock = 10_000;
    expect(
      Effect.runPromise(secondManager.exec({ command: ["pwd"], sandbox: expiring })),
    ).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: "Sandbox lease has expired.",
    });
    expect(execCalls).toBe(0);
  });

  test("rejects ready data-plane records without provider route identity", async () => {
    let execCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_missing_route",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      runId: RUN_ID,
      status: "ready",
    };
    const baseProvider: SandboxProvider = {
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
    const database = recordStoreDatabase();
    const sandbox = await Effect.runPromise(
      makeSandboxManager(baseProvider, database, makeIdGenerator()).create({
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
    const routedProvider: SandboxProvider = {
      ...baseProvider,
      validateLeaseRoute: () => undefined,
    };

    expect(
      Effect.runPromise(
        makeSandboxManager(routedProvider, database, makeIdGenerator()).exec({
          command: ["pwd"],
          sandbox,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: "Sandbox lifecycle record is missing its provider route key.",
    });
    expect(execCalls).toBe(0);
  });

  test("serializes checkpoint behind an in-flight data-plane operation", async () => {
    const transactions: TransactionOperation[][] = [];
    let checkpointCalls = 0;
    let releaseExec: (() => void) | undefined;
    let markExecStarted: (() => void) | undefined;
    const execStarted = new Promise<void>((resolve) => {
      markExecStarted = resolve;
    });
    const execReleased = new Promise<void>((resolve) => {
      releaseExec = resolve;
    });
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_serialized_data_plane",
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
        return {
          checkpointRef: "lambda-microvm://microvm_serialized_data_plane/suspended",
          createdAt: Date.now(),
          provider: "aws_lambda_microvm",
        };
      },
      create: async () => lease,
      destroy: async () => undefined,
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => {
        markExecStarted?.();
        await execReleased;
        return { durationMs: 1, exitCode: 0, stderr: "", stdout: "" };
      },
      resume: async () => lease,
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(provider, statefulDatabase(transactions), makeIdGenerator());
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

    const exec = Effect.runPromise(manager.exec({ command: ["sleep"], sandbox }));
    await execStarted;
    const checkpoint = Effect.runPromise(manager.checkpoint(sandbox));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(checkpointCalls).toBe(0);
    releaseExec?.();
    await exec;
    await checkpoint;
    expect(checkpointCalls).toBe(1);
  });

  test("does not retain a durable lease when a queued operation is interrupted", async () => {
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
      externalSandboxId: "microvm_interrupted_queue",
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
    const manager = makeSandboxManager(provider, recordStoreDatabase(), makeIdGenerator());
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
    const queued = Effect.runFork(manager.exec({ command: ["pwd"], sandbox }));
    const interrupted = Effect.runPromise(Fiber.interrupt(queued));
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirst?.();
    await first;
    await interrupted;

    expect(Effect.runPromise(manager.exec({ command: ["pwd"], sandbox }))).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(execCalls).toBe(2);
  });
});
