import { describe, expect, test } from "bun:test";
import {
  AgentRunPlanRecord,
  ChannelBindingRecord,
  RunRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import { progressEvent } from "./agent-run-lease.ts";
import { customerRunPins, id } from "./agent-run.fixture.ts";
import { slackFixture, streamRecord } from "./slack-agent-stream.fixture.ts";
import {
  SlackAgentStreamApiError,
  ensureSlackAgentStream,
  finalizeSlackAgentStream,
  slackAgentStreamClient,
} from "./slack-agent-stream.ts";
import { appendSlackAgentProgress } from "./slack-agent-stream-progress.ts";

describe("Slack agent stream lifecycle", () => {
  test("streams one Slack-triggered run and suppresses its terminal fallback delivery", async () => {
    const test = slackFixture();

    const result = await processAgentRun(test.queue, test.dependencies);

    expect(result.action).toBe("completed");
    expect(test.calls.map((call) => call.method)).toEqual([
      "start",
      "append",
      "append",
      "append",
      "stop",
      "update",
    ]);
    expect(test.calls.slice(1, 4).map((call) => call.payload)).toEqual([
      {
        channel: "C1",
        chunks: [
          { title: "Complete the request", type: "plan_update" },
          {
            id: "produce-response",
            status: "pending",
            title: "Produce the response",
            type: "task_update",
          },
        ],
        ts: "1721609601.000001",
      },
      {
        channel: "C1",
        chunks: [
          {
            id: "produce-response",
            status: "in_progress",
            title: "Produce the response",
            type: "task_update",
          },
        ],
        ts: "1721609601.000001",
      },
      {
        channel: "C1",
        chunks: [
          {
            id: "produce-response",
            status: "complete",
            title: "Produce the response",
            type: "task_update",
          },
        ],
        ts: "1721609601.000001",
      },
    ]);
    const plan = [...test.memory.records.values()].find(
      (record) => record.itemType === "agent-run-plan",
    );
    expect(plan?.data).toMatchObject({
      planRevision: 3,
      runExecutionVersion: 1,
      tasks: [{ id: "produce-response", status: "completed" }],
      title: "Complete the request",
    });
    expect(test.calls.at(-2)).toMatchObject({
      method: "stop",
      payload: {
        channel: "C1",
        chunks: [{ text: "Persisted assistant result.", type: "markdown_text" }],
        ts: "1721609601.000001",
      },
    });
    expect(streamRecord(test.memory)?.data.status).toBe("stopped");
    const delivery = [...test.memory.records.values()].find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "channel-delivery" }> =>
        record.itemType === "channel-delivery",
    );
    expect(delivery?.data).toMatchObject({
      deliveryMode: "slack-stream-fallback",
      status: "queued",
    });
    expect(
      test.events
        .filter((event) => event.eventType.startsWith("agent."))
        .map((event) => event.eventType),
    ).toEqual([
      "agent.plan.updated",
      "agent.task.updated",
      "agent.task.updated",
      "agent.plan.updated",
    ]);
  });

  test("starts once and appends stable task updates", async () => {
    const test = slackFixture();

    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    await appendSlackAgentProgress(test.dependencies, test.run, {
      eventType: "tool.running",
      level: "info",
      message: "Running tool shopify.fulfillments.create.",
      metadata: { toolCallId: "tool-1", toolName: "shopify.fulfillments.create" },
    });
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);

    expect(test.calls).toEqual([
      {
        method: "start",
        payload: {
          channel: "C1",
          chunks: [{ title: "Working on: Produce the answer.", type: "plan_update" }],
          recipient_team_id: "T1",
          recipient_user_id: "U1",
          task_display_mode: "plan",
          thread_ts: "1721609600.123456",
        },
      },
      {
        method: "append",
        payload: {
          channel: "C1",
          chunks: [
            {
              details: "Running tool shopify.fulfillments.create.",
              id: "tool-1",
              status: "in_progress",
              title: "Use shopify.fulfillments.create",
              type: "task_update",
            },
          ],
          ts: "1721609601.000001",
        },
      },
    ]);
    expect(streamRecord(test.memory)?.data).toMatchObject({
      channelId: "C1",
      recipientTeamId: "T1",
      recipientUserId: "U1",
      status: "streaming",
      streamTs: "1721609601.000001",
      threadTs: "1721609600.123456",
      version: 1,
    });
  });

  test("starts with the generic Slack identity configured on the binding", async () => {
    const test = slackFixture({
      bindingMetadata: {
        slackAgentIdentity: {
          iconUrl: "https://cdn.example.test/agents/rex.png",
          username: "Rex",
        },
      },
    });

    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);

    expect(test.calls[0]).toMatchObject({
      method: "start",
      payload: {
        icon_url: "https://cdn.example.test/agents/rex.png",
        username: "Rex",
      },
    });
  });

  test("starts with the reauthorized binding identity instead of the initial snapshot", async () => {
    const test = slackFixture({
      authorizedBindingMetadata: {
        slackAgentIdentity: { iconEmoji: ":robot_face:", username: "Nova" },
      },
      bindingMetadata: { slackAgentIdentity: { username: "Rex" } },
    });

    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);

    expect(test.calls[0]).toMatchObject({
      method: "start",
      payload: { icon_emoji: ":robot_face:", username: "Nova" },
    });
  });

  test("seeds recovered streams from the canonical plan and suppresses compatibility cards", async () => {
    const test = slackFixture();
    const plan = Schema.decodeUnknownSync(AgentRunPlanRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: test.run.data.agentDeploymentId,
          createdAt: test.run.data.createdAt,
          environmentId: test.run.data.environmentId,
          id: test.run.data.id,
          organizationId: test.run.data.organizationId,
          planRevision: 1,
          projectId: test.run.data.projectId,
          runAttempt: test.run.data.attempt,
          runClaimedAt: test.run.data.claimedAt ?? test.run.data.updatedAt,
          runExecutionVersion: test.run.data.version,
          runId: test.run.data.id,
          tasks: [
            {
              id: "produce-response",
              order: 0,
              status: "in_progress" as const,
              title: "Produce the response",
            },
          ],
          threadId: test.run.data.threadId,
          title: "Complete the request",
          traceId: test.run.data.traceId,
          updatedAt: test.run.data.updatedAt,
          version: 0,
        },
        itemType: "agent-run-plan" as const,
      }),
    );
    await test.memory.database.putRecord(plan);

    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    await appendSlackAgentProgress(test.dependencies, test.run, {
      eventType: "tool.running",
      level: "info",
      message: "Compatibility progress that should be suppressed.",
      metadata: { toolCallId: "legacy-tool", toolName: "provider.read" },
    });

    expect(test.calls).toEqual([
      {
        method: "start",
        payload: {
          channel: "C1",
          chunks: [
            { title: "Complete the request", type: "plan_update" },
            {
              id: "produce-response",
              status: "in_progress",
              title: "Produce the response",
              type: "task_update",
            },
          ],
          recipient_team_id: "T1",
          recipient_user_id: "U1",
          task_display_mode: "plan",
          thread_ts: "1721609600.123456",
        },
      },
    ]);
  });

  test("publishes Slack progress even when the thread-event sink fails", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);

    expect(
      progressEvent(
        {
          ...test.dependencies,
          appendThreadEvent: async () => {
            throw new Error("thread event unavailable");
          },
        },
        {
          agentDefinitionId: id(5),
          ...customerRunPins(test.run.data),
          agentManifestHash: "sha256:test-manifest",
          captureMode: test.run.data.captureMode,
          environmentId: test.run.data.environmentId,
          eventType: "tool.running",
          level: "info",
          message: "Running deployment.read.",
          metadata: { toolCallId: "tool-1", toolName: "deployment.read" },
          occurredAt: "2026-07-22T00:00:01.000Z",
          organizationId: test.run.data.organizationId,
          projectId: test.run.data.projectId,
          runId: test.run.data.id,
          spanId: test.run.data.spanId,
          threadId: test.run.data.threadId,
          traceId: test.run.data.traceId,
        },
        test.run,
      ),
    ).rejects.toThrow("thread event unavailable");

    expect(test.calls.map((call) => call.method)).toEqual(["start", "append"]);
  });

  test("bounds native Slack API requests", async () => {
    const originalFetch = globalThis.fetch;
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal;
      return Response.json({ ok: true, ts: "1721609601.000001" });
    }) as typeof fetch;
    try {
      await slackAgentStreamClient.start("xoxb-token", {
        channel: "C1",
        chunks: [],
        recipient_team_id: "T1",
        recipient_user_id: "U1",
        task_display_mode: "plan",
        thread_ts: "1721609600.123456",
      });
      expect(signal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("stops with the final answer and records confirmed completion", async () => {
    const test = slackFixture();
    const stream = await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    expect(stream?.data.status).toBe("streaming");
    const completed = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...test.run.data,
          completedAt: "2026-07-22T00:00:10.000Z",
          status: "completed",
          updatedAt: "2026-07-22T00:00:10.000Z",
          version: test.run.data.version + 1,
        },
        itemType: "run" as const,
      }),
    );

    await finalizeSlackAgentStream({
      body: "The deployment is healthy.",
      dependencies: test.dependencies,
      run: completed,
    });

    // The stop delivers the answer; the update then drops the plan so the message text, which
    // notifications and search show, is the answer without the plan title in front of it.
    expect(test.calls.slice(-2)).toEqual([
      {
        method: "stop",
        payload: {
          channel: "C1",
          chunks: [{ text: "The deployment is healthy.", type: "markdown_text" }],
          ts: "1721609601.000001",
        },
      },
      {
        method: "update",
        payload: {
          channel: "C1",
          markdown_text: "The deployment is healthy.",
          ts: "1721609601.000001",
        },
      },
    ]);
    expect(streamRecord(test.memory)?.data).toMatchObject({ status: "stopped", version: 2 });
  });

  test("keeps the plan on failed and oversized replies and survives a refused rewrite", async () => {
    const finish = async (
      status: "completed" | "failed",
      body: string,
      update?: () => Promise<undefined>,
    ) => {
      const test = slackFixture();
      if (update) test.dependencies.slackAgentStream.update = update;
      await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
      const run = Schema.decodeUnknownSync(RunRecord)(
        withCanonicalRecordKeys({
          data: {
            ...test.run.data,
            completedAt: "2026-07-22T00:00:10.000Z",
            status,
            updatedAt: "2026-07-22T00:00:10.000Z",
            version: test.run.data.version + 1,
          },
          itemType: "run" as const,
        }),
      );
      const result = await finalizeSlackAgentStream({
        body,
        dependencies: test.dependencies,
        run,
      });
      return { methods: test.calls.map((call) => call.method), status: result?.data.status };
    };

    // A failed run's error card is the reply, so its message keeps the plan and task cards.
    expect(await finish("failed", "")).toEqual({ methods: ["start", "stop"], status: "stopped" });
    // One character past Slack's markdown_text limit: rewriting would cut the answer short.
    expect(await finish("completed", "a".repeat(12_001))).toEqual({
      methods: ["start", "stop"],
      status: "stopped",
    });
    expect(await finish("completed", "a".repeat(12_000))).toEqual({
      methods: ["start", "stop", "update"],
      status: "stopped",
    });
    // The answer was already delivered by the stop, so a refused rewrite changes nothing.
    expect(
      await finish("completed", "Final answer.", async () => {
        throw new SlackAgentStreamApiError("chat.update", 200, "ratelimited");
      }),
    ).toEqual({ methods: ["start", "stop"], status: "stopped" });
  });

  test("does not mutate Slack after its channel binding is revoked", async () => {
    const test = slackFixture();
    await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
    const binding = [...test.memory.records.values()].find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "channel-binding" }> =>
        record.itemType === "channel-binding",
    );
    if (!binding) throw new Error("Expected Slack binding fixture.");
    const disabled = Schema.decodeUnknownSync(ChannelBindingRecord)(
      withCanonicalRecordKeys({
        data: {
          ...binding.data,
          status: "disabled" as const,
          updatedAt: "2026-07-22T00:00:02.000Z",
          version: binding.data.version + 1,
        },
        itemType: "channel-binding" as const,
      }),
    );
    await test.memory.database.putRecord(disabled);
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
      body: "Final answer.",
      dependencies: test.dependencies,
      run: completed,
    });
    expect(test.calls.map((call) => call.method)).toEqual(["start"]);
    expect(result?.data).toMatchObject({ fallbackAllowed: false, status: "failed" });
  });
});
