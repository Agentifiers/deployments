import type { CommandCatalog } from "./types.ts";
import { action, requiredText, text } from "./catalog-helpers.ts";

const windowFilters = {
  from: text("Start of the bounded window (RFC 3339)", "query"),
  to: text("End of the bounded window (RFC 3339)", "query"),
} as const;

const traceFilters = {
  ...windowFilters,
  status: text("Terminal trace outcome", "query"),
  definition: { ...text("Root run agent definition ID", "query"), field: "agentDefinitionId" },
  deployment: { ...text("Root run agent deployment ID", "query"), field: "agentDeploymentId" },
  release: { ...text("Root run agent release ID", "query"), field: "agentReleaseId" },
  purpose: {
    ...text("Root run execution purpose: customer, preview, or evaluation", "query"),
    field: "executionPurpose",
  },
  "error-class": { ...text("Trace error class", "query"), field: "errorClass" },
} as const;

const traceColumns = [
  "trace_id",
  "status",
  "occurred_at",
  "agent_deployment_id",
  "duration_ms",
  "error_class",
  "total_tokens",
];

export const observabilityCommandCatalog: CommandCatalog = {
  trace: {
    summary: "Hot observability traces and execution trees",
    actions: {
      list: action({
        summary: "List and filter recent traces",
        method: "GET",
        path: "/v1/observability/traces",
        scope: "organization",
        output: "list",
        listField: "items",
        columns: traceColumns,
        pagination: { limitField: "limit", maxLimit: 100, target: "query" },
        args: traceFilters,
      }),
      show: action({
        summary: "Show a finalized trace",
        method: "GET",
        path: "/v1/observability/traces/:traceId",
        scope: "organization",
        output: "detail",
        args: {
          id: { ...requiredText("Trace ID", "path"), field: "traceId" },
        },
      }),
      spans: action({
        summary: "Render the spans in an execution trace",
        method: "GET",
        path: "/v1/observability/traces/:traceId/spans",
        scope: "organization",
        output: "list",
        listField: "items",
        columns: [
          "span_id",
          "name",
          "status",
          "duration_ms",
          "requested_model_id",
          "actual_model_id",
          "total_tokens",
          "cost_usd_micros",
        ],
        pagination: { limitField: "limit", maxLimit: 100, target: "query" },
        args: {
          id: { ...requiredText("Trace ID", "path"), field: "traceId" },
        },
      }),
      "for-run": action({
        summary: "Show the trace containing a run",
        method: "GET",
        path: "/v1/observability/runs/:runId/trace",
        scope: "organization",
        output: "detail",
        args: {
          run: { ...requiredText("Run ID", "path"), field: "runId" },
        },
      }),
      session: action({
        summary: "List traces for a session",
        method: "GET",
        path: "/v1/observability/sessions/:sessionId/traces",
        scope: "organization",
        output: "list",
        listField: "items",
        columns: traceColumns,
        pagination: { limitField: "limit", maxLimit: 100, target: "query" },
        args: {
          session: {
            ...requiredText("Session or thread ID", "path"),
            field: "sessionId",
          },
          ...traceFilters,
        },
      }),
    },
  },
  observability: {
    summary: "Hot observability metrics, tools, and exports",
    actions: {
      metrics: action({
        summary: "Show trace or model metrics by time bucket, optionally grouped",
        method: "GET",
        path: "/v1/observability/metrics",
        scope: "organization",
        output: "list",
        listField: "items",
        columns: [
          "bucket",
          "group_value",
          "trace_count",
          "invocation_count",
          "error_count",
          "total_tokens",
          "total_cost_usd_micros",
          "p95_duration_ms",
          "p95_latency_ms",
        ],
        args: {
          ...windowFilters,
          interval: text("Bucket width: hour or day", "query"),
          "group-by": {
            ...text(
              "Group by agentDefinitionId, agentDeploymentId, agentReleaseId, model, or provider",
              "query",
            ),
            field: "groupBy",
          },
        },
      }),
      tools: action({
        summary: "Show tool calls, errors, and latency",
        method: "GET",
        path: "/v1/observability/tools",
        scope: "organization",
        output: "list",
        listField: "items",
        columns: ["name", "calls", "errors", "p95_duration_ms"],
        args: {
          ...windowFilters,
          deployment: {
            ...text("Only tool calls of this agent deployment's runs", "query"),
            field: "agentDeploymentId",
          },
        },
      }),
      export: action({
        summary: "Export a bounded recent trace set",
        method: "POST",
        path: "/v1/observability/exports",
        scope: "organization",
        output: "detail",
        args: {
          limit: {
            definition: {
              type: "string",
              description: "Maximum exported traces",
            },
            target: "body",
            transform: "number",
          },
        },
      }),
    },
  },
};
