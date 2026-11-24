import { describe, expect, it } from "bun:test";
import { RunRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { Schema } from "effect";
import { fixtures, id } from "./agent-run.fixture.ts";
import { completedToolCallRecord } from "./record-builders.ts";
import {
  runToolContinuation,
  runtimeCompletedToolCall,
  withRunToolContinuation,
} from "./continuation.ts";

function runWithPendingPublicationIndexes(indexes: unknown) {
  const run = fixtures().run;
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...run.data,
        toolContinuation: {
          artifactContinuation: {
            artifactBytes: 0,
            artifactIndexCursor: 2,
            artifacts: [
              { fileName: "first.txt", label: "First" },
              { fileName: "second.txt", label: "Second" },
            ],
            pendingArtifactPublicationIndexes: indexes,
          },
          completedToolCallIds: [],
          version: 3,
        },
      },
      itemType: "run" as const,
    }),
  );
}

describe("run artifact continuation validation", () => {
  it("preserves an authorized callback input hash in completed continuation state", () => {
    const run = fixtures().run;
    const inputHash = `sha256:${"a".repeat(64)}`;
    const toolCall = completedToolCallRecord({
      call: {
        effect: "write",
        executionBinding: {
          authorizationFingerprint: "authorization-v1",
          connectionId: id(90),
          externalAccountId: "callback-account",
          inputHash,
          toolAdapterId: id(91),
          toolPlanFingerprint: "plan-v1",
        },
        idempotencyKey: "callback-write-1",
        input: { target: "authorized-resource" },
        inputSummary: "Write through callback.",
        policyAction: "allow",
        policyReason: "Allowed.",
        requiredScopes: ["callback:write"],
        toolCallId: id(92),
        toolName: "vertical.callback.write",
      },
      now: new Date("2026-08-08T12:00:00.000Z"),
      run,
    });

    expect(runtimeCompletedToolCall(toolCall).executionBinding?.inputHash).toBe(inputHash);
  });

  it("replays failed sub-agent delegations to the model but rejects other failed tools", () => {
    const run = fixtures().run;
    const failed = (toolName: string) => {
      const record = completedToolCallRecord({
        call: {
          effect: "execute",
          idempotencyKey: `${toolName}-1`,
          inputSummary: "Delegate.",
          policyAction: "allow",
          policyReason: "Allowed.",
          requiredScopes: [],
          toolCallId: id(93),
          toolName,
        },
        now: new Date("2026-08-08T12:00:00.000Z"),
        run,
      });
      return {
        ...record,
        data: { ...record.data, outputSummary: "Sub-agent run failed.", status: "failed" as const },
      };
    };

    expect(runtimeCompletedToolCall(failed("agent.delegate")).output).toEqual({
      error: "Sub-agent run failed.",
      status: "failed",
    });
    expect(() => runtimeCompletedToolCall(failed("web.search"))).toThrow(
      "is not a canonical completed continuation",
    );
  });

  it.each([
    ["a non-array value", "1"],
    ["duplicate indexes", [1, 1]],
    ["an index at the artifact cursor", [2]],
  ])("rejects %s for pending artifact publications", (_label, indexes) => {
    expect(() => runToolContinuation(runWithPendingPublicationIndexes(indexes))).toThrow(
      "pending publication indexes",
    );
  });

  it("round-trips bounded model-native tool state through version 4", () => {
    const fixture = fixtures();
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.run.data,
          toolContinuation: {
            completedToolCallIds: [],
            modelContinuation: {
              modelCallCount: 1,
              toolRequests: [
                {
                  effect: "read",
                  idempotencyKey: "model-tool-1",
                  input: { resource: "account" },
                  inputSummary: "Model requested provider.read.",
                  requiredScopes: ["account:read"],
                  toolName: "provider.read",
                },
              ],
            },
            version: 4,
          },
        },
        itemType: "run" as const,
      }),
    );

    expect(runToolContinuation(run).modelContinuation).toEqual({
      modelCallCount: 1,
      toolRequests: [
        {
          effect: "read",
          idempotencyKey: "model-tool-1",
          input: { resource: "account" },
          inputSummary: "Model requested provider.read.",
          requiredScopes: ["account:read"],
          toolName: "provider.read",
        },
      ],
    });
  });

  it("stores a runtime model continuation without its generation reasoning", () => {
    const toolRequest = {
      effect: "read" as const,
      idempotencyKey: "model-tool-1",
      inputSummary: "Model requested provider.read.",
      requiredScopes: [],
      toolName: "provider.read",
    };
    const runtimeContinuation = {
      generationReasoning: [
        {
          details: [{ format: "anthropic-claude-v1", signature: "c2ln", type: "reasoning.text" }],
          modelCallIndex: 0,
          producerAttemptId: "attempt-0",
          producerModelId: "openrouter/anthropic/claude-opus-5.5",
        },
      ],
      modelCallCount: 1,
      toolRequests: [toolRequest],
    };

    const run = withRunToolContinuation(
      fixtures().run,
      [],
      undefined,
      undefined,
      runtimeContinuation,
    );

    expect(run.data.toolContinuation).toEqual({
      completedToolCallIds: [],
      modelContinuation: { modelCallCount: 1, toolRequests: [toolRequest] },
      version: 4,
    });
  });
});
