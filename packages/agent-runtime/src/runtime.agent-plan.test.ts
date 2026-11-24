import { describe, expect, test } from "bun:test";
import type { RuntimeAgentPlanEvent } from "./types.ts";
import { createTestAgentRuntime, input } from "./runtime.fixture.ts";
import { RuntimeAgentPlanTracker } from "./runtime-agent-plan.ts";

describe("runtime agent plans", () => {
  test("publishes a monotonic response plan", async () => {
    const plans: RuntimeAgentPlanEvent[] = [];
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "Done." }),
      publishAgentPlan: async (event) => void plans.push(event),
    });

    await runtime.execute(input());

    expect(plans.map((event) => event.plan.revision)).toEqual([1, 2, 3]);
    expect(plans.map((event) => event.eventType)).toEqual([
      "agent.plan.updated",
      "agent.task.updated",
      "agent.task.updated",
    ]);
    expect(plans[0]).toMatchObject({
      plan: {
        tasks: [{ id: "produce-response", order: 0, status: "pending" }],
        title: "Complete the request",
      },
      runAttempt: 0,
      runExecutionVersion: 1,
    });
    expect(plans[2]).toMatchObject({
      task: { id: "produce-response", status: "completed" },
    });
  });

  test("leaves an approval task active with a waiting detail", async () => {
    const plans: RuntimeAgentPlanEvent[] = [];
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "require-approval",
        approvalId: input().runId,
        reason: "Approval required.",
        toolCallId: input().threadId,
      }),
      executeToolCall: async () => ({ status: "completed" }),
      generateAssistantMessage: async () => ({ assistantMessage: "Not reached." }),
      publishAgentPlan: async (event) => void plans.push(event),
    });

    await runtime.execute(
      input({
        toolRequests: [
          {
            effect: "read",
            idempotencyKey: "approval-plan",
            inputSummary: "Read a resource",
            toolName: "provider.read",
          },
        ],
      }),
    );

    expect(plans.at(-1)).toMatchObject({
      eventType: "agent.task.updated",
      task: {
        details: "Waiting for approval",
        id: "use-tools",
        status: "in_progress",
      },
    });
  });

  test("clears obsolete task details on the next transition", async () => {
    const plans: RuntimeAgentPlanEvent[] = [];
    const tracker = new RuntimeAgentPlanTracker(
      input({
        toolRequests: [
          {
            effect: "read",
            idempotencyKey: "detail",
            inputSummary: "Read",
            toolName: "provider.read",
          },
        ],
      }),
      {
        generateAssistantMessage: async () => ({ assistantMessage: "Done." }),
        publishAgentPlan: async (event) => void plans.push(event),
      },
    );
    await tracker.start();
    await tracker.updateTask("use-tools", "in_progress", "Waiting for approval");
    await tracker.updateTask("use-tools", "completed");

    expect(plans.at(-1)).toMatchObject({ task: { id: "use-tools", status: "completed" } });
    expect(plans.at(-1)).not.toHaveProperty("task.details");
  });

  test("keeps plan publication failures from failing agent execution", async () => {
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "Done." }),
      publishAgentPlan: async () => {
        throw new Error("plan sink unavailable");
      },
    });

    expect(runtime.execute(input())).resolves.toMatchObject({
      assistantMessage: "Done.",
      completionStatus: "completed",
    });
  });

  test("retries a full snapshot after initial publication recovers", async () => {
    const plans: RuntimeAgentPlanEvent[] = [];
    let calls = 0;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "Done." }),
      publishAgentPlan: async (event) => {
        calls += 1;
        if (calls === 1) throw new Error("initial sink outage");
        plans.push(event);
      },
    });

    await runtime.execute(input());

    expect(plans[0]).toMatchObject({
      eventType: "agent.plan.updated",
      plan: {
        revision: 2,
        tasks: [{ id: "produce-response", status: "in_progress" }],
      },
    });
    expect(plans.at(-1)).toMatchObject({
      eventType: "agent.task.updated",
      task: { id: "produce-response", status: "completed" },
    });
  });

  test("repairs a failed incremental update with the next full snapshot", async () => {
    const plans: RuntimeAgentPlanEvent[] = [];
    let calls = 0;
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "Done." }),
      publishAgentPlan: async (event) => {
        calls += 1;
        if (calls === 2) throw new Error("delta sink outage");
        plans.push(event);
      },
    });

    await runtime.execute(input());

    expect(plans.map((event) => event.eventType)).toEqual([
      "agent.plan.updated",
      "agent.plan.updated",
    ]);
    expect(plans.at(-1)).toMatchObject({
      plan: {
        revision: 3,
        tasks: [{ id: "produce-response", status: "completed" }],
      },
    });
  });

  test("fails every active nested task", async () => {
    const plans: RuntimeAgentPlanEvent[] = [];
    const tracker = new RuntimeAgentPlanTracker(
      input({
        toolRequests: [
          {
            effect: "read",
            idempotencyKey: "nested-failure",
            inputSummary: "Read",
            toolName: "provider.read",
          },
        ],
      }),
      {
        generateAssistantMessage: async () => ({ assistantMessage: "Done." }),
        publishAgentPlan: async (event) => void plans.push(event),
      },
    );
    await tracker.start();
    await tracker.updateTask("produce-response", "in_progress");
    await tracker.updateTask("use-tools", "in_progress");
    await tracker.failActive("Execution failed");

    expect(
      plans
        .filter((event) => event.eventType === "agent.task.updated")
        .slice(-2)
        .map((event) => (event.eventType === "agent.task.updated" ? event.task : undefined)),
    ).toEqual([
      {
        details: "Execution failed",
        id: "use-tools",
        order: 0,
        status: "failed",
        title: "Use tools as needed",
      },
      {
        details: "Execution failed",
        id: "produce-response",
        order: 1,
        status: "failed",
        title: "Produce the response",
      },
    ]);
  });
});
