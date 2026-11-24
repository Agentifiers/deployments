import {
  DatabaseError,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
  makeIdGenerator,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { type SandboxLease, type SandboxProvider } from "./index.ts";
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

describe("managed sandbox operation aborts and streams", () => {
  test("aborts an in-flight provider call when operation lease renewal fails", async () => {
    let rejectRenewals = false;
    let observedSignal: AbortSignal | undefined;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_failed_operation_renewal",
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
        observedSignal = input.signal;
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve({
                durationMs: 2_000,
                exitCode: 0,
                stderr: "",
                stdout: "",
              }),
            2_000,
          );
          input.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(input.signal?.reason);
            },
            { once: true },
          );
        });
      },
      resume: async () => lease,
      upload: async () => undefined,
    };
    const stored = recordStoreDatabase();
    const database: DynamoDatabaseService = {
      ...stored,
      transactWrite: async (operations) => {
        const renewal = operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "runtime-lease" &&
            operation.previousRecord?.itemType === "runtime-lease" &&
            operation.record.data.renewedAt !== undefined,
        );
        if (rejectRenewals && renewal) {
          throw new DatabaseError({
            cause: new Error("injected runtime lease renewal failure"),
            message: "Runtime lease renewal failed.",
            operation: "transact-write",
            table: "execution",
          });
        }
        await stored.transactWrite(operations);
      },
    };
    const manager = makeSandboxManager(provider, database, makeIdGenerator(), {
      operationLeaseMs: 3_000,
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
    rejectRenewals = true;

    expect(Effect.runPromise(manager.exec({ command: ["sleep"], sandbox }))).rejects.toMatchObject({
      _tag: "SandboxOperationError",
      operation: "exec-lease",
    });
    expect(observedSignal?.aborted).toBe(true);
    const operationLeaseKey = withCanonicalRecordKeys({
      data: {
        id: sandbox.record.data.id,
        leaseKey: `sandbox-provider-operation/${sandbox.record.data.id}`,
      },
      itemType: "runtime-lease" as const,
    });
    const retained = await database.getRecord(
      "execution",
      { pk: operationLeaseKey.pk, sk: operationLeaseKey.sk },
      true,
    );
    expect(retained !== undefined).toBe(true);
    if (retained !== undefined) {
      expect(retained).toMatchObject({
        data: {
          environmentId: ENVIRONMENT_ID,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
        },
        itemType: "runtime-lease",
      });
      expect(retained.data).not.toHaveProperty("runId");
    }
  });

  test("aborts the provider call before releasing an interrupted operation lease", async () => {
    let observedSignal: AbortSignal | undefined;
    let markExecStarted: (() => void) | undefined;
    let markExecAborted: (() => void) | undefined;
    const execStarted = new Promise<void>((resolve) => {
      markExecStarted = resolve;
    });
    const execAborted = new Promise<void>((resolve) => {
      markExecAborted = resolve;
    });
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_interrupted_operation",
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
        observedSignal = input.signal;
        input.onMutationDispatch?.();
        markExecStarted?.();
        return await new Promise((_resolve, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              markExecAborted?.();
              reject(input.signal?.reason);
            },
            { once: true },
          );
        });
      },
      resume: async () => lease,
      upload: async () => undefined,
    };
    const database = recordStoreDatabase();
    const manager = makeSandboxManager(provider, database, makeIdGenerator());
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
    const fiber = Effect.runFork(manager.exec({ command: ["sleep"], sandbox }));
    await execStarted;

    await Effect.runPromise(Fiber.interrupt(fiber));
    await execAborted;

    expect(observedSignal?.aborted).toBe(true);
    const operationLeaseKey = withCanonicalRecordKeys({
      data: {
        id: sandbox.record.data.id,
        leaseKey: `sandbox-provider-operation/${sandbox.record.data.id}`,
      },
      itemType: "runtime-lease" as const,
    });
    const retained = await database.getRecord(
      "execution",
      { pk: operationLeaseKey.pk, sk: operationLeaseKey.sk },
      true,
    );
    expect(retained !== undefined).toBe(true);
  });

  test("combines a caller abort signal with the managed operation signal", async () => {
    let observedSignal: AbortSignal | undefined;
    let markExecStarted: (() => void) | undefined;
    const execStarted = new Promise<void>((resolve) => {
      markExecStarted = resolve;
    });
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_caller_abort",
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
        observedSignal = input.signal;
        markExecStarted?.();
        return await new Promise((_resolve, reject) =>
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason), {
            once: true,
          }),
        );
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
    const execution = Effect.runPromise(
      manager.exec({ command: ["sleep"], sandbox, signal: controller.signal }),
    );
    await execStarted;
    controller.abort(new Error("caller canceled"));

    expect(execution).rejects.toMatchObject({
      _tag: "SandboxOperationError",
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  test("holds the sandbox operation lease until a download stream is canceled", async () => {
    let checkpointCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_stream_operation_lease",
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
          checkpointRef: "lambda-microvm://microvm_stream_operation_lease/suspended",
          createdAt: Date.now(),
          provider: "aws_lambda_microvm",
        };
      },
      create: async () => lease,
      destroy: async () => undefined,
      download: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
        }),
      exec: async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
      resume: async () => lease,
      upload: async () => undefined,
    };
    const database = recordStoreDatabase();
    const manager = makeSandboxManager(provider, database, makeIdGenerator());
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

    const stream = await Effect.runPromise(manager.download({ path: "/artifact", sandbox }));
    const checkpoint = Effect.runPromise(manager.checkpoint(sandbox));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(checkpointCalls).toBe(0);

    await stream.cancel();
    await checkpoint;
    expect(checkpointCalls).toBe(1);
  });

  test("releases the sandbox operation lease when download acquisition is canceled", async () => {
    let markDownloadStarted: (() => void) | undefined;
    const downloadStarted = new Promise<void>((resolve) => {
      markDownloadStarted = resolve;
    });
    let execCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_canceled_download_acquisition",
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
      download: async (input) => {
        markDownloadStarted?.();
        return await new Promise((_resolve, reject) =>
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason), {
            once: true,
          }),
        );
      },
      exec: async () => {
        execCalls += 1;
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
    const download = Effect.runPromise(
      manager.download({
        path: "/artifact",
        sandbox,
        signal: controller.signal,
      }),
    );
    await downloadStarted;
    controller.abort(new Error("caller canceled download"));

    expect(download).rejects.toMatchObject({
      _tag: "SandboxOperationError",
    });
    expect(Effect.runPromise(manager.exec({ command: ["pwd"], sandbox }))).resolves.toMatchObject({
      exitCode: 0,
    });
    expect(execCalls).toBe(1);
  });

  test("releases the sandbox operation lease when an acquired download signal is aborted", async () => {
    let checkpointCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_acquired_download_abort",
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
          checkpointRef: "lambda-microvm://microvm_acquired_download_abort/suspended",
          createdAt: Date.now(),
          provider: "aws_lambda_microvm",
        };
      },
      create: async () => lease,
      destroy: async () => undefined,
      download: async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
        }),
      exec: async () => ({
        durationMs: 1,
        exitCode: 0,
        stderr: "",
        stdout: "",
      }),
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
    await Effect.runPromise(
      manager.download({
        path: "/artifact",
        sandbox,
        signal: controller.signal,
      }),
    );
    const checkpoint = Effect.runPromise(manager.checkpoint(sandbox));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(checkpointCalls).toBe(0);

    controller.abort(new Error("caller canceled acquired download"));
    await checkpoint;
    expect(checkpointCalls).toBe(1);
  });
});
