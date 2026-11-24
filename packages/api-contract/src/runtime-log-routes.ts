import { RUNTIME_LOG_LEVELS, RUNTIME_LOG_SOURCES } from "@deployments-ai/observability";
import { runtimeFilteredListErrors } from "./runtime-page-contracts.ts";

export const runtimeLogRoutes = [
  {
    authentication: "api-credential-or-platform-bearer",
    errors: runtimeFilteredListErrors,
    idempotency: "none",
    method: "GET",
    name: "listRunLogs",
    path: "/v1/runs/:runId/logs",
    queryParameters: [
      {
        description: "Opaque cursor returned by the previous page.",
        name: "cursor",
        schema: { maxLength: 4_096, minLength: 1, type: "string" },
      },
      {
        description: "Maximum number of lines to return.",
        name: "limit",
        schema: { maximum: 500, minimum: 1, type: "integer" },
      },
      {
        description: "Only lines at this level or more severe.",
        name: "level",
        schema: { enum: [...RUNTIME_LOG_LEVELS], type: "string" },
      },
      {
        description: "Only lines from this source.",
        name: "source",
        schema: { enum: [...RUNTIME_LOG_SOURCES], type: "string" },
      },
      {
        description: "Only lines written by this tool call.",
        name: "toolCallId",
        schema: { maxLength: 26, minLength: 26, type: "string" },
      },
      {
        description: "Only lines written at or after this time (RFC 3339).",
        name: "from",
        schema: { format: "date-time", type: "string" },
      },
      {
        description: "Only lines written before this time (RFC 3339).",
        name: "to",
        schema: { format: "date-time", type: "string" },
      },
    ],
    requiredAuthorization: "runs:read",
    requiredScope: "runs:read",
    responseBody: "ListRunLogsResponse",
    responseContentType: "application/json",
    scopeHeaders: "optional-tenant",
    successStatus: 200,
    tag: "Runtime",
  },
] as const;
