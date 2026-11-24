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
import { type SandboxLease, type SandboxProvider } from "./index.ts";
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

describe("managed sandbox identity ownership", () => {
  test("does not destroy an external sandbox identity claimed by another lease", async () => {
    const transactions: TransactionOperation[][] = [];
    let conflictingClaim: PlatformRecord | undefined;
    let destroyCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_shared",
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
      resume: async () => {
        throw new Error("not reached");
      },
      upload: async () => undefined,
    };
    const base = database(transactions);
    const conflictingDatabase: DynamoDatabaseService = {
      ...base,
      getRecord: async (table) =>
        table === "control" && conflictingClaim ? conflictingClaim : undefined,
      transactWrite: async (operations) => {
        transactions.push([...operations]);
        const event = records(operations).find((record) => record.itemType === "semantic-event");
        if (event?.itemType === "semantic-event" && event.data.eventType === "sandbox.allocated") {
          const claim = records(operations).find((record) => record.itemType === "unique-claim");
          if (claim?.itemType === "unique-claim") {
            conflictingClaim = {
              ...claim,
              data: { ...claim.data, ownerId: IDS[8] as Ulid },
            };
          }
          throw new DatabaseError({
            cause: new Error("provider identity already claimed"),
            message: "sandbox allocation transaction failed",
            operation: "transact-write",
            table: "control",
          });
        }
      },
    };
    const manager = makeSandboxManager(provider, conflictingDatabase, makeIdGenerator());

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
      message: "Sandbox provider returned an external identity owned by another lease.",
    });

    expect(destroyCalls).toBe(0);
    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      failureReason: "provider-sandbox-identity-conflict",
      status: "error",
    });
    expect(leaseRecord(transactions.at(-1) ?? []).data.externalSandboxId).toBeUndefined();
  });

  test("fails closed when external sandbox identity ownership cannot be read", async () => {
    const transactions: TransactionOperation[][] = [];
    let destroyCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_unknown_owner",
      isolationMode: "run-ephemeral",
      leaseExpiresAt: 2_000_000_000_000,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "aws_lambda_microvm",
      providerRouteKey: "lambda-route-unknown-owner",
      region: "us-east-2",
      reservedMemoryMiB: 4_096,
      reservedVcpu: 2,
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
      resume: async () => {
        throw new Error("not reached");
      },
      upload: async () => undefined,
    };
    const base = database(transactions);
    const unavailableDatabase: DynamoDatabaseService = {
      ...base,
      getRecord: async (table) => {
        if (table === "control") {
          throw new DatabaseError({
            cause: new Error("DynamoDB unavailable"),
            message: "claim lookup failed",
            operation: "get",
            table: "control",
          });
        }
        return undefined;
      },
      transactWrite: async (operations) => {
        transactions.push([...operations]);
        const event = records(operations).find((record) => record.itemType === "semantic-event");
        if (event?.itemType === "semantic-event" && event.data.eventType === "sandbox.allocated") {
          throw new DatabaseError({
            cause: new Error("allocation transaction failed"),
            message: "sandbox allocation transaction failed",
            operation: "transact-write",
            table: "control",
          });
        }
      },
    };
    const manager = makeSandboxManager(provider, unavailableDatabase, makeIdGenerator());

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
      operation: "allocation-identity-reconciliation",
    });

    expect(destroyCalls).toBe(0);
    const recoverable = leaseRecord(transactions.at(-1) ?? []);
    expect(recoverable.data).toMatchObject({
      computeUsageActive: true,
      failureReason: "provider-identity-ownership-unavailable",
      leaseExpiresAt: "2033-05-18T03:33:20.000Z",
      providerRouteKey: "lambda-route-unknown-owner",
      recoveryExternalSandboxId: "microvm_unknown_owner",
      region: "us-east-2",
      reservedMemoryMiB: 4_096,
      reservedVcpu: 2,
      status: "creating",
    });

    const recoveryTransactions: TransactionOperation[][] = [];
    const recoveryManager = makeSandboxManager(
      provider,
      databaseSeededWith(recoverable, recoveryTransactions),
      makeIdGenerator(),
    );
    expect(
      Effect.runPromise(recoveryManager.reconcileCreateWithCleanup(recoverable, lease)),
    ).resolves.toMatchObject({ data: { status: "destroyed" } });
    expect(destroyCalls).toBe(1);
  });

  test("resolves an ambiguous committed ready transition before compensating", async () => {
    const transactions: TransactionOperation[][] = [];
    let stored: PlatformRecord | undefined;
    let destroyCalls = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_ambiguous",
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
        const lease = records(operations).find((record) => record.itemType === "sandbox-lease");
        if (lease) stored = lease;
        const event = records(operations).find((record) => record.itemType === "semantic-event");
        if (event?.itemType === "semantic-event" && event.data.eventType === "sandbox.ready") {
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

    expect(sandbox.record.data.status).toBe("ready");
    expect(destroyCalls).toBe(0);
    expect(
      transactions
        .flatMap(records)
        .some((record) =>
          record.itemType === "semantic-event" ? record.data.eventType === "sandbox.failed" : false,
        ),
    ).toBe(false);
  });

  test("rejects resumed lease expirations outside the JavaScript Date range", async () => {
    const transactions: TransactionOperation[][] = [];
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_invalid_resume_expiry",
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
        checkpointRef: "lambda-microvm://microvm_invalid_resume_expiry/suspended",
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
        leaseExpiresAt: 1e100,
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
      message: "Sandbox provider returned an invalid resumed lease expiration.",
    });
    expect(leaseRecord(transactions.at(-1) ?? []).data).toMatchObject({
      failureReason: "provider-resume-identity-mismatch",
      status: "error",
    });
  });

  test("does not compensate when a committed ready transition cannot be reconciled", async () => {
    const transactions: TransactionOperation[][] = [];
    let destroyCalls = 0;
    let reconciliationReads = 0;
    const lease: SandboxLease = {
      executionTargetId: AGENT_DEPLOYMENT_ID,
      executionTargetKind: "agent-deployment",
      environmentId: ENVIRONMENT_ID,
      externalSandboxId: "microvm_unknown_commit",
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
    const reconciliationFailure = new DatabaseError({
      cause: new Error("read timeout"),
      message: "reconciliation read failed",
      operation: "get",
      table: "execution",
    });
    const db: DynamoDatabaseService = {
      deleteRecord: async () => {},
      getRecord: async () => {
        reconciliationReads += 1;
        throw reconciliationFailure;
      },
      putRecord: async () => {},
      queryRecords: async () => ({ items: [] }),
      transactWrite: async (operations) => {
        transactions.push([...operations]);
        const event = records(operations).find((record) => record.itemType === "semantic-event");
        if (event?.itemType === "semantic-event" && event.data.eventType === "sandbox.ready") {
          throw ambiguous;
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
      _tag: "SandboxPersistenceUnknownError",
      operation: "persistence-reconciliation",
    });

    expect(reconciliationReads).toBe(3);
    expect(destroyCalls).toBe(0);
  });
});
