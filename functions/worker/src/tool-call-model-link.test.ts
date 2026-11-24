import { describe, expect, test } from "bun:test";
import type { RuntimeCompletedToolCall } from "@deployments-ai/agent-runtime";
import { stableSpanId } from "@deployments-ai/observability";
import { fixtures, id } from "./agent-run.fixture.ts";
import { runtimeCompletedToolCall } from "./continuation.ts";
import { observabilityFactsForTransition } from "./observability-normalizer.ts";
import { completedToolCallRecord, pausedToolCallRecord } from "./record-builders.ts";

const now = new Date("2026-08-08T12:00:00.000Z");
const stream = {
  normalizedAt: "2026-08-08T12:00:02.000Z",
  streamArn: "arn:aws:dynamodb:us-east-2:123:table/execution/stream/1",
  streamSequenceNumber: "100",
} as const;

function completedCall(
  overrides: Partial<RuntimeCompletedToolCall> = {},
): RuntimeCompletedToolCall {
  return {
    effect: "read",
    idempotencyKey: `${id(7)}:model-tool:1:0`,
    inputSummary: "Model requested provider.read.",
    outputSummary: "read",
    policyAction: "allow",
    policyReason: "Allowed.",
    requiredScopes: [],
    toolCallId: id(92),
    toolName: "provider.read",
    ...overrides,
  };
}

describe("tool calls linked to their requesting model generation", () => {
  const { run } = fixtures();
  const requester = {
    modelAttemptId: `${run.data.id}:execution:1:assistant:1:run-attempt:0:fallback:1`,
    modelCallIndex: 1,
  };

  test("records and rehydrates the requesting generation", () => {
    const record = completedToolCallRecord({ call: completedCall(requester), now, run });
    expect(record.data).toMatchObject(requester);
    expect(runtimeCompletedToolCall(record)).toMatchObject(requester);

    const toolPlan = completedToolCallRecord({
      call: completedCall({ idempotencyKey: "caller-key" }),
      now,
      run,
    });
    expect(toolPlan.data).not.toHaveProperty("modelAttemptId");
    expect(toolPlan.data).not.toHaveProperty("modelCallIndex");
    expect(runtimeCompletedToolCall(toolPlan)).not.toHaveProperty("modelCallIndex");
  });

  test("keeps the link from a paused call and rejects a completion that names another", () => {
    const {
      outputSummary: _outputSummary,
      policyAction: _policyAction,
      ...call
    } = completedCall(requester);
    const waiting = pausedToolCallRecord({
      action: { ...call, approvalId: id(93), kind: "approval" },
      now,
      run,
    });
    expect(waiting.data).toMatchObject(requester);
    const pending = { ...waiting, data: { ...waiting.data, status: "pending" as const } };
    const approved = completedCall({
      ...requester,
      approvalId: id(93),
      policyAction: "require-approval",
    });

    expect(
      completedToolCallRecord({ call: approved, now, previous: pending, run }).data,
    ).toMatchObject({ ...requester, status: "succeeded" });
    expect(() =>
      completedToolCallRecord({
        call: { ...approved, modelAttemptId: `${requester.modelAttemptId}:other` },
        now,
        previous: pending,
        run,
      }),
    ).toThrow("does not match its canonical record");
  });

  test("parents a model-requested tool span to the requesting model attempt span", async () => {
    const [span] = await observabilityFactsForTransition({
      ...stream,
      current: completedToolCallRecord({ call: completedCall(requester), now, run }),
      eventName: "INSERT",
      table: "execution",
    });

    expect(span?.factType).toBe("span.finalized");
    expect(span?.trace?.parentSpanId).toBe(
      stableSpanId(run.data.traceId, `model:${requester.modelAttemptId}`),
    );
    expect(span?.payload).toMatchObject({
      attemptId: requester.modelAttemptId,
      kind: "tool",
      modelCallIndex: 1,
    });
  });

  test("parents a tool-plan tool span to the run span", async () => {
    const [span] = await observabilityFactsForTransition({
      ...stream,
      current: completedToolCallRecord({
        call: completedCall({ idempotencyKey: "caller-key" }),
        now,
        run,
      }),
      eventName: "INSERT",
      table: "execution",
    });

    expect(span?.trace?.parentSpanId).toBe(run.data.spanId);
    expect(span?.payload).not.toHaveProperty("attemptId");
    expect(span?.payload).not.toHaveProperty("modelCallIndex");
  });
});
