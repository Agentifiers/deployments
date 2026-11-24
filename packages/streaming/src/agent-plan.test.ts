import { describe, expect, test } from "bun:test";
import { parseAgentPlanUpdate } from "./agent-plan.ts";

const task = {
  id: "produce-response",
  order: 0,
  status: "pending" as const,
  title: "Produce the response",
};

describe("agent plan contract", () => {
  test("parses full snapshots and individual task transitions", () => {
    expect(
      parseAgentPlanUpdate({
        eventType: "agent.plan.updated",
        plan: { revision: 1, tasks: [task], title: "Complete the request" },
      }),
    ).toEqual({
      eventType: "agent.plan.updated",
      plan: { revision: 1, tasks: [task], title: "Complete the request" },
    });
    expect(
      parseAgentPlanUpdate({
        eventType: "agent.task.updated",
        plan: { revision: 2, title: "Complete the request" },
        task: { ...task, details: "Writing the answer", status: "in_progress" },
      }),
    ).toMatchObject({ eventType: "agent.task.updated", plan: { revision: 2 } });
  });

  test("rejects invalid revisions, duplicate tasks, and unsupported statuses", () => {
    expect(() =>
      parseAgentPlanUpdate({
        eventType: "agent.plan.updated",
        plan: { revision: 0, tasks: [task], title: "Complete the request" },
      }),
    ).toThrow("positive integers");
    expect(() =>
      parseAgentPlanUpdate({
        eventType: "agent.plan.updated",
        plan: { revision: 1, tasks: [task, { ...task, order: 1 }], title: "Duplicate" },
      }),
    ).toThrow("IDs must be unique");
    expect(() =>
      parseAgentPlanUpdate({
        eventType: "agent.task.updated",
        plan: { revision: 2, title: "Complete the request" },
        task: { ...task, status: "blocked" },
      }),
    ).toThrow("status is not supported");
  });

  test("bounds plan size and text", () => {
    expect(() =>
      parseAgentPlanUpdate({
        eventType: "agent.plan.updated",
        plan: {
          revision: 1,
          tasks: Array.from({ length: 17 }, (_, order) => ({
            ...task,
            id: `task-${order}`,
            order,
          })),
          title: "Too many tasks",
        },
      }),
    ).toThrow("at most 16 tasks");
    expect(() =>
      parseAgentPlanUpdate({
        eventType: "agent.plan.updated",
        plan: { revision: 1, tasks: [task], title: "x".repeat(257) },
      }),
    ).toThrow("at most 256 characters");
  });
});
