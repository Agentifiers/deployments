import "@tanstack/react-start/server-only";
import type { AgentMutation } from "./agent-actions.ts";
import { scoreDefinitionView } from "./evaluation-data.ts";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

export function createRegressionDataset({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: AgentMutation) {
  return callRoute(
    "createRegressionDataset",
    {
      body: decodeRequestBody("createRegressionDataset", "CreateRegressionDatasetRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function importDatasetCases({
  accessToken,
  body,
  datasetId,
  idempotencyKey,
  scope,
}: AgentMutation & { readonly datasetId: string }) {
  return callRoute(
    "importDatasetCases",
    {
      body: decodeRequestBody("importDatasetCases", "ImportDatasetCasesRequest", body),
      idempotencyKey,
      path: { datasetId },
      scope,
    },
    accessToken,
  );
}

export function archiveRegressionDataset({
  accessToken,
  datasetId,
  idempotencyKey,
  scope,
}: Omit<AgentMutation, "body"> & { readonly datasetId: string }) {
  return callRoute(
    "archiveRegressionDataset",
    { idempotencyKey, path: { datasetId }, scope },
    accessToken,
  );
}

export async function createScoreDefinition({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: AgentMutation) {
  return scoreDefinitionView(
    await callRoute(
      "createScoreDefinition",
      {
        body: decodeRequestBody("createScoreDefinition", "CreateScoreDefinitionRequest", body),
        idempotencyKey,
        scope,
      },
      accessToken,
    ),
  );
}

export async function reviseScoreDefinition({
  accessToken,
  body,
  idempotencyKey,
  scope,
  scoreDefinitionId,
}: AgentMutation & { readonly scoreDefinitionId: string }) {
  return scoreDefinitionView(
    await callRoute(
      "reviseScoreDefinition",
      {
        body: decodeRequestBody("reviseScoreDefinition", "ReviseScoreDefinitionRequest", body),
        idempotencyKey,
        path: { scoreDefinitionId },
        scope,
      },
      accessToken,
    ),
  );
}

export function createEvaluationRun({ accessToken, body, idempotencyKey, scope }: AgentMutation) {
  return callRoute(
    "createEvaluationRun",
    {
      body: decodeRequestBody("createEvaluationRun", "CreateEvaluationRunRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function createReleaseComparison({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: AgentMutation) {
  return callRoute(
    "createReleaseComparison",
    {
      body: decodeRequestBody("createReleaseComparison", "CreateReleaseComparisonRequest", body),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}
