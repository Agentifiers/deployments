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
  SandboxAllocationCleanupError,
  SandboxCheckpointUnknownError,
  SandboxDestroyUnknownError,
  type SandboxLease,
  type SandboxLeaseRecordValue,
  type SandboxProvider,
} from "./index.ts";
import { makeSandboxManager } from "./sandbox-manager.fixture.ts";

const IDS = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  "01ARZ3NDEKTSV4RRFFQ69G5FB1",
  "01ARZ3NDEKTSV4RRFFQ69G5FB2",
  "01ARZ3NDEKTSV4RRFFQ69G5FB8",
  "01ARZ3NDEKTSV4RRFFQ69G5FB9",
  "01ARZ3NDEKTSV4RRFFQ69G5FBA",
  "01ARZ3NDEKTSV4RRFFQ69G5FBB",
  "01ARZ3NDEKTSV4RRFFQ69G5FBC",
] as const satisfies readonly string[];

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
    getRecord: async (_table, key) => stored.get(recordKey(key)),
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

describe("managed sandbox compensation", () => {
  test("rejects checkpoint responses from a different provider", async () => {
    const transactions: TransactionOperation[][] = [];
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "sandbox_wrong_checkpoint_provider",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      runId: RUN_ID,
      status: "ready",
      workspaceId: IDS[8] as Ulid,
    };
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => ({
        checkpointRef: "wrong-provider-checkpoint",
        createdAt: 1,
        provider: "unknown_provider" as SandboxLease["provider"],
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
      resume: async () => lease,
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(provider, database(transactions), makeIdGenerator());
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
        workspaceId: IDS[8] as Ulid,
      }),
    );

    expect(Effect.runPromise(manager.checkpoint(sandbox))).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: "Sandbox checkpoint returned the wrong provider.",
    });
    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      computeUsageActive: true,
      failureReason: "provider-checkpoint-provider-mismatch",
      status: "error",
    });
  });

  test("destroys an allocated sandbox when ready persistence fails", async () => {
    const transactions: TransactionOperation[][] = [];
    let destroyCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_cleanup",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
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
    const failedReady = new DatabaseError({
      cause: new Error("network timeout"),
      message: "ready transaction failed",
      operation: "transact-write",
      table: "execution",
    });
    const db = database(transactions);
    const failingDatabase: DynamoDatabaseService = {
      ...db,
      transactWrite: async (operations) => {
        transactions.push([...operations]);
        const event = records(operations).find((record) => record.itemType === "semantic-event");
        if (event?.itemType === "semantic-event" && event.data.eventType === "sandbox.ready")
          throw failedReady;
      },
    };
    const manager = makeSandboxManager(provider, failingDatabase, makeIdGenerator(), {
      now: (() => {
        let value = 0;
        return () => (value += 100);
      })(),
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
    ).rejects.toMatchObject({
      _tag: "DatabaseError",
      message: "ready transaction failed",
    });

    expect(destroyCalls).toBe(1);
    const recovery = transactions
      .map(leaseRecord)
      .find((record) => record.data.status === "destroyed") as SandboxLeaseRecordValue | undefined;
    expect(recovery?.data).toMatchObject({
      externalSandboxId: "microvm_cleanup",
      failureReason: "ready-persistence-failed",
      status: "destroyed",
    });

    const transactionCount = transactions.length;
    const usageCount = transactions
      .flatMap(records)
      .filter((record) => record.itemType === "meter-event").length;
    expect(
      Effect.runPromise(
        manager.destroy(managedSandboxFromRecord(recovery as SandboxLeaseRecordValue)),
      ),
    ).resolves.toMatchObject({ data: { status: "destroyed" } });
    expect(destroyCalls).toBe(1);
    expect(transactions).toHaveLength(transactionCount);
    expect(
      transactions.flatMap(records).filter((record) => record.itemType === "meter-event"),
    ).toHaveLength(usageCount);
  });

  test("persists the external ID when manager cleanup recovers a Lambda allocation", async () => {
    const transactions: TransactionOperation[][] = [];
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_leaked",
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
        throw new SandboxAllocationCleanupError({
          allocationError: new Error("readiness failed"),
          cleanupError: new Error("terminate denied"),
          lease,
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
    const manager = makeSandboxManager(provider, database(transactions), makeIdGenerator());

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

    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      externalSandboxId: "microvm_leaked",
      failureReason: "provider-create-cleanup-failed",
      status: "destroyed",
    });
  });

  test("re-suspends a resumed sandbox when ready persistence fails", async () => {
    const transactions: TransactionOperation[][] = [];
    let checkpointCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_resume_compensation",
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
          checkpointRef: "lambda-microvm://microvm_resume_compensation/suspended",
          createdAt: 1,
          provider: "aws_lambda_microvm",
        };
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
      resume: async () => ({ ...lease, status: "ready" }),
      upload: async () => undefined,
    };
    const resumeFailure = new DatabaseError({
      cause: new Error("network timeout"),
      message: "resume transaction failed",
      operation: "transact-write",
      table: "execution",
    });
    const base = database(transactions);
    const failingDatabase: DynamoDatabaseService = {
      ...base,
      transactWrite: async (operations) => {
        transactions.push([...operations]);
        const event = records(operations).find((record) => record.itemType === "semantic-event");
        if (event?.itemType === "semantic-event" && event.data.eventType === "sandbox.resumed")
          throw resumeFailure;
      },
    };
    const manager = makeSandboxManager(provider, failingDatabase, makeIdGenerator());
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

    expect(Effect.runPromise(manager.resume(suspended))).rejects.toMatchObject({
      _tag: "DatabaseError",
      message: "resume transaction failed",
    });

    expect(checkpointCalls).toBe(2);
    const compensated = transactions
      .map(leaseRecord)
      .find((record) => record.data.failureReason === "resume-persistence-failed");
    expect(compensated?.data).toMatchObject({
      checkpointRef: "lambda-microvm://microvm_resume_compensation/suspended",
      status: "suspended",
    });
  });

  test("does not destroy after an ambiguous resume-compensation checkpoint", async () => {
    const transactions: TransactionOperation[][] = [];
    let checkpointCalls = 0;
    let destroyCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_resume_compensation_unknown",
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
        if (checkpointCalls > 1) {
          throw new SandboxCheckpointUnknownError(new Error("checkpoint response timeout"));
        }
        return {
          checkpointRef: "lambda-microvm://microvm_resume_compensation_unknown/suspended",
          createdAt: 1,
          provider: "aws_lambda_microvm",
        };
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
      resume: async () => ({ ...lease, status: "ready" }),
      upload: async () => undefined,
    };
    const resumeFailure = new DatabaseError({
      cause: new Error("network timeout"),
      message: "resume transaction failed",
      operation: "transact-write",
      table: "execution",
    });
    const base = recordStoreDatabase([], transactions);
    const failingDatabase: DynamoDatabaseService = {
      ...base,
      transactWrite: async (operations) => {
        const event = records(operations).find((record) => record.itemType === "semantic-event");
        if (event?.itemType === "semantic-event" && event.data.eventType === "sandbox.resumed")
          throw resumeFailure;
        await base.transactWrite(operations);
      },
    };
    const manager = makeSandboxManager(provider, failingDatabase, makeIdGenerator(), {
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
    const suspended = await Effect.runPromise(manager.checkpoint(sandbox));

    expect(Effect.runPromise(manager.resume(suspended))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "resume-compensation",
    });

    expect(checkpointCalls).toBe(2);
    expect(destroyCalls).toBe(0);
    const recovery = managedSandboxFromRecord(leaseRecord(transactions.at(-1) ?? []));
    expect(Effect.runPromise(manager.destroy(recovery))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "destroy-lease",
    });
  });

  test("keeps usage active when resume-compensation destroy is ambiguous", async () => {
    const transactions: TransactionOperation[][] = [];
    let checkpointCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_resume_cleanup_unknown",
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
        if (checkpointCalls > 1) throw new Error("checkpoint rejected");
        return {
          checkpointRef: "lambda-microvm://microvm_resume_cleanup_unknown/suspended",
          createdAt: 1,
          provider: "aws_lambda_microvm",
        };
      },
      create: async () => lease,
      destroy: async () => {
        throw new SandboxDestroyUnknownError(new Error("destroy response timeout"));
      },
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
      resume: async (input) => ({ ...input.lease, status: "ready" }),
      upload: async () => undefined,
    };
    const resumeFailure = new DatabaseError({
      cause: new Error("resume commit failed"),
      message: "resume transaction failed",
      operation: "transact-write",
      table: "execution",
    });
    const base = recordStoreDatabase([], transactions);
    const failingDatabase: DynamoDatabaseService = {
      ...base,
      transactWrite: async (operations) => {
        const event = records(operations).find((record) => record.itemType === "semantic-event");
        if (event?.itemType === "semantic-event" && event.data.eventType === "sandbox.resumed")
          throw resumeFailure;
        await base.transactWrite(operations);
      },
    };
    const manager = makeSandboxManager(provider, failingDatabase, makeIdGenerator());
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

    expect(Effect.runPromise(manager.resume(suspended))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "resume-compensation",
    });

    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      computeUsageActive: true,
      failureReason: "resume-persistence-failed-cleanup-failed",
      status: "error",
    });
  });
});
