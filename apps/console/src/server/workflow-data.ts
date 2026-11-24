import "@tanstack/react-start/server-only";
import type {
  WorkflowDefinitionResponse,
  WorkflowDefinitionSummaryResponse,
  WorkflowExecutionResponse,
  WorkflowExecutionSummaryResponse,
  WorkflowReleaseResponse,
  WorkflowReleaseSummaryResponse,
  WorkflowStepAttemptResponse,
} from "@deployments-ai/api-contract";
import { collectPagesUpTo } from "../overview/status-counts.ts";
import type { EnvironmentScope } from "../scope.ts";
import {
  approvalPrompt,
  pendingStepOf,
  type ApprovalQueue,
  type ApprovalTarget,
  type DefinitionFilters,
  type ExecutionFilters,
} from "../workflows/model.ts";
import { fanOut } from "./fan-out.ts";
import { API_PAGE_LIMIT, fillPage, PAGE_SIZE, type Page } from "./list-pages.ts";
import { callRoute, type PlatformApiClient } from "./platform-api.ts";

type DefinitionSummary = typeof WorkflowDefinitionSummaryResponse.Type;
type ReleaseSummary = typeof WorkflowReleaseSummaryResponse.Type;

export type Platform = Pick<PlatformApiClient, "callRoute">;

const platform: Platform = { callRoute };

const RELATED_EXECUTION_PAGES = 5;
const STEP_ATTEMPT_PAGES = 3;

export interface Scan<Item> {
  readonly complete: boolean;
  readonly items: readonly Item[];
}

export interface ExecutionDetail {
  readonly attempts: Scan<WorkflowStepAttemptResponse>;
  readonly execution: WorkflowExecutionResponse;
}

const nextCursorOf = (page: { readonly nextCursor?: string | null | undefined }) =>
  page.nextCursor ?? undefined;

export async function loadDefinitionPage(
  accessToken: string,
  scope: EnvironmentScope,
  filters: DefinitionFilters,
  cursor: string | undefined,
  client: Platform = platform,
): Promise<Page<DefinitionSummary>> {
  const status = filters.status ?? "active";
  return fillPage(
    async (pageCursor, limit) => {
      const page = await client.callRoute(
        "listWorkflowDefinitions",
        { query: { cursor: pageCursor, limit }, scope },
        accessToken,
      );
      return {
        items: status === "all" ? page.items : page.items.filter((item) => item.status === status),
        nextCursor: nextCursorOf(page),
      };
    },
    cursor,
    PAGE_SIZE,
  );
}

export function loadDefinition(
  accessToken: string,
  scope: EnvironmentScope,
  definitionId: string,
): Promise<WorkflowDefinitionResponse> {
  return callRoute("getWorkflowDefinition", { path: { id: definitionId }, scope }, accessToken);
}

export async function loadReleasePage(
  accessToken: string,
  scope: EnvironmentScope,
  definitionId: string,
  cursor: string | undefined,
): Promise<Page<ReleaseSummary>> {
  const page = await callRoute(
    "listWorkflowReleases",
    { path: { id: definitionId }, query: { cursor, limit: PAGE_SIZE }, scope },
    accessToken,
  );
  return { items: page.items, nextCursor: nextCursorOf(page) };
}

export function loadRelease(
  accessToken: string,
  scope: EnvironmentScope,
  releaseId: string,
): Promise<WorkflowReleaseResponse> {
  return callRoute("getWorkflowRelease", { path: { id: releaseId }, scope }, accessToken);
}

function executionPages(
  accessToken: string,
  scope: EnvironmentScope,
  filters: ExecutionFilters,
  client: Platform,
) {
  return async (cursor: string | undefined, limit = API_PAGE_LIMIT) => {
    const page = await client.callRoute(
      "listWorkflowExecutions",
      { query: { cursor, limit, status: filters.status }, scope },
      accessToken,
    );
    return { items: page.items, nextCursor: nextCursorOf(page) };
  };
}

export function loadExecutionPage(
  accessToken: string,
  scope: EnvironmentScope,
  filters: ExecutionFilters,
  cursor: string | undefined,
  client: Platform = platform,
): Promise<Page<WorkflowExecutionSummaryResponse>> {
  return fillPage(executionPages(accessToken, scope, filters, client), cursor, PAGE_SIZE);
}

export async function loadRelatedExecutions(
  accessToken: string,
  scope: EnvironmentScope,
  related: { readonly definitionId: string } | { readonly releaseId: string },
  client: Platform = platform,
): Promise<Scan<WorkflowExecutionSummaryResponse>> {
  const { complete, items } = await collectPagesUpTo(
    executionPages(accessToken, scope, {}, client),
    RELATED_EXECUTION_PAGES,
  );
  return {
    complete,
    items: items.filter((execution) =>
      "definitionId" in related
        ? execution.workflowDefinitionId === related.definitionId
        : execution.workflowReleaseId === related.releaseId,
    ),
  };
}

function stepAttempts(
  accessToken: string,
  scope: EnvironmentScope,
  executionId: string,
  client: Platform,
) {
  return collectPagesUpTo(
    async (cursor) =>
      client.callRoute(
        "listWorkflowStepAttempts",
        {
          path: { workflowExecutionId: executionId },
          query: { cursor, limit: API_PAGE_LIMIT },
          scope,
        },
        accessToken,
      ),
    STEP_ATTEMPT_PAGES,
  );
}

export async function loadExecutionDetail(
  accessToken: string,
  scope: EnvironmentScope,
  executionId: string,
  client: Platform = platform,
): Promise<ExecutionDetail> {
  const [execution, attempts] = await Promise.all([
    client.callRoute(
      "getWorkflowExecution",
      { path: { workflowExecutionId: executionId }, scope },
      accessToken,
    ),
    stepAttempts(accessToken, scope, executionId, client),
  ]);
  return { attempts, execution };
}

export async function loadApprovalQueue(
  accessToken: string,
  scope: EnvironmentScope,
  client: Platform = platform,
): Promise<ApprovalQueue> {
  const waiting = await fillPage(
    executionPages(accessToken, scope, { status: "waiting-for-approval" }, client),
    undefined,
    PAGE_SIZE,
  );
  const scans = await fanOut(waiting.items, async (execution) => {
    const attempts = await stepAttempts(accessToken, scope, execution.id, client);
    return {
      complete: attempts.complete,
      execution,
      step: pendingStepOf(execution, attempts.items),
    };
  });
  const pending = scans.flatMap(({ execution, step }) =>
    step === undefined ? [] : [{ execution, step }],
  );
  const releases = new Map(
    (
      await fanOut(
        [...new Set(pending.map(({ execution }) => execution.workflowReleaseId))],
        (releaseId) =>
          client.callRoute("getWorkflowRelease", { path: { id: releaseId }, scope }, accessToken),
      )
    ).map((release) => [release.id, release]),
  );
  return {
    complete:
      waiting.nextCursor === undefined &&
      scans.every(({ complete, step }) => complete || step !== undefined),
    items: pending.flatMap(({ execution, step }) => {
      const release = releases.get(execution.workflowReleaseId);
      return release === undefined
        ? []
        : [
            {
              ...step,
              prompt: approvalPrompt(release.definition, step.stepId),
              releaseId: release.id,
              releaseNumber: release.releaseNumber,
              workflowName: release.definition.name,
            },
          ];
    }),
  };
}

export function loadApproval(
  accessToken: string,
  scope: EnvironmentScope,
  target: ApprovalTarget,
  client: Platform = platform,
) {
  return client.callRoute(
    "getWorkflowApproval",
    {
      path: { workflowApprovalId: target.approvalId, workflowExecutionId: target.executionId },
      scope,
    },
    accessToken,
  );
}
