import type { ActionSpec, CommandArgument, CommandCatalog } from "./types.ts";
import {
  action,
  csv,
  json,
  number,
  requiredCsv,
  requiredJson,
  requiredNumber,
  requiredText,
  text,
} from "./catalog-helpers.ts";

const pagination = { limitField: "limit", maxLimit: 100, target: "query" } as const;

const pathId = (description: string, field: string): CommandArgument => ({
  ...requiredText(description, "path"),
  field,
});
const withField = (argument: CommandArgument, field: string): CommandArgument => ({
  ...argument,
  field,
});

const statusFilter = text("Only active or archived resources", "query");
const traceArg = pathId("Trace ID (32 lowercase hex characters)", "traceId");
const datasetArg = pathId("Regression dataset ID", "datasetId");
const runArg = pathId("Evaluation run ID", "evaluationRunId");
const scoreDefinitionArg = pathId("Score definition ID", "scoreDefinitionId");
const scoreDefinitionConfiguration = {
  evaluator: requiredJson('Evaluator configuration, for example {"kind":"contains"}'),
  sampling: json('Automatic sampling policy, for example {"rate":0.1}'),
  target: text("Scored target: root-run or trace"),
  threshold: number("Minimum passing value between 0 and 1"),
  weight: number("Relative weight between 0 and 100"),
} as const;
const replayControls = {
  concurrency: number("Cases replayed in parallel (1-20)"),
  "case-timeout": withField(number("Per-case timeout in seconds (30-3600)"), "caseTimeoutSeconds"),
} as const;
const scoreDefinitionIds = withField(
  requiredCsv("Score definition IDs to evaluate"),
  "scoreDefinitionIds",
);

const tenantAction = (spec: Omit<ActionSpec, "scope">): ActionSpec =>
  action({ ...spec, scope: "tenant", ...(spec.method === "POST" ? { idempotent: true } : {}) });

export const evaluationCommandCatalog: CommandCatalog = {
  "eval-score-definition": {
    summary: "Versioned score definitions used to evaluate agent behavior",
    namespace: { name: "eval", command: "score-definition" },
    actions: {
      create: tenantAction({
        summary: "Create a score definition",
        method: "POST",
        path: "/v1/score-definitions",
        output: "detail",
        args: {
          name: requiredText("Score definition name"),
          description: text("Score definition description"),
          ...scoreDefinitionConfiguration,
        },
      }),
      list: tenantAction({
        summary: "List score definitions",
        method: "GET",
        path: "/v1/score-definitions",
        output: "list",
        listField: "items",
        columns: ["id", "name", "type", "currentRevision", "status"],
        pagination,
        args: { status: statusFilter },
      }),
      show: tenantAction({
        summary: "Show a score definition",
        method: "GET",
        path: "/v1/score-definitions/:scoreDefinitionId",
        output: "detail",
        args: { id: scoreDefinitionArg },
      }),
      revise: tenantAction({
        summary: "Publish a new score definition revision",
        method: "POST",
        path: "/v1/score-definitions/:scoreDefinitionId/revisions",
        output: "detail",
        args: {
          id: scoreDefinitionArg,
          "expected-revision": requiredNumber("Revision the change is based on"),
          ...scoreDefinitionConfiguration,
        },
      }),
      archive: tenantAction({
        summary: "Archive a score definition",
        method: "POST",
        path: "/v1/score-definitions/:scoreDefinitionId/archive",
        output: "detail",
        destructive: true,
        args: { id: scoreDefinitionArg },
      }),
    },
  },
  "eval-score": {
    summary: "Score results recorded against traces",
    namespace: { name: "eval", command: "score" },
    actions: {
      list: tenantAction({
        summary: "List recent score results",
        method: "GET",
        path: "/v1/score-results",
        output: "list",
        listField: "items",
        columns: ["id", "scoreDefinitionId", "traceId", "value", "passed", "source"],
        pagination,
        args: {
          "score-definition": withField(
            text("Only results for this score definition", "query"),
            "scoreDefinitionId",
          ),
        },
      }),
      trace: tenantAction({
        summary: "List score results for a trace",
        method: "GET",
        path: "/v1/traces/:traceId/score-results",
        output: "list",
        listField: "items",
        columns: ["id", "scoreDefinitionId", "value", "passed", "source", "createdAt"],
        pagination,
        args: { trace: traceArg },
      }),
      record: tenantAction({
        summary: "Record a human or imported score for a trace",
        method: "POST",
        path: "/v1/traces/:traceId/score-results",
        output: "detail",
        args: {
          trace: traceArg,
          "score-definition": withField(requiredText("Score definition ID"), "scoreDefinitionId"),
          value: requiredNumber("Score value between 0 and 1"),
          label: text("Score label"),
          rationale: text("Why this score was given"),
          run: withField(text("Run ID within the trace"), "runId"),
          span: withField(text("Span ID within the trace"), "spanId"),
        },
      }),
    },
  },
  "eval-annotation": {
    summary: "Reviewer annotations on traces",
    namespace: { name: "eval", command: "annotation" },
    actions: {
      list: tenantAction({
        summary: "List annotations for a trace",
        method: "GET",
        path: "/v1/traces/:traceId/annotations",
        output: "list",
        listField: "items",
        columns: ["id", "label", "body", "authorPrincipalId", "createdAt"],
        pagination,
        args: { trace: traceArg },
      }),
      create: tenantAction({
        summary: "Annotate a trace",
        method: "POST",
        path: "/v1/traces/:traceId/annotations",
        output: "detail",
        args: {
          trace: traceArg,
          body: requiredText("Annotation text"),
          label: text("Annotation label"),
          tags: csv("Annotation tags"),
          run: withField(text("Run ID within the trace"), "runId"),
          span: withField(text("Span ID within the trace"), "spanId"),
        },
      }),
    },
  },
  "eval-dataset": {
    summary: "Regression datasets of replayable cases",
    namespace: { name: "eval", command: "dataset" },
    actions: {
      create: tenantAction({
        summary: "Create a regression dataset",
        method: "POST",
        path: "/v1/regression-datasets",
        output: "detail",
        args: {
          name: requiredText("Regression dataset name"),
          description: text("Regression dataset description"),
          "retention-days": number("Days to retain captured cases (1-3650)"),
        },
      }),
      list: tenantAction({
        summary: "List regression datasets",
        method: "GET",
        path: "/v1/regression-datasets",
        output: "list",
        listField: "items",
        columns: ["id", "name", "caseCount", "status", "updatedAt"],
        pagination,
        args: { status: statusFilter },
      }),
      show: tenantAction({
        summary: "Show a regression dataset",
        method: "GET",
        path: "/v1/regression-datasets/:datasetId",
        output: "detail",
        args: { id: datasetArg },
      }),
      archive: tenantAction({
        summary: "Archive a regression dataset",
        method: "POST",
        path: "/v1/regression-datasets/:datasetId/archive",
        output: "detail",
        destructive: true,
        args: { id: datasetArg },
      }),
    },
  },
  "eval-case": {
    summary: "Cases in a regression dataset",
    namespace: { name: "eval", command: "case" },
    actions: {
      add: tenantAction({
        summary: "Add one case from inline input or an existing run or trace",
        method: "POST",
        path: "/v1/regression-datasets/:datasetId/cases",
        output: "detail",
        args: {
          dataset: datasetArg,
          input: json('Inline input, for example {"content":"Where is my refund?"}'),
          source: json('Captured source, for example {"type":"trace","traceId":"..."}'),
          expectations: json('Expected behavior, for example {"mustInclude":["refund"]}'),
          "external-id": text("Stable external case ID"),
          tags: csv("Case tags"),
          "consent-basis": text("Consent basis for captured customer content"),
        },
      }),
      import: tenantAction({
        summary: "Import cases from a JSON case file",
        method: "POST",
        path: "/v1/regression-datasets/:datasetId/cases/import",
        output: "detail",
        args: {
          dataset: datasetArg,
          file: {
            definition: {
              type: "string",
              description:
                "JSON array of { id?, message, expected?: { mustInclude?, mustNot?, mustUseTools?, mustNotUseTools?, matches?, jsonSchema? }, tags? }",
              required: true,
              valueHint: "path",
            },
            target: "control",
          },
        },
        fileInputs: [{ argument: "file", bodyField: "cases", format: "json", required: true }],
      }),
      list: tenantAction({
        summary: "List cases in a regression dataset",
        method: "GET",
        path: "/v1/regression-datasets/:datasetId/cases",
        output: "list",
        listField: "items",
        columns: ["id", "externalId", "provenance", "inputPreview", "expectationKinds"],
        pagination,
        args: { dataset: datasetArg },
      }),
    },
  },
  "eval-run": {
    summary: "Evaluation runs that replay datasets or score traces",
    namespace: { name: "eval", command: "run" },
    actions: {
      create: tenantAction({
        summary: "Start a dataset replay or trace scoring run",
        method: "POST",
        path: "/v1/evaluation-runs",
        output: "detail",
        args: {
          kind: requiredText("Run kind: dataset-replay or trace-score"),
          "score-definitions": scoreDefinitionIds,
          dataset: withField(text("Regression dataset ID (dataset-replay)"), "datasetId"),
          target: json(
            'Replay target (dataset-replay), for example {"type":"release","agentReleaseId":"..."}',
          ),
          "trace-ids": withField(csv("Trace IDs to score (trace-score)"), "traceIds"),
          ...replayControls,
        },
      }),
      list: tenantAction({
        summary: "List evaluation runs, newest first",
        method: "GET",
        path: "/v1/evaluation-runs",
        output: "list",
        listField: "items",
        columns: ["id", "kind", "status", "datasetId", "caseCount", "createdAt"],
        pagination,
        args: {
          status: text(
            "Only runs in this status: queued, running, completed, failed, or canceled",
            "query",
          ),
          dataset: withField(text("Only replays of this regression dataset", "query"), "datasetId"),
          release: withField(
            text("Only replays whose target is this agent release", "query"),
            "agentReleaseId",
          ),
        },
      }),
      show: tenantAction({
        summary: "Show an evaluation run and its summary",
        method: "GET",
        path: "/v1/evaluation-runs/:evaluationRunId",
        output: "detail",
        args: { id: runArg },
      }),
      results: tenantAction({
        summary: "List per-case results of an evaluation run",
        method: "GET",
        path: "/v1/evaluation-runs/:evaluationRunId/results",
        output: "list",
        listField: "items",
        columns: ["caseKey", "status", "latencyMs", "totalTokens", "traceId"],
        pagination,
        args: { id: runArg },
      }),
    },
  },
  "eval-comparison": {
    summary: "Advisory baseline versus candidate release comparisons",
    namespace: { name: "eval", command: "comparison" },
    actions: {
      create: tenantAction({
        summary: "Compare a candidate release against a baseline on a dataset",
        method: "POST",
        path: "/v1/release-comparisons",
        output: "detail",
        args: {
          baseline: withField(requiredText("Baseline agent release ID"), "baselineReleaseId"),
          candidate: withField(requiredText("Candidate agent release ID"), "candidateReleaseId"),
          dataset: withField(requiredText("Regression dataset ID"), "datasetId"),
          "score-definitions": scoreDefinitionIds,
          "gate-policy": json('Gate thresholds, for example {"maxNewFailures":0}'),
          "runtime-config-from": withField(
            text("Agent deployment whose runtime configuration both releases use"),
            "runtimeConfigFromAgentDeploymentId",
          ),
          ...replayControls,
        },
      }),
      list: tenantAction({
        summary: "List release comparisons, newest first",
        method: "GET",
        path: "/v1/release-comparisons",
        output: "list",
        listField: "items",
        columns: ["id", "status", "verdict", "datasetId", "createdAt"],
        pagination,
        args: {
          status: text(
            "Only comparisons in this status: queued, running, completed, or failed",
            "query",
          ),
          baseline: withField(
            text("Only comparisons with this baseline release", "query"),
            "baselineReleaseId",
          ),
          candidate: withField(
            text("Only comparisons with this candidate release", "query"),
            "candidateReleaseId",
          ),
        },
      }),
      show: tenantAction({
        summary: "Show a release comparison and its verdict",
        method: "GET",
        path: "/v1/release-comparisons/:releaseComparisonId",
        output: "detail",
        args: { id: pathId("Release comparison ID", "releaseComparisonId") },
      }),
    },
  },
};
