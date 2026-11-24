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

describe("managed sandbox resume reconciliation", () => {
  test("does not compensate an ambiguously committed resume", async () => {
    const transactions: TransactionOperation[][] = [];
    let checkpointCalls = 0;
    let reconciliationReads = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_resume_unknown",
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
          checkpointRef: "lambda-microvm://microvm_resume_unknown/suspended",
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
      resume: async (input) => ({ ...input.lease, status: "ready" }),
      upload: async () => undefined,
    };
    const ambiguous = new DatabaseError({
      cause: new Error("response timeout"),
      message: "resume transaction outcome unknown",
      operation: "transact-write",
      table: "execution",
    });
    const readFailure = new DatabaseError({
      cause: new Error("read timeout"),
      message: "resume reconciliation failed",
      operation: "get",
      table: "execution",
    });
    const db: DynamoDatabaseService = {
      ...database(transactions),
      getRecord: async () => {
        reconciliationReads += 1;
        throw readFailure;
      },
      transactWrite: async (operations) => {
        transactions.push([...operations]);
        const event = records(operations).find((record) => record.itemType === "semantic-event");
        if (event?.itemType === "semantic-event" && event.data.eventType === "sandbox.resumed") {
          throw ambiguous;
        }
      },
    };
    const manager = makeSandboxManager(provider, db, makeIdGenerator());
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
      _tag: "SandboxPersistenceUnknownError",
    });

    expect(reconciliationReads).toBe(3);
    expect(checkpointCalls).toBe(1);
  });

  test("keeps compute accounting active through manual ambiguous resume reconciliation", async () => {
    const transactions: TransactionOperation[][] = [];
    let clock = 0;
    let resumeCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "sandbox_resume_usage",
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
        checkpointRef: "microvm://sandbox_resume_usage/suspended",
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
      resume: async () => {
        resumeCalls += 1;
        throw new SandboxResumeUnknownError(new Error("readiness timed out"));
      },
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(
      provider,
      statefulDatabase(transactions),
      makeIdGenerator(),
      { now: () => (clock += 1_000) },
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
    const suspended = await Effect.runPromise(manager.checkpoint(sandbox));
    expect(Effect.runPromise(manager.resume(suspended))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "resume",
    });
    const ambiguousTransaction = transactions.at(-1) ?? [];
    const ambiguous = leaseRecord(ambiguousTransaction);
    expect(ambiguous.data).toMatchObject({
      computeUsageActive: true,
      failureReason: "provider-resume-outcome-unknown",
      status: "resuming",
    });
    const ambiguousUsage = records(ambiguousTransaction).find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
        record.itemType === "meter-event" && record.data.metric === "sandbox_ms",
    );
    expect(ambiguousUsage?.data.quantity).toBeGreaterThan(0);
    expect(
      Effect.runPromise(manager.resume(managedSandboxFromRecord(ambiguous))),
    ).rejects.toMatchObject({ _tag: "SandboxRecordError" });
    expect(resumeCalls).toBe(1);

    const suspendedRecoveryTransactions: TransactionOperation[][] = [];
    const suspendedRecoveryManager = makeSandboxManager(
      provider,
      databaseSeededWith(ambiguous, suspendedRecoveryTransactions),
      makeIdGenerator(),
      { now: () => 100_000 },
    );
    const stillSuspended = await Effect.runPromise(
      suspendedRecoveryManager.reconcileResumeWithLease(ambiguous, {
        ...managedSandboxFromRecord(ambiguous).lease,
        status: "suspended",
      }),
    );
    expect(stillSuspended.record.data.status).toBe("suspended");
    const suspendedUsage = records(suspendedRecoveryTransactions.at(-1) ?? []).find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
        record.itemType === "meter-event" && record.data.metric === "sandbox_ms",
    );
    expect(suspendedUsage?.data.quantity).toBe(0);
    expect(suspendedUsage?.data.dimensions.segmentEndedAt).toBe(
      ambiguous.data.usageAccountedThrough,
    );

    const reconciled = await Effect.runPromise(
      manager.reconcileResumeWithLease(ambiguous, {
        ...managedSandboxFromRecord(ambiguous).lease,
        status: "ready",
      }),
    );
    expect(reconciled.record.data.status).toBe("ready");
    expect(reconciled.record.data.resumeRequestedAt).toBeUndefined();
    const resumedTransaction = transactions.at(-1) ?? [];
    const resumedUsage = records(resumedTransaction ?? []).find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
        record.itemType === "meter-event" && record.data.metric === "sandbox_ms",
    );
    expect(resumedUsage?.data.dimensions.segmentStartedAt).toBe(
      ambiguous.data.usageAccountedThrough,
    );
    expect(resumedUsage?.data.quantity).toBeGreaterThan(0);
  });

  test("preserves the prior active cursor during resume compensation", async () => {
    const transactions: TransactionOperation[][] = [];
    const times = [0, 100, 200, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000];
    let resumeCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_resume_compensation_usage",
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
        checkpointRef: "lambda-microvm://microvm_resume_compensation_usage/suspended",
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
      resume: async (input) => {
        resumeCalls += 1;
        return { ...input.lease, status: "ready" };
      },
      upload: async () => undefined,
    };
    const resumeFailure = new DatabaseError({
      cause: new Error("resume commit failed"),
      message: "resume transaction failed",
      operation: "transact-write",
      table: "execution",
    });
    let stored: PlatformRecord | undefined;
    const db: DynamoDatabaseService = {
      deleteRecord: async () => {},
      getRecord: async () => stored,
      putRecord: async () => {},
      queryRecords: async () => ({ items: [] }),
      transactWrite: async (operations) => {
        transactions.push([...operations]);
        const event = records(operations).find((record) => record.itemType === "semantic-event");
        if (event?.itemType === "semantic-event" && event.data.eventType === "sandbox.resumed") {
          throw resumeFailure;
        }
        const next = records(operations).find((record) => record.itemType === "sandbox-lease");
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
    const suspended = await Effect.runPromise(manager.checkpoint(sandbox));
    const activeRecord: SandboxLeaseRecordValue = {
      ...suspended.record,
      data: {
        ...suspended.record.data,
        computeUsageActive: true,
        failureReason: "provider-resume-failed",
        status: "error",
        version: suspended.record.data.version + 1,
      },
    };
    stored = activeRecord;
    const active = managedSandboxFromRecord(activeRecord);

    expect(Effect.runPromise(manager.resume(active))).rejects.toMatchObject({
      _tag: "DatabaseError",
    });
    expect(resumeCalls).toBe(1);

    const compensated = transactions.find(
      (transaction) => leaseRecord(transaction).data.failureReason === "resume-persistence-failed",
    );
    const usage = records(compensated ?? []).find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
        record.itemType === "meter-event" && record.data.metric === "sandbox_ms",
    );
    expect(usage?.data.quantity).toBeGreaterThan(0);
    expect(usage?.data.dimensions.segmentStartedAt).toBe(active.record.data.usageAccountedThrough);
  });

  test("rejects resume identity changes and clears the failure after a valid retry", async () => {
    const transactions: TransactionOperation[][] = [];
    let destroyCalls = 0;
    let resumeCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "sandbox_resume",
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
      resume: async () => {
        resumeCalls += 1;
        return resumeCalls <= 2
          ? { ...lease, externalSandboxId: "sandbox_other" }
          : {
              ...lease,
              leaseExpiresAt: 10_000,
              region: "us-east-2",
              reservedMemoryMiB: 4_096,
              reservedVcpu: 2,
              status: "ready",
            };
      },
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(provider, database(transactions), makeIdGenerator(), {
      now: (() => {
        let value = 0;
        return () => (value += 100);
      })(),
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
      _tag: "SandboxRecordError",
    });
    const firstError = managedSandboxFromRecord(leaseRecord(transactions.at(-1) ?? []));
    expect(Effect.runPromise(manager.resume(firstError))).rejects.toMatchObject({
      _tag: "SandboxRecordError",
    });
    const secondError = managedSandboxFromRecord(leaseRecord(transactions.at(-1) ?? []));
    const resumed = await Effect.runPromise(manager.resume(secondError));

    const mismatchTransactions = transactions.filter(
      (transaction) =>
        leaseRecord(transaction).data.failureReason === "provider-resume-identity-mismatch",
    );
    const secondMismatchUsage = records(mismatchTransactions[1] ?? []).find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
        record.itemType === "meter-event" && record.data.metric === "sandbox_ms",
    );
    expect(secondMismatchUsage?.data.dimensions.segmentStartedAt).toBe(
      leaseRecord(mismatchTransactions[0] ?? []).data.usageAccountedThrough,
    );
    expect(secondMismatchUsage?.data.quantity).toBeGreaterThan(0);

    expect(resumed.lease.externalSandboxId).toBe("sandbox_resume");
    expect(resumed.lease).toMatchObject({
      checkpointRef: "checkpoint",
      leaseExpiresAt: 10_000,
      region: "us-east-2",
      reservedMemoryMiB: 4_096,
      reservedVcpu: 2,
      status: "ready",
    });
    expect(resumed.record.data).toMatchObject({
      checkpointRef: "checkpoint",
      leaseExpiresAt: "1970-01-01T00:00:10.000Z",
      region: "us-east-2",
      reservedMemoryMiB: 4_096,
      reservedVcpu: 2,
      status: "ready",
    });
    expect(resumed.record.data.failureReason).toBeUndefined();
    const resumedEvent = records(transactions.at(-1) ?? []).find(
      (record) => record.itemType === "semantic-event",
    );
    expect(resumedEvent?.data.payload).not.toHaveProperty("failureReason");
    expect(Effect.runPromise(manager.destroy(resumed))).resolves.toMatchObject({
      data: { status: "destroyed" },
    });
    expect(destroyCalls).toBe(1);
  });

  test("rejects expired provider leases before publishing ready state", async () => {
    const transactions: TransactionOperation[][] = [];
    let destroyCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_expired_create",
      isolationMode: "run-ephemeral",
      leaseExpiresAt: 500,
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
    const times = [0, 1_000, 2_000, 3_000];
    const manager = makeSandboxManager(provider, database(transactions), makeIdGenerator(), {
      now: () => times.shift() ?? 3_000,
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
      _tag: "SandboxRecordError",
      message: "Sandbox provider returned an expired ready lease.",
    });

    expect(destroyCalls).toBe(1);
    expect(
      transactions
        .flatMap(records)
        .some(
          (record) =>
            record.itemType === "semantic-event" &&
            ["sandbox.allocated", "sandbox.ready"].includes(record.data.eventType),
        ),
    ).toBe(false);
    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      externalSandboxId: "microvm_expired_create",
      failureReason: "provider-lease-not-ready",
      status: "destroyed",
    });
  });
});
