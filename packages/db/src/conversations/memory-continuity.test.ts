import { describe, expect, test } from "bun:test";

import type { DynamoDatabaseService, PlatformRecord, Ulid } from "../index.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeConversationMemoryContinuityPersistence } from "./memory-continuity.ts";

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

function database(records: readonly PlatformRecord[]): DynamoDatabaseService {
  const values = new Map(records.map((record) => [`${record.pk}\u0000${record.sk}`, record]));
  return {
    deleteRecord: () => Promise.resolve(),
    getRecord: (_table, key) => {
      const value = values.get(`${key.pk}\u0000${key.sk}`);
      return Promise.resolve(value === undefined ? undefined : value);
    },
    putRecord: () => Promise.resolve(),
    queryRecords: () => Promise.resolve({ items: [] }),
    transactWrite: () => Promise.resolve(),
  };
}

describe("conversation memory continuity", () => {
  test("returns the validated predecessor chain and stops at its explicit root", async () => {
    const currentThreadId = id("8");
    const predecessorThreadId = id("9");
    const rootThreadId = id("10");
    const currentDeploymentId = id("5");
    const predecessorDeploymentId = id("6");
    const rootDeploymentId = id("7");
    const persistence = makeConversationMemoryContinuityPersistence(
      database([
        thread(currentThreadId, currentDeploymentId, predecessorThreadId),
        thread(predecessorThreadId, predecessorDeploymentId, rootThreadId),
        thread(rootThreadId, rootDeploymentId),
        thread(id("11"), id("12")),
        deployment(predecessorDeploymentId),
        deployment(rootDeploymentId),
        deployment(id("12")),
      ]),
    );

    expect(
      persistence.validatedPredecessorThreadIds({
        agentDefinitionId: id("4"),
        currentAgentDeploymentId: currentDeploymentId,
        environmentId: id("3"),
        organizationId: id("1"),
        projectId: id("2"),
        threadId: currentThreadId,
      }),
    ).resolves.toEqual([predecessorThreadId, rootThreadId]);
  });

  test("rejects a continuation that crosses agent definitions", async () => {
    const currentThreadId = id("8");
    const predecessorThreadId = id("9");
    const currentDeploymentId = id("5");
    const predecessorDeploymentId = id("6");
    const persistence = makeConversationMemoryContinuityPersistence(
      database([
        thread(currentThreadId, currentDeploymentId, predecessorThreadId),
        thread(predecessorThreadId, predecessorDeploymentId),
        deployment(predecessorDeploymentId, id("40")),
      ]),
    );

    expect(
      persistence.validatedPredecessorThreadIds({
        agentDefinitionId: id("4"),
        currentAgentDeploymentId: currentDeploymentId,
        environmentId: id("3"),
        organizationId: id("1"),
        projectId: id("2"),
        threadId: currentThreadId,
      }),
    ).rejects.toThrow("agent definition");
  });
});
