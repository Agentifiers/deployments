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
  MAX_SANDBOX_RESERVED_MEMORY_MIB,
  MAX_SANDBOX_RESERVED_VCPU,
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
  sessionId: IDS[0] as Ulid,
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

describe("managed sandbox usage segmentation", () => {
  test("continues usage after an ambiguous destroy outcome", async () => {
    const transactions: TransactionOperation[][] = [];
    const times = [0, 100, 200, 1_000, 2_000, 3_000, 5_000];
    let destroyCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_ambiguous_destroy",
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
        if (destroyCalls === 1) {
          throw new SandboxDestroyUnknownError(new Error("response timeout"));
        }
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
      now: () => times.shift() ?? 5_000,
    });
    const sandbox = await Effect.runPromise(
      manager.create({
        executionTargetId: AGENT_DEPLOYMENT_ID,
        executionTargetKind: "agent-deployment",
        environmentId: ENVIRONMENT_ID,
        isolationMode: "run-ephemeral",
        organizationId: ORGANIZATION_ID,
        observability: OBSERVABILITY,
        projectId: PROJECT_ID,
        runId: RUN_ID,
      }),
    );

    expect(Effect.runPromise(manager.destroy(sandbox))).rejects.toBeDefined();
    const errored = managedSandboxFromRecord(leaseRecord(transactions.at(-1) ?? []));
    expect(errored.record.data).toMatchObject({
      computeUsageActive: true,
      failureReason: "provider-destroy-outcome-unknown",
    });
    await Effect.runPromise(manager.destroy(errored));

    const usage = transactions
      .flatMap(records)
      .filter(
        (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
          record.itemType === "meter-event" && record.data.metric === "sandbox_ms",
      );
    expect(usage.map((record) => record.data.quantity)).toEqual([2_000, 3_000]);
    expect(usage.map((record) => record.data.observability)).toEqual([
      OBSERVABILITY,
      OBSERVABILITY,
    ]);
    expect(destroyCalls).toBe(2);
  });

  test("caps segmented usage at an expiration learned during reconciliation, in the lease's workspace", async () => {
    const dayMs = 24 * 60 * 60 * 1_000;
    const observedAt = 180 * dayMs;
    const expiresAt = 30 * dayMs;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "sandbox_reconciled_expiration",
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
      provider,
      database(setupTransactions),
      makeIdGenerator(),
      { now: () => 0 },
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
    const checkpointing: SandboxLeaseRecordValue = {
      ...sandbox.record,
      data: {
        ...sandbox.record.data,
        checkpointRequestedAt: sandbox.record.data.updatedAt,
        status: "checkpointing",
        version: sandbox.record.data.version + 1,
      },
    };
    const transactions: TransactionOperation[][] = [];
    const manager = makeSandboxManager(
      provider,
      databaseSeededWith(checkpointing, transactions),
      makeIdGenerator(),
      { now: () => observedAt },
    );

    await Effect.runPromise(
      manager.reconcileCheckpointWithResult(checkpointing, {
        checkpoint: {
          checkpointRef: "checkpoint-expired",
          createdAt: observedAt,
          provider: "aws_lambda_microvm",
        },
        lease: {
          ...managedSandboxFromRecord(checkpointing).lease,
          leaseExpiresAt: expiresAt,
          status: "suspended",
        },
      }),
    );

    const usage = transactions
      .flatMap(records)
      .filter(
        (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
          record.itemType === "meter-event" && record.data.metric === "sandbox_ms",
      );
    expect(usage.reduce((total, record) => total + record.data.quantity, 0)).toBe(expiresAt);
    expect(usage.map((record) => record.data.workspaceId)).toEqual(usage.map(() => IDS[8] as Ulid));
  });

  test("segments long-lived maximal reservations before usage quantities overflow", async () => {
    const transactions: TransactionOperation[][] = [];
    const dayMs = 24 * 60 * 60 * 1_000;
    const durationMs = 180 * dayMs;
    const destroyedAt = 200 * dayMs;
    let clock = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "sandbox_long_lived",
      isolationMode: "run-ephemeral",
      leaseExpiresAt: durationMs,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      reservedMemoryMiB: MAX_SANDBOX_RESERVED_MEMORY_MIB,
      reservedVcpu: MAX_SANDBOX_RESERVED_VCPU,
      runId: RUN_ID,
      status: "ready",
      workspaceId: IDS[8] as Ulid,
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
    const manager = makeSandboxManager(provider, database(transactions), makeIdGenerator(), {
      costPolicy: { vcpuHourUsdMicros: 999_999_937 },
      now: () => clock,
    });
    const sandbox = await Effect.runPromise(
      manager.create({
        executionTargetId: AGENT_DEPLOYMENT_ID,
        executionTargetKind: "agent-deployment",
        environmentId: ENVIRONMENT_ID,
        isolationMode: "run-ephemeral",
        minMemoryMiB: MAX_SANDBOX_RESERVED_MEMORY_MIB,
        minVcpu: MAX_SANDBOX_RESERVED_VCPU,
        observability: OBSERVABILITY,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        workspaceId: IDS[8] as Ulid,
      }),
    );
    clock = destroyedAt;

    expect(Effect.runPromise(manager.destroy(sandbox))).resolves.toMatchObject({
      data: {
        destroyedAt: new Date(durationMs).toISOString(),
        status: "destroyed",
      },
    });

    const usage = transactions
      .flatMap(records)
      .filter(
        (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
          record.itemType === "meter-event",
      );
    expect(
      usage.every(
        (record) =>
          Number.isSafeInteger(record.data.quantity) &&
          (record.data.dimensions.costUsdMicros === undefined ||
            Number.isSafeInteger(record.data.dimensions.costUsdMicros)),
      ),
    ).toBe(true);
    const memoryUsage = usage.filter((record) => record.data.metric === "sandbox_memory_mib_ms");
    expect(memoryUsage).toHaveLength(2);
    expect(memoryUsage.reduce((total, record) => total + BigInt(record.data.quantity), 0n)).toBe(
      BigInt(durationMs) * BigInt(MAX_SANDBOX_RESERVED_MEMORY_MIB),
    );
    const firstVcpuUsage = usage.find((record) => record.data.metric === "sandbox_vcpu_ms");
    const exactVcpuCost =
      (BigInt(firstVcpuUsage?.data.quantity ?? 0) * 999_999_937n + 1_800_000n) / 3_600_000n;
    expect(firstVcpuUsage?.data.dimensions.costUsdMicros).toBe(Number(exactVcpuCost));
    expect(
      transactions
        .flatMap(records)
        .some(
          (record) =>
            record.itemType === "semantic-event" &&
            record.data.eventType === "sandbox.usage-recorded",
        ),
    ).toBe(true);
    const usageRecorded = transactions
      .map(leaseRecord)
      .find((record) => record.data.status === "releasing" && record.data.usagePendingThrough);
    const destroyed = transactions
      .map(leaseRecord)
      .find((record) => record.data.status === "destroyed");
    expect(Date.parse(destroyed?.data.updatedAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(usageRecorded?.data.updatedAt ?? ""),
    );
  });

  test("segments long active usage before normal and reconciled resume commits", async () => {
    const durationMs = 365 * 24 * 60 * 60 * 1_000;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "sandbox_long_resume",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      reservedMemoryMiB: MAX_SANDBOX_RESERVED_MEMORY_MIB,
      reservedVcpu: MAX_SANDBOX_RESERVED_VCPU,
      runId: RUN_ID,
      status: "ready",
      workspaceId: IDS[8] as Ulid,
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
      reconcileResume: async (input) => ({ ...input.lease, status: "ready" }),
      resume: async (input) => ({ ...input.lease, status: "ready" }),
      upload: async () => undefined,
    };
    const setupTransactions: TransactionOperation[][] = [];
    const setupManager = makeSandboxManager(
      provider,
      database(setupTransactions),
      makeIdGenerator(),
      { now: () => 0 },
    );
    const sandbox = await Effect.runPromise(
      setupManager.create({
        executionTargetId: AGENT_DEPLOYMENT_ID,
        executionTargetKind: "agent-deployment",
        environmentId: ENVIRONMENT_ID,
        isolationMode: "run-ephemeral",
        minMemoryMiB: MAX_SANDBOX_RESERVED_MEMORY_MIB,
        minVcpu: MAX_SANDBOX_RESERVED_VCPU,
        observability: OBSERVABILITY,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        workspaceId: IDS[8] as Ulid,
      }),
    );

    for (const status of ["error", "resuming"] as const) {
      const recoveryTransactions: TransactionOperation[][] = [];
      const activeRecord: SandboxLeaseRecordValue = {
        ...sandbox.record,
        data: {
          ...sandbox.record.data,
          computeUsageActive: true,
          ...(status === "error" ? { failureReason: "provider-resume-failed" } : {}),
          status,
          updatedAt: sandbox.record.data.usageStartedAt,
          usageAccountedThrough: sandbox.record.data.usageStartedAt,
          version: sandbox.record.data.version + 1,
        },
      };
      const manager = makeSandboxManager(
        provider,
        databaseSeededWith(activeRecord, recoveryTransactions),
        makeIdGenerator(),
        { now: () => durationMs },
      );

      if (status === "error") {
        await Effect.runPromise(manager.resume(managedSandboxFromRecord(activeRecord)));
      } else {
        await Effect.runPromise(manager.reconcileResume(activeRecord));
      }

      const memoryUsage = recoveryTransactions
        .flatMap(records)
        .filter(
          (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
            record.itemType === "meter-event" && record.data.metric === "sandbox_memory_mib_ms",
        );
      expect(memoryUsage.length).toBeGreaterThan(1);
      expect(memoryUsage.every((record) => Number.isSafeInteger(record.data.quantity))).toBe(true);
      expect(memoryUsage.reduce((total, record) => total + BigInt(record.data.quantity), 0n)).toBe(
        BigInt(durationMs) * BigInt(MAX_SANDBOX_RESERVED_MEMORY_MIB),
      );
      const usageChunks = recoveryTransactions
        .filter((transaction) =>
          records(transaction).some(
            (record) =>
              record.itemType === "semantic-event" &&
              record.data.eventType === "sandbox.usage-recorded",
          ),
        )
        .map(leaseRecord);
      expect(usageChunks.length).toBeGreaterThan(0);
      expect(
        usageChunks.every(
          (record) => record.data.usagePendingThrough === new Date(durationMs).toISOString(),
        ),
      ).toBe(true);
    }
  });

  test("applies resumed capacity only after the active usage boundary", async () => {
    const setupTransactions: TransactionOperation[][] = [];
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "sandbox_resume_capacity",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      region: "us-east-2",
      reservedMemoryMiB: 1_024,
      reservedVcpu: 1,
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
      resume: async (input) => ({
        ...input.lease,
        region: "us-west-2",
        reservedMemoryMiB: 4_096,
        reservedVcpu: 2,
        status: "ready",
      }),
      upload: async () => undefined,
    };
    const setupManager = makeSandboxManager(
      provider,
      database(setupTransactions),
      makeIdGenerator(),
      { now: () => 0 },
    );
    const sandbox = await Effect.runPromise(
      setupManager.create({
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
    );
    const activeRecord: SandboxLeaseRecordValue = {
      ...sandbox.record,
      data: {
        ...sandbox.record.data,
        computeUsageActive: true,
        failureReason: "provider-resume-failed",
        status: "error",
        version: sandbox.record.data.version + 1,
      },
    };
    const transactions: TransactionOperation[][] = [];
    const times = [1_000, 2_000, 3_000, 4_000, 5_000, 6_000];
    const manager = makeSandboxManager(
      provider,
      databaseSeededWith(activeRecord, transactions),
      makeIdGenerator(),
      { now: () => times.shift() ?? 6_000 },
    );

    const resumed = await Effect.runPromise(manager.resume(managedSandboxFromRecord(activeRecord)));
    await Effect.runPromise(manager.destroy(resumed));

    const usageFor = (eventType: string, metric: string) =>
      records(
        transactions.find((transaction) =>
          records(transaction).some(
            (record) => record.itemType === "semantic-event" && record.data.eventType === eventType,
          ),
        ) ?? [],
      ).find(
        (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
          record.itemType === "meter-event" && record.data.metric === metric,
      );

    expect(usageFor("sandbox.resumed", "sandbox_vcpu_ms")?.data.quantity).toBe(3_000);
    expect(usageFor("sandbox.resumed", "sandbox_memory_mib_ms")?.data.quantity).toBe(3_000 * 1_024);
    expect(usageFor("sandbox.resumed", "sandbox_ms")?.data.dimensions.region).toBe("us-east-2");
    expect(usageFor("sandbox.destroyed", "sandbox_vcpu_ms")?.data.quantity).toBe(4_000);
    expect(usageFor("sandbox.destroyed", "sandbox_memory_mib_ms")?.data.quantity).toBe(
      2_000 * 4_096,
    );
    expect(usageFor("sandbox.destroyed", "sandbox_ms")?.data.dimensions.region).toBe("us-west-2");
  });
});
