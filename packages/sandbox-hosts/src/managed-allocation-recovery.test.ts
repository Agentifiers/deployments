import {
  DatabaseError,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
  decodePlatformRecord,
  makeIdGenerator,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  SandboxAllocationLeaseError,
  SandboxAllocationUnknownError,
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

describe("managed sandbox allocation recovery", () => {
  test("preserves provider-declared capacity when the ready lease omits reservations", async () => {
    const transactions: TransactionOperation[][] = [];
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_provider_reservation",
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
      provisioningReservation: () => ({
        reservedMemoryMiB: 4_096,
        reservedVcpu: 2,
      }),
      resume: async () => lease,
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(provider, database(transactions), makeIdGenerator(), {
      now: () => 1_000,
    });

    const sandbox = await Effect.runPromise(
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
    );

    expect(sandbox.record.data).toMatchObject({
      reservedMemoryMiB: 4_096,
      reservedVcpu: 2,
      status: "ready",
    });
  });

  test("preserves an ambiguously allocated sandbox for reconciliation", async () => {
    const transactions: TransactionOperation[][] = [];
    const allocationIds: Array<Ulid | undefined> = [];
    const requestedReservations: Array<[number | undefined, number | undefined]> = [];
    let createCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_reconciled_allocation",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      runId: RUN_ID,
      status: "ready",
    };
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      allocationFingerprint: (input) => `${input.minMemoryMiB}:${input.minVcpu}`,
      automaticAllocationReconciliation: true,
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async (input) => {
        createCalls += 1;
        allocationIds.push(input.allocationId);
        requestedReservations.push([input.minMemoryMiB, input.minVcpu]);
        if (createCalls > 1) return lease;
        throw new SandboxAllocationUnknownError({
          allocationError: new Error("RunMicrovm response timeout"),
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
      provisioningReservation: () => ({
        reservedMemoryMiB: 4_096,
        reservedVcpu: 2,
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

    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      failureReason: "provider-create-outcome-unknown",
      requestedMemoryMiB: 1_024,
      requestedVcpu: 1,
      reservedMemoryMiB: 4_096,
      reservedVcpu: 2,
      status: "creating",
    });
    expect(
      transactions.flatMap(records).filter((record) => record.itemType === "meter-event"),
    ).toHaveLength(0);
    const unknown = leaseRecord(transactions.at(-1) ?? []);
    const reconciled = await Effect.runPromise(manager.reconcileCreate(unknown));
    expect(reconciled.record.data).toMatchObject({
      externalSandboxId: "microvm_reconciled_allocation",
      status: "ready",
    });
    expect(reconciled.record.data.failureReason).toBeUndefined();
    expect(allocationIds).toEqual([unknown.data.id, unknown.data.id]);
    expect(requestedReservations).toEqual([
      [1_024, 1],
      [1_024, 1],
    ]);
  });

  test("does not replay a manual-only unknown allocation", async () => {
    const transactions: TransactionOperation[][] = [];
    const times = [0, 250, 10_000];
    let createCalls = 0;
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async (input) => {
        createCalls += 1;
        throw new SandboxAllocationUnknownError({
          allocationError: new Error("response timeout"),
          allocationToken: String(input.allocationId),
          automaticReconciliation: false,
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
    const manager = makeSandboxManager(
      provider,
      statefulDatabase(transactions),
      makeIdGenerator(),
      { now: () => times.shift() ?? 10_000 },
    );

    expect(
      Effect.runPromise(
        manager.create({
          executionTargetId: AGENT_DEPLOYMENT_ID,
          executionTargetKind: "agent-deployment",
          environmentId: ENVIRONMENT_ID,
          isolationMode: "run-ephemeral",
          organizationId: ORGANIZATION_ID,
          preferredRegion: "us-west-2",
          observability: OBSERVABILITY,
          projectId: PROJECT_ID,
          runId: RUN_ID,
          workspaceId: IDS[8] as Ulid,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "create",
    });

    const unknown = leaseRecord(transactions.at(-1) ?? []);
    expect(unknown.data).toMatchObject({
      failureReason: "provider-create-outcome-manual-reconciliation",
      preferredRegion: "us-west-2",
      status: "creating",
    });
    expect(Effect.runPromise(manager.reconcileCreate(unknown))).rejects.toMatchObject({
      _tag: "SandboxRecordError",
    });
    const resolved = await Effect.runPromise(manager.resolveCreateAsNotAllocated(unknown, 250));
    expect(resolved.data).toMatchObject({
      failureReason: "provider-create-manually-confirmed-absent",
      status: "destroyed",
    });
    const sandboxUsage = records(transactions.at(-1) ?? []).find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "meter-event" }> =>
        record.itemType === "meter-event" && record.data.metric === "sandbox_ms",
    );
    expect(sandboxUsage?.data.quantity).toBe(250);
    expect(createCalls).toBe(1);
  });

  test("attaches a manually discovered allocation without replaying create", async () => {
    const transactions: TransactionOperation[][] = [];
    let createCalls = 0;
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async (input) => {
        createCalls += 1;
        throw new SandboxAllocationUnknownError({
          allocationError: new Error("response timeout"),
          allocationToken: String(input.allocationId),
          automaticReconciliation: false,
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
      providerRouteKeyForLease: () => "lambda-route-a",
      resume: async (input) => ({ ...input.lease, status: "ready" }),
      upload: async () => undefined,
      validateLeaseRoute: (lease) => {
        if (lease.providerRouteKey !== "lambda-route-a") {
          throw new Error("wrong Lambda route");
        }
      },
    };
    const manager = makeSandboxManager(provider, statefulDatabase(transactions), makeIdGenerator());
    const input = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment" as const,
      environmentId: ENVIRONMENT_ID,
      isolationMode: "run-ephemeral" as const,
      observability: OBSERVABILITY,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      workspaceId: IDS[8] as Ulid,
    };

    expect(Effect.runPromise(manager.create(input))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "create",
    });
    const unknown = leaseRecord(transactions.at(-1) ?? []);
    const discovered: SandboxLease = {
      ...input,
      externalSandboxId: "sandbox_discovered",
      provider: "aws_lambda_microvm",
      status: "ready",
    };
    const reconciled = await Effect.runPromise(
      manager.reconcileCreateWithLease(unknown, discovered),
    );

    expect(reconciled.record.data).toMatchObject({
      externalSandboxId: "sandbox_discovered",
      providerRouteKey: "lambda-route-a",
      status: "ready",
    });
    expect(reconciled.lease.providerRouteKey).toBe("lambda-route-a");
    expect(createCalls).toBe(1);
  });

  test("manually recovers a creating lease without failure metadata", async () => {
    const setupTransactions: TransactionOperation[][] = [];
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async (input) => {
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
      resume: async (input) => ({ ...input.lease, status: "ready" }),
      upload: async () => undefined,
    };
    const setupManager = makeSandboxManager(
      provider,
      database(setupTransactions),
      makeIdGenerator(),
    );
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

    expect(Effect.runPromise(setupManager.create(input))).rejects.toBeDefined();
    const creating = leaseRecord(setupTransactions[0] ?? []);
    expect(creating.data.failureReason).toBeUndefined();
    const creatingWithRecovery = await Effect.runPromise(
      decodePlatformRecord({
        ...creating,
        data: {
          ...creating.data,
          leaseExpiresAt: "2026-07-21T01:00:00.000Z",
          recoveryExternalSandboxId: "microvm_discovered_after_worker_loss",
          region: "us-east-2",
        },
      }),
    );
    if (creatingWithRecovery.itemType !== "sandbox-lease") {
      throw new Error("Expected sandbox lease recovery record");
    }

    const recoveryTransactions: TransactionOperation[][] = [];
    const recoveryManager = makeSandboxManager(
      provider,
      databaseSeededWith(creatingWithRecovery, recoveryTransactions),
      makeIdGenerator(),
    );
    const recovered = await Effect.runPromise(
      recoveryManager.reconcileCreateWithLease(creatingWithRecovery, {
        ...input,
        externalSandboxId: "microvm_discovered_after_worker_loss",
        provider: "aws_lambda_microvm",
        status: "ready",
      }),
    );

    expect(recovered.record.data).toMatchObject({
      externalSandboxId: "microvm_discovered_after_worker_loss",
      status: "ready",
    });
    expect(recovered.lease).toMatchObject({
      externalSandboxId: "microvm_discovered_after_worker_loss",
      leaseExpiresAt: Date.parse("2026-07-21T01:00:00.000Z"),
      region: "us-east-2",
      status: "ready",
    });
  });

  test("cleans up a known identity from an invalid allocation response", async () => {
    const transactions: TransactionOperation[][] = [];
    let claimedBeforeDestroy = false;
    let destroyCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "sandbox_unready",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      reservedMemoryMiB: -1,
      reservedVcpu: -1,
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
          allocationError: new Error("Invalid sandbox lease.status response"),
          lease,
        });
      },
      destroy: async () => {
        destroyCalls += 1;
        const cleanupClaim = records(transactions.at(-1) ?? []);
        claimedBeforeDestroy =
          cleanupClaim.some(
            (record) => record.itemType === "sandbox-lease" && record.data.status === "releasing",
          ) && cleanupClaim.some((record) => record.itemType === "unique-claim");
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
      operation: "create",
    });

    expect(destroyCalls).toBe(1);
    expect(claimedBeforeDestroy).toBe(true);
    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      externalSandboxId: "sandbox_unready",
      reservedMemoryMiB: 2_048,
      reservedVcpu: 1,
      status: "destroyed",
    });
    expect(
      transactions
        .flatMap(records)
        .some(
          (record) =>
            record.itemType === "semantic-event" &&
            record.data.eventType === "sandbox.destroy-completed",
        ),
    ).toBe(true);
  });
});
