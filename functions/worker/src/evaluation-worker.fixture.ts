import {
  EvaluationRunRecord,
  makeEvaluationPersistence,
  makeModelIdAdmission,
  MessageRecord,
  RunLookupRecord,
  RunRecord,
  tableForItemType,
  ToolCallRecord,
  TraceRecord,
  withCanonicalRecordKeys,
  type EvaluationPersistence,
  type EvaluationRunData,
  type EvaluationScope,
  type PlatformRecord,
  type ScoreDefinitionRevisionRecord,
  type Ulid,
} from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import type {
  CaseExpectations,
  EvaluatorConfig,
} from "@deployments-ai/observability/evaluator-config";
import {
  caseMaterialObjectKey,
  evaluatorVersionHash,
  prepareCaseMaterial,
  scoreDefinitionTypeForEvaluator,
  type EvaluationQueueMessage,
  type JudgeModelRequest,
  type JudgeModelResponse,
} from "@deployments-ai/observability/evaluators";
import { Schema } from "effect";
import type {
  CreateEvaluationBindingInput,
  EvaluationBlobReference,
  EvaluationMessageContext,
  EvaluationWorkerDependencies,
  SubmitEvaluationTurnInput,
} from "./evaluation-ports.ts";

export const scope: EvaluationScope = {
  environmentId: "01J00000000000000000000EN1" as Ulid,
  organizationId: "01J00000000000000000000RG1" as Ulid,
  projectId: "01J00000000000000000000PR1" as Ulid,
};
export const RELEASE_ID = "01J00000000000000000000RE1" as Ulid;
export const DEPLOYMENT_ID = "01J00000000000000000000DE1" as Ulid;
const ARTIFACT_BUCKET = "evaluation-artifacts";
const START = Date.parse("2026-09-29T12:00:00.000Z");

let sequence = 0;
/** Strictly increasing, valid ULIDs. */
export function nextUlid(): Ulid {
  sequence += 1;
  return `01K${String(sequence).padStart(23, "0")}` as Ulid;
}

/** 32-hex trace id derived from a counter. */
function nextTraceId(): string {
  sequence += 1;
  return sequence.toString(16).padStart(32, "a");
}

export interface SimulatedRun {
  readonly outputText?: string;
  readonly status: "completed" | "failed" | "running";
  readonly toolNames?: readonly string[];
  readonly executionPurpose?: string;
  readonly executionBindingId?: string;
  readonly totalTokens?: number;
}

/** Decodes a canonical record; callers narrow to the record type they seeded. */
function decodeRecord(schema: Schema.Codec<unknown, unknown>, itemType: string, data: object) {
  return Schema.decodeUnknownSync(schema)(withCanonicalRecordKeys({ data, itemType } as never));
}

export function evaluationHarness() {
  const memory = evaluationMemoryDatabase();
  const sent: EvaluationQueueMessage[] = [];
  const bindings: CreateEvaluationBindingInput[] = [];
  const submissions: SubmitEvaluationTurnInput[] = [];
  const reports: { key: string; body: string; contentType: string }[] = [];
  const judgeRequests: JudgeModelRequest[] = [];
  const objects = new Map<string, Uint8Array>();
  const clock = { now: START };
  let judgeResponse: JudgeModelResponse = { text: '{"value":1,"rationale":"ok"}' };
  /** Simulated outcome of the next submitted turn. */
  let nextRun: SimulatedRun = { outputText: "Your refund is on its way.", status: "completed" };

  const put = (record: PlatformRecord) =>
    memory.records.set(
      `${tableForItemType(record.itemType)}\u0000${record.pk}\u0000${record.sk}`,
      record,
    );

  /** Writes a run with its lookup, user and assistant messages, tool calls, and trace. */
  function seedRun(input: {
    readonly content: string;
    readonly run: SimulatedRun;
    readonly runId?: Ulid;
    readonly threadId?: Ulid;
    readonly traceId?: string;
  }) {
    const runId = input.runId ?? nextUlid();
    const threadId = input.threadId ?? nextUlid();
    const traceId = input.traceId ?? nextTraceId();
    const userMessageId = nextUlid();
    const createdAt = new Date(clock.now).toISOString();
    const completedAt = new Date(clock.now + 1_500).toISOString();
    const finished = input.run.status !== "running";
    const idempotencyKey = `turn/${runId}`;
    const run = decodeRecord(RunRecord, "run", {
      ...scope,
      agentDeploymentId: DEPLOYMENT_ID,
      agentReleaseId: RELEASE_ID,
      attempt: 0,
      captureMode: "metadata-only",
      createdAt,
      executor: "hosted",
      id: runId,
      idempotencyKey,
      priority: 1,
      redactionPolicyVersion: 1,
      schemaVersion: 1,
      spanId: "0123456789abcdef",
      startedAt: createdAt,
      status: input.run.status,
      threadId,
      traceId,
      trigger: "api",
      updatedAt: createdAt,
      userMessageId,
      userMessageSequence: 0,
      version: 1,
      ...(finished ? { completedAt } : {}),
    }) as Extract<PlatformRecord, { itemType: "run" }>;
    const extras = {
      ...(input.run.executionPurpose ? { executionPurpose: input.run.executionPurpose } : {}),
      ...(input.run.executionBindingId ? { executionBindingId: input.run.executionBindingId } : {}),
    };
    put({ ...run, data: { ...run.data, ...extras } } as PlatformRecord);
    put(
      decodeRecord(RunLookupRecord, "run-lookup", {
        ...scope,
        createdAt,
        idempotencyKey,
        runId,
        threadId,
      }) as PlatformRecord,
    );
    const message = (id: Ulid, role: "assistant" | "user", body: string, sequenceNumber: number) =>
      put(
        decodeRecord(MessageRecord, "message", {
          ...scope,
          body,
          contentHash: `hash-${id}`,
          createdAt,
          id,
          role,
          runId,
          sequence: sequenceNumber,
          threadId,
        }) as PlatformRecord,
      );
    message(userMessageId, "user", input.content, 0);
    if (input.run.outputText !== undefined)
      message(nextUlid(), "assistant", input.run.outputText, 1);
    for (const toolName of input.run.toolNames ?? []) {
      put(
        decodeRecord(ToolCallRecord, "tool-call", {
          ...scope,
          createdAt,
          effect: "read",
          id: nextUlid(),
          inputSummary: toolName,
          requiredScopes: [],
          runId,
          status: "succeeded",
          threadId,
          toolName,
          updatedAt: createdAt,
          version: 1,
        }) as PlatformRecord,
      );
    }
    put(
      decodeRecord(TraceRecord, "trace", {
        ...scope,
        captureMode: "metadata-only",
        createdAt,
        id: traceId,
        redactionPolicyVersion: 1,
        rootRunId: runId,
        rootSpanId: "0123456789abcdef",
        runIds: [runId],
        schemaVersion: 1,
        sessionId: threadId,
        status: finished ? "finalized" : "open",
        traceId,
        updatedAt: createdAt,
        version: 1,
        ...(finished ? { finalizedAt: completedAt } : {}),
        ...(input.run.totalTokens !== undefined
          ? { totalCostUsdMicros: input.run.totalTokens * 2, totalTokens: input.run.totalTokens }
          : {}),
      }) as PlatformRecord,
    );
    return { runId, threadId, traceId };
  }

  const dependencies: EvaluationWorkerDependencies = {
    admitJudgeModel: makeModelIdAdmission(memory.database),
    artifacts: {
      async putReport(input) {
        reports.push(input);
        return {
          bucket: ARTIFACT_BUCKET,
          byteSize: new TextEncoder().encode(input.body).byteLength,
          contentType: input.contentType,
          key: input.key,
          sha256: "0".repeat(64),
          versionId: `v${reports.length}`,
        };
      },
      async readCaseMaterial(reference: EvaluationBlobReference) {
        const bytes = objects.get(reference.key);
        if (!bytes) throw new Error(`Missing object ${reference.key}`);
        return bytes;
      },
      async readMessageBody() {
        throw new Error("Fixture messages store inline bodies.");
      },
    },
    database: memory.database,
    execution: {
      async createBinding(input) {
        bindings.push(input);
        return { executionBindingId: `binding-${input.idempotencyKey}` };
      },
      async submitTurn(input) {
        submissions.push(input);
        const seeded = seedRun({ content: input.content, run: nextRun });
        return { ...seeded, runIdempotencyKey: `turn/${seeded.runId}` };
      },
    },
    generateId: async () => nextUlid(),
    judgeFor: () => ({
      async complete(request) {
        judgeRequests.push(request);
        return judgeResponse;
      },
    }),
    now: () => new Date(clock.now),
    queue: {
      async send(message) {
        sent.push(message);
      },
    },
  };
  const persistence: EvaluationPersistence = makeEvaluationPersistence(memory.database, scope);
  const context: EvaluationMessageContext = { ...dependencies, persistence, scope };

  async function seedDefinition(
    evaluator: EvaluatorConfig,
    options: { readonly threshold?: number; readonly samplingRate?: number } = {},
  ): Promise<ScoreDefinitionRevisionRecord> {
    const id = nextUlid();
    const now = new Date(clock.now).toISOString();
    const threshold = options.threshold ?? 1;
    const created = await persistence.createScoreDefinition(
      {
        definition: {
          ...scope,
          createdAt: now,
          createdByPrincipalId: "principal-1",
          currentRevision: 1,
          id,
          name: `definition-${id.toLowerCase().slice(-6)}`,
          ownerPrincipalId: "principal-1",
          status: "active",
          type: scoreDefinitionTypeForEvaluator(evaluator),
          updatedAt: now,
          version: 1,
        },
        revision: {
          ...scope,
          createdAt: now,
          createdByPrincipalId: "principal-1",
          evaluator,
          evaluatorVersionHash: evaluatorVersionHash({ evaluator, target: "root-run", threshold }),
          id: nextUlid(),
          revision: 1,
          sampling: { rate: options.samplingRate ?? 0 },
          scoreDefinitionId: id,
          status: "active",
          target: "root-run",
          threshold,
          updatedAt: now,
          version: 1,
        },
      },
      { eventId: nextUlid(), eventType: "score-definition.created", occurredAt: now, payload: {} },
    );
    return created.revision;
  }

  async function seedDataset(
    cases: readonly { readonly content: string; readonly expectations?: CaseExpectations }[],
  ) {
    const datasetId = nextUlid();
    const now = new Date(clock.now).toISOString();
    const event = (eventType: string) => ({
      eventId: nextUlid(),
      eventType,
      occurredAt: now,
      payload: {},
    });
    await persistence.createRegressionDataset(
      {
        ...scope,
        caseCount: 0,
        createdAt: now,
        createdByPrincipalId: "principal-1",
        id: datasetId,
        name: `dataset-${datasetId.toLowerCase().slice(-6)}`,
        ownerPrincipalId: "principal-1",
        status: "active",
        updatedAt: now,
        version: 1,
      },
      event("regression-dataset.created"),
    );
    const prepared = cases.map((entry) =>
      prepareCaseMaterial({ content: entry.content, expectations: entry.expectations ?? {} }),
    );
    const result = await persistence.addDatasetCases(
      {
        cases: prepared.map((material) => {
          const key = caseMaterialObjectKey(
            scope.organizationId,
            datasetId,
            material.contentSha256,
          );
          objects.set(key, material.bytes);
          return {
            ...scope,
            contentSha256: material.contentSha256,
            createdAt: now,
            createdByPrincipalId: "principal-1",
            datasetId,
            expectationKinds: [...material.expectationKinds],
            id: nextUlid(),
            inputPreview: material.inputPreview,
            material: {
              bucket: ARTIFACT_BUCKET,
              byteSize: material.bytes.byteLength,
              contentType: "application/json",
              key,
              sha256: material.contentSha256,
            },
            provenance: "manual" as const,
            tags: [],
          };
        }),
        datasetId,
        updatedAt: now,
      },
      event("regression-dataset.cases-added"),
    );
    return { cases: result.created, datasetId };
  }

  function runData(
    definitions: readonly ScoreDefinitionRevisionRecord[],
    fields: Partial<EvaluationRunData>,
  ): EvaluationRunData {
    const id = nextUlid();
    return {
      ...scope,
      caseCount: 0,
      caseTimeoutSeconds: 600,
      concurrency: 5,
      counts: { failed: 0, pending: 0, running: 0, scored: 0, timedOut: 0 },
      createdAt: new Date(clock.now).toISOString(),
      createdByPrincipalId: "principal-1",
      id,
      idempotencyKey: `create-${id}`,
      kind: "dataset-replay",
      scoreDefinitions: definitions.map((revision) => ({
        evaluatorVersionHash: revision.data.evaluatorVersionHash,
        name: `definition-${revision.data.scoreDefinitionId.toLowerCase().slice(-6)}`,
        revision: revision.data.revision,
        scoreDefinitionId: revision.data.scoreDefinitionId,
        threshold: revision.data.threshold,
        type: scoreDefinitionTypeForEvaluator(revision.data.evaluator),
      })),
      status: "queued",
      updatedAt: new Date(clock.now).toISOString(),
      version: 1,
      ...fields,
    };
  }

  async function createRun(
    definitions: readonly ScoreDefinitionRevisionRecord[],
    fields: Partial<EvaluationRunData>,
  ): Promise<EvaluationRunRecord> {
    const now = new Date(clock.now).toISOString();
    return persistence.createEvaluationRun(runData(definitions, fields), {
      eventId: nextUlid(),
      eventType: "evaluation-run.created",
      occurredAt: now,
      payload: {},
    });
  }

  return {
    bindings,
    clock,
    context,
    createRun,
    dependencies,
    judgeRequests,
    memory,
    persistence,
    reports,
    runData,
    seedDataset,
    seedDefinition,
    seedRun,
    sent,
    setJudgeResponse(response: JudgeModelResponse) {
      judgeResponse = response;
    },
    setNextRun(run: SimulatedRun) {
      nextRun = run;
    },
    submissions,
  };
}

export type EvaluationHarness = ReturnType<typeof evaluationHarness>;

/** Delivers every queued message (FIFO order) until the queue drains or the limit is reached. */
export async function drainQueue(
  harness: EvaluationHarness,
  deliver: (message: EvaluationQueueMessage) => Promise<unknown>,
  limit = 200,
) {
  let delivered = 0;
  while (harness.sent.length > 0) {
    if (delivered >= limit) throw new Error("Evaluation queue did not drain.");
    const message = harness.sent.shift()!;
    delivered += 1;
    await deliver(message);
  }
  return delivered;
}
