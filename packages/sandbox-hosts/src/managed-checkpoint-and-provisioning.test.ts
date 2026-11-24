import {
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

describe("managed sandbox checkpointing and provisioning", () => {
  test("reconciles a durable checkpointing lease without replaying checkpoint", async () => {
    const setupTransactions: TransactionOperation[][] = [];
    let checkpointCalls = 0;
    let reconciliationCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_checkpointing_recovery",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      runId: RUN_ID,
      status: "ready",
    };
    const checkpointRef = {
      checkpointRef: "lambda-microvm://microvm_checkpointing_recovery/suspended",
      createdAt: 2_000,
      provider: "aws_lambda_microvm" as const,
    };
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        checkpointCalls += 1;
        return checkpointRef;
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
      reconcileCheckpoint: async (input) => {
        reconciliationCalls += 1;
        return {
          checkpoint: checkpointRef,
          lease: { ...input.lease, status: "suspended" },
        };
      },
      resume: async (input) => ({ ...input.lease, status: "ready" }),
      upload: async () => undefined,
    };
    const setupManager = makeSandboxManager(
      provider,
      database(setupTransactions),
      makeIdGenerator(),
      {
        now: (() => {
          const times = [0, 100, 200, 500, 2_500];
          return () => times.shift() ?? 2_500;
        })(),
      },
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
    await Effect.runPromise(setupManager.checkpoint(sandbox));
    const checkpointingTransaction = setupTransactions.find((transaction) =>
      records(transaction).some(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "sandbox.checkpointing",
      ),
    );
    const checkpointing = leaseRecord(checkpointingTransaction ?? []);

    const recoveryTransactions: TransactionOperation[][] = [];
    const recoveryManager = makeSandboxManager(
      provider,
      databaseSeededWith(checkpointing, recoveryTransactions),
      makeIdGenerator(),
      { now: () => 10_000 },
    );
    const recovered = await Effect.runPromise(recoveryManager.reconcileCheckpoint(checkpointing));

    expect(recovered.record.data).toMatchObject({
      checkpointRef: checkpointRef.checkpointRef,
      computeUsageActive: false,
      status: "suspended",
    });
    expect(checkpointCalls).toBe(1);
    expect(reconciliationCalls).toBe(1);
    const usage = records(recoveryTransactions.at(-1) ?? []).find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
        record.itemType === "meter-event" && record.data.metric === "sandbox_ms",
    );
    expect(usage?.data).toMatchObject({
      dimensions: {
        segmentEndedAt: "1970-01-01T00:00:02.000Z",
        segmentStartedAt: "1970-01-01T00:00:00.000Z",
      },
      quantity: 2_000,
    });
  });

  test("preserves checkpoint request time across intermediate usage commits", async () => {
    const setupTransactions: TransactionOperation[][] = [];
    let requestedAt: number | undefined;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_checkpoint_request_time",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      region: "us-east-2",
      reservedMemoryMiB: 2_048,
      reservedVcpu: 1,
      runId: RUN_ID,
      status: "ready",
    };
    const checkpointRef = {
      checkpointRef: "lambda-microvm://microvm_checkpoint_request_time/suspended",
      createdAt: 2_000,
      provider: "aws_lambda_microvm" as const,
    };
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => checkpointRef,
      create: async () => lease,
      destroy: async () => undefined,
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
      reconcileCheckpoint: async (input) => {
        requestedAt = input.requestedAt;
        return {
          checkpoint: checkpointRef,
          lease: { ...input.lease, status: "suspended" },
        };
      },
      resume: async (input) => ({ ...input.lease, status: "ready" }),
      upload: async () => undefined,
    };
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
    await Effect.runPromise(setupManager.checkpoint(sandbox));
    const checkpointingTransaction = setupTransactions.find((transaction) =>
      records(transaction).some(
        (record) =>
          record.itemType === "semantic-event" && record.data.eventType === "sandbox.checkpointing",
      ),
    );
    const checkpointing = leaseRecord(checkpointingTransaction ?? []);
    const chunkedCheckpointing: SandboxLeaseRecordValue = {
      ...checkpointing,
      data: {
        ...checkpointing.data,
        checkpointRequestedAt: checkpointing.data.updatedAt,
        updatedAt: "1970-01-01T00:00:03.000Z",
        usageAccountedThrough: "1970-01-01T00:00:01.500Z",
        version: checkpointing.data.version + 1,
      },
    };
    const recoveryTransactions: TransactionOperation[][] = [];
    const recoveryManager = makeSandboxManager(
      provider,
      databaseSeededWith(chunkedCheckpointing, recoveryTransactions),
      makeIdGenerator(),
      { now: () => 10_000 },
    );

    const recovered = await Effect.runPromise(
      recoveryManager.reconcileCheckpoint(chunkedCheckpointing),
    );

    expect(requestedAt).toBe(Date.parse(checkpointing.data.updatedAt));
    expect(recovered.record.data).toMatchObject({ status: "suspended" });
    expect(recovered.record.data.checkpointRequestedAt).toBeUndefined();

    const readyRecoveryTransactions: TransactionOperation[][] = [];
    const readyRecoveryManager = makeSandboxManager(
      provider,
      databaseSeededWith(chunkedCheckpointing, readyRecoveryTransactions),
      makeIdGenerator(),
      { now: () => 10_000 },
    );
    const restored = await Effect.runPromise(
      readyRecoveryManager.reconcileCheckpointWithResult(chunkedCheckpointing, {
        lease: {
          ...managedSandboxFromRecord(chunkedCheckpointing).lease,
          region: "us-west-2",
          reservedMemoryMiB: 4_096,
          reservedVcpu: 2,
          status: "ready",
        },
      }),
    );
    expect(restored.record.data).toMatchObject({
      computeUsageActive: true,
      region: "us-west-2",
      reservedMemoryMiB: 4_096,
      reservedVcpu: 2,
      status: "ready",
    });
    expect(restored.record.data.checkpointRequestedAt).toBeUndefined();
    expect(restored.record.data.usagePendingThrough).toBeUndefined();
    const readyUsage = records(readyRecoveryTransactions.at(-1) ?? []).filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
        record.itemType === "meter-event",
    );
    expect(
      readyUsage.find((record) => record.data.metric === "sandbox_vcpu_ms")?.data.quantity,
    ).toBe(8_500);
    expect(
      readyUsage.find((record) => record.data.metric === "sandbox_memory_mib_ms")?.data.quantity,
    ).toBe(8_500 * 2_048);
    expect(readyUsage.every((record) => record.data.dimensions.region === "us-east-2")).toBe(true);
  });

  test("rejects manual lifecycle reconciliation after the provider route changes", async () => {
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "sandbox_stale_manual_route",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      providerRouteKey: "old-route",
      runId: RUN_ID,
      status: "ready",
      workspaceId: IDS[8] as Ulid,
    };
    const setupProvider: SandboxProvider = {
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
    const setupTransactions: TransactionOperation[][] = [];
    const setupManager = makeSandboxManager(
      setupProvider,
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
        workspaceId: IDS[8] as Ulid,
      }),
    );
    expect(managedSandboxFromRecord(sandbox.record).lease.providerRouteKey).toBe("old-route");
    const staleProvider: SandboxProvider = {
      ...setupProvider,
      validateLeaseRoute() {
        throw new Error("provider route changed");
      },
    };
    const checkpointing: SandboxLeaseRecordValue = {
      ...sandbox.record,
      data: {
        ...sandbox.record.data,
        checkpointRequestedAt: sandbox.record.data.updatedAt,
        status: "checkpointing",
        version: sandbox.record.data.version + 1,
      },
    };
    const resuming: SandboxLeaseRecordValue = {
      ...sandbox.record,
      data: {
        ...sandbox.record.data,
        resumeRequestedAt: sandbox.record.data.updatedAt,
        status: "resuming",
        version: sandbox.record.data.version + 1,
      },
    };

    const checkpointManager = makeSandboxManager(
      staleProvider,
      databaseSeededWith(checkpointing, []),
      makeIdGenerator(),
      { now: () => 2_000 },
    );
    expect(
      Effect.runPromise(
        checkpointManager.reconcileCheckpointWithResult(checkpointing, {
          lease: {
            ...managedSandboxFromRecord(checkpointing).lease,
            status: "ready",
          },
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: "Invalid reconciled checkpoint state.",
    });

    const resumeManager = makeSandboxManager(
      staleProvider,
      databaseSeededWith(resuming, []),
      makeIdGenerator(),
      { now: () => 2_000 },
    );
    expect(
      Effect.runPromise(
        resumeManager.reconcileResumeWithLease(resuming, {
          ...managedSandboxFromRecord(resuming).lease,
          status: "ready",
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: "Invalid reconciled sandbox lease.",
    });
  });

  test("records failed provisioning usage and a terminal failure event", async () => {
    const transactions: TransactionOperation[][] = [];
    const generated = [...IDS];
    const times = [0, 250];
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async () => {
        throw new Error("capacity exhausted");
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
    const manager = makeSandboxManager(
      provider,
      database(transactions),
      makeIdGenerator(() => generated.shift() as Ulid),
      { now: () => times.shift() ?? 250 },
    );

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

    expect(transactions).toHaveLength(2);
    const failed = records(transactions[1] ?? []);
    expect(failed.find((record) => record.itemType === "sandbox-lease")?.data.status).toBe("error");
    expect(failed.find((record) => record.itemType === "semantic-event")?.data.eventType).toBe(
      "sandbox.failed",
    );
    expect(failed.filter((record) => record.itemType === "meter-event")).toHaveLength(3);
  });

  test("meters provider-declared Lambda capacity when allocation fails early", async () => {
    const transactions: TransactionOperation[][] = [];
    const times = [0, 250];
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async () => {
        throw new Error("capacity exhausted");
      },
      destroy: async () => undefined,
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
      provisioningReservation: () => ({
        reservedMemoryMiB: 4_096,
        reservedVcpu: 2,
      }),
      resume: async () => {
        throw new Error("not reached");
      },
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(provider, database(transactions), makeIdGenerator(), {
      now: () => times.shift() ?? 250,
    });

    expect(
      Effect.runPromise(
        manager.create({
          executionTargetId: AGENT_DEPLOYMENT_ID,
          executionTargetKind: "agent-deployment",
          environmentId: ENVIRONMENT_ID,
          isolationMode: "run-ephemeral",
          minMemoryMiB: 1_024,
          minVcpu: 1,
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

    const terminal = transactions.at(-1) ?? [];
    expect(leaseRecord(terminal).data).toMatchObject({
      reservedMemoryMiB: 4_096,
      reservedVcpu: 2,
      status: "error",
    });
    expect(
      records(terminal)
        .filter(
          (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
            record.itemType === "meter-event",
        )
        .map((record) => [record.data.metric, record.data.quantity]),
    ).toEqual([
      ["sandbox_ms", 250],
      ["sandbox_vcpu_ms", 500],
      ["sandbox_memory_mib_ms", 1_024_000],
    ]);
  });
});
