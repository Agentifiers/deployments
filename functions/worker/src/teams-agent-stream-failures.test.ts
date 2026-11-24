import { describe, expect, test } from "bun:test";
import {
  TeamsBotAuthenticationError,
  TeamsConnectorError,
} from "@deployments-ai/channel-adapters/teams";
import { RunRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import { id } from "./agent-run.fixture.ts";
import {
  teamsDeliveries,
  teamsFixture,
  teamsStreamRecord,
  terminalRun,
} from "./teams-agent-stream.fixture.ts";
import {
  ensureTeamsAgentStream,
  finalizeTeamsAgentStream,
  pauseTeamsAgentStream,
} from "./teams-agent-stream.ts";

const contentStreamNotAllowed = () =>
  new TeamsConnectorError({
    code: "ContentStreamNotAllowed",
    definitiveRejection: true,
    message: "Teams send activity failed with HTTP 403 (ContentStreamNotAllowed).",
    retryable: false,
    stage: "connector",
    status: 403,
  });
const activityNotFound = () =>
  new TeamsConnectorError({
    definitiveRejection: true,
    message: "Teams update activity failed with HTTP 404.",
    retryable: false,
    stage: "connector",
    status: 404,
  });
const unavailable = () =>
  new TeamsConnectorError({
    definitiveRejection: false,
    message: "Teams send activity failed with HTTP 503.",
    retryable: true,
    stage: "connector",
    status: 503,
  });

/** Fails the transition of the Teams stream record into `status`. */
function failStreamTransition(test: ReturnType<typeof teamsFixture>, status: string) {
  let pending = true;
  return {
    ...test.dependencies.database,
    transactWrite: (operations: Parameters<typeof test.dependencies.database.transactWrite>[0]) => {
      if (
        pending &&
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "teams-agent-stream" &&
            operation.record.data.status === status,
        )
      ) {
        pending = false;
        return Promise.reject(new Error(`simulated ${status} stream write failure`));
      }
      return test.dependencies.database.transactWrite(operations);
    },
  };
}

describe("Teams agent stream start", () => {
  for (const [name, failure] of [
    ["a definitive start rejection", contentStreamNotAllowed()],
    ["a rejected bot token request", new TeamsBotAuthenticationError({ status: 401 })],
    [
      "a bot token outage that sent no activity",
      new TeamsConnectorError({
        definitiveRejection: false,
        message: "Teams bot token request timed out.",
        retryable: true,
        stage: "authentication",
      }),
    ],
  ] as const) {
    test(`permits fallback after ${name}`, async () => {
      const test = teamsFixture();
      test.failures.set(0, failure);

      const result = await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);

      expect(result?.data).toMatchObject({
        fallbackAllowed: true,
        lastError: failure.message,
        status: "failed",
      });
    });
  }

  test("fails closed after an ambiguous start and never restarts it automatically", async () => {
    const test = teamsFixture();
    test.failures.set(0, unavailable());

    expect(ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage)).rejects.toThrow(
      "initialization could not be durably reconciled",
    );
    expect(teamsStreamRecord(test.memory)?.data).toMatchObject({
      fallbackAllowed: false,
      lastError: "Teams send activity failed with HTTP 503.",
      status: "failed",
    });
    expect(ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage)).rejects.toThrow(
      "initialization could not be durably reconciled",
    );
    expect(test.calls).toHaveLength(1);
  });

  test("fails closed when Teams accepts a stream start without a stream id", async () => {
    const test = teamsFixture();
    const dependencies = {
      ...test.dependencies,
      teamsAgentStream: { ...test.dependencies.teamsAgentStream, sendActivity: async () => ({}) },
    };

    expect(ensureTeamsAgentStream(dependencies, test.run, test.userMessage)).rejects.toThrow(
      "initialization could not be durably reconciled",
    );
    expect(teamsStreamRecord(test.memory)?.data).toMatchObject({
      fallbackAllowed: false,
      status: "failed",
    });
  });

  test("requeues the run without executing it after an ambiguous start", async () => {
    const test = teamsFixture();
    test.failures.set(0, unavailable());
    let executions = 0;

    const result = await processAgentRun(test.queue, {
      ...test.dependencies,
      runtime: {
        generateAssistantMessage: async () => {
          executions += 1;
          return { assistantMessage: "unexpected" };
        },
      },
    });

    expect(result).toMatchObject({ action: "requeued" });
    expect(executions).toBe(0);
  });

  test("ends a started stream and allows fallback when its streaming state cannot persist", async () => {
    const test = teamsFixture({ bindingMetadata: { teamsAgentIdentity: { displayName: "Rex" } } });

    const result = await ensureTeamsAgentStream(
      { ...test.dependencies, database: failStreamTransition(test, "streaming") },
      test.run,
      test.userMessage,
    );

    expect(test.calls[1]?.activity).toEqual({
      entities: [{ streamId: "stream-1", streamType: "final", type: "streaminfo" }],
      text: "**Rex**\n\n_Request failed._\n\nAgent progress stream could not be persisted.",
      textFormat: "markdown",
      type: "message",
    });
    expect(result?.data).toMatchObject({
      fallbackAllowed: true,
      lastError: "simulated streaming stream write failure",
      status: "failed",
    });
  });

  test("keeps an unconfirmed compensation retryable without allowing fallback", async () => {
    const test = teamsFixture();
    test.failures.set(1, unavailable());

    expect(
      ensureTeamsAgentStream(
        { ...test.dependencies, database: failStreamTransition(test, "streaming") },
        test.run,
        test.userMessage,
      ),
    ).rejects.toThrow("initialization could not be durably reconciled");
    expect(teamsStreamRecord(test.memory)?.data).toMatchObject({
      fallbackAllowed: false,
      status: "failed",
    });
    expect(test.calls).toHaveLength(2);
  });

  test("starts a new generation after reconciling a stream left by an older claim", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);
    const reclaimed = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...test.run.data,
          attempt: 1,
          claimedAt: "2026-07-22T00:00:11.000Z",
          status: "running" as const,
          updatedAt: "2026-07-22T00:00:11.000Z",
          version: test.run.data.version + 2,
        },
        itemType: "run" as const,
      }),
    );

    const result = await ensureTeamsAgentStream(test.dependencies, reclaimed, test.userMessage);

    expect(test.calls.map((call) => call.activity.entities?.[0]?.streamType)).toEqual([
      "informative",
      "final",
      "informative",
    ]);
    expect(result?.data).toMatchObject({
      runClaimedAt: "2026-07-22T00:00:11.000Z",
      runExecutionVersion: reclaimed.data.version,
      status: "streaming",
      streamId: "stream-2",
    });
  });
});

describe("Teams agent stream finalization failures", () => {
  test("updates the stream message when Teams refuses the final stream message", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);
    test.failures.set(1, contentStreamNotAllowed());

    const result = await finalizeTeamsAgentStream({
      body: "Final answer.",
      dependencies: test.dependencies,
      run: terminalRun(test.run, "completed"),
    });

    expect(test.calls.map((call) => call.method)).toEqual(["send", "send", "update"]);
    expect(test.calls[2]).toMatchObject({
      activity: { text: "Final answer.", type: "message" },
      activityId: "stream-1",
    });
    expect(result?.data.status).toBe("stopped");
  });

  test("queues a failed run's notice when Teams refuses both the final message and its update", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);
    test.failures.set(1, contentStreamNotAllowed());
    test.failures.set(2, activityNotFound());
    const failed = terminalRun(test.run, "failed");

    const result = await finalizeTeamsAgentStream({ dependencies: test.dependencies, run: failed });

    expect(result?.data).toMatchObject({ fallbackAllowed: true, status: "failed" });
    const deliveries = teamsDeliveries(test.memory);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.data).toMatchObject({
      deliveryMode: "teams-stream-fallback",
      idempotencyKey: `channel-response:v1:${test.run.data.id}:${id(70)}:terminal-${String(test.run.data.version)}`,
      providerPayload: { text: "_Request failed._\n\nAgent run failed." },
      status: "queued",
      teamsStreamRunClaimedAt: result?.data.runClaimedAt,
    });
  });

  test("surfaces an ambiguous final message for retry and keeps the stream open", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);
    test.failures.set(1, unavailable());

    expect(
      finalizeTeamsAgentStream({
        body: "Final answer.",
        dependencies: test.dependencies,
        run: terminalRun(test.run, "completed"),
      }),
    ).rejects.toThrow("HTTP 503");
    expect(teamsStreamRecord(test.memory)?.data.status).toBe("streaming");
    expect(teamsDeliveries(test.memory)).toEqual([]);
  });

  test("pauses through a message update when the user already stopped the stream", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);
    test.failures.set(1, contentStreamNotAllowed());

    const result = await pauseTeamsAgentStream(test.dependencies, test.run);

    expect(test.calls.at(-1)).toMatchObject({
      activity: { text: "Waiting for the next step before continuing." },
      activityId: "stream-1",
      method: "update",
    });
    expect(result?.data).toMatchObject({ fallbackAllowed: false, status: "paused" });
  });

  test("allows fallback when a paused segment's message is gone", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);
    await pauseTeamsAgentStream(test.dependencies, test.run);
    test.failures.set(2, activityNotFound());

    const result = await finalizeTeamsAgentStream({
      body: "Final answer.",
      dependencies: test.dependencies,
      run: terminalRun(test.run, "completed"),
    });

    expect(result?.data).toMatchObject({ fallbackAllowed: true, status: "failed" });
  });
});
