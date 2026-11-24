import type {
  AddDatasetCaseRequest,
  CreateRegressionDatasetRequest,
  ImportDatasetCasesRequest,
} from "@deployments-ai/api-contract";
import {
  MAX_DATASET_CASES_PER_WRITE,
  type DatasetCaseData,
  type DatasetCaseRecord,
  type RegressionDatasetRecord,
} from "@deployments-ai/db";
import {
  expectationsFromCaseFile,
  MAX_CASE_INPUT_LENGTH,
  prepareCaseMaterial,
  type PreparedCaseMaterial,
} from "@deployments-ai/observability/evaluators";
import { failure } from "../persistence-failure.ts";
import { datasetCaseResponse, regressionDatasetResponse } from "./responses.ts";
import {
  evaluationEvent,
  pageOptions,
  requiredParam,
  statusFilter,
  ulid,
  type EvaluationRequestContext,
} from "./service-support.ts";

/** UTF-8 encodes at most four bytes per character of the bounded case input. */
const MAX_CASE_INPUT_BYTES = MAX_CASE_INPUT_LENGTH * 4;

type CaseSource = Pick<
  DatasetCaseData,
  "consentBasis" | "externalId" | "provenance" | "sourceRunId" | "sourceThreadId" | "sourceTraceId"
> & { readonly tags?: readonly string[] | undefined };

export async function requireActiveDataset(
  context: EvaluationRequestContext,
  datasetId: string,
): Promise<RegressionDatasetRecord> {
  const dataset =
    (await context.persistence.getRegressionDataset(datasetId)) ??
    failure("not-found", "regression_dataset_not_found", "Regression dataset not found.");
  if (dataset.data.status !== "active") {
    failure("conflict", "regression_dataset_archived", "The regression dataset is archived.");
  }
  return dataset;
}

/** The user input that started a run, read inline or from the artifact store. */
async function runUserInput(context: EvaluationRequestContext, threadId: string, runId: string) {
  const run =
    (await context.persistence.getRun(threadId, runId)) ??
    failure("not-found", "run_not_found", "Run not found.");
  const messages = await context.persistence.listRunMessages(run);
  const message = messages.find(
    (candidate) =>
      candidate.data.role === "user" &&
      (run.data.userMessageId
        ? candidate.data.id === run.data.userMessageId
        : candidate.data.runId === runId),
  );
  const content =
    message?.data.body ??
    (message?.data.bodyRef
      ? await context.dependencies.artifacts.readText(message.data.bodyRef, MAX_CASE_INPUT_BYTES)
      : undefined);
  if (content === undefined) {
    failure("unprocessable", "run_input_unavailable", "The run has no user input to capture.");
  }
  return { content, run };
}

async function caseRecordData(
  context: EvaluationRequestContext,
  datasetId: string,
  prepared: PreparedCaseMaterial,
  source: CaseSource,
): Promise<DatasetCaseData> {
  const material = await context.dependencies.artifacts.putCaseMaterial({
    bytes: prepared.bytes,
    contentSha256: prepared.contentSha256,
    datasetId,
    organizationId: context.scope.organizationId,
  });
  return {
    ...(source.consentBasis === undefined ? {} : { consentBasis: source.consentBasis }),
    contentSha256: prepared.contentSha256,
    createdAt: context.timestamp,
    createdByPrincipalId: context.principalId,
    datasetId: ulid(datasetId),
    environmentId: context.scope.environmentId,
    expectationKinds: prepared.expectationKinds,
    ...(source.externalId === undefined ? {} : { externalId: source.externalId }),
    id: await context.newId(),
    inputPreview: prepared.inputPreview,
    material,
    organizationId: context.scope.organizationId,
    projectId: context.scope.projectId,
    provenance: source.provenance,
    ...(source.sourceRunId === undefined ? {} : { sourceRunId: source.sourceRunId }),
    ...(source.sourceThreadId === undefined ? {} : { sourceThreadId: source.sourceThreadId }),
    ...(source.sourceTraceId === undefined ? {} : { sourceTraceId: source.sourceTraceId }),
    tags: source.tags ?? [],
  };
}

/**
 * Writes content-addressed cases: content already in the dataset is reused without another
 * upload, and new material is stored before its case record commits. Returns one entry per
 * distinct content hash with whether this request created it.
 */
async function writeCases(
  context: EvaluationRequestContext,
  datasetId: string,
  cases: readonly { readonly prepared: PreparedCaseMaterial; readonly source: CaseSource }[],
) {
  const outcomes = new Map<
    string,
    { readonly created: boolean; readonly record: DatasetCaseRecord }
  >();
  const existing = await context.persistence.findDatasetCasesByContent(
    datasetId,
    cases.map((entry) => entry.prepared.contentSha256),
  );
  for (const [contentSha256, record] of existing)
    outcomes.set(contentSha256, { created: false, record });
  const pending: DatasetCaseData[] = [];
  const queued = new Set<string>();
  for (const entry of cases) {
    const contentSha256 = entry.prepared.contentSha256;
    if (outcomes.has(contentSha256) || queued.has(contentSha256)) continue;
    queued.add(contentSha256);
    pending.push(await caseRecordData(context, datasetId, entry.prepared, entry.source));
  }
  for (let offset = 0; offset < pending.length; offset += MAX_DATASET_CASES_PER_WRITE) {
    const chunk = pending.slice(offset, offset + MAX_DATASET_CASES_PER_WRITE);
    const result = await context.persistence.addDatasetCases(
      { cases: chunk, datasetId, updatedAt: context.timestamp },
      await evaluationEvent(context, "regression-dataset.cases-added", {
        caseCount: chunk.length,
        datasetId,
        status: "active",
      }),
    );
    for (const record of result.created) {
      outcomes.set(record.data.contentSha256, { created: true, record });
    }
    for (const record of result.existing) {
      outcomes.set(record.data.contentSha256, { created: false, record });
    }
  }
  return outcomes;
}

async function addDatasetCase(context: EvaluationRequestContext) {
  const body = context.invocation.body as AddDatasetCaseRequest;
  const datasetId = requiredParam(context, "datasetId");
  await requireActiveDataset(context, datasetId);
  const metadata = {
    consentBasis: body.consentBasis,
    externalId: body.externalId,
    tags: body.tags,
  };
  let content: string;
  let source: CaseSource;
  if (body.input) {
    content = body.input.content;
    source = { ...metadata, provenance: "manual" };
  } else if (body.source?.type === "run") {
    const captured = await runUserInput(context, body.source.threadId, body.source.runId);
    content = captured.content;
    source = {
      ...metadata,
      provenance: "trace",
      sourceRunId: captured.run.data.id,
      sourceThreadId: captured.run.data.threadId,
      sourceTraceId: captured.run.data.traceId,
    };
  } else if (body.source?.type === "trace") {
    const trace =
      (await context.persistence.getTrace(body.source.traceId)) ??
      failure("not-found", "trace_not_found", "Trace not found.");
    const captured = await runUserInput(context, trace.data.sessionId, trace.data.rootRunId);
    content = captured.content;
    source = {
      ...metadata,
      provenance: "trace",
      sourceRunId: trace.data.rootRunId,
      sourceThreadId: trace.data.sessionId,
      sourceTraceId: trace.data.traceId,
    };
  } else {
    failure("invalid-input", "invalid_dataset_case", "Provide exactly one of input or source.");
  }
  const prepared = prepareCaseMaterial({ content, expectations: body.expectations ?? {} });
  const outcomes = await writeCases(context, datasetId, [{ prepared, source }]);
  const outcome = outcomes.get(prepared.contentSha256)!;
  return { case: datasetCaseResponse(outcome.record), created: outcome.created };
}

async function importDatasetCases(context: EvaluationRequestContext) {
  const body = context.invocation.body as ImportDatasetCasesRequest;
  const datasetId = requiredParam(context, "datasetId");
  await requireActiveDataset(context, datasetId);
  const entries = body.cases.map((imported) => {
    const { consentBasis, expected, id, message, tags, ...extraFields } = imported;
    const expectations = expectationsFromCaseFile(expected, extraFields);
    return {
      externalId: id,
      prepared: prepareCaseMaterial({ content: message, expectations }),
      source: { consentBasis, externalId: id, provenance: "import" as const, tags },
    };
  });
  const outcomes = await writeCases(context, datasetId, entries);
  const reported = new Set<string>();
  const items = entries.map((entry) => {
    const outcome = outcomes.get(entry.prepared.contentSha256)!;
    const created = outcome.created && !reported.has(entry.prepared.contentSha256);
    reported.add(entry.prepared.contentSha256);
    return {
      case: datasetCaseResponse(outcome.record),
      created,
      ...(entry.externalId === undefined ? {} : { externalId: entry.externalId }),
    };
  });
  const created = items.filter((item) => item.created).length;
  return { created, existing: items.length - created, items };
}

export async function invokeDatasetRoute(
  routeName:
    | "addDatasetCase"
    | "archiveRegressionDataset"
    | "createRegressionDataset"
    | "getRegressionDataset"
    | "importDatasetCases"
    | "listDatasetCases"
    | "listRegressionDatasets",
  context: EvaluationRequestContext,
) {
  const { persistence } = context;
  switch (routeName) {
    case "createRegressionDataset": {
      const body = context.invocation.body as CreateRegressionDatasetRequest;
      const id = await context.newId();
      const dataset = await persistence.createRegressionDataset(
        {
          caseCount: 0,
          createdAt: context.timestamp,
          createdByPrincipalId: context.principalId,
          ...(body.description === undefined ? {} : { description: body.description }),
          environmentId: context.scope.environmentId,
          id,
          name: body.name,
          organizationId: context.scope.organizationId,
          ownerPrincipalId: context.principalId,
          projectId: context.scope.projectId,
          ...(body.retentionDays === undefined ? {} : { retentionDays: body.retentionDays }),
          status: "active",
          updatedAt: context.timestamp,
          version: 1,
        },
        await evaluationEvent(context, "regression-dataset.created", {
          datasetId: id,
          status: "active",
        }),
      );
      return regressionDatasetResponse(dataset);
    }
    case "archiveRegressionDataset": {
      const datasetId = requiredParam(context, "datasetId");
      const dataset = await persistence.archiveRegressionDataset(
        { archivedAt: context.timestamp, datasetId },
        await evaluationEvent(context, "regression-dataset.archived", {
          datasetId,
          status: "archived",
        }),
      );
      return regressionDatasetResponse(dataset);
    }
    case "getRegressionDataset": {
      const dataset =
        (await persistence.getRegressionDataset(requiredParam(context, "datasetId"))) ??
        failure("not-found", "regression_dataset_not_found", "Regression dataset not found.");
      return regressionDatasetResponse(dataset);
    }
    case "listRegressionDatasets": {
      const page = await persistence.listRegressionDatasets({
        ...pageOptions(context),
        ...statusFilter<RegressionDatasetRecord["data"]["status"]>(context),
      });
      return {
        items: page.items.map(regressionDatasetResponse),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    }
    case "addDatasetCase":
      return addDatasetCase(context);
    case "importDatasetCases":
      return importDatasetCases(context);
    case "listDatasetCases": {
      const datasetId = requiredParam(context, "datasetId");
      if (!(await persistence.getRegressionDataset(datasetId))) {
        failure("not-found", "regression_dataset_not_found", "Regression dataset not found.");
      }
      const page = await persistence.listDatasetCases(datasetId, pageOptions(context));
      return {
        items: page.items.map(datasetCaseResponse),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    }
  }
}
