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
  SandboxAllocationLeaseError,
  SandboxAllocationUnknownError,
  SandboxDestroyUnknownError,
  type SandboxLease,
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

describe("managed sandbox allocation cleanup", () => {
  test("keeps usage active when invalid-allocation cleanup is ambiguous", async () => {
    const transactions: TransactionOperation[][] = [];
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "sandbox_unready_cleanup_unknown",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      runId: RUN_ID,
      status: "error",
      workspaceId: IDS[8] as Ulid,
    };
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async () => {
        throw new SandboxAllocationLeaseError({
          allocationError: new Error("invalid allocation response"),
          lease,
        });
      },
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
      resume: async () => lease,
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
          workspaceId: IDS[8] as Ulid,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "create-compensation",
    });

    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      computeUsageActive: true,
      failureReason: "provider-create-cleanup-failed-cleanup-failed",
      status: "error",
    });
  });

  test("retries an available provider identity claim before cleanup", async () => {
    const transactions: TransactionOperation[][] = [];
    let claimAttempts = 0;
    let destroyCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_claim_retry",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      runId: RUN_ID,
      status: "error",
      workspaceId: IDS[8] as Ulid,
    };
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async () =>
        await Promise.reject(
          new SandboxAllocationLeaseError({
            allocationError: new Error("readiness failed"),
            lease,
          }),
        ),
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
    const base = database(transactions);
    const db: DynamoDatabaseService = {
      ...base,
      transactWrite: async (operations) => {
        transactions.push([...operations]);
        const event = records(operations).find((record) => record.itemType === "semantic-event");
        if (
          event?.itemType === "semantic-event" &&
          event.data.eventType === "sandbox.releasing" &&
          (claimAttempts += 1) < 3
        ) {
          throw new DatabaseError({
            cause: new Error("transient claim failure"),
            message: "sandbox cleanup claim failed",
            operation: "transact-write",
            table: "control",
          });
        }
      },
    };
    const manager = makeSandboxManager(provider, db, makeIdGenerator());

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
          workspaceId: IDS[8] as Ulid,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "create",
    });

    expect(claimAttempts).toBe(3);
    expect(destroyCalls).toBe(1);
    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      externalSandboxId: "microvm_claim_retry",
      status: "destroyed",
    });
  });

  test("persists an unclaimed provider identity for later cleanup reconciliation", async () => {
    const transactions: TransactionOperation[][] = [];
    let destroyCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_claim_unavailable",
      isolationMode: "run-ephemeral",
      leaseExpiresAt: 2_000_000_000_000,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      providerRouteKey: "lambda-route-claim-unavailable",
      region: "us-east-2",
      reservedMemoryMiB: 4_096,
      reservedVcpu: 2,
      runId: RUN_ID,
      status: "error",
    };
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async () =>
        await Promise.reject(
          new SandboxAllocationLeaseError({
            allocationError: new Error("readiness failed"),
            lease,
          }),
        ),
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
    const base = database(transactions);
    const db: DynamoDatabaseService = {
      ...base,
      getRecord: async () => undefined,
      transactWrite: async (operations) => {
        transactions.push([...operations]);
        const event = records(operations).find((record) => record.itemType === "semantic-event");
        if (event?.itemType === "semantic-event" && event.data.eventType === "sandbox.releasing") {
          throw new DatabaseError({
            cause: new Error("claim service unavailable"),
            message: "sandbox cleanup claim failed",
            operation: "transact-write",
            table: "control",
          });
        }
      },
    };
    const manager = makeSandboxManager(provider, db, makeIdGenerator());

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
      operation: "create-compensation-ownership",
    });

    expect(destroyCalls).toBe(0);
    const recoverable = leaseRecord(transactions.at(-1) ?? []);
    expect(recoverable.data).toMatchObject({
      computeUsageActive: true,
      failureReason: "provider-create-cleanup-failed-cleanup-claim-unavailable",
      leaseExpiresAt: "2033-05-18T03:33:20.000Z",
      providerRouteKey: "lambda-route-claim-unavailable",
      recoveryExternalSandboxId: "microvm_claim_unavailable",
      region: "us-east-2",
      reservedMemoryMiB: 4_096,
      reservedVcpu: 2,
      status: "creating",
    });
    expect(
      records(transactions.at(-1) ?? []).some((record) => record.itemType === "meter-event"),
    ).toBe(false);

    const recoveryTransactions: TransactionOperation[][] = [];
    const recoveryManager = makeSandboxManager(
      provider,
      databaseSeededWith(recoverable, recoveryTransactions),
      makeIdGenerator(),
    );
    expect(
      Effect.runPromise(
        recoveryManager.reconcileCreateWithLease(recoverable, {
          ...lease,
          externalSandboxId: "sandbox_different_allocation",
          status: "ready",
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: "Discovered sandbox identity does not match the persisted recovery identity.",
    });
    expect(recoveryTransactions).toHaveLength(0);
    const destroyed = await Effect.runPromise(
      recoveryManager.reconcileCreateWithCleanup(recoverable, lease),
    );
    expect(destroyed.data.status).toBe("destroyed");
    expect(destroyCalls).toBe(1);
    expect(
      recoveryTransactions
        .flatMap(records)
        .some(
          (record) =>
            record.itemType === "semantic-event" &&
            record.data.eventType === "sandbox.destroy-completed",
        ),
    ).toBe(true);
  });

  test("keeps usage active when recovered create cleanup is ambiguous", async () => {
    const setupTransactions: TransactionOperation[][] = [];
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_recovery_cleanup_unknown",
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
      create: async (input) => {
        throw new SandboxAllocationUnknownError({
          allocationError: new Error("create response timeout"),
          allocationToken: String(input.allocationId),
        });
      },
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
      resume: async () => lease,
      upload: async () => undefined,
    };
    const input = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment" as const,
      environmentId: ENVIRONMENT_ID,
      isolationMode: "run-ephemeral" as const,
      observability: OBSERVABILITY,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
    };
    const setupManager = makeSandboxManager(
      provider,
      database(setupTransactions),
      makeIdGenerator(),
    );
    expect(Effect.runPromise(setupManager.create(input))).rejects.toBeDefined();
    const creating = leaseRecord(setupTransactions.at(-1) ?? []);
    const recoveryTransactions: TransactionOperation[][] = [];
    const recoveryManager = makeSandboxManager(
      provider,
      databaseSeededWith(creating, recoveryTransactions),
      makeIdGenerator(),
    );

    expect(
      Effect.runPromise(recoveryManager.reconcileCreateWithCleanup(creating, lease)),
    ).rejects.toMatchObject({ _tag: "SandboxOperationError" });

    expect(leaseRecord(recoveryTransactions.at(-1) ?? []).data).toMatchObject({
      computeUsageActive: true,
      failureReason: "provider-destroy-failed",
      status: "error",
    });
  });

  test("persists a provider-cleaned allocation without destroying it twice", async () => {
    const transactions: TransactionOperation[][] = [];
    let destroyCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_cleaned",
      imageRef: "lambda-image@7",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      region: "us-east-2",
      reservedMemoryMiB: 4_096,
      reservedVcpu: 2,
      runId: RUN_ID,
      status: "error",
    };
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async () => {
        throw new SandboxAllocationLeaseError({
          allocationError: new Error("readiness failed"),
          cleanupCompletedAt: 2_000,
          lease,
        });
      },
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
    const manager = makeSandboxManager(provider, database(transactions), makeIdGenerator(), {
      now: () => 0,
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
      _tag: "SandboxOperationError",
      operation: "create",
    });

    expect(destroyCalls).toBe(0);
    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      destroyedAt: "1970-01-01T00:00:02.000Z",
      externalSandboxId: "microvm_cleaned",
      failureReason: "provider-create-cleaned",
      imageRef: "lambda-image@7",
      reservedMemoryMiB: 4_096,
      reservedVcpu: 2,
      status: "destroyed",
    });
    const usage = records(transactions.at(-1) ?? []).filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
        record.itemType === "meter-event",
    );
    expect(usage.map((record) => [record.data.metric, record.data.quantity])).toEqual([
      ["sandbox_ms", 2_000],
      ["sandbox_vcpu_ms", 4_000],
      ["sandbox_memory_mib_ms", 8_192_000],
    ]);
    expect(
      usage.map((record) => ({
        externalSandboxId: record.data.dimensions.externalSandboxId,
        region: record.data.dimensions.region,
      })),
    ).toEqual([
      { externalSandboxId: "microvm_cleaned", region: "us-east-2" },
      { externalSandboxId: "microvm_cleaned", region: "us-east-2" },
      { externalSandboxId: "microvm_cleaned", region: "us-east-2" },
    ]);
  });
});
