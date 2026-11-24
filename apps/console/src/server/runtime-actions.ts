import "@tanstack/react-start/server-only";
import type { EnvironmentScope } from "../scope.ts";
import { callRoute } from "./platform-api.ts";
import { approvalView, type ApprovalView, type Run } from "./runtime-data.ts";

export interface RunMutation {
  readonly accessToken: string;
  readonly runId: string;
  readonly scope: EnvironmentScope;
}

export interface ApprovalDecision extends RunMutation {
  readonly approvalId: string;
  readonly decision: "approved" | "rejected";
}

export interface ApprovalResolution {
  readonly approval: ApprovalView;
  readonly decision: "approved" | "expired" | "rejected";
  readonly runStatus: Run["status"];
}

export function cancelRun({ accessToken, runId, scope }: RunMutation): Promise<Run> {
  return callRoute("cancelRun", { path: { runId }, scope }, accessToken);
}

export function retryRun({ accessToken, runId, scope }: RunMutation): Promise<Run> {
  return callRoute("retryRun", { path: { runId }, scope }, accessToken);
}

export function replayRun({
  accessToken,
  idempotencyKey,
  runId,
  scope,
}: RunMutation & { readonly idempotencyKey: string }): Promise<Run> {
  return callRoute("replayRun", { idempotencyKey, path: { runId }, scope }, accessToken);
}

export async function resolveApproval({
  accessToken,
  approvalId,
  decision,
  runId,
  scope,
}: ApprovalDecision): Promise<ApprovalResolution> {
  const run = await callRoute("getRunById", { path: { runId }, scope }, accessToken);
  const resolution = await callRoute(
    "resolveApproval",
    { body: { decision, threadId: run.threadId }, path: { approvalId, runId }, scope },
    accessToken,
  );
  return {
    approval: approvalView(resolution.approval),
    decision: resolution.decision,
    runStatus: resolution.run.status,
  };
}
