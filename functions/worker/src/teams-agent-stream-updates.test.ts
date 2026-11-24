import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { TeamsConnectorError } from "@deployments-ai/channel-adapters/teams";
import type { AgentPlanUpdate } from "@deployments-ai/streaming";
import {
  TEAMS_CONVERSATION_ID,
  TEAMS_SERVICE_URL,
  teamsFixture,
  teamsStreamRecord,
  terminalRun,
} from "./teams-agent-stream.fixture.ts";
import { ensureTeamsAgentStream, finalizeTeamsAgentStream } from "./teams-agent-stream.ts";
import { appendTeamsAgentPlan, appendTeamsAgentProgress } from "./teams-agent-stream-progress.ts";

/** Lets in-flight connector work settle; `setImmediate` is not faked and runs after microtasks. */
async function settle() {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

function toolProgress(toolCallId: string, eventType: string) {
  return {
    eventType,
    level: "info" as const,
    message: `Running ${toolCallId}.`,
    metadata: { toolCallId, toolName: "github.issue.create" },
  };
}

const plan: AgentPlanUpdate = {
  eventType: "agent.plan.updated",
  plan: {
    revision: 1,
    tasks: [{ id: "inspect", order: 0, status: "in_progress", title: "Inspect the deployment" }],
    title: "Check deployment health",
  },
};

// Teams accepts at most one stream request per second; fake timers drive that interval.
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("Teams informative stream updates", () => {
  test("paces sequential updates and coalesces to the latest status", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);

    // Progress publication returns without waiting for the request interval (timers are frozen).
    await appendTeamsAgentProgress(
      test.dependencies,
      test.run,
      toolProgress("tool-1", "tool.running"),
    );
    await appendTeamsAgentProgress(
      test.dependencies,
      test.run,
      toolProgress("tool-2", "tool.running"),
    );
    await appendTeamsAgentProgress(
      test.dependencies,
      test.run,
      toolProgress("tool-2", "tool.completed"),
    );
    jest.advanceTimersByTime(999);
    await settle();
    expect(test.calls).toHaveLength(1);

    jest.advanceTimersByTime(1);
    await test.waitForCalls(2);
    await settle();
    expect(test.calls[1]).toEqual({
      activity: {
        entities: [
          {
            streamId: "stream-1",
            streamSequence: 2,
            streamType: "informative",
            type: "streaminfo",
          },
        ],
        text: "Done: Use github.issue.create — Running tool-2.",
        type: "typing",
      },
      conversationId: TEAMS_CONVERSATION_ID,
      method: "send",
      serviceUrl: TEAMS_SERVICE_URL,
    });

    await appendTeamsAgentProgress(
      test.dependencies,
      test.run,
      toolProgress("tool-3", "tool.running"),
    );
    jest.advanceTimersByTime(999);
    await settle();
    expect(test.calls).toHaveLength(2);
    jest.advanceTimersByTime(1);
    await test.waitForCalls(3);
    expect(test.calls[2]?.activity.entities).toEqual([
      { streamId: "stream-1", streamSequence: 3, streamType: "informative", type: "streaminfo" },
    ]);
  });

  test("prefers the plan over tool progress for a planned generation", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);

    await appendTeamsAgentPlan(test.dependencies, test.run, test.run.data.version, plan);
    await appendTeamsAgentProgress(
      test.dependencies,
      test.run,
      toolProgress("tool-1", "tool.running"),
    );
    jest.advanceTimersByTime(1_000);
    await test.waitForCalls(2);

    expect(test.calls.map((call) => call.activity.text)).toEqual([
      "Working on: Produce the answer.",
      "Check deployment health (0/1 done) — Working: Inspect the deployment",
    ]);
  });

  test("ignores plan updates from another run generation", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);

    await appendTeamsAgentPlan(test.dependencies, test.run, test.run.data.version + 1, plan);
    jest.advanceTimersByTime(5_000);
    await settle();

    expect(test.calls).toHaveLength(1);
  });

  test("stops updating a segment after a failed update and still finalizes it", async () => {
    const test = teamsFixture();
    test.failures.set(
      1,
      new TeamsConnectorError({
        definitiveRejection: false,
        message: "Teams send activity failed with HTTP 429.",
        retryable: true,
        stage: "connector",
        status: 429,
      }),
    );
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);
    await appendTeamsAgentProgress(
      test.dependencies,
      test.run,
      toolProgress("tool-1", "tool.running"),
    );
    jest.advanceTimersByTime(1_000);
    await test.waitForCalls(2);
    await settle();
    await appendTeamsAgentProgress(
      test.dependencies,
      test.run,
      toolProgress("tool-2", "tool.running"),
    );
    jest.advanceTimersByTime(5_000);
    await settle();

    const stopped = await finalizeTeamsAgentStream({
      body: "Done.",
      dependencies: test.dependencies,
      run: terminalRun(test.run, "completed"),
    });

    expect(test.calls.map((call) => call.activity.entities?.[0]?.streamType)).toEqual([
      "informative",
      "informative",
      "final",
    ]);
    expect(stopped?.data.status).toBe("stopped");
  });

  test("drops a pending update when the stream finalizes", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);
    await appendTeamsAgentProgress(
      test.dependencies,
      test.run,
      toolProgress("tool-1", "tool.running"),
    );

    // Finalization does not wait out the pending update's request interval (timers are frozen).
    await finalizeTeamsAgentStream({
      body: "Done.",
      dependencies: test.dependencies,
      run: terminalRun(test.run, "completed"),
    });
    jest.advanceTimersByTime(5_000);
    await settle();

    expect(test.calls.map((call) => call.activity.entities?.[0]?.streamType)).toEqual([
      "informative",
      "final",
    ]);
  });

  test("bounds the informative updates of one segment", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);

    for (let index = 0; index < 70; index += 1) {
      await appendTeamsAgentProgress(
        test.dependencies,
        test.run,
        toolProgress(`tool-${String(index)}`, "tool.running"),
      );
      jest.advanceTimersByTime(1_000);
      await settle();
    }

    expect(test.calls).toHaveLength(61);
    expect(test.calls.at(-1)?.activity.entities?.[0]).toMatchObject({ streamSequence: 61 });
  });

  test("updates the stream message instead of streaming past the Teams time limit", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);
    test.clock.offsetMs = 115_000;

    await appendTeamsAgentProgress(
      test.dependencies,
      test.run,
      toolProgress("tool-1", "tool.running"),
    );
    jest.advanceTimersByTime(5_000);
    await settle();
    const result = await finalizeTeamsAgentStream({
      body: "Final answer.",
      dependencies: test.dependencies,
      run: terminalRun(test.run, "completed"),
    });

    expect(test.calls.slice(1)).toEqual([
      {
        activity: { text: "Final answer.", textFormat: "markdown", type: "message" },
        activityId: "stream-1",
        conversationId: TEAMS_CONVERSATION_ID,
        method: "update",
        serviceUrl: TEAMS_SERVICE_URL,
      },
    ]);
    expect(result?.data.status).toBe("stopped");
    expect(teamsStreamRecord(test.memory)?.data.status).toBe("stopped");
  });
});
