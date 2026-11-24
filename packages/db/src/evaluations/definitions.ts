import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { scoreDefinitionTypeForEvaluator } from "@deployments-ai/observability/evaluator-config";
import { key } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import { ScoreDefinitionRecord, ScoreDefinitionRevisionRecord } from "../records/evaluations.ts";
import {
  createBrainRecordOperations as createClaimedRecordOperations,
  updateBrainRecordOperations as updateClaimedRecordOperations,
} from "../brains/record-operations.ts";
import {
  canonicalRecord,
  commitWithEvent,
  conflict,
  invalidInput,
  nextRecordVersion,
  notFound,
  queryAllScoped,
  queryScopedPage,
  readScopedRecord,
  type EvaluationPage,
  type EvaluationPageOptions,
  type EvaluationPersistenceEvent,
  type EvaluationScope,
} from "./support.ts";

export type ScoreDefinitionData = ScoreDefinitionRecord["data"];
export type ScoreDefinitionRevisionData = ScoreDefinitionRevisionRecord["data"];

export interface ScoreDefinitionWithRevision {
  readonly definition: ScoreDefinitionRecord;
  readonly revision: ScoreDefinitionRevisionRecord;
}

/** Active definitions per environment; creation refuses more, and automatic scoring reads all. */
export const MAX_ACTIVE_SCORE_DEFINITIONS = 200;

export interface ScoreDefinitionPersistence {
  readonly createScoreDefinition: (
    input: {
      readonly definition: ScoreDefinitionData;
      readonly revision: ScoreDefinitionRevisionData;
    },
    event: EvaluationPersistenceEvent,
  ) => Promise<ScoreDefinitionWithRevision>;
  readonly reviseScoreDefinition: (
    input: {
      readonly expectedRevision: number;
      readonly revision: ScoreDefinitionRevisionData;
      readonly updatedAt: string;
    },
    event: EvaluationPersistenceEvent,
  ) => Promise<ScoreDefinitionWithRevision>;
  readonly archiveScoreDefinition: (
    input: { readonly archivedAt: string; readonly scoreDefinitionId: string },
    event: EvaluationPersistenceEvent,
  ) => Promise<ScoreDefinitionWithRevision>;
  readonly getScoreDefinition: (id: string) => Promise<ScoreDefinitionRecord | undefined>;
  readonly getScoreDefinitionRevision: (
    scoreDefinitionId: string,
    revision: number,
  ) => Promise<ScoreDefinitionRevisionRecord | undefined>;
  readonly listScoreDefinitions: (
    options: EvaluationPageOptions & { readonly status?: ScoreDefinitionData["status"] },
  ) => Promise<EvaluationPage<ScoreDefinitionRecord>>;
  /** Current active revisions in the environment, for automatic trace scoring. */
  readonly listActiveScoreDefinitionRevisions: () => Promise<
    readonly ScoreDefinitionRevisionRecord[]
  >;
}

export function makeScoreDefinitionPersistence(
  database: DynamoDatabaseService,
  scope: EvaluationScope,
): ScoreDefinitionPersistence {
  const environmentPartition = key("ORG", scope.organizationId, "ENV", scope.environmentId);
  const definitionRecord = (data: ScoreDefinitionData) =>
    canonicalRecord(ScoreDefinitionRecord, { data, itemType: "score-definition" });
  const revisionRecord = (data: ScoreDefinitionRevisionData) =>
    canonicalRecord(ScoreDefinitionRevisionRecord, {
      data,
      itemType: "score-definition-revision",
    });

  const getScoreDefinition = (id: string) =>
    readScopedRecord(
      database,
      scope,
      "control",
      { pk: environmentPartition, sk: key("SCORE-DEFINITION", id) },
      "score-definition",
    );

  const getScoreDefinitionRevision = (scoreDefinitionId: string, revision: number) =>
    readScopedRecord(
      database,
      scope,
      "control",
      {
        pk: key("ORG", scope.organizationId, "SCORE-DEFINITION", scoreDefinitionId),
        sk: key("SCORE-DEFINITION-REVISION", String(revision).padStart(16, "0")),
      },
      "score-definition-revision",
    );

  function assertRevisionBelongs(
    definition: ScoreDefinitionRecord,
    revision: ScoreDefinitionRevisionRecord,
  ) {
    if (revision.data.scoreDefinitionId !== definition.data.id) {
      invalidInput(
        "score_definition_revision_mismatch",
        "The revision belongs to another definition.",
      );
    }
  }

  async function currentPair(scoreDefinitionId: string) {
    const definition = await getScoreDefinition(scoreDefinitionId);
    if (!definition) notFound("score_definition_not_found", "Score definition not found.");
    const revision = await getScoreDefinitionRevision(
      scoreDefinitionId,
      definition.data.currentRevision,
    );
    if (!revision) {
      notFound("score_definition_revision_not_found", "Score definition revision not found.");
    }
    return { definition, revision };
  }

  /** Counts active definitions, stopping once the cap is reached. */
  async function activeDefinitionCount() {
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await queryScopedPage(database, scope, {
        index: "gsi2",
        itemType: "score-definition",
        options: { cursor, limit: 100 },
        partition: key("ENV", scope.environmentId),
        prefix: `${key("SCORE-DEFINITION", "active")}#`,
        table: "control",
      });
      count += page.items.length;
      cursor = page.nextCursor;
    } while (cursor && count < MAX_ACTIVE_SCORE_DEFINITIONS);
    return count;
  }

  return {
    async createScoreDefinition(input, event) {
      const definition = definitionRecord(input.definition);
      const revision = revisionRecord(input.revision);
      assertRevisionBelongs(definition, revision);
      if (scoreDefinitionTypeForEvaluator(revision.data.evaluator) !== definition.data.type) {
        invalidInput(
          "score_definition_type_mismatch",
          "The score definition type must match its evaluator.",
        );
      }
      if (
        definition.data.version !== 1 ||
        revision.data.version !== 1 ||
        definition.data.currentRevision !== 1 ||
        revision.data.revision !== 1 ||
        definition.data.status !== "active" ||
        revision.data.status !== "active"
      ) {
        invalidInput(
          "invalid_score_definition",
          "New score definitions start active at version 1 with revision 1.",
        );
      }
      if ((await activeDefinitionCount()) >= MAX_ACTIVE_SCORE_DEFINITIONS) {
        throw new PersistenceError(
          "unprocessable",
          "score_definition_limit_reached",
          `An environment can have at most ${MAX_ACTIVE_SCORE_DEFINITIONS} active score definitions; archive one first.`,
        );
      }
      const operations: TransactionOperation[] = [
        ...createClaimedRecordOperations(definition, definition.data.createdAt),
        { kind: "put", record: revision },
      ];
      await commitWithEvent(
        database,
        scope,
        operations,
        {
          aggregateId: definition.data.id,
          aggregateType: "score_definition",
          aggregateVersion: definition.data.version,
          event,
        },
        "score definition create",
      );
      return { definition, revision };
    },

    async reviseScoreDefinition(input, event) {
      const { definition: previousDefinition, revision: previousRevision } = await currentPair(
        input.revision.scoreDefinitionId,
      );
      if (previousDefinition.data.status !== "active") {
        conflict("score_definition_archived", "Archived score definitions cannot be revised.");
      }
      if (previousDefinition.data.currentRevision !== input.expectedRevision) {
        conflict(
          "score_definition_revision_conflict",
          "The score definition was revised concurrently; reload and retry.",
        );
      }
      const revision = revisionRecord(input.revision);
      if (
        revision.data.revision !== previousDefinition.data.currentRevision + 1 ||
        revision.data.version !== 1 ||
        revision.data.status !== "active"
      ) {
        invalidInput(
          "invalid_score_definition_revision",
          "A new revision must be the next revision number, active, at version 1.",
        );
      }
      if (
        scoreDefinitionTypeForEvaluator(revision.data.evaluator) !== previousDefinition.data.type
      ) {
        invalidInput(
          "score_definition_type_change",
          "A revision cannot change the score definition type.",
        );
      }
      const definition = nextRecordVersion(
        previousDefinition,
        definitionRecord({
          ...previousDefinition.data,
          currentRevision: revision.data.revision,
          updatedAt: input.updatedAt,
          version: previousDefinition.data.version + 1,
        }),
      );
      const superseded = nextRecordVersion(
        previousRevision,
        revisionRecord({
          ...previousRevision.data,
          status: "superseded",
          supersededAt: input.updatedAt,
          updatedAt: input.updatedAt,
          version: previousRevision.data.version + 1,
        }),
      );
      await commitWithEvent(
        database,
        scope,
        [
          ...updateClaimedRecordOperations(previousDefinition, definition, input.updatedAt),
          { kind: "put", previousRecord: previousRevision, record: superseded },
          { kind: "put", record: revision },
        ],
        {
          aggregateId: definition.data.id,
          aggregateType: "score_definition",
          aggregateVersion: definition.data.version,
          event,
        },
        "score definition revision",
      );
      return { definition, revision };
    },

    async archiveScoreDefinition(input, event) {
      const { definition: previousDefinition, revision: previousRevision } = await currentPair(
        input.scoreDefinitionId,
      );
      if (previousDefinition.data.status === "archived") {
        return { definition: previousDefinition, revision: previousRevision };
      }
      const definition = nextRecordVersion(
        previousDefinition,
        definitionRecord({
          ...previousDefinition.data,
          archivedAt: input.archivedAt,
          status: "archived",
          updatedAt: input.archivedAt,
          version: previousDefinition.data.version + 1,
        }),
      );
      const revision = nextRecordVersion(
        previousRevision,
        revisionRecord({
          ...previousRevision.data,
          status: "archived",
          updatedAt: input.archivedAt,
          version: previousRevision.data.version + 1,
        }),
      );
      await commitWithEvent(
        database,
        scope,
        [
          ...updateClaimedRecordOperations(previousDefinition, definition, input.archivedAt),
          { kind: "put", previousRecord: previousRevision, record: revision },
        ],
        {
          aggregateId: definition.data.id,
          aggregateType: "score_definition",
          aggregateVersion: definition.data.version,
          event,
        },
        "score definition archive",
      );
      return { definition, revision };
    },

    getScoreDefinition,
    getScoreDefinitionRevision,

    listScoreDefinitions: (options) =>
      queryScopedPage(database, scope, {
        index: "gsi2",
        itemType: "score-definition",
        newestFirst: true,
        options,
        partition: key("ENV", scope.environmentId),
        prefix: `${options.status ? key("SCORE-DEFINITION", options.status) : "SCORE-DEFINITION"}#`,
        table: "control",
      }),

    listActiveScoreDefinitionRevisions: () =>
      queryAllScoped(
        database,
        scope,
        {
          index: "gsi2",
          itemType: "score-definition-revision",
          partition: key("ENV", scope.environmentId),
          prefix: `${key("SCORE-DEFINITION-REVISION", "active")}#`,
          table: "control",
        },
        MAX_ACTIVE_SCORE_DEFINITIONS,
      ),
  };
}
