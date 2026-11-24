import { describe, expect, it } from "bun:test";
import { CreateScheduleCommand } from "@aws-sdk/client-scheduler";
import { ApprovalResolutionError, pausedToolCallRecord, resolveRunToolResult } from "./index.ts";
import {
  asyncFixture,
  claimResumedRun,
  dependencies,
  inMemoryDatabase,
} from "./approvals.fixture.ts";
import {
  createClientToolExpirationScheduler,
  expireClientToolCall,
} from "./client-tool-expiration.ts";
import { runtimeCompletedToolCall } from "./continuation.ts";
import type { ResolveRunToolResultInput } from "./approval-shared.ts";
import { appendPausedRunEvent } from "./agent-run-terminal.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";

const outputSchema = {
  additionalProperties: false,
  properties: { temperature: { type: "number" } },
  required: ["temperature"],
  type: "object",
};

function clientFixture(expiresAt = "2026-07-22T00:15:00.000Z") {
  const waiting = asyncFixture();
  const toolCall = pausedToolCallRecord({
    action: {
      client: { expiresAt, outputSchema },
      effect: "read",
      executionBinding: {
        authorizationFingerprint: "client:weather.local",
        connectionId: waiting.toolCall.data.id,
        externalAccountId: "client:weather.local",
      },
      externalOperationId: waiting.toolCall.data.id,
      idempotencyKey: "tool/weather-1",
      input: { city: "Oslo" },
      inputSummary: "Read the local weather.",
      kind: "tool",
      policyReason: "Allowed.",
      requiredScopes: [],
      toolCallId: waiting.toolCall.data.id,
      toolName: "weather.local",
    },
    now: new Date("2026-07-22T00:00:00.000Z"),
    run: waiting.run,
  });
  const { externalOperationId: _externalOperationId, ...base } = waiting.input;
  const input: ResolveRunToolResultInput = {
    ...base,
    outcome: "completed",
    output: { temperature: 21.5 },
    outputSummary: "Local weather read.",
  };
  return { input, run: waiting.run, toolCall };
}

describe("client tool results", () => {
  it("persists paused client tool metadata on the tool call", () => {
    const { toolCall } = clientFixture();
    expect(toolCall.data).toMatchObject({
      executionType: "client",
      expiresAt: "2026-07-22T00:15:00.000Z",
      externalOperationId: toolCall.data.id,
      input: { city: "Oslo" },
      outputSchema,
      status: "running",
    });
  });

  it("schedules the deadline and streams the client input when the run pauses", async () => {
    const waiting = clientFixture();
    const scheduled: unknown[] = [];
    const events: Array<{ readonly eventType: string; readonly payload?: unknown }> = [];
    const pendingAction = {
      client: { expiresAt: "2026-07-22T00:15:00.000Z", outputSchema },
      effect: "read" as const,
      externalOperationId: waiting.toolCall.data.id,
      idempotencyKey: "tool/weather-1",
      input: { city: "Oslo" },
      inputSummary: "Read the local weather.",
      kind: "tool" as const,
      policyReason: "Allowed.",
      requiredScopes: [],
      toolCallId: waiting.toolCall.data.id,
      toolName: "weather.local",
    };
    const worker = {
      appendThreadEvent: async (event: { eventType: string; payload?: unknown }) =>
        void events.push(event),
      scheduleClientToolExpiration: async (input: unknown) => void scheduled.push(input),
      workerId: "worker-1",
    } as unknown as AgentRunWorkerDependencies;

    await appendPausedRunEvent(worker, waiting.run, pendingAction);

    expect(scheduled).toEqual([
      expect.objectContaining({
        expiresAt: "2026-07-22T00:15:00.000Z",
        runId: waiting.run.data.id,
        toolCallId: waiting.toolCall.data.id,
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "tool.running",
      payload: {
        clientTool: {
          expiresAt: "2026-07-22T00:15:00.000Z",
          input: { city: "Oslo" },
          outputSchema,
        },
      },
    });

    const { client: _client, ...providerAction } = pendingAction;
    events.length = 0;
    await appendPausedRunEvent(worker, waiting.run, providerAction);
    expect(events[0]?.payload).not.toHaveProperty("clientTool");
    expect(scheduled).toHaveLength(1);
    expect(
      appendPausedRunEvent(
        {
          ...worker,
          scheduleClientToolExpiration: undefined,
        } as unknown as AgentRunWorkerDependencies,
        waiting.run,
        pendingAction,
      ),
    ).rejects.toThrow("Client tool expiration scheduling is unavailable");
  });

  it("completes with structured output, resumes the run, and replays identical results", async () => {
    const waiting = clientFixture();
    const memory = inMemoryDatabase([waiting.run, waiting.toolCall]);
    const test = dependencies(memory.database);

    const first = await resolveRunToolResult(waiting.input, test.dependencies);
    const replay = await resolveRunToolResult(
      { ...waiting.input, output: { temperature: 21.5 } },
      test.dependencies,
    );

    expect(first.toolCall.data).toMatchObject({
      externalOperationId: waiting.toolCall.data.id,
      output: { temperature: 21.5 },
      status: "succeeded",
    });
    expect(first.run.data.status).toBe("queued");
    expect(replay.toolCall.data.version).toBe(first.toolCall.data.version);
    expect(test.enqueued).toHaveLength(1);
    expect(runtimeCompletedToolCall(first.toolCall).output).toEqual({ temperature: 21.5 });
  });

  it("rejects a conflicting resolution after the client tool completed", async () => {
    const waiting = clientFixture();
    const memory = inMemoryDatabase([waiting.run, waiting.toolCall]);
    const test = dependencies(memory.database);
    await resolveRunToolResult(waiting.input, test.dependencies);

    expect(
      resolveRunToolResult({ ...waiting.input, output: { temperature: 3 } }, test.dependencies),
    ).rejects.toMatchObject({ code: "tool_call_already_resolved" });
    expect(
      resolveRunToolResult({ ...waiting.input, outcome: "failed" }, test.dependencies),
    ).rejects.toMatchObject({ code: "tool_call_already_resolved" });
  });

  it("replays an identical result after the worker claimed the resumed run", async () => {
    const waiting = clientFixture();
    const memory = inMemoryDatabase([waiting.run, waiting.toolCall]);
    const test = dependencies(memory.database);
    const first = await resolveRunToolResult(waiting.input, test.dependencies);
    claimResumedRun(memory.records, first.run);

    const replay = await resolveRunToolResult(waiting.input, test.dependencies);

    expect(replay.toolCall).toEqual(first.toolCall);
    expect(replay.run.data).toMatchObject({
      status: "running",
      version: first.run.data.version + 1,
    });
    expect(replay.queueMessage).toBeUndefined();
    expect(test.enqueued).toHaveLength(1);
    expect(test.events.map((event) => event.eventType)).toEqual(["tool.completed"]);
    const lease = [...memory.records.values()].find(
      (record) => record.itemType === "runtime-lease",
    );
    expect(lease?.data.owner).toBe("worker:resumed");
    expect(
      resolveRunToolResult({ ...waiting.input, output: { temperature: 3 } }, test.dependencies),
    ).rejects.toMatchObject({ code: "tool_call_already_resolved" });
  });

  it("requires schema-valid output for completed client tools without mutating state", async () => {
    const waiting = clientFixture();
    const memory = inMemoryDatabase([waiting.run, waiting.toolCall]);
    const test = dependencies(memory.database);
    const { output: _output, ...withoutOutput } = waiting.input;

    for (const input of [
      withoutOutput,
      { ...waiting.input, output: { temperature: "warm" } },
      { ...waiting.input, output: { text: "x".repeat(96 * 1024) } },
    ]) {
      expect(resolveRunToolResult(input, test.dependencies)).rejects.toMatchObject({
        code: "invalid_tool_output",
      });
    }
    expect(test.enqueued).toHaveLength(0);
    const persisted = [...memory.records.values()].find(
      (record) => record.itemType === "tool-call",
    );
    expect(persisted?.data.status).toBe("running");
  });

  it("rejects a client-supplied operation id that differs from the tool call id", async () => {
    const waiting = clientFixture();
    const memory = inMemoryDatabase([waiting.run, waiting.toolCall]);
    const test = dependencies(memory.database);
    expect(
      resolveRunToolResult(
        { ...waiting.input, externalOperationId: "other-operation" },
        test.dependencies,
      ),
    ).rejects.toMatchObject({ code: "external_operation_mismatch" });
  });

  it("resumes the run when the client reports failure so the model can recover", async () => {
    const waiting = clientFixture();
    const memory = inMemoryDatabase([waiting.run, waiting.toolCall]);
    const test = dependencies(memory.database);
    const { output: _output, ...failedInput } = waiting.input;

    const result = await resolveRunToolResult(
      { ...failedInput, outcome: "failed", outputSummary: "Sensor offline." },
      test.dependencies,
    );

    expect(result.toolCall.data.status).toBe("failed");
    expect(result.run.data.status).toBe("queued");
    expect(test.enqueued).toHaveLength(1);
    expect(runtimeCompletedToolCall(result.toolCall).output).toEqual({
      error: "Sensor offline.",
      status: "failed",
    });
  });

  it("refuses late client submissions after the deadline", async () => {
    const waiting = clientFixture("2026-07-22T00:00:30.000Z");
    const memory = inMemoryDatabase([waiting.run, waiting.toolCall]);
    const test = dependencies(memory.database);
    const error = await resolveRunToolResult(waiting.input, test.dependencies).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ApprovalResolutionError);
    expect(error).toMatchObject({ code: "tool_call_expired" });
  });
});

describe("client tool expiration", () => {
  it("fails an expired client tool call and resumes its run", async () => {
    const waiting = clientFixture("2026-07-22T00:00:30.000Z");
    const memory = inMemoryDatabase([waiting.run, waiting.toolCall]);
    const test = dependencies(memory.database);
    const command = {
      environmentId: waiting.run.data.environmentId,
      organizationId: waiting.run.data.organizationId,
      projectId: waiting.run.data.projectId,
      runId: waiting.run.data.id,
      threadId: waiting.run.data.threadId,
      toolCallId: waiting.toolCall.data.id,
    };

    const outcome = await expireClientToolCall(command, test.dependencies);
    const redelivered = await expireClientToolCall(command, test.dependencies);

    expect(outcome.status).toBe("expired");
    if (outcome.status !== "expired") throw new Error("Expected expiry.");
    expect(outcome.result.toolCall.data).toMatchObject({
      outputSummary: "Client tool did not return a result before it expired.",
      status: "failed",
    });
    expect(outcome.result.run.data.status).toBe("queued");
    expect(redelivered.status).toBe("expired");
    expect(test.enqueued).toHaveLength(1);
    expect(test.events.map((event) => event.eventType)).toContain("tool.failed");
  });

  it("does not expire a call before its deadline and ignores resolved calls", async () => {
    const waiting = clientFixture();
    const memory = inMemoryDatabase([waiting.run, waiting.toolCall]);
    const test = dependencies(memory.database);
    const command = {
      environmentId: waiting.run.data.environmentId,
      organizationId: waiting.run.data.organizationId,
      projectId: waiting.run.data.projectId,
      runId: waiting.run.data.id,
      threadId: waiting.run.data.threadId,
      toolCallId: waiting.toolCall.data.id,
    };

    expect(expireClientToolCall(command, test.dependencies)).rejects.toMatchObject({
      code: "tool_call_expired",
    });
    await resolveRunToolResult(waiting.input, test.dependencies);
    expect(expireClientToolCall(command, test.dependencies)).resolves.toEqual({
      status: "resolved",
    });
  });

  it("schedules a one-time expiry at the rounded-up deadline", async () => {
    const sent: unknown[] = [];
    const schedule = createClientToolExpirationScheduler({
      client: { send: async (command: unknown) => void sent.push(command) } as never,
      env: {
        DEPLOYMENTS_AI_AUTOMATION_FAILURE_QUEUE_ARN: "arn:aws:sqs:us-east-1:1:failures",
        DEPLOYMENTS_AI_CLIENT_TOOL_TIMEOUT_LAMBDA_ARN:
          "arn:aws:lambda:us-east-1:1:function:client-tool-timeout",
        DEPLOYMENTS_AI_SCHEDULER_GROUP: "runtime",
        DEPLOYMENTS_AI_SCHEDULER_ROLE_ARN: "arn:aws:iam::1:role/scheduler",
      },
    });
    const waiting = clientFixture("2026-07-22T00:15:00.250Z");
    await schedule({
      environmentId: waiting.run.data.environmentId,
      expiresAt: "2026-07-22T00:15:00.250Z",
      organizationId: waiting.run.data.organizationId,
      projectId: waiting.run.data.projectId,
      runId: waiting.run.data.id,
      threadId: waiting.run.data.threadId,
      toolCallId: waiting.toolCall.data.id,
    });

    expect(sent).toHaveLength(1);
    const command = sent[0] as CreateScheduleCommand;
    expect(command).toBeInstanceOf(CreateScheduleCommand);
    expect(command.input.ScheduleExpression).toBe("at(2026-07-22T00:15:01)");
    expect(command.input.Name).toBe(`client-tool-${waiting.toolCall.data.id}`);
    expect(JSON.parse(command.input.Target!.Input!)).toMatchObject({
      runId: waiting.run.data.id,
      toolCallId: waiting.toolCall.data.id,
    });
  });

  it("fails closed when expiry scheduling is not configured", async () => {
    const schedule = createClientToolExpirationScheduler({
      client: { send: async () => undefined } as never,
      env: {},
    });
    const waiting = clientFixture();
    expect(
      schedule({
        environmentId: waiting.run.data.environmentId,
        expiresAt: "2026-07-22T00:15:00.000Z",
        organizationId: waiting.run.data.organizationId,
        projectId: waiting.run.data.projectId,
        runId: waiting.run.data.id,
        threadId: waiting.run.data.threadId,
        toolCallId: waiting.toolCall.data.id,
      }),
    ).rejects.toThrow("DEPLOYMENTS_AI_");
  });
});
