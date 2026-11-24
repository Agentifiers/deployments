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
import { SandboxDataPlaneUnknownError, type SandboxLease, type SandboxProvider } from "./index.ts";
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
    getRecord: async (_table, key) =>
      stored.has(recordKey(key)) ? (stored.get(recordKey(key)) as PlatformRecord) : undefined,
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

describe("managed sandbox persistence and data-plane leases", () => {
  test("keeps a later lease version persistence-unknown without compensation", async () => {
    const transactions: TransactionOperation[][] = [];
    let stored: PlatformRecord | undefined;
    let destroyCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_later_version",
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
    const ambiguous = new DatabaseError({
      cause: new Error("response timeout"),
      message: "transaction outcome unknown",
      operation: "transact-write",
      table: "execution",
    });
    const db: DynamoDatabaseService = {
      deleteRecord: async () => {},
      getRecord: async (table) => (table === "execution" && stored ? stored : undefined),
      putRecord: async () => {},
      queryRecords: async () => ({ items: [] }),
      transactWrite: async (operations) => {
        transactions.push([...operations]);
        const target = leaseRecord(operations);
        const event = records(operations).find((record) => record.itemType === "semantic-event");
        if (event?.itemType === "semantic-event" && event.data.eventType === "sandbox.ready") {
          stored = {
            ...target,
            data: {
              ...target.data,
              updatedAt: "2026-07-21T00:00:00.000Z",
              version: target.data.version + 1,
            },
          };
          throw ambiguous;
        }
        stored = target;
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
    ).rejects.toMatchObject({ _tag: "SandboxPersistenceUnknownError" });
    expect(destroyCalls).toBe(0);
  });

  test("does not destroy invalid provider leases claimed by another owner", async () => {
    const transactions: TransactionOperation[][] = [];
    let destroyCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_invalid_shared",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      runId: RUN_ID,
      status: "error",
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
    const conflictingClaim = {
      data: {
        createdAt: "2026-07-21T00:00:00.000Z",
        namespace: "sandbox-provider:aws_lambda_microvm:pool:default",
        ownerId: IDS[8] as Ulid,
        ownerItemType: "sandbox-lease",
        ownerPk: "AGENT#other",
        ownerSk: "SANDBOX#other",
        ownerTable: "execution",
        value: "microvm_invalid_shared",
      },
      itemType: "unique-claim",
      pk: "UNIQUE#sandbox-provider",
      sk: "VALUE#microvm_invalid_shared",
    } as unknown as PlatformRecord;
    const base = database(transactions);
    const db: DynamoDatabaseService = {
      ...base,
      getRecord: async (table) => (table === "control" ? conflictingClaim : undefined),
      transactWrite: async (operations) => {
        transactions.push([...operations]);
        const event = records(operations).find((record) => record.itemType === "semantic-event");
        if (event?.itemType === "semantic-event" && event.data.eventType === "sandbox.releasing") {
          throw new DatabaseError({
            cause: new Error("provider identity already claimed"),
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
    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      failureReason: "provider-lease-not-ready-identity-conflict",
      status: "error",
    });
  });

  test("blocks data-plane calls for suspended sandboxes", async () => {
    const transactions: TransactionOperation[][] = [];
    let execCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_suspended",
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
        checkpointRef: "lambda-microvm://microvm_suspended/suspended",
        createdAt: 1,
        provider: "aws_lambda_microvm",
      }),
      create: async () => lease,
      destroy: async () => undefined,
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => {
        execCalls += 1;
        return { durationMs: 1, exitCode: 0, stderr: "", stdout: "" };
      },
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
      }),
    );
    const suspended = await Effect.runPromise(manager.checkpoint(sandbox));

    expect(
      Effect.runPromise(manager.exec({ command: ["pwd"], sandbox: suspended })),
    ).rejects.toMatchObject({
      _tag: "SandboxRecordError",
      message: "Sandbox data-plane operations require a ready lease.",
    });
    expect(execCalls).toBe(0);
  });

  test("retains the operation lease when a provider returns an async exec handle", async () => {
    const transactions: TransactionOperation[][] = [];
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_async_exec",
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
        checkpointRef: "lambda-microvm://microvm_async_exec/suspended",
        createdAt: 1,
        provider: "aws_lambda_microvm",
      }),
      create: async () => lease,
      destroy: async () => undefined,
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => ({
        lease: { ...lease, externalSandboxId: "microvm_untrusted" },
        operationId: "operation-1",
      }),
      resume: async () => lease,
      upload: async () => undefined,
    };
    const database = recordStoreDatabase([], transactions);
    const manager = makeSandboxManager(provider, database, makeIdGenerator(), {
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

    expect(Effect.runPromise(manager.exec({ command: ["pwd"], sandbox }))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "exec-async-unsupported",
    });
    expect(Effect.runPromise(manager.exec({ command: ["pwd"], sandbox }))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "exec-lease",
    });
  });

  test("retains the operation lease after ambiguous data-plane mutations", async () => {
    let checkpointCalls = 0;
    let destroyCalls = 0;
    const provider: SandboxProvider = {
      name: "aws_lambda_microvm",
      checkpoint: async (input) => {
        checkpointCalls += 1;
        return {
          checkpointRef: `lambda-microvm://${input.lease.externalSandboxId}/suspended`,
          createdAt: 1,
          provider: "aws_lambda_microvm",
        };
      },
      create: async (input) => ({
        ...input,
        externalSandboxId: `microvm_${input.allocationId}`,
        provider: "aws_lambda_microvm",
        status: "ready",
      }),
      destroy: async () => {
        destroyCalls += 1;
      },
      download: async () => new ReadableStream<Uint8Array>(),
      exec: async () => {
        throw new SandboxDataPlaneUnknownError("exec", new Error("response timeout"));
      },
      resume: async (input) => ({ ...input.lease, status: "ready" }),
      upload: async () => {
        throw new SandboxDataPlaneUnknownError("upload", new Error("response timeout"));
      },
    };
    const manager = makeSandboxManager(provider, recordStoreDatabase(), makeIdGenerator(), {
      operationAcquireTimeoutMs: 0,
    });
    const createInput = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment" as const,
      environmentId: ENVIRONMENT_ID,
      isolationMode: "run-ephemeral" as const,
      observability: OBSERVABILITY,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
    };
    const execSandbox = await Effect.runPromise(manager.create(createInput));

    expect(
      Effect.runPromise(manager.exec({ command: ["pwd"], sandbox: execSandbox })),
    ).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "exec",
    });
    expect(Effect.runPromise(manager.checkpoint(execSandbox))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "checkpoint-lease",
    });
    expect(checkpointCalls).toBe(0);

    const uploadSandbox = await Effect.runPromise(manager.create(createInput));
    expect(
      Effect.runPromise(
        manager.upload({
          content: new Uint8Array([1]),
          path: "/tmp/a",
          sandbox: uploadSandbox,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "upload",
    });
    expect(Effect.runPromise(manager.destroy(uploadSandbox))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "destroy-lease",
    });
    expect(destroyCalls).toBe(0);
  });

  test("releases the operation lease for a pre-aborted data-plane request", async () => {
    let execCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_pre_aborted",
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
      exec: async (input) => {
        execCalls += 1;
        input.signal?.throwIfAborted();
        return { durationMs: 1, exitCode: 0, stderr: "", stdout: "" };
      },
      resume: async () => lease,
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(provider, recordStoreDatabase(), makeIdGenerator(), {
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
    const controller = new AbortController();
    controller.abort(new Error("already canceled"));

    expect(
      Effect.runPromise(manager.exec({ command: ["pwd"], sandbox, signal: controller.signal })),
    ).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "exec",
    });
    expect(Effect.runPromise(manager.exec({ command: ["pwd"], sandbox }))).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(execCalls).toBe(1);
  });

  test("releases the operation lease when caller cancellation precedes mutation dispatch", async () => {
    let execCalls = 0;
    let markPreflightStarted: (() => void) | undefined;
    const preflightStarted = new Promise<void>((resolve) => {
      markPreflightStarted = resolve;
    });
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_preflight_abort",
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
      exec: async (input) => {
        execCalls += 1;
        if (execCalls === 1) {
          markPreflightStarted?.();
          return await new Promise((_resolve, reject) =>
            input.signal?.addEventListener("abort", () => reject(input.signal?.reason), {
              once: true,
            }),
          );
        }
        input.onMutationDispatch?.();
        return { durationMs: 1, exitCode: 0, stderr: "", stdout: "" };
      },
      resume: async () => lease,
      upload: async () => undefined,
    };
    const manager = makeSandboxManager(provider, recordStoreDatabase(), makeIdGenerator());
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
    const controller = new AbortController();
    const first = Effect.runPromise(
      manager.exec({ command: ["pwd"], sandbox, signal: controller.signal }),
    );
    await preflightStarted;
    controller.abort(new Error("caller canceled during preflight"));

    expect(first).rejects.toMatchObject({
      _tag: "SandboxOperationError",
    });
    expect(Effect.runPromise(manager.exec({ command: ["pwd"], sandbox }))).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(execCalls).toBe(2);
  });
});
