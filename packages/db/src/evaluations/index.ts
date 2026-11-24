import type { DynamoDatabaseService } from "../client-types.ts";
import { makeRegressionDatasetPersistence, type RegressionDatasetPersistence } from "./datasets.ts";
import { makeScoreDefinitionPersistence, type ScoreDefinitionPersistence } from "./definitions.ts";
import {
  makeEvaluationEvidencePersistence,
  type EvaluationEvidencePersistence,
} from "./evidence.ts";
import { makeEvaluationRunPersistence, type EvaluationRunPersistence } from "./runs.ts";
import { makeScoreResultPersistence, type ScoreResultPersistence } from "./scores.ts";
import type { EvaluationScope } from "./support.ts";

export * from "./datasets.ts";
export * from "./definitions.ts";
export * from "./evidence.ts";
export * from "./runs.ts";
export * from "./scores.ts";
export type {
  EvaluationPage,
  EvaluationPageOptions,
  EvaluationPersistenceEvent,
  EvaluationScope,
} from "./support.ts";

export type EvaluationPersistence = ScoreDefinitionPersistence &
  RegressionDatasetPersistence &
  EvaluationRunPersistence &
  ScoreResultPersistence &
  EvaluationEvidencePersistence;

/** Environment-scoped persistence for score definitions, datasets, evaluation runs, and scores. */
export function makeEvaluationPersistence(
  database: DynamoDatabaseService,
  scope: EvaluationScope,
): EvaluationPersistence {
  return {
    ...makeScoreDefinitionPersistence(database, scope),
    ...makeRegressionDatasetPersistence(database, scope),
    ...makeEvaluationRunPersistence(database, scope),
    ...makeScoreResultPersistence(database, scope),
    ...makeEvaluationEvidencePersistence(database, scope),
  };
}
