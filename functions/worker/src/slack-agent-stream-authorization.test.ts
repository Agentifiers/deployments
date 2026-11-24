import { expect, test } from "bun:test";
import {
  ChannelBindingRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { progressEvent } from "./agent-run-lease.ts";
import { customerRunPins, id } from "./agent-run.fixture.ts";
import { slackFixture, streamRecord } from "./slack-agent-stream.fixture.ts";
import { ensureSlackAgentStream } from "./slack-agent-stream.ts";

test("keeps an in-flight stream valid across metadata-only binding versions", async () => {
  const test = slackFixture();
  await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
  const binding = [...test.memory.records.values()].find(
    (record): record is Extract<PlatformRecord, { readonly itemType: "channel-binding" }> =>
      record.itemType === "channel-binding",
  );
  if (!binding) throw new Error("Expected Slack binding fixture.");
  await test.memory.database.putRecord(
    Schema.decodeUnknownSync(ChannelBindingRecord)(
      withCanonicalRecordKeys({
        data: {
          ...binding.data,
          updatedAt: "2026-07-22T00:00:02.000Z",
          version: binding.data.version + 1,
        },
        itemType: "channel-binding" as const,
      }),
    ),
  );

  await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
  expect(test.calls.map((call) => call.method)).toEqual(["start"]);
  expect(streamRecord(test.memory)?.data.status).toBe("streaming");
});

test("does not mutate Slack after its channel binding route is repointed", async () => {
  const test = slackFixture();
  await ensureSlackAgentStream(test.dependencies, test.run, test.userMessage);
  const binding = [...test.memory.records.values()].find(
    (record): record is Extract<PlatformRecord, { readonly itemType: "channel-binding" }> =>
      record.itemType === "channel-binding",
  );
  if (!binding) throw new Error("Expected Slack binding fixture.");
  const repointed = Schema.decodeUnknownSync(ChannelBindingRecord)(
    withCanonicalRecordKeys({
      data: {
        ...binding.data,
        externalChannelId: "C2",
        externalWorkspaceId: "T2",
        updatedAt: "2026-07-22T00:00:02.000Z",
        version: binding.data.version + 1,
      },
      itemType: "channel-binding" as const,
    }),
  );
  await test.memory.database.putRecord(repointed);

  await progressEvent(
    test.dependencies,
    {
      agentDefinitionId: id(5),
      ...customerRunPins(test.run.data),
      agentManifestHash: "sha256:test-manifest",
      captureMode: test.run.data.captureMode,
      environmentId: test.run.data.environmentId,
      eventType: "tool.running",
      level: "info",
      message: "Running tool shopify.fulfillments.create.",
      metadata: { toolCallId: "tool-after-repoint", toolName: "shopify.fulfillments.create" },
      occurredAt: "2026-07-22T00:00:02.000Z",
      organizationId: test.run.data.organizationId,
      projectId: test.run.data.projectId,
      runId: test.run.data.id,
      spanId: test.run.data.spanId,
      threadId: test.run.data.threadId,
      traceId: test.run.data.traceId,
      ...(test.run.data.workspaceId ? { workspaceId: test.run.data.workspaceId } : {}),
    },
    test.run,
  );

  expect(test.calls.map((call) => call.method)).toEqual(["start"]);
  expect(streamRecord(test.memory)?.data.status).toBe("streaming");
});

test("fails closed when the binding route changes during stream initialization", async () => {
  const test = slackFixture();
  const database = {
    ...test.dependencies.database,
    putRecord: (record: Parameters<typeof test.dependencies.database.putRecord>[0]) =>
      (async () => {
        await test.dependencies.database.putRecord(record);
        if (record.itemType !== "slack-agent-stream") return;
        const binding = [...test.memory.records.values()].find(
          (value): value is Extract<PlatformRecord, { readonly itemType: "channel-binding" }> =>
            value.itemType === "channel-binding",
        );
        if (!binding) throw new Error("Expected Slack binding fixture.");
        await test.dependencies.database.putRecord(
          Schema.decodeUnknownSync(ChannelBindingRecord)(
            withCanonicalRecordKeys({
              data: {
                ...binding.data,
                externalChannelId: "C2",
                updatedAt: "2026-07-22T00:00:02.000Z",
                version: binding.data.version + 1,
              },
              itemType: "channel-binding" as const,
            }),
          ),
        );
      })(),
  };

  const result = await ensureSlackAgentStream(
    { ...test.dependencies, database },
    test.run,
    test.userMessage,
  );

  expect(result?.data).toMatchObject({ fallbackAllowed: false, status: "failed" });
  expect(test.calls).toEqual([]);
});
