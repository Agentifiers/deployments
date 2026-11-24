import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import { AnnotationRecord, ScoreResultRecord } from "../records/evaluations.ts";
import {
  canonicalRecord,
  commitWithEvent,
  conflict,
  invalidInput,
  nextRecordVersion,
  queryScopedPage,
  readScopedRecord,
  type EvaluationPage,
  type EvaluationPageOptions,
  type EvaluationScope,
} from "./support.ts";

export type ScoreResultData = ScoreResultRecord["data"];
export type AnnotationData = AnnotationRecord["data"];

export interface RecordScoreResultOutcome {
  /** False when an identical automated score for this trace and definition revision existed. */
  readonly created: boolean;
  readonly result: ScoreResultRecord;
}

export interface ScoreResultPersistence {
  /**
   * Idempotently records an automated score: one result per trace, definition, and revision.
   * An existing result is returned unchanged.
   */
  readonly recordAutomatedScore: (data: ScoreResultData) => Promise<RecordScoreResultOutcome>;
  /**
   * Records a human or imported score. A later score for the same trace and definition
   * revision supersedes the stored value in place (version + 1).
   */
  readonly recordSubmittedScore: (data: ScoreResultData) => Promise<RecordScoreResultOutcome>;
  readonly getScoreResult: (
    traceId: string,
    scoreDefinitionId: string,
    revision: number,
  ) => Promise<ScoreResultRecord | undefined>;
  readonly listTraceScoreResults: (
    traceId: string,
    options: EvaluationPageOptions,
  ) => Promise<EvaluationPage<ScoreResultRecord>>;
  readonly listScoreResults: (
    options: EvaluationPageOptions & { readonly scoreDefinitionId?: string },
  ) => Promise<EvaluationPage<ScoreResultRecord>>;
  readonly createAnnotation: (data: AnnotationData) => Promise<AnnotationRecord>;
  readonly listAnnotations: (
    traceId: string,
    options: EvaluationPageOptions,
  ) => Promise<EvaluationPage<AnnotationRecord>>;
}

export function makeScoreResultPersistence(
  database: DynamoDatabaseService,
  scope: EvaluationScope,
): ScoreResultPersistence {
  const tracePartition = (traceId: string) => key("ORG", scope.organizationId, "TRACE", traceId);
  const scoreRecord = (data: ScoreResultData) =>
    canonicalRecord(ScoreResultRecord, { data, itemType: "score-result" });

  const getScoreResult = (traceId: string, scoreDefinitionId: string, revision: number) =>
    readScopedRecord(
      database,
      scope,
      "execution",
      {
        pk: tracePartition(traceId),
        sk: key("SCORE-RESULT", scoreDefinitionId, String(revision).padStart(16, "0")),
      },
      "score-result",
    );

  async function createOnce(record: ScoreResultRecord): Promise<RecordScoreResultOutcome> {
    const existing = await getScoreResult(
      record.data.traceId,
      record.data.scoreDefinitionId,
      record.data.revision,
    );
    if (existing) return { created: false, result: existing };
    try {
      await commitWithEvent(database, scope, [{ kind: "put", record }], undefined, "score write");
      return { created: true, result: record };
    } catch (cause) {
      const raced = await getScoreResult(
        record.data.traceId,
        record.data.scoreDefinitionId,
        record.data.revision,
      );
      if (raced) return { created: false, result: raced };
      throw cause;
    }
  }

  return {
    async recordAutomatedScore(data) {
      const record = scoreRecord(data);
      if (record.data.source === "api" || record.data.version !== 1) {
        invalidInput("invalid_score_result", "Automated scores are created once at version 1.");
      }
      if (record.data.scoreType === "human" || record.data.scoreType === "imported") {
        invalidInput(
          "invalid_score_result",
          "Human and imported scores are submitted, not automated.",
        );
      }
      return createOnce(record);
    },

    async recordSubmittedScore(data) {
      const candidate = scoreRecord(data);
      if (
        candidate.data.source !== "api" ||
        (candidate.data.scoreType !== "human" && candidate.data.scoreType !== "imported")
      ) {
        invalidInput(
          "invalid_score_result",
          "Only human and imported score definitions accept submitted scores.",
        );
      }
      const existing = await getScoreResult(
        candidate.data.traceId,
        candidate.data.scoreDefinitionId,
        candidate.data.revision,
      );
      if (!existing) return createOnce({ ...candidate, data: { ...candidate.data, version: 1 } });
      if (existing.data.source !== "api") {
        conflict(
          "score_result_conflict",
          "The trace already has an automated score for this revision.",
        );
      }
      if (existing.data.idempotencyKey === candidate.data.idempotencyKey) {
        return { created: false, result: existing };
      }
      const record = nextRecordVersion(
        existing,
        scoreRecord({
          ...candidate.data,
          createdAt: existing.data.createdAt,
          id: existing.data.id,
          version: existing.data.version + 1,
        }),
      );
      await commitWithEvent(
        database,
        scope,
        [{ kind: "put", previousRecord: existing, record }],
        undefined,
        "score supersession",
      );
      return { created: true, result: record };
    },

    getScoreResult,

    listTraceScoreResults: (traceId, options) =>
      queryScopedPage(database, scope, {
        itemType: "score-result",
        options,
        partition: tracePartition(traceId),
        prefix: "SCORE-RESULT#",
        table: "execution",
      }),

    listScoreResults: (options) =>
      options.scoreDefinitionId
        ? queryScopedPage(database, scope, {
            index: "gsi1",
            itemType: "score-result",
            newestFirst: true,
            options,
            partition: key(
              "ORG",
              scope.organizationId,
              "SCORE-DEFINITION",
              options.scoreDefinitionId,
              "SCORE-RESULTS",
            ),
            table: "execution",
          })
        : queryScopedPage(database, scope, {
            index: "gsi2",
            itemType: "score-result",
            newestFirst: true,
            options,
            partition: key("ENV", scope.environmentId),
            prefix: "SCORE-RESULT#",
            table: "execution",
          }),

    async createAnnotation(data) {
      const record = canonicalRecord(AnnotationRecord, { data, itemType: "annotation" });
      await commitWithEvent(
        database,
        scope,
        [{ kind: "put", record }],
        undefined,
        "annotation write",
      );
      return record;
    },

    listAnnotations: (traceId, options) =>
      queryScopedPage(database, scope, {
        itemType: "annotation",
        options,
        partition: tracePartition(traceId),
        prefix: "ANNOTATION#",
        table: "execution",
      }),
  };
}
