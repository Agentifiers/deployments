import "@tanstack/react-start/server-only";
import { automationLabel, type AutomationKind } from "../automations/automation-state.ts";
import { PlatformApiError, UnauthenticatedError, type PlatformProblem } from "../errors.ts";
import type { AgentReleaseEntry } from "../observability/agent-labels.ts";
import type { ApprovalFilters, RunFeedFilters } from "../runs/filters.ts";
import { hidesRunOutput } from "../runs/run-output.ts";
import type { ThreadStreamGrant } from "../runs/thread-stream.ts";
import {
  approvalRequestSummary,
  messageContent,
  type ApprovalRequestSummary,
  type MessageContent,
} from "../runs/views.ts";
import type { EnvironmentScope } from "../scope.ts";
import { loadReleaseEntries } from "./agent-directory.ts";
import { fanOut } from "./fan-out.ts";
import { API_PAGE_LIMIT, fillPage, PAGE_SIZE, type LabeledPage, type Page } from "./list-pages.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";

export type Run = RouteResponse<"getRunById">;
export type Thread = RouteResponse<"getThread">;
type ApprovalResponse = RouteResponse<"getApproval">;
type ToolCallResponse = RouteResponse<"listRunToolCalls">["toolCalls"][number];
type MessageResponse = RouteResponse<"listThreadMessages">["messages"][number];

/** The schedule or heartbeat a run came from, without the fire. */
export interface AutomationRef {
  readonly id: string;
  readonly kind: AutomationKind;
}

export interface AutomationLabelEntry extends AutomationRef {
  readonly label: string;
}

export interface RunFeedPage extends LabeledPage<Run> {
  readonly automations: readonly AutomationLabelEntry[];
}

export interface ApprovalView extends Omit<ApprovalResponse, "escalationPolicy" | "request"> {
  readonly request: ApprovalRequestSummary;
}

export type ApprovalSlot =
  | { readonly approval: ApprovalView; readonly kind: "loaded" }
  | { readonly kind: "unavailable"; readonly problem: PlatformProblem };

export interface ToolCallView extends Omit<ToolCallResponse, "input" | "output" | "outputSchema"> {
  readonly approval?: ApprovalSlot;
}

export interface RunDetail {
  readonly releases: readonly AgentReleaseEntry[];
  readonly run: Run;
  readonly toolCalls: readonly ToolCallView[];
  readonly toolCallsComplete: boolean;
}

export interface TranscriptMessage {
  readonly attachedFileCount: number;
  readonly content: MessageContent;
  readonly createdAt: string;
  readonly id: string;
  readonly role: MessageResponse["role"];
  readonly runId?: string;
  readonly sequence: number;
}

export type RuntimeLookup =
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "missing" };

const MAX_TOOL_CALLS = 200;

export function approvalView(approval: ApprovalResponse): ApprovalView {
  const { escalationPolicy: _escalationPolicy, request, ...fields } = approval;
  return { ...fields, request: approvalRequestSummary(request) };
}

/**
 * The automation's label, or `null` when it cannot be read (outside the caller's scopes, gone,
 * or failing); like an unreadable release, its runs then show the plain trigger.
 */
export async function loadAutomationLabel(
  accessToken: string,
  scope: EnvironmentScope,
  automation: AutomationRef,
): Promise<string | null> {
  try {
    switch (automation.kind) {
      case "heartbeat": {
        const heartbeat = await callRoute(
          "getHeartbeat",
          { path: { heartbeatId: automation.id }, scope },
          accessToken,
        );
        return automationLabel({ heartbeat, kind: "heartbeat" });
      }
      case "schedule": {
        const schedule = await callRoute(
          "getSchedule",
          { path: { scheduleId: automation.id }, scope },
          accessToken,
        );
        return automationLabel({ kind: "schedule", schedule });
      }
      default: {
        const exhaustive: never = automation.kind;
        return exhaustive;
      }
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) throw error;
    return null;
  }
}

async function loadAutomationLabels(
  accessToken: string,
  scope: EnvironmentScope,
  runs: readonly Run[],
): Promise<AutomationLabelEntry[]> {
  const automations = new Map<string, AutomationRef>();
  for (const { automation } of runs) {
    if (automation) automations.set(automation.id, { id: automation.id, kind: automation.kind });
  }
  const entries = await fanOut([...automations.values()], async (automation) => {
    const label = await loadAutomationLabel(accessToken, scope, automation);
    return label === null ? undefined : { ...automation, label };
  });
  return entries.filter((entry): entry is AutomationLabelEntry => entry !== undefined);
}

/** One page of runs and the releases that label them. */
export async function loadRunPage(
  accessToken: string,
  scope: EnvironmentScope,
  filters: RunFeedFilters,
  cursor: string | undefined,
): Promise<LabeledPage<Run>> {
  const page = await fillPage(
    (pageCursor, limit) =>
      callRoute(
        "listRuns",
        {
          query: {
            agentDeploymentId: filters.agentDeploymentId,
            agentReleaseId: filters.agentReleaseId,
            createdAfter: filters.createdAfter,
            createdBefore: filters.createdBefore,
            cursor: pageCursor,
            executionPurpose: filters.executionPurpose,
            limit,
            status: filters.status,
            threadId: filters.threadId,
          },
          scope,
        },
        accessToken,
      ).then(({ nextCursor, runs }) => ({ items: runs, nextCursor })),
    cursor,
    PAGE_SIZE,
  );
  const releases = await loadReleaseEntries(accessToken, scope, [
    ...page.items.map((run) => run.agentReleaseId),
    filters.agentReleaseId,
  ]);
  return { ...page, releases };
}

/** The runs feed also names the schedule or heartbeat each run came from. */
export async function loadRunFeedPage(
  accessToken: string,
  scope: EnvironmentScope,
  filters: RunFeedFilters,
  cursor: string | undefined,
): Promise<RunFeedPage> {
  const page = await loadRunPage(accessToken, scope, filters, cursor);
  // After the releases, so the two lookups together stay within one fan-out's concurrency.
  const automations = await loadAutomationLabels(accessToken, scope, page.items);
  return { ...page, automations };
}

async function toolCallView(
  accessToken: string,
  scope: EnvironmentScope,
  toolCall: ToolCallResponse,
): Promise<ToolCallView> {
  const { input: _input, output: _output, outputSchema: _outputSchema, ...view } = toolCall;
  if (view.approvalId === undefined) return view;
  try {
    const approval = await callRoute(
      "getApproval",
      { path: { approvalId: view.approvalId, runId: view.runId }, scope },
      accessToken,
    );
    return { ...view, approval: { approval: approvalView(approval), kind: "loaded" } };
  } catch (error) {
    if (error instanceof PlatformApiError) {
      return { ...view, approval: { kind: "unavailable", problem: error.problem } };
    }
    throw error;
  }
}

export async function loadRunDetail(
  accessToken: string,
  scope: EnvironmentScope,
  runId: string,
): Promise<RunDetail> {
  const [{ releases, run }, toolCallPage] = await Promise.all([
    callRoute("getRunById", { path: { runId }, scope }, accessToken).then(async (run) => ({
      releases: await loadReleaseEntries(accessToken, scope, [run.agentReleaseId]),
      run,
    })),
    fillPage(
      (cursor, limit) =>
        callRoute(
          "listRunToolCalls",
          { path: { runId }, query: { cursor, limit }, scope },
          accessToken,
        ).then(({ nextCursor, toolCalls }) => ({ items: toolCalls, nextCursor })),
      undefined,
      MAX_TOOL_CALLS,
    ),
  ]);
  const toolCalls = await fanOut(toolCallPage.items, (toolCall) =>
    toolCallView(accessToken, scope, toolCall),
  );
  return { releases, run, toolCalls, toolCallsComplete: toolCallPage.nextCursor === undefined };
}

export async function loadApprovalPage(
  accessToken: string,
  scope: EnvironmentScope,
  filters: ApprovalFilters,
  cursor: string | undefined,
): Promise<Page<ApprovalView>> {
  const status = filters.status === "all" ? undefined : (filters.status ?? "pending");
  const page = await fillPage(
    (pageCursor, limit) =>
      callRoute(
        "listApprovals",
        { query: { cursor: pageCursor, limit, status }, scope },
        accessToken,
      ).then(({ approvals, nextCursor }) => ({ items: approvals, nextCursor })),
    cursor,
    PAGE_SIZE,
  );
  return { ...page, items: page.items.map(approvalView) };
}

export function loadThread(
  accessToken: string,
  scope: EnvironmentScope,
  threadId: string,
): Promise<Thread> {
  return callRoute("getThread", { path: { threadId }, scope }, accessToken);
}

/** The completed run's final message, or `null` while the API has none it can serve. */
export async function loadRunOutput(
  accessToken: string,
  scope: EnvironmentScope,
  threadId: string,
  runId: string,
): Promise<MessageContent | null> {
  try {
    const message = await callRoute(
      "getRunMessage",
      { path: { runId, threadId }, scope },
      accessToken,
    );
    return messageContent(message);
  } catch (error) {
    if (error instanceof PlatformApiError && hidesRunOutput(error.problem)) return null;
    throw error;
  }
}

/**
 * The session's history page (up to 4 MiB) repeats the transcript, so the browser gets only what
 * it reads the stream with.
 */
export async function openThreadStream(
  accessToken: string,
  scope: EnvironmentScope,
  threadId: string,
): Promise<ThreadStreamGrant> {
  const created = await callRoute(
    "createThreadStreamSession",
    { path: { threadId }, scope },
    accessToken,
  );
  return {
    accessToken: created.accessToken,
    expiresInMs: Date.parse(created.session.expiresAt) - Date.now(),
    offset: created.session.offset,
    streamUrl: created.streamUrl,
  };
}

export function transcriptMessage(message: MessageResponse): TranscriptMessage {
  return {
    attachedFileCount: message.inputArtifacts?.length ?? 0,
    content: messageContent(message),
    createdAt: message.createdAt,
    id: message.id,
    role: message.role,
    ...(message.runId === undefined ? {} : { runId: message.runId }),
    sequence: message.sequence,
  };
}

/**
 * Each console page is one API page, which the API caps at 4 MiB; filling past a short page could
 * exceed the console Lambda's 6 MB response limit.
 */
export async function loadTranscriptPage(
  accessToken: string,
  scope: EnvironmentScope,
  threadId: string,
  cursor: string | undefined,
): Promise<Page<TranscriptMessage>> {
  const { messages, nextCursor } = await callRoute(
    "listThreadMessages",
    { path: { threadId }, query: { cursor, limit: API_PAGE_LIMIT }, scope },
    accessToken,
  );
  return { items: messages.map(transcriptMessage), nextCursor };
}

export async function lookupRuntimeId(
  accessToken: string,
  scope: EnvironmentScope,
  id: string,
): Promise<RuntimeLookup> {
  try {
    const run = await callRoute("getRunById", { path: { runId: id }, scope }, accessToken);
    return { kind: "run", runId: run.id };
  } catch (error) {
    if (!(error instanceof PlatformApiError && error.problem.status === 404)) throw error;
  }
  try {
    const thread = await callRoute("getThread", { path: { threadId: id }, scope }, accessToken);
    return { kind: "thread", threadId: thread.id };
  } catch (error) {
    if (!(error instanceof PlatformApiError && error.problem.status === 404)) throw error;
  }
  return { kind: "missing" };
}
