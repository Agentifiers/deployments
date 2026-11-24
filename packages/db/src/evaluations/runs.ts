import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { key } from "../keys.ts";
import {
  EvaluationCaseRunRecord,
  EvaluationRunRecord,
  MAX_EVALUATION_DATASET_CASES,
  ReleaseComparisonRecord,
} from "../records/evaluations.ts";
import {
  canonicalRecord,
  commitAggregateUpdate,
  commitWithEvent,
  commitWithEvents,
  invalidInput,
  nextRecordVersion,
  queryAllScoped,
  queryFilteredScopedPage,
  queryScopedPage,
  readScopedRecord,
  type EvaluationPage,
  type EvaluationPageOptions,
  type EvaluationPersistenceEvent,
  type EvaluationScope,
} from "./support.ts";

export type EvaluationRunData = EvaluationRunRecord["data"];
export type EvaluationCaseRunData = EvaluationCaseRunRecord["data"];
export type ReleaseComparisonData = ReleaseComparisonRecord["data"];

/** Environment run history filters; every supplied filter must match. */
export interface EvaluationRunListOptions extends EvaluationPageOptions {
  /** Matches the replay target's release, including a deployment target's pinned release. */
  readonly agentReleaseId?: string | undefined;
  readonly datasetId?: string | undefined;
  readonly status?: EvaluationRunData["status"] | undefined;
}

/** Environment comparison history filters; every supplied filter must match. */
export interface ReleaseComparisonListOptions extends EvaluationPageOptions {
  readonly baselineReleaseId?: string | undefined;
  readonly candidateReleaseId?: string | undefined;
  readonly status?: ReleaseComparisonData["status"] | undefined;
}

/** Case-run creates per transaction (each put also writes a governance directory entry). */
export const MAX_CASE_RUNS_PER_WRITE = 40;

export interface EvaluationRunPersistence {
  readonly createEvaluationRun: (
    data: EvaluationRunData,
    event: EvaluationPersistenceEvent,
  ) => Promise<EvaluationRunRecord>;
  /**
   * Creates a comparison and both of its evaluation runs atomically, with the created event of
   * each aggregate.
   */
  readonly createReleaseComparison: (
    input: {
      readonly baseline: EvaluationRunData;
      readonly candidate: EvaluationRunData;
      readonly comparison: ReleaseComparisonData;
    },
    events: {
      readonly baseline: EvaluationPersistenceEvent;
      readonly candidate: EvaluationPersistenceEvent;
      readonly comparison: EvaluationPersistenceEvent;
    },
  ) => Promise<{
    readonly baseline: EvaluationRunRecord;
    readonly candidate: EvaluationRunRecord;
    readonly comparison: ReleaseComparisonRecord;
  }>;
  readonly getEvaluationRun: (id: string) => Promise<EvaluationRunRecord | undefined>;
  /** Environment evaluation runs, newest created first. */
  readonly listEvaluationRuns: (
    options: EvaluationRunListOptions,
  ) => Promise<EvaluationPage<EvaluationRunRecord>>;
  /** Every run version carries a semantic event, so each update needs one. */
  readonly updateEvaluationRun: (
    previous: EvaluationRunRecord,
    data: EvaluationRunData,
    event: EvaluationPersistenceEvent,
  ) => Promise<EvaluationRunRecord>;
  readonly getReleaseComparison: (id: string) => Promise<ReleaseComparisonRecord | undefined>;
  /** Environment release comparisons, newest created first. */
  readonly listReleaseComparisons: (
    options: ReleaseComparisonListOptions,
  ) => Promise<EvaluationPage<ReleaseComparisonRecord>>;
  /** Every comparison version carries a semantic event, so each update needs one. */
  readonly updateReleaseComparison: (
    previous: ReleaseComparisonRecord,
    data: ReleaseComparisonData,
    event: EvaluationPersistenceEvent,
  ) => Promise<ReleaseComparisonRecord>;
  /** Creates missing case runs; existing case runs for the same case key are left unchanged. */
  readonly createCaseRuns: (
    evaluationRunId: string,
    cases: readonly EvaluationCaseRunData[],
  ) => Promise<readonly EvaluationCaseRunRecord[]>;
  readonly getCaseRun: (
    evaluationRunId: string,
    caseKey: string,
  ) => Promise<EvaluationCaseRunRecord | undefined>;
  readonly updateCaseRun: (
    previous: EvaluationCaseRunRecord,
    data: EvaluationCaseRunData,
  ) => Promise<EvaluationCaseRunRecord>;
  readonly listCaseRuns: (
    evaluationRunId: string,
    options: EvaluationPageOptions,
  ) => Promise<EvaluationPage<EvaluationCaseRunRecord>>;
  readonly listAllCaseRuns: (
    evaluationRunId: string,
  ) => Promise<readonly EvaluationCaseRunRecord[]>;
}

export function makeEvaluationRunPersistence(
  database: DynamoDatabaseService,
  scope: EvaluationScope,
): EvaluationRunPersistence {
  const environmentPartition = key("ORG", scope.organizationId, "ENV", scope.environmentId);
  const runPartition = (evaluationRunId: string) =>
    key("ORG", scope.organizationId, "EVALUATION-RUN", evaluationRunId);
  const runRecord = (data: EvaluationRunData) =>
    canonicalRecord(EvaluationRunRecord, { data, itemType: "evaluation-run" });
  const caseRunRecord = (data: EvaluationCaseRunData) =>
    canonicalRecord(EvaluationCaseRunRecord, { data, itemType: "evaluation-case-run" });
  const comparisonRecord = (data: ReleaseComparisonData) =>
    canonicalRecord(ReleaseComparisonRecord, { data, itemType: "release-comparison" });

  function initialRun(data: EvaluationRunData) {
    const record = runRecord(data);
    if (record.data.version !== 1 || record.data.status !== "queued") {
      invalidInput("invalid_evaluation_run", "New evaluation runs start queued at version 1.");
    }
    return record;
  }

  const listAllCaseRuns = (evaluationRunId: string) =>
    queryAllScoped(
      database,
      scope,
      {
        itemType: "evaluation-case-run",
        partition: runPartition(evaluationRunId),
        prefix: "EVALUATION-CASE-RUN#",
        table: "execution",
      },
      MAX_EVALUATION_DATASET_CASES,
    );

  return {
    async createEvaluationRun(data, event) {
      const record = initialRun(data);
      await commitWithEvent(
        database,
        scope,
        [{ kind: "put", record }],
        {
          aggregateId: record.data.id,
          aggregateType: "evaluation_run",
          aggregateVersion: record.data.version,
          event,
        },
        "evaluation run create",
      );
      return record;
    },

    async createReleaseComparison(input, events) {
      const comparison = comparisonRecord(input.comparison);
      const baseline = initialRun(input.baseline);
      const candidate = initialRun(input.candidate);
      if (
        comparison.data.version !== 1 ||
        comparison.data.status !== "queued" ||
        comparison.data.baseline.evaluationRunId !== baseline.data.id ||
        comparison.data.candidate.evaluationRunId !== candidate.data.id ||
        baseline.data.comparison?.releaseComparisonId !== comparison.data.id ||
        baseline.data.comparison.role !== "baseline" ||
        candidate.data.comparison?.releaseComparisonId !== comparison.data.id ||
        candidate.data.comparison.role !== "candidate"
      ) {
        invalidInput(
          "invalid_release_comparison",
          "A new comparison must be queued and reference its baseline and candidate runs.",
        );
      }
      await commitWithEvents(
        database,
        scope,
        [
          { kind: "put", record: comparison },
          { kind: "put", record: baseline },
          { kind: "put", record: candidate },
        ],
        [
          {
            aggregateId: comparison.data.id,
            aggregateType: "release_comparison",
            aggregateVersion: comparison.data.version,
            event: events.comparison,
          },
          {
            aggregateId: baseline.data.id,
            aggregateType: "evaluation_run",
            aggregateVersion: baseline.data.version,
            event: events.baseline,
          },
          {
            aggregateId: candidate.data.id,
            aggregateType: "evaluation_run",
            aggregateVersion: candidate.data.version,
            event: events.candidate,
          },
        ],
        "release comparison create",
      );
      return { baseline, candidate, comparison };
    },

    getEvaluationRun: (id) =>
      readScopedRecord(
        database,
        scope,
        "execution",
        { pk: environmentPartition, sk: key("EVALUATION-RUN", id) },
        "evaluation-run",
      ),

    listEvaluationRuns: ({ agentReleaseId, cursor, datasetId, limit, status }) =>
      queryFilteredScopedPage(database, scope, {
        index: "gsi1",
        itemType: "evaluation-run",
        newestFirst: true,
        options: { cursor, limit },
        partition: key("ORG", scope.organizationId, "ENV", scope.environmentId, "EVALUATION-RUNS"),
        table: "execution",
        ...(agentReleaseId === undefined && datasetId === undefined && status === undefined
          ? {}
          : {
              include: ({ data }) =>
                (status === undefined || data.status === status) &&
                (datasetId === undefined || data.datasetId === datasetId) &&
                (agentReleaseId === undefined || data.target?.agentReleaseId === agentReleaseId),
            }),
      }),

    async updateEvaluationRun(previous, data, event) {
      return commitAggregateUpdate(
        database,
        scope,
        previous,
        nextRecordVersion(previous, runRecord(data)),
        event,
        "evaluation run update",
      );
    },

    getReleaseComparison: (id) =>
      readScopedRecord(
        database,
        scope,
        "execution",
        { pk: environmentPartition, sk: key("RELEASE-COMPARISON", id) },
        "release-comparison",
      ),

    listReleaseComparisons: ({ baselineReleaseId, candidateReleaseId, cursor, limit, status }) =>
      queryFilteredScopedPage(database, scope, {
        index: "gsi1",
        itemType: "release-comparison",
        newestFirst: true,
        options: { cursor, limit },
        partition: key(
          "ORG",
          scope.organizationId,
          "ENV",
          scope.environmentId,
          "RELEASE-COMPARISONS",
        ),
        table: "execution",
        ...(baselineReleaseId === undefined &&
        candidateReleaseId === undefined &&
        status === undefined
          ? {}
          : {
              include: ({ data }) =>
                (status === undefined || data.status === status) &&
                (baselineReleaseId === undefined ||
                  data.baseline.agentReleaseId === baselineReleaseId) &&
                (candidateReleaseId === undefined ||
                  data.candidate.agentReleaseId === candidateReleaseId),
            }),
      }),

    async updateReleaseComparison(previous, data, event) {
      return commitAggregateUpdate(
        database,
        scope,
        previous,
        nextRecordVersion(previous, comparisonRecord(data)),
        event,
        "release comparison update",
      );
    },

    async createCaseRuns(evaluationRunId, cases) {
      const existing = new Set(
        (await listAllCaseRuns(evaluationRunId)).map((record) => record.data.caseKey),
      );
      const created: EvaluationCaseRunRecord[] = [];
      const pending = cases.map(caseRunRecord).filter((record) => {
        if (record.data.evaluationRunId !== evaluationRunId || record.data.version !== 1) {
          invalidInput(
            "invalid_evaluation_case_run",
            "New case runs must belong to the evaluation run and start at version 1.",
          );
        }
        if (existing.has(record.data.caseKey)) return false;
        existing.add(record.data.caseKey);
        return true;
      });
      for (let index = 0; index < pending.length; index += MAX_CASE_RUNS_PER_WRITE) {
        const batch = pending.slice(index, index + MAX_CASE_RUNS_PER_WRITE);
        await commitWithEvent(
          database,
          scope,
          batch.map((record): TransactionOperation => ({ kind: "put", record })),
          undefined,
          "evaluation case run create",
        );
        created.push(...batch);
      }
      return created;
    },

    getCaseRun: (evaluationRunId, caseKey) =>
      readScopedRecord(
        database,
        scope,
        "execution",
        { pk: runPartition(evaluationRunId), sk: key("EVALUATION-CASE-RUN", caseKey) },
        "evaluation-case-run",
      ),

    async updateCaseRun(previous, data) {
      const record = nextRecordVersion(previous, caseRunRecord(data));
      await commitWithEvent(
        database,
        scope,
        [{ kind: "put", previousRecord: previous, record }],
        undefined,
        "evaluation case run update",
      );
      return record;
    },

    listCaseRuns: (evaluationRunId, options) =>
      queryScopedPage(database, scope, {
        itemType: "evaluation-case-run",
        options,
        partition: runPartition(evaluationRunId),
        prefix: "EVALUATION-CASE-RUN#",
        table: "execution",
      }),

    listAllCaseRuns,
  };
}
