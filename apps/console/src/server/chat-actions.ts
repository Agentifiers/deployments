import "@tanstack/react-start/server-only";
import { runErrorText } from "../runs/run-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

type Preview = RouteResponse<"createPreview">;

/** A preview of the draft, and the draft version it snapshotted. */
export interface DraftPreview {
  readonly draftVersion: number;
  readonly expiresAt: string;
  readonly id: string;
}

/** A page left open keeps its preview no longer than this; leaving or resetting deletes it. */
const PREVIEW_TTL_SECONDS = 60 * 60;
type ToolResolution = RouteResponse<"resolveToolResult">;

/** What a chat turn reports back: the thread it ran on and the run it started. */
export interface SubmittedTurn {
  readonly threadId: string;
  readonly run: {
    readonly id: string;
    readonly status: RouteResponse<"getRunById">["status"];
    readonly error?: string;
  };
}

interface Caller {
  readonly accessToken: string;
  readonly scope: EnvironmentScope;
}

interface Keyed extends Caller {
  readonly idempotencyKey: string;
}

function submittedTurn(submitted: RouteResponse<"submitAgentRun">): SubmittedTurn {
  const error = runErrorText(submitted.run.error);
  return {
    run: {
      id: submitted.run.id,
      status: submitted.run.status,
      ...(error === undefined ? {} : { error }),
    },
    threadId: submitted.thread.id,
  };
}

/** Opens a conversation with a deployment; each chat in the console starts its own thread. */
export async function createChatThread({
  accessToken,
  agentDeploymentId,
  scope,
}: Caller & { readonly agentDeploymentId: string }): Promise<string> {
  const thread = await callRoute(
    "createThread",
    {
      body: decodeRequestBody("createThread", "CreateThreadRequest", {
        agentDeploymentId,
        channel: "console",
      }),
      scope,
    },
    accessToken,
  );
  return thread.id;
}

export async function submitChatTurn({
  accessToken,
  agentDeploymentId,
  content,
  idempotencyKey,
  scope,
  threadId,
}: Keyed & {
  readonly agentDeploymentId: string;
  readonly content: string;
  readonly threadId: string;
}): Promise<SubmittedTurn> {
  const submitted = await callRoute(
    "submitAgentRun",
    {
      body: decodeRequestBody("submitAgentRun", "SubmitAgentRunRequest", { content, threadId }),
      idempotencyKey,
      path: { agentDeploymentId },
      scope,
    },
    accessToken,
  );
  return submittedTurn(submitted);
}

/**
 * Previews the definition's current draft. The draft is re-read here, so the preview runs what
 * the platform holds, not what the browser last loaded.
 */
export async function createDraftPreview({
  accessToken,
  definitionId,
  fromAgentDeploymentId,
  idempotencyKey,
  scope,
}: Keyed & {
  readonly definitionId: string;
  readonly fromAgentDeploymentId?: string;
}): Promise<DraftPreview> {
  const definition = await callRoute(
    "getAgentDefinition",
    { path: { id: definitionId }, scope },
    accessToken,
  );
  const preview = await callRoute(
    "createPreview",
    {
      body: decodeRequestBody("createPreview", "CreatePreviewRequest", {
        manifest: definition.draft,
        ttlSeconds: PREVIEW_TTL_SECONDS,
        ...(fromAgentDeploymentId === undefined ? {} : { fromAgentDeploymentId }),
      }),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
  return { draftVersion: definition.version, expiresAt: preview.expiresAt, id: preview.id };
}

export async function deletePreview({
  accessToken,
  previewId,
  scope,
}: Caller & { readonly previewId: string }): Promise<Preview["status"]> {
  const { status } = await callRoute("deletePreview", { path: { previewId }, scope }, accessToken);
  return status;
}

export async function submitPreviewTurn({
  accessToken,
  content,
  idempotencyKey,
  previewId,
  scope,
  threadId,
}: Keyed & {
  readonly content: string;
  readonly previewId: string;
  readonly threadId?: string;
}): Promise<SubmittedTurn> {
  const submitted = await callRoute(
    "submitPreviewTurn",
    {
      body: decodeRequestBody("submitPreviewTurn", "SubmitPreviewTurnRequest", {
        content,
        ...(threadId === undefined ? {} : { threadId }),
      }),
      idempotencyKey,
      path: { previewId },
      scope,
    },
    accessToken,
  );
  return submittedTurn(submitted);
}

/** Answers a client-executed tool call the run waits on, so the run resumes. */
export async function resolveClientToolCall({
  accessToken,
  output,
  outcome,
  outputSummary,
  runId,
  scope,
  toolCallId,
}: Caller & {
  readonly outcome: "completed" | "failed";
  readonly output?: unknown;
  readonly outputSummary?: string;
  readonly runId: string;
  readonly toolCallId: string;
}): Promise<{ readonly outcome: ToolResolution["outcome"]; readonly runStatus: string }> {
  const run = await callRoute("getRunById", { path: { runId }, scope }, accessToken);
  const resolution = await callRoute(
    "resolveToolResult",
    {
      body: decodeRequestBody("resolveToolResult", "ResolveToolResultRequest", {
        outcome,
        threadId: run.threadId,
        ...(output === undefined ? {} : { output }),
        ...(outputSummary === undefined ? {} : { outputSummary }),
      }),
      path: { runId, toolCallId },
      scope,
    },
    accessToken,
  );
  return { outcome: resolution.outcome, runStatus: resolution.run.status };
}
