import { expect, jest, test } from "bun:test";
import { RunRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { Schema } from "effect";
import { slackFixture, streamRecord } from "./slack-agent-stream.fixture.ts";
import {
  SlackAgentStreamApiError,
  ensureSlackAgentStream,
  finalizeSlackAgentStream,
  pauseSlackAgentStream,
} from "./slack-agent-stream.ts";
import { appendSlackAgentProgress } from "./slack-agent-stream-progress.ts";

test("treats an unchanged recovered final message as stopped", async () => {
  const test = slackFixture();
  await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
  const dependencies = {
    ...test.dependencies,
    slackAgentStream: {
      ...test.dependencies.slackAgentStream,
      stop: async () => {
        throw new SlackAgentStreamApiError(
          "chat.stopStream",
          200,
          "message_not_in_streaming_state",
        );
      },
      update: async () => {
        throw new SlackAgentStreamApiError("chat.update", 200, "message_not_modified");
      },
    },
  };
  const completed = Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...test.run.data,
        completedAt: "2026-07-22T00:00:10.000Z",
        status: "completed" as const,
        updatedAt: "2026-07-22T00:00:10.000Z",
        version: test.run.data.version + 1,
      },
      itemType: "run" as const,
    }),
  );

  const result = await finalizeSlackAgentStream({
    body: "Recovered final answer.",
    dependencies,
    run: completed,
  });

  expect(result?.data).toMatchObject({ fallbackAllowed: false, status: "stopped" });
  expect(streamRecord(test.memory)?.data.fallbackAllowed).toBe(false);
});

test("treats unchanged waiting text as a recovered pause", async () => {
  const test = slackFixture();
  await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);

  const result = await pauseSlackAgentStream(
    {
      ...test.dependencies,
      slackAgentStream: {
        ...test.dependencies.slackAgentStream,
        stop: async () => {
          throw new SlackAgentStreamApiError(
            "chat.stopStream",
            200,
            "message_not_in_streaming_state",
          );
        },
        update: async () => {
          throw new SlackAgentStreamApiError("chat.update", 200, "message_not_modified");
        },
      },
    },
    test.run,
  );

  expect(result?.data).toMatchObject({ fallbackAllowed: false, status: "paused" });
});

test("bounds degraded cosmetic progress without delaying agent execution", async () => {
  const test = slackFixture();
  await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
  let appends = 0;
  const appendStarted = Promise.withResolvers<void>();
  const blockedAppend = Promise.withResolvers<void>();
  const coalescedAppend = Promise.withResolvers<void>();
  const dependencies = {
    ...test.dependencies,
    slackAgentStream: {
      ...test.dependencies.slackAgentStream,
      append: async () => {
        appends += 1;
        if (appends === 1) {
          appendStarted.resolve();
          await blockedAppend.promise;
        } else {
          coalescedAppend.resolve();
        }
      },
    },
  };

  jest.useFakeTimers();
  const progress = (async () => {
    for (let index = 0; index < 10; index += 1) {
      await appendSlackAgentProgress(dependencies, test.run, {
        eventType: "tool.running",
        level: "info",
        message: "Tool progress.",
        metadata: { toolCallId: `tool-${index}`, toolName: "provider.read" },
      });
    }
  })();
  try {
    await Promise.race([appendStarted.promise, progress]);
    jest.advanceTimersByTime(250);
  } finally {
    // Restoring real timers drops every fake timer still pending, so the ten calls finish only
    // if each deadline they wait on fell within the 250 ms just advanced.
    jest.useRealTimers();
  }
  await progress;

  expect(appends).toBe(1);
  blockedAppend.resolve();
  await coalescedAppend.promise;
  expect(appends).toBe(2);
}, 15_000);

test("drains in-flight progress before stopping the stream", async () => {
  const test = slackFixture();
  await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
  let releaseAppend: (() => void) | undefined;
  const blockedAppend = new Promise<void>((resolve) => {
    releaseAppend = resolve;
  });
  const order: string[] = [];
  const dependencies = {
    ...test.dependencies,
    slackAgentStream: {
      ...test.dependencies.slackAgentStream,
      append: async () => {
        order.push("append-started");
        await blockedAppend;
        order.push("append-finished");
      },
      stop: async () => void order.push("stop"),
    },
  };
  await appendSlackAgentProgress(dependencies, test.run, {
    eventType: "tool.running",
    level: "info",
    message: "Tool progress.",
    metadata: { toolCallId: "tool-1", toolName: "provider.read" },
  });

  const finalization = finalizeSlackAgentStream({
    body: "Done.",
    dependencies,
    run: test.run,
  });
  await Bun.sleep(0);
  expect(order).toEqual(["append-started"]);
  releaseAppend?.();
  await finalization;
  expect(order).toEqual(["append-started", "append-finished", "stop"]);
});
