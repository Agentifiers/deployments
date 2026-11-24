import { marshall } from "@aws-sdk/util-dynamodb";
import {
  DatabaseError,
  ProviderMutationClaimRecord,
  RunEdgeRecord,
  RunLocatorRecord,
  RunRecord,
  TraceRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { fixtures, id, inMemoryDatabase } from "./agent-run.fixture.ts";
import { handler, setTraceFinalizationDatabaseForTest } from "./trace-finalization-main.ts";
import { reconcileTraceFinalization } from "./trace-finalization.ts";

type Claim = typeof ProviderMutationClaimRecord.Type;
type Run = Extract<PlatformRecord, { readonly itemType: "run" }>;
type Trace = Extract<PlatformRecord, { readonly itemType: "trace" }>;

function completedRun(runId: Ulid): Run {
  const source = fixtures().run;
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      ...source,
      data: {
        ...source.data,
        completedAt: "2026-07-22T00:00:02.000Z",
        id: runId,
        idempotencyKey: `run/${runId}`,
        status: "completed" as const,
        updatedAt: "2026-07-22T00:00:02.000Z",
        version: 2,
      },
    }),
  );
}

function locator(run: Run) {
  return Schema.decodeUnknownSync(RunLocatorRecord)(
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
}

/** A completed root run that delegated to a completed child, with one provider claim of the root. */
function delegatedTrace(claimStatus: "active" | "succeeded") {
  const root = completedRun(fixtures().run.data.id);
  const child = completedRun(id(90));
  const trace = Schema.decodeUnknownSync(TraceRecord)(
    withCanonicalRecordKeys({
      data: {
        captureMode: "metadata-only" as const,
        createdAt: root.data.createdAt,
        environmentId: root.data.environmentId,
        id: root.data.traceId,
        organizationId: root.data.organizationId,
        projectId: root.data.projectId,
        redactionPolicyVersion: 1 as const,
        rootRunId: root.data.id,
        rootSpanId: root.data.spanId,
        runIds: [root.data.id, child.data.id],
        schemaVersion: 1 as const,
        sessionId: root.data.threadId,
        status: "open" as const,
        terminalRunIds: [root.data.id, child.data.id],
        traceId: root.data.traceId,
        updatedAt: root.data.updatedAt,
        version: 0,
        workspaceId: root.data.workspaceId,
      },
      itemType: "trace" as const,
    }),
  );
  const edge = Schema.decodeUnknownSync(RunEdgeRecord)(
    withCanonicalRecordKeys({
      data: {
        childRunId: child.data.id,
        childThreadId: child.data.threadId,
        createdAt: root.data.createdAt,
        environmentId: root.data.environmentId,
        fromAgentDeploymentId: root.data.agentDeploymentId,
        id: id(91),
        kind: "child-agent" as const,
        organizationId: root.data.organizationId,
        parentRunId: root.data.id,
        parentSpanId: root.data.spanId,
        projectId: root.data.projectId,
        threadId: root.data.threadId,
        toAgentDeploymentId: child.data.agentDeploymentId,
        traceId: root.data.traceId,
      },
      itemType: "run-edge" as const,
    }),
  );
  const claim = Schema.decodeUnknownSync(ProviderMutationClaimRecord)(
    withCanonicalRecordKeys({
      data: {
        claimAttemptId: "attempt-1",
        connectionId: id(70),
        createdAt: "2026-07-22T00:00:01.000Z",
        environmentId: root.data.environmentId,
        id: id(71),
        idempotencyKey: "provider-claim-delegated-trace",
        immutableIdentityHash: "sha256:provider-claim-delegated-trace",
        operation: "provider.write",
        organizationId: root.data.organizationId,
        projectId: root.data.projectId,
        runId: root.data.id,
        status: claimStatus,
        threadId: root.data.threadId,
        toolCallId: id(72),
        updatedAt: "2026-07-22T00:00:01.000Z",
        version: 1,
      },
      itemType: "provider-mutation-claim" as const,
    }),
  );
  const memory = inMemoryDatabase([root, child, trace, edge, claim, locator(root), locator(child)]);
  return { claim, edge, memory, root };
}

function claimRemoval(claim: Claim, sequenceNumber: string) {
  return {
    Records: [
      {
        dynamodb: {
          Keys: marshall({ pk: claim.pk, sk: claim.sk }),
          OldImage: marshall(claim, { removeUndefinedValues: true }),
          SequenceNumber: sequenceNumber,
        },
        eventName: "REMOVE",
      },
    ],
  };
}

function storedTrace(records: Iterable<PlatformRecord>) {
  return [...records].find((record): record is Trace => record.itemType === "trace");
}

/** While retention holds the organization's erasure fence, DynamoDB cancels every other tenant write. */
function fencedWrites(database: DynamoDatabaseService): DynamoDatabaseService {
  return {
    ...database,
    transactWrite: async () => {
      throw new DatabaseError({
        cause: Object.assign(new Error("Transaction cancelled."), {
          CancellationReasons: ["None", "None", "None", "ConditionalCheckFailed", "None"].map(
            (Code) => ({ Code }),
          ),
          name: "TransactionCanceledException",
        }),
        message: "DynamoDB transact-write failed for table multiple.",
        operation: "transact-write",
        table: "multiple",
      });
    },
  };
}

async function finalizeThenExpireClaimAndEdge() {
  const state = delegatedTrace("succeeded");
  const finalized = await reconcileTraceFinalization(state.memory.database, state.root);
  expect(finalized?.data.status).toBe("finalized");
  await state.memory.database.transactWrite([
    { kind: "delete", record: state.claim },
    { kind: "delete", record: state.edge },
  ]);
  return { ...state, finalized };
}

describe("trace finalization on provider claim removal", () => {
  test("acknowledges retention's removal of a settled claim while retention holds the fence", async () => {
    const { claim, finalized, memory } = await finalizeThenExpireClaimAndEdge();
    setTraceFinalizationDatabaseForTest(fencedWrites(memory.database));

    expect(await handler(claimRemoval(claim, "201"))).toEqual({ batchItemFailures: [] });
    expect(storedTrace(memory.records.values())).toEqual(finalized);
  });

  test("keeps a finalized trace finalized after retention removes a settled claim", async () => {
    const { claim, finalized, memory } = await finalizeThenExpireClaimAndEdge();
    setTraceFinalizationDatabaseForTest(memory.database);

    expect(await handler(claimRemoval(claim, "202"))).toEqual({ batchItemFailures: [] });
    expect(storedTrace(memory.records.values())).toEqual(finalized);
  });

  test("finalizes the trace when the runtime releases an open claim", async () => {
    const { claim, memory, root } = delegatedTrace("active");
    const waiting = await reconcileTraceFinalization(memory.database, root);
    expect(waiting?.data.status).toBe("open");
    await memory.database.transactWrite([{ kind: "delete", record: claim }]);
    setTraceFinalizationDatabaseForTest(memory.database);

    expect(await handler(claimRemoval(claim, "203"))).toEqual({ batchItemFailures: [] });
    expect(storedTrace(memory.records.values())?.data).toMatchObject({
      outcome: "ok",
      status: "finalized",
    });
  });
});
