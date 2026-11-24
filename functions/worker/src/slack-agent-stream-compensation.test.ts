import { describe, expect, test } from "bun:test";
import { slackFixture, streamRecord } from "./slack-agent-stream.fixture.ts";
import { SlackAgentStreamApiError, ensureSlackAgentStream } from "./slack-agent-stream.ts";

function failStreamTransitions(test: ReturnType<typeof slackFixture>, failedWriteFailures: number) {
  let failStreamingWrite = true;
  let remainingFailedWriteFailures = failedWriteFailures;
  return {
    ...test.dependencies.database,
    transactWrite: (operations: Parameters<typeof test.dependencies.database.transactWrite>[0]) => {
      const streamTransition = operations.find(
        (operation) =>
          operation.kind === "put" && operation.record.itemType === "slack-agent-stream",
      );
      if (
        failStreamingWrite &&
        streamTransition?.kind === "put" &&
        streamTransition.record.itemType === "slack-agent-stream" &&
        streamTransition.record.data.status === "streaming"
      ) {
        failStreamingWrite = false;
        return Promise.reject(new Error("simulated streaming-state write failure"));
      }
      if (
        remainingFailedWriteFailures > 0 &&
        streamTransition?.kind === "put" &&
        streamTransition.record.itemType === "slack-agent-stream" &&
        streamTransition.record.data.status === "failed"
      ) {
        remainingFailedWriteFailures -= 1;
        return Promise.reject(new Error("simulated compensated-state write failure"));
      }
      return test.dependencies.database.transactWrite(operations);
    },
  };
}

describe("Slack agent stream start compensation", () => {
  test("permits fallback when Slack definitively reports the started stream absent", async () => {
    const test = slackFixture();
    const result = await ensureSlackAgentStream(
      {
        ...test.dependencies,
        database: failStreamTransitions(test, 0),
        slackAgentStream: {
          ...test.dependencies.slackAgentStream,
          stop: async () => {
            throw new SlackAgentStreamApiError("chat.stopStream", 200, "message_not_found");
          },
        },
      },
      test.run,
      test.userMessage,
    );

    expect(result?.data).toMatchObject({ fallbackAllowed: true, status: "failed" });
    expect(streamRecord(test.memory)?.data).toMatchObject({
      fallbackAllowed: true,
      status: "failed",
    });
  });

  test("retains confirmed compensation through transient persistence failures", async () => {
    const test = slackFixture();
    const result = await ensureSlackAgentStream(
      { ...test.dependencies, database: failStreamTransitions(test, 4) },
      test.run,
      test.userMessage,
    );

    expect(result?.data).toMatchObject({ fallbackAllowed: true, status: "failed" });
    expect(test.calls.map((call) => call.method)).toEqual(["start", "stop"]);
  });

  test("bounds persistent compensated-state failures", async () => {
    const test = slackFixture();
    const result = ensureSlackAgentStream(
      { ...test.dependencies, database: failStreamTransitions(test, Number.POSITIVE_INFINITY) },
      test.run,
      test.userMessage,
    );

    expect(result).rejects.toThrow("initialization could not be durably reconciled");
    expect(streamRecord(test.memory)?.data.status).toBe("starting");
    expect(test.calls.map((call) => call.method)).toEqual(["start", "stop"]);
  });
});
