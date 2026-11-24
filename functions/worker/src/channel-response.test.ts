import { describe, expect, test } from "bun:test";
import {
  ChannelBindingRecord,
  MessageRecord,
  RunRecord,
  WorkspaceRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import { fixtures, id, inMemoryDatabase, workerDependencies } from "./agent-run.fixture.ts";
import {
  automaticChannelResponseError,
  channelResponsePersistence,
  slackRouteRequiresApproval,
} from "./channel-response.ts";
import { slackThreadTs } from "./channel-response-payload.ts";

function workspaceRecord(
  fixture: ReturnType<typeof fixtures>,
  status: "active" | "archived" = "active",
) {
  return Schema.decodeUnknownSync(WorkspaceRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: fixture.run.data.createdAt,
        environmentId: fixture.run.data.environmentId,
        id: fixture.run.data.workspaceId!,
        name: "Channel response workspace",
        organizationId: fixture.run.data.organizationId,
        projectId: fixture.run.data.projectId,
        slug: "channel-response-workspace",
        status,
        updatedAt: fixture.run.data.updatedAt,
        version: status === "active" ? 0 : 1,
      },
      itemType: "workspace" as const,
    }),
  );
}

const SLACK_TRUNCATION_NOTICE =
  "\n\n_Response truncated in Slack. Open Deployments.ai to view the complete result._";

describe("automatic channel response composition", () => {
  test("distinguishes Slack root routes from threaded routes", () => {
    expect(slackThreadTs("slack:T1:thread:C1")).toBeUndefined();
    expect(slackThreadTs("slack:T1:thread:C1:1.2")).toBe("1.2");
    expect(slackThreadTs("slack:T1:shared:thread:C1")).toBeUndefined();
    expect(slackThreadTs("slack:T1:shared:thread:C1:1.3")).toBe("1.3");
    expect(slackRouteRequiresApproval("slack:T1:shared:thread:C1:1.3")).toBe(true);
    expect(slackRouteRequiresApproval("slack:T1:thread:C1:1.3")).toBe(false);
    expect(automaticChannelResponseError("   ")).toBe("Automatic channel response is empty.");
  });

  test("atomically queues one delivery when a channel-triggered chat run completes", async () => {
    const fixture = fixtures();
    const bindingId = id(70);
    const userMessage = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.userMessage.data,
          metadata: {
            bindingId,
            externalThreadKey: "telegram:chat:123",
            routeId: "a".repeat(64),
            source: "channel-ingress",
            throughSequence: 2,
          },
        },
        itemType: "message" as const,
      }),
    );
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixture.run.data,
          responsePublication: "external",
          trigger: "chat",
        },
        itemType: "run" as const,
      }),
    );
    const binding = Schema.decodeUnknownSync(ChannelBindingRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDefinitionId: fixture.release.data.agentDefinitionId,
          agentDeploymentId: fixture.deployment.data.id,
          channel: "telegram",
          createdAt: fixture.run.data.createdAt,
          credentialRef: {
            credentialId: id(71),
            generation: 1,
            store: "dynamodb-kms" as const,
          },
          environmentId: fixture.run.data.environmentId,
          externalThreadKey: "telegram:chat:123",
          id: bindingId,
          organizationId: fixture.run.data.organizationId,
          projectId: fixture.run.data.projectId,
          provider: "telegram",
          status: "active",
          updatedAt: fixture.run.data.updatedAt,
          version: 0,
          workspaceId: fixture.run.data.workspaceId,
        },
        itemType: "channel-binding" as const,
      }),
    );
    let memory: ReturnType<typeof inMemoryDatabase>;
    memory = inMemoryDatabase(
      [
        fixture.release,
        fixture.deployment,
        fixture.thread,
        userMessage,
        run,
        binding,
        workspaceRecord(fixture),
      ],
      {
        failCompletionBeforeCommitOnce: true,
        onCompletionFailureBeforeCommit: () => {
          const updated = Schema.decodeUnknownSync(ChannelBindingRecord)(
            withCanonicalRecordKeys({
              data: {
                ...binding.data,
                updatedAt: "2026-07-22T00:00:00.500Z",
                version: binding.data.version + 1,
              },
              itemType: "channel-binding" as const,
            }),
          );
          const entry = [...memory.records.entries()].find(
            ([, record]) => record.itemType === "channel-binding",
          );
          if (entry) memory.records.set(entry[0], updated);
        },
      },
    );
    const base = workerDependencies(memory.database);
    const longResponse = "x".repeat(4_097);
    const dependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async () => ({ assistantMessage: longResponse }),
      },
    };

    const result = await processAgentRun(fixture.queue, dependencies);

    expect(result.action).toBe("completed");
    const records = [...memory.records.values()];
    const deliveries = records.filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "channel-delivery" }> =>
        record.itemType === "channel-delivery",
    );
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0]!;
    expect(delivery.data).toMatchObject({
      attempts: 0,
      bindingId,
      contentPreview: "x".repeat(500),
      credentialRef: binding.data.credentialRef,
      externalThreadKey: "telegram:chat:123",
      providerPayload: expect.any(Array),
      responsePublication: "external",
      routeId: "a".repeat(64),
      sourceMessageId: expect.any(String),
      sourceMessageSequence: 1,
      status: "queued",
      throughSequence: 2,
    });
    expect(records.filter((record) => record.itemType === "channel-delivery-lookup")).toHaveLength(
      1,
    );
    const queuedEvents = records.filter(
      (record): record is Extract<PlatformRecord, { readonly itemType: "semantic-event" }> =>
        record.itemType === "semantic-event" && record.data.eventType === "channel.delivery.queued",
    );
    expect(queuedEvents).toHaveLength(1);
    expect(queuedEvents[0]?.data.payload).toEqual({
      channelBindingId: bindingId,
      deliveryId: delivery.data.id,
      provider: "telegram",
      runId: run.data.id,
      status: "queued",
    });
    const completionTransaction = memory.transactionInputs.find((operations) =>
      operations.some(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "run" &&
          operation.record.data.status === "completed",
      ),
    );
    expect(completionTransaction).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "put",
          record: expect.objectContaining({ itemType: "channel-delivery" }),
        }),
        expect.objectContaining({
          kind: "put",
          record: expect.objectContaining({ itemType: "channel-delivery-lookup" }),
        }),
        expect.objectContaining({
          expressionAttributeValues: { ":active": "active", ":version": 0 },
          key: {
            pk: workspaceRecord(fixture).pk,
            sk: workspaceRecord(fixture).sk,
          },
          kind: "condition-check",
          table: "control",
        }),
      ]),
    );
    const checkedBindingVersions = memory.transactionInputs
      .filter((operations) =>
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "run" &&
            operation.record.data.status === "completed",
        ),
      )
      .map(
        (operations) =>
          operations.find(
            (operation) => operation.kind === "condition-check" && operation.table === "control",
          )?.expressionAttributeValues?.[":version"],
      );
    expect(checkedBindingVersions).toEqual([0, 1]);

    await memory.database.putRecord(workspaceRecord(fixture, "archived"));
    const suppressed = await channelResponsePersistence({
      body: "Do not send after archive.",
      dependencies,
      run,
      timestamp: new Date(run.data.updatedAt),
    });
    expect(suppressed).toEqual({ events: [], operations: [] });
  });

  test("completes the run with a terminal failed delivery when the response cannot send", async () => {
    for (const [assistantMessage, expectedError] of [
      [
        "x".repeat(40_001),
        "Automatic channel response exceeds the 40,000-character delivery limit.",
      ],
    ] as const) {
      const fixture = fixtures();
      const bindingId = id(70);
      const userMessage = Schema.decodeUnknownSync(MessageRecord)(
        withCanonicalRecordKeys({
          data: {
            ...fixture.userMessage.data,
            metadata: {
              bindingId,
              externalChannelId: "telegram-bot",
              externalThreadKey: "telegram:chat:123",
              source: "channel-ingress",
            },
          },
          itemType: "message" as const,
        }),
      );
      const run = Schema.decodeUnknownSync(RunRecord)(
        withCanonicalRecordKeys({
          data: { ...fixture.run.data, trigger: "chat" },
          itemType: "run" as const,
        }),
      );
      const binding = Schema.decodeUnknownSync(ChannelBindingRecord)(
        withCanonicalRecordKeys({
          data: {
            agentDefinitionId: fixture.release.data.agentDefinitionId,
            agentDeploymentId: fixture.deployment.data.id,
            channel: "telegram",
            createdAt: fixture.run.data.createdAt,
            credentialRef: {
              credentialId: id(71),
              generation: 1,
              store: "dynamodb-kms" as const,
            },
            environmentId: fixture.run.data.environmentId,
            externalChannelId: "telegram-bot",
            externalThreadKey: "telegram:chat:123",
            id: bindingId,
            organizationId: fixture.run.data.organizationId,
            projectId: fixture.run.data.projectId,
            provider: "telegram",
            status: "active",
            updatedAt: fixture.run.data.updatedAt,
            version: 0,
            workspaceId: fixture.run.data.workspaceId,
          },
          itemType: "channel-binding" as const,
        }),
      );
      const memory = inMemoryDatabase([
        fixture.release,
        fixture.deployment,
        fixture.thread,
        userMessage,
        run,
        binding,
        workspaceRecord(fixture),
      ]);
      const base = workerDependencies(memory.database);
      const dependencies = {
        ...base.dependencies,
        runtime: {
          generateAssistantMessage: async () => ({ assistantMessage }),
        },
      };

      const result = await processAgentRun(fixture.queue, dependencies);

      expect(result.action).toBe("completed");
      const records = [...memory.records.values()];
      const delivery = records.find(
        (record): record is Extract<PlatformRecord, { readonly itemType: "channel-delivery" }> =>
          record.itemType === "channel-delivery",
      );
      expect(delivery?.data).toMatchObject({
        attempts: 0,
        lastError: expectedError,
        status: "failed",
      });
      expect(
        records.filter(
          (record) =>
            record.itemType === "semantic-event" &&
            record.data.eventType === "channel.delivery.failed",
        ),
      ).toHaveLength(1);
      expect(
        records.filter(
          (record) =>
            record.itemType === "semantic-event" &&
            record.data.eventType === "channel.delivery.queued",
        ),
      ).toHaveLength(0);
    }
  });

  test("applies the binding's Slack agent identity to fallback deliveries", async () => {
    const threadKey = "slack:T1:thread:C1:1721609600.123456";
    const cases = [
      {
        expected: {
          channel: "C1",
          icon_emoji: ":mag:",
          markdown_text: "Final answer.",
          thread_ts: "1721609600.123456",
          username: "Rex",
        },
        metadata: { slackAgentIdentity: { iconEmoji: ":mag:", username: " Rex " } },
        provider: "slack_edge",
      },
      {
        expected: {
          channel: "C1",
          icon_url: "https://cdn.example.test/agents/rex.png",
          markdown_text: "Final answer.",
          thread_ts: "1721609600.123456",
          username: "Rex",
        },
        metadata: {
          slackAgentIdentity: {
            iconUrl: "https://cdn.example.test/agents/rex.png",
            username: "Rex",
          },
        },
        provider: "slack_cloudflare_edge",
      },
      {
        expected: { channel: "C1", markdown_text: "Final answer.", thread_ts: "1721609600.123456" },
        metadata: undefined,
        provider: "slack_edge",
      },
      {
        body: "x".repeat(12_000),
        expected: {
          channel: "C1",
          markdown_text: "x".repeat(12_000),
          thread_ts: "1721609600.123456",
        },
        metadata: undefined,
        provider: "slack_edge",
      },
      {
        body: "x".repeat(12_001),
        expected: {
          channel: "C1",
          markdown_text: `${"x".repeat(12_000 - SLACK_TRUNCATION_NOTICE.length)}${SLACK_TRUNCATION_NOTICE}`,
          thread_ts: "1721609600.123456",
        },
        metadata: undefined,
        provider: "slack_edge",
      },
      {
        expectedError: "Slack channel binding has an invalid agent identity.",
        metadata: { slackAgentIdentity: { iconEmoji: "mag", username: "Rex" } },
        provider: "slack_edge",
      },
    ] as const;
    for (const testCase of cases) {
      const fixture = fixtures();
      const bindingId = id(70);
      const userMessage = Schema.decodeUnknownSync(MessageRecord)(
        withCanonicalRecordKeys({
          data: {
            ...fixture.userMessage.data,
            metadata: {
              bindingId,
              externalChannelId: "C1",
              externalThreadKey: threadKey,
              source: "channel-ingress",
            },
          },
          itemType: "message" as const,
        }),
      );
      const run = Schema.decodeUnknownSync(RunRecord)(
        withCanonicalRecordKeys({
          data: {
            ...fixture.run.data,
            trigger: "chat",
            userMessageId: userMessage.data.id,
            userMessageSequence: userMessage.data.sequence,
          },
          itemType: "run" as const,
        }),
      );
      const binding = Schema.decodeUnknownSync(ChannelBindingRecord)(
        withCanonicalRecordKeys({
          data: {
            agentDefinitionId: fixture.release.data.agentDefinitionId,
            agentDeploymentId: fixture.deployment.data.id,
            channel: "slack",
            createdAt: fixture.run.data.createdAt,
            credentialRef: {
              credentialId: id(71),
              generation: 1,
              store: "dynamodb-kms" as const,
            },
            environmentId: fixture.run.data.environmentId,
            externalChannelId: "C1",
            externalThreadKey: threadKey,
            externalWorkspaceId: "T1",
            id: bindingId,
            ...(testCase.metadata ? { metadata: testCase.metadata } : {}),
            organizationId: fixture.run.data.organizationId,
            projectId: fixture.run.data.projectId,
            provider: testCase.provider,
            status: "active",
            updatedAt: fixture.run.data.updatedAt,
            version: 0,
            workspaceId: fixture.run.data.workspaceId,
          },
          itemType: "channel-binding" as const,
        }),
      );
      const memory = inMemoryDatabase([userMessage, run, binding, workspaceRecord(fixture)]);
      const { dependencies } = workerDependencies(memory.database);

      const persistence = await channelResponsePersistence({
        body: "body" in testCase ? testCase.body : "Final answer.",
        dependencies,
        run,
        timestamp: new Date(run.data.updatedAt),
      });

      const delivery = persistence.operations.find(
        (operation) => operation.kind === "put" && operation.record.itemType === "channel-delivery",
      );
      if (delivery?.kind !== "put" || delivery.record.itemType !== "channel-delivery") {
        throw new Error("Expected a planned channel delivery.");
      }
      if ("expectedError" in testCase) {
        expect(delivery.record.data).toMatchObject({
          lastError: testCase.expectedError,
          status: "failed",
        });
        expect(delivery.record.data.providerPayload).toBeUndefined();
      } else {
        expect(delivery.record.data.status).toBe("queued");
        expect(delivery.record.data.providerPayload).toEqual(testCase.expected);
      }
    }
  });
});
