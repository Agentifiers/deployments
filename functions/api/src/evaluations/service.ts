import type { EvaluationApiRouteName } from "@deployments-ai/api-contract";
import { invokeReleaseComparisonRoute } from "./comparison-service.ts";
import { invokeDatasetRoute } from "./dataset-service.ts";
import { invokeScoreDefinitionRoute } from "./definition-service.ts";
import { invokeEvaluationRunRoute } from "./run-service.ts";
import { invokeScoreRoute } from "./score-service.ts";
import type {
  EvaluationApiInvocation,
  EvaluationApiService,
  EvaluationApiServiceDependencies,
} from "./service-contracts.ts";
import { evaluationRequestContext } from "./service-support.ts";

/** Dispatches the evaluation routes to their environment-scoped handlers. */
export function makeEvaluationApiService(
  dependencies: EvaluationApiServiceDependencies,
): EvaluationApiService {
  return {
    invoke: async (routeName: EvaluationApiRouteName, invocation: EvaluationApiInvocation) => {
      const context = evaluationRequestContext(dependencies, invocation);
      switch (routeName) {
        case "archiveScoreDefinition":
        case "createScoreDefinition":
        case "getScoreDefinition":
        case "listScoreDefinitions":
        case "reviseScoreDefinition":
          return invokeScoreDefinitionRoute(routeName, context);
        case "createTraceAnnotation":
        case "listScoreResults":
        case "listTraceAnnotations":
        case "listTraceScoreResults":
        case "recordTraceScoreResult":
          return invokeScoreRoute(routeName, context);
        case "addDatasetCase":
        case "archiveRegressionDataset":
        case "createRegressionDataset":
        case "getRegressionDataset":
        case "importDatasetCases":
        case "listDatasetCases":
        case "listRegressionDatasets":
          return invokeDatasetRoute(routeName, context);
        case "createEvaluationRun":
        case "getEvaluationRun":
        case "listEvaluationRunResults":
        case "listEvaluationRuns":
          return invokeEvaluationRunRoute(routeName, context);
        case "createReleaseComparison":
        case "getReleaseComparison":
        case "listReleaseComparisons":
          return invokeReleaseComparisonRoute(routeName, context);
      }
    },
  };
}
