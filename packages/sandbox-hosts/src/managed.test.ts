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
  SandboxCheckpointUnknownError,
  SandboxResumeUnknownError,
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

describe("managed sandbox lifecycle", () => {
  test("persists lifecycle events and terminal usage atomically", async () => {
    const transactions: TransactionOperation[][] = [];
    const generated = [...IDS];
    const times = [0, 1_000, 2_000, 4_000];
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_1",
      imageRef: "lambda-image@7",
      isolationMode: "run-ephemeral",
      leaseExpiresAt: 3_000,
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
      database(transactions),
      makeIdGenerator(() => generated.shift() as Ulid),
      { now: () => times.shift() ?? 4_000 },
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
    expect(transactions).toHaveLength(6);
    const eventTypes = transactions.flatMap((transaction) =>
      records(transaction)
        .filter((record) => record.itemType === "semantic-event")
        .map((record) => record.data.eventType),
    );
    expect(eventTypes).toEqual([
      "sandbox.provisioning-started",
      "sandbox.allocated",
      "sandbox.ready",
      "sandbox.releasing",
      "sandbox.destroy-completed",
      "sandbox.destroyed",
    ]);
    expect(
      records(transactions[4] ?? []).find((record) => record.itemType === "semantic-event")?.data
        .payload,
    ).toMatchObject({ destroyCompletedAt: "1970-01-01T00:00:04.000Z" });
    expect(
      records(transactions[1] ?? []).find((record) => record.itemType === "unique-claim")?.data,
    ).toMatchObject({
      namespace: "sandbox-provider:aws_lambda_microvm:route:legacy",
      ownerId: sandbox.record.data.id,
      ownerItemType: "sandbox-lease",
      value: "microvm_1",
    });

    const terminalRecords = records(transactions[5] ?? []);
    const usage = terminalRecords.filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
        record.itemType === "meter-event",
    );
    expect(usage.map((record) => [record.data.metric, record.data.quantity])).toEqual([
      ["sandbox_ms", 3_000],
      ["sandbox_vcpu_ms", 3_000],
      ["sandbox_memory_mib_ms", 6_144_000],
    ]);
    expect(usage[0]?.data).toMatchObject({
      dimensions: {
        segmentEndedAt: "1970-01-01T00:00:03.000Z",
        segmentStartedAt: "1970-01-01T00:00:00.000Z",
      },
      occurredAt: "1970-01-01T00:00:04.000Z",
    });
    expect(terminalRecords.some((record) => record.itemType === "sandbox-lease")).toBe(true);
    expect(terminalRecords.some((record) => record.itemType === "semantic-event")).toBe(true);
  });

  test("excludes suspended intervals from compute usage", async () => {
    const transactions: TransactionOperation[][] = [];
    const times = [0, 100, 200, 1_000, 2_000, 5_000, 6_000, 7_000, 8_000, 9_000];
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_usage_pause",
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
        checkpointRef: "lambda-microvm://microvm_usage_pause/suspended",
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
      resume: async (input) => ({ ...input.lease, status: "ready" }),
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(provider, database(transactions), makeIdGenerator(), {
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
    const suspended = await Effect.runPromise(manager.checkpoint(sandbox));
    const resumed = await Effect.runPromise(manager.resume(suspended));
    expect(resumed.record.data.resumeRequestedAt).toBeUndefined();
    await Effect.runPromise(manager.destroy(resumed));

    const usage = transactions
      .flatMap(records)
      .filter(
        (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
          record.itemType === "meter-event" && record.data.metric === "sandbox_ms",
      );
    expect(usage.map((record) => record.data.quantity)).toEqual([2_000, 2_000]);
    expect(usage.map((record) => record.data.dimensions)).toEqual([
      expect.objectContaining({
        segmentEndedAt: "1970-01-01T00:00:02.000Z",
        segmentStartedAt: "1970-01-01T00:00:00.000Z",
      }),
      expect.objectContaining({
        segmentEndedAt: "1970-01-01T00:00:09.000Z",
        segmentStartedAt: "1970-01-01T00:00:07.000Z",
      }),
    ]);
  });

  test("uses a valid provider checkpoint timestamp as the usage cutoff", async () => {
    const transactions: TransactionOperation[][] = [];
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "sandbox_checkpoint_timestamp",
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
        checkpointRef: "checkpoint-at-provider-time",
        createdAt: 2_000,
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
      resume: async (input) => ({ ...input.lease, status: "ready" }),
      upload: async () => undefined,
    };
    const times = [0, 100, 200, 1_000, 5_000];
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
        workspaceId: IDS[8] as Ulid,
      }),
    );

    await Effect.runPromise(manager.checkpoint(sandbox));

    const usage = records(transactions.at(-1) ?? []).find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
        record.itemType === "meter-event" && record.data.metric === "sandbox_ms",
    );
    expect(usage?.data).toMatchObject({
      dimensions: { segmentEndedAt: "1970-01-01T00:00:02.000Z" },
      quantity: 2_000,
    });
  });

  test("keeps an ambiguous checkpoint reconcilable without losing usage", async () => {
    const transactions: TransactionOperation[][] = [];
    const times = [0, 100, 200, 1_000, 2_000, 3_000, 4_000];
    let resumeCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "sandbox_checkpoint_unknown",
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
      checkpoint: async () => {
        throw new SandboxCheckpointUnknownError(new Error("response timeout"));
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
      reconcileCheckpoint: async (input) => ({
        lease: { ...input.lease, status: "ready" },
      }),
      resume: async (input) => {
        resumeCalls += 1;
        return { ...input.lease, status: "ready" };
      },
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(
      provider,
      statefulDatabase(transactions),
      makeIdGenerator(),
      {
        now: () => times.shift() ?? 4_000,
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
        workspaceId: IDS[8] as Ulid,
      }),
    );

    expect(Effect.runPromise(manager.checkpoint(sandbox))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "checkpoint",
    });
    const checkpointing = leaseRecord(transactions.at(-1) ?? []);
    expect(checkpointing.data).toMatchObject({
      computeUsageActive: true,
      failureReason: "provider-checkpoint-outcome-unknown",
      status: "checkpointing",
    });

    const reconciled = await Effect.runPromise(manager.reconcileCheckpoint(checkpointing));
    expect(reconciled.record.data.status).toBe("ready");
    expect(resumeCalls).toBe(0);
  });

  test("reconciles a durable resuming lease without replaying resume", async () => {
    const setupTransactions: TransactionOperation[][] = [];
    let requestedAt: number | undefined;
    let resumeCalls = 0;
    let reconciliationCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_resuming_recovery",
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
        checkpointRef: "lambda-microvm://microvm_resuming_recovery/suspended",
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
      reconcileResume: async (input) => {
        reconciliationCalls += 1;
        requestedAt = input.requestedAt;
        return { ...input.lease, status: "ready" };
      },
      resume: async () => {
        resumeCalls += 1;
        throw new SandboxResumeUnknownError(new Error("worker lost response"));
      },
      upload: async () => undefined,
    };
    const setupManager = makeSandboxManager(
      provider,
      database(setupTransactions),
      makeIdGenerator(),
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
    const suspended = await Effect.runPromise(setupManager.checkpoint(sandbox));
    expect(Effect.runPromise(setupManager.resume(suspended))).rejects.toBeDefined();
    const resuming = leaseRecord(setupTransactions.at(-1) ?? []);
    expect(resuming.data).toMatchObject({
      computeUsageActive: true,
      failureReason: "provider-resume-outcome-unknown",
      status: "resuming",
    });
    expect(resuming.data.resumeRequestedAt).toBeDefined();
    const chunkedResuming: SandboxLeaseRecordValue = {
      ...resuming,
      data: {
        ...resuming.data,
        updatedAt: new Date(Date.parse(resuming.data.updatedAt) + 60_000).toISOString(),
        version: resuming.data.version + 1,
      },
    };

    const recoveryTransactions: TransactionOperation[][] = [];
    const recoveryManager = makeSandboxManager(
      provider,
      databaseSeededWith(chunkedResuming, recoveryTransactions),
      makeIdGenerator(),
    );
    const recovered = await Effect.runPromise(recoveryManager.reconcileResume(chunkedResuming));

    expect(recovered.record.data.status).toBe("ready");
    expect(requestedAt).toBe(Date.parse(resuming.data.resumeRequestedAt ?? ""));
    expect(resumeCalls).toBe(1);
    expect(reconciliationCalls).toBe(1);
  });
});
