import {
  AgentDeploymentRecord,
  MessageRecord,
  RunLocatorRecord,
  RunRecord,
  ThreadRecord,
  TraceRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { runMutationThreadEvents } from "./runtime-handler.ts";
import { replayRun, retryRun } from "./runtime-operations.ts";
import type { RuntimeApiDependencies, RuntimeApiPrincipal } from "./runtime-support.ts";

const ids = Array.from(
  { length: 32 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5${String(index).padStart(3, "0")}`,
) as Ulid[];
const [organizationId, projectId, environmentId, serviceAccountId, deploymentId] = ids as [
  Ulid,
  Ulid,
  Ulid,
  Ulid,
  Ulid,
];
const now = new Date("2026-07-25T12:00:00.000Z");

function memoryDatabase(seed: readonly PlatformRecord[] = []) {
  const records = new Map<string, PlatformRecord>();
  const queries: Parameters<DynamoDatabaseService["queryRecords"]>[1][] = [];
  const transactions: Array<readonly TransactionOperation[]> = [];
  const recordKey = (record: Pick<PlatformRecord, "pk" | "sk">) => `${record.pk}\n${record.sk}`;
  for (const record of seed) records.set(recordKey(record), record);
  const runs = seed.filter(
    (record): record is Extract<PlatformRecord, { readonly itemType: "run" }> =>
      record.itemType === "run",
  );
  for (const run of runs) {
    const trace = traceRecord(
      run,
      runs.filter((candidate) => candidate.data.traceId === run.data.traceId),
    );
    if (!records.has(recordKey(trace))) records.set(recordKey(trace), trace);
  }
  const database = {
    getRecord: (
      _table: Parameters<DynamoDatabaseService["getRecord"]>[0],
      requested: Parameters<DynamoDatabaseService["getRecord"]>[1],
    ) => {
      const record = records.get(`${requested.pk}\n${requested.sk}`);
      return Promise.resolve(record);
    },
    queryRecords: (
      _table: Parameters<DynamoDatabaseService["queryRecords"]>[0],
      input: Parameters<DynamoDatabaseService["queryRecords"]>[1],
    ) => {
      queries.push(input);
      const values = input.ExpressionAttributeValues ?? {};
      const partition = values[":pk"];
      const prefix = values[":prefix"];
      const items = [...records.values()].filter((record) => {
        const recordPartition = input.IndexName === "gsi2" ? record.gsi2pk : record.pk;
        const recordSort = input.IndexName === "gsi2" ? record.gsi2sk : record.sk;
        return (
          recordPartition === partition &&
          (typeof prefix !== "string" || recordSort?.startsWith(prefix))
        );
      });
      return Promise.resolve({ items });
    },
    transactWrite: (operations: Parameters<DynamoDatabaseService["transactWrite"]>[0]) => {
      transactions.push(operations);
      for (const operation of operations) {
        if (
          operation.kind === "put" &&
          operation.conditionExpression?.includes("attribute_not_exists") &&
          records.has(recordKey(operation.record))
        ) {
          const conflict = new Error("conditional write failed");
          conflict.name = "ConditionalCheckFailedException";
          return Promise.reject(conflict as never);
        }
      }
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const table = tableForItemType(operation.record.itemType);
        if (!["control", "events", "execution"].includes(table)) continue;
        if (operation.kind === "delete") records.delete(recordKey(operation.record));
        else records.set(recordKey(operation.record), operation.record);
      }
      return Promise.resolve(undefined);
    },
  } as unknown as DynamoDatabaseService;
  return { database, queries, records, transactions };
}

function principal(): RuntimeApiPrincipal {
  return {
    credential: { data: { id: ids[31]!, scopes: ["platform:*"] } },
    scope: { environmentId, organizationId, projectId },
    serviceAccount: {
      data: { id: serviceAccountId, scopes: ["platform:*"] },
    },
  } as unknown as RuntimeApiPrincipal;
}

function deployment() {
  return Schema.decodeUnknownSync(AgentDeploymentRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDefinitionId: ids[5]!,
        agentReleaseId: ids[6]!,
        createdAt: now.toISOString(),
        currentState: "ready" as const,
        desiredState: "running" as const,
        environmentId,
        id: deploymentId,
        organizationId,
        projectId,
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "agent-deployment" as const,
    }),
  );
}

function release() {
  return withCanonicalRecordKeys({
    data: {
      agentDefinitionId: ids[5]!,
      contentHash: "test-content-hash",
      createdAt: now.toISOString(),
      createdByPrincipalId: serviceAccountId,
      environmentId,
      id: ids[6]!,
      manifest: { spec: {} },
      organizationId,
      projectId,
      releaseNumber: 1,
      status: "active" as const,
      version: 0,
    },
    itemType: "agent-release" as const,
  }) as Extract<PlatformRecord, { readonly itemType: "agent-release" }>;
}

function runRecord(
  status: "completed" | "failed" | "queued" | "running",
  runId = ids[7]!,
  idempotencyKey = `run-${status}`,
) {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: deploymentId,
        agentReleaseId: ids[6]!,
        attempt: status === "failed" ? 3 : 0,
        captureMode: "metadata-only" as const,
        createdAt: now.toISOString(),
        ...(status === "completed" || status === "failed"
          ? { completedAt: now.toISOString() }
          : {}),
        environmentId,
        executor: "hosted",
        id: runId,
        idempotencyKey,
        organizationId,
        priority: 50,
        projectId,
        redactionPolicyVersion: 1 as const,
        schemaVersion: 1 as const,
        spanId: "0123456789abcdef",
        status,
        threadId: ids[8]!,
        trigger: "api",
        traceId: "0123456789abcdef0123456789abcdef",
        updatedAt: now.toISOString(),
        userMessageId: ids[14]!,
        userMessageSequence: 0,
        version: 1,
      },
      itemType: "run" as const,
    }),
  );
}

function traceRecord(
  run: ReturnType<typeof runRecord>,
  runs: readonly ReturnType<typeof runRecord>[],
) {
  const finalized = runs.every((candidate) =>
    ["canceled", "completed", "failed"].includes(candidate.data.status),
  );
  return Schema.decodeUnknownSync(TraceRecord)(
    withCanonicalRecordKeys({
      data: {
        captureMode: run.data.captureMode,
        ...(finalized ? { completedAt: now.toISOString(), finalizedAt: now.toISOString() } : {}),
        createdAt: run.data.createdAt,
        environmentId,
        ...(finalized ? { graphWatermark: "fixture-watermark" } : {}),
        id: run.data.traceId,
        organizationId,
        projectId,
        redactionPolicyVersion: 1 as const,
        rootRunId: run.data.id,
        rootSpanId: run.data.spanId,
        runIds: runs.map((candidate) => candidate.data.id),
        schemaVersion: 1 as const,
        sessionId: run.data.threadId,
        status: finalized ? ("finalized" as const) : ("open" as const),
        ...(finalized ? { totalCostUsdMicros: 0, totalTokens: 0 } : {}),
        traceId: run.data.traceId,
        updatedAt: now.toISOString(),
        version: 1,
      },
      itemType: "trace" as const,
    }),
  );
}

function runLocator(run: ReturnType<typeof runRecord>) {
  return Schema.decodeUnknownSync(RunLocatorRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: run.data.createdAt,
        environmentId,
        id: run.data.id,
        organizationId,
        projectId,
        runPk: run.pk,
        runSk: run.sk,
      },
      itemType: "run-locator" as const,
    }),
  );
}

function threadRecord(run: ReturnType<typeof runRecord>) {
  return Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: run.data.agentDeploymentId,
        archived: false,
        channel: "api",
        createdAt: now.toISOString(),
        createdBy: {
          id: serviceAccountId,
          type: "service-account" as const,
        },
        environmentId,
        id: run.data.threadId,
        organizationId,
        pinned: false,
        projectId,
        streamId: ids[18]!,
        title: "Replay source",
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "thread" as const,
    }),
  );
}

function promptMessage(run: ReturnType<typeof runRecord>) {
  return Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: run.data.agentDeploymentId,
        body: "Replay this prompt",
        contentHash: "source-content-hash",
        createdAt: now.toISOString(),
        environmentId,
        id: run.data.userMessageId!,
        organizationId,
        projectId,
        role: "user" as const,
        runId: run.data.id,
        sequence: run.data.userMessageSequence!,
        threadId: run.data.threadId,
      },
      itemType: "message" as const,
    }),
  );
}

describe("runtime discovery and lifecycle operations", () => {
  test("rejects retry and replay when current execution pins are unavailable", async () => {
    const failed = runRecord("failed");
    const activeThread = threadRecord(failed);
    const archivedThread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        ...activeThread,
        data: {
          ...activeThread.data,
          archived: true,
          version: activeThread.data.version + 1,
        },
      }),
    );
    const retryMemory = memoryDatabase([
      failed,
      runLocator(failed),
      archivedThread,
      deployment(),
      release(),
    ]);
    expect(
      retryRun(
        {
          database: retryMemory.database,
          generateId: async () => ids[20]!,
        } as unknown as RuntimeApiDependencies,
        principal(),
        failed.data.id,
      ),
    ).rejects.toMatchObject({ code: "run_not_executable", status: 409 });

    const completed = runRecord("completed", ids[10]!, "run-completed");
    const stoppedDeployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
      withCanonicalRecordKeys({
        ...deployment(),
        data: {
          ...deployment().data,
          currentState: "stopped" as const,
          desiredState: "stopped" as const,
          version: 1,
        },
      }),
    );
    const replayMemory = memoryDatabase([
      completed,
      runLocator(completed),
      threadRecord(completed),
      promptMessage(completed),
      stoppedDeployment,
      release(),
    ]);
    expect(
      replayRun(
        {
          database: replayMemory.database,
          generateId: async () => ids[20]!,
        } as unknown as RuntimeApiDependencies,
        principal(),
        completed.data.id,
        "replay-with-stopped-deployment",
      ),
    ).rejects.toMatchObject({ code: "run_not_executable", status: 409 });
  });

  test("reconciles a concurrent retry transaction winner", async () => {
    const failed = runRecord("failed");
    const memory = memoryDatabase([
      failed,
      runLocator(failed),
      threadRecord(failed),
      deployment(),
      release(),
    ]);
    let transactionAttempts = 0;
    const database = {
      ...memory.database,
      transactWrite: async (operations: readonly TransactionOperation[]) => {
        transactionAttempts += 1;
        await memory.database.transactWrite(operations);
        throw { name: "TransactionConflictException" };
      },
    } as DynamoDatabaseService;
    const generated = ids.slice(20, 23);

    const result = await retryRun(
      {
        database,
        generateId: async () => generated.shift()!,
        now: () => now,
      } as unknown as RuntimeApiDependencies,
      principal(),
      failed.data.id,
    );

    expect(result.run).toMatchObject({ id: failed.data.id, status: "queued" });
    expect(result.publication).toBeDefined();
    expect(result.snapshot.data.version).toBe(failed.data.version + 1);
    expect(result.snapshot.data.queuedAt).toBe("2026-07-25T12:00:00.000Z");
    expect(transactionAttempts).toBe(1);
  });

  test("retries when trace finalization is the only concurrent change", async () => {
    const failed = runRecord("failed");
    const childBase = runRecord("running", ids[30]!, "running-child");
    const child = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...childBase,
        data: { ...childBase.data, threadId: ids[29]! },
      }),
    );
    const memory = memoryDatabase([
      failed,
      child,
      runLocator(failed),
      threadRecord(failed),
      deployment(),
      release(),
    ]);
    let transactionAttempts = 0;
    const database = {
      ...memory.database,
      transactWrite: (operations: readonly TransactionOperation[]) => {
        transactionAttempts += 1;
        if (transactionAttempts > 1) return memory.database.transactWrite(operations);
        const trace = [...memory.records.values()].find(
          (record): record is Extract<PlatformRecord, { readonly itemType: "trace" }> =>
            record.itemType === "trace" && record.data.traceId === failed.data.traceId,
        );
        if (!trace) throw new Error("Expected the retry trace fixture.");
        const finalized = Schema.decodeUnknownSync(TraceRecord)(
          withCanonicalRecordKeys({
            ...trace,
            data: {
              ...trace.data,
              completedAt: now.toISOString(),
              finalizedAt: now.toISOString(),
              graphWatermark: "concurrent-finalization",
              status: "finalized" as const,
              totalCostUsdMicros: 0,
              totalTokens: 0,
              version: trace.data.version + 1,
            },
          }),
        );
        memory.records.set(`${finalized.pk}\n${finalized.sk}`, finalized);
        return Promise.reject({ name: "TransactionConflictException" } as never);
      },
    } as DynamoDatabaseService;
    const generated = ids.slice(20, 26);

    const result = await retryRun(
      {
        database,
        generateId: async () => generated.shift()!,
        now: () => now,
      } as unknown as RuntimeApiDependencies,
      principal(),
      failed.data.id,
    );

    expect(result.run).toMatchObject({ id: failed.data.id, status: "queued" });
    expect(transactionAttempts).toBe(2);
  });

  test("rejects replay before commit when the prompt body is externally stored", async () => {
    const completed = runRecord("completed", ids[10]!, "external-prompt");
    const inlineMessage = promptMessage(completed);
    const { body: _body, ...messageData } = inlineMessage.data;
    const externalMessage = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        ...inlineMessage,
        data: {
          ...messageData,
          bodyRef: {
            bucket: "artifact-bucket",
            byteSize: 20,
            contentType: "text/plain; charset=utf-8",
            key: "message-bodies/source",
            sha256: "a".repeat(64),
            versionId: "source-version",
          },
        },
      }),
    );
    const memory = memoryDatabase([
      completed,
      runLocator(completed),
      threadRecord(completed),
      externalMessage,
      deployment(),
      release(),
    ]);

    expect(
      replayRun(
        {
          database: memory.database,
          generateId: async () => ids[20]!,
          now: () => now,
        } as unknown as RuntimeApiDependencies,
        principal(),
        completed.data.id,
        "external-prompt-replay",
      ),
    ).rejects.toMatchObject({ code: "run_not_replayable", status: 409 });
    expect(memory.transactions).toHaveLength(0);
  });

  test("reconciles a replay idempotency key after the source run is retried", async () => {
    const source = runRecord("failed");
    const memory = memoryDatabase([
      source,
      runLocator(source),
      threadRecord(source),
      promptMessage(source),
      deployment(),
      release(),
    ]);
    const generated = ids.slice(20, 28);
    const dependencies = {
      database: memory.database,
      generateId: async () => generated.shift()!,
      now: () => now,
    } as unknown as RuntimeApiDependencies;

    const replayed = await replayRun(
      dependencies,
      principal(),
      source.data.id,
      "stable-replay-key",
    );
    expect(replayed.snapshot.data.initiatingCaller).toEqual({
      apiCredentialId: ids[31]!,
      serviceAccountId,
      type: "service-account",
    });
    expect(replayed.snapshot.data.queuedAt).toBe("2026-07-25T12:00:00.000Z");
    await retryRun(dependencies, principal(), source.data.id);
    const reconciled = await replayRun(
      dependencies,
      principal(),
      source.data.id,
      "stable-replay-key",
    );

    expect(reconciled).toEqual(replayed);
  });

  test("recovers immutable retry and replay snapshots after workers advance the runs", async () => {
    const failed = runRecord("failed");
    const completed = runRecord("completed", ids[10]!, "completed-for-publication-race");
    const memory = memoryDatabase([
      failed,
      runLocator(failed),
      completed,
      runLocator(completed),
      threadRecord(completed),
      promptMessage(completed),
      deployment(),
      release(),
    ]);
    const generated = ids.slice(20, 29);
    const dependencies = {
      database: memory.database,
      generateId: async () => generated.shift()!,
      now: () => now,
    } as unknown as RuntimeApiDependencies;

    const retried = await retryRun(dependencies, principal(), failed.data.id);
    const runningRetry = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...retried.snapshot,
        data: {
          ...retried.snapshot.data,
          claimedAt: new Date(now.getTime() + 1_000).toISOString(),
          claimedBy: "worker-1",
          status: "running" as const,
          updatedAt: new Date(now.getTime() + 1_000).toISOString(),
          version: retried.snapshot.data.version + 1,
        },
      }),
    );
    memory.records.set(`${runningRetry.pk}\n${runningRetry.sk}`, runningRetry);
    const recoveredRetry = await retryRun(dependencies, principal(), failed.data.id);

    expect(recoveredRetry).toEqual(retried);
    expect(recoveredRetry.snapshot.data.status).toBe("queued");

    const replayed = await replayRun(
      dependencies,
      principal(),
      completed.data.id,
      "publication-race-replay",
    );
    const runningReplay = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...replayed.snapshot,
        data: {
          ...replayed.snapshot.data,
          claimedAt: new Date(now.getTime() + 2_000).toISOString(),
          claimedBy: "worker-2",
          status: "running" as const,
          updatedAt: new Date(now.getTime() + 2_000).toISOString(),
          version: replayed.snapshot.data.version + 1,
        },
      }),
    );
    memory.records.set(`${runningReplay.pk}\n${runningReplay.sk}`, runningReplay);
    const recoveredReplay = await replayRun(
      dependencies,
      principal(),
      completed.data.id,
      "publication-race-replay",
    );

    expect(recoveredReplay).toEqual(replayed);
    expect(runMutationThreadEvents("replay", principal(), recoveredReplay.snapshot)).toEqual(
      runMutationThreadEvents("replay", principal(), replayed.snapshot),
    );
  });

  test("reconciles the one durable retry after that retry also fails", async () => {
    const failed = runRecord("failed");
    const memory = memoryDatabase([
      failed,
      runLocator(failed),
      threadRecord(failed),
      deployment(),
      release(),
    ]);
    const generated = ids.slice(20, 23);
    const dependencies = {
      database: memory.database,
      generateId: async () => generated.shift()!,
      now: () => now,
    } as unknown as RuntimeApiDependencies;

    const retried = await retryRun(dependencies, principal(), failed.data.id);
    const retriedFailure = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...retried.snapshot,
        data: {
          ...retried.snapshot.data,
          attempt: 1,
          completedAt: new Date(now.getTime() + 1_000).toISOString(),
          error: { code: "model_unavailable", message: "The model request failed." },
          status: "failed" as const,
          updatedAt: new Date(now.getTime() + 1_000).toISOString(),
          version: retried.snapshot.data.version + 1,
        },
      }),
    );
    memory.records.set(`${retriedFailure.pk}\n${retriedFailure.sk}`, retriedFailure);

    expect(retryRun(dependencies, principal(), failed.data.id)).resolves.toEqual(retried);
  });

  test("rejects historical retry recovery after the retried run terminalizes", async () => {
    for (const status of ["canceled", "completed"] as const) {
      const failed = runRecord("failed");
      const memory = memoryDatabase([
        failed,
        runLocator(failed),
        threadRecord(failed),
        deployment(),
        release(),
      ]);
      const generated = ids.slice(20, 23);
      const dependencies = {
        database: memory.database,
        generateId: async () => generated.shift()!,
        now: () => now,
      } as unknown as RuntimeApiDependencies;

      const retried = await retryRun(dependencies, principal(), failed.data.id);
      const terminal = Schema.decodeUnknownSync(RunRecord)(
        withCanonicalRecordKeys({
          ...retried.snapshot,
          data: {
            ...retried.snapshot.data,
            completedAt: new Date(now.getTime() + 1_000).toISOString(),
            status,
            updatedAt: new Date(now.getTime() + 1_000).toISOString(),
            version: retried.snapshot.data.version + 1,
          },
        }),
      );
      memory.records.set(`${terminal.pk}\n${terminal.sk}`, terminal);

      expect(retryRun(dependencies, principal(), failed.data.id)).rejects.toMatchObject({
        code: "run_not_retryable",
        status: 409,
      });
    }
  });
});
