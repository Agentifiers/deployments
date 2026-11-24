import "@tanstack/react-start/server-only";
import type { RunLogFilters } from "../runs/run-logs.ts";
import type { EnvironmentScope } from "../scope.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";

export type RunLogPage = RouteResponse<"listRunLogs">;
export type RunLogEntry = RunLogPage["logs"][number];

/** One page of a run's runtime log; its cursor also continues after lines written later. */
export function loadRunLogPage(
  accessToken: string,
  scope: EnvironmentScope,
  runId: string,
  filters: RunLogFilters,
  cursor: string | undefined,
): Promise<RunLogPage> {
  return callRoute(
    "listRunLogs",
    {
      path: { runId },
      query: {
        cursor,
        level: filters.level,
        limit: 200,
        source: filters.source,
        toolCallId: filters.toolCallId,
      },
      scope,
    },
    accessToken,
  );
}
