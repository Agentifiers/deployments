import { describe, expect, test } from "bun:test";
import { createHeartbeat, fireHeartbeat } from "./index.ts";
import { agentDeploymentId, dependencies, memoryDatabase, scope } from "./automation.fixture.ts";

async function fireAt(date: string, fireKey: string) {
  const memory = memoryDatabase();
  const fixture = dependencies(memory);
  const heartbeat = await createHeartbeat(
    {
      ...scope,
      activeWindow: { daysOfWeek: [1], endMinuteOfDay: 2 * 60, startMinuteOfDay: 22 * 60 },
      agentDeploymentId,
      idempotencyKey: `overnight-${fireKey}`,
      instructions: "Review queued work",
      intervalMs: 60_000,
      timezone: "UTC",
    },
    fixture.dependencies,
  );
  const result = await fireHeartbeat(
    { ...scope, agentDeploymentId, fireKey, heartbeatId: heartbeat.data.id },
    { ...fixture.dependencies, now: () => new Date(date) },
  );
  return { result, runs: fixture.runs };
}

describe("heartbeat overnight active windows", () => {
  test("attributes the after-midnight segment to the window start day", async () => {
    const mondayWindow = await fireAt("2026-07-21T01:00:00.000Z", "tuesday-early");
    expect(mondayWindow.result.heartbeatRun.data.status).toBe("accepted");
    expect(mondayWindow.runs).toHaveLength(1);

    const sundayWindow = await fireAt("2026-07-20T01:00:00.000Z", "monday-early");
    expect(sundayWindow.result.heartbeatRun.data.status).toBe("skipped");
    expect(sundayWindow.result.heartbeatRun.data.skipReason).toBe("outside-active-window");
    expect(sundayWindow.runs).toHaveLength(0);
  });
});
