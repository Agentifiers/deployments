import { describe, expect, it } from "bun:test";
import type { RuntimeCompletedToolCall } from "@deployments-ai/agent-runtime";
import { ToolCallRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { Schema } from "effect";
import { fixtures, id } from "./agent-run.fixture.ts";
import { completedToolCallRecord } from "./record-builders.ts";

const now = new Date("2026-09-29T23:03:36.000Z");

function approvedCall(output: Readonly<Record<string, unknown>>): RuntimeCompletedToolCall {
  return {
    approvalId: id(80),
    effect: "write",
    idempotencyKey: "run:model-tool:0:0",
    input: { url: "https://deployments.ai/capabilities" },
    inputSummary: "Execute an approved browser session.",
    output,
    outputSummary: "Executed 2 browser actions.",
    policyAction: "require-approval",
    policyReason: "Tool adapter browser.session.execute defaults to require_approval.",
    requiredScopes: [],
    toolCallId: id(81),
    toolName: "browser.session.execute",
  };
}

/** The canonical record an approval leaves behind: pending, with no output yet. */
function pendingRecord(call: RuntimeCompletedToolCall) {
  const { run } = fixtures();
  const {
    completedAt: _completedAt,
    output: _output,
    outputSummary: _outputSummary,
    ...data
  } = completedToolCallRecord({ call, now, run }).data;
  return Schema.decodeUnknownSync(ToolCallRecord)(
    withCanonicalRecordKeys({
      data: { ...data, status: "pending" },
      itemType: "tool-call" as const,
    }),
  );
}

describe("completed tool call records", () => {
  it("completes an approved call whose result carries output", () => {
    const call = approvedCall({ finalUrl: "https://deployments.ai/capabilities" });

    const completed = completedToolCallRecord({
      call,
      now,
      previous: pendingRecord(call),
      run: fixtures().run,
    });

    expect(completed.data.status).toBe("succeeded");
    expect(completed.data.output).toEqual({ finalUrl: "https://deployments.ai/capabilities" });
  });

  it("rejects a replayed completion whose output differs from the succeeded record", () => {
    const { run } = fixtures();
    const succeeded = completedToolCallRecord({ call: approvedCall({ attempt: 1 }), now, run });

    expect(() =>
      completedToolCallRecord({
        call: approvedCall({ attempt: 2 }),
        now,
        previous: succeeded,
        run,
      }),
    ).toThrow("output does not match its canonical record");
  });
});
