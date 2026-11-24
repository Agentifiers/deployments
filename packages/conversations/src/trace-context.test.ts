import { MAX_TRACE_RUNS, type PlatformRecord, type Ulid } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import type { SubmitConversationTurnInput } from "./submission.ts";
import { observabilityRecordsForRun } from "./trace-context.ts";

type Run = Extract<PlatformRecord, { readonly itemType: "run" }>;
type Trace = Extract<PlatformRecord, { readonly itemType: "trace" }>;

describe("conversation trace context", () => {
  test("rejects a child before a trace can exceed its durable run limit", () => {
    const runId = "01ARZ3NDEKTSV4RRFFQ69G5F00" as Ulid;
    const parentTrace = {
      data: {
        runIds: Array.from({ length: MAX_TRACE_RUNS }, () => runId),
      },
    } as unknown as Trace;
    const child = {
      data: { id: "01ARZ3NDEKTSV4RRFFQ69G5F01" as Ulid },
    } as unknown as Run;

    expect(() =>
      observabilityRecordsForRun({
        input: {} as SubmitConversationTurnInput,
        parentTrace,
        run: child,
        runEdgeId: "01ARZ3NDEKTSV4RRFFQ69G5F02" as Ulid,
        timestamp: "2026-07-28T00:00:00.000Z",
      }),
    ).toThrow(`Trace graphs cannot exceed ${MAX_TRACE_RUNS} runs.`);
  });
});
