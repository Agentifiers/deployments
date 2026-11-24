import { describe, expect, test } from "bun:test";
import {
  ChannelBindingRecord,
  ChannelDeliveryRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import { id } from "./agent-run.fixture.ts";
import {
  TEAMS_CONVERSATION_ID,
  TEAMS_SERVICE_URL,
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

type Binding = Extract<PlatformRecord, { readonly itemType: "channel-binding" }>;

function binding(memory: ReturnType<typeof teamsFixture>["memory"]) {
  const value = [...memory.records.values()].find(
    (record): record is Binding => record.itemType === "channel-binding",
  );
  if (!value) throw new Error("Expected Teams binding fixture.");
  return value;
}

async function replaceBinding(
  test: ReturnType<typeof teamsFixture>,
  patch: Partial<Binding["data"]>,
) {
  const current = binding(test.memory);
  await test.memory.database.putRecord(
    Schema.decodeUnknownSync(ChannelBindingRecord)(
      withCanonicalRecordKeys({
        data: {
          ...current.data,
          ...patch,
          updatedAt: "2026-07-22T00:00:02.000Z",
          version: current.data.version + 1,
        },
        itemType: "channel-binding" as const,
      }),
    ),
  );
}

describe("Teams agent stream lifecycle", () => {
  test("streams a personal-chat run and hands the stopped stream to its fallback delivery", async () => {
    const test = teamsFixture();

    const result = await processAgentRun(test.queue, test.dependencies);

    expect(result.action).toBe("completed");
    // Plan updates arrive faster than Teams' one-request-per-second limit; the pending update is
    // dropped when the stream finalizes, so only the start and final messages are sent.
    expect(test.calls).toEqual([
      {
        activity: {
          entities: [{ streamSequence: 1, streamType: "informative", type: "streaminfo" }],
          text: "Working on: Produce the answer.",
          type: "typing",
        },
        conversationId: TEAMS_CONVERSATION_ID,
        method: "send",
        serviceUrl: TEAMS_SERVICE_URL,
      },
      {
        activity: {
          entities: [{ streamId: "stream-1", streamType: "final", type: "streaminfo" }],
          text: "Persisted assistant result.",
          textFormat: "markdown",
          type: "message",
        },
        conversationId: TEAMS_CONVERSATION_ID,
        method: "send",
        serviceUrl: TEAMS_SERVICE_URL,
      },
    ]);
    const stream = teamsStreamRecord(test.memory);
    expect(stream?.data).toMatchObject({
      conversationId: TEAMS_CONVERSATION_ID,
      fallbackAllowed: false,
      recipientId: "29:user-1",
      serviceUrl: TEAMS_SERVICE_URL,
      status: "stopped",
      streamId: "stream-1",
      tenantId: "tenant-1",
    });
    expect(stream?.data.streamStartedAt).toBeString();
    const deliveries = teamsDeliveries(test.memory);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.data).toMatchObject({
      channel: "teams",
      deliveryMode: "teams-stream-fallback",
      provider: "teams_bot_framework",
      providerPayload: {
        conversationId: TEAMS_CONVERSATION_ID,
        serviceUrl: TEAMS_SERVICE_URL,
        text: "Persisted assistant result.",
      },
      status: "queued",
      teamsStreamRunClaimedAt: stream?.data.runClaimedAt,
    });
    expect(deliveries[0]?.data).not.toHaveProperty("slackStreamRunClaimedAt");
  });

  for (const conversationType of ["groupChat", "channel"] as const) {
    test(`delivers a ${conversationType} reply after the run without streaming`, async () => {
      const test = teamsFixture({ conversationType });

      const result = await processAgentRun(test.queue, test.dependencies);

      expect(result.action).toBe("completed");
      expect(test.calls).toEqual([]);
      expect(teamsStreamRecord(test.memory)).toBeUndefined();
      const deliveries = teamsDeliveries(test.memory);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.data).toMatchObject({
        providerPayload: {
          conversationId:
            conversationType === "groupChat"
              ? "19:group-chat-1@thread.v2"
              : "19:general@thread.tacv2;messageid=1700000000001",
          serviceUrl: TEAMS_SERVICE_URL,
          text: "Persisted assistant result.",
        },
        status: "queued",
      });
      expect(deliveries[0]?.data).not.toHaveProperty("deliveryMode");
    });
  }

  test("labels the final message and the delivery with the reauthorized agent identity", async () => {
    const test = teamsFixture({
      authorizedBindingMetadata: { teamsAgentIdentity: { displayName: "Nova_Bot" } },
      bindingMetadata: { teamsAgentIdentity: { displayName: "Rex" } },
    });

    await processAgentRun(test.queue, test.dependencies);

    expect(test.calls.at(-1)?.activity.text).toBe("**Nova\\_Bot**\n\nPersisted assistant result.");
    expect(teamsDeliveries(test.memory)[0]?.data.providerPayload).toMatchObject({
      text: "**Nova\\_Bot**\n\nPersisted assistant result.",
    });
  });

  test("fails an invalid agent identity without streaming or posting as the bare bot", async () => {
    const test = teamsFixture({ bindingMetadata: { teamsAgentIdentity: { displayName: " " } } });

    await processAgentRun(test.queue, test.dependencies);

    expect(test.calls).toEqual([]);
    expect(teamsStreamRecord(test.memory)?.data).toMatchObject({
      fallbackAllowed: false,
      lastError: "Teams channel binding has an invalid stream identity.",
      status: "failed",
    });
    expect(teamsDeliveries(test.memory)[0]?.data).toMatchObject({
      lastError: "Teams channel binding has an invalid agent identity.",
      status: "failed",
    });
    expect(teamsDeliveries(test.memory)[0]?.data).not.toHaveProperty("providerPayload");
  });

  test("does not mutate Teams after its channel binding is revoked", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);
    await replaceBinding(test, { status: "disabled" });

    const result = await finalizeTeamsAgentStream({
      body: "Final answer.",
      dependencies: test.dependencies,
      run: terminalRun(test.run, "completed"),
    });

    expect(test.calls.map((call) => call.method)).toEqual(["send"]);
    expect(result?.data).toMatchObject({ fallbackAllowed: false, status: "failed" });
  });

  test("invalidates an in-flight stream when the binding credential rotates", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);
    await replaceBinding(test, {
      credentialRef: { credentialId: id(71), generation: 2, store: "dynamodb-kms" },
    });

    const result = await pauseTeamsAgentStream(test.dependencies, test.run);

    expect(test.calls).toHaveLength(1);
    expect(result?.data).toMatchObject({ fallbackAllowed: false, status: "failed" });
  });

  test("ends the segment on pause and starts a fresh stream on resume", async () => {
    const test = teamsFixture({ bindingMetadata: { teamsAgentIdentity: { displayName: "Rex" } } });
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);

    const paused = await pauseTeamsAgentStream(test.dependencies, test.run);
    const resumed = await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);

    expect(paused?.data).toMatchObject({ fallbackAllowed: false, status: "paused" });
    expect(test.calls[1]?.activity).toEqual({
      entities: [{ streamId: "stream-1", streamType: "final", type: "streaminfo" }],
      text: "**Rex**\n\nWaiting for the next step before continuing.",
      textFormat: "markdown",
      type: "message",
    });
    expect(test.calls[2]?.activity.entities).toEqual([
      { streamSequence: 1, streamType: "informative", type: "streaminfo" },
    ]);
    expect(resumed?.data).toMatchObject({ status: "streaming", streamId: "stream-2", version: 4 });
  });

  test("updates a paused segment's message when the run later fails", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);
    await pauseTeamsAgentStream(test.dependencies, test.run);

    const result = await finalizeTeamsAgentStream({
      dependencies: test.dependencies,
      run: terminalRun(test.run, "failed"),
    });

    expect(result?.data.status).toBe("stopped");
    expect(test.calls.at(-1)).toEqual({
      activity: {
        text: "_Request failed._\n\nAgent run failed.",
        textFormat: "markdown",
        type: "message",
      },
      activityId: "stream-1",
      conversationId: TEAMS_CONVERSATION_ID,
      method: "update",
      serviceUrl: TEAMS_SERVICE_URL,
    });
  });

  test("reopens a suppressed fallback delivery once the stream outcome resolves", async () => {
    const test = teamsFixture();
    await ensureTeamsAgentStream(test.dependencies, test.run, test.userMessage);
    const timestamp = "2026-07-22T00:00:01.000Z";
    await test.memory.database.putRecord(
      Schema.decodeUnknownSync(ChannelDeliveryRecord)(
        withCanonicalRecordKeys({
          data: {
            attempts: 0,
            bindingId: id(70),
            channel: "teams",
            contentPreview: "Final answer.",
            createdAt: timestamp,
            credentialRef: { credentialId: id(71), generation: 1, store: "dynamodb-kms" },
            deliveryMode: "teams-stream-fallback" as const,
            environmentId: test.run.data.environmentId,
            externalThreadKey: `teams:tenant-1:thread:${TEAMS_CONVERSATION_ID}`,
            failedAt: timestamp,
            id: id(75),
            idempotencyKey: `channel-response:v1:${test.run.data.id}:${id(70)}`,
            lastError: "Teams agent stream outcome is unknown; fallback delivery was suppressed.",
            organizationId: test.run.data.organizationId,
            projectId: test.run.data.projectId,
            provider: "teams_bot_framework",
            providerPayload: {
              conversationId: TEAMS_CONVERSATION_ID,
              serviceUrl: TEAMS_SERVICE_URL,
              text: "Final answer.",
            },
            runId: test.run.data.id,
            status: "failed" as const,
            threadId: test.run.data.threadId,
            updatedAt: timestamp,
            version: 1,
            workspaceId: test.run.data.workspaceId,
          },
          itemType: "channel-delivery" as const,
        }),
      ),
    );

    await finalizeTeamsAgentStream({
      body: "Final answer.",
      dependencies: test.dependencies,
      run: terminalRun(test.run, "completed"),
    });

    const [reopened] = teamsDeliveries(test.memory);
    expect(reopened?.data).toMatchObject({
      lastError: "Teams agent stream resolved; fallback delivery was requeued.",
      status: "queued",
      version: 2,
    });
    expect(reopened?.data).not.toHaveProperty("failedAt");
  });
});
