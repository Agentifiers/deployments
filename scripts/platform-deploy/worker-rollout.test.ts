import { describe, expect, test } from "bun:test";
import { agentWorkerService, rolloutProgress, verifyWorkerRollout } from "./worker-rollout.ts";

const previous = "arn:aws:ecs:us-east-2:123456789012:task-definition/agent-worker:6";
const applied = "arn:aws:ecs:us-east-2:123456789012:task-definition/agent-worker:7";
const service = {
  clusterArn: "arn:aws:ecs:us-east-2:123456789012:cluster/models-cluster",
  serviceName: "agent-worker",
  taskDefinitionArn: applied,
};

describe("agent worker rollout", () => {
  test("waits while old tasks drain and completes once the applied revision is steady", () => {
    expect(
      rolloutProgress(
        [
          { rolloutState: "IN_PROGRESS", status: "PRIMARY", taskDefinition: applied },
          { rolloutState: "COMPLETED", status: "ACTIVE", taskDefinition: previous },
        ],
        applied,
      ),
    ).toEqual({ state: "in-progress" });
    expect(
      rolloutProgress(
        [{ rolloutState: "COMPLETED", status: "PRIMARY", taskDefinition: applied }],
        applied,
      ),
    ).toEqual({ state: "completed" });
  });

  test("fails a release the circuit breaker rolled back to the previous revision", () => {
    const progress = rolloutProgress(
      [{ rolloutState: "COMPLETED", status: "PRIMARY", taskDefinition: previous }],
      applied,
    );
    expect(progress.state).toBe("failed");
  });

  test("fails with the ECS reason when the applied revision's rollout failed", () => {
    expect(
      rolloutProgress(
        [
          {
            rolloutState: "FAILED",
            rolloutStateReason: "ECS deployment circuit breaker: tasks failed to start.",
            status: "PRIMARY",
            taskDefinition: applied,
          },
        ],
        applied,
      ),
    ).toEqual({
      reason: "ECS deployment circuit breaker: tasks failed to start.",
      state: "failed",
    });
  });

  test("polls describe-services until the rollout completes", async () => {
    const states = ["IN_PROGRESS", "IN_PROGRESS", "COMPLETED"];
    const commands: string[][] = [];
    await verifyWorkerRollout({
      retryDelayMs: 0,
      run: async (command) => {
        commands.push([...command]);
        const rolloutState = states.shift();
        return JSON.stringify([{ rolloutState, status: "PRIMARY", taskDefinition: applied }]);
      },
      service,
    });
    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain(service.clusterArn);
  });

  test("stops polling and throws once the rollout is rolled back", async () => {
    let calls = 0;
    expect(
      verifyWorkerRollout({
        retryDelayMs: 0,
        run: async () => {
          calls += 1;
          return JSON.stringify([
            { rolloutState: "COMPLETED", status: "PRIMARY", taskDefinition: previous },
          ]);
        },
        service,
      }),
    ).rejects.toThrow("agent-worker rollout failed");
    expect(calls).toBe(1);
  });

  test("skips verification only when the root exports no worker", () => {
    expect(agentWorkerService({ agent_runtime_worker: null })).toBeUndefined();
    expect(agentWorkerService({})).toBeUndefined();
    expect(() =>
      agentWorkerService({ agent_runtime_worker: { cluster_arn: "arn", service_name: "" } }),
    ).toThrow("agent_runtime_worker.service_name is empty");
  });
});
