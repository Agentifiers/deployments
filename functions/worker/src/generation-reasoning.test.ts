import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  validateGenerationReasoning,
  type RuntimeModelContinuation,
  type RuntimePendingAction,
} from "@deployments-ai/agent-runtime";
import {
  generationReasoningCreateOperation,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import { persistPausedRun } from "./agent-run-completion.ts";
import {
  persistCanceledRun,
  persistCheckpointedRun,
  persistFailedRun,
  persistInterruptedRun,
  persistRetryableRun,
} from "./agent-run-terminal.ts";
import { abandonedRunWithLease } from "./agent-run-state.fixture.ts";
import { fixtures, id, inMemoryDatabase, workerDependencies } from "./agent-run.fixture.ts";
import { withRunToolContinuationReferences } from "./continuation.ts";
import { hydratedModelContinuation } from "./generation-reasoning.ts";
import type { AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";
import type { RuntimeLeaseRecordValue } from "./agent-run-input.ts";

const OPUS = "openrouter/anthropic/claude-opus-5.5";
const CREATE_ONLY = "attribute_not_exists(pk) AND attribute_not_exists(sk)";

const thinking = (modelCallIndex: number) =>
  [
    {
      format: "anthropic-claude-v1",
      index: 0,
      signature: `c2lnbmF0dXJl${modelCallIndex}`,
      text: `Plan step ${modelCallIndex}.`,
      type: "reasoning.text",
    },
  ] as const;

const toolRequest = (modelCallIndex: number) => ({
  effect: "read" as const,
  idempotencyKey: `model-tool:${modelCallIndex}:0`,
  inputSummary: `Read resource ${modelCallIndex}.`,
  requiredScopes: [],
  toolName: "provider.read",
});

const attemptId = (modelCallIndex: number) =>
  `${id(10)}:execution:1:assistant:${modelCallIndex}:run-attempt:0:fallback:0`;

function continuation(modelCallCount: number): RuntimeModelContinuation {
  return {
    generationReasoning: validateGenerationReasoning(
      Array.from({ length: modelCallCount }, (_, modelCallIndex) => ({
        details: thinking(modelCallIndex),
        modelCallIndex,
        producerAttemptId: attemptId(modelCallIndex),
        producerModelId: OPUS,
      })),
      modelCallCount,
    ),
    modelCallCount,
    toolRequests: Array.from({ length: modelCallCount }, (_, index) => toolRequest(index)),
  };
}

const approval: RuntimePendingAction = {
  approvalId: id(72),
  effect: "write",
  idempotencyKey: "model-tool:2:1",
  inputSummary: "Publish the notes.",
  kind: "approval",
  policyReason: "Publishing needs approval.",
  requiredScopes: [],
  toolCallId: id(71),
  toolName: "notes.publish",
};

interface Boundary {
  readonly database: DynamoDatabaseService;
  readonly dependencies: AgentRunWorkerDependencies;
  readonly lease: RuntimeLeaseRecordValue;
  readonly previous: RunRecordValue;
  readonly records: ReadonlyMap<string, PlatformRecord>;
  readonly transactionInputs: readonly (readonly TransactionOperation[])[];
}

function claimedRunCountingOneGeneration(): Boundary {
  const fixture = fixtures();
  const claimed = abandonedRunWithLease(fixture);
  const previous = withRunToolContinuationReferences(claimed.run, {
    completedToolCallIds: [],
    modelContinuation: { modelCallCount: 1, toolRequests: [toolRequest(0)] },
  });
  const memory = inMemoryDatabase([
    fixture.release,
    fixture.deployment,
    fixture.thread,
    fixture.userMessage,
    previous,
    claimed.lease,
  ]);
  return {
    database: memory.database,
    dependencies: workerDependencies(memory.database).dependencies,
    lease: claimed.lease,
    previous,
    records: memory.records,
    transactionInputs: memory.transactionInputs,
  };
}

function reasoningRecords(records: Iterable<PlatformRecord>) {
  return [...records]
    .filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "generation-reasoning" }> =>
        record.itemType === "generation-reasoning",
    )
    .toSorted((left, right) => left.sk.localeCompare(right.sk));
}

const boundaries: readonly (readonly [
  string,
  (boundary: Boundary, modelContinuation: RuntimeModelContinuation) => Promise<unknown>,
  readonly string[],
])[] = [
  [
    "paused",
    ({ dependencies, lease, previous }, modelContinuation) =>
      persistPausedRun(
        dependencies,
        previous,
        lease,
        "waiting-for-approval",
        "Waiting for approval.",
        [],
        approval,
        { artifactBytes: 0, artifactIndexCursor: 0, artifacts: [] },
        modelContinuation,
        [],
      ),
    ["GENERATION-REASONING#0000000000000001", "GENERATION-REASONING#0000000000000002"],
  ],
  [
    "checkpointed",
    ({ dependencies, lease, previous }, modelContinuation) =>
      persistCheckpointedRun(dependencies, previous, lease, {
        completedToolCalls: [],
        modelContinuation,
        modelInvocationAttempts: [],
        usage: [],
      }),
    ["GENERATION-REASONING#0000000000000001", "GENERATION-REASONING#0000000000000002"],
  ],
  [
    "interrupted",
    ({ dependencies, lease, previous }, modelContinuation) =>
      persistInterruptedRun(dependencies, previous, lease, {
        completedToolCalls: [],
        modelContinuation,
        modelInvocationAttempts: [],
        usage: [],
      }),
    ["GENERATION-REASONING#0000000000000001", "GENERATION-REASONING#0000000000000002"],
  ],
  [
    "retry-scheduled",
    ({ dependencies, lease, previous }, modelContinuation) =>
      persistRetryableRun(
        dependencies,
        previous,
        new Error("Provider unavailable."),
        lease,
        [],
        undefined,
        [],
        modelContinuation,
      ),
    ["GENERATION-REASONING#0000000000000001", "GENERATION-REASONING#0000000000000002"],
  ],
  [
    "failed",
    ({ dependencies, lease, previous }, modelContinuation) =>
      persistFailedRun(
        dependencies,
        previous,
        new Error("Model failed."),
        lease,
        [],
        [],
        undefined,
        modelContinuation,
      ),
    [],
  ],
  [
    "canceled",
    ({ dependencies, lease, previous }, modelContinuation) =>
      persistCanceledRun(
        dependencies,
        previous,
        lease,
        "Canceled.",
        [],
        undefined,
        [],
        undefined,
        modelContinuation,
      ),
    [],
  ],
];

describe("generation reasoning at run boundaries", () => {
  it.each(boundaries)(
    "a %s boundary creates reasoning only for uncounted generations of a continuing run",
    async (_name, persist, expectedSortKeys) => {
      const boundary = claimedRunCountingOneGeneration();

      await persist(boundary, continuation(3));

      const puts = boundary.transactionInputs
        .at(-1)!
        .filter(
          (operation) =>
            operation.kind === "put" && operation.record.itemType === "generation-reasoning",
        )
        .map((operation) =>
          operation.kind === "put"
            ? { conditionExpression: operation.conditionExpression, sk: operation.record.sk }
            : undefined,
        );
      expect(puts).toEqual(
        expectedSortKeys.map((sk) => ({ conditionExpression: CREATE_ONLY, sk })),
      );
      expect(reasoningRecords(boundary.records.values()).map((record) => record.sk)).toEqual([
        ...expectedSortKeys,
      ]);
    },
  );

  it("rejects a re-run of a committed boundary on the run version and keeps its reasoning", async () => {
    const boundary = claimedRunCountingOneGeneration();
    const pause = (modelContinuation: RuntimeModelContinuation) =>
      persistPausedRun(
        boundary.dependencies,
        boundary.previous,
        boundary.lease,
        "waiting-for-approval",
        "Waiting for approval.",
        [],
        approval,
        { artifactBytes: 0, artifactIndexCursor: 0, artifacts: [] },
        modelContinuation,
        [],
      );
    await pause(continuation(3));
    const committed = reasoningRecords(boundary.records.values());

    const retried = pause({
      ...continuation(3),
      generationReasoning: validateGenerationReasoning(
        [1, 2].map((modelCallIndex) => ({
          details: thinking(modelCallIndex + 10),
          modelCallIndex,
          producerAttemptId: attemptId(modelCallIndex),
          producerModelId: OPUS,
        })),
        3,
      ),
    });

    expect(retried).rejects.toThrow("simulated optimistic write conflict");
    expect<unknown>(committed.map((record) => record.data.reasoningDetails)).toEqual([
      thinking(1),
      thinking(2),
    ]);
    expect(reasoningRecords(boundary.records.values())).toEqual(committed);
  });
});

describe("hydratedModelContinuation", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  afterEach(() => warn.mockClear());
  afterAll(() => warn.mockRestore());

  it("joins the reasoning of counted generations and reports the rest", async () => {
    const { database, previous } = claimedRunCountingOneGeneration();
    await database.transactWrite(
      [0, 2, 5].map((modelCallIndex) =>
        generationReasoningCreateOperation({
          createdAt: "2026-07-22T00:00:02.000Z",
          modelCallIndex,
          producerAttemptId: attemptId(modelCallIndex),
          producerModelId: OPUS,
          reasoningDetails: thinking(modelCallIndex),
          scope: {
            environmentId: previous.data.environmentId,
            organizationId: previous.data.organizationId,
            projectId: previous.data.projectId,
            runId: previous.data.id,
            threadId: previous.data.threadId,
          },
        }),
      ),
    );
    const { generationReasoning: _none, ...record } = continuation(3);

    const hydrated = await hydratedModelContinuation({
      database,
      record,
      run: previous,
    });

    expect<unknown>(hydrated).toEqual({
      generationReasoning: [0, 2].map((modelCallIndex) => ({
        details: thinking(modelCallIndex),
        modelCallIndex,
        producerAttemptId: attemptId(modelCallIndex),
        producerModelId: OPUS,
      })),
      modelCallCount: 3,
      toolRequests: [toolRequest(0), toolRequest(1), toolRequest(2)],
    });
    expect(warn.mock.calls).toEqual([
      [
        "Generation reasoning beyond the run's model continuation was not replayed.",
        { modelCallCount: 3, modelCallIndexes: [5], runId: id(10) },
      ],
    ]);
  });
});
