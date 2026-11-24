import { describe, expect, it } from "bun:test";
import {
  runtimeExecutionFailureState,
  RuntimeToolExecutionKnownFailureError,
  RuntimeToolRecoveryRequiredError,
  runtimeArtifactId,
} from "./index.ts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";

describe("agent runtime", () => {
  it("continues artifact indexes and model evidence across a paused run", async () => {
    const recordedIndexes: number[] = [];
    let recordedArtifactIds: readonly string[] | undefined;
    let approvalDispatch:
      | { readonly approvalId?: string; readonly policyAction?: string }
      | undefined;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        throw new Error("approved continuation must not be reauthorized");
      },
      executeToolCall: async (request) => {
        recordedArtifactIds = request.recordedArtifactIds;
        approvalDispatch = {
          ...(request.approvalId ? { approvalId: request.approvalId } : {}),
          ...(request.policyAction ? { policyAction: request.policyAction } : {}),
        };
        return {
          artifacts: [{ content: "new evidence", fileName: "new.txt", label: "New evidence" }],
          outputSummary: "Completed.",
          status: "completed",
        };
      },
      generateAssistantMessage: async (request) => {
        expect(request.sandboxArtifacts.map((artifact) => artifact.fileName)).toEqual([
          "prior.txt",
          "new.txt",
        ]);
        expect(request.sandboxArtifacts[0]?.content).toBe("prior evidence");
        return { assistantMessage: "Continuation complete." };
      },
      loadArtifact: async () => ({
        content: "prior evidence",
        fileName: "prior.txt",
        label: "Prior evidence",
      }),
      recordArtifact: async (_artifact, index) => void recordedIndexes.push(index),
    });

    const result = await runtime.execute(
      input({
        approvedToolCalls: [
          {
            approvalId: id("81"),
            effect: "write",
            idempotencyKey: "continued-write",
            inputSummary: "Continue write",
            policyReason: "Approved.",
            requiredScopes: [],
            toolCallId: id("82"),
            toolName: "provider.write",
          },
        ],
        artifactContinuation: {
          artifactBytes: 14,
          artifactIndexCursor: 1,
          artifacts: [{ fileName: "prior.txt", label: "Prior evidence" }],
        },
        toolRequests: [
          {
            effect: "write",
            idempotencyKey: "continued-write",
            inputSummary: "Continue write",
            toolName: "provider.write",
          },
        ],
      }),
    );

    expect(recordedIndexes).toEqual([1]);
    expect(recordedArtifactIds).toEqual([runtimeArtifactId(id("7"), 0)]);
    expect(approvalDispatch).toEqual({
      approvalId: id("81"),
      policyAction: "require-approval",
    });
    expect(result.artifactContinuation).toMatchObject({
      artifactIndexCursor: 2,
      artifacts: [{ fileName: "prior.txt" }, { fileName: "new.txt" }],
    });
  });

  it("seeds completed tools and consumes approved continuation without repeating policy", async () => {
    let authorizations = 0;
    const executed: string[] = [];
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        authorizations += 1;
        throw new Error("continued tools must not be reauthorized");
      },
      executeToolCall: async (request) => {
        executed.push(request.toolName);
        return { outputSummary: "Second tool completed.", status: "completed" };
      },
      generateAssistantMessage: async (request) => {
        expect(request.completedToolCalls).toEqual([
          {
            effect: "read",
            idempotencyKey: "tool-first-completed",
            input: { first: 1, second: 2 },
            inputSummary: "First tool",
            outputSummary: "First tool completed.",
            policyAction: "allow",
            policyReason: "Previously allowed.",
            requiredScopes: [],
            toolCallId: id("71"),
            toolName: "provider.first",
          },
          {
            approvalId: id("73"),
            effect: "write",
            idempotencyKey: "tool-second-approved",
            input: { target: "production" },
            inputSummary: "Second tool",
            outputSummary: "Second tool completed.",
            policyAction: "require-approval",
            policyReason: "Approved by an owner.",
            requiredScopes: [],
            toolCallId: id("72"),
            toolName: "provider.second",
          },
        ]);
        return { assistantMessage: "Continuation complete." };
      },
    });

    const result = await runtime.execute(
      input({
        approvedToolCalls: [
          {
            approvalId: id("73"),
            effect: "write",
            idempotencyKey: "tool-second-approved",
            input: { target: "production" },
            inputSummary: "Second tool",
            policyReason: "Approved by an owner.",
            requiredScopes: [],
            toolCallId: id("72"),
            toolName: "provider.second",
          },
        ],
        completedToolCalls: [
          {
            effect: "read",
            idempotencyKey: "tool-first-completed",
            input: { second: 2, first: 1 },
            inputSummary: "First tool",
            outputSummary: "First tool completed.",
            policyAction: "allow",
            policyReason: "Previously allowed.",
            requiredScopes: [],
            toolCallId: id("71"),
            toolName: "provider.first",
          },
        ],
        toolRequests: [
          {
            effect: "read",
            idempotencyKey: "tool-first-completed",
            input: { first: 1, second: 2 },
            inputSummary: "First tool",
            toolName: "provider.first",
          },
          {
            effect: "write",
            idempotencyKey: "tool-second-approved",
            input: { target: "production" },
            inputSummary: "Second tool",
            toolName: "provider.second",
          },
        ],
      }),
    );

    expect(result.completionStatus).toBe("completed");
    expect(authorizations).toBe(0);
    expect(executed).toEqual(["provider.second"]);
  });

  it("rejects an approved continuation whose persisted input no longer matches", async () => {
    let executed = false;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        throw new Error("approved continuation must not be reauthorized");
      },
      executeToolCall: async () => {
        executed = true;
        return { status: "completed" };
      },
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
    });

    expect(
      runtime.execute(
        input({
          approvedToolCalls: [
            {
              approvalId: id("74"),
              effect: "write",
              idempotencyKey: "tool-approved-input",
              input: { target: "staging" },
              inputSummary: "Deploy target",
              policyReason: "Approved by an owner.",
              requiredScopes: [],
              toolCallId: id("75"),
              toolName: "provider.write",
            },
          ],
          toolRequests: [
            {
              effect: "write",
              idempotencyKey: "tool-approved-input",
              input: { target: "production" },
              inputSummary: "Deploy target",
              toolName: "provider.write",
            },
          ],
        }),
      ),
    ).rejects.toThrow("Approved tool continuation does not match provider.write");
    expect(executed).toBe(false);
  });

  it("preserves completed tool outcomes when artifacts exceed persistence limits", async () => {
    let recorded = false;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id("31"),
      }),
      executeToolCall: async () => ({
        artifacts: Array.from({ length: 33 }, (_, index) => ({
          content: "artifact",
          fileName: `artifact-${index}.txt`,
          label: `Artifact ${index}`,
        })),
        status: "completed",
      }),
      generateAssistantMessage: async (request) => {
        expect(request.completedToolCalls).toEqual([
          expect.objectContaining({ toolCallId: id("31"), toolName: "provider.read" }),
        ]);
        expect(request.sandboxArtifacts).toHaveLength(0);
        return { assistantMessage: "Completed without invalid artifacts." };
      },
      recordArtifact: async () => {
        recorded = true;
      },
    });

    const result = await runtime.execute(
      input({
        toolRequests: [
          {
            effect: "read",
            idempotencyKey: "tool-artifact-limit",
            inputSummary: "Return many artifacts",
            toolName: "provider.read",
          },
        ],
      }),
    );

    expect(result.completionStatus).toBe("completed");
    expect(result.completedToolCalls).toEqual([
      expect.objectContaining({ toolCallId: id("31"), toolName: "provider.read" }),
    ]);
    expect(recorded).toBe(false);
  });

  it("pauses for reconciliation when the tool executor rejects", async () => {
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id("32"),
      }),
      executeToolCall: async () => {
        throw new Error("provider request outcome unknown");
      },
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
    });

    const result = await runtime.execute(
      input({
        toolRequests: [
          {
            effect: "write",
            idempotencyKey: "tool-executor-rejected",
            inputSummary: "Start provider mutation",
            toolName: "provider.write",
          },
        ],
      }),
    );

    expect(result).toMatchObject({
      completionStatus: "waiting-for-tool",
      pendingAction: {
        externalOperationId: `unknown:${id("32")}`,
        kind: "tool",
        toolCallId: id("32"),
      },
    });
  });

  it("terminally fails known tool execution errors instead of requesting reconciliation", async () => {
    const progress: string[] = [];
    const runtime = createTestAgentRuntime({
      appendProgress: async (event) => void progress.push(event.eventType),
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id("91"),
      }),
      executeToolCall: async () => {
        throw new RuntimeToolExecutionKnownFailureError(
          "provider.read",
          new Error("Credential scopes were revoked with token=provider-secret-value"),
        );
      },
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
    });

    let failure: unknown;
    try {
      await runtime.execute(
        input({
          toolRequests: [
            {
              effect: "read",
              idempotencyKey: "tool-known-failure",
              inputSummary: "Read with revoked scopes",
              toolName: "provider.read",
            },
          ],
        }),
      );
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(RuntimeToolExecutionKnownFailureError);
    expect(failure).not.toBeInstanceOf(RuntimeToolRecoveryRequiredError);
    expect((failure as Error).message).not.toContain("provider-secret-value");
    expect(runtimeExecutionFailureState(failure)?.completedToolCalls).toEqual([]);
    expect(progress).toContain("tool.running");
    expect(progress).toContain("tool.failed");
  });

  it("fails closed on unsupported tool execution statuses", async () => {
    let recorded = false;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id("33"),
      }),
      executeToolCall: async () =>
        ({
          artifacts: [{ content: "must not persist", fileName: "invalid.txt", label: "Invalid" }],
          status: "failed",
        }) as never,
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      recordArtifact: async () => {
        recorded = true;
      },
    });

    expect(
      runtime.execute(
        input({
          toolRequests: [
            {
              effect: "read",
              idempotencyKey: "tool-invalid-status",
              inputSummary: "Invalid status",
              toolName: "provider.read",
            },
          ],
        }),
      ),
    ).rejects.toThrow("unsupported status");
    expect(recorded).toBe(false);
  });

  it("preserves recovery correlation before persisting asynchronous tool artifacts", async () => {
    let recorded = false;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id("34"),
      }),
      executeToolCall: async () => ({
        artifacts: [{ content: "must not persist", fileName: "invalid.txt", label: "Invalid" }],
        status: "running",
      }),
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      recordArtifact: async () => {
        recorded = true;
      },
    });

    const result = await runtime.execute(
      input({
        toolRequests: [
          {
            effect: "read",
            idempotencyKey: "tool-missing-external-operation",
            inputSummary: "Invalid async result",
            toolName: "provider.read",
          },
        ],
      }),
    );

    expect(result.completionStatus).toBe("waiting-for-tool");
    expect(result.pendingAction).toEqual({
      effect: "read",
      externalOperationId: `unknown:${id("34")}`,
      idempotencyKey: "tool-missing-external-operation",
      inputSummary: "Invalid async result",
      kind: "tool",
      policyReason: "Allowed.",
      requiredScopes: [],
      toolCallId: id("34"),
      toolName: "provider.read",
    });
    expect(result.assistantMessage).toContain("externalOperationId");
    expect(recorded).toBe(false);
  });
});
