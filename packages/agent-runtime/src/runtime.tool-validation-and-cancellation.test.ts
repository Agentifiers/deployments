import { describe, expect, it } from "bun:test";
import type { Ulid } from "@deployments-ai/db";
import {
  runtimeExecutionFailureState,
  RuntimeArtifactValidationError,
  RuntimeToolDeniedError,
  RuntimeToolPreparationRetryableError,
} from "./index.ts";
import type { RuntimeProgressEvent } from "./types.ts";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";

describe("agent runtime", () => {
  it("validates and deduplicates tool correlation IDs before executor calls", async () => {
    let malformedExecuted = false;
    const malformed = createTestAgentRuntime({
      authorizeToolCall: async () =>
        ({ action: "allow", reason: "Allowed.", toolCallId: "not-a-ulid" }) as never,
      executeToolCall: async () => {
        malformedExecuted = true;
        return { status: "completed" };
      },
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
    });
    expect(
      malformed.execute(
        input({
          toolRequests: [
            {
              effect: "write",
              idempotencyKey: "tool-invalid-correlation",
              inputSummary: "Invalid correlation",
              toolName: "provider.write",
            },
          ],
        }),
      ),
    ).rejects.toThrow("toolCallId must be a canonical ULID");
    expect(malformedExecuted).toBe(false);

    let duplicateExecutions = 0;
    const duplicate = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id("38"),
      }),
      executeToolCall: async () => {
        duplicateExecutions += 1;
        return { status: "completed" };
      },
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
    });
    expect(
      duplicate.execute(
        input({
          toolRequests: [
            {
              effect: "read",
              idempotencyKey: "tool-correlation-first",
              inputSummary: "First read",
              toolName: "provider.read",
            },
            {
              effect: "read",
              idempotencyKey: "tool-correlation-second",
              inputSummary: "Second read",
              toolName: "provider.read",
            },
          ],
        }),
      ),
    ).rejects.toThrow("reused toolCallId");
    expect(duplicateExecutions).toBe(1);

    const invalidApproval = createTestAgentRuntime({
      authorizeToolCall: async () =>
        ({
          action: "require-approval",
          approvalId: "not-a-ulid",
          reason: "Approval required.",
          toolCallId: id("39"),
        }) as never,
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
    });
    expect(
      invalidApproval.execute(
        input({
          toolRequests: [
            {
              effect: "write",
              idempotencyKey: "tool-invalid-approval",
              inputSummary: "Invalid approval",
              toolName: "provider.write",
            },
          ],
        }),
      ),
    ).rejects.toThrow("approvalId must be a canonical ULID");

    let invalidAdapterExecuted = false;
    const invalidAdapter = createTestAgentRuntime({
      authorizeToolCall: async () =>
        ({
          action: "allow",
          executionBinding: {
            authorizationFingerprint: "binding-v1",
            connectionId: id("40"),
            externalAccountId: "account-1",
            toolAdapterId: "not-a-ulid",
          },
          reason: "Allowed.",
          toolCallId: id("41"),
        }) as never,
      executeToolCall: async () => {
        invalidAdapterExecuted = true;
        return { status: "completed" };
      },
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
    });
    expect(
      invalidAdapter.execute(
        input({
          toolRequests: [
            {
              effect: "read",
              idempotencyKey: "tool-invalid-adapter",
              inputSummary: "Read with invalid adapter provenance",
              toolName: "provider.read",
            },
          ],
        }),
      ),
    ).rejects.toThrow("toolAdapterId must be a canonical ULID");
    expect(invalidAdapterExecuted).toBe(false);
  });

  it("does not allow undeclared tool fields to replace the pinned run scope", async () => {
    let authorizedOrganization: Ulid | undefined;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async (request) => {
        authorizedOrganization = request.organizationId;
        return {
          action: "allow",
          reason: "Allowed.",
          toolCallId: id("15"),
        };
      },
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage: async () => ({ assistantMessage: "Scoped result." }),
    });

    await runtime.execute(
      input({
        toolRequests: [
          {
            effect: "read",
            idempotencyKey: "tool-scope",
            inputSummary: "Read scoped data",
            organizationId: id("99"),
            toolName: "provider.read",
          } as never,
        ],
      }),
    );

    expect(authorizedOrganization).toBe(id("5"));
  });

  it("rejects tool declarations that disagree with canonical metadata", async () => {
    let authorized = false;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        authorized = true;
        return { action: "allow", reason: "unexpected", toolCallId: id("35") };
      },
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      resolveToolDefinition: async () => ({
        effect: "write",
        requiredScopes: ["provider:write"],
        toolName: "provider.read",
      }),
    });

    expect(
      runtime.execute(
        input({
          toolRequests: [
            {
              effect: "read",
              idempotencyKey: "tool-metadata-mismatch",
              inputSummary: "Misdeclared write",
              requiredScopes: [],
              toolName: "provider.read",
            },
          ],
        }),
      ),
    ).rejects.toThrow("expected write effect");
    expect(authorized).toBe(false);
  });

  it("rejects invalid or reused tool idempotency keys before side effects", async () => {
    let authorized = false;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        authorized = true;
        return { action: "allow", reason: "unexpected", toolCallId: id("36") };
      },
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
    });

    expect(
      runtime.execute(
        input({
          toolRequests: [
            {
              effect: "read",
              idempotencyKey: "reused-key",
              inputSummary: "First read",
              toolName: "provider.read",
            },
            {
              effect: "read",
              idempotencyKey: "reused-key",
              inputSummary: "Second read",
              toolName: "provider.read",
            },
          ],
        }),
      ),
    ).rejects.toThrow("reused within the run");
    expect(authorized).toBe(false);

    expect(
      runtime.execute(
        input({
          toolRequests: [
            {
              effect: "read",
              idempotencyKey: " ",
              inputSummary: "Invalid key",
              toolName: "provider.read",
            },
          ],
        }),
      ),
    ).rejects.toThrow("idempotencyKey must contain");
    expect(authorized).toBe(false);
  });

  it("validates sandbox configuration before memory or tool side effects", async () => {
    let authorized = false;
    let executed = false;
    let recalled = false;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        authorized = true;
        return { action: "allow", reason: "unexpected", toolCallId: id("37") };
      },
      executeToolCall: async () => {
        executed = true;
        return { status: "completed" };
      },
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      recallMemory: async () => {
        recalled = true;
        return [];
      },
    });

    expect(
      runtime.execute(
        input({
          memoryMode: "agent",
          sandboxCommands: [{ command: ["true"] }],
          sandboxPolicy: {
            minMemoryMiB: 0,
            mode: "run-ephemeral",
            provider: "aws_lambda_microvm",
          },
          toolRequests: [
            {
              effect: "write",
              idempotencyKey: "tool-before-invalid-sandbox",
              inputSummary: "Perform side effect",
              toolName: "provider.write",
            },
          ],
        }),
      ),
    ).rejects.toThrow("minMemoryMiB");
    expect(recalled).toBe(false);
    expect(authorized).toBe(false);
    expect(executed).toBe(false);
  });

  it("records artifacts from an earlier tool before a later tool fails", async () => {
    const recorded: string[] = [];
    let authorizationCount = 0;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: authorizationCount++ === 0 ? "allow" : "deny",
        reason: "Policy decision.",
        toolCallId: id(String(20 + authorizationCount)),
      }),
      executeToolCall: async () => ({
        artifacts: [
          {
            content: "first tool evidence",
            fileName: "first.txt",
            label: "First tool",
          },
        ],
        status: "completed",
      }),
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      recordArtifact: async (artifact) => void recorded.push(artifact.fileName),
    });

    let failure: unknown;
    try {
      await runtime.execute(
        input({
          toolRequests: [
            {
              effect: "read",
              idempotencyKey: "tool-first",
              inputSummary: "First read",
              toolName: "provider.first",
            },
            {
              effect: "write",
              idempotencyKey: "tool-second",
              inputSummary: "Second write",
              toolName: "provider.second",
            },
          ],
        }),
      );
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(RuntimeToolDeniedError);
    expect(runtimeExecutionFailureState(failure)?.completedToolCalls).toEqual([
      expect.objectContaining({ toolName: "provider.first" }),
    ]);
    expect(recorded).toEqual(["first.txt"]);
  });

  it("reuses only artifact indexes that were not durably recorded", async () => {
    const recorded: Array<{ readonly fileName: string; readonly index: number }> = [];
    let executionCount = 0;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id(String(50 + executionCount)),
      }),
      executeToolCall: async () => {
        executionCount += 1;
        return executionCount === 1
          ? {
              artifacts: [
                { content: "persisted", fileName: "persisted.txt", label: "Persisted" },
                { content: "failed", fileName: "failed.txt", label: "Failed" },
              ],
              status: "completed" as const,
            }
          : {
              artifacts: [{ content: "later", fileName: "later.txt", label: "Later" }],
              status: "completed" as const,
            };
      },
      generateAssistantMessage: async (request) => {
        expect(request.sandboxArtifacts.map((artifact) => artifact.fileName)).toEqual([
          "persisted.txt",
          "later.txt",
        ]);
        return { assistantMessage: "Completed with persisted artifacts." };
      },
      recordArtifact: async (artifact, index) => {
        recorded.push({ fileName: artifact.fileName, index });
        if (artifact.fileName === "failed.txt") {
          throw new RuntimeArtifactValidationError("artifact write failed");
        }
      },
    });

    const result = await runtime.execute(
      input({
        toolRequests: [
          {
            effect: "read",
            idempotencyKey: "tool-partial-artifacts",
            inputSummary: "Return partially persisted artifacts",
            toolName: "provider.first",
          },
          {
            effect: "read",
            idempotencyKey: "tool-later-artifact",
            inputSummary: "Return another artifact",
            toolName: "provider.read",
          },
        ],
      }),
    );

    expect(result.artifacts.map((artifact) => artifact.fileName)).toEqual([
      "persisted.txt",
      "later.txt",
    ]);
    expect(recorded).toEqual([
      { fileName: "persisted.txt", index: 0 },
      { fileName: "failed.txt", index: 1 },
      { fileName: "later.txt", index: 1 },
    ]);
  });

  it("ignores malformed optional operation correlation after a tool completes", async () => {
    let executionCount = 0;
    const progress: RuntimeProgressEvent[] = [];
    const runtime = createTestAgentRuntime({
      appendProgress: async (event) => void progress.push(event),
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id("59"),
      }),
      executeToolCall: async () => {
        executionCount += 1;
        return {
          externalOperationId: " unknown:invalid-completed-operation ",
          status: "completed",
        };
      },
      generateAssistantMessage: async () => ({ assistantMessage: "completed" }),
    });

    const result = await runtime.execute(
      input({
        toolRequests: [
          {
            effect: "read",
            idempotencyKey: "tool-invalid-completed-correlation",
            inputSummary: "Complete despite invalid optional correlation",
            toolName: "provider.read",
          },
        ],
      }),
    );

    expect(executionCount).toBe(1);
    expect(result.completionStatus).toBe("completed");
    expect(result.completedToolCalls).toEqual([
      expect.not.objectContaining({ externalOperationId: expect.anything() }),
    ]);
    expect(progress).toContainEqual(
      expect.objectContaining({ eventType: "tool.correlation.ignored", level: "warn" }),
    );
  });

  it("does not execute a tool canceled while authorization is in flight", async () => {
    let canceled = false;
    let executed = false;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        canceled = true;
        return { action: "allow", reason: "Allowed.", toolCallId: id("30") };
      },
      executeToolCall: async () => {
        executed = true;
        return { status: "completed" };
      },
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      shouldCancel: async () => canceled,
    });

    const result = await runtime.execute(
      input({
        toolRequests: [
          {
            effect: "write",
            idempotencyKey: "tool-cancel-race",
            inputSummary: "Write after policy",
            toolName: "provider.write",
          },
        ],
      }),
    );

    expect(result.completionStatus).toBe("canceled");
    expect(executed).toBe(false);
  });

  it("preserves approval correlation when cancellation races authorization", async () => {
    let canceled = false;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        canceled = true;
        return {
          action: "require-approval",
          approvalId: id("53"),
          reason: "Approval was reserved before cancellation.",
          toolCallId: id("54"),
        };
      },
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      shouldCancel: async () => canceled,
    });

    const result = await runtime.execute(
      input({
        toolRequests: [
          {
            effect: "write",
            idempotencyKey: "tool-approval-cancel-race",
            inputSummary: "Reserve approval during cancellation",
            toolName: "provider.write",
          },
        ],
      }),
    );

    expect(result.completionStatus).toBe("canceled");
    expect(result.pendingAction).toBeUndefined();
  });

  it("preserves completed tools and artifacts when a later tool is canceled", async () => {
    let authorizationCount = 0;
    let canceled = false;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        authorizationCount += 1;
        if (authorizationCount === 2) canceled = true;
        return {
          action: "allow",
          reason: "Allowed.",
          toolCallId: id(String(40 + authorizationCount)),
        };
      },
      executeToolCall: async () => ({
        artifacts: [
          {
            content: "completed evidence",
            fileName: "completed.txt",
            label: "Completed evidence",
          },
        ],
        externalOperationId: "completed-operation-1",
        outputSummary: "Completed first tool.",
        status: "completed",
      }),
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
      shouldCancel: async () => canceled,
    });

    const result = await runtime.execute(
      input({
        toolRequests: [
          {
            effect: "read",
            idempotencyKey: "tool-completed-before-cancel",
            inputSummary: "Complete first",
            toolName: "provider.first",
          },
          {
            effect: "write",
            idempotencyKey: "tool-canceled-second",
            inputSummary: "Cancel second",
            toolName: "provider.second",
          },
        ],
      }),
    );

    expect(result.completionStatus).toBe("canceled");
    expect(result.artifacts.map((artifact) => artifact.fileName)).toEqual(["completed.txt"]);
    expect(result.completedToolCalls).toEqual([
      expect.objectContaining({
        externalOperationId: "completed-operation-1",
        toolName: "provider.first",
      }),
    ]);
  });

  it("retries a failing read twice across run attempts, then gives the model its error", async () => {
    const progress: RuntimeProgressEvent[] = [];
    const answers: string[] = [];
    const runtime = createTestAgentRuntime({
      appendProgress: async (event) => void progress.push(event),
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id("81"),
      }),
      executeToolCall: async () => {
        throw new RuntimeToolPreparationRetryableError(
          "provider.first",
          new Error("Firecrawl request failed with HTTP 502."),
        );
      },
      generateAssistantMessage: async (request) => {
        answers.push(JSON.stringify(request.completedToolCalls.map((call) => call.output)));
        return { assistantMessage: "Tried another source." };
      },
    });
    const read = (retriedToolCall?: { failures: number; idempotencyKey: string }) =>
      runtime.execute(
        input({
          ...(retriedToolCall ? { retriedToolCall } : {}),
          toolRequests: [
            {
              effect: "read",
              idempotencyKey: "read-page",
              inputSummary: "Read the page",
              toolName: "provider.first",
            },
          ],
        }),
      );

    const first = await read().catch((cause: unknown) => cause);
    expect(first).toBeInstanceOf(RuntimeToolPreparationRetryableError);
    expect((first as RuntimeToolPreparationRetryableError).retriedToolCall).toEqual({
      failures: 1,
      idempotencyKey: "read-page",
    });
    // A count left by another call does not carry over to this one.
    const other = await read({ failures: 2, idempotencyKey: "another-call" }).catch(
      (cause: unknown) => cause,
    );
    expect((other as RuntimeToolPreparationRetryableError).retriedToolCall?.failures).toBe(1);
    const second = await read({ failures: 1, idempotencyKey: "read-page" }).catch(
      (cause: unknown) => cause,
    );
    expect((second as RuntimeToolPreparationRetryableError).retriedToolCall?.failures).toBe(2);
    expect(answers).toEqual([]);

    const third = await read({ failures: 2, idempotencyKey: "read-page" });
    expect(third.completedToolCalls).toEqual([
      expect.objectContaining({
        output: {
          error: {
            code: "retries_exhausted",
            message: "Firecrawl request failed with HTTP 502.",
          },
        },
        toolName: "provider.first",
      }),
    ]);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toContain("retries_exhausted");
    expect(
      progress
        .filter((event) => event.eventType.startsWith("tool.retr"))
        .map((event) => [event.eventType, event.metadata?.failures]),
    ).toEqual([
      ["tool.retry-scheduled", 1],
      ["tool.retry-scheduled", 1],
      ["tool.retry-scheduled", 2],
      ["tool.retries-exhausted", 3],
    ]);
  });

  it("keeps retrying a mutation whose failure it cannot hand to the model", async () => {
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id("82"),
      }),
      executeToolCall: async () => {
        throw new RuntimeToolPreparationRetryableError(
          "provider.write",
          new Error("credential vault unavailable"),
        );
      },
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
    });
    const write = await runtime
      .execute(
        input({
          retriedToolCall: { failures: 9, idempotencyKey: "write-record" },
          toolRequests: [
            {
              effect: "write",
              idempotencyKey: "write-record",
              inputSummary: "Write the record",
              toolName: "provider.write",
            },
          ],
        }),
      )
      .catch((cause: unknown) => cause);
    expect(write).toBeInstanceOf(RuntimeToolPreparationRetryableError);
    expect((write as RuntimeToolPreparationRetryableError).retriedToolCall).toBeUndefined();
  });

  it("attaches completed tool state to retryable preparation failures", async () => {
    let authorizationCount = 0;
    let executionCount = 0;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id(String(70 + ++authorizationCount)),
      }),
      executeToolCall: async () => {
        executionCount += 1;
        if (executionCount === 2) {
          throw new RuntimeToolPreparationRetryableError(
            "provider.second",
            new Error("credential vault unavailable"),
          );
        }
        return {
          artifacts: [
            {
              content: "first tool evidence",
              fileName: "first-tool.txt",
              label: "First tool evidence",
            },
          ],
          outputSummary: "First completed.",
          status: "completed",
        };
      },
      generateAssistantMessage: async () => ({ assistantMessage: "unexpected" }),
    });

    try {
      await runtime.execute(
        input({
          toolRequests: [
            {
              effect: "read",
              idempotencyKey: "tool-before-preparation-retry",
              inputSummary: "Complete first",
              toolName: "provider.first",
            },
            {
              effect: "write",
              idempotencyKey: "tool-preparation-retry",
              inputSummary: "Retry second",
              toolName: "provider.second",
            },
          ],
        }),
      );
      throw new Error("Expected runtime preparation to fail.");
    } catch (cause) {
      expect(cause).toBeInstanceOf(RuntimeToolPreparationRetryableError);
      expect(runtimeExecutionFailureState(cause)?.completedToolCalls).toEqual([
        expect.objectContaining({ toolName: "provider.first" }),
      ]);
      expect(runtimeExecutionFailureState(cause)?.artifactContinuation).toEqual({
        artifactBytes: 19,
        artifactIndexCursor: 1,
        artifacts: [
          {
            contentType: "application/octet-stream",
            fileName: "first-tool.txt",
            label: "First tool evidence",
            type: "report",
          },
        ],
      });
      expect(runtimeExecutionFailureState(cause)?.usage).toHaveLength(1);
    }
  });
});
