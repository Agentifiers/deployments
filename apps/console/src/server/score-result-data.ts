import "@tanstack/react-start/server-only";
import type { EnvironmentScope } from "../scope.ts";
import { scoreDefinitionView, type ScoreDefinition } from "./evaluation-data.ts";
import { fillPage, PAGE_SIZE, type Page } from "./list-pages.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";

export type ScoreResult = RouteResponse<"listScoreResults">["items"][number];
export type AddedDatasetCase = RouteResponse<"addDatasetCase">;

/** One scorer's results, newest first. */
export function loadScoreResultPage(
  accessToken: string,
  scope: EnvironmentScope,
  scoreDefinitionId: string,
  cursor: string | undefined,
): Promise<Page<ScoreResult>> {
  return fillPage(
    (pageCursor, limit) =>
      callRoute(
        "listScoreResults",
        { query: { cursor: pageCursor, limit, scoreDefinitionId }, scope },
        accessToken,
      ),
    cursor,
    PAGE_SIZE,
  );
}

export async function archiveScoreDefinition(
  accessToken: string,
  scope: EnvironmentScope,
  scoreDefinitionId: string,
  idempotencyKey: string,
): Promise<ScoreDefinition> {
  return scoreDefinitionView(
    await callRoute(
      "archiveScoreDefinition",
      { idempotencyKey, path: { scoreDefinitionId }, scope },
      accessToken,
    ),
  );
}

/** Captures the user input of a trace's root run as a new case; `created` is false on a repeat. */
export function addTraceToDataset(
  accessToken: string,
  scope: EnvironmentScope,
  datasetId: string,
  traceId: string,
  idempotencyKey: string,
): Promise<AddedDatasetCase> {
  return callRoute(
    "addDatasetCase",
    {
      body: { source: { traceId, type: "trace" } },
      idempotencyKey,
      path: { datasetId },
      scope,
    },
    accessToken,
  );
}
