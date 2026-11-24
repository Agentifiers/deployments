import { describe, expect, test } from "bun:test";

import type { DynamoDatabaseService, PlatformRecord, Ulid } from "../index.ts";
import {
  nonReplayableConversationMessageMetadata,
  transientConversationMessageMetadata,
} from "../conversation-message-visibility.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeConversationTemporalContinuityPersistence } from "./temporal-continuity.ts";

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;

function thread(threadId: Ulid, deploymentId: Ulid, continuedFromThreadId?: Ulid): PlatformRecord {
  return withCanonicalRecordKeys({
    data: {
      agentDeploymentId: deploymentId,
      archived: false,
      channel: "api",
      ...(continuedFromThreadId ? { continuedFromThreadId } : {}),
      createdAt: "2026-09-05T00:00:00.000Z",
      createdBy: { id: id("90"), type: "service-account" as const },
      environmentId: id("3"),
      id: threadId,
      organizationId: id("1"),
      pinned: false,
      projectId: id("2"),
      streamId: id("91"),
      title: "Conversation",
      updatedAt: "2026-09-05T00:00:00.000Z",
      version: 0,
    },
    itemType: "thread" as const,
  }) as PlatformRecord;
}

function deployment(deploymentId: Ulid, agentDefinitionId = id("4")): PlatformRecord {
  return withCanonicalRecordKeys({
    data: {
      agentDefinitionId,
      agentReleaseId: id("92"),
      createdAt: "2026-09-05T00:00:00.000Z",
      currentState: "ready" as const,
      desiredState: "running" as const,
      environmentId: id("3"),
      id: deploymentId,
      organizationId: id("1"),
      projectId: id("2"),
      updatedAt: "2026-09-05T00:00:00.000Z",
      version: 0,
    },
    itemType: "agent-deployment" as const,
  }) as PlatformRecord;
}

function message(
  messageId: Ulid,
  threadId: Ulid,
  sequence: number,
  createdAt: string,
  options: { readonly transient?: boolean; readonly nonReplayable?: boolean } = {},
): PlatformRecord {
  return withCanonicalRecordKeys({
    data: {
      body: "Synthetic predecessor conversation text.",
      contentHash: `hash-${messageId}`,
      createdAt,
      environmentId: id("3"),
      id: messageId,
      ...(options.transient ? { metadata: transientConversationMessageMetadata() } : {}),
      ...(options.nonReplayable ? { metadata: nonReplayableConversationMessageMetadata() } : {}),
      organizationId: id("1"),
      projectId: id("2"),
      role: "assistant" as const,
      sequence,
      threadId,
    },
    itemType: "message" as const,
  }) as PlatformRecord;
}

function inheritedCheckpoint(
  threadId: Ulid,
  predecessorThreadId: Ulid,
  throughSequence: number,
  deploymentId = id("5"),
): PlatformRecord {
  return withCanonicalRecordKeys({
    data: {
      agentDeploymentId: deploymentId,
      contentHash: `checkpoint-${threadId}`,
      continuedFromCheckpointId: id("80"),
      continuedFromThreadId: predecessorThreadId,
      continuedFromThroughSequence: throughSequence,
      createdAt: "2026-09-05T00:00:00.000Z",
      environmentId: id("3"),
      fromSequence: 0,
      id: id("81"),
      organizationId: id("1"),
      projectId: id("2"),
      runId: id("82"),
      sourceMessageCount: throughSequence + 1,
      summary: "Earlier conversation.",
      threadId,
      throughSequence: 0,
    },
    itemType: "conversation-checkpoint" as const,
  }) as PlatformRecord;
}

function database(records: readonly PlatformRecord[]): DynamoDatabaseService {
  const values = new Map(records.map((record) => [`${record.pk}\u0000${record.sk}`, record]));
  return {
    deleteRecord: () => Promise.resolve(),
    getRecord: (_table, key) => {
      const value = values.get(`${key.pk}\u0000${key.sk}`);
      return Promise.resolve(value === undefined ? undefined : value);
    },
    putRecord: () => Promise.resolve(),
    queryRecords: (_table, input) => {
      const attributes = input.ExpressionAttributeValues as Record<string, unknown>;
      const partition = attributes[":pk"];
      const prefix = attributes[":prefix"];
      const candidates = records
        .filter((record) => record.pk === partition)
        .filter((record) => typeof prefix !== "string" || record.sk.startsWith(prefix))
        .filter(
          (record) =>
            typeof attributes[":maximumSk"] !== "string" || record.sk <= attributes[":maximumSk"],
        )
        .filter(
          (record) => !input.ExclusiveStartKey || record.sk < String(input.ExclusiveStartKey.sk),
        )
        .sort((left, right) => right.sk.localeCompare(left.sk));
      const items = candidates.slice(0, input.Limit);
      const last = items.at(-1);
      return Promise.resolve({
        items,
        ...(last && candidates.length > items.length
          ? { lastEvaluatedKey: { pk: last.pk, sk: last.sk } }
          : {}),
      });
    },
    transactWrite: () => Promise.resolve(),
  };
}

describe("conversation temporal continuity", () => {
  test("returns only the latest replayable predecessor message timing", async () => {
    const currentThreadId = id("8");
    const predecessorThreadId = id("9");
    const currentDeploymentId = id("5");
    const predecessorDeploymentId = id("6");
    const persistence = makeConversationTemporalContinuityPersistence(
      database([
        thread(currentThreadId, currentDeploymentId, predecessorThreadId),
        thread(predecessorThreadId, predecessorDeploymentId),
        inheritedCheckpoint(currentThreadId, predecessorThreadId, 1),
        deployment(predecessorDeploymentId),
        message(id("20"), predecessorThreadId, 0, "2026-09-03T20:00:00.000Z"),
        message(id("21"), predecessorThreadId, 1, "2026-09-03T20:05:00.000Z", {
          transient: true,
        }),
      ]),
    );

    expect(
      persistence.latestReplayablePredecessorMessage({
        agentDefinitionId: id("4"),
        currentAgentDeploymentId: currentDeploymentId,
        environmentId: id("3"),
        organizationId: id("1"),
        projectId: id("2"),
        threadId: currentThreadId,
      }),
    ).resolves.toEqual({ createdAt: "2026-09-03T20:00:00.000Z", role: "assistant" });
  });

  test("returns no timing anchor when the thread has no predecessor", async () => {
    const currentThreadId = id("8");
    const currentDeploymentId = id("5");
    const persistence = makeConversationTemporalContinuityPersistence(
      database([thread(currentThreadId, currentDeploymentId)]),
    );

    expect(
      persistence.latestReplayablePredecessorMessage({
        agentDefinitionId: id("4"),
        currentAgentDeploymentId: currentDeploymentId,
        environmentId: id("3"),
        organizationId: id("1"),
        projectId: id("2"),
        threadId: currentThreadId,
      }),
    ).resolves.toBeUndefined();
  });

  test("retains exact lineage turns before each handoff and the current trigger only", async () => {
    const currentThreadId = id("8");
    const predecessorThreadId = id("9");
    const ancestorThreadId = id("10");
    const currentDeploymentId = id("5");
    const predecessorDeploymentId = id("6");
    const middle = thread(predecessorThreadId, predecessorDeploymentId, ancestorThreadId);
    const persistence = makeConversationTemporalContinuityPersistence(
      database([
        thread(currentThreadId, currentDeploymentId, predecessorThreadId),
        {
          ...middle,
          data: { ...middle.data, createdAt: "2026-09-03T00:00:00.000Z" },
        } as PlatformRecord,
        thread(ancestorThreadId, predecessorDeploymentId),
        deployment(predecessorDeploymentId),
        message(id("20"), ancestorThreadId, 300, "2026-09-02T20:00:00.000Z"),
        message(id("21"), ancestorThreadId, 301, "2026-09-03T20:00:00.000Z"),
        inheritedCheckpoint(currentThreadId, predecessorThreadId, 5),
        inheritedCheckpoint(predecessorThreadId, ancestorThreadId, 300, predecessorDeploymentId),
        message(id("22"), predecessorThreadId, 0, "2026-09-03T20:00:00.000Z"),
        message(id("23"), predecessorThreadId, 1, "2026-09-04T20:00:00.000Z"),
        message(id("24"), predecessorThreadId, 2, "2026-09-05T20:00:00.000Z"),
        message(id("25"), id("99"), 3, "2026-09-03T20:00:00.000Z"),
        message(id("26"), predecessorThreadId, 4, "2026-09-03T20:00:00.000Z", { transient: true }),
        message(id("27"), predecessorThreadId, 5, "2026-09-03T20:00:00.000Z", {
          nonReplayable: true,
        }),
      ]),
    );
    const scope = {
      agentDefinitionId: id("4"),
      currentAgentDeploymentId: currentDeploymentId,
      environmentId: id("3"),
      organizationId: id("1"),
      projectId: id("2"),
      threadId: currentThreadId,
    };
    const messages = await persistence.recentReplayablePredecessorMessages(scope, {
      maximumCharacters: 10_000,
      maximumMessages: 100,
      maximumPages: 128,
      throughCreatedAt: "2026-09-04T00:00:00.000Z",
    });
    expect(messages.map((record) => record.data.id)).toEqual([id("20"), id("22")]);
    expect(messages.map((record) => record.data.body)).toEqual([
      "Synthetic predecessor conversation text.",
      "Synthetic predecessor conversation text.",
    ]);
    expect(
      persistence.latestReplayablePredecessorMessage({
        ...scope,
        throughCreatedAt: "2026-09-04T00:00:00.000Z",
      }),
    ).resolves.toEqual({ createdAt: "2026-09-03T20:00:00.000Z", role: "assistant" });
    expect(
      (
        await persistence.recentReplayablePredecessorMessages(scope, {
          maximumCharacters: 10_000,
          maximumMessages: 100,
          maximumPages: 128,
          throughCreatedAt: "2026-09-06T00:00:00.000Z",
        })
      ).map((record) => record.data.id),
    ).toEqual([id("20"), id("22"), id("23")]);
  });

  test("bounds the newest replayable predecessor tail across paginated hidden turns", async () => {
    const scope = {
      agentDefinitionId: id("4"),
      currentAgentDeploymentId: id("5"),
      environmentId: id("3"),
      organizationId: id("1"),
      projectId: id("2"),
      threadId: id("8"),
    };
    const persistence = makeConversationTemporalContinuityPersistence(
      database([
        thread(scope.threadId, scope.currentAgentDeploymentId, id("9")),
        thread(id("9"), id("6")),
        deployment(id("6")),
        inheritedCheckpoint(scope.threadId, id("9"), 31),
        message(id("20"), id("9"), 0, "2026-09-03T20:00:00.000Z"),
        message(id("21"), id("9"), 1, "2026-09-03T20:05:00.000Z"),
        ...Array.from({ length: 30 }, (_, index) =>
          message(id(String(100 + index)), id("9"), index + 2, "2026-09-03T20:10:00.000Z", {
            transient: true,
          }),
        ),
      ]),
    );
    const options = {
      maximumCharacters: 10_000,
      maximumMessages: 1,
      maximumPages: 128,
      throughCreatedAt: "2026-09-06T00:00:00.000Z",
    };
    expect(
      (await persistence.recentReplayablePredecessorMessages(scope, options)).map(
        (record) => record.data.id,
      ),
    ).toEqual([id("21")]);
    expect(
      (
        await persistence.recentReplayablePredecessorMessages(scope, {
          ...options,
          maximumCharacters: "Synthetic predecessor conversation text.".length,
          maximumMessages: 100,
        })
      ).map((record) => record.data.id),
    ).toEqual([id("21")]);
    expect(
      persistence.recentReplayablePredecessorMessages(scope, { ...options, maximumPages: 1 }),
    ).rejects.toThrow("bounded predecessor message scan limit");
  });

  test.each(["organizationId", "projectId", "environmentId", "workspaceId"] as const)(
    "rejects predecessor history crossing %s",
    async (field) => {
      const predecessor = thread(id("9"), id("6"));
      const persistence = makeConversationTemporalContinuityPersistence(
        database([
          thread(id("8"), id("5"), id("9")),
          { ...predecessor, data: { ...predecessor.data, [field]: id("99") } } as PlatformRecord,
          deployment(id("6")),
          message(id("20"), id("9"), 0, "2026-09-03T20:00:00.000Z"),
        ]),
      );
      expect(
        persistence.recentReplayablePredecessorMessages(
          {
            agentDefinitionId: id("4"),
            currentAgentDeploymentId: id("5"),
            environmentId: id("3"),
            organizationId: id("1"),
            projectId: id("2"),
            threadId: id("8"),
          },
          {
            maximumCharacters: 10_000,
            maximumMessages: 100,
            maximumPages: 128,
            throughCreatedAt: "2026-09-06T00:00:00.000Z",
          },
        ),
      ).rejects.toThrow("canonical thread scope");
    },
  );

  test("rejects a predecessor pinned to a different agent", async () => {
    const persistence = makeConversationTemporalContinuityPersistence(
      database([
        thread(id("8"), id("5"), id("9")),
        thread(id("9"), id("6")),
        deployment(id("6"), id("99")),
        message(id("20"), id("9"), 0, "2026-09-03T20:00:00.000Z"),
      ]),
    );
    expect(
      persistence.recentReplayablePredecessorMessages(
        {
          agentDefinitionId: id("4"),
          currentAgentDeploymentId: id("5"),
          environmentId: id("3"),
          organizationId: id("1"),
          projectId: id("2"),
          threadId: id("8"),
        },
        {
          maximumCharacters: 10_000,
          maximumMessages: 100,
          maximumPages: 128,
          throughCreatedAt: "2026-09-06T00:00:00.000Z",
        },
      ),
    ).rejects.toThrow("agent definition");
  });

  test("does not replay or derive timing from an edge without an inherited checkpoint", async () => {
    const persistence = makeConversationTemporalContinuityPersistence(
      database([
        thread(id("8"), id("5"), id("9")),
        thread(id("9"), id("6")),
        deployment(id("6")),
        message(id("20"), id("9"), 0, "2026-09-03T20:00:00.000Z"),
      ]),
    );
    const scope = {
      agentDefinitionId: id("4"),
      currentAgentDeploymentId: id("5"),
      environmentId: id("3"),
      organizationId: id("1"),
      projectId: id("2"),
      threadId: id("8"),
    };
    expect(
      persistence.recentReplayablePredecessorMessages(scope, {
        maximumCharacters: 10_000,
        maximumMessages: 100,
        maximumPages: 128,
        throughCreatedAt: "2026-09-06T00:00:00.000Z",
      }),
    ).resolves.toEqual([]);
    expect(persistence.latestReplayablePredecessorMessage(scope)).resolves.toBeUndefined();
  });
});
