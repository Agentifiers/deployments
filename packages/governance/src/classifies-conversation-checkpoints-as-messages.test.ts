import { describe, expect, test } from "bun:test";
import { withCanonicalRecordKeys, type PlatformRecord } from "@deployments-ai/db";
import { retentionClass } from "./governance-record-classification.ts";

describe("retention classification", () => {
  test("conversation checkpoints expire with the messages they summarize", () => {
    const checkpoint = withCanonicalRecordKeys({
      data: {
        agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        contentHash: "sha256:summary",
        createdAt: "2026-10-01T00:00:00.000Z",
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        fromSequence: 1,
        id: "01ARZ3NDEKTSV4RRFFQ69G5FC1",
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        runId: "01ARZ3NDEKTSV4RRFFQ69G5FR1",
        sourceMessageCount: 4,
        summary: "The user asked about billing.",
        threadId: "01ARZ3NDEKTSV4RRFFQ69G5FT1",
        throughSequence: 4,
      },
      itemType: "conversation-checkpoint" as const,
    }) as unknown as PlatformRecord;

    expect(retentionClass(checkpoint)).toBe("messages");
  });
});
