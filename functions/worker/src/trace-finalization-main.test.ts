import { marshall } from "@aws-sdk/util-dynamodb";
import {
  MemoryFlushRecord,
  RunLocatorRecord,
  RunRecord,
  TraceRecord,
  ProviderMutationClaimRecord,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { describe, expect, spyOn, test } from "bun:test";
import { Schema } from "effect";
import { fixtures, id, inMemoryDatabase } from "./agent-run.fixture.ts";
import { runtimeUsageRecord } from "./records.ts";
import type { EvaluationQueueMessage } from "@deployments-ai/observability/evaluators";
import {
  handler,
  setTraceFinalizationDatabaseForTest,
  setTraceFinalizationEvaluationQueueForTest,
} from "./trace-finalization-main.ts";

describe("trace finalization stream consumer", () => {
  test("durably retries terminal run finalization from the execution stream", async () => {
    const source = fixtures().run;
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...source,
        data: {
          ...source.data,
          completedAt: "2026-07-22T00:00:02.000Z",
          status: "completed" as const,
          updatedAt: "2026-07-22T00:00:02.000Z",
          version: 2,
        },
      }),
    );
    const trace = Schema.decodeUnknownSync(TraceRecord)(
      withCanonicalRecordKeys({
        data: {
          captureMode: "metadata-only" as const,
          createdAt: run.data.createdAt,
          environmentId: run.data.environmentId,
          id: run.data.traceId,
          organizationId: run.data.organizationId,
          projectId: run.data.projectId,
          redactionPolicyVersion: 1 as const,
          rootRunId: run.data.id,
          rootSpanId: run.data.spanId,
          runIds: [run.data.id],
          schemaVersion: 1 as const,
          sessionId: run.data.threadId,
          status: "open" as const,
          traceId: run.data.traceId,
          updatedAt: run.data.updatedAt,
          version: 0,
          workspaceId: run.data.workspaceId,
        },
        itemType: "trace" as const,
      }),
    );
    const locator = Schema.decodeUnknownSync(RunLocatorRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: run.data.createdAt,
          environmentId: run.data.environmentId,
          id: run.data.id,
          organizationId: run.data.organizationId,
          projectId: run.data.projectId,
          runPk: run.pk,
          runSk: run.sk,
        },
        itemType: "run-locator" as const,
      }),
    );
    const memory = inMemoryDatabase([run, trace, locator]);
    setTraceFinalizationDatabaseForTest(memory.database);

    const result = await handler({
      Records: [
        {
          dynamodb: {
            NewImage: marshall(run, { removeUndefinedValues: true }),
            SequenceNumber: "101",
          },
          eventName: "MODIFY",
        },
      ],
    });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "trace" && record.data.traceId === run.data.traceId,
      )?.data,
    ).toMatchObject({ status: "finalized", version: 2 });
  });

  test("wakes finalization when a provider mutation claim settles", async () => {
    const source = fixtures().run;
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...source,
        data: {
          ...source.data,
          completedAt: "2026-07-22T00:00:02.000Z",
          status: "completed" as const,
          updatedAt: "2026-07-22T00:00:02.000Z",
          version: 2,
        },
      }),
    );
    const trace = Schema.decodeUnknownSync(TraceRecord)(
      withCanonicalRecordKeys({
        data: {
          captureMode: run.data.captureMode,
          createdAt: run.data.createdAt,
          environmentId: run.data.environmentId,
          id: run.data.traceId,
          organizationId: run.data.organizationId,
          projectId: run.data.projectId,
          redactionPolicyVersion: 1 as const,
          rootRunId: run.data.id,
          rootSpanId: run.data.spanId,
          runIds: [run.data.id],
          schemaVersion: 1 as const,
          sessionId: run.data.threadId,
          status: "open" as const,
          traceId: run.data.traceId,
          updatedAt: run.data.updatedAt,
          version: 0,
          workspaceId: run.data.workspaceId,
        },
        itemType: "trace" as const,
      }),
    );
    const locator = Schema.decodeUnknownSync(RunLocatorRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: run.data.createdAt,
          environmentId: run.data.environmentId,
          id: run.data.id,
          organizationId: run.data.organizationId,
          projectId: run.data.projectId,
          runPk: run.pk,
          runSk: run.sk,
        },
        itemType: "run-locator" as const,
      }),
    );
    const claim = Schema.decodeUnknownSync(ProviderMutationClaimRecord)(
      withCanonicalRecordKeys({
        data: {
          claimAttemptId: "attempt-1",
          connectionId: source.data.agentDeploymentId,
          createdAt: run.data.createdAt,
          environmentId: run.data.environmentId,
          id: source.data.agentDeploymentId,
          idempotencyKey: "provider-claim-1",
          immutableIdentityHash: "sha256:provider-claim-1",
          operation: "provider.write",
          organizationId: run.data.organizationId,
          projectId: run.data.projectId,
          runId: run.data.id,
          status: "succeeded" as const,
          threadId: run.data.threadId,
          toolCallId: source.data.agentDeploymentId,
          updatedAt: run.data.updatedAt,
          version: 1,
        },
        itemType: "provider-mutation-claim" as const,
      }),
    );
    const memory = inMemoryDatabase([run, trace, locator, claim]);
    setTraceFinalizationDatabaseForTest(memory.database);

    const result = await handler({
      Records: [
        {
          dynamodb: {
            NewImage: marshall(claim, { removeUndefinedValues: true }),
            SequenceNumber: "102",
          },
          eventName: "MODIFY",
        },
      ],
    });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "trace" && record.data.traceId === run.data.traceId,
      )?.data,
    ).toMatchObject({ status: "finalized", version: 2 });
  });

  test("ignores an open provider claim's removal after erasure deletes its run", async () => {
    const fixture = fixtures();
    const claim = Schema.decodeUnknownSync(ProviderMutationClaimRecord)(
      withCanonicalRecordKeys({
        data: {
          claimAttemptId: "attempt-1",
          connectionId: fixture.run.data.agentDeploymentId,
          createdAt: fixture.run.data.createdAt,
          environmentId: fixture.run.data.environmentId,
          id: fixture.run.data.agentDeploymentId,
          idempotencyKey: "provider-claim-retained-run",
          immutableIdentityHash: "sha256:provider-claim-retained-run",
          operation: "provider.write",
          organizationId: fixture.run.data.organizationId,
          projectId: fixture.run.data.projectId,
          runId: fixture.run.data.id,
          status: "active" as const,
          threadId: fixture.run.data.threadId,
          toolCallId: fixture.run.data.agentDeploymentId,
          updatedAt: fixture.run.data.updatedAt,
          version: 1,
        },
        itemType: "provider-mutation-claim" as const,
      }),
    );
    setTraceFinalizationDatabaseForTest(inMemoryDatabase([]).database);

    expect(
      handler({
        Records: [
          {
            dynamodb: {
              OldImage: marshall(claim, { removeUndefinedValues: true }),
              SequenceNumber: "103",
            },
            eventName: "REMOVE",
          },
        ],
      }),
    ).resolves.toEqual({ batchItemFailures: [] });
  });

  test("logs one line that names each failed record and its error", async () => {
    const fixture = fixtures();
    const claim = Schema.decodeUnknownSync(ProviderMutationClaimRecord)(
      withCanonicalRecordKeys({
        data: {
          claimAttemptId: "attempt-1",
          connectionId: fixture.run.data.agentDeploymentId,
          createdAt: fixture.run.data.createdAt,
          environmentId: fixture.run.data.environmentId,
          id: fixture.run.data.agentDeploymentId,
          idempotencyKey: "provider-claim-missing-run",
          immutableIdentityHash: "sha256:provider-claim-missing-run",
          operation: "provider.write",
          organizationId: fixture.run.data.organizationId,
          projectId: fixture.run.data.projectId,
          runId: fixture.run.data.id,
          status: "succeeded" as const,
          threadId: fixture.run.data.threadId,
          toolCallId: fixture.run.data.agentDeploymentId,
          updatedAt: fixture.run.data.updatedAt,
          version: 1,
        },
        itemType: "provider-mutation-claim" as const,
      }),
    );
    setTraceFinalizationDatabaseForTest(inMemoryDatabase([]).database);
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await handler({
        Records: [
          {
            dynamodb: {
              Keys: marshall({ pk: claim.pk, sk: claim.sk }),
              NewImage: marshall(claim, { removeUndefinedValues: true }),
              SequenceNumber: "104",
            },
            eventName: "MODIFY",
          },
        ],
      });

      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "104" }] });
      expect(stderr.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        {
          eventName: "MODIFY",
          failure: [
            {
              message: "Trace finalization repair could not resolve its canonical run locator.",
              type: "Error",
            },
          ],
          itemType: "provider-mutation-claim",
          message: "Trace finalization stream record failed.",
          pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G0001#RUN#01ARZ3NDEKTSV4RRFFQ69G0010",
          sequenceNumber: "104",
        },
      ]);
    } finally {
      stderr.mockRestore();
    }
  });

  test("reconciles finalized totals when trace-scoped model usage arrives", async () => {
    const source = fixtures().run;
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...source,
        data: {
          ...source.data,
          completedAt: "2026-07-22T00:00:02.000Z",
          status: "completed" as const,
          updatedAt: "2026-07-22T00:00:02.000Z",
          version: 2,
        },
      }),
    );
    const trace = Schema.decodeUnknownSync(TraceRecord)(
      withCanonicalRecordKeys({
        data: {
          captureMode: run.data.captureMode,
          createdAt: run.data.createdAt,
          environmentId: run.data.environmentId,
          id: run.data.traceId,
          organizationId: run.data.organizationId,
          projectId: run.data.projectId,
          redactionPolicyVersion: 1 as const,
          rootRunId: run.data.id,
          rootSpanId: run.data.spanId,
          runIds: [run.data.id],
          schemaVersion: 1 as const,
          sessionId: run.data.threadId,
          status: "open" as const,
          traceId: run.data.traceId,
          updatedAt: run.data.updatedAt,
          version: 0,
          workspaceId: run.data.workspaceId,
        },
        itemType: "trace" as const,
      }),
    );
    const locator = Schema.decodeUnknownSync(RunLocatorRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: run.data.createdAt,
          environmentId: run.data.environmentId,
          id: run.data.id,
          organizationId: run.data.organizationId,
          projectId: run.data.projectId,
          runPk: run.pk,
          runSk: run.sk,
        },
        itemType: "run-locator" as const,
      }),
    );
    const usage = runtimeUsageRecord({
      entry: {
        costUsdMicros: 23,
        idempotencyKey: `${run.data.id}:model_tokens:memory-flush:stream`,
        modelId: "openai/gpt-4o-mini",
        occurredAt: "2026-07-22T00:00:04.000Z",
        provider: "bifrost",
        quantity: 37,
        runId: run.data.id,
        source: "memory-flush",
        payer: { kind: "operator" as const },
        type: "model_tokens",
        unit: "tokens",
      },
      id: id(80),
      run,
    });
    const memory = inMemoryDatabase([run, trace, locator]);
    setTraceFinalizationDatabaseForTest(memory.database);

    await handler({
      Records: [
        {
          dynamodb: {
            NewImage: marshall(run, { removeUndefinedValues: true }),
            SequenceNumber: "104",
          },
          eventName: "MODIFY",
        },
      ],
    });
    await memory.database.putRecord(usage);
    const result = await handler({
      Records: [
        {
          dynamodb: {
            NewImage: marshall(usage, { removeUndefinedValues: true }),
            SequenceNumber: "105",
          },
          eventName: "INSERT",
        },
      ],
    });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "trace" && record.data.traceId === run.data.traceId,
      )?.data,
    ).toMatchObject({
      status: "finalized",
      totalCostUsdMicros: 23,
      totalTokens: 37,
      version: 3,
    });
  });

  test("reopens for a late memory flush and finalizes again when it settles", async () => {
    const source = fixtures().run;
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        ...source,
        data: {
          ...source.data,
          completedAt: "2026-07-22T00:00:02.000Z",
          status: "completed" as const,
          updatedAt: "2026-07-22T00:00:02.000Z",
          version: 2,
        },
      }),
    );
    const trace = Schema.decodeUnknownSync(TraceRecord)(
      withCanonicalRecordKeys({
        data: {
          captureMode: run.data.captureMode,
          createdAt: run.data.createdAt,
          environmentId: run.data.environmentId,
          id: run.data.traceId,
          organizationId: run.data.organizationId,
          projectId: run.data.projectId,
          redactionPolicyVersion: 1 as const,
          rootRunId: run.data.id,
          rootSpanId: run.data.spanId,
          runIds: [run.data.id],
          schemaVersion: 1 as const,
          sessionId: run.data.threadId,
          status: "open" as const,
          traceId: run.data.traceId,
          updatedAt: run.data.updatedAt,
          version: 0,
          workspaceId: run.data.workspaceId,
        },
        itemType: "trace" as const,
      }),
    );
    const locator = Schema.decodeUnknownSync(RunLocatorRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: run.data.createdAt,
          environmentId: run.data.environmentId,
          id: run.data.id,
          organizationId: run.data.organizationId,
          projectId: run.data.projectId,
          runPk: run.pk,
          runSk: run.sk,
        },
        itemType: "run-locator" as const,
      }),
    );
    const flush = Schema.decodeUnknownSync(MemoryFlushRecord)(
      withCanonicalRecordKeys({
        data: {
          attempt: 1,
          createdAt: "2026-07-22T00:00:01.000Z",
          environmentId: run.data.environmentId,
          id: id(81),
          idempotencyKey: `memory-flush:${run.data.id}`,
          memoryIds: [],
          observability: {
            captureMode: run.data.captureMode,
            runSpanId: run.data.spanId,
            sessionId: run.data.threadId,
            traceId: run.data.traceId,
          },
          organizationId: run.data.organizationId,
          projectId: run.data.projectId,
          runId: run.data.id,
          startedAt: "2026-07-22T00:00:01.000Z",
          status: "running" as const,
          threadId: run.data.threadId,
          updatedAt: "2026-07-22T00:00:01.000Z",
          version: 1,
        },
        itemType: "memory-flush" as const,
      }),
    );
    const memory = inMemoryDatabase([run, trace, locator]);
    setTraceFinalizationDatabaseForTest(memory.database);

    await handler({
      Records: [
        {
          dynamodb: {
            NewImage: marshall(run, { removeUndefinedValues: true }),
            SequenceNumber: "106",
          },
          eventName: "MODIFY",
        },
      ],
    });
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "trace" && record.data.traceId === run.data.traceId,
      )?.data,
    ).toMatchObject({ status: "finalized" });

    await memory.database.putRecord(flush);
    await handler({
      Records: [
        {
          dynamodb: {
            NewImage: marshall(flush, { removeUndefinedValues: true }),
            SequenceNumber: "107",
          },
          eventName: "INSERT",
        },
      ],
    });
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "trace" && record.data.traceId === run.data.traceId,
      )?.data,
    ).toMatchObject({ status: "open" });

    const settled = Schema.decodeUnknownSync(MemoryFlushRecord)(
      withCanonicalRecordKeys({
        ...flush,
        data: {
          ...flush.data,
          completedAt: "2026-07-22T00:00:04.000Z",
          status: "succeeded" as const,
          updatedAt: "2026-07-22T00:00:04.000Z",
          version: 2,
        },
      }),
    );
    await memory.database.putRecord(settled);
    const result = await handler({
      Records: [
        {
          dynamodb: {
            NewImage: marshall(settled, { removeUndefinedValues: true }),
            SequenceNumber: "108",
          },
          eventName: "MODIFY",
        },
      ],
    });

    expect(result).toEqual({ batchItemFailures: [] });
    expect(
      [...memory.records.values()].find(
        (record) => record.itemType === "trace" && record.data.traceId === run.data.traceId,
      )?.data,
    ).toMatchObject({ status: "finalized" });
  });
});

describe("automatic scoring trigger", () => {
  function traceImage(status: "finalized" | "open", version: number) {
    const run = fixtures().run;
    return Schema.decodeUnknownSync(TraceRecord)(
      withCanonicalRecordKeys({
        data: {
          captureMode: "metadata-only" as const,
          createdAt: run.data.createdAt,
          environmentId: run.data.environmentId,
          id: run.data.traceId,
          organizationId: run.data.organizationId,
          projectId: run.data.projectId,
          redactionPolicyVersion: 1 as const,
          rootRunId: run.data.id,
          rootSpanId: run.data.spanId,
          runIds: [run.data.id],
          schemaVersion: 1 as const,
          sessionId: run.data.threadId,
          status,
          traceId: run.data.traceId,
          updatedAt: run.data.updatedAt,
          version,
          workspaceId: run.data.workspaceId,
        },
        itemType: "trace" as const,
      }),
    );
  }

  async function deliver(queueUrl: string | undefined) {
    const sent: { queueUrl: string; message: EvaluationQueueMessage }[] = [];
    setTraceFinalizationEvaluationQueueForTest((url) => ({
      send: async (message) => {
        sent.push({ message, queueUrl: url });
      },
    }));
    const previous = process.env.DEPLOYMENTS_AI_EVALUATION_QUEUE_URL;
    if (queueUrl === undefined) delete process.env.DEPLOYMENTS_AI_EVALUATION_QUEUE_URL;
    else process.env.DEPLOYMENTS_AI_EVALUATION_QUEUE_URL = queueUrl;
    try {
      const open = traceImage("open", 1);
      const finalized = traceImage("finalized", 2);
      const result = await handler({
        Records: [
          {
            dynamodb: {
              NewImage: marshall(finalized, { removeUndefinedValues: true }),
              OldImage: marshall(open, { removeUndefinedValues: true }),
              SequenceNumber: "901",
            },
            eventName: "MODIFY",
          },
          // Rewriting an already-finalized trace does not re-trigger scoring.
          {
            dynamodb: {
              NewImage: marshall(traceImage("finalized", 3), { removeUndefinedValues: true }),
              OldImage: marshall(finalized, { removeUndefinedValues: true }),
              SequenceNumber: "902",
            },
            eventName: "MODIFY",
          },
        ],
      });
      return { finalized, result, sent };
    } finally {
      if (previous === undefined) delete process.env.DEPLOYMENTS_AI_EVALUATION_QUEUE_URL;
      else process.env.DEPLOYMENTS_AI_EVALUATION_QUEUE_URL = previous;
    }
  }

  test("sends exactly one trace.score message for a newly finalized trace", async () => {
    const { finalized, result, sent } = await deliver("https://sqs.example/evaluations.fifo");
    expect(result).toEqual({ batchItemFailures: [] });
    expect(sent).toEqual([
      {
        message: {
          environmentId: finalized.data.environmentId,
          organizationId: finalized.data.organizationId,
          projectId: finalized.data.projectId,
          traceId: finalized.data.traceId,
          type: "trace.score",
        },
        queueUrl: "https://sqs.example/evaluations.fifo",
      },
    ]);
  });

  test("sends nothing when the evaluation queue is not configured", async () => {
    const { result, sent } = await deliver(undefined);
    expect(result).toEqual({ batchItemFailures: [] });
    expect(sent).toEqual([]);
  });
});
