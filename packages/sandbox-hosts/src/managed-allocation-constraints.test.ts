import {
  type DynamoDatabaseService,
  type TransactionOperation,
  type Ulid,
  makeIdGenerator,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { type SandboxProvider } from "./index.ts";
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
const ALLOCATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB8" as Ulid;

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

describe("managed sandbox allocation constraints", () => {
  test("uses a caller-provided durable allocation identity", async () => {
    const transactions: TransactionOperation[][] = [];
    let providerAllocationId: Ulid | undefined;
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async (input) => {
        providerAllocationId = input.allocationId;
        return {
          executionTargetId: AGENT_DEPLOYMENT_ID,
          executionTargetKind: "agent-deployment",
          environmentId: ENVIRONMENT_ID,
          externalSandboxId: `microvm_${input.allocationId}`,
          isolationMode: "run-ephemeral",
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          provider: "aws_lambda_microvm",
          runId: RUN_ID,
          status: "ready",
        };
      },
      destroy: async () => undefined,
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
      resume: async () => {
        throw new Error("not reached");
      },
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(provider, database(transactions), makeIdGenerator());

    const created = await Effect.runPromise(
      manager.create({
        executionTargetId: AGENT_DEPLOYMENT_ID,
        executionTargetKind: "agent-deployment",
        allocationId: ALLOCATION_ID,
        environmentId: ENVIRONMENT_ID,
        isolationMode: "run-ephemeral",
        observability: OBSERVABILITY,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
      }),
    );

    expect(providerAllocationId).toBe(ALLOCATION_ID);
    expect(created.record.data.id).toBe(ALLOCATION_ID);
  });

  test("requires trace context for run-owned allocations and stamps it on the lease", async () => {
    const transactions: TransactionOperation[][] = [];
    let providerCreates = 0;
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async () => {
        throw new Error("not reached");
      },
      create: async (input) => {
        providerCreates += 1;
        return {
          executionTargetId: AGENT_DEPLOYMENT_ID,
          executionTargetKind: "agent-deployment",
          environmentId: ENVIRONMENT_ID,
          externalSandboxId: `microvm_${input.allocationId}`,
          isolationMode: "thread-persistent",
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          provider: "aws_lambda_microvm",
          ...(input.runId ? { runId: input.runId } : {}),
          status: "ready",
        };
      },
      destroy: async () => undefined,
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
      resume: async () => {
        throw new Error("not reached");
      },
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(provider, database(transactions), makeIdGenerator());
    const input = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment" as const,
      environmentId: ENVIRONMENT_ID,
      isolationMode: "thread-persistent" as const,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };

    expect(Effect.runPromise(manager.create({ ...input, runId: RUN_ID }))).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: "A run-owned sandbox requires the run's immutable trace context.",
    });
    expect({ providerCreates, transactions }).toEqual({ providerCreates: 0, transactions: [] });

    const traced = await Effect.runPromise(
      manager.create({ ...input, observability: OBSERVABILITY, runId: RUN_ID }),
    );
    expect(traced.record.data).toMatchObject({ observability: OBSERVABILITY, runId: RUN_ID });
    const leaseContexts = transactions
      .flatMap(records)
      .flatMap((record) =>
        record.itemType === "sandbox-lease" ? [record.data.observability] : [],
      );
    expect(leaseContexts.length).toBeGreaterThan(1);
    expect(leaseContexts).toEqual(leaseContexts.map(() => OBSERVABILITY));

    const shared = await Effect.runPromise(manager.create(input));
    expect(shared.record.data.runId).toBeUndefined();
    expect(shared.record.data.observability).toBeUndefined();
  });

  test("cleans up same-tenant leases that violate requested image or capacity", async () => {
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
        externalSandboxId: "sandbox_underprovisioned",
        imageRef: "wrong-image",
        isolationMode: "run-ephemeral",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "aws_lambda_microvm",
        reservedMemoryMiB: 1_024,
        reservedVcpu: 1,
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
          imageRef: "required-image",
          isolationMode: "run-ephemeral",
          minMemoryMiB: 4_096,
          minVcpu: 2,
          observability: OBSERVABILITY,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          runId: RUN_ID,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "SandboxRecordError" });
    expect(destroyCalls).toBe(1);
    expect(leaseRecord(transactions.at(-1) ?? []).data.status).toBe("destroyed");
  });
});
