import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RETENTION_POLICY,
  THREAD_OWNERSHIP,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import {
  retentionClass,
  retentionMinimumAgeMilliseconds,
} from "./governance-record-classification.ts";

const THREAD_OWNED_TYPES_WITHOUT_RETENTION_CLASS = [
  "conversation-inbox-thread",
  "dataset-case",
  "end-user-thread",
  "heartbeat",
  "idempotency",
  "inbox-thread-conversation",
  "memory",
  "run-locator",
  "schedule",
];

describe("retention classification", () => {
  test("expires generation reasoning with its run", () => {
    const reasoning = withCanonicalRecordKeys({
      data: {
        createdAt: "2026-10-01T00:00:00.000Z",
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        modelCallIndex: 0,
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        producerAttemptId: "run:execution:1:assistant:0:run-attempt:0:fallback:0",
        producerModelId: "openrouter/anthropic/claude-opus-5.5",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        reasoningDetails: [{ signature: "c2ln", type: "reasoning.text" }],
        runId: "01ARZ3NDEKTSV4RRFFQ69G5FR1",
        threadId: "01ARZ3NDEKTSV4RRFFQ69G5FT1",
      },
      itemType: "generation-reasoning" as const,
    }) as unknown as PlatformRecord;

    expect(retentionClass(reasoning)).toBe("runs");
  });

  test("gives every thread-owned item type a retention class unless it is listed without one", () => {
    const unclassified = Object.entries(THREAD_OWNERSHIP)
      .filter(([, ownership]) => ownership.kind === "owned")
      .map(([itemType]) => itemType)
      .filter(
        (itemType) =>
          retentionMinimumAgeMilliseconds(itemType, DEFAULT_RETENTION_POLICY) === undefined,
      )
      .sort();

    expect(unclassified).toEqual(THREAD_OWNED_TYPES_WITHOUT_RETENTION_CLASS);
  });
});
