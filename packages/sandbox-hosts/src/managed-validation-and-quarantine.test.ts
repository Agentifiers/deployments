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
  MAX_SANDBOX_RESERVED_MEMORY_MIB,
  MAX_SANDBOX_RESERVED_VCPU,
  SandboxAllocationLeaseError,
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

describe("managed sandbox validation and quarantine", () => {
  test("rejects expired resumed leases before publishing resumed state", async () => {
    const transactions: TransactionOperation[][] = [];
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_expired_resume",
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
        checkpointRef: "lambda-microvm://microvm_expired_resume/suspended",
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
      resume: async (input) => ({
        ...input.lease,
        leaseExpiresAt: 500,
        status: "ready",
      }),
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(provider, database(transactions), makeIdGenerator(), {
      now: (() => {
        let value = 0;
        return () => (value += 1_000);
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
      message: "Sandbox provider returned an expired resumed lease.",
    });
    expect(
      transactions
        .flatMap(records)
        .some(
          (record) =>
            record.itemType === "semantic-event" && record.data.eventType === "sandbox.resumed",
        ),
    ).toBe(false);
    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      failureReason: "provider-resume-identity-mismatch",
      status: "error",
    });
  });

  test("rejects an expired suspended lease before calling resume", async () => {
    const transactions: TransactionOperation[][] = [];
    let clock = 0;
    let resumeCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_expired_before_resume",
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
        checkpointRef: "lambda-microvm://microvm_expired_before_resume/suspended",
        createdAt: clock,
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
        return lease;
      },
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(
      provider,
      statefulDatabase(transactions),
      makeIdGenerator(),
      { now: () => clock },
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
    clock = 1_000;
    const suspended = await Effect.runPromise(manager.checkpoint(sandbox));
    clock = 10_000;

    expect(Effect.runPromise(manager.resume(suspended))).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: "Expired sandbox leases cannot be resumed.",
    });
    expect(resumeCalls).toBe(0);
    expect(leaseRecord(transactions.at(-1) ?? []).data.status).toBe("suspended");
  });

  test("rejects non-positive reservations before allocation", async () => {
    const transactions: TransactionOperation[][] = [];
    let createCalls = 0;
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async () => {
        createCalls += 1;
        throw new Error("not reached");
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
          minVcpu: 0,
          observability: OBSERVABILITY,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          runId: RUN_ID,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: "Sandbox minVcpu must be a positive finite number.",
    });
    expect(createCalls).toBe(0);
    expect(transactions).toHaveLength(0);

    expect(
      Effect.runPromise(
        manager.create({
          executionTargetId: AGENT_DEPLOYMENT_ID,
          executionTargetKind: "agent-deployment",
          environmentId: ENVIRONMENT_ID,
          isolationMode: "run-ephemeral",
          minMemoryMiB: MAX_SANDBOX_RESERVED_MEMORY_MIB + 1,
          observability: OBSERVABILITY,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          runId: RUN_ID,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: `Sandbox minMemoryMiB must be no greater than ${MAX_SANDBOX_RESERVED_MEMORY_MIB}.`,
    });
    expect(
      Effect.runPromise(
        manager.create({
          executionTargetId: AGENT_DEPLOYMENT_ID,
          executionTargetKind: "agent-deployment",
          environmentId: ENVIRONMENT_ID,
          isolationMode: "run-ephemeral",
          minVcpu: MAX_SANDBOX_RESERVED_VCPU + 1,
          observability: OBSERVABILITY,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          runId: RUN_ID,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: `Sandbox minVcpu must be no greater than ${MAX_SANDBOX_RESERVED_VCPU}.`,
    });
    expect(createCalls).toBe(0);
    expect(transactions).toHaveLength(0);
  });

  test("rejects unsafe sandbox usage cost rates at manager construction", () => {
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async () => {
        throw new Error("not reached");
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

    expect(() =>
      makeSandboxManager(provider, database([]), makeIdGenerator(), {
        costPolicy: { baseHourUsdMicros: 1_000_000_001 },
      }),
    ).toThrow("costPolicy.baseHourUsdMicros must be a non-negative safe integer");
    expect(() =>
      makeSandboxManager(provider, database([]), makeIdGenerator(), {
        costPolicy: { vcpuHourUsdMicros: 0.5 },
      }),
    ).toThrow("costPolicy.vcpuHourUsdMicros must be a non-negative safe integer");
    expect(() =>
      makeSandboxManager(provider, database([]), makeIdGenerator(), {
        costPolicy: { memoryGiBHourUsdMicros: -1 },
      }),
    ).toThrow("costPolicy.memoryGiBHourUsdMicros must be a non-negative safe integer");
  });

  test("persists an unclaimed provider identity when tenant validation fails", async () => {
    const transactions: TransactionOperation[][] = [];
    let destroyCalls = 0;
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async () => ({
        executionTargetId: AGENT_DEPLOYMENT_ID,
        executionTargetKind: "agent-deployment",
        environmentId: ENVIRONMENT_ID,
        externalSandboxId: "sandbox_other_tenant",
        isolationMode: "run-ephemeral",
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FB9" as Ulid,
        projectId: PROJECT_ID,
        provider: "aws_lambda_microvm",
        runId: RUN_ID,
        status: "ready",
      }),
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
    ).rejects.toMatchObject({ _tag: "SandboxRecordError" });

    expect(destroyCalls).toBe(0);
    expect(
      transactions
        .flatMap(records)
        .some((record) =>
          record.itemType === "semantic-event"
            ? record.data.eventType === "sandbox.allocated"
            : false,
        ),
    ).toBe(false);
    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      computeUsageActive: true,
      failureReason: "provider-lease-identity-mismatch",
      recoveryExternalSandboxId: "sandbox_other_tenant",
      status: "creating",
    });
    expect(leaseRecord(transactions.at(-1) ?? []).data.externalSandboxId).toBeUndefined();
    const failureEvent = records(transactions.at(-1) ?? []).find(
      (record) => record.itemType === "semantic-event",
    );
    expect(failureEvent?.data.payload).not.toHaveProperty("recoveryExternalSandboxId");
  });

  test("preserves a failed allocation identity when tenant validation fails", async () => {
    const transactions: TransactionOperation[][] = [];
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async () => {
        throw new SandboxAllocationLeaseError({
          allocationError: new Error("invalid tenant response"),
          lease: {
            executionTargetId: AGENT_DEPLOYMENT_ID,
            executionTargetKind: "agent-deployment",
            environmentId: ENVIRONMENT_ID,
            externalSandboxId: "sandbox_failed_other_tenant",
            isolationMode: "run-ephemeral",
            organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FB9" as Ulid,
            projectId: PROJECT_ID,
            provider: "aws_lambda_microvm",
            runId: RUN_ID,
            status: "error",
          },
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
    ).rejects.toMatchObject({ _tag: "SandboxRecordError" });

    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      computeUsageActive: true,
      failureReason: "provider-lease-identity-mismatch",
      recoveryExternalSandboxId: "sandbox_failed_other_tenant",
      status: "creating",
    });
  });

  test("persists an unverified provider identity without claiming or destroying it", async () => {
    const transactions: TransactionOperation[][] = [];
    let createCalls = 0;
    let destroyCalls = 0;
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async () => {
        createCalls += 1;
        throw new SandboxAllocationLeaseError({
          allocationError: new Error("provider returned a different tenant scope"),
          identityVerified: false,
          lease: {
            environmentId: IDS[10] as Ulid,
            executionTargetId: IDS[9] as Ulid,
            executionTargetKind: "agent-deployment",
            externalSandboxId: "sandbox_quarantined_scope",
            isolationMode: "run-ephemeral",
            organizationId: IDS[11] as Ulid,
            projectId: IDS[12] as Ulid,
            provider: "aws_lambda_microvm",
            runId: IDS[9] as Ulid,
            status: "error",
            workspaceId: IDS[10] as Ulid,
          },
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
          workspaceId: IDS[8] as Ulid,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "SandboxRecordError" });

    expect(createCalls).toBe(1);
    expect(destroyCalls).toBe(0);
    expect(
      transactions
        .flatMap(records)
        .flatMap((record) => (record.itemType === "unique-claim" ? [record.data.namespace] : [])),
    ).toEqual([`organization:${ORGANIZATION_ID}:active-sandbox-slot`]);
    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      computeUsageActive: true,
      failureReason: "provider-lease-identity-mismatch",
      recoveryExternalSandboxId: "sandbox_quarantined_scope",
      status: "creating",
    });
    expect(leaseRecord(transactions.at(-1) ?? []).data.externalSandboxId).toBeUndefined();
  });
});
