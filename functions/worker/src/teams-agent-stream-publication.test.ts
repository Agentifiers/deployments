import { describe, expect, test } from "bun:test";
import { TeamsConnectorError } from "@deployments-ai/channel-adapters/teams";
import {
  RunRecord,
  RuntimeLeaseRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import { additionalRunOnThread } from "./agent-run.fixture.ts";
import {
  TEAMS_CONVERSATION_ID,
  TEAMS_SERVICE_URL,
  teamsDeliveries,
  teamsFixture,
  teamsStreamRecord,
  terminalRun,
} from "./teams-agent-stream.fixture.ts";
import { ensureTeamsAgentStream, finalizeTeamsAgentStream } from "./teams-agent-stream.ts";

const identity = { teamsAgentIdentity: { displayName: "Rex" } };
const TRUNCATION_NOTICE =
  "\n\n_Response truncated in Teams. Open Deployments.ai to view the complete result._";
const startRejected = () =>
  new TeamsConnectorError({
    code: "BadRequest",
    definitiveRejection: true,
    message: "Teams send activity failed with HTTP 400 (BadRequest).",
    retryable: false,
    stage: "connector",
    status: 400,
  });

function records<ItemType extends PlatformRecord["itemType"]>(
  memory: { readonly records: ReadonlyMap<string, PlatformRecord> },
  itemType: ItemType,
) {
  return [...memory.records.values()].filter(
    (record): record is Extract<PlatformRecord, { readonly itemType: ItemType }> =>
      record.itemType === itemType,
  );
}

describe("Teams streaming for externally published channel responses", () => {
  test("streams the run and hands the stopped stream to confirmed publication", async () => {
    const test = teamsFixture({ bindingMetadata: identity, externalPublication: true });

    const result = await processAgentRun(test.queue, test.dependencies);

    expect(result.action).toBe("completed");
    expect(test.calls.at(-1)?.activity.text).toBe("**Rex**\n\nPersisted assistant result.");
    const stream = teamsStreamRecord(test.memory);
    expect(stream?.data).toMatchObject({ status: "stopped", streamId: "stream-1" });
    const [assistant] = records(test.memory, "message").filter(
      (message) => message.data.role === "assistant",
    );
    const deliveries = teamsDeliveries(test.memory);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.data).toMatchObject({
      deliveryMode: "teams-stream-fallback",
      providerPayload: {
        conversationId: TEAMS_CONVERSATION_ID,
        serviceUrl: TEAMS_SERVICE_URL,
        text: "**Rex**\n\nPersisted assistant result.",
      },
      publicationContent: "Persisted assistant result.",
      responsePublication: "external",
      routeId: "a".repeat(64),
      sourceMessageId: assistant?.data.id,
      sourceMessageSequence: assistant?.data.sequence,
      status: "queued",
      teamsStreamRunClaimedAt: stream?.data.runClaimedAt,
      throughSequence: 0,
    });
    // History publication waits for the delivery worker to observe the stopped stream.
    expect(records(test.memory, "message-publication")).toEqual([]);
  });

  test("bounds a long fallback post to the Teams limit while publishing the complete result", async () => {
    const assistantBody = "é".repeat(12_001);
    const test = teamsFixture({ externalPublication: true });
    test.failures.set(0, startRejected());

    expect(
      processAgentRun(test.queue, {
        ...test.dependencies,
        runtime: { generateAssistantMessage: async () => ({ assistantMessage: assistantBody }) },
      }),
    ).resolves.toMatchObject({ action: "completed" });

    expect(test.calls).toHaveLength(1);
    expect(teamsStreamRecord(test.memory)?.data).toMatchObject({
      fallbackAllowed: true,
      status: "failed",
    });
    const deliveries = teamsDeliveries(test.memory);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.data).toMatchObject({
      deliveryMode: "teams-stream-fallback",
      providerPayload: {
        text: `${"é".repeat(Math.floor((24_000 - TRUNCATION_NOTICE.length) / 2))}${TRUNCATION_NOTICE}`,
      },
      publicationContent: assistantBody,
      status: "queued",
    });
  });

  test("delivers a failed run's fallback notice without publishing it to history", async () => {
    const test = teamsFixture({ bindingMetadata: identity, externalPublication: true });
    test.failures.set(0, startRejected());
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);

    await finalizeTeamsAgentStream({
      dependencies: test.dependencies,
      run: terminalRun(test.run, "failed"),
    });

    const deliveries = teamsDeliveries(test.memory);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.data).toMatchObject({
      deliveryMode: "teams-stream-fallback",
      providerPayload: { text: "**Rex**\n\n_Request failed._\n\nAgent run failed." },
      status: "queued",
    });
    expect(deliveries[0]?.data).not.toHaveProperty("responsePublication");
    expect(deliveries[0]?.data).not.toHaveProperty("publicationContent");
  });
});

describe("Teams agent stream lease recovery", () => {
  test("requeues prior Teams finalization before releasing its expired lease", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);
    const running = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...test.run.data,
          attempt: 1,
          claimedAt: "2026-07-22T00:00:00.000Z",
          claimedBy: "expired-worker",
          heartbeatAt: "2026-07-22T00:00:00.000Z",
          status: "running" as const,
          updatedAt: "2026-07-22T00:00:00.000Z",
          version: test.run.data.version + 1,
        },
        itemType: "run" as const,
      }),
    );
    const lease = Schema.decodeUnknownSync(RuntimeLeaseRecord)(
      withCanonicalRecordKeys({
        data: {
          acquiredAt: "2026-07-22T00:00:00.000Z",
          expiresAt: "2026-07-22T00:00:00.050Z",
          id: test.fixture.thread.data.id,
          leaseKey: `agent-run-thread/${test.fixture.thread.data.id}`,
          owner: "expired-worker",
          renewedAt: "2026-07-22T00:00:00.000Z",
          runId: running.data.id,
          threadId: test.fixture.thread.data.id,
          version: 0,
        },
        itemType: "runtime-lease" as const,
      }),
    );
    const secondBase = additionalRunOnThread({
      ...test.fixture,
      run: test.run,
      userMessage: test.userMessage,
    });
    const second = {
      ...secondBase,
      run: Schema.decodeUnknownSync(RunRecord)(
        withCanonicalRecordKeys({
          data: {
            ...secondBase.run.data,
            userMessageId: secondBase.userMessage.data.id,
            userMessageSequence: secondBase.userMessage.data.sequence,
          },
          itemType: "run" as const,
        }),
      ),
    };
    for (const record of [running, lease, second.userMessage, second.run]) {
      await test.memory.database.putRecord(record);
    }
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
    const requeued: Parameters<NonNullable<typeof test.dependencies.enqueueRun>>[0][] = [];
    const dependencies = {
      ...test.dependencies,
      enqueueRun: async (input: Parameters<NonNullable<typeof test.dependencies.enqueueRun>>[0]) =>
        void requeued.push(input),
      runningClaimTimeoutMs: 50,
      runtime: { generateAssistantMessage: async () => ({ assistantMessage: "Second answer." }) },
    };

    expect(processAgentRun(second.queue, dependencies)).resolves.toMatchObject({
      action: "completed",
    });

    expect(
      [...test.memory.records.values()].some(
        (record) => record.itemType === "runtime-lease" && record.data.runId === running.data.id,
      ),
    ).toBe(false);
    expect(requeued).toHaveLength(1);
    expect(requeued[0]).toMatchObject({
      deduplicationId: `teams-terminal-recovery:${running.data.id}:${String(lease.data.version)}`,
      message: { runId: running.data.id },
      messageGroupId: expect.stringContaining(":recovery"),
    });

    expect(processAgentRun(requeued[0]!.message, test.dependencies)).resolves.toMatchObject({
      action: "skipped",
    });
    const priorStream = records(test.memory, "teams-agent-stream").find(
      (record) => record.data.runId === running.data.id,
    );
    expect(priorStream?.data.status).toBe("stopped");
    expect(test.calls.at(-1)?.activity).toMatchObject({
      entities: [{ streamId: "stream-1", streamType: "final" }],
      text: "_Request failed._\n\nAgent run failed.",
    });
  });
});
