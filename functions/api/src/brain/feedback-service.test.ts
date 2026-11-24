import { describe, expect, test } from "bun:test";
import { makeDynamoBrainQueryTelemetry } from "@deployments-ai/brain-runtime";
import type { DynamoDatabaseService, PlatformRecord } from "@deployments-ai/db";
import {
  brainId,
  environmentId,
  invocation,
  organizationId,
  projectId,
  service,
  sourceId,
  timestamp,
} from "./service.fixture.ts";

const queryAttemptId = "01ARZ3NDEKTSV4RRFFQ69G5FBN";

function memoryDatabase() {
  const records = new Map<string, PlatformRecord>();
  const database: DynamoDatabaseService = {
    deleteRecord: async () => {},
    getRecord: (_table, key) => Promise.resolve(records.get(`${key.pk}|${key.sk}`)),
    putRecord: async () => {},
    queryRecords: () => Promise.resolve({ items: [] }),
    transactWrite: async (operations) => {
      for (const operation of operations) {
        if (operation.kind === "put") {
          records.set(`${operation.record.pk}|${operation.record.sk}`, operation.record);
        }
      }
    },
  };
  return { database, records };
}

// Persists an environment-scoped ask attempt exactly as the deployed search/ask runtime does.
function recordAskAttempt(database: DynamoDatabaseService, attemptOrganizationId: string) {
  const generated = [queryAttemptId, "01ARZ3NDEKTSV4RRFFQ69G5FBQ", "01ARZ3NDEKTSV4RRFFQ69G5FBR"];
  return makeDynamoBrainQueryTelemetry({
    database,
    generateId: async () => generated.shift()!,
    now: () => new Date(timestamp),
  }).record({
    authorizedBrainIds: [brainId],
    candidateCount: 3,
    canonicalDropCount: 0,
    context: { environmentId, operationId: "brain-ask-1", projectId, workspaceId: undefined },
    emittedCount: 1,
    latencyMs: 12,
    organizationId: attemptOrganizationId,
    placementGeneration: 1,
    purpose: "ask-evidence",
    query: "Why?",
    results: [
      {
        citation: {
          brainId,
          chunkId: "chunk-1",
          coordinates: { end: 12, kind: "unicode-scalar", start: 0 },
          documentId: "01ARZ3NDEKTSV4RRFFQ69G5FBS",
          documentVersionId: "01ARZ3NDEKTSV4RRFFQ69G5FBT",
          renditionId: "01ARZ3NDEKTSV4RRFFQ69G5FBV",
          sourceId,
        },
        excerpt: "The citations resolved cleanly.",
        score: 0.9,
        sensitivity: "internal",
      },
    ],
    target: {
      location: {},
      providerId: "aws-native",
      schemaGeneration: 1,
      targetId: "01ARZ3NDEKTSV4RRFFQ69G5FBP",
    },
  });
}

describe("Brain API feedback", () => {
  test("records usefulness against the environment-scoped attempt ask returned", async () => {
    const { database, records } = memoryDatabase();
    const attempt = await recordAskAttempt(database, organizationId);

    const result = await service({ database }).invoke(
      "recordBrainFeedback",
      invocation({
        body: { feedback: "The citations resolved cleanly.", usefulness: "useful" },
        params: { queryAttemptId: attempt.queryAttemptId },
      }),
    );

    expect(result).toEqual({ queryAttemptId, recordedAt: timestamp, usefulness: "useful" });
    const updated = [...records.values()].find(
      (record) => record.itemType === "brain-query-attempt",
    );
    expect(updated?.data).toMatchObject({
      environmentId,
      feedback: "The citations resolved cleanly.",
      id: queryAttemptId,
      usefulness: "useful",
      version: 1,
    });
  });

  test("hides an attempt recorded by another organization", async () => {
    const { database } = memoryDatabase();
    const attempt = await recordAskAttempt(database, "01ARZ3NDEKTSV4RRFFQ69G5FBW");

    expect(
      service({ database }).invoke(
        "recordBrainFeedback",
        invocation({
          body: { usefulness: "useful" },
          params: { queryAttemptId: attempt.queryAttemptId },
        }),
      ),
    ).rejects.toMatchObject({ code: "brain_query_attempt_not_found" });
  });

  test("hides an attempt whose item TTL has passed", async () => {
    const { database, records } = memoryDatabase();
    const attempt = await recordAskAttempt(database, organizationId);
    for (const [recordKey, record] of records) {
      if (record.itemType !== "brain-query-attempt") continue;
      records.set(recordKey, { ...record, ttl: Date.parse(timestamp) / 1_000 });
    }

    expect(
      service({ database }).invoke(
        "recordBrainFeedback",
        invocation({
          body: { usefulness: "useful" },
          params: { queryAttemptId: attempt.queryAttemptId },
        }),
      ),
    ).rejects.toMatchObject({ code: "brain_query_attempt_not_found" });
  });
});
