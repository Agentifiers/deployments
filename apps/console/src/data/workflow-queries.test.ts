import { describe, expect, test } from "bun:test";
import type { WorkflowExecutionSummaryResponse } from "@deployments-ai/api-contract";
import { QueryClient } from "@tanstack/react-query";
import type { ExecutionDetail } from "../server/workflow-data.ts";
import {
  approvalQueueQuery,
  definitionPagesQuery,
  executionDetailRefreshMs,
  executionListRefreshMs,
  settleApproval,
} from "./workflow-queries.ts";

type Status = WorkflowExecutionSummaryResponse["status"];

// Polling reads only `status`, so the fixtures omit every other field.
const summary = (status: Status) => ({ status }) as unknown as WorkflowExecutionSummaryResponse;
const detail = (status: Status) =>
  ({
    attempts: { complete: true, items: [] },
    execution: { status },
  }) as unknown as ExecutionDetail;

describe("executionListRefreshMs", () => {
  test("refreshes every 30 seconds while any loaded page holds an unfinished execution", () => {
    expect(
      executionListRefreshMs([
        { items: [summary("completed"), summary("failed")] },
        { items: [summary("canceling")] },
      ]),
    ).toBe(30_000);
    expect(executionListRefreshMs([{ items: [summary("waiting-for-approval")] }])).toBe(30_000);
  });

  test("stops once every loaded execution is finished, or before any page loads", () => {
    expect(
      executionListRefreshMs([
        { items: [summary("completed"), summary("failed")] },
        { items: [summary("canceled")] },
      ]),
    ).toBe(false);
    expect(executionListRefreshMs([{ items: [] }])).toBe(false);
    expect(executionListRefreshMs(undefined)).toBe(false);
  });
});

describe("executionDetailRefreshMs", () => {
  test("refreshes every 5 seconds until the execution completes, fails, or is canceled", () => {
    for (const status of ["queued", "running", "waiting-for-tool", "canceling"] as const) {
      expect(executionDetailRefreshMs(detail(status))).toBe(5_000);
    }
    for (const status of ["completed", "failed", "canceled"] as const) {
      expect(executionDetailRefreshMs(detail(status))).toBe(false);
    }
    expect(executionDetailRefreshMs(undefined)).toBe(false);
  });
});

const SCOPE = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G600G",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G600C",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G600D",
};

function pending(approvalId: string) {
  return {
    approvalId,
    executionId: `${approvalId}-execution`,
    prompt: "QA: approve this execution?",
    releaseId: "01K0000000000000000000000R",
    releaseNumber: 1,
    stepId: "review",
    waitingSince: "2026-10-09T05:01:00.000Z",
    workflowName: "QA approval gate",
  };
}

describe("settleApproval", () => {
  test("a decided approval leaves the queue at once, and only the other workflow reads go stale", async () => {
    const queryClient = new QueryClient();
    const queue = approvalQueueQuery(SCOPE).queryKey;
    const definitions = definitionPagesQuery(SCOPE, {}).queryKey;
    queryClient.setQueryData(queue, { complete: true, items: [pending("A1"), pending("A2")] });
    queryClient.setQueryData(definitions, { pageParams: [], pages: [] });

    await settleApproval(queryClient, SCOPE, "A1");

    expect(queryClient.getQueryData(queue)?.items.map((item) => item.approvalId)).toEqual(["A2"]);
    expect(
      [queue, definitions].map((queryKey) => queryClient.getQueryState(queryKey)?.isInvalidated),
    ).toEqual([false, true]);
  });

  test("a queue fetch already in flight cannot bring the decided approval back", async () => {
    const queryClient = new QueryClient();
    const queue = approvalQueueQuery(SCOPE).queryKey;
    const before = { complete: true, items: [pending("A1"), pending("A2")] };
    queryClient.setQueryData(queue, before);
    const { promise: answered, resolve: answer } = Promise.withResolvers<typeof before>();
    const inFlight = queryClient
      .fetchQuery({ queryFn: () => answered, queryKey: queue })
      .catch(() => undefined);

    await settleApproval(queryClient, SCOPE, "A1");
    answer(before);
    await inFlight;

    expect(queryClient.getQueryData(queue)?.items.map((item) => item.approvalId)).toEqual(["A2"]);
  });
});
