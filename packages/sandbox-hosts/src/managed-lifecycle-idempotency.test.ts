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
  type SandboxLease,
  type SandboxLeaseRecordValue,
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

describe("managed sandbox lifecycle idempotency", () => {
  test("recovers suspended persistence after the provider checkpoint succeeds", async () => {
    const transactions: TransactionOperation[][] = [];
    const times = [0, 100, 200, 1_000, 2_000, 9_000];
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_checkpoint_recovery",
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
        checkpointRef: "lambda-microvm://microvm_checkpoint_recovery/suspended",
        createdAt: 1,
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
      resume: async () => lease,
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(
      provider,
      statefulDatabase(transactions, "sandbox.suspended"),
      makeIdGenerator(),
      { now: () => times.shift() ?? 9_000 },
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

    const checkpointed = await Effect.runPromise(manager.checkpoint(sandbox));

    expect(checkpointed.record.data).toMatchObject({
      status: "suspended",
      usageAccountedThrough: "1970-01-01T00:00:02.000Z",
    });
    const suspendedTransactions = transactions.filter((transaction) =>
      records(transaction).some(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "sandbox.suspended",
      ),
    );
    expect(suspendedTransactions).toHaveLength(2);
    expect(suspendedTransactions.map(leaseRecord).map((record) => record.data.updatedAt)).toEqual([
      "1970-01-01T00:00:02.000Z",
      "1970-01-01T00:00:02.000Z",
    ]);
    const eventIds = suspendedTransactions.map(
      (transaction) =>
        records(transaction).find((record) => record.itemType === "semantic-event")?.sk,
    );
    expect(eventIds[0]).toBe(eventIds[1]);
  });

  test("retries the destroyed transaction without calling the provider twice", async () => {
    const transactions: TransactionOperation[][] = [];
    const times = [0, 100, 200, 1_000, 2_000, 9_000];
    let destroyCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_destroy_recovery",
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
    const manager = makeSandboxManager(
      provider,
      statefulDatabase(transactions, "sandbox.destroyed"),
      makeIdGenerator(),
      { now: () => times.shift() ?? 9_000 },
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

    const destroyed = await Effect.runPromise(manager.destroy(sandbox));

    expect(destroyed.data.status).toBe("destroyed");
    expect(destroyed.data.destroyedAt).toBe("1970-01-01T00:00:02.000Z");
    expect(destroyCalls).toBe(1);
    const destroyedTransactions = transactions.filter((transaction) =>
      records(transaction).some(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "sandbox.destroyed",
      ),
    );
    expect(destroyedTransactions.map(leaseRecord).map((record) => record.data.destroyedAt)).toEqual(
      ["1970-01-01T00:00:02.000Z", "1970-01-01T00:00:02.000Z"],
    );
  });

  test("retries the post-destroy completion marker without calling the provider twice", async () => {
    const transactions: TransactionOperation[][] = [];
    const times = [0, 100, 200, 1_000, 2_000, 9_000];
    let destroyCalls = 0;
    let markerFailures = 0;
    let stored: PlatformRecord | undefined;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_destroy_marker_recovery",
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
    const markerFailure = new DatabaseError({
      cause: new Error("marker response timeout"),
      message: "destroy completion marker failed",
      operation: "transact-write",
      table: "execution",
    });
    const db: DynamoDatabaseService = {
      deleteRecord: async () => {},
      getRecord: async () => stored,
      putRecord: async () => {},
      queryRecords: async () => ({ items: [] }),
      transactWrite: async (operations) => {
        transactions.push([...operations]);
        const next = records(operations).find((record) => record.itemType === "sandbox-lease");
        if (
          next?.itemType === "sandbox-lease" &&
          next.data.destroyCompletedAt &&
          markerFailures++ === 0
        ) {
          throw markerFailure;
        }
        if (next) stored = next;
      },
    };
    const manager = makeSandboxManager(provider, db, makeIdGenerator(), {
      now: () => times.shift() ?? 9_000,
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

    const destroyed = await Effect.runPromise(manager.destroy(sandbox));

    expect(destroyed.data.status).toBe("destroyed");
    expect(destroyCalls).toBe(1);
    const markerTransactions = transactions.filter(
      (transaction) => leaseRecord(transaction).data.destroyCompletedAt !== undefined,
    );
    expect(markerTransactions).toHaveLength(2);
    expect(
      markerTransactions.map(
        (transaction) =>
          records(transaction).find((record) => record.itemType === "semantic-event")?.sk,
      ),
    ).toEqual([expect.any(String), expect.any(String)]);
    expect(
      records(markerTransactions[0] ?? []).find((record) => record.itemType === "semantic-event")
        ?.sk,
    ).toBe(
      records(markerTransactions[1] ?? []).find((record) => record.itemType === "semantic-event")
        ?.sk,
    );
  });

  test("does not replay destroy from a stale releasing snapshot", async () => {
    let destroyCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_stale_releasing",
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
    const setupTransactions: TransactionOperation[][] = [];
    const setupManager = makeSandboxManager(
      provider,
      database(setupTransactions),
      makeIdGenerator(),
      { now: () => 1_000 },
    );
    const sandbox = await Effect.runPromise(
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
    const releasing: SandboxLeaseRecordValue = {
      ...sandbox.record,
      data: {
        ...sandbox.record.data,
        status: "releasing",
        updatedAt: "1970-01-01T00:00:02.000Z",
        version: sandbox.record.data.version + 1,
      },
    };
    const destroyed: SandboxLeaseRecordValue = {
      ...releasing,
      data: {
        ...releasing.data,
        computeUsageActive: false,
        destroyedAt: "1970-01-01T00:00:03.000Z",
        status: "destroyed",
        updatedAt: "1970-01-01T00:00:03.000Z",
        usageAccountedThrough: "1970-01-01T00:00:03.000Z",
        version: releasing.data.version + 1,
      },
    };
    const transactions: TransactionOperation[][] = [];
    const manager = makeSandboxManager(
      provider,
      databaseSeededWith(destroyed, transactions),
      makeIdGenerator(),
      { now: () => 4_000 },
    );

    expect(
      Effect.runPromise(manager.destroy(managedSandboxFromRecord(releasing))),
    ).resolves.toEqual(destroyed);
    expect(destroyCalls).toBe(0);
    expect(transactions).toHaveLength(0);
  });

  test("enforces checkpoint and resume source states", async () => {
    const transactions: TransactionOperation[][] = [];
    let checkpointCalls = 0;
    let resumeCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_source_state",
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
          checkpointRef: "lambda-microvm://microvm_source_state/suspended",
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
      resume: async () => {
        resumeCalls += 1;
        return lease;
      },
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
      }),
    );
    expect(Effect.runPromise(manager.resume(sandbox))).rejects.toMatchObject({
      _tag: "SandboxRecordError",
    });
    const suspended = await Effect.runPromise(manager.checkpoint(sandbox));
    expect(Effect.runPromise(manager.checkpoint(suspended))).rejects.toMatchObject({
      _tag: "SandboxRecordError",
    });
    expect(resumeCalls).toBe(0);
    expect(checkpointCalls).toBe(1);
  });

  test("rejects mismatched provider leases before lifecycle calls", async () => {
    const transactions: TransactionOperation[][] = [];
    let checkpointCalls = 0;
    let destroyCalls = 0;
    let resumeCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_lifecycle_identity",
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
          checkpointRef: "lambda-microvm://microvm_lifecycle_identity/suspended",
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
      resume: async () => {
        resumeCalls += 1;
        return lease;
      },
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
      }),
    );
    const mismatched = {
      ...sandbox,
      lease: { ...sandbox.lease, externalSandboxId: "microvm_other" },
    };

    expect(Effect.runPromise(manager.checkpoint(mismatched))).rejects.toMatchObject({
      _tag: "SandboxRecordError",
    });
    expect(Effect.runPromise(manager.destroy(mismatched))).rejects.toMatchObject({
      _tag: "SandboxRecordError",
    });
    expect(checkpointCalls).toBe(0);
    expect(destroyCalls).toBe(0);

    const suspended = await Effect.runPromise(manager.checkpoint(sandbox));
    expect(
      Effect.runPromise(
        manager.resume({
          ...suspended,
          lease: { ...suspended.lease, externalSandboxId: "microvm_other" },
        }),
      ),
    ).rejects.toMatchObject({ _tag: "SandboxRecordError" });
    expect(checkpointCalls).toBe(1);
    expect(resumeCalls).toBe(0);
  });
});
